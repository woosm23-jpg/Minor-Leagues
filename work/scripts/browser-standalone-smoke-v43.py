import json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v43.html'
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
    name = page.locator('[data-career-field="name"]')
    name.fill('부상 테스트')
    name.dispatch_event('change')
    page.locator('[data-career-field="age"]').select_option('19')
    page.locator('[data-career-field="primaryPosition"]').select_option('CF')
    page.locator('[data-career-field="archetype"]').select_option('ATHLETIC')
    page.locator('[data-career-trait][value="QUICK_FIRST_STEP"]').check()
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=15000)
    page.wait_for_function("() => document.body.innerText.includes('오프닝 데이 백업')")

    page.locator('[data-season-tab="PLAYER"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('선수')")
    page.locator('[data-player-section="DEVELOPMENT"]').click()
    page.wait_for_function("() => document.querySelector('[data-player-section=\"DEVELOPMENT\"]')?.classList.contains('active')")
    player_text = page.locator('.season-content').inner_text()
    checks['healthSurface'] = '건강' in player_text and '내구성' in player_text
    checks['hiddenHealthAgeSafe'] = 'health.age' not in player_text and '숨은 나이' not in player_text

    page.locator('[data-season-tab="HOME"]').click()
    with page.expect_download() as info:
        page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    profile = export_doc.get('career', {}).get('fixture', {}).get('careerProfile', {})
    user_id = export_doc.get('career', {}).get('fixture', {}).get('userPlayerId')
    user_state = export_doc.get('career', {}).get('playerStates', {}).get(user_id, {})
    health = user_state.get('health', {})
    checks['exportV43'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase3_development_core_v43' and export_doc.get('metadata', {}).get('saveSchemaVersion') == 2 and len(export_doc.get('checksum', {}).get('value','')) == 64
    checks['authoritativeHealthStored'] = health.get('version') == 1 and isinstance(health.get('durability'), (int,float)) and health.get('activeInjury') is None and health.get('history', {}).get('total') == 0
    aging = user_state.get('aging', {})
    checks['authoritativeAgingStored'] = aging.get('version') == 1 and aging.get('processedSeasons') == [] and isinstance(aging.get('modifiers'), dict)
    checks['hiddenAgingStateSafe'] = 'processedSeasons' not in player_text and 'aging.modifiers' not in player_text
    development = user_state.get('development', {})
    checks['authoritativeDevelopmentStored'] = development.get('version') == 2 and isinstance(development.get('randomKey'), int) and isinstance(development.get('rate'), (int,float)) and isinstance(development.get('workEthic'), (int,float)) and isinstance(development.get('ceilings'), dict) and development.get('processedOffseasons') == []
    checks['hiddenDevelopmentStateSafe'] = all(token not in player_text for token in ['hiddenTrait', 'randomKey', 'workEthic', 'processedOffseasons', 'ceilings'])
    checks['careerProfilePreserved'] = profile.get('identity', {}).get('name') == '부상 테스트' and profile.get('identity', {}).get('primaryPosition') == 'CF'

    meta = page.evaluate("""() => { const db=window.__fakeIDBDatabases.get('the-call-up'); return {saves:db.stores.get('saves').rows.size, backups:db.stores.get('backups').rows.size, meta:db.stores.get('save_meta').rows.size}; }""")
    checks['openingDayPersistence'] = meta['saves'] >= 1 and meta['backups'] >= 1 and meta['meta'] >= 1
    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase3-v43',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v43.html',
    'result': 'PASS' if all(v is True for k,v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'v43 standalone smoke covers New Career -> public development/health surface -> authoritative hidden development + health + aging persistence -> .tcu export while preserving IndexedDB v3 and save schema v2.'
}
(root / 'reports' / 'phase3-development-core-v43-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
