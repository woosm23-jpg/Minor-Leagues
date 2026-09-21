import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v17.html'
html = html_path.read_text()

fake_idb = r'''
<script>
(() => {
  const databases = new Map();
  databases.set('the-call-up', { version: 1, stores: new Map([
    ['settings', { keyPath: 'key', rows: new Map([['upgrade-marker', { key: 'upgrade-marker', value: 'keep-me' }]]) }],
    ['saves', { keyPath: 'saveId', rows: new Map() }]
  ]) });
  window.__fakeIDBDatabases = databases;
  const makeRequest = (producer) => {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      try { request.result = producer(); request.onsuccess?.(); }
      catch (error) { request.error = error; request.onerror?.(); }
    }, 0);
    return request;
  };
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open(name, version) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setTimeout(() => {
        try {
          let record = databases.get(name);
          const needsUpgrade = !record || record.version < version;
          if (!record) record = { version, stores: new Map() };
          if (version > record.version) record.version = version;
          const db = {
            objectStoreNames: { contains(storeName) { return record.stores.has(storeName); } },
            createObjectStore(storeName, options = {}) {
              const store = { keyPath: options.keyPath ?? null, rows: new Map() };
              record.stores.set(storeName, store);
              return store;
            },
            transaction(storeName) {
              const store = record.stores.get(storeName);
              if (!store) throw new Error('Missing object store: ' + storeName);
              const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
              tx.objectStore = () => ({
                put(value) {
                  const key = value[store.keyPath];
                  store.rows.set(key, structuredClone(value));
                  return makeRequest(() => key);
                },
                get(key) { return makeRequest(() => store.rows.has(key) ? structuredClone(store.rows.get(key)) : undefined); },
                getAll() { return makeRequest(() => [...store.rows.values()].map((value) => structuredClone(value))); },
                delete(key) { store.rows.delete(key); return makeRequest(() => undefined); }
              });
              setTimeout(() => tx.oncomplete?.(), 5);
              return tx;
            },
            close() {}
          };
          request.result = db;
          databases.set(name, record);
          if (needsUpgrade) request.onupgradeneeded?.();
          setTimeout(() => request.onsuccess?.(), 0);
        } catch (error) {
          request.error = error;
          request.onerror?.();
        }
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
    page = browser.new_page(accept_downloads=True)
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.set_content(smoke_html, wait_until='load')
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('오프닝 데이 백업')")

    checks = {}
    checks['bootErrorAbsent'] = page.locator('.boot-error').count() == 0
    save_text = page.locator('.save-card').inner_text()
    checks['v17BackupUi'] = all(token in save_text for token in ['마일스톤 백업', '최근 6개', '오프닝 데이', '복구'])

    db_state = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      return {
        version: db?.version ?? null,
        stores: db ? [...db.stores.keys()].sort() : [],
        saves: db?.stores?.get('saves')?.rows?.size ?? 0,
        backups: db?.stores?.get('backups')?.rows?.size ?? 0,
        upgradeMarker: db?.stores?.get('settings')?.rows?.get('upgrade-marker')?.value ?? null
      };
    }""")
    checks['dbUpgradeV2'] = db_state['version'] == 2 and 'backups' in db_state['stores'] and db_state['saves'] == 1 and db_state['backups'] == 1 and db_state['upgradeMarker'] == 'keep-me'

    # Move the main slot forward, then recover the Opening Day backup as a copy.
    page.locator('[data-season-action="SIM_GAME"]').click()
    page.wait_for_function("() => document.body.innerText.includes('1/28 경기')")
    page.wait_for_timeout(100)
    page.locator('[data-backup-restore]').first.click()
    page.wait_for_function("() => document.body.innerText.includes('백업 복구 완료 · 복구본')")
    content_after_recovery = page.locator('.season-content').inner_text()
    checks['recoveryReturnsOpeningDay'] = '0/28 경기' in content_after_recovery and '0-0' in content_after_recovery

    copy_state = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      const saves = db?.stores?.get('saves')?.rows;
      const rows = saves ? [...saves.values()] : [];
      return rows.map((row) => ({ saveId: row.saveId, completedGames: row.payload?.season?.completedGames ?? null, recoveredFrom: row.recoveredFrom ?? null }));
    }""")
    checks['recoveryIsCopyAndSourceUntouched'] = len(copy_state) >= 2 and any(r['saveId'].startswith('recovery_') and r['completedGames'] == 0 for r in copy_state) and any(not r['saveId'].startswith('recovery_') and r['completedGames'] > 0 for r in copy_state)

    # Complete the recovered season through the real UI. A season-end milestone backup must appear automatically.
    for expected in range(2, 29, 2):
      page.locator('[data-season-action="SIM_SERIES"]').click()
      page.wait_for_function(f"() => document.body.innerText.includes('{expected}/28 경기')")
      page.wait_for_timeout(80)
    page.wait_for_function("() => document.body.innerText.includes('시즌 종료 백업')")
    final_save_text = page.locator('.save-card').inner_text()
    checks['seasonEndBackupUi'] = '시즌 종료' in final_save_text and '복구' in final_save_text

    final_db = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      const backups = db?.stores?.get('backups')?.rows;
      return backups ? [...backups.values()].map((row) => ({ saveId: row.saveId, milestone: row.milestone, status: row.status, completedGames: row.payload?.season?.completedGames ?? null })) : [];
    }""")
    checks['seasonEndBackupPersisted'] = any(r['saveId'].startswith('recovery_') and r['milestone'] == 'SEASON_END' and r['status'] == 'COMPLETE' and r['completedGames'] == 112 for r in final_db)

    # v16 export/import behavior remains live in the same standalone.
    with page.expect_download() as info:
      page.locator('[data-season-action="EXPORT"]').click()
    download = info.value
    export_text = Path(download.path()).read_text()
    export_doc = json.loads(export_text)
    checks['transferRegression'] = export_doc.get('format') == 'THE_CALL_UP_CAREER_EXPORT' and export_doc.get('metadata', {}).get('gameVersion') == 'phase2_save_select_v18' and len(export_doc.get('checksum', {}).get('value', '')) == 64
    checks['pageErrors'] = len(errors)

    browser.close()

result = {
    'version': 'phase2-v17',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v17.html',
    'result': 'PASS' if all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'Browser navigation is administrator-blocked in this sandbox, so standalone execution used Playwright set_content with an injected asynchronous IndexedDB-compatible test double. The real v17 bundled app exercised DB v2 store creation, Opening Day backup, recovery-as-copy, Season End backup, and v16 .tcu export regression in Chromium.'
}
(root / 'reports' / 'phase2-rotating-backups-v17-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
