import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v32.html'
html = html_path.read_text()

fake_idb = r'''
<script>
(() => {
  const databases = new Map();
  databases.set('the-call-up', { version: 2, stores: new Map([
    ['settings', { keyPath: 'key', rows: new Map([['upgrade-marker', { key: 'upgrade-marker', value: 'keep-me' }]]) }],
    ['saves', { keyPath: 'saveId', rows: new Map() }],
    ['backups', { keyPath: 'backupId', rows: new Map() }]
  ]) });
  window.__fakeIDBDatabases = databases;
  const asyncRequest = (producer) => {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      try { request.result = producer(); request.onsuccess?.(); }
      catch (error) { request.error = error; request.onerror?.(); }
    }, 0);
    return request;
  };
  const makeStoreApi = (store) => ({
    put(value) { const key = value[store.keyPath]; store.rows.set(key, structuredClone(value)); return asyncRequest(() => key); },
    get(key) { return asyncRequest(() => store.rows.has(key) ? structuredClone(store.rows.get(key)) : undefined); },
    getAll() { return asyncRequest(() => [...store.rows.values()].map((value) => structuredClone(value))); },
    delete(key) { store.rows.delete(key); return asyncRequest(() => undefined); },
    openCursor() {
      const values = [...store.rows.values()].map((value) => structuredClone(value));
      let index = 0;
      const request = { result: null, error: null, onsuccess: null, onerror: null };
      const step = () => setTimeout(() => {
        if (index >= values.length) { request.result = null; request.onsuccess?.(); return; }
        request.result = { value: values[index], continue() { index += 1; step(); } };
        request.onsuccess?.();
      }, 0);
      step();
      return request;
    }
  });
  const makeTransaction = (record, names) => {
    const list = Array.isArray(names) ? names : [names];
    const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
    tx.objectStore = (name) => {
      if (!list.includes(name) && list.length) throw new Error('Store outside transaction: ' + name);
      const store = record.stores.get(name);
      if (!store) throw new Error('Missing object store: ' + name);
      return makeStoreApi(store);
    };
    setTimeout(() => tx.oncomplete?.(), 15);
    return tx;
  };
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open(name, version) {
      const request = { result: null, transaction: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        try {
          let record = databases.get(name);
          if (!record) record = { version: 0, stores: new Map() };
          const needsUpgrade = record.version < version;
          const db = {
            objectStoreNames: { contains(storeName) { return record.stores.has(storeName); } },
            createObjectStore(storeName, options = {}) {
              const store = { keyPath: options.keyPath ?? null, rows: new Map() };
              record.stores.set(storeName, store);
              return makeStoreApi(store);
            },
            transaction(names) { return makeTransaction(record, names); },
            close() {}
          };
          request.result = db;
          if (needsUpgrade) {
            request.transaction = makeTransaction(record, [...record.stores.keys(), 'save_meta']);
            record.version = version;
            databases.set(name, record);
            request.onupgradeneeded?.();
          } else databases.set(name, record);
          setTimeout(() => request.onsuccess?.(), 20);
        } catch (error) { request.error = error; request.onerror?.(); }
      }, 0);
      return request;
    }
  }});
})();
</script>
'''

