import json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v40.html'
html = html_path.read_text()
legacy_smoke = (root / 'scripts' / 'browser-standalone-smoke-v39.py').read_text()
m = re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html", legacy_smoke, re.S)
if not m:
    raise RuntimeError('v39 fake IndexedDB harness not found')
fake_idb = m.group(1)
smoke_html = html.replace('<body>\n', '<body>\n' + fake_idb, 1)
errors = []
checks = {}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(accept_downloads=True, viewport={"width": 390, "height": 844})
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until='load')
    page.wait_for_selector('.save-select-hero')
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text()

    db_upgrade = page.evaluate("""() => { const db=window.__fakeIDBDatabases.get('the-call-up'); return {version:db.version, stores:[...db.stores.keys()].sort(), marker:db.stores.get('settings').rows.get('upgrade-marker')?.value ?? null}; }""")
    checks['dbV3Regression'] = db_upgrade['version'] == 3 and 'save_meta' in db_upgrade['stores'] and db_upgrade['marker'] == 'keep-me'

    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen')
    creation_text = page.locator('.new-career-screen').inner_text()
    checks['creationSections'] = all(token in creation_text for token in ['1. 기본 정보','2. 야구 프로필','3. 선수 유형','4. 시작 조직','예상 프로필'])
    checks['realDataBoundaryText'] = 'v45–v47' in creation_text and '실제 MLB 30개 조직' in creation_text
    checks['hiddenSafePreview'] = all(token not in creation_text for token in ['hiddenDevelopmentTrait','ceilings','true ceiling'])

    name = page.locator('[data-career-field="name"]')
    name.fill('브라우저 테스트')
    name.dispatch_event('change')
    page.locator('[data-career-field="age"]').select_option('18')
    page.locator('[data-career-field="primaryPosition"]').select_option('SS')
    page.locator('[data-career-field="bats"]').select_option('S')
    page.locator('[data-career-field="archetype"]').select_option('POWER_SPEED')
    page.locator('[data-career-trait][value="QUICK_BAT"]').check()
    page.locator('[data-career-trait][value="BASE_STEALER"]').check()
    page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
    page.wait_for_selector('[data-career-field="favoriteOrganizationId"]')
    page.locator('[data-career-field="favoriteOrganizationId"]').select_option('BLU')
    page.wait_for_function("() => document.querySelector('.career-preview-card')?.innerText.includes('브라우저 테스트')")
    preview_text = page.locator('.career-preview-card').inner_text()
    checks['creationPreviewUpdates'] = '브라우저 테스트' in preview_text and 'SS' in preview_text and '콜업 블루' in preview_text
    checks['traitLimit'] = page.locator('[data-career-trait]:checked').count() == 2 and page.locator('[data-career-trait]:disabled').count() >= 1

    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=15000)
    page.wait_for_function("() => document.body.innerText.includes('오프닝 데이 백업')")
    home_text = page.locator('.season-content').inner_text()
    checks['createdCareerHome'] = '브라우저 테스트' in home_text and 'AAA' in home_text

    page.locator('[data-season-tab="PLAYER"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('선수')")
    player_text = page.locator('.season-content').inner_text()
    checks['createdPlayerProfile'] = '브라우저 테스트' in player_text and 'SS' in player_text and 'Ratings' in player_text
    checks['playerHiddenSafe'] = all(token not in player_text for token in ['hiddenDevelopmentTrait','ceilings','Adaptability','adaptability'])

    page.locator('[data-season-tab="HOME"]').click()
    with page.expect_download() as info:
        page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    career = export_doc.get('career', {})
    profile = career.get('fixture', {}).get('careerProfile', {})
    checks['exportV40'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase3_new_career_v40' and export_doc.get('metadata', {}).get('saveSchemaVersion') == 2 and len(export_doc.get('checksum', {}).get('value','')) == 64
    checks['exportIdentity'] = profile.get('identity', {}).get('name') == '브라우저 테스트' and profile.get('identity', {}).get('primaryPosition') == 'SS'
    checks['exportTraits'] = profile.get('visibleTraits') == ['QUICK_BAT','BASE_STEALER']
    checks['authoritativeHiddenStored'] = bool(profile.get('startingProfile', {}).get('hiddenDevelopmentTrait')) and bool(profile.get('startingProfile', {}).get('ceilings'))

    meta = page.evaluate("""() => { const db=window.__fakeIDBDatabases.get('the-call-up'); return {saves:db.stores.get('saves').rows.size, backups:db.stores.get('backups').rows.size, meta:db.stores.get('save_meta').rows.size}; }""")
    checks['openingDayPersistence'] = meta['saves'] >= 1 and meta['backups'] >= 1 and meta['meta'] >= 1
    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase3-v40',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v40.html',
    'result': 'PASS' if all(v is True for k,v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'v40 standalone smoke covers Save Select -> New Career creation UI -> authoritative career creation -> opening-day save/backup -> Player view -> .tcu export, while preserving IndexedDB v3 and save schema v2.'
}
(root / 'reports' / 'phase3-new-career-v40-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
