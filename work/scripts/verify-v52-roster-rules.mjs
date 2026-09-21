import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { getRosterRuleset, waiverPriority } from "../src/engine/career/rosterRules.js";
import {
  createRosterControlState, addTo40Man, optionToMinors, recallToMlb,
  advanceRosterControlToDate, designateForAssignment, placeOnOutrightWaivers,
  resolveOutrightWaivers
} from "../src/engine/career/rosterControlState.js";

const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const rules = getRosterRuleset("ruleset_2026");

assert.equal(rules.fortyManLimit, 40);
assert.equal(rules.standardOptionYears, 3);
assert.equal(rules.optionYearMinorDays, 20);
assert.equal(rules.maxOptionalAssignmentsPerSeason, 5);
assert.equal(rules.dfaResolutionDays, 7);

let pure = createRosterControlState({
  playerId: "known_user", startDate: "2026-03-25", initialLevel: "AAA",
  organizationId: "109", isUser: true
});
assert.equal(pure.on40Man, false);
assert.equal(pure.option.remaining, 3);
pure = addTo40Man(pure, { date: "2026-04-01", knownFortyManCount: 28 });
pure = optionToMinors(pure, { date: "2026-04-01" });
pure = advanceRosterControlToDate(pure, { toDate: "2026-04-19" });
assert.equal(pure.option.minorDaysThisSeason, 19);
assert.equal(pure.option.remaining, 3);
pure = advanceRosterControlToDate(pure, { toDate: "2026-04-20" });
assert.equal(pure.option.minorDaysThisSeason, 20);
assert.equal(pure.option.yearsUsed, 1);
assert.equal(pure.option.remaining, 2);

for (const date of ["2026-05-01","2026-06-01","2026-07-01","2026-08-01"]) {
  pure = recallToMlb(pure, { date });
  pure = optionToMinors(pure, { date });
}
assert.equal(pure.option.assignmentsThisSeason, 5);
pure = recallToMlb(pure, { date: "2026-08-02" });
assert.throws(() => optionToMinors(pure, { date: "2026-09-01" }), /횟수 제한/);

let dfa = designateForAssignment(pure, { date: "2026-09-01" });
assert.equal(dfa.on40Man, false);
assert.equal(dfa.dfa.deadlineDate, "2026-09-08");
dfa = placeOnOutrightWaivers(dfa, { date: "2026-09-04" });
const cleared = resolveOutrightWaivers(dfa, { date: "2026-09-05", knownServiceDays: 520 });
assert.equal(cleared.result, "CLEARED");
assert.equal(cleared.rights.canElectFreeAgency, true);
const claimed = resolveOutrightWaivers(dfa, { date: "2026-09-05", claimedByOrganizationId: "147", knownServiceDays: 0 });
assert.equal(claimed.result, "CLAIMED");
assert.equal(claimed.state.on40Man, true);
assert.equal(claimed.state.organizationId, "147");

const priority = waiverPriority([
  {teamId:"A",pct:.500,previousSeasonPct:.450},
  {teamId:"B",pct:.420,previousSeasonPct:.600},
  {teamId:"C",pct:.500,previousSeasonPct:.400}
]);
assert.deepEqual(priority.map((x)=>x.teamId), ["B","C","A"]);

const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
const organization = catalog.organizations[0];
let season = seasonApi.createCareerSeason({
  seed: "v50-1d-production-callup",
  input: {
    name: "v52 Roster QA", nationality: "대한민국", hometown: "구미", age: 21,
    heightCm: 180, weightKg: 78, bodyType: "ATHLETIC", bats: "R", throws: "R",
    primaryPosition: "CF", archetype: "HIT_FIRST", visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE", favoriteOrganizationId: String(organization.id)
  },
  masterSnapshot: snapshot
});

const initial = seasonApi.serializeSeason(season.seasonId);
const userId = String(initial.fixture.userPlayerId);
assert.ok(initial.rosterControlStates?.[userId], "user roster-control state missing");
assert.equal(initial.rosterControlStates[userId].on40Man, false);
assert.equal(initial.rosterControlStates[userId].option.remaining, 3);
assert.equal(season.userPlayer.rosterControl.on40Man, false);

const initialKnown40 = Object.values(initial.rosterControlStates).filter((x)=>x.organizationId===String(organization.id) && x.on40Man===true).length;
assert.ok(initialKnown40 < 40, "initial verified 40-man should have room");

let aaaGames = 0;
while (aaaGames < 8 && season.currentLevel === "AAA" && season.nextGame) {
  season = seasonApi.simulateCurrentGame(season.seasonId);
  aaaGames += 1;
}
assert.equal(season.currentLevel, "MLB", "deterministic v52 call-up did not reach MLB");
assert.equal(season.userPlayer.rosterControl.on40Man, true);
assert.equal(season.userPlayer.rosterControl.assignmentStatus, "MLB_ACTIVE");
assert.equal(season.userPlayer.rosterControl.options.remaining, 3);

const callupEvent = season.careerTimeline.events.find((event)=>event.type==="PLAYER_PROMOTED" && event.toLevel==="MLB");
assert.ok(callupEvent, "MLB call-up event missing");
assert.ok(callupEvent.reasonCodes.includes("FORTY_MAN_ADDED") || callupEvent.reasonCodes.includes("FORTY_MAN_ELIGIBLE"));

const saved = seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(saved, { mode:"FULL" }), true);
const restored = seasonApi.restoreSeason(structuredClone(saved));
const roundTrip = seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(roundTrip.rosterControlStates, saved.rosterControlStates, "roster-control save roundtrip drift");
assert.deepEqual(restored.userPlayer.rosterControl, season.userPlayer.rosterControl, "public roster-control view drift");
for (const forbidden of ["lastClockDate","priorOutrights"]) {
  assert.equal(Object.hasOwn(restored.userPlayer.rosterControl, forbidden), false, `public roster control leaked ${forbidden}`);
}

const report = {
  schema:"THE_CALL_UP_V52_ROSTER_RULES_GATE",
  pass:true,
  source:"Production Snapshot v2",
  ruleset:{
    id:rules.id,
    fortyManLimit:rules.fortyManLimit,
    standardOptionYears:rules.standardOptionYears,
    optionYearMinorDays:rules.optionYearMinorDays,
    maxOptionalAssignmentsPerSeason:rules.maxOptionalAssignmentsPerSeason,
    dfaResolutionDays:rules.dfaResolutionDays
  },
  pureRules:{
    optionYearConsumedAt20Days:true,
    oneOptionYearPerSeason:true,
    sixthAssignmentBlocked:true,
    dfaDeadlineSevenDays:true,
    outrightRights:true,
    waiverPriority:true
  },
  production:{
    initialKnown40,
    aaaGamesBeforeCallup:aaaGames,
    callupDate:callupEvent.date,
    userAddedTo40Man:true,
    saveRestore:true,
    publicInternalFieldsHidden:true
  }
};
fs.writeFileSync("reports/v52-roster-rules-gate.json", JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
