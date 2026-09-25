import json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html_path = root / 'dist' / 'THE_CALL_UP_COMPLETE_EDITION_RC.html'
assert html_path.is_file(), f'Missing candidate HTML: {html_path}'
errors = []
console_errors = []
checks = {}
widths = {}

class QuietFileHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root), **kwargs)
    def log_message(self, format, *args):
        return

def diagnostic(page, stage, cause):
    try:
        body = page.locator('body').inner_text(timeout=6000)[:1500]
    except Exception as exc:
        body = f'Body unavailable: {exc}'
    try:
        boot = page.locator('.boot-error').inner_text(timeout=6000) if page.locator('.boot-error').count() else None
    except Exception as exc:
        boot = f'Boot error unavailable: {exc}'
    try:
        ready = page.evaluate('document.readyState')
    except Exception as exc:
        ready = f'No readyState: {exc}'
    record = {'stage':stage, 'cause':str(cause), 'url':page.url, 'readyState':ready,
        'bootError':boot, 'bodyPreview':body, 'pageErrors':errors[-10:], 'consoleErrors':console_errors[-10:]}
    print('PHASE9_BROWSER_DIAGNOSTIC '+json.dumps(record,ensure_ascii=False),flush=True)

with ThreadingHTTPServer(('127.0.0.1',0), QuietFileHandler) as server:
    thread=Thread(target=server.serve_forever,daemon=True)
    thread.start()
    url=f'http://127.0.0.1:{server.server_port}/dist/THE_CALL_UP_COMPLETE_EDITION_RC.html'
    print('PHASE9_BROWSER_HTTP_ORIGIN '+url,flush=True)
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            page=browser.new_page(viewport={'width':390,'height':844},accept_downloads=True)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('console',lambda m:console_errors.append(m.text) if m.type=='error' else None)
            page.on('dialog',lambda d:d.accept())
            try:
                # Native HTTP loading avoids transferring a 100MB+ production snapshot
                # over the browser automation protocol via Page.setDocumentContent.
                # The browser uses its real IndexedDB, not a synthetic DB shim.
                page.goto(url,wait_until='domcontentloaded',timeout=240000)
                # Detect JavaScript compilation failures as soon as Chromium reports them.
                # Do not silently spin for two minutes on a blank initial screen.
                for _ in range(100):
                    if page.locator('.save-select-hero').count() or page.locator('.boot-error').count():
                        break
                    if errors:
                        raise RuntimeError('Browser bootstrap JavaScript error: '+repr(errors[-4:]))
                    page.wait_for_timeout(1000)
                else:
                    raise TimeoutError('Neither launcher nor boot-error appeared after 100 seconds')
                if page.locator('.boot-error').count():
                    raise RuntimeError('Standalone boot-error: '+page.locator('.boot-error').inner_text(timeout=10000)[:2400])
                page.wait_for_selector('.save-select-hero',state='visible',timeout=25000)
                checks['saveSelectLoads']=True
                checks['realIndexedDB']=page.evaluate("typeof indexedDB==='object' && typeof indexedDB.open==='function'")
                page.locator('[data-career-new]').click(timeout=30000)
                page.wait_for_selector('.new-career-screen',timeout=120000)
                page.locator('[data-career-org-mode][value="FAVORITE"]').check(force=True,timeout=30000)
                page.wait_for_function('''() => {const e=document.querySelector('[data-career-field="favoriteOrganizationId"]');return !!e&&[...e.options].filter(o=>o.value).length===30}''',timeout=180000)
                opts=page.locator('[data-career-field="favoriteOrganizationId"] option').evaluate_all('(els)=>els.map(e=>e.value).filter(Boolean)')
                page.locator('[data-career-field="favoriteOrganizationId"]').select_option(opts[0])
                page.locator('[data-career-field="name"]').fill('최종 후보 모바일 검사')
                page.locator('[data-career-create-submit]').click(timeout=30000)
                page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('시즌 홈')",timeout=240000)
                checks['productionCareerStarts']=True
                checks['homeActionsVisible']=page.locator('[data-season-action="SIM_DAY"]').count()>0
                for width in (320,390,430):
                    page.set_viewport_size({'width':width,'height':844})
                    page.wait_for_timeout(150)
                    sizes=page.evaluate('''() => ({screen:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth})''')
                    widths[str(width)]=sizes
                    checks[f'noHorizontalOverflow{width}']=sizes['scroll']<=width+2 and sizes['body']<=width+2
                page.locator('[data-season-tab="PLAYER"]').click()
                page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('선수')",timeout=30000)
                checks['playerTab']=True
                page.locator('[data-season-tab="LEAGUE"]').click()
                page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('리그')",timeout=30000)
                checks['leagueTab']=True
                page.locator('[data-season-tab="MORE"]').click()
                page.wait_for_function("() => document.querySelector('.season-title')?.textContent.includes('더보기')",timeout=30000)
                checks['moreTab']=True
                page.locator('[data-more-section="SETTINGS"]').click()
                page.wait_for_selector('[data-season-action="EXPORT"]',timeout=30000)
                checks['hasExportAction']=page.locator('[data-season-action="EXPORT"]').count()>0
                checks['pageErrors']=len(errors)
                checks['consoleErrors']=len(console_errors)
                passed=all(v is True for k,v in checks.items() if k not in ('pageErrors','consoleErrors')) and not errors and not console_errors
                report={'schema':'THE_CALL_UP_PHASE9_RC_MOBILE_BROWSER_V2','pass':passed,'widths':widths,'checks':checks,'errors':errors,'consoleErrors':console_errors,
                    'scope':'Chromium via local HTTP; real IndexedDB; production v3 HTML; mobile 320/390/430. Physical-phone speed not measured.'}
                (root/'reports'/'phase9-rc-mobile-browser.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
                print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
                if not passed:
                    raise AssertionError('Mobile smoke gate failed; see printed report')
            except Exception as exc:
                diagnostic(page,'candidate-open-and-mobile-flows',exc)
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()
