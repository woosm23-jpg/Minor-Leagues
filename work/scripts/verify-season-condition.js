import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import {
  createPositionPlayerSeasonState,
  applyPositionPlayerGame,
  recoverPositionPlayer,
  fatigueBand,
  formBand,
  getSeasonDevelopedPlayer,
  getSeasonEffectivePlayer,
  getPositionPlayerSeasonView
} from "../src/engine/season/playerSeasonState.js";
import {
  createHealthState,
  advanceHealthState,
  maybeApplyInjury,
  getHealthPublicView
} from "../src/engine/season/injuryState.js";

const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1e-condition-regression.json";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function loadSnapshot(path) {
  const bytes = fs.readFileSync(path);
  const text = path.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(text);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function strongLine() {
  return { PA: 5, H: 4, doubles: 1, triples: 0, HR: 1, BB: 1, HBP: 0, SO: 0 };
}

function weakLine() {
  return { PA: 4, H: 0, doubles: 0, triples: 0, HR: 0, BB: 0, HBP: 0, SO: 4 };
}

const verify = process.argv.includes("--verify");
const outputPath = arg("output", DEFAULT_OUTPUT);

const snapshot = loadSnapshot(SNAPSHOT_PATH);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30, "Production organization catalog must contain 30 organizations");

const organization = catalog.organizations[0];
const input = {
  name: "v50.1e Condition QA",
  nationality: "대한민국",
  hometown: "구미",
  age: 18,
  heightCm: 180,
  weightKg: 78,
  bodyType: "ATHLETIC",
  bats: "R",
  throws: "R",
  primaryPosition: "CF",
  archetype: "ATHLETIC",
  visibleTraits: ["QUICK_BAT", "BASE_STEALER"],
  organizationMode: "FAVORITE",
  favoriteOrganizationId: String(organization.id)
};

let season = seasonApi.createCareerSeason({
  seed: "v50-1e-condition-production",
  input,
  masterSnapshot: snapshot
});
assert.equal(season.currentLevel, "A", "age-18 Production career should begin at A");

const initialPayload = seasonApi.serializeSeason(season.seasonId);
const userId = String(initialPayload.fixture.userPlayerId);
const initialLevel = initialPayload.fixture.organization.userLevel;
const userPlayer = initialPayload.fixture.organization.levels[initialLevel].roster.players[userId];
assert.ok(userPlayer, "Production user player missing from organization roster");

// Direct fatigue/form engine regression.
let state = createPositionPlayerSeasonState(userPlayer, userPlayer.positioning ?? null);
assert.equal(state.fatigue, 0);
assert.equal(state.form, 0);
assert.equal(fatigueBand(0), "FRESH");
assert.equal(fatigueBand(21), "NORMAL");
assert.equal(fatigueBand(41), "TIRED");
assert.equal(fatigueBand(61), "FATIGUED");
assert.equal(fatigueBand(81), "EXHAUSTED");
assert.equal(formBand(0.35), "HOT");
assert.equal(formBand(0.12), "GOOD");
assert.equal(formBand(0), "NORMAL");
assert.equal(formBand(-0.12), "POOR");
assert.equal(formBand(-0.35), "COLD");

state = applyPositionPlayerGame(state, userPlayer, {
  battingLine: strongLine(),
  position: "CF",
  appearanceType: "START",
  date: "2026-04-01",
  level: "A"
});
const hotForm = state.form;
assert.ok(hotForm > 0, `strong game should create positive form, got ${hotForm}`);
assert.equal(state.fatigue, 17, "CF start workload drift");

for (let i = 0; i < 14; i += 1) {
  state = applyPositionPlayerGame(state, userPlayer, {
    battingLine: weakLine(),
    position: "CF",
    appearanceType: "START",
    date: addDays("2026-04-02", i),
    level: "A"
  });
}
assert.ok(state.form < 0, `sustained poor games should create negative form, got ${state.form}`);
assert.ok(state.form >= -1 && state.form <= 1, "form outside [-1,1]");
assert.ok(state.fatigue >= 0 && state.fatigue <= 100, "fatigue outside [0,100]");
assert.equal(state.recentForm.length, 14, "recent form window must be capped at 14 games");

