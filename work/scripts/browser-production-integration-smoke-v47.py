import json, re
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html_path=root/'dist'/'THE_CALL_UP_SEASON_STANDALONE_v47_BROWSER_SMOKE.html'
html=html_path.read_text()
legacy=(root/'scripts'/'browser-standalone-smoke-v39.py').read_text()
m=re.search(r"fake_idb = r'''(.*?)'''\n\nsmoke_html",legacy,re.S)
if not m: raise RuntimeError('fake IndexedDB harness not found')
smoke_html=html.replace('<body>\n','<body>\n'+m.group(1),1)
errors=[]; checks={}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(accept_downloads=True,viewport={'width':390,'height':844})
    page.on('pageerror',lambda exc: errors.append(str(exc)))
    page.on('dialog',lambda dialog: dialog.accept())
    page.set_content(smoke_html,wait_until='domcontentloaded',timeout=120000)
    page.wait_for_selector('.save-select-hero',timeout=30000)
    checks['startsAtSaveSelect']='THE CALL-UP' in page.locator('.save-select-hero').inner_text()
    page.locator('[data-career-new]').click()
    page.wait_for_selector('.new-career-screen',timeout=30000)
    page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
    sel=page.locator('[data-career-field="favoriteOrganizationId"]')
    names=[sel.locator('option').nth(i).inner_text() for i in range(sel.locator('option').count())]
    checks['productionOrganizations30']=len(names)==30
    checks['realOrganizationNames']=any('Arizona Diamondbacks' in x for x in names) and any('New York Yankees' in x for x in names)
    first=sel.locator('option').first.get_attribute('value'); sel.select_option(first)
    page.locator('[data-career-field="name"]').fill('Production Smoke')
    page.locator('[data-career-field="age"]').select_option('18')
    page.locator('[data-career-field="primaryPosition"]').select_option('SS')
    page.locator('[data-career-field="archetype"]').select_option('BALANCED')
    page.locator('[data-career-create-submit]').click()
    page.wait_for_selector('.season-title',timeout=120000)
    checks['careerCreated']=True
    page.locator('[data-season-tab="HOME"]').click()
    with page.expect_download(timeout=120000) as info:
        page.locator('[data-season-action="EXPORT"]').click()
    doc=json.loads(Path(info.value.path()).read_text())
    u=doc['career']['dataUniverse']; f=doc['career']['fixture']
    checks['gameVersionV47']=doc['metadata']['gameVersion']=='phase4_production_world_activation_v47'
    checks['productionUniverseStored']=u['origin']=='MASTER_SNAPSHOT' and u['independent'] is True and u['sourceSnapshot']['hash']=='fnv1a32:6eef1a9a'
    checks['productionFixtureStored']=f['worldMode']=='PRODUCTION_REAL' and f['scheduleSource']=='MASTER_SNAPSHOT' and f['organization']['userLevel']=='A'
    checks['fiveRealLevelsStored']=set(f['levelLeagues'].keys())=={'MLB','AAA','AA','HIGH_A','A'} and all(len(f['levelLeagues'][k]['teams'])==30 for k in f['levelLeagues'])
    checks['fullRealIdentityCoverageStored']=len(u['data']['teams'])==150 and len(u['data']['players'])==5201 and len(u['data']['parks'])==30
    checks['pageErrors']=len(errors)
    browser.close()
result={'version':'phase4-v47-production-integration','standalone':html_path.name,'result':'PASS' if all(v is True for k,v in checks.items() if k!='pageErrors') and checks['pageErrors']==0 else 'FAIL','checks':checks,'errors':errors,'organizationSample':names[:5], 'note':'Browser smoke derivative preserves all teams/players/affiliations/schedule/parks; only historical stats rows are reduced to representative coverage for harness size.'}
(root/'reports'/'phase4-production-v47-browser-smoke.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
if result['result']!='PASS': raise SystemExit(1)
