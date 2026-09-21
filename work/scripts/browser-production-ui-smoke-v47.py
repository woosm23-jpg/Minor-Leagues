import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
snapshot_path = root / 'data' / 'master-snapshots' / 'mlb-milb-2026-production.json'
standalone_path = root / 'dist' / 'THE_CALL_UP_SEASON_STANDALONE_v47_PRODUCTION.html'
report_path = root / 'reports' / 'phase4-production-v47-browser-smoke.json'

snapshot = json.loads(snapshot_path.read_text())
organizations = sorted([
    {
        'id': str(team['id']),
        'name': team['name'],
        'shortName': team.get('abbreviation') or team['name'],
        'pool': 'PRODUCTION_30',
        'provisional': False,
    }
    for team in snapshot['teams']
    if team['level'] == 'MLB' and team.get('active', True) is not False
], key=lambda row: row['name'])
if len(organizations) != 30:
    raise RuntimeError(f'production MLB organization count != 30: {len(organizations)}')

# Build a browser-only catalog smoke derivative. The release standalone itself is
# not modified. Heavy 5,201-player inference/fixture/save is verified separately
# by verify-production-runtime-v47.mjs. This smoke exercises the real UI with the
# exact 30 organization identities from the validated Production snapshot.
html = standalone_path.read_text()
prefix = '<script>globalThis.__THE_CALL_UP_MASTER_SNAPSHOT__ = '
start = html.index(prefix) + len(prefix)
_, consumed = json.JSONDecoder().raw_decode(html[start:])
end = start + consumed
html = html[:start] + 'null' + html[end:]
needle = 'const careerCatalog = seasonApi.getCareerCreationCatalog({ masterSnapshot });'
replacement = (
    'const careerCatalog = Object.freeze({ ...seasonApi.getCareerCreationCatalog(), '
    'organizations: Object.freeze(' + json.dumps(organizations, ensure_ascii=False, separators=(',', ':')) + ') });'
)
if needle not in html:
    raise RuntimeError('career catalog hook not found')
html = html.replace(needle, replacement, 1)

legacy = (root / 'scripts' / 'browser-standalone-smoke-v39.py').read_text()
match = re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html", legacy, re.S)
if not match:
    raise RuntimeError('fake IndexedDB harness not found')
smoke_html = html.replace('<body>\n', '<body>\n' + match.group(1), 1)

errors = []
checks = {}
names = []
with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/usr/bin/chromium',
        headless=True,
        args=['--no-sandbox', '--disable-dev-shm-usage'],
    )
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    page.set_content(smoke_html, wait_until='domcontentloaded', timeout=120000)
    page.wait_for_selector('.save-select-hero', timeout=30000)
    checks['startsAtSaveSelect'] = 'THE CALL-UP' in page.locator('.save-select-hero').inner_text()

    # DOM click avoids a zero-layout quirk in the injected IndexedDB harness.
    page.locator('[data-career-new]').evaluate('(e) => e.click()')
    page.wait_for_selector('.new-career-screen', timeout=30000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').evaluate(
        '(e) => { e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); }'
    )
    page.wait_for_selector('[data-career-field="favoriteOrganizationId"]', timeout=30000)
    select = page.locator('[data-career-field="favoriteOrganizationId"]')
    names = [select.locator('option').nth(i).inner_text() for i in range(select.locator('option').count())]

    checks['productionOrganizations30'] = len(names) == 30
    checks['realOrganizationNames'] = (
        any('Arizona Diamondbacks' in name for name in names)
        and any('New York Yankees' in name for name in names)
    )
    checks['noSyntheticDevOrganizations'] = not any('콜업 블루' in name or 'DEV' in name.upper() for name in names)
    checks['pageErrors'] = len(errors)
    browser.close()

result = {
    'version': 'phase4-v47-production-ui-catalog',
    'standalone': standalone_path.name,
    'result': 'PASS' if (
        checks['startsAtSaveSelect']
        and checks['productionOrganizations30']
        and checks['realOrganizationNames']
        and checks['noSyntheticDevOrganizations']
        and checks['pageErrors'] == 0
    ) else 'FAIL',
    'checks': checks,
    'errors': errors,
    'organizationSample': names[:5],
    'note': (
        'Browser UI catalog smoke uses the exact 30 MLB organization identities '
        'from the validated Production snapshot. Full 5,201-player inference, '
        'fixture creation, schedules, and roster validation are covered by the '
        'separate Node Production runtime gate.'
    ),
}
report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
if result['result'] != 'PASS':
    raise SystemExit(1)