const exhausted = { ...state, fatigue: 100, form: -1 };
const freshHot = { ...state, fatigue: 0, form: 1 };
const developed = getSeasonDevelopedPlayer(userPlayer, state);
const exhaustedEffective = getSeasonEffectivePlayer(userPlayer, exhausted);
const freshHotEffective = getSeasonEffectivePlayer(userPlayer, freshHot);

assert.ok(exhaustedEffective.hitting.contactR < developed.hitting.contactR, "exhaustion/cold form should reduce contact");
assert.ok(exhaustedEffective.running.speed < developed.running.speed, "exhaustion should reduce speed");
assert.ok(exhaustedEffective.fielding.reaction < developed.fielding.reaction, "exhaustion should reduce reaction");
assert.ok(freshHotEffective.hitting.contactR >= developed.hitting.contactR, "hot fresh form should not reduce contact");

const beforeRecovery = state.fatigue;
const recovered = recoverPositionPlayer(state, 2);
assert.equal(recovered.fatigue, Math.max(0, beforeRecovery - 28), "position-player fatigue recovery drift");

const publicCondition = getPositionPlayerSeasonView(state);
assert.ok(publicCondition.fatigue >= 0 && publicCondition.fatigue <= 100);
assert.ok(publicCondition.form >= -1 && publicCondition.form <= 1);
assert.ok(["FRESH","NORMAL","TIRED","FATIGUED","EXHAUSTED"].includes(publicCondition.fatigueBand));
assert.ok(["HOT","GOOD","NORMAL","POOR","COLD"].includes(publicCondition.formBand));

// Direct injury lifecycle regression.
const baseHealth = createHealthState(userPlayer, { kind: "POSITION" });
const lowRiskForced = maybeApplyInjury(baseHealth, userPlayer, {
  seed: "v50-1e-risk-low",
  date: "2026-04-01",
  fatigue: 0,
  age: 18,
  activity: "POSITION_START",
  kind: "POSITION",
  force: { family: "LOWER_BODY", severity: "MODERATE", days: 14 }
});
const highRiskForced = maybeApplyInjury(baseHealth, userPlayer, {
  seed: "v50-1e-risk-high",
  date: "2026-04-01",
  fatigue: 100,
  age: 18,
  activity: "POSITION_START",
  kind: "POSITION",
  force: { family: "LOWER_BODY", severity: "MODERATE", days: 14 }
});
assert.ok(highRiskForced.risk > lowRiskForced.risk, "fatigue must increase injury risk");
assert.ok(lowRiskForced.event, "forced injury must emit an event");
assert.equal(lowRiskForced.event.family, "LOWER_BODY");
assert.equal(lowRiskForced.event.severity, "MODERATE");
assert.equal(lowRiskForced.event.daysRemaining, 14);
assert.equal(lowRiskForced.event.expectedReturnDate, "2026-04-15");
assert.equal(lowRiskForced.health.history.total, 1);

const duplicateWhileActive = maybeApplyInjury(lowRiskForced.health, userPlayer, {
  seed: "v50-1e-active-duplicate",
  date: "2026-04-02",
  fatigue: 100,
  age: 18,
  activity: "POSITION_START",
  kind: "POSITION",
  force: { family: "UPPER_BODY", severity: "MAJOR", days: 60 }
});
assert.equal(duplicateWhileActive.event, null, "active injury must block duplicate injury application");
assert.equal(duplicateWhileActive.risk, 0);
assert.equal(duplicateWhileActive.health.history.total, 1);

const day13 = advanceHealthState(lowRiskForced.health, 13);
assert.equal(day13.activeInjury.daysRemaining, 1);
const day14 = advanceHealthState(lowRiskForced.health, 14);
assert.equal(day14.activeInjury, null, "injury must clear when daysRemaining reaches zero");
assert.equal(day14.history.total, 1, "injury history must survive recovery");

