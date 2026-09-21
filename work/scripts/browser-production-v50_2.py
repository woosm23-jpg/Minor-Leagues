import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / "dist" / "THE_CALL_UP_SEASON_STANDALONE_v50_2_PRODUCTION.html"
report_path = root / "reports" / "v50-2c-production-browser-smoke.json"

html = html_path.read_text(encoding="utf-8")
legacy = (root / "scripts" / "browser-standalone-smoke-v39.py").read_text(encoding="utf-8")
match = re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html", legacy, re.S)
if not match:
    raise RuntimeError("fake IndexedDB harness not found")
smoke_html = html.replace("<body>\n", "<body>\n" + match.group(1), 1)

def make_page(browser):
    errors = []
    page = browser.new_page(viewport={"width": 390, "height": 844})
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.set_content(smoke_html, wait_until="domcontentloaded", timeout=180000)
    page.wait_for_selector(".save-select-hero", timeout=60000)
    return page, errors

def configure_new_career(page, *, age, name):
    assert "THE CALL-UP" in page.locator(".save-select-hero").inner_text()
    page.locator("[data-career-new]").click()
    page.wait_for_selector(".new-career-screen", timeout=60000)

    page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
    org_select = page.locator('[data-career-field="favoriteOrganizationId"]')
    org_select.wait_for(timeout=60000)
    values = org_select.locator("option").evaluate_all(
        "(els) => els.map(e => e.value).filter(Boolean)"
    )
    names = org_select.locator("option").evaluate_all(
        "(els) => els.map(e => e.textContent.trim()).filter(Boolean)"
    )
    if len(values) != 30:
        raise AssertionError(f"expected 30 Production organizations, got {len(values)}")
    if not any("Arizona Diamondbacks" in x for x in names):
        raise AssertionError("Arizona Diamondbacks missing from organization list")
    if not any("New York Yankees" in x for x in names):
        raise AssertionError("New York Yankees missing from organization list")

    org_select.select_option(values[0])
    page.locator('[data-career-field="name"]').fill(name)
    page.locator('[data-career-field="age"]').select_option(str(age))
    page.locator('[data-career-field="primaryPosition"]').select_option("CF")
    page.locator('[data-career-field="archetype"]').select_option("BALANCED")
    page.locator("[data-career-create-submit]").click()
    page.wait_for_selector(".season-title", timeout=180000)
    page.wait_for_function(
        "() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",
        timeout=180000,
    )
    return names

checks = {}
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )

    page1, errors1 = make_page(browser)
    org_names1 = configure_new_career(page1, age=20, name="v50.2 저장 QA")
    body1 = page1.locator("body").inner_text()
    checks["newCareerHome"] = True
    checks["organizations30"] = len(org_names1) == 30
    checks["realOrganizations"] = (
        any("Arizona Diamondbacks" in x for x in org_names1)
        and any("New York Yankees" in x for x in org_names1)
    )
    checks["noCareerCreationFailure"] = "새 커리어 생성 실패" not in body1
    checks["openingDayAutosave"] = "자동 저장됨" in body1
    errors.extend(errors1)
    page1.close()

    page2, errors2 = make_page(browser)
    configure_new_career(page2, age=21, name="v50.2 진행 QA")
    checks["sevenDaysButton"] = page2.locator('[data-season-action="SIM_7_DAYS"]').count() == 1
    checks["importantEventButton"] = page2.locator('[data-season-action="SIM_IMPORTANT"]').count() == 1

    page2.locator('[data-season-action="SIM_7_DAYS"]').click()
    page2.wait_for_selector(".progress-stop-card", timeout=180000)
    stop_text = page2.locator(".progress-stop-card").inner_text()
    body2 = page2.locator("body").inner_text()

    checks["stoppedOnImportantEvent"] = "중요 이벤트에서 정지" in stop_text
    checks["proDebutStop"] = "프로 데뷔" in stop_text
    checks["autosaveAfterProgress"] = "자동 저장됨" in body2
    errors.extend(errors2)
    page2.close()

    browser.close()

checks["pageErrors"] = len(errors)
passed = (
    all(v is True for k, v in checks.items() if k != "pageErrors")
    and checks["pageErrors"] == 0
)

result = {
    "schema": "THE_CALL_UP_V50_2C_PRODUCTION_BROWSER_SMOKE",
    "pass": passed,
    "standalone": html_path.name,
    "viewport": {"width": 390, "height": 844},
    "checks": checks,
    "errors": errors,
    "scenarios": [
        "Production age-20 new career reaches Season Home with autosave",
        "Production age-21 7-day progress stops on PRO_DEBUT important event"
    ]
}

report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False, indent=2))
if not passed:
    raise SystemExit(1)
