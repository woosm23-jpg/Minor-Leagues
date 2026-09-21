import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v16.html'
html = html_path.read_text()

fake_idb = r'''
<script>
(() => {
  const databases = new Map();
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

    checks = {}
    checks['bootErrorAbsent'] = page.locator('.boot-error').count() == 0
    save_text = page.locator('.save-card').inner_text()
    checks['v16TransferUi'] = all(token in save_text for token in ['.tcu', '내보내기', '가져오기', '복사본'])

    # Create and checkpoint a live game before export.
    page.locator('[data-season-action="PLAY"]').first.click()
    page.wait_for_selector('.game-title')
    page.locator('[data-approach="CONTACT"]').click()
    page.wait_for_timeout(100)
    game_text_before = page.locator('.game-screen').inner_text()
    page.locator('#reset-game').click()
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('자동 저장됨')")
    checks['checkpointReady'] = '진행 중 경기' in page.locator('.season-content').inner_text()

    # Export through the real Blob/download UI and inspect the file.
    with page.expect_download() as info:
      page.locator('[data-season-action="EXPORT"]').click()
    download = info.value
    export_path = Path(download.path())
    export_text = export_path.read_text()
    export_doc = json.loads(export_text)
    checks['downloadExtension'] = download.suggested_filename.endswith('.tcu')
    checks['exportEnvelope'] = export_doc.get('format') == 'THE_CALL_UP_CAREER_EXPORT' and export_doc.get('formatVersion') == 1
    checks['exportChecksumShape'] = export_doc.get('checksum', {}).get('algorithm') == 'SHA-256' and len(export_doc.get('checksum', {}).get('value', '')) == 64
    checks['exportHasCheckpoint'] = bool(export_doc.get('career', {}).get('activeGameCheckpoint'))

    # Import the exported file as a copy via the hidden file input.
    page.locator('[data-tcu-import]').set_input_files({
      'name': download.suggested_filename,
      'mimeType': 'application/vnd.the-call-up+json',
      'buffer': export_text.encode('utf-8')
    })
    page.wait_for_function("() => document.body.innerText.includes('가져오기 완료 · 복사본')")
    imported_text = page.locator('.save-card').inner_text()
    checks['importAsCopyMessage'] = '가져오기 완료 · 복사본 import_' in imported_text
    checks['importPreservesCheckpointUi'] = '진행 중 경기' in page.locator('.season-content').inner_text()

    # Resume imported checkpoint and make sure the UI state matches exported checkpoint.
    page.locator('[data-season-action="PLAY"]').first.click()
    page.wait_for_selector('.game-title')
    game_text_after = page.locator('.game-screen').inner_text()
    checks['importedCheckpointUiMatches'] = game_text_after == game_text_before
    page.locator('#reset-game').click()
    page.wait_for_selector('.season-title')

    # Advance copied save; autosave must keep both original and imported slots.
    page.locator('[data-season-action="SIM_GAME"]').click()
    page.wait_for_function("() => document.body.innerText.includes('1/28 경기')")
    page.wait_for_function("() => document.body.innerText.includes('자동 저장됨')")
    save_ids = page.evaluate("""() => {
      const db = window.__fakeIDBDatabases.get('the-call-up');
      const store = db?.stores?.get('saves');
      return store ? [...store.rows.keys()].sort() : [];
    }""")
    checks['sourceAndCopyBothPersist'] = len(save_ids) >= 2 and any(x.startswith('import_') for x in save_ids) and any(not x.startswith('import_') for x in save_ids)
    checks['pageErrors'] = len(errors)

    browser.close()

result = {
    'version': 'phase2-v16',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v16.html',
    'result': 'PASS' if all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'Browser navigation is administrator-blocked in this sandbox, so standalone execution used Playwright set_content with an injected asynchronous IndexedDB-compatible test double. The Blob download, File upload, .tcu envelope, import-as-copy flow and UI checkpoint resume were exercised in Chromium; Node tests separately verify checksum and Full Validation failure paths.'
}
(root / 'reports' / 'phase2-export-import-v16-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