const publicHealth = getHealthPublicView(lowRiskForced.health);
assert.equal(publicHealth.availability, "INJURED");
assert.equal(publicHealth.injury.daysRemaining, 14);
assert.equal(publicHealth.history.total, 1);
assert.equal(Object.hasOwn(publicHealth, "age"), false, "public health must hide internal age");
assert.equal(Object.hasOwn(publicHealth.history, "byFamily"), false, "public health must hide internal family counters");
assert.equal(Object.hasOwn(publicHealth.injury, "activity"), false, "public health must hide internal activity field");

// Current Production integration regression: bounded current-game progression.
const observations = [];
let previousDate = season.currentDate;
for (let i = 0; i < 6; i += 1) {
  season = seasonApi.simulateCurrentGame(season.seasonId);
  assert.ok(season.currentDate >= previousDate, `Production date regressed: ${previousDate} -> ${season.currentDate}`);
  previousDate = season.currentDate;

  const status = season.userPlayer.status;
  assert.ok(Number.isFinite(status.fatigue) && status.fatigue >= 0 && status.fatigue <= 100, "public fatigue invalid");
  assert.ok(Number.isFinite(status.form) && status.form >= -1 && status.form <= 1, "public form invalid");
  assert.ok(["FRESH","NORMAL","TIRED","FATIGUED","EXHAUSTED"].includes(status.fatigueBand), "public fatigue band invalid");
  assert.ok(["HOT","GOOD","NORMAL","POOR","COLD"].includes(status.formBand), "public form band invalid");
  assert.equal(Object.hasOwn(status.health ?? {}, "age"), false, "Production public health leaked age");
  assert.equal(Object.hasOwn(status.health?.history ?? {}, "byFamily"), false, "Production public health leaked family counters");

  observations.push({
    step: i + 1,
    date: season.currentDate,
    level: season.currentLevel,
    G: season.userSeasonLine.G,
    fatigue: status.fatigue,
    fatigueBand: status.fatigueBand,
    form: status.form,
    formBand: status.formBand,
    availability: status.health?.availability ?? null
  });
}

const payload = seasonApi.serializeSeason(season.seasonId);
const restored = seasonApi.restoreSeason(structuredClone(payload));
const restoredPayload = seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(
  restoredPayload.playerStates[userId],
  payload.playerStates[userId],
  "user condition/health state changed across save restore"
);
assert.equal(restored.currentDate, season.currentDate, "current date changed across save restore");
assert.equal(restored.currentLevel, season.currentLevel, "current level changed across save restore");
assert.deepEqual(restored.userPlayer.status, season.userPlayer.status, "public condition view changed across save restore");

const report = {
  schema: "THE_CALL_UP_V50_1E_CONDITION_REGRESSION",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  engine: {
    hotFormAfterStrongGame: hotForm,
    finalFormAfterPoorRun: state.form,
    finalFatigueAfterPoorRun: state.fatigue,
    recoveredFatigueAfterTwoDays: recovered.fatigue,
    exhaustedEffective: {
      contactR: exhaustedEffective.hitting.contactR,
      speed: exhaustedEffective.running.speed,
      reaction: exhaustedEffective.fielding.reaction
    },
    developedBaseline: {
      contactR: developed.hitting.contactR,
      speed: developed.running.speed,
      reaction: developed.fielding.reaction
    }
  },
  injury: {
    lowFatigueRisk: lowRiskForced.risk,
    highFatigueRisk: highRiskForced.risk,
    family: lowRiskForced.event.family,
    severity: lowRiskForced.event.severity,
    days: lowRiskForced.event.daysRemaining,
    expectedReturnDate: lowRiskForced.event.expectedReturnDate,
    duplicateBlocked: duplicateWhileActive.event === null,
    clearedAfter14Days: day14.activeInjury === null,
    publicHiddenSafe: !Object.hasOwn(publicHealth, "age")
      && !Object.hasOwn(publicHealth.history, "byFamily")
      && !Object.hasOwn(publicHealth.injury, "activity")
  },
  production: {
    organizationId: String(organization.id),
    observations,
    restoreRoundTrip: true
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
