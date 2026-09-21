import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import {
  evaluateAaaMlbPromotion,
  evaluateMinorLevelPromotion,
  getOrganizationEvaluationPublicView
} from "../src/engine/season/promotionAI.js";
import { executeAdjacentLevelSwap } from "../src/services/organizationRosterService.js";

const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const PAIRS = Object.freeze([
  Object.freeze({ fromLevel: "A", toLevel: "HIGH_A", kind: "MINOR" }),
  Object.freeze({ fromLevel: "HIGH_A", toLevel: "AA", kind: "MINOR" }),
  Object.freeze({ fromLevel: "AA", toLevel: "AAA", kind: "MINOR" }),
  Object.freeze({ fromLevel: "AAA", toLevel: "MLB", kind: "MLB" })
]);
const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1b-promotion-gate.json";

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

function candidate(id, fromLevel) {
  return {
    id,
    fromLevel,
    position: "SS",
    depthScore: 90,
    seasonLine: { G: 12, PA: 60, OPS: 1.150 },
    roleState: { momentum: 0.15, role: "STARTER" },
    fatigue: 0,
    injured: false
  };
}

function incumbent(id) {
  return {
    id,
    position: "SS",
    depthScore: 25,
    seasonLine: { G: 12, PA: 60, OPS: 0.420 },
    roleState: { momentum: -0.15, role: "STARTER" },
    fatigue: 0,
    injured: false
  };
}

function assertPublicSafe(view, label) {
  assert.ok(view, `${label}: public evaluation missing`);
  for (const key of ["internal", "candidateScore", "incumbentScore", "aaaPerf", "mlbPerf", "lowerPerf", "upperPerf"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(view, key), false, `${label}: leaked ${key}`);
  }
}

function choosePosition(rosterA, rosterB) {
  const preferred = ["SS", "CF", "2B", "3B", "LF", "RF", "1B", "C", "DH"];
  for (const position of preferred) {
    const a = rosterA.lineupSlots?.find((row) => row.position === position)?.starterId ?? null;
    const b = rosterB.lineupSlots?.find((row) => row.position === position)?.starterId ?? null;
    if (a && b && a !== b && rosterA.players?.[a] && rosterB.players?.[b]) return { position, promotePlayerId: a, demotePlayerId: b };
  }
  throw new Error("Production adjacent pair에서 공통 포지션 starter를 찾지 못했습니다.");
}

function assertUniqueOrganizationPlayers(fixture, label) {
  const seen = new Map();
  for (const level of LEVELS) {
    const roster = fixture.organization.levels[level].roster;
    for (const id of Object.keys(roster.players ?? {})) {
      if (seen.has(id)) throw new Error(`${label}: duplicate player ${id} in ${seen.get(id)} and ${level}`);
      seen.set(id, level);
    }
  }
}

const verify = process.argv.includes("--verify");
const output = arg("output", DEFAULT_OUTPUT);
const snapshot = loadSnapshot(SNAPSHOT_PATH);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30);

const input = {
  name: "v50.1b Promotion QA",
  nationality: "대한민국",
  hometown: "구미",
  age: 18,
  heightCm: 180,
  weightKg: 78,
  bodyType: "ATHLETIC",
  bats: "R",
  throws: "R",
  primaryPosition: "SS",
  archetype: "HIT_FIRST",
  visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
  organizationMode: "FAVORITE",
  favoriteOrganizationId: String(catalog.organizations[0].id)
};

const season = seasonApi.createCareerSeason({ seed: "v50-1b-production-promotion", input, masterSnapshot: snapshot });
const payload = seasonApi.serializeSeason(season.seasonId);
assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL");
assert.deepEqual(payload.fixture.organization.levelOrder, LEVELS);

const evaluatorRows = [];
for (const pair of PAIRS) {
  const c = candidate(`candidate-${pair.fromLevel}`, pair.fromLevel);
  const i = incumbent(`incumbent-${pair.toLevel}`);
  const evaluation = pair.kind === "MLB"
    ? evaluateAaaMlbPromotion({ date: "2026-05-15", candidate: c, incumbent: i })
    : evaluateMinorLevelPromotion({ date: "2026-05-15", fromLevel: pair.fromLevel, toLevel: pair.toLevel, candidate: c, incumbent: i });

  assert.equal(evaluation.decision, "PROMOTE", `${pair.fromLevel}->${pair.toLevel}: promotion decision`);
  assert.equal(evaluation.incumbentDecision, "DEMOTE", `${pair.fromLevel}->${pair.toLevel}: demotion decision`);
  assert.equal(evaluation.sampleReady, true, `${pair.fromLevel}->${pair.toLevel}: candidate sample`);
  assert.equal(evaluation.cooldown, false, `${pair.fromLevel}->${pair.toLevel}: unexpected cooldown`);
  assert.equal(evaluation.injuryBlocked, false, `${pair.fromLevel}->${pair.toLevel}: unexpected injury block`);

  const candidateView = getOrganizationEvaluationPublicView(evaluation, { playerId: c.id });
  const incumbentView = getOrganizationEvaluationPublicView(evaluation, { playerId: i.id });
  assertPublicSafe(candidateView, `${pair.fromLevel}->${pair.toLevel} candidate`);
  assertPublicSafe(incumbentView, `${pair.fromLevel}->${pair.toLevel} incumbent`);
  assert.equal(candidateView.fromLevel, pair.fromLevel);
  assert.equal(candidateView.toLevel, pair.toLevel);
  assert.equal(candidateView.decision, "PROMOTE");
  assert.equal(incumbentView.decision, "DEMOTE");

  evaluatorRows.push({
    fromLevel: pair.fromLevel,
    toLevel: pair.toLevel,
    decision: evaluation.decision,
    incumbentDecision: evaluation.incumbentDecision,
    candidatePerspective: candidateView.perspective,
    incumbentPerspective: incumbentView.perspective
  });
}

