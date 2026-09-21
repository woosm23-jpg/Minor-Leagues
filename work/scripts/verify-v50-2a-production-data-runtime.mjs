import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { validateMasterSnapshot, createSaveUniverseFromMasterSnapshot } from "../src/data/masterSnapshot.js";
import { inferRealWorldUniverse } from "../src/data/realWorldInference.js";
import { isPlayerGameAvailable, playerAssignedLevel, playerAssignedTeamId } from "../src/data/rosterAvailability.js";
import { validateProductionRuntimeUniverse } from "../src/services/productionSeasonFactory.js";
import { seasonApi } from "../src/api/seasonApi.js";

const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const MANIFEST_PATH = "data/the_call_up_snapshot_v2/production_manifest_v2.json";
const DEFAULT_OUTPUT = "reports/v50-2a-production-data-runtime.json";
const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const EXPECTED_SCHEDULES = Object.freeze({
  MLB: 2430,
  AAA: 2250,
  AA: 2070,
  HIGH_A: 1980,
  A: 1980
});

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = String(keyFn(row));
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
function loadGzipJson(path) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path)).toString("utf8"));
}
function activeTeamCount(raw, level) {
  return raw.teams.filter((team) => team.level === level && team.active !== false).length;
}
function scheduleCount(raw, level) {
  return raw.schedule.filter((game) => game.level === level).length;
}

const verify = process.argv.includes("--verify");
const outputPath = arg("output", DEFAULT_OUTPUT);

const raw = loadGzipJson(SNAPSHOT_PATH);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

assert.equal(raw.schemaVersion, 2, "Snapshot schema must be v2");
assert.equal(manifest.snapshotSchema, 2, "Production manifest snapshot schema drift");
assert.equal(manifest.contentHash, raw.metadata.contentHash, "manifest/snapshot content hash drift");
assert.equal(manifest.snapshotDate, raw.metadata.snapshotDate, "manifest/snapshot date drift");
assert.equal(manifest.coverage.teams, raw.teams.length, "manifest team count drift");
assert.equal(manifest.coverage.players, raw.players.length, "manifest player count drift");
assert.equal(manifest.coverage.statsRows, raw.stats.length, "manifest stats count drift");
assert.equal(manifest.coverage.scheduleGames, raw.schedule.length, "manifest schedule count drift");
assert.equal(manifest.coverage.parks, raw.parks?.length ?? 0, "manifest park count drift");

validateMasterSnapshot(raw, { requireProductionCoverage: true });

const playerIds = raw.players.map((player) => String(player.id));
assert.equal(new Set(playerIds).size, playerIds.length, "canonical player IDs contain duplicates");

const teamIds = new Set(raw.teams.map((team) => String(team.id)));
for (const player of raw.players) {
  const assignedTeamId = playerAssignedTeamId(player);
  if (assignedTeamId != null) {
    assert.ok(teamIds.has(String(assignedTeamId)), `assigned team missing for player ${player.id}/${assignedTeamId}`);
  }
  assert.ok(Array.isArray(player.positions) && player.positions.length > 0, `position evidence missing for player ${player.id}`);
}

const teamCounts = {};
const snapshotSchedules = {};
for (const level of LEVELS) {
  teamCounts[level] = activeTeamCount(raw, level);
  snapshotSchedules[level] = scheduleCount(raw, level);
  assert.equal(teamCounts[level], 30, `${level}: active Production team count drift`);
  assert.equal(snapshotSchedules[level], EXPECTED_SCHEDULES[level], `${level}: 2026 schedule count drift`);
}

assert.equal(raw.schedule.length, 10710, "2026 total five-level schedule drift");
assert.equal(raw.parks?.length ?? 0, 30, "MLB park coverage drift");

for (const season of [2024, 2025, 2026]) {
  for (const group of ["hitting", "pitching", "fielding"]) {
    assert.ok(
      raw.stats.some((row) => Number(row.season) === season && row.group === group),
      `${season}/${group}: stats missing`
    );
  }
}

const activePlayers = raw.players.filter(isPlayerGameAvailable);
for (const level of LEVELS) {
  assert.ok(
    activePlayers.some((player) => playerAssignedLevel(player) === level),
    `${level}: no game-available assigned players`
  );
}

const universe = createSaveUniverseFromMasterSnapshot(raw, {
  copiedAtCareerStart: raw.metadata.snapshotDate,
  sourceVersion: "v50.2a-production-data-runtime"
});
const inferred = inferRealWorldUniverse(universe);
validateProductionRuntimeUniverse(inferred);

