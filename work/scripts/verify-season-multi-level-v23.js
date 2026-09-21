import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { organizationCalibration } from "../src/config/organizationCalibration.js";

const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const EXPECTED_MINOR_PAIRS = Object.freeze([
  Object.freeze({ fromLevel: "A", toLevel: "HIGH_A" }),
  Object.freeze({ fromLevel: "HIGH_A", toLevel: "AA" }),
  Object.freeze({ fromLevel: "AA", toLevel: "AAA" })
]);
const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1c-full-ladder-gate.json";

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

function assertLevelSet(object, label) {
  const present = Object.keys(object ?? {}).filter((level) => LEVELS.includes(level));
  assert.deepEqual(present.sort(), [...LEVELS].sort(), `${label}: five-level set mismatch`);
}

function assertScheduleLegality(league, level) {
  assert.equal(league.level, level, `${level}: league level mismatch`);
  assert.equal(league.teams.length, 30, `${level}: Production league must have 30 teams`);
  const teamIds = league.teams.map((team) => String(team.id));
  const teamSet = new Set(teamIds);
  assert.equal(teamSet.size, 30, `${level}: duplicate team id`);
  assert.equal(Object.keys(league.rosters ?? {}).length, 30, `${level}: roster map must contain 30 teams`);
  assert.ok(Array.isArray(league.schedule) && league.schedule.length > 0, `${level}: schedule missing`);

  const appearances = Object.fromEntries(teamIds.map((id) => [id, 0]));
  for (const game of league.schedule) {
    const away = String(game.awayTeamId);
    const home = String(game.homeTeamId);
    assert.notEqual(away, home, `${level}/${game.gameId}: same-team game`);
    assert.ok(teamSet.has(away), `${level}/${game.gameId}: unknown away team ${away}`);
    assert.ok(teamSet.has(home), `${level}/${game.gameId}: unknown home team ${home}`);
    assert.equal(game.status, "SCHEDULED", `${level}/${game.gameId}: new Production career must reset results`);
    appearances[away] += 1;
    appearances[home] += 1;
  }
  for (const teamId of teamIds) {
    assert.ok(appearances[teamId] >= 100, `${level}/${teamId}: schedule coverage below 100 games`);
  }
  return { teams: teamIds.length, scheduleGames: league.schedule.length };
}

function assertOrganizationMirror(fixture, level) {
  const league = fixture.levelLeagues[level];
  const affiliate = fixture.organization.levels[level];
  assert.ok(affiliate?.team?.id !== null && affiliate?.team?.id !== undefined, `${level}: affiliate team missing`);
  const teamId = String(affiliate.team.id);
  assert.equal(String(league.userTeamId), teamId, `${level}: affiliate/userTeamId mismatch`);
  assert.ok(league.rosters?.[teamId], `${level}: affiliate roster missing from league`);
  assert.deepEqual(affiliate.roster, league.rosters[teamId], `${level}: organization/league roster drift`);
  assert.ok(Object.keys(affiliate.roster.players ?? {}).length > 0, `${level}: affiliate roster empty`);
  return {
    teamId,
    teamName: affiliate.team.name,
    players: Object.keys(affiliate.roster.players ?? {}).length
  };
}

function assertNoOrganizationDuplicates(fixture) {
  const seen = new Map();
  for (const level of LEVELS) {
    for (const id of Object.keys(fixture.organization.levels[level].roster.players ?? {})) {
      assert.equal(seen.has(id), false, `duplicate organization player ${id}: ${seen.get(id)} and ${level}`);
      seen.set(id, level);
    }
  }
  return seen.size;
}

const verify = process.argv.includes("--verify");
const quiet = process.argv.includes("--quiet");
const seedCount = Number(arg("seeds", "1"));
const seedStart = Number(arg("start", "1"));
const outputPath = arg("output", DEFAULT_OUTPUT);

assert.ok(Number.isInteger(seedCount) && seedCount >= 1 && seedCount <= 6, "seeds must be an integer from 1 to 6");
assert.ok(Number.isInteger(seedStart) && seedStart >= 1, "start must be a positive integer");

