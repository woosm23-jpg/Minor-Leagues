import assert from "node:assert/strict";
import test from "node:test";
import {createCoalescedSaveQueue} from "../src/services/coalescedSaveQueue.js";
import {createSeasonSaveService} from "../src/services/seasonSaveService.js";
import {createSeasonBackupService} from "../src/services/seasonBackupService.js";
import {createSeasonTransferService,createTcuExportDocument} from "../src/services/seasonTransferService.js";
import {seasonApi} from "../src/api/seasonApi.js";
import {validateSeasonSavePayload} from "../src/services/seasonSerialization.js";

function store() {
  const records=new Map();
  return {records,async put(record){records.set(record.saveId,structuredClone(record));return record;},
    async get(id){return records.has(id)?structuredClone(records.get(id)):null;},
    async getMeta(id){const v=records.get(id);if(!v)return null;const {payload:_p,...meta}=v;return structuredClone(meta);},
    async list(){return [...records.values()].map(({payload:_p,...meta})=>structuredClone(meta));},
    async delete(id){return records.delete(id);}};
}
function backupStore() {
  const records=new Map();
  return {records,async put(record){records.set(record.backupId,structuredClone(record));return record;},
    async get(id){return records.has(id)?structuredClone(records.get(id)):null;},
    async listBySaveId(saveId){return [...records.values()].filter(r=>r.saveId===saveId)
      .map(({payload:_p,...meta})=>structuredClone(meta)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));},
    async delete(id){return records.delete(id);}};
}
function fresh(seed) {const view=seasonApi.createDemoSeason({seed,startDate:"2026-04-01"});return view.seasonId;}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test("queued autosaves never coalesce different careers; milestone keeps its own captured payload",async()=>{
  const started=deferred(),release=deferred(),written=[];
  const queue=createCoalescedSaveQueue({save:async({milestone,context})=>{
    written.push({milestone,context});
    if(written.length===1){started.resolve();await release.promise;}
    return true;
  }});
  const a=queue.request({context:{seasonId:"A",saveId:"save-A"}});await started.promise;
  const pending=[queue.request({context:{seasonId:"A",saveId:"save-A"}}),
    queue.request({context:{seasonId:"A",saveId:"save-A"}}),
    queue.request({context:{seasonId:"B",saveId:"save-B"}}),
    queue.request({milestone:"SEASON_END",context:{seasonId:"A",saveId:"save-A",payload:{seasonYear:2026}}}),
    queue.request({context:{seasonId:"A",saveId:"save-A"}})];
  release.resolve();assert.ok((await Promise.all([a,...pending])).every(Boolean));
  assert.deepEqual(written.map(x=>[x.milestone,x.context.saveId]),[[null,"save-A"],[null,"save-A"],[null,"save-B"],["SEASON_END","save-A"],[null,"save-A"]]);
  assert.deepEqual(written[3].context.payload,{seasonYear:2026});
  assert.equal(queue.diagnostics().coalesced,1);
});

test("captured milestone save and backup remain byte-for-byte unchanged after next game",async()=>{
  const id=fresh("phase8-milestone-captured");
  const save=store(),backups=backupStore();
  const service=createSeasonSaveService({repository:save,now:()=>"2026-10-02T00:00:00.000Z"});
  const backup=createSeasonBackupService({api:seasonApi,backupRepository:backups,saveRepository:save,now:()=>"2026-10-02T00:00:00.000Z"});
  const captured=seasonApi.serializeSeason(id);
  assert.equal(validateSeasonSavePayload(captured,{mode:"FULL"}),true);
  seasonApi.simulateCurrentGame(id);
  const current=seasonApi.serializeSeason(id);
  assert.notDeepEqual(current,captured);
  await service.saveSeasonPayload(captured,{saveId:"original"});
  const meta=await backup.createMilestoneBackupFromPayload(captured,{saveId:"original",milestone:"SEASON_END"});
  assert.deepEqual((await save.get("original")).payload,captured);
  assert.deepEqual((await backups.get(meta.backupId)).payload,captured);
  const recovered=await backup.restoreBackupAsCopy(meta.backupId);
  assert.ok(recovered.meta.saveId!=="original");
  assert.deepEqual((await save.get("original")).payload,captured);
  assert.deepEqual((await save.get(recovered.meta.saveId)).payload,captured);
  assert.equal(recovered.snapshot.seasonId,id);
});

test("corrupted .tcu import cannot change existing save; valid import creates separate copy",async()=>{
  const id=fresh("phase8-import-guard");const original=seasonApi.serializeSeason(id),save=store();
  const service=createSeasonSaveService({repository:save,now:()=>"2026-10-02T00:00:00Z"});
  await service.saveSeasonPayload(original,{saveId:"original"});
  const transfer=createSeasonTransferService({repository:save,now:()=>"2026-10-03T00:00:00Z"});
  const doc=createTcuExportDocument({payload:original,sourceSaveId:"original",exportedAt:"2026-10-03T00:00:00Z"});
  const corrupted=structuredClone(doc);corrupted.career.season.currentDate="2030-10-31";
  await assert.rejects(transfer.importSeasonText(JSON.stringify(corrupted)),/checksum/i);
  assert.equal(save.records.size,1);
  assert.deepEqual((await save.get("original")).payload,original);
  const meta=await transfer.importSeasonText(JSON.stringify(doc));
  assert.notEqual(meta.saveId,"original");
  assert.equal(save.records.size,2);
  assert.deepEqual((await save.get(meta.saveId)).payload,original);
});
