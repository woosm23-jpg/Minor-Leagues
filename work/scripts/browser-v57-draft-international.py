import json,re,time
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html_path=root/"dist"/"THE_CALL_UP_SEASON_STANDALONE_v57_PRODUCTION.html"
html=html_path.read_text(encoding="utf-8")
legacy=(root/"scripts"/"browser-standalone-smoke-v39.py").read_text(encoding="utf-8")
match=re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html",legacy,re.S)
if not match: raise RuntimeError("fake IndexedDB harness not found")
smoke=html.replace("<body>\n","<body>\n"+match.group(1),1)

errors=[];console_errors=[];checks={};timings={}
with sync_playwright() as p:
  b=p.chromium.launch(headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
  page=b.new_page(viewport={"width":390,"height":844})
  page.on("pageerror",lambda exc:errors.append(str(exc)))
  page.on("console",lambda msg:console_errors.append(msg.text) if msg.type=="error" else None)
  page.on("dialog",lambda d:d.accept())
  page.set_content(smoke,wait_until="domcontentloaded",timeout=180000)
  page.wait_for_selector(".save-select-hero",timeout=60000)
  page.locator("[data-career-new]").click()
  page.wait_for_selector(".new-career-screen",timeout=60000)
  page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
  page.wait_for_function("() => {const e=document.querySelector('[data-career-field=\"favoriteOrganizationId\"]');return !!e&&[...e.options].filter(o=>o.value).length===30}",timeout=180000)
  org=page.locator('[data-career-field="favoriteOrganizationId"]')
  vals=org.locator("option").evaluate_all("(els)=>els.map(e=>e.value).filter(Boolean)")
  org.select_option(vals[0])
  page.locator('[data-career-field="name"]').fill("v57 아마추어 QA")
  page.locator('[data-career-field="age"]').select_option("21")
  page.locator('[data-career-field="primaryPosition"]').select_option("CF")
  page.locator('[data-career-field="archetype"]').select_option("BALANCED")
  page.locator("[data-career-create-submit]").click()
  page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",timeout=180000)
  t=time.perf_counter(); page.locator('[data-season-tab="LEAGUE"]').click(); timings["homeToLeague"]=round((time.perf_counter()-t)*1000,3)
  page.wait_for_selector('[data-league-section="AMATEUR"]',timeout=30000)
  t=time.perf_counter(); page.locator('[data-league-section="AMATEUR"]').click(); timings["leagueToAmateur"]=round((time.perf_counter()-t)*1000,3)
  page.wait_for_selector("text=Snapshot protected",timeout=30000)
  checks["amateurTab"]=page.locator("text=아마추어 파이프라인").count()>0
  checks["snapshotProtectionUi"]=page.locator("text=Snapshot protected").count()>0
  checks["version"]="full_career_draft_international_v57" in html
  checks["pageErrors"]=len(errors)
  checks["consoleErrors"]=len(console_errors)
  checks["handlersUnder1000ms"]=all(v<1000 for v in timings.values())
  b.close()

passed=all([checks["amateurTab"],checks["snapshotProtectionUi"],checks["version"],checks["pageErrors"]==0,checks["consoleErrors"]==0,checks["handlersUnder1000ms"]])
report={"schema":"THE_CALL_UP_V57_BROWSER_SMOKE","pass":passed,"viewport":{"width":390,"height":844},"timingsMs":timings,"checks":checks,"errors":errors,"consoleErrors":console_errors}
(root/"reports"/"v57-browser-smoke.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
if not passed: raise SystemExit(1)
