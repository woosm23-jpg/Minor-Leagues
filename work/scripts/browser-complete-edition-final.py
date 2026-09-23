import json,time
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
html_path=root/'dist'/'THE_CALL_UP_COMPLETE_EDITION.html'
html=html_path.read_text(encoding='utf-8')

legacy=(root/'scripts'/'browser-standalone-smoke-v39.py').read_text(encoding='utf-8')
start_marker="fake_idb = r'''"
start=legacy.index(start_marker)+len(start_marker)
end=legacy.index("'''\n\nsmoke_html", start)
fake_idb=legacy[start:end]
smoke=html.replace('<body>\n','<body>\n'+fake_idb,1)

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(390,844),(412,915)]:
        errors=[]
        console_errors=[]
        timings={}
        checks={}
        page=browser.new_page(viewport={'width':width,'height':height})
        page.on('pageerror',lambda exc,arr=errors:arr.append(str(exc)))
        page.on('console',lambda msg,arr=console_errors:arr.append(msg.text) if msg.type=='error' else None)
        page.on('dialog',lambda d:d.accept())

        page.set_content(smoke,wait_until='domcontentloaded',timeout=180000)
        page.wait_for_selector('.save-select-hero',timeout=60000)
        page.locator('[data-career-new]').click()
        page.wait_for_selector('.new-career-screen',timeout=60000)
        page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True)
        page.wait_for_function(
            "() => {const e=document.querySelector('[data-career-field=\"favoriteOrganizationId\"]');"
            "return !!e&&[...e.options].filter(o=>o.value).length===30}",
            timeout=180000
        )
        org=page.locator('[data-career-field="favoriteOrganizationId"]')
        vals=org.locator('option').evaluate_all('(els)=>els.map(e=>e.value).filter(Boolean)')
        org.select_option(vals[0])
        page.locator('[data-career-field="name"]').fill('Complete Edition QA')
        page.locator('[data-career-field="age"]').select_option('18')
        page.locator('[data-career-field="primaryPosition"]').select_option('SS')
        page.locator('[data-career-field="archetype"]').select_option('BALANCED')
        page.locator('[data-career-create-submit]').click()
        page.wait_for_function(
            "() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",
            timeout=180000
        )

        nav_heights=page.locator('[data-season-tab]').evaluate_all(
            '(els)=>els.map(e=>e.getBoundingClientRect().height)'
        )
        checks['touchTargets44']=len(nav_heights)>=4 and min(nav_heights)>=44

        t=time.perf_counter()
        page.locator('[data-season-tab="PLAYER"]').click()
        timings['homeToPlayer']=round((time.perf_counter()-t)*1000,3)
        page.wait_for_function(
            "() => document.querySelector('.season-title')?.textContent.includes('선수')",
            timeout=30000
        )

        t=time.perf_counter()
        page.locator('[data-season-tab="LEAGUE"]').click()
        timings['playerToLeague']=round((time.perf_counter()-t)*1000,3)
        page.wait_for_function(
            "() => document.querySelector('.season-title')?.textContent.includes('리그')",
            timeout=30000
        )

        t=time.perf_counter()
        page.locator('[data-season-tab="MORE"]').click()
        timings['leagueToMore']=round((time.perf_counter()-t)*1000,3)
        page.wait_for_selector('[data-more-section="HISTORY"]',timeout=30000)
        page.locator('[data-more-section="HISTORY"]').click()
        page.wait_for_selector('text=Hall of Fame',timeout=30000)

        checks['hofUi']=page.locator('text=Hall of Fame').count()>0
        checks['retirementUi']=page.locator('text=마지막 시즌 선언').count()>0
        checks['noHorizontalOverflow']=page.evaluate(
            '() => document.documentElement.scrollWidth <= window.innerWidth + 2'
        )
        checks['pageErrors']=len(errors)
        checks['consoleErrors']=len(console_errors)
        checks['handlersUnder1000ms']=all(v<1000 for v in timings.values())
        checks['version']='complete_edition_v1_0' in html
        checks['title']='THE CALL-UP — Complete Edition' in html

        passed=(
            checks['touchTargets44']
            and checks['hofUi']
            and checks['retirementUi']
            and checks['noHorizontalOverflow']
            and checks['pageErrors']==0
            and checks['consoleErrors']==0
            and checks['handlersUnder1000ms']
            and checks['version']
            and checks['title']
        )
        results.append({
            'viewport':{'width':width,'height':height},
            'pass':passed,
            'timingsMs':timings,
            'checks':checks,
            'errors':errors,
            'consoleErrors':console_errors
        })
        page.close()
    browser.close()

passed=all(x['pass'] for x in results)
report={
    'schema':'THE_CALL_UP_COMPLETE_EDITION_FINAL_BROWSER',
    'pass':passed,
    'results':results
}
(root/'reports'/'complete-edition-final-browser.json').write_text(
    json.dumps(report,ensure_ascii=False,indent=2)+'\n',
    encoding='utf-8'
)
print(json.dumps(report,ensure_ascii=False,indent=2))
if not passed:
    raise SystemExit(1)
