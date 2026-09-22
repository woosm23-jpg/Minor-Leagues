import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { seasonApi } from "../src/api/seasonApi.js";

const master=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
const org=catalog.organizations[0];

let season=seasonApi.createCareerSeason({
  seed:"v55-1-performance",
  input:{name:"v55.1 Performance QA",nationality:"대한민국",hometown:"구미",age:21,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},
  masterSnapshot:master
});

const firstDiag=seasonApi.getPerformanceDiagnostics(season.seasonId);
assert.equal(firstDiag.worldProspects.misses,1);
assert.equal(firstDiag.organization.misses,1);

const samples=[];
let refOrg=null, refWorld=null;
for(let i=0;i<5;i+=1){
  const t0=performance.now();
  const view=seasonApi.getSeason(season.seasonId);
  samples.push(performance.now()-t0);
  if(i===0){
    refOrg=JSON.stringify(view.organization);
    refWorld=JSON.stringify(view.worldProspectRankings);
  }else{
    assert.equal(JSON.stringify(view.organization),refOrg);
    assert.equal(JSON.stringify(view.worldProspectRankings),refWorld);
  }
}
const warm=seasonApi.getPerformanceDiagnostics(season.seasonId);
assert.ok(warm.worldProspects.hits>=5);
assert.ok(warm.organization.hits>=5);
assert.equal(warm.worldProspects.misses,1);
assert.equal(warm.organization.misses,1);

const before=seasonApi.getPerformanceDiagnostics(season.seasonId);
const a0=performance.now();
season=seasonApi.simulateCurrentGame(season.seasonId);
const actionMs=performance.now()-a0;
const after=seasonApi.getPerformanceDiagnostics(season.seasonId);
assert.ok(after.worldProspects.hits>before.worldProspects.hits);
assert.ok(after.organization.hits>before.organization.hits);

const missBeforeReview=after.worldProspects.misses;
season=seasonApi.runOrganizationReview(season.seasonId,{force:true});
const reviewed=seasonApi.getPerformanceDiagnostics(season.seasonId);
assert.ok(reviewed.worldProspects.misses>missBeforeReview);
assert.ok(reviewed.organization.misses>before.organization.misses);

const serialized=seasonApi.serializeSeason(season.seasonId);
assert.equal(serialized.performanceCache,undefined);
assert.equal(serialized.readModelCache,undefined);

const report={
  schema:"THE_CALL_UP_V55_1_PERFORMANCE_GATE",
  pass:true,
  cache:{
    warmWorldProspectHits:warm.worldProspects.hits,
    warmOrganizationHits:warm.organization.hits,
    reviewInvalidates:true,
    cacheNotSerialized:true
  },
  timingsMs:{
    getSeasonWarm:samples.map(v=>Number(v.toFixed(3))),
    getSeasonWarmAverage:Number((samples.reduce((a,b)=>a+b,0)/samples.length).toFixed(3)),
    simulateCurrentGame:Number(actionMs.toFixed(3))
  }
};
fs.writeFileSync("reports/v55-1-performance-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
