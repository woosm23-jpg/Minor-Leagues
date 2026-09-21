import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v49_PRODUCTION.html'
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
    page.locator('[data-career-field="age"]').select_option('21')
    page.locator('[data-career-field="primaryPosition"]').select_option('CF')
    page.locator('[data-career-field="archetype"]').select_option('BALANCED')
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=120000)
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')", timeout=120000)

    checks['sevenDaysButton'] = page.locator('[data-season-action="SIM_7_DAYS"]').count() == 1
    checks['importantEventButton'] = page.locator('[data-season-action="SIM_IMPORTANT"]').count() == 1
    page.locator('[data-season-action="SIM_7_DAYS"]').click()
    page.wait_for_selector('.progress-stop-card', timeout=120000)
    stop_text = page.locator('.progress-stop-card').inner_text()
    body_text = page.locator('body').inner_text()
    checks['stoppedOnImportantEvent'] = '중요 이벤트에서 정지' in stop_text
    checks['proDebutStop'] = '프로 데뷔' in stop_text
    checks['autosaveAfterProgress'] = '자동 저장됨' in body_text
    checks['pageErrors'] = len(errors)
    browser.close()

passed = all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0
result = {
    'version': 'phase5-v49-seven-day-important-event-progress',
    'standalone': html_path.name,
    'result': 'PASS' if passed else 'FAIL',
    'checks': checks,
    'errors': errors,
    'note': 'Production mobile path: create age-21 CWS AAA career, verify both v49 progress controls, run 7 Days, auto-stop on the first AAA game PRO_DEBUT, autosave, and pageerror=0.'
}
(root / 'reports' / 'phase5-v49-production-progress-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit(1)
