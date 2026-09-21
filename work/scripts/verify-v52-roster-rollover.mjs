import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";

const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
const org = catalog.organizations[0];
const created = seasonApi.createCareerSeason({
  seed:"v52-roster-rollover",
  input:{
    name:"v52 Rollover QA", nationality:"대한민국", hometown:"구미", age:18,
    heightCm:180, weightKg:78, bodyType:"ATHLETIC", bats:"R", throws:"R",
    primaryPosition:"SS", archetype:"HIT_FIRST", visibleTraits:["QUICK_BAT","SOFT_HANDS"],
    organizationMode:"FAVORITE", favoriteOrganizationId:String(org.id)
  },
  masterSnapshot:snapshot
});
const before=seasonApi.serializeSeason(created.seasonId);
const userId=String(before.fixture.userPlayerId);
assert.equal(before.rosterControlStates[userId].on40Man,false);

const completed=seasonApi.simulateToSeasonEnd(created.seasonId);
assert.equal(completed.status,"COMPLETE");
assert.equal(completed.progress.worldLeagueGamesCompleted,10710);
const next=seasonApi.advanceToNextSeason(created.seasonId);
assert.equal(next.seasonYear,2027);
assert.equal(next.startDate,"2027-03-25");

const after=seasonApi.serializeSeason(created.seasonId);
const mlbIds=Object.values(after.fixture.levelLeagues.MLB.rosters).flatMap((r)=>Object.keys(r.players??{}));
assert.equal(mlbIds.length,840);
assert.ok(mlbIds.every((id)=>after.rosterControlStates[id]?.on40Man===true),"all current MLB players must be known on 40-man");
assert.equal(after.rosterControlStates[userId].on40Man,false);
assert.equal(after.rosterControlStates[userId].option.assignmentsThisSeason,0);

for(const state of Object.values(after.rosterControlStates)){
  assert.ok(state.option.assignmentsThisSeason<=5);
  if(state.baseline==="KNOWN_ZERO"){
    assert.ok(state.option.remaining>=0 && state.option.remaining<=3);
  }
}
const restored=seasonApi.restoreSeason(structuredClone(after));
const round=seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(round.rosterControlStates,after.rosterControlStates);

const report={
  schema:"THE_CALL_UP_V52_ROSTER_ROLLOVER_GATE",
  pass:true,
  source:"Production Snapshot v2",
  completed2026:{worldGames:completed.progress.worldLeagueGamesCompleted},
  next2027:{startDate:next.startDate,mlbPlayers:mlbIds.length,allMlbOn40Man:true},
  user:{on40Man:after.rosterControlStates[userId].on40Man,assignmentsThisSeason:after.rosterControlStates[userId].option.assignmentsThisSeason},
  saveRoundTrip:true
};
fs.writeFileSync("reports/v52-roster-rollover-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
