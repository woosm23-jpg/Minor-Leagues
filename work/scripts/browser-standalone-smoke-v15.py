import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v15.html'
html = html_path.read_text()

fake_idb = r'''
<script>
(() => {
  const databases = new Map();
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
    page = browser.new_page()
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.set_content(smoke_html, wait_until='load')
    page.wait_for_selector('.season-title')

    checks = {}
    checks['bootErrorAbsent'] = page.locator('.boot-error').count() == 0
    checks['v15SaveUi'] = 'IndexedDB · v15' in page.locator('.save-card').inner_text()

    page.locator('[data-season-action="PLAY"]').first.click()
    page.wait_for_selector('.game-title')
    page.locator('[data-approach="CONTACT"]').click()
    page.wait_for_timeout(100)
    game_text_before = page.locator('.game-screen').inner_text()
    checks['gamePlayedOneUserPA'] = '접근법 선택' in game_text_before or '경기 종료' in game_text_before

    page.locator('#reset-game').click()
    page.wait_for_selector('.season-title')
    page.wait_for_function("() => document.body.innerText.includes('자동 저장됨')")
    home_text = page.locator('.season-content').inner_text()
    checks['activeGameShownOnHome'] = '진행 중 경기' in home_text and '경기 계속' in home_text
    checks['checkpointAutosaveMessage'] = '자동 저장됨' in home_text

    page.locator('[data-season-action="LOAD"]').click()
    page.wait_for_function("() => document.body.innerText.includes('저장된 시즌을 불러왔습니다.')")
    checks['activeCheckpointLoads'] = '진행 중 경기' in page.locator('.season-content').inner_text()

    page.locator('[data-season-action="PLAY"]').first.click()
    page.wait_for_selector('.game-title')
    game_text_after = page.locator('.game-screen').inner_text()
    checks['checkpointResumeUiMatches'] = game_text_after == game_text_before

    page.locator('#reset-game').click()
    page.wait_for_selector('.season-title')
    page.locator('[data-season-action="SIM_GAME"]').click()
    page.wait_for_function("() => document.body.innerText.includes('1/28 경기')")
    checks['simCurrentGameAfterCheckpoint'] = '1/28 경기' in page.locator('.season-content').inner_text()

    page.locator('[data-season-action="SAVE"]').click()
    page.wait_for_function("() => document.body.innerText.includes('수동 저장 완료')")
    checks['manualSaveWorks'] = '수동 저장 완료' in page.locator('.save-card').inner_text()
    page.locator('[data-season-action="LOAD"]').click()
    page.wait_for_function("() => document.body.innerText.includes('저장된 시즌을 불러왔습니다.')")
    checks['loadWorks'] = '저장된 시즌을 불러왔습니다.' in page.locator('.save-card').inner_text()
    checks['pageErrors'] = len(errors)

    browser.close()

result = {
    'version': 'phase2-v15',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v15.html',
    'result': 'PASS' if all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'Browser navigation is administrator-blocked in this sandbox, so standalone execution used Playwright set_content with an injected asynchronous IndexedDB-compatible test double. Node tests separately cover payload checkpoint/migration round-trips.'
}
(root / 'reports' / 'phase2-save-checkpoint-v15-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
