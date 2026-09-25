import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {seasonApi} from "../src/api/seasonApi.js";
import {validateSeasonSavePayload} from "../src/services/seasonSerialization.js";
import {renderSeason} from "../src/ui/seasonRender.js";

const master=JSON.parse(gunzipSync(readFileSync(
  "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
let view=seasonApi.createCareerSeason({seed:"phase5-spring-amateur-2026",
  input:{name:"Phase5 Spring QA",nationality:"대한민국",hometown:"구미",age:21,
    heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",
    primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],
    organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},masterSnapshot:master});
const id=view.seasonId;
view=seasonApi.simulateToSeasonEnd(id);
assert.equal(view.progress.worldLeagueGamesCompleted,10710);
assert.equal(view.amateur.draft,null,"2026 historical cohort cannot be duplicated");
view=seasonApi.startOffseason(id);
let loops=0;
while(view.offseason.currentPhase!=="SPRING_TRAINING") {
  view=seasonApi.advanceOffseasonPhase(id);
  if(++loops>12)throw new Error("spring phase not reached");
}
assert.equal(view.amateur.currentYear,2027);
assert.equal(view.amateur.draft.status,"UPCOMING");
assert.equal(view.amateur.international.status,"ACTIVE_SIGNINGS_COMPLETE");
assert.equal(view.springCamp.status,"PRE_CAMP_OUTLOOK");
assert.equal(view.springCamp.springGamesPlayed,0);
const pre=seasonApi.serializeSeason(id);
const userId=pre.fixture.userPlayerId;
const chosen=seasonApi.setSpringRolePreference(id,"AAA_EVERYDAY");
assert.equal(chosen.springCamp.preference,"AAA_EVERYDAY");
const selected=seasonApi.serializeSeason(id);
assert.deepEqual(selected.playerStates[userId].development,pre.playerStates[userId].development);
assert.deepEqual(selected.roleStates,pre.roleStates);
assert.deepEqual(selected.fixture,pre.fixture);
assert.deepEqual(selected.levelSeasons,pre.levelSeasons);
assert.equal(validateSeasonSavePayload(selected,{mode:"FULL"}),true);
const legacy=structuredClone(pre);
delete legacy.playerStates[userId].springRolePreference;
assert.equal(seasonApi.restoreSeason(legacy).springCamp.preference,"OPEN");
seasonApi.restoreSeason(structuredClone(selected));
const ui={innerHTML:"",querySelectorAll:()=>[],querySelector:()=>null};
renderSeason(ui,chosen,{},"HOME",{});
assert.match(ui.innerHTML,/data-spring-role-preference="AAA_EVERYDAY"/);
assert.match(ui.innerHTML,/스프링 예비평가/);
const processed=seasonApi.advanceOffseasonPhase(id);
assert.equal(processed.offseason.lastPhase,"SPRING_TRAINING");
assert.equal(processed.offseason.lastResult.outlook.preference,"AAA_EVERYDAY");
assert.equal(processed.offseason.lastResult.outlook.springStats,null);
assert.equal(processed.offseason.lastResult.outlook.rosterDecisionMade,false);
assert.equal(processed.userSeasonLine.G,chosen.userSeasonLine.G);
const after=seasonApi.serializeSeason(id);
assert.equal(validateSeasonSavePayload(after,{mode:"FULL"}),true);
seasonApi.restoreSeason(structuredClone(selected));
const replay=seasonApi.advanceOffseasonPhase(id);
assert.deepEqual(replay.offseason.lastResult,processed.offseason.lastResult);
assert.deepEqual(replay.springCamp,processed.springCamp);
const bad=seasonApi.serializeSeason(id);
bad.playerStates[userId].springRolePreference={mode:"GUARANTEED_MLB",requestedDate:"2027-02-20"};
assert.throws(()=>seasonApi.restoreSeason(bad),/스프링/);
const restored=seasonApi.restoreSeason(structuredClone(after));
assert.equal(restored.springCamp.preference,"AAA_EVERYDAY");
view=seasonApi.advanceToNextSeason(id);
assert.equal(view.seasonYear,2027);
assert.equal(view.status,"REGULAR_SEASON");
assert.equal(view.amateur.currentYear,2027);
assert.equal(view.amateur.draft.status,"UPCOMING");
const opening=seasonApi.serializeSeason(id);
assert.equal(validateSeasonSavePayload(opening,{mode:"FULL"}),true);
assert.deepEqual(opening.offseasonState.phaseResults.SPRING_TRAINING.outlook,
  processed.offseason.lastResult.outlook);
assert.equal(opening.playerStates[userId].springRolePreference.mode,"AAA_EVERYDAY");
const ids=new Set();
for(const league of Object.values(opening.fixture.levelLeagues))
  for(const roster of Object.values(league.rosters))
    for(const playerId of Object.keys(roster.players)) {
      assert.equal(ids.has(playerId),false,`duplicate player ${playerId}`); ids.add(playerId);
    }
for(const row of opening.amateurAcquisitionState.reserve)
  assert.equal(ids.has(String(row.player.id)),false,`reserve leaked ${row.player.id}`);
const report={schema:"THE_CALL_UP_PHASE5_SPRING_AMATEUR_BUNDLE_V1",pass:true,
  source:"Production v2 scenario; v3 whole-world audit separate",
  regularSeasonWorldGames2026:10710,
  springOutlookUsesRosterAndRole:true,
  springRolePreferenceAdvisory:true,
  noFabricatedSpringStats:true,
  noEarlyRosterDecision:true,
  springPhaseSaveRestoreReplay:true,
  savedPreferenceAndOldSaveCompatibility:true,
  invalidSaveRejected:true,
  draft2027Prepared:true,
  internationalReserveNoDuplicates:true,
  openingDay2027:true};
writeFileSync("reports/phase5-spring-amateur-bundle.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