smoke_html = html.replace('<body>\n', '<body>\n' + fake_idb, 1)
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(accept_downloads=True, viewport={"width": 390, "height": 844})
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until='load')
    page.wait_for_selector('.save-select-hero')
    page.wait_for_timeout(80)

    checks = {}
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text()
    db_upgrade = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      return {version: db.version, stores: [...db.stores.keys()].sort(), marker: db.stores.get('settings').rows.get('upgrade-marker')?.value ?? null};
    }""")
    checks['dbV3Regression'] = db_upgrade['version'] == 3 and 'save_meta' in db_upgrade['stores'] and db_upgrade['marker'] == 'keep-me'

    page.locator('[data-career-new]').click()
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('오프닝 데이 백업')")
    home_text = page.locator('.season-content').inner_text()
    checks['roleStatusHome'] = '역할 상태' in home_text and 'AAA 주전' in home_text and '다음 검토' in home_text

    # Produce enough league stats and calendar time for the first scheduled organization review.
    for expected in [2, 4, 6, 8]:
        page.locator('[data-season-action="SIM_SERIES"]').click()
        page.wait_for_function(f"() => document.body.innerText.includes('{expected}/28 경기')")

    page.locator('[data-season-tab="PLAYER"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('선수')")
    ratings_text = page.locator('.season-content').inner_text()
    checks['playerRatings'] = 'Ratings' in ratings_text and 'Contact vs R' in ratings_text and 'Raw Power' in ratings_text and 'OVR 미사용' in ratings_text
    checks['playerRoleStrip'] = '역할' in ratings_text and 'AAA 주전' in ratings_text

    page.locator('[data-player-section="STATS"]').click()
    page.wait_for_function("() => document.body.innerText.includes('시즌 기록')")
    stats_text = page.locator('.season-content').inner_text()
    checks['playerStats'] = 'AVG' in stats_text and 'OPS' in stats_text and '리그 순위' in stats_text
    checks['levelSplitStats'] = 'AAA' in stats_text and 'MLB' in stats_text

    page.locator('[data-player-section="DEVELOPMENT"]').click()
    page.wait_for_function("() => document.body.innerText.includes('Development')")
    page.locator('[data-training-focus="SPEED"]').click()
    page.wait_for_function("""() => document.querySelector('[data-training-focus="SPEED"]')?.classList.contains('active')""")
    dev_text = page.locator('.season-content').inner_text()
    checks['playerDevelopment'] = '스피드 훈련' in dev_text and '실제 ceiling은 표시하지 않습니다' in dev_text

    page.locator('[data-player-section="CAREER"]').click()
    page.wait_for_function("() => document.body.innerText.includes('Career Timeline')")
    career_text = page.locator('.season-content').inner_text()
    checks['careerTimeline'] = 'Career Timeline' in career_text and '커리어 시작' in career_text and 'AAA 첫 배정' in career_text and '프로 데뷔' in career_text
    checks['careerMomentContext'] = 'vs ' in career_text and 'PA #' in career_text and '점수 ' in career_text and ('회초' in career_text or '회말' in career_text)
    checks['careerTimelineHiddenSafe'] = all(token not in career_text for token in ['candidateScore', 'incumbentScore', 'momentum":', 'recentFeedback', 'gameContext'])

    page.locator('[data-season-tab="LEAGUE"]').click()
    page.locator('[data-league-section="LEADERS"]').click()
    page.wait_for_selector('.leader-page-card')
    checks['leaderCategories'] = page.locator('[data-leader-category]').count() == 9
    checks['leaderTopRows'] = page.locator('[data-player-detail]').count() >= 1

    page.locator('[data-leader-category="HR"]').click()
    page.locator('[data-player-detail]').first.click()
    page.wait_for_selector('.player-sheet')
    sheet_text = page.locator('.player-sheet').inner_text()
    checks['competitorBottomSheet'] = 'CON R' in sheet_text and 'POWER' in sheet_text and 'AVG' in sheet_text and 'OPS' in sheet_text
    page.locator('.sheet-close').click()
    page.wait_for_function("() => !document.querySelector('.player-sheet')")

    # Organization / Depth Chart v20.
    page.locator('[data-season-tab="ORG"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('조직')")
    org_text = page.locator('.season-content').inner_text()
    checks['organizationLevels'] = all(label in org_text for label in ['MLB', 'AAA', 'High-A (A+)', 'AA', 'A']) and '현재 AAA' in org_text
    checks['multiLevelOrgText'] = 'A / High-A(A+) / AA / AAA / MLB 5단계' in org_text and '독립 일정' in org_text and '사용자 전용 보정은 사용하지 않습니다' in org_text
    checks['fullPromotionLadder'] = ('A↔High-A(A+)↔AA↔AAA↔MLB' in org_text or '인접 레벨' in org_text)
    checks['promotionReviewPublic'] = 'MLB 준비도' in org_text and '조직 경로' in org_text and '최근 평가 요인' in org_text
    checks['promotionReviewHiddenSafe'] = all(token not in org_text for token in ['candidateScore', 'incumbentScore', 'promotionMargin'])
    checks['cfDepthChart'] = 'Depth Chart' in org_text and '강민준' in org_text and page.locator('[data-org-position="CF"]').count() == 1
    page.locator('[data-org-position="SP"]').click()
    page.wait_for_function("() => document.querySelector('[data-org-position=\"SP\"]')?.classList.contains('active')")
    checks['pitcherDepthChart'] = 'BLU MLB 선발' in page.locator('.season-content').inner_text()
    pitcher_org_text = page.locator('.season-content').inner_text()
    checks['pitcherMovementReview'] = '투수 이동 검토' in pitcher_org_text and '선발 후보' in pitcher_org_text and '불펜 후보' in pitcher_org_text
    checks['pitcherMovementHiddenSafe'] = all(token not in pitcher_org_text for token in ['candidateScore', 'incumbentScore', 'performanceAdjustment', 'scoreMargin'])
    page.locator('[data-org-position="CF"]').click()
    page.locator('.org-depth-group').first.locator('[data-player-detail]').first.click()
    page.wait_for_selector('.player-sheet')
    org_sheet_text = page.locator('.player-sheet').inner_text()
    checks['orgPlayerSheet'] = 'BLU MLB CF' in org_sheet_text and 'CON R' in org_sheet_text and 'POWER' in org_sheet_text
    page.locator('.sheet-close').click()
    page.wait_for_function("() => !document.querySelector('.player-sheet')")

    # Export remains portable and advances only gameVersion, not save schema/DB schema.
    page.locator('[data-season-tab="HOME"]').click()
    with page.expect_download() as info:
        page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    checks['exportV31'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase3_utility_role_read_v34' and export_doc.get('metadata', {}).get('saveSchemaVersion') == 2 and len(export_doc.get('checksum', {}).get('value', '')) == 64
    level_seasons = export_doc.get('career', {}).get('levelSeasons', {})
    checks['exportFiveLevelSeasons'] = all(level in level_seasons for level in ['A','HIGH_A','AA','AAA','MLB'])
    career_state = export_doc.get('career', {}).get('careerEventState', {})
    career_events = career_state.get('events', []) if isinstance(career_state, dict) else []
    checks['exportCareerTimeline'] = career_state.get('schemaVersion') == 1 and len(career_events) >= 3 and career_state.get('nextSequence') == len(career_events) + 1 and 'PRO_DEBUT' in career_state.get('completedMomentKeys', [])
    pro_event = next((event for event in career_events if event.get('type') == 'PRO_DEBUT'), None)
    pro_context = pro_event.get('gameContext') if isinstance(pro_event, dict) else None
    checks['exportCareerContext'] = isinstance(pro_context, dict) and pro_context.get('kind') == 'PA' and isinstance(pro_context.get('inning'), int) and isinstance(pro_context.get('paNumber'), int) and bool(pro_context.get('opponentTeamName'))

    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase3-v31',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v32.html',
    'result': 'PASS' if all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'Standalone execution used Playwright set_content with an asynchronous IndexedDB-compatible test double. The v31 bundle exercised A/High-A/AA/AAA/MLB five-level season UI, persistent Career Timeline with official-game Career Firsts plus authoritative opponent/inning/PA/score context, existing replacement/pitcher regressions, five-level promotion ladder, level-split player stats, DB v3 persistence and .tcu export including careerEventState in Chromium.'
}
(root / 'reports' / 'phase3-career-context-v31-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