const movementRows = [];
for (const pair of PAIRS) {
  const fixture = structuredClone(payload.fixture);
  const lower = fixture.organization.levels[pair.fromLevel].roster;
  const upper = fixture.organization.levels[pair.toLevel].roster;
  const selected = choosePosition(lower, upper);
  const beforeUserLevel = fixture.organization.userLevel;

  const moved = executeAdjacentLevelSwap({
    fixture,
    roleStates: {},
    fromLevel: pair.fromLevel,
    toLevel: pair.toLevel,
    promotePlayerId: selected.promotePlayerId,
    demotePlayerId: selected.demotePlayerId,
    position: selected.position,
    date: "2026-05-15",
    reasonCodes: ["V50_1B_GATE"]
  });

  assert.deepEqual(moved.fixture.organization.levelOrder, LEVELS);
  const nextLower = moved.fixture.organization.levels[pair.fromLevel].roster;
  const nextUpper = moved.fixture.organization.levels[pair.toLevel].roster;
  assert.ok(nextUpper.players[selected.promotePlayerId], `${pair.fromLevel}->${pair.toLevel}: promoted player missing upstairs`);
  assert.equal(Boolean(nextUpper.players[selected.demotePlayerId]), false, `${pair.fromLevel}->${pair.toLevel}: demoted player remained upstairs`);
  assert.ok(nextLower.players[selected.demotePlayerId], `${pair.fromLevel}->${pair.toLevel}: demoted player missing downstairs`);
  assert.equal(Boolean(nextLower.players[selected.promotePlayerId]), false, `${pair.fromLevel}->${pair.toLevel}: promoted player remained downstairs`);
  assert.deepEqual(moved.events.map((event) => event.type), ["PLAYER_PROMOTED", "PLAYER_DEMOTED"]);
  assert.equal(moved.events[0].fromLevel, pair.fromLevel);
  assert.equal(moved.events[0].toLevel, pair.toLevel);
  assert.equal(moved.events[1].fromLevel, pair.toLevel);
  assert.equal(moved.events[1].toLevel, pair.fromLevel);

  const lowerTeamId = String(moved.fixture.organization.levels[pair.fromLevel].team.id);
  const upperTeamId = String(moved.fixture.organization.levels[pair.toLevel].team.id);
  assert.deepEqual(moved.fixture.levelLeagues[pair.fromLevel].rosters[lowerTeamId], nextLower);
  assert.deepEqual(moved.fixture.levelLeagues[pair.toLevel].rosters[upperTeamId], nextUpper);

  if (pair.fromLevel === "AAA" || pair.toLevel === "AAA") {
    const aaaRoster = moved.fixture.organization.levels.AAA.roster;
    assert.deepEqual(moved.fixture.rosters[moved.fixture.userTeamId], aaaRoster, `${pair.fromLevel}->${pair.toLevel}: AAA canonical mirror drift`);
  }

  if (selected.promotePlayerId === fixture.userPlayerId) assert.equal(moved.fixture.organization.userLevel, pair.toLevel);
  else if (selected.demotePlayerId === fixture.userPlayerId) assert.equal(moved.fixture.organization.userLevel, pair.fromLevel);
  else assert.equal(moved.fixture.organization.userLevel, beforeUserLevel);

  assertUniqueOrganizationPlayers(moved.fixture, `${pair.fromLevel}->${pair.toLevel}`);
  movementRows.push({
    fromLevel: pair.fromLevel,
    toLevel: pair.toLevel,
    position: selected.position,
    promotePlayerId: selected.promotePlayerId,
    demotePlayerId: selected.demotePlayerId,
    events: moved.events.map((event) => event.type)
  });
}

const report = {
  schema: "THE_CALL_UP_V50_1B_PROMOTION_GATE",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  levelOrder: LEVELS,
  evaluatorRows,
  movementRows
};
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
