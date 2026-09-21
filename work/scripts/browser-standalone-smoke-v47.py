import json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v47_PRODUCTION.html'
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
    page.set_content(smoke_html, wait_until='load', timeout=120000)
    page.wait_for_selector('.save-select-hero', timeout=30000)
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text()

    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen', timeout=30000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').check()
    page.wait_for_selector('[data-career-field="favoriteOrganizationId"]')
    org_select = page.locator('[data-career-field="favoriteOrganizationId"]')
    checks['productionOrganizations30'] = org_select.locator('option').count() == 30
    first_org_id = org_select.locator('option').first.get_attribute('value')
    first_org_text = org_select.locator('option').first.inner_text()
    org_select.select_option(first_org_id)

    page.locator('[data-career-field="name"]').fill('Production Smoke')
    page.locator('[data-career-field="age"]').select_option('18')
    page.locator('[data-career-field="primaryPosition"]').select_option('SS')
    page.locator('[data-career-field="archetype"]').select_option('BALANCED')
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=120000)
    checks['careerCreated'] = True
    checks['selectedRealOrganizationVisible'] = first_org_text.split(' (')[0] in page.locator('body').inner_text()

    page.locator('[data-season-tab="HOME"]').click()
    with page.expect_download(timeout=120000) as info:
        page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    career = export_doc.get('career', {})
    universe = career.get('dataUniverse', {})
    fixture = career.get('fixture', {})
    levels = fixture.get('levelLeagues', {})
    checks['gameVersionV47'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase4_production_world_activation_v47'
    checks['productionUniverseStored'] = universe.get('origin') == 'MASTER_SNAPSHOT' and universe.get('independent') is True and universe.get('sourceSnapshot', {}).get('hash') == 'fnv1a32:5d641237'
    checks['productionFixtureStored'] = fixture.get('worldMode') == 'PRODUCTION_REAL' and fixture.get('scheduleSource') == 'MASTER_SNAPSHOT' and fixture.get('organization', {}).get('userLevel') == 'A'
    checks['fiveRealLevelsStored'] = set(levels.keys()) == {'MLB','AAA','AA','HIGH_A','A'} and all(len(levels[k].get('teams', [])) == 30 for k in levels)
    checks['fullUniverseCoverageStored'] = len(universe.get('data', {}).get('teams', [])) == 150 and len(universe.get('data', {}).get('players', [])) == 5201 and len(universe.get('data', {}).get('parks', [])) == 30
    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase4-v47-production',
    'browser': 'System Chromium via Playwright',
    'standalone': 'dist/THE_CALL_UP_SEASON_STANDALONE_v47_PRODUCTION.html',
    'result': 'PASS' if all(v is True for k,v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0 else 'FAIL',
    'checks': checks,
    'errors': errors,
    'environmentNote': 'v47 production smoke covers embedded real snapshot -> 30 organization New Career -> production fixture -> full Master Snapshot save/export.'
}
(root / 'reports' / 'phase4-production-v47-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
