import json, os, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
os.chdir(root)
server=ThreadingHTTPServer(('127.0.0.1',8765), SimpleHTTPRequestHandler)
thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
errors=[]; checks={}; names=[]
try:
  with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':390,'height':844})
    page.on('pageerror',lambda exc: errors.append(str(exc)))
    page.goto('http://127.0.0.1:8765/dist/THE_CALL_UP_SEASON_STANDALONE_v47_PRODUCTION.html',wait_until='domcontentloaded',timeout=120000)
    page.wait_for_selector('.save-select-hero',timeout=30000)
    checks['startsAtSaveSelect']='THE CALL-UP' in page.locator('.save-select-hero').inner_text()
    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen',timeout=30000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').check()
    page.wait_for_selector('[data-career-field="favoriteOrganizationId"]',timeout=30000)
    sel=page.locator('[data-career-field="favoriteOrganizationId"]'); opts=sel.locator('option')
    names=[opts.nth(i).inner_text() for i in range(opts.count())]
    checks['productionOrganizations30']=len(names)==30
    checks['realOrganizationNames']=any('Arizona Diamondbacks' in x for x in names) and any('New York Yankees' in x for x in names)
    checks['pageErrors']=len(errors)
    browser.close()
finally:
  server.shutdown(); server.server_close()
result={'version':'phase4-v47-production-http','result':'PASS' if all(v is True for k,v in checks.items() if k!='pageErrors') and checks.get('pageErrors')==0 else 'FAIL','checks':checks,'errors':errors,'organizationSample':names[:5]}
(root/'reports'/'phase4-production-v47-browser-smoke.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
if result['result']!='PASS': raise SystemExit(1)