const minorPairs = organizationCalibration.ladder?.adjacentPairs ?? [];
assert.deepEqual(
  minorPairs.map(({ fromLevel, toLevel }) => ({ fromLevel, toLevel })),
  EXPECTED_MINOR_PAIRS,
  "minor-ladder adjacency configuration drift"
);
const legalPairs = [...EXPECTED_MINOR_PAIRS, { fromLevel: "AAA", toLevel: "MLB" }];
for (const pair of legalPairs) {
  assert.equal(
    LEVELS.indexOf(pair.toLevel),
    LEVELS.indexOf(pair.fromLevel) - 1,
    `${pair.fromLevel}->${pair.toLevel}: non-adjacent ladder pair`
  );
}

const snapshot = loadSnapshot(SNAPSHOT_PATH);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30, "Production organization catalog must contain 30 MLB organizations");

const rows = [];
for (let offset = 0; offset < seedCount; offset += 1) {
  const n = seedStart + offset;
  const organization = catalog.organizations[(n - 1) % catalog.organizations.length];
  const input = {
    name: `v50.1c Ladder QA ${n}`,
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
    favoriteOrganizationId: String(organization.id)
  };

  const season = seasonApi.createCareerSeason({
    seed: `v50-1c-full-ladder-${n}`,
    input,
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(season.seasonId);
  const fixture = payload.fixture;

  assert.equal(fixture.worldMode, "PRODUCTION_REAL", `seed ${n}: not a Production fixture`);
  assert.deepEqual(fixture.organization.levelOrder, LEVELS, `seed ${n}: organization level order drift`);
  assertLevelSet(fixture.levelLeagues, `seed ${n}/levelLeagues`);
  assertLevelSet(fixture.organization.levels, `seed ${n}/organization.levels`);

  const levelRows = {};
  for (const level of LEVELS) {
    const schedule = assertScheduleLegality(fixture.levelLeagues[level], level);
    const affiliate = assertOrganizationMirror(fixture, level);
    levelRows[level] = { ...schedule, ...affiliate };
  }

  assert.equal(fixture.organization.userLevel, "A", `seed ${n}: age-18 Production career must start at A`);
  const userId = String(fixture.userPlayerId);
  const userLevels = LEVELS.filter((level) => Boolean(fixture.organization.levels[level].roster.players?.[userId]));
  assert.deepEqual(userLevels, ["A"], `seed ${n}: user must exist in exactly one ladder level`);

  const aaaTeamId = String(fixture.organization.levels.AAA.team.id);
  assert.equal(String(fixture.userTeamId), aaaTeamId, `seed ${n}: canonical AAA userTeamId drift`);
  assert.deepEqual(
    fixture.rosters[fixture.userTeamId],
    fixture.organization.levels.AAA.roster,
    `seed ${n}: canonical AAA roster mirror drift`
  );

  const uniqueOrganizationPlayers = assertNoOrganizationDuplicates(fixture);

  const restored = seasonApi.restoreSeason(structuredClone(payload));
  const restoredPayload = seasonApi.serializeSeason(restored.seasonId);
  assert.equal(restoredPayload.fixture.worldMode, "PRODUCTION_REAL", `seed ${n}: restore lost Production mode`);
  assert.deepEqual(restoredPayload.fixture.organization.levelOrder, LEVELS, `seed ${n}: restore lost ladder order`);
  assertLevelSet(restoredPayload.fixture.levelLeagues, `seed ${n}/restored levelLeagues`);
  assertLevelSet(restoredPayload.fixture.organization.levels, `seed ${n}/restored organization.levels`);
  assert.equal(restoredPayload.fixture.organization.userLevel, fixture.organization.userLevel, `seed ${n}: restore user level drift`);

  for (const level of LEVELS) {
    assert.equal(
      String(restoredPayload.fixture.organization.levels[level].team.id),
      String(fixture.organization.levels[level].team.id),
      `seed ${n}/${level}: restore affiliate drift`
    );
  }

  rows.push({
    seed: n,
    organizationId: fixture.organization.organizationId,
    organizationName: fixture.organization.name,
    levelOrder: fixture.organization.levelOrder,
    userLevel: fixture.organization.userLevel,
    userLevels,
    legalPairs,
    uniqueOrganizationPlayers,
    levels: levelRows,
    restoreRoundTrip: true
  });
}

const report = {
  schema: "THE_CALL_UP_V50_1C_FULL_LADDER_GATE",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  levelOrder: LEVELS,
  seeds: seedCount,
  rows
};

if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!quiet) console.log(JSON.stringify(report, null, 2));
