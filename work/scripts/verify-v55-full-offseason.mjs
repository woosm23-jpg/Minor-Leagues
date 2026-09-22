import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { OFFSEASON_PHASES, createOffseasonState, completeOffseasonPhase } from "../src/engine/career/offseasonPipeline.js";

let pure=createOffseasonState({seasonYear:2026,startDate:"2026-09-30",userPlayerId:"u1",organizationId:"109",seasonReview:{level:"AAA"}});
const first=completeOffseasonPhase(pure,{phase:"SEASON_REVIEW",date:"2026-09-30",result:{ok:true}});
assert.equal(first.applied,true);
const duplicate=completeOffseasonPhase(first.state,{phase:"SEASON_REVIEW",date:"2026-09-30",result:{ok:false}});
assert.equal(duplicate.applied,false);
assert.equal(duplicate.state.processedPhases.length,1);
assert.throws(()=>completeOffseasonPhase(first.state,{phase:"EXTENSIONS",date:"2026-10-01"}));

const master=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
const org=catalog.organizations[0];
let season=seasonApi.createCareerSeason({
  seed:"v55-offseason-production",
  input:{name:"v55 Offseason QA",nationality:"대한민국",hometown:"구미",age:21,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},
  masterSnapshot:master
});
season=seasonApi.simulateToSeasonEnd(season.seasonId);
assert.equal(season.status,"COMPLETE");
assert.equal(season.progress.worldLeagueGamesCompleted,10710);
const seasonEndPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(seasonEndPayload,{mode:"FULL"}),true);

season=seasonApi.startOffseason(season.seasonId);
assert.equal(season.status,"OFFSEASON");
assert.equal(season.offseason.currentPhase,"SEASON_REVIEW");
for(let i=0;i<5;i+=1) season=seasonApi.advanceOffseasonPhase(season.seasonId);
assert.equal(season.offseason.completedCount,5);

const midPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(midPayload,{mode:"FULL"}),true);
const midPhase=season.offseason.currentPhase;
season=seasonApi.restoreSeason(structuredClone(midPayload));
assert.equal(season.status,"OFFSEASON");
assert.equal(season.offseason.currentPhase,midPhase);
assert.equal(season.offseason.completedCount,5);

let safety=0;
while(season.status==="OFFSEASON"){
  const before=season.offseason.completedCount;
  season=seasonApi.advanceOffseasonPhase(season.seasonId);
  if(season.status==="OFFSEASON") assert.equal(season.offseason.completedCount,before+1);
  safety+=1;
  if(safety>20) throw new Error("offseason phase safety exceeded");
}
assert.equal(season.status,"REGULAR_SEASON");
assert.equal(season.seasonYear,2027);
assert.equal(season.offseason.status,"COMPLETE");
assert.equal(season.offseason.completedCount,OFFSEASON_PHASES.length);
assert.equal(season.progress.worldLeagueGamesCompleted,0);
assert.equal(season.leagueEcology.lastOffseason.year,2027);

const manualPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(manualPayload,{mode:"FULL"}),true);
assert.equal(manualPayload.offseasonState.status,"COMPLETE");
assert.deepEqual(manualPayload.offseasonState.processedPhases,[...OFFSEASON_PHASES]);
assert.ok(manualPayload.offseasonState.phaseResults.SERVICE_CONTRACT_STATUS);
assert.ok(manualPayload.offseasonState.phaseResults.NON_TENDER_ARBITRATION);
assert.equal(manualPayload.offseasonState.phaseResults.OPENING_DAY.nextSeasonYear,2027);

season=seasonApi.restoreSeason(structuredClone(manualPayload));
const completeBefore=JSON.stringify(season.offseason);
season=seasonApi.advanceOffseasonPhase(season.seasonId);
assert.equal(JSON.stringify(season.offseason),completeBefore);

season=seasonApi.restoreSeason(structuredClone(seasonEndPayload));
const auto=seasonApi.advanceToNextSeason(season.seasonId);
assert.equal(auto.status,"REGULAR_SEASON");
assert.equal(auto.seasonYear,2027);
assert.equal(auto.offseason.status,"COMPLETE");
assert.deepEqual(auto.offseason.processedPhases,[...OFFSEASON_PHASES]);
assert.equal(auto.leagueEcology.lastOffseason.year,2027);
const autoPayload=seasonApi.serializeSeason(auto.seasonId);
assert.equal(validateSeasonSavePayload(autoPayload,{mode:"FULL"}),true);

const report={
  schema:"THE_CALL_UP_V55_FULL_OFFSEASON_GATE",
  pass:true,
  phases:OFFSEASON_PHASES,
  pure:{ordered:true,idempotentDuplicate:true,outOfOrderBlocked:true},
  production:{
    worldGames2026:10710,
    midOffseasonSaveRestore:true,
    manualPhaseProgression:true,
    autoAdvanceCompatibility:true,
    openingDay2027:true,
    ecologyYear:2027,
    saveRoundTrip:true
  }
};
fs.writeFileSync("reports/v55-full-offseason-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
