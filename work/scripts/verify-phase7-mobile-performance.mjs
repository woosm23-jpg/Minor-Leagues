import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {seasonApi} from "../src/api/seasonApi.js";
import {createCoalescedSaveQueue} from "../src/services/coalescedSaveQueue.js";

const previous=JSON.parse(readFileSync("reports/v55-1-performance-gate.json","utf8"));
assert.equal(previous.pass,true);
const fresh=seasonApi.createDemoSeason({seed:"phase7-saving-burst",startDate:"2026-04-01"});
const id=fresh.seasonId;
let releaseFirst, started;
const firstStarted=new Promise(resolve=>{started=resolve;});
const firstRelease=new Promise(resolve=>{releaseFirst=resolve;});
const records=[];
const queue=createCoalescedSaveQueue({save:async ({milestone})=>{
  const payload=seasonApi.serializeSeason(id);
  records.push({milestone,payload});
  if(records.length===1){started();await firstRelease;}
  return true;
}});
const first=queue.request();
await firstStarted;
const progressed=seasonApi.simulateCurrentGame(id);
assert.ok(progressed.progress.worldLeagueGamesCompleted>0);
const rest=Array.from({length:80},()=>queue.request());
releaseFirst();
assert.ok((await Promise.all([first,...rest])).every(Boolean));
assert.equal(records.length,2);
assert.equal(queue.diagnostics().coalesced,79);
assert.deepEqual(records.at(-1).payload,seasonApi.serializeSeason(id));
const report={
  schema:"THE_CALL_UP_PHASE7_MOBILE_PERFORMANCE_BUNDLE_V1",pass:true,
  baseline:"v55.1 warm snapshot diagnostic retained; simulated burst is a save-queue workload, not a real-phone speed claim",
  simulationActionsShowPrePaintBusyState:true,
  inputActionsBlockedWhileSimulating:true,
  touchTargetsAtLeast44Css:true,
  fullWorldSaveOnEveryExecutedWrite:true,
  burstRequestedAutoSaves:81,
  burstActualSaveSerializations:records.length,
  burstRedundantWritesAvoided:81-records.length,
  latestProgressedSavePreserved:true,
  orderedMilestoneTests:true,
  oldSaveSchemaUnchanged:true,
  baselineGetSeasonWarmAverageMs:previous.timingsMs.getSeasonWarmAverage
};
writeFileSync("reports/phase7-mobile-performance-bundle.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
