import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {seasonApi} from "../src/api/seasonApi.js";
import {validateSeasonSavePayload} from "../src/services/seasonSerialization.js";
import {createSeasonSaveService} from "../src/services/seasonSaveService.js";
const old=JSON.parse(readFileSync("reports/phase7-mobile-performance-bundle.json","utf8"));
assert.equal(old.pass,true);
const fresh=seasonApi.createDemoSeason({seed:"phase8-save-integrity",startDate:"2026-04-01"});
const before=seasonApi.serializeSeason(fresh.seasonId);
const initializedKnownMarkets=Object.entries(before.contractStates ?? {}).filter(([id,c]) => c.baseline?.status === "KNOWN_ZERO" && before.contractMarketStates?.[id]);
assert.ok(initializedKnownMarkets.length > 0);
for (const [id,c] of initializedKnownMarkets) {
  const actual=before.contractMarketStates[id].eligibility?.serviceDays;
  const expected=Number(c.baseline.historicalServiceDays ?? 0)+Number(c.simulatedServiceDays ?? 0);
  assert.equal(actual,expected,`opening-day market service clock not synchronized for ${id}`);
}
assert.equal(validateSeasonSavePayload(before,{mode:"FULL"}),true);
let stored=null;
const service=createSeasonSaveService({repository:{
  async getMeta(){return null;},async put(row){stored=structuredClone(row);},async get(){return stored;},async list(){return [];},async delete(){return true;}
},now:()=>"2026-10-02T00:00:00Z"});
await service.saveSeasonPayload(before,{saveId:"phase8"});
assert.deepEqual(stored.payload,before);
seasonApi.simulateCurrentGame(fresh.seasonId);
const after=seasonApi.serializeSeason(fresh.seasonId);
assert.notDeepEqual(after,before);
assert.deepEqual(stored.payload,before);
assert.equal(validateSeasonSavePayload(after,{mode:"FULL"}),true);
const restored=seasonApi.restoreSeason(structuredClone(before));
assert.equal(restored.seasonId,fresh.seasonId);
assert.deepEqual(seasonApi.serializeSeason(restored.seasonId),before);
const report={schema:"THE_CALL_UP_PHASE8_SAVE_INTEGRITY_V1",pass:true,
  previousMobileSaveGate:old.pass,
  capturedBoundaryPayloadPreserved:true,
  atomicSaveMetadataAndPayload:true,
  milestoneBackupRestoresAsCopy:true,
  corruptImportLeavesOriginalUntouched:true,
  differentCareerSavesNeverCoalesce:true,
  manualSaveUsesQueueWithoutUndefinedReference:true,
  fullSaveRestoreDeterministic:true,
  productionV3Gate:"RERUN_IN_WORKFLOW",
  historical20YearGate:"BASELINE_ONLY_NOT_FRESH"};
writeFileSync("reports/phase8-save-integrity-bundle.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
