import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v18.html'
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
    page = browser.new_page(accept_downloads=True)
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until='load')
    page.wait_for_selector('.save-select-hero')
    page.wait_for_timeout(80)

    checks = {}
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text() and '저장된 커리어가 없습니다' in page.locator('body').inner_text()

    db_upgrade = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      return {version: db.version, stores: [...db.stores.keys()].sort(), marker: db.stores.get('settings').rows.get('upgrade-marker')?.value ?? null};
    }""")
    checks['dbUpgradeV3'] = db_upgrade['version'] == 3 and 'save_meta' in db_upgrade['stores'] and db_upgrade['marker'] == 'keep-me'

    # Career A: create, play one completed game, then enter a live game checkpoint.
    page.locator('[data-career-new]').click()
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('오프닝 데이 백업')")
    page.locator('[data-season-action="SIM_GAME"]').click()
    page.wait_for_function("() => document.body.innerText.includes('1/28 경기')")
    page.get_by_role('button', name='다음 출전').click()
    page.wait_for_selector('.game-title')
    page.locator('#reset-game').click()
    page.wait_for_function("() => document.body.innerText.includes('경기 계속')")
    page.locator('[data-season-action="CAREERS"]').click()
    page.wait_for_selector('.save-select-list')
    page.wait_for_function("() => document.body.innerText.includes('진행 중 경기')")

    # Career B: a second independent slot.
    page.locator('[data-career-new]').click()
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('0/28 경기')")
    page.locator('[data-season-action="CAREERS"]').click()
    page.wait_for_selector('.save-select-list')
    checks['twoCareerSlots'] = page.locator('.save-slot').count() == 2

    meta_state = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      const meta = [...db.stores.get('save_meta').rows.values()];
      const saves = [...db.stores.get('saves').rows.values()];
      return {metaCount: meta.length, saveCount: saves.length, metaHasPayload: meta.some(row => 'payload' in row), activeMeta: meta.filter(row => row.hasActiveGame).length};
    }""")
    checks['lightweightMetadataStore'] = meta_state['metaCount'] == 2 and meta_state['saveCount'] == 2 and not meta_state['metaHasPayload'] and meta_state['activeMeta'] == 1

    # Continue the active slot and ensure the checkpoint is really restored.
    active_card = page.locator('.save-slot').filter(has_text='진행 중 경기')
    active_card.locator('[data-save-continue]').click()
    page.wait_for_function("() => document.body.innerText.includes('경기 계속')")
    checks['continueRestoresCheckpoint'] = '1/28 경기' in page.locator('.season-content').inner_text() and '진행 중 경기' in page.locator('.season-content').inner_text()

    # Export regression from v16/v17 remains available in the selected career.
    with page.expect_download() as info:
      page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    checks['exportRegression'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase2_save_select_v18' and len(export_doc.get('checksum', {}).get('value', '')) == 64

    # Return to selector and delete the inactive slot; backup rows must be cleaned with it.
    page.locator('[data-season-action="CAREERS"]').click()
    page.wait_for_selector('.save-select-list')
    inactive = page.locator('.save-slot').filter(has_not_text='진행 중 경기')
    inactive.locator('[data-save-delete]').click()
    page.wait_for_function("() => document.querySelectorAll('.save-slot').length === 1")
    final_db = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      return {saves: db.stores.get('saves').rows.size, meta: db.stores.get('save_meta').rows.size, backups: db.stores.get('backups').rows.size};
    }""")
    checks['deleteIsolation'] = final_db['saves'] == 1 and final_db['meta'] == 1 and final_db['backups'] == 1
    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase2-v18',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v18.html',
    'result': 'PASS' if all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'Standalone execution used Playwright set_content with an asynchronous IndexedDB-compatible test double. The bundled v18 app exercised DB v2→v3 upgrade, lightweight save_meta, two independent career slots, active-game Continue, export regression and isolated delete in Chromium.'
}
(root / 'reports' / 'phase2-save-select-v18-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
