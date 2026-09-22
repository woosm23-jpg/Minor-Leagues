import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { POSTSEASON_RULESET_2026, POSTSEASON_ROUND_ORDER } from "../src/engine/career/postseasonHistory.js";

const master=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
const org=catalog.organizations[0];

let season=seasonApi.createCareerSeason({
  seed:"v56-postseason-history",
  input:{name:"v56 Postseason QA",nationality:"대한민국",hometown:"구미",age:21,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},
  masterSnapshot:master
});
season=seasonApi.simulateToSeasonEnd(season.seasonId);
assert.equal(season.status,"COMPLETE");
const endPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(endPayload,{mode:"FULL"}),true);
const regularMlbBefore=JSON.stringify(endPayload.levelSeasons.MLB);

season=seasonApi.startPostseason(season.seasonId);
assert.equal(season.status,"POSTSEASON");
assert.equal(season.postseason.currentRound,"WILD_CARD");
const fieldTeams=Object.values(season.postseason.field.leagues).flatMap((row)=>row.seeds);
assert.equal(fieldTeams.length,12);
assert.equal(new Set(fieldTeams.map((row)=>row.teamId)).size,12);
assert.ok(Object.values(seasonApi.serializeSeason(season.seasonId).postseasonState.rosters).every((ids)=>ids.length===POSTSEASON_RULESET_2026.rosterSize));

season=seasonApi.advancePostseasonRound(season.seasonId);
assert.equal(season.status,"POSTSEASON");
assert.equal(season.postseason.currentRound,"DIVISION_SERIES");
const midPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(midPayload,{mode:"FULL"}),true);
season=seasonApi.restoreSeason(structuredClone(midPayload));
assert.equal(season.status,"POSTSEASON");
assert.equal(season.postseason.currentRound,"DIVISION_SERIES");

let safety=0;
while(season.status==="POSTSEASON"){
  season=seasonApi.advancePostseasonRound(season.seasonId);
  safety+=1;
  if(safety>6) throw new Error("postseason safety exceeded");
}
assert.equal(season.status,"COMPLETE");
assert.equal(season.postseason.status,"COMPLETE");
assert.ok(season.postseason.championTeamId);
assert.ok(season.postseason.runnerUpTeamId);
assert.deepEqual(Object.keys(season.postseason.rounds),POSTSEASON_ROUND_ORDER);
assert.equal(season.postseason.rounds.WILD_CARD.length,4);
assert.equal(season.postseason.rounds.DIVISION_SERIES.length,4);
assert.equal(season.postseason.rounds.LCS.length,2);
assert.equal(season.postseason.rounds.WORLD_SERIES.length,1);
assert.equal(season.history.totalSeasons,1);

const afterPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(JSON.stringify(afterPayload.levelSeasons.MLB),regularMlbBefore);
assert.equal(validateSeasonSavePayload(afterPayload,{mode:"FULL"}),true);
const archive=afterPayload.historyState.seasons[0];
assert.equal(archive.seasonYear,2026);
assert.equal(archive.championTeamId,afterPayload.postseasonState.championTeamId);
assert.equal(archive.awards.methodology.goldGlove,"DEFERRED_FIELDING_EVENT_TOTALS_REQUIRED");
assert.equal(Object.keys(archive.awards.leagues).length,2);
for(const league of Object.values(archive.awards.leagues)){
  assert.ok(league.mvp?.playerId);
  assert.ok(league.cyYoung?.playerId);
  assert.ok(Array.isArray(league.silverSlugger));
}
assert.ok(archive.awards.worldSeriesMvp?.playerId);
assert.ok(["NONE","ORG_CHAMPION_NO_ROSTER","ROSTER_CHAMPION"].includes(archive.user.championshipStatus));
assert.ok(afterPayload.postseasonState.stats && afterPayload.postseasonState.stats.batting);

season=seasonApi.startOffseason(season.seasonId);
assert.equal(season.status,"OFFSEASON");
assert.equal(season.history.totalSeasons,1);

season=seasonApi.restoreSeason(structuredClone(endPayload));
const auto=seasonApi.advanceToNextSeason(season.seasonId);
assert.equal(auto.status,"REGULAR_SEASON");
assert.equal(auto.seasonYear,2027);
assert.equal(auto.history.totalSeasons,1);
const autoPayload=seasonApi.serializeSeason(auto.seasonId);
assert.equal(autoPayload.historyState.seasons[0].seasonYear,2026);
assert.equal(autoPayload.postseasonState,null);
assert.equal(validateSeasonSavePayload(autoPayload,{mode:"FULL"}),true);

const report={
  schema:"THE_CALL_UP_V56_POSTSEASON_AWARDS_HISTORY_GATE",
  pass:true,
  ruleset:{
    id:POSTSEASON_RULESET_2026.id,
    teamsPerLeague:POSTSEASON_RULESET_2026.teamsPerLeague,
    rosterSize:POSTSEASON_RULESET_2026.rosterSize,
    rounds:POSTSEASON_ROUND_ORDER
  },
  postseason:{
    fieldTeams:12,wildCardSeries:4,divisionSeries:4,lcsSeries:2,worldSeries:1,
    regularStatsFrozen:true,midPostseasonSaveRestore:true,championFinalized:true,postseasonStatsSeparate:true
  },
  awards:{
    mvp:true,cyYoung:true,silverSlugger:true,worldSeriesMvp:true,
    goldGloveDeferred:true,methodologyTransparent:true
  },
  history:{seasonArchive:true,championshipParticipationDistinguished:true,autoOffseasonCompatibility:true}
};
fs.writeFileSync("reports/v56-postseason-awards-history-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
