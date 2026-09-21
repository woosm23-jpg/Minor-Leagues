import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v50_WORK_PRODUCTION.html'
html = html_path.read_text()
legacy = (root / 'scripts' / 'browser-standalone-smoke-v39.py').read_text()
match = re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html", legacy, re.S)
if not match:
    raise RuntimeError('fake IndexedDB harness not found')
smoke_html = html.replace('<body>\n', '<body>\n' + match.group(1), 1)

veterans = ['Christian Bethancourt', 'Jihwan Bae', 'Jakson Reetz', 'Pablo Reyes']
checks = {}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until='domcontentloaded', timeout=120000)
    page.wait_for_selector('.save-select-hero', timeout=30000)
    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen', timeout=30000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
    page.locator('[data-career-field="favoriteOrganizationId"]').select_option('117')
    page.locator('[data-career-field="name"]').fill('Top100 Smoke')
    page.locator('[data-career-field="age"]').select_option('20')
    page.locator('[data-career-field="primaryPosition"]').select_option('CF')
    page.locator('[data-career-field="archetype"]').select_option('BALANCED')
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=120000)
    checks['homeCareerFeed'] = page.locator('.home-career-feed').count() == 1 and 'Career Feed' in page.locator('.home-career-feed').inner_text()

    page.locator('[data-season-tab="LEAGUE"]').click()
    page.wait_for_selector('[data-league-section="PROSPECTS"]', timeout=30000)
    page.locator('[data-league-section="PROSPECTS"]').click()
    page.wait_for_selector('.leader-page-card.scouting-card .leader-row', timeout=30000)

    rows = page.locator('.leader-page-card.scouting-card .leader-row')
    texts = [rows.nth(i).inner_text() for i in range(rows.count())]
    joined = '\n'.join(texts)
    checks['top100Count'] = len(texts) == 100
    checks['veteransExcluded'] = all(name not in joined for name in veterans)
    diego = next((text for text in texts if 'Diego Velasquez' in text), '')
    checks['realProspectRetained'] = bool(diego)
    checks['realProspectAge'] = '22세' in diego
    checks['parentMlbOrganization'] = 'SF · AAA' in diego
    checks['affiliateNotShown'] = 'SAC · AAA' not in diego and 'Sacramento' not in diego
    note_text = page.locator('.leader-page-card.scouting-card .condition-note').inner_text()
    checks['eligibilityNote'] = 'MLB 데뷔 이력이 없는 마이너리그 선수만' in note_text
    checks['pageErrors'] = len(errors)
    browser.close()

passed = all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0
result = {
    'version': 'v50-work-production-top100-focused-smoke',
    'standalone': html_path.name,
    'result': 'PASS' if passed else 'FAIL',
    'checks': checks,
    'errors': errors,
    'diegoRow': diego,
    'note': 'Production UI path: create Houston career, open League > Prospects > Top 100, verify 100 rows, reported MLB veterans absent, a real no-debut prospect retained with real age and parent MLB organization, and pageerror=0.'
}
(root / 'reports' / 'v50-work-production-top100-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit(1)
