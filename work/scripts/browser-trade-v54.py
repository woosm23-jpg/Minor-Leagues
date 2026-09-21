import json,re
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

root=Path(__file__).resolve().parents[1]
html_path=root/"dist"/"THE_CALL_UP_SEASON_STANDALONE_v54_PRODUCTION.html"
html=html_path.read_text(encoding="utf-8")
legacy=(root/"scripts"/"browser-standalone-smoke-v39.py").read_text(encoding="utf-8")
match=re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html",legacy,re.S)
if not match: raise RuntimeError("fake IndexedDB harness not found")
smoke_html=html.replace("<body>\n","<body>\n"+match.group(1),1)
if smoke_html==html: raise RuntimeError("fake IndexedDB harness injection failed")

errors=[]; console_errors=[]; checks={}
def write_failure(page, reason):
    try:
        boot=page.locator(".boot-error").inner_text(timeout=1000) if page.locator(".boot-error").count() else ""
    except Exception:
        boot=""
    try:
        body=page.locator("body").inner_text(timeout=1000)[:4000]
    except Exception:
        body=""
    report={"schema":"THE_CALL_UP_V54_TRADE_BROWSER_SMOKE","pass":False,"standalone":html_path.name,
            "viewport":{"width":390,"height":844},"reason":reason,"checks":checks,
            "errors":errors,"consoleErrors":console_errors,"bootError":boot,"bodyPreview":body}
    (root/"reports"/"v54-trade-browser-smoke.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return report

with sync_playwright() as p:
    b=p.chromium.launch(headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
    page=b.new_page(viewport={"width":390,"height":844})
    page.on("pageerror",lambda exc: errors.append(str(exc)))
    page.on("console",lambda msg: console_errors.append(msg.text) if msg.type=="error" else None)
    page.on("dialog",lambda d:d.accept())
    page.set_content(smoke_html,wait_until="domcontentloaded",timeout=180000)
    try:
        page.wait_for_selector(".save-select-hero",timeout=20000)
    except PlaywrightTimeoutError:
        write_failure(page,"BOOT_TIMEOUT")
        b.close()
        raise SystemExit(1)
    page.locator("[data-career-new]").click()
    page.wait_for_selector(".new-career-screen",timeout=60000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
    page.wait_for_function("() => {const e=document.querySelector('[data-career-field=\"favoriteOrganizationId\"]');return !!e&&[...e.options].filter(o=>o.value).length===30}",timeout=180000)
    org=page.locator('[data-career-field="favoriteOrganizationId"]')
    vals=org.locator("option").evaluate_all("(els)=>els.map(e=>e.value).filter(Boolean)")
    org.select_option(vals[0])
    page.locator('[data-career-field="name"]').fill("v54 트레이드 QA")
    page.locator('[data-career-field="age"]').select_option("21")
    page.locator('[data-career-field="primaryPosition"]').select_option("CF")
    page.locator('[data-career-field="archetype"]').select_option("BALANCED")
    page.locator("[data-career-create-submit]").click()
    page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",timeout=180000)
    page.locator('[data-season-tab="PLAYER"]').click()
    page.wait_for_selector('[data-player-section="CONTRACT"]',timeout=60000)
    page.locator('[data-player-section="CONTRACT"]').click()
    page.wait_for_selector(".player-contract-card",timeout=60000)
    text=page.locator(".player-contract-card").inner_text()
    checks["tradeMarket"]="Trade Market" in text
    checks["rumor"]="활성 루머 없음" in text
    checks["agent"]="Agent Request" in text
    checks["notGm"]="사용자는 GM이 아닙니다" in text
    checks["pageErrors"]=len(errors)
    checks["consoleErrors"]=len(console_errors)
    b.close()

passed=all(v is True for k,v in checks.items() if k not in ("pageErrors","consoleErrors")) and checks["pageErrors"]==0 and checks["consoleErrors"]==0
report={"schema":"THE_CALL_UP_V54_TRADE_BROWSER_SMOKE","pass":passed,"standalone":html_path.name,
        "viewport":{"width":390,"height":844},"checks":checks,"errors":errors,"consoleErrors":console_errors}
(root/"reports"/"v54-trade-browser-smoke.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
if not passed: raise SystemExit(1)
