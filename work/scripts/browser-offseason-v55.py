import json,re
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html_path=root/"dist"/"THE_CALL_UP_SEASON_STANDALONE_v55_PRODUCTION.html"
html=html_path.read_text(encoding="utf-8")
legacy=(root/"scripts"/"browser-standalone-smoke-v39.py").read_text(encoding="utf-8")
match=re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html",legacy,re.S)
if not match: raise RuntimeError("fake IndexedDB harness not found")
smoke=html.replace("<body>\n","<body>\n"+match.group(1),1)

errors=[];console_errors=[];checks={}
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
  page.locator('[data-career-field="name"]').fill("v55 오프시즌 QA")
  page.locator('[data-career-field="age"]').select_option("21")
  page.locator('[data-career-field="primaryPosition"]').select_option("CF")
  page.locator('[data-career-field="archetype"]').select_option("BALANCED")
  page.locator("[data-career-create-submit]").click()
  page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",timeout=180000)
  checks["normalSeasonBoot"]=page.locator(".season-content").count()==1
  checks["offseasonUiBundled"]="Offseason Pipeline" in html and "START_OFFSEASON" in html and "OFFSEASON_NEXT" in html
  checks["gameVersion"]="full_career_offseason_pipeline_v55" in html
  checks["pageErrors"]=len(errors)
  checks["consoleErrors"]=len(console_errors)
  b.close()
passed=checks["normalSeasonBoot"] and checks["offseasonUiBundled"] and checks["gameVersion"] and checks["pageErrors"]==0 and checks["consoleErrors"]==0
report={"schema":"THE_CALL_UP_V55_OFFSEASON_BROWSER_SMOKE","pass":passed,"standalone":html_path.name,"viewport":{"width":390,"height":844},"checks":checks,"errors":errors,"consoleErrors":console_errors}
(root/"reports"/"v55-offseason-browser-smoke.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
if not passed: raise SystemExit(1)
