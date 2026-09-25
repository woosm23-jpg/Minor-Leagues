import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createCoalescedSaveQueue} from "../src/services/coalescedSaveQueue.js";
import {seasonApi} from "../src/api/seasonApi.js";
import {renderSeason} from "../src/ui/seasonRender.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("ordinary autosaves coalesce during an in-flight write without losing the latest write", async () => {
  const started = deferred(), release = deferred();
  const writes = [];
  const queue = createCoalescedSaveQueue({
    save: async ({milestone}) => {
      writes.push(milestone);
      if (writes.length === 1) { started.resolve(); await release.promise; }
      return true;
    }
  });
  const first = queue.request();
  await started.promise;
  const rest = Array.from({length: 99}, () => queue.request());
  assert.equal(queue.diagnostics().requested, 100);
  assert.equal(queue.diagnostics().coalesced, 98);
  release.resolve();
  assert.ok((await Promise.all([first, ...rest])).every(Boolean));
  assert.deepEqual(writes, [null, null]);
  assert.equal(queue.diagnostics().attemptedWrites, 2);
  assert.equal(queue.diagnostics().failed, 0);
});

test("season-end and opening-day milestone writes preserve FIFO boundaries", async () => {
  const started = deferred(), release = deferred(), writes = [];
  const queue = createCoalescedSaveQueue({save: async ({milestone}) => {
    writes.push(milestone ?? "AUTO");
    if (writes.length === 1) {started.resolve(); await release.promise;}
    return true;
  }});
  const first = queue.request();
  await started.promise;
  const rest = [queue.request(), queue.request(),
    queue.request({milestone:"SEASON_END"}),
    queue.request(), queue.request(),
    queue.request({milestone:"OPENING_DAY"}),
    queue.request()];
  release.resolve();
  assert.ok((await Promise.all([first, ...rest])).every(Boolean));
  assert.deepEqual(writes,["AUTO","AUTO","SEASON_END","AUTO","OPENING_DAY","AUTO"]);
  assert.equal(queue.diagnostics().coalesced,2);
});

test("failed write resolves false and later save can still succeed",async()=>{
  let attempts=0;
  const queue=createCoalescedSaveQueue({save: async()=>{
    attempts++;
    if(attempts===1)throw new Error("quota");
    return true;
  }});
  assert.equal(await queue.request(),false);
  assert.equal(await queue.request({milestone:"OPENING_DAY"}),true);
  assert.equal(queue.diagnostics().failed,1);
  assert.equal(queue.diagnostics().attemptedWrites,2);
  assert.throws(()=>queue.request({milestone:""}),/milestone/);
});

test("mobile simulation progress surface is accessible and ordinary gameplay remains unchanged",()=>{
  const snapshot=seasonApi.createDemoSeason({seed:"phase7-progress-ui",startDate:"2026-04-01"});
  const root={innerHTML:"",querySelectorAll:()=>[],querySelector:()=>null};
  renderSeason(root,snapshot,{},"HOME",{simBusy:true});
  assert.match(root.innerHTML,/aria-busy="true"/);
  assert.match(root.innerHTML,/class="sim-progress-overlay"/);
  assert.match(root.innerHTML,/role="status"/);
  assert.match(root.innerHTML,/경기 진행 및 저장 중/);
  renderSeason(root,snapshot,{},"HOME",{simBusy:false});
  assert.doesNotMatch(root.innerHTML,/sim-progress-overlay/);
  assert.match(root.innerHTML,/data-season-action="PLAY"/);
  const css=readFileSync("styles/app.css","utf8");
  assert.match(css,/\.sim-progress-overlay\s*\{/);
  assert.match(css,/touch-action:\s*manipulation/);
  assert.match(css,/@media\s*\(max-width:\s*430px\)/);
});
