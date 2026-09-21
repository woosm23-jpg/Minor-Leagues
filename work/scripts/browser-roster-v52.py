import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html_path=root/"dist"/"THE_CALL_UP_SEASON_STANDALONE_v52_PRODUCTION.html"
html=html_path.read_text(encoding="utf-8")
legacy=(root/"scripts"/"browser-standalone-smoke-v39.py").read_text(encoding="utf-8")
match=re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html",legacy,re.S)
if not match: raise RuntimeError("fake IndexedDB harness not found")
smoke_html=html.replace("<body>\n","<body>\n"+match.group(1),1)

errors=[]
checks={}
with sync_playwright() as p:
  br=p.chromium.launch(headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
  page=br.new_page(viewport={"width":390,"height":844})
  page.on("pageerror",lambda exc: errors.append(str(exc)))
  page.on("dialog",lambda dialog: dialog.accept())
  page.set_content(smoke_html,wait_until="domcontentloaded",timeout=180000)
  page.wait_for_selector(".save-select-hero",timeout=60000)
  page.locator("[data-career-new]").click()
  page.wait_for_selector(".new-career-screen",timeout=60000)
  page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
  page.wait_for_function(
    "() => { const el=document.querySelector('[data-career-field=\"favoriteOrganizationId\"]'); return !!el && [...el.options].filter(o=>o.value).length===30; }",
    timeout=180000
  )
  org=page.locator('[data-career-field="favoriteOrganizationId"]')
  values=org.locator("option").evaluate_all("(els)=>els.map(e=>e.value).filter(Boolean)")
  org.select_option(values[0])
  page.locator('[data-career-field="name"]').fill("v52 로스터 QA")
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
  checks["contractTab"]="Contract / Service" in text
  checks["fortyMan"]="40-man" in text
  checks["options"]="Options" in text
  checks["notOn40Man"]="미등록" in text
  checks["pageErrors"]=len(errors)
  br.close()

passed=all(v is True for k,v in checks.items() if k!="pageErrors") and checks["pageErrors"]==0
report={"schema":"THE_CALL_UP_V52_ROSTER_BROWSER_SMOKE","pass":passed,"standalone":html_path.name,"viewport":{"width":390,"height":844},"checks":checks,"errors":errors}
(root/"reports"/"v52-roster-browser-smoke.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
if not passed: raise SystemExit(1)
