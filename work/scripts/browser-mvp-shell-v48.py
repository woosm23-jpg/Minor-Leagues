import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v48.html'
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
    page = browser.new_page(accept_downloads=True, viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until='domcontentloaded', timeout=120000)
    page.wait_for_selector('.save-select-hero', timeout=30000)
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text()

    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen', timeout=30000)
    checks['newCareerScreen'] = '선수 만들기' in page.locator('.new-career-screen').inner_text()
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title', timeout=30000)
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')")

    nav = page.locator('.season-nav button')
    nav_text = [nav.nth(i).inner_text().replace('\n', ' ') for i in range(nav.count())]
    checks['fiveTabMvpNav'] = nav.count() == 5 and all(label in ' '.join(nav_text) for label in ['홈', '경기', '선수', '리그', '더보기'])
    checks['noDirectOrgTab'] = page.locator('[data-season-tab="ORG"]').count() == 0
    checks['touchTargets44'] = all((nav.nth(i).bounding_box() or {}).get('height', 0) >= 44 for i in range(nav.count()))

    page.locator('[data-season-tab="MORE"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('더보기')")
    checks['moreDefaultsToOrg'] = 'Depth Chart' in page.locator('.season-content').inner_text()
    checks['moreThreeSections'] = page.locator('[data-more-section]').count() == 3

    page.locator('[data-more-section="FEED"]').click()
    page.wait_for_function("() => document.body.innerText.includes('Career Feed')")
    feed_text = page.locator('.season-content').inner_text()
    checks['careerFeed'] = 'Career Feed' in feed_text and '커리어 시작' in feed_text

    page.locator('[data-more-section="SETTINGS"]').click()
    page.wait_for_function("() => document.body.innerText.includes('Settings')")
    settings_text = page.locator('.season-content').inner_text()
    checks['settingsSaveHub'] = all(token in settings_text for token in ['Settings', 'Quick AB', 'IndexedDB', '수동 저장', '.tcu 내보내기', '.tcu 가져오기'])

    with page.expect_download() as info:
        page.locator('[data-season-action="EXPORT"]').click()
    export_doc = json.loads(Path(info.value.path()).read_text())
    checks['saveSchemaStable'] = export_doc.get('metadata', {}).get('saveSchemaVersion') == 2
    checks['engineBaselineStable'] = export_doc.get('metadata', {}).get('gameVersion') == 'phase4_production_world_activation_v47'

    page.locator('[data-season-tab="PLAYER"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('선수')")
    checks['playerTab'] = 'Ratings' in page.locator('.season-content').inner_text()

    page.locator('[data-season-tab="LEAGUE"]').click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('리그')")
    checks['leagueTab'] = '순위' in page.locator('.season-content').inner_text()

    checks['pageErrors'] = len(errors)
    browser.close()

passed = all(v is True for k, v in checks.items() if k != 'pageErrors') and checks['pageErrors'] == 0
result = {
    'version': 'phase5-mvp-shell-v48',
    'standalone': html_path.name,
    'result': 'PASS' if passed else 'FAIL',
    'checks': checks,
    'errors': errors,
    'note': 'v48 is a presentation/navigation milestone. Save schema v2 and v47 baseball-engine gameVersion intentionally remain unchanged.'
}
(root / 'reports' / 'phase5-mvp-shell-v48-browser-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit(1)
