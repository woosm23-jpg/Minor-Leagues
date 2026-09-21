import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v48_1_PRODUCTION.html'
html = html_path.read_text()
legacy = (root / 'scripts' / 'browser-standalone-smoke-v39.py').read_text()
match = re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html", legacy, re.S)
if not match:
    raise RuntimeError('fake IndexedDB harness not found')
smoke_html = html.replace('<body>\n', '<body>\n' + match.group(1), 1)

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
    page.locator('[data-career-field="favoriteOrganizationId"]').select_option('145')
    page.locator('[data-career-field="name"]').fill('강민준')
    page.locator('[data-career-field="age"]').select_option('20')
    page.locator('[data-career-field="primaryPosition"]').select_option('CF')
    page.locator('[data-career-field="archetype"]').select_option('BALANCED')
    page.locator('[data-career-create-submit]').click()

    # renderHome() is reached only after saveSeason + OPENING_DAY full-validation
    # milestone backup both succeed in seasonApp.onCreate().
    page.wait_for_selector('.season-title', timeout=120000)
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')", timeout=120000)
    body_text = page.locator('body').inner_text()
    checks['careerCreatedAndOpenedHome'] = True
    checks['noCareerCreationFailure'] = '새 커리어 생성 실패' not in body_text
    checks['openingDayAutosaveCompleted'] = '자동 저장됨 · 오프닝 데이 백업' in body_text
    checks['pageErrors'] = len(errors)
    browser.close()

passed = all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0
result = {
    'version': 'phase5-v48.1-production-save-hotfix',
    'standalone': html_path.name,
    'result': 'PASS' if passed else 'FAIL',
    'checks': checks,
    'errors': errors,
    'note': 'Exact full Production standalone regression for the reported Chicago White Sox / age-20 New Career path. Reaching Season Home proves initial save and OPENING_DAY FULL-validation backup completed.'
}
(root / 'reports' / 'phase5-v48_1-production-new-career-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit(1)