const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: raw });
assert.equal(catalog.organizations.length, 30, "Production career catalog must contain 30 organizations");

const organization = catalog.organizations[0];
const input = {
  name: "v50.2a Runtime QA",
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

const created = seasonApi.createCareerSeason({
  seed: "v50-2a-production-runtime",
  input,
  masterSnapshot: raw
});
const payload = seasonApi.serializeSeason(created.seasonId);

assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL", "runtime worldMode drift");
assert.equal(payload.fixture.startDate, "2026-03-25", "Production start date drift");
assert.deepEqual(payload.fixture.organization.levelOrder, LEVELS, "runtime five-level order drift");
assert.equal(payload.fixture.organization.userLevel, "A", "age-18 Production user should begin at A");
assert.equal(payload.dataUniverse.origin, "MASTER_SNAPSHOT", "runtime data universe origin drift");
assert.equal(payload.dataUniverse.sourceSnapshot.hash, raw.metadata.contentHash, "runtime source snapshot hash drift");

const runtimeLevels = {};
for (const level of LEVELS) {
  const league = payload.fixture.levelLeagues[level];
  assert.ok(league, `${level}: runtime league missing`);
  assert.equal(league.teams.length, 30, `${level}: runtime team count drift`);
  assert.equal(Object.keys(league.rosters ?? {}).length, 30, `${level}: runtime roster map drift`);
  assert.equal(league.schedule.length, EXPECTED_SCHEDULES[level], `${level}: runtime schedule count drift`);
  assert.ok(league.schedule.every((game) => game.status === "SCHEDULED"), `${level}: new career schedule not reset`);

  const affiliate = payload.fixture.organization.levels[level];
  assert.ok(affiliate?.team?.id != null, `${level}: user organization affiliate missing`);
  const teamId = String(affiliate.team.id);
  assert.ok(league.rosters[teamId], `${level}: affiliate roster missing in runtime league`);
  assert.deepEqual(affiliate.roster, league.rosters[teamId], `${level}: organization/league roster mirror drift`);

  runtimeLevels[level] = {
    teams: league.teams.length,
    scheduleGames: league.schedule.length,
    affiliateTeamId: teamId,
    affiliatePlayers: Object.keys(affiliate.roster.players ?? {}).length,
    affiliatePositionPlayers: affiliate.roster.positionPlayers?.length ?? 0,
    affiliatePitchers: affiliate.roster.pitchers?.length ?? 0
  };
}

const userId = String(payload.fixture.userPlayerId);
const userAssignments = LEVELS.filter((level) =>
  Boolean(payload.fixture.organization.levels[level]?.roster?.players?.[userId])
);
assert.deepEqual(userAssignments, ["A"], "new Production user must exist in exactly one organization level");

const restored = seasonApi.restoreSeason(structuredClone(payload));
const restoredPayload = seasonApi.serializeSeason(restored.seasonId);
assert.equal(restoredPayload.fixture.worldMode, "PRODUCTION_REAL", "restore lost Production mode");
assert.deepEqual(restoredPayload.fixture.organization.levelOrder, LEVELS, "restore lost five-level order");
assert.equal(restoredPayload.dataUniverse.sourceSnapshot.hash, raw.metadata.contentHash, "restore source snapshot hash drift");

const report = {
  schema: "THE_CALL_UP_V50_2A_PRODUCTION_DATA_RUNTIME",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  snapshot: {
    id: raw.metadata.snapshotId,
    date: raw.metadata.snapshotDate,
    contentHash: raw.metadata.contentHash,
    teams: raw.teams.length,
    players: raw.players.length,
    activePlayers: activePlayers.length,
    statsRows: raw.stats.length,
    scheduleGames: raw.schedule.length,
    parks: raw.parks?.length ?? 0,
    availability: countBy(raw.players, (player) => player.availability ?? "MISSING")
  },
  dataGate: {
    teamCounts,
    schedules: snapshotSchedules,
    historySeasons: [2024, 2025, 2026],
    historyGroups: ["hitting", "pitching", "fielding"],
    runtimeUniverseValidation: true
  },
  runtimeGate: {
    organizations: catalog.organizations.length,
    selectedOrganization: organization.name,
    worldMode: payload.fixture.worldMode,
    startDate: payload.fixture.startDate,
    userLevel: payload.fixture.organization.userLevel,
    userAssignments,
    levels: runtimeLevels,
    restoreRoundTrip: true
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
