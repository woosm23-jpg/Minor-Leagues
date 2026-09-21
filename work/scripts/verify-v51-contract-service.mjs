import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import {
  createContractState,
  addContractServiceDays,
  getContractPublicView
} from "../src/engine/career/contractState.js";
import { getContractRuleset } from "../src/engine/career/contractRules.js";

const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const OUTPUT = "reports/v51-contract-service-gate.json";
const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT_PATH)).toString("utf8"));
const rules = getContractRuleset("ruleset_2026");

assert.equal(rules.serviceYearDays, 172);
assert.equal(rules.regularSeasonCalendarDays, 187);
assert.equal(rules.arbitrationYears, 3);
assert.equal(rules.freeAgencyYears, 6);
assert.equal(rules.mlbMinimumSalary, 780000);
assert.equal(rules.superTwoMinimumPriorSeasonDays, 86);
assert.equal(rules.superTwoPercent, 0.22);

let threshold = createContractState({
  playerId: "threshold_user",
  startDate: "2026-03-25",
  initialLevel: "AAA",
  isUser: true
});
threshold = addContractServiceDays(threshold, 515, { seasonYear: 2026 });
assert.equal(getContractPublicView(threshold, { currentLevel: "MLB", currentDate: "2026-09-20" }).status, "PRE_ARBITRATION");
threshold = addContractServiceDays(threshold, 1, { seasonYear: 2026 });
assert.equal(getContractPublicView(threshold, { currentLevel: "MLB", currentDate: "2026-09-20" }).status, "ARBITRATION_ELIGIBLE");
threshold = addContractServiceDays(threshold, 516, { seasonYear: 2027 });
assert.equal(getContractPublicView(threshold, { currentLevel: "MLB", currentDate: "2027-09-20" }).status, "FREE_AGENCY_ELIGIBLE");

const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
const organization = catalog.organizations[0];
let season = seasonApi.createCareerSeason({
  seed: "v50-1d-production-callup",
  input: {
    name: "v51 Contract QA",
    nationality: "대한민국",
    hometown: "구미",
    age: 21,
    heightCm: 180,
    weightKg: 78,
    bodyType: "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition: "CF",
    archetype: "HIT_FIRST",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE",
    favoriteOrganizationId: String(organization.id)
  },
  masterSnapshot: snapshot
});

assert.equal(season.currentLevel, "AAA");
assert.equal(season.userPlayer.contract.status, "MINOR_LEAGUE_CONTROL");
assert.equal(season.userPlayer.contract.baseline, "KNOWN_ZERO");
assert.equal(season.userPlayer.contract.service.knownTotalDays, 0);
assert.equal(season.userPlayer.contract.service.simulatedDaysSinceSave, 0);

const initialPayload = seasonApi.serializeSeason(season.seasonId);
const userId = String(initialPayload.fixture.userPlayerId);
assert.ok(initialPayload.contractStates?.[userId], "user contract state missing");
assert.ok(Object.keys(initialPayload.contractStates).length >= 4000, "world contract-state coverage unexpectedly small");
assert.equal(validateSeasonSavePayload(initialPayload, { mode: "FULL" }), true);

const realMlbId = initialPayload.fixture.organization.levels.MLB.roster.positionPlayers
  .find((id) => String(id) !== userId);
assert.ok(realMlbId, "real MLB comparison player missing");
const realDetail = seasonApi.getPlayerDetail(season.seasonId, String(realMlbId));
assert.equal(realDetail.contract.baseline, "UNKNOWN_REAL_WORLD");
assert.equal(realDetail.contract.status, "UNKNOWN_REAL_BASELINE");
assert.equal(realDetail.contract.service.knownTotalDays, null);
assert.equal(realDetail.contract.terms.aav, null);

let aaaGames = 0;
while (aaaGames < 8 && season.currentLevel === "AAA" && season.nextGame) {
  season = seasonApi.simulateCurrentGame(season.seasonId);
  aaaGames += 1;
  if (season.currentLevel === "AAA") {
    assert.equal(season.userPlayer.contract.service.simulatedDaysSinceSave, 0, "minor-league time counted as MLB service");
  }
}
assert.equal(season.currentLevel, "MLB", "deterministic v51 call-up did not reach MLB");
assert.equal(season.userPlayer.contract.status, "PRE_ARBITRATION");
assert.ok(season.userPlayer.contract.service.simulatedDaysSinceSave >= 1, "call-up date did not begin MLB service");
assert.equal(season.userPlayer.contract.terms.kind, "MLB_CONTROL");
assert.equal(season.userPlayer.contract.terms.aav, 780000);

const serviceAtCallup = season.userPlayer.contract.service.simulatedDaysSinceSave;
season = seasonApi.simulateCurrentGame(season.seasonId);
assert.ok(season.userPlayer.contract.service.simulatedDaysSinceSave > serviceAtCallup, "MLB calendar service did not advance");
assert.equal(season.userPlayer.contract.service.thisSeasonDays, season.userPlayer.contract.service.simulatedDaysSinceSave);

const saved = seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(saved, { mode: "FULL" }), true);
const restored = seasonApi.restoreSeason(structuredClone(saved));
const restoredPayload = seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(restoredPayload.contractStates, saved.contractStates, "contract state changed across restore");
assert.deepEqual(restored.userPlayer.contract, season.userPlayer.contract, "public contract view changed across restore");

for (const forbidden of ["serviceClockDate", "lastCreditedDate", "historicalServiceDays"]) {
  assert.equal(Object.hasOwn(restored.userPlayer.contract, forbidden), false, `public contract leaked internal ${forbidden}`);
}

const callup = season.careerTimeline.events.find((event) => event.type === "PLAYER_PROMOTED" && event.toLevel === "MLB") ?? null;
const report = {
  schema: "THE_CALL_UP_V51_CONTRACT_SERVICE_GATE",
  pass: true,
  source: "Production Snapshot v2",
  ruleset: {
    id: rules.id,
    serviceYearDays: rules.serviceYearDays,
    regularSeasonCalendarDays: rules.regularSeasonCalendarDays,
    arbitrationYears: rules.arbitrationYears,
    freeAgencyYears: rules.freeAgencyYears,
    superTwoMinimumPriorSeasonDays: rules.superTwoMinimumPriorSeasonDays,
    superTwoPercent: rules.superTwoPercent,
    mlbMinimumSalary: rules.mlbMinimumSalary
  },
  coverage: {
    contractStates: Object.keys(saved.contractStates).length,
    realBaselineUnknownSafe: true,
    minorTimeExcluded: true,
    callupServiceBegins: true,
    saveRestore: true,
    publicInternalFieldsHidden: true
  },
  user: {
    aaaGamesBeforeCallup: aaaGames,
    callupDate: callup?.date ?? null,
    serviceAtCallup,
    serviceAfterMlbGame: season.userPlayer.contract.service.simulatedDaysSinceSave,
    publicStatus: season.userPlayer.contract.status,
    serviceDisplay: season.userPlayer.contract.service.display,
    aav: season.userPlayer.contract.terms.aav
  }
};

fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
