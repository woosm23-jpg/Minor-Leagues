import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {seasonApi} from "../src/api/seasonApi.js";
import {validateSeasonSavePayload} from "../src/services/seasonSerialization.js";

const master=JSON.parse(gunzipSync(readFileSync(
  "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
let view=seasonApi.createCareerSeason({seed:"phase6-career-records-2026",
  input:{name:"Phase6 Record QA",nationality:"대한민국",hometown:"구미",age:21,
    heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",
    primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],
    organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},masterSnapshot:master});
const id=view.seasonId;
assert.equal(view.retirementHall.careerRecords.includedSeasons.length,0);
view=seasonApi.simulateToSeasonEnd(id);
assert.equal(view.progress.worldLeagueGamesCompleted,10710);
view=seasonApi.startOffseason(id);
const record=view.retirementHall.careerRecords;
assert.deepEqual(record.includedSeasons,[2026]);
assert.equal(record.scope,"SIMULATED_MLB_IN_THIS_SAVE_ONLY");
assert.ok(record.categories.H.totalEligible>100,"MLB hitters did not appear in ledger");
assert.ok(record.categories.SO.totalEligible>100,"MLB pitchers did not appear in ledger");
const saved=seasonApi.serializeSeason(id);
assert.equal(validateSeasonSavePayload(saved,{mode:"FULL"}),true);
const leader=record.categories.H.leaders[0];
assert.equal(leader.value,saved.retirementHallState.careerLedger[leader.playerId].totals.batting.H);
assert.equal(new Set(record.categories.H.leaders.map(row=>row.playerId)).size,record.categories.H.leaders.length);
assert.deepEqual(record.categories.H.leaders.map(row=>row.value),
  [...record.categories.H.leaders.map(row=>row.value)].sort((a,b)=>b-a));
const beforeSave=JSON.stringify(saved.retirementHallState);
assert.deepEqual(seasonApi.getSeason(id).retirementHall.careerRecords,record);
assert.equal(JSON.stringify(seasonApi.serializeSeason(id).retirementHallState),beforeSave);
view=seasonApi.restoreSeason(structuredClone(saved));
assert.deepEqual(view.retirementHall.careerRecords,record);
view=seasonApi.advanceToNextSeason(id);
assert.equal(view.seasonYear,2027);
assert.deepEqual(view.retirementHall.careerRecords,record,"2027 opening day duplicated 2026 records");
const after=seasonApi.serializeSeason(id);
assert.equal(validateSeasonSavePayload(after,{mode:"FULL"}),true);
assert.deepEqual(after.retirementHallState.recordedSeasons,[2026]);
const phase6=JSON.parse(readFileSync("reports/phase6-value-history-bundle.json","utf8"));
assert.equal(phase6.pass,true);
const v59=JSON.parse(readFileSync("reports/v59-long-run-stress-checkpoint.json","utf8"));
assert.equal(v59.pass,true);
assert.equal(v59.stress.completedSeasons,20);
const drift=v59.stress.statDriftFirst3VsLast3;
const report={schema:"THE_CALL_UP_PHASE6_CAREER_RECORDS_BUNDLE_V1",pass:true,
  source:"Production v2 historical-ledger scenario; production v3 season gate separately executed",
  worldGames2026:10710,recordScope:record.scope,recordedSeasons:record.includedSeasons,
  hitterPlayers:record.categories.H.totalEligible,pitcherPlayers:record.categories.SO.totalEligible,
  noPreSaveHistoricalStats:true,teamChangesNoDuplicate:true,saveUnchangedByReadModel:true,
  saveRestoreStable:true,openingDay2027NoDuplicate:true,
  historical20YearBaseline:{source:"v59 report generated before current Phase 6 changes; not a fresh 20-year test",
    seasons:v59.stress.completedSeasons,statDriftFirst3VsLast3:drift,
    meaningfulDriftRequiresFinalCalibration:Math.abs(drift.RA9)>1||Math.abs(drift.OBP)>.03}};
writeFileSync("reports/phase6-career-records-bundle.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
