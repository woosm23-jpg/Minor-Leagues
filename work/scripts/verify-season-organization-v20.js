import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";

const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const DEFAULT_SNAPSHOT = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1a-organization-depth.json";

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

function assertFiniteDepthEntries(organization) {
  let depthEntryCount = 0;
  for (const position of organization.positionOptions) {
    const groups = organization.depthCharts[position];
    assert.ok(Array.isArray(groups), `depth chart missing: ${position}`);
    assert.deepEqual(groups.map((group) => group.level), LEVELS, `${position}: depth level order drift`);
    for (const group of groups) {
      assert.ok(group.team?.id !== null && group.team?.id !== undefined, `${position}/${group.level}: team id missing`);
      assert.ok(Array.isArray(group.entries), `${position}/${group.level}: entries missing`);
      for (const entry of group.entries) {
        assert.ok(entry.id !== null && entry.id !== undefined && String(entry.id).length > 0, `${position}/${group.level}: player id missing`);
        assert.ok(Number.isFinite(entry.rank) && entry.rank >= 1, `${position}/${group.level}/${entry.id}: invalid rank`);
        assert.ok(Number.isFinite(entry.depthScore), `${position}/${group.level}/${entry.id}: invalid depth score`);
        depthEntryCount += 1;
      }
    }
  }
  assert.ok(depthEntryCount > 0, "organization depth chart is empty");
  return depthEntryCount;
}

function assertRosterReferences(fixture) {
  const invalid = [];
  const counts = {};
  for (const level of LEVELS) {
    const affiliate = fixture.organization?.levels?.[level];
    assert.ok(affiliate?.roster, `${level}: organization roster missing`);
    const roster = affiliate.roster;
    const players = roster.players ?? {};
    const refs = [
      ...(roster.positionPlayers ?? []),
      ...(roster.pitchers ?? []),
      ...(roster.starters ?? []),
      ...(roster.bullpen ?? []),
      ...(roster.lineup ?? []),
      ...(roster.lineupSlots ?? []).map((slot) => slot.starterId),
      ...(roster.bench ?? []).map((row) => row.playerId)
    ].filter((id) => id !== null && id !== undefined);
    for (const id of refs) {
      if (!String(id).length || !players[id]) invalid.push(`${level}:${id}`);
    }
    counts[level] = {
      players: Object.keys(players).length,
      positionPlayers: roster.positionPlayers?.length ?? 0,
      pitchers: roster.pitchers?.length ?? 0,
      referencesChecked: refs.length
    };
    assert.ok(Number.isFinite(counts[level].players) && counts[level].players > 0, `${level}: empty roster`);
  }
  assert.deepEqual(invalid, [], `dangling roster references: ${invalid.slice(0, 8).join(", ")}`);
  return counts;
}

const verify = process.argv.includes("--verify");
const seedCount = Number(arg("seeds", "2"));
const snapshotPath = arg("snapshot", DEFAULT_SNAPSHOT);
const outputPath = arg("output", DEFAULT_OUTPUT);
assert.ok(Number.isInteger(seedCount) && seedCount >= 1 && seedCount <= 6, "seeds must be an integer from 1 to 6");

const snapshot = loadSnapshot(snapshotPath);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30, "Production organization catalog must contain 30 MLB organizations");

const rows = [];
for (let i = 0; i < seedCount; i += 1) {
  const organization = catalog.organizations[i % catalog.organizations.length];
  const input = {
    name: `v50.1a QA ${i + 1}`,
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

  const season = seasonApi.createCareerSeason({ seed: `v50-1a-organization-${i + 1}`, input, masterSnapshot: snapshot });
  const view = season.organization;
  const payload = seasonApi.serializeSeason(season.seasonId);

  assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL", `seed ${i + 1}: not a Production fixture`);
  assert.ok(view, `seed ${i + 1}: organization view missing`);
  assert.deepEqual(view.levelOrder, LEVELS, `seed ${i + 1}: five-level order mismatch`);
  assert.deepEqual(view.levelSummaries.map((row) => row.level), LEVELS, `seed ${i + 1}: level summaries mismatch`);
  assert.equal(Object.keys(payload.fixture.organization.levels).filter((level) => LEVELS.includes(level)).length, LEVELS.length, `seed ${i + 1}: organization levels missing`);

  for (const summary of view.levelSummaries) {
    assert.ok(Number.isFinite(summary.positionPlayers) && summary.positionPlayers > 0, `${summary.level}: invalid position-player count`);
    assert.ok(Number.isFinite(summary.pitchers) && summary.pitchers > 0, `${summary.level}: invalid pitcher count`);
  }

  const depthEntryCount = assertFiniteDepthEntries(view);
  const rosterCounts = assertRosterReferences(payload.fixture);
  const userId = payload.fixture.userPlayerId;
  const assignmentLevels = LEVELS.filter((level) => Boolean(payload.fixture.organization.levels[level]?.roster?.players?.[userId]));
  assert.deepEqual(assignmentLevels, [view.userLevel], `seed ${i + 1}: user must belong to exactly one active organization level`);

  const userDepth = view.depthCharts[view.userPosition];
  assert.ok(Array.isArray(userDepth), `seed ${i + 1}: user position depth chart missing`);
  const userDepthEntries = userDepth.flatMap((group) => group.entries.filter((entry) => entry.id === userId).map((entry) => ({ ...entry, groupLevel: group.level })));
  assert.equal(userDepthEntries.length, 1, `seed ${i + 1}: user depth entry must appear exactly once`);
  assert.equal(userDepthEntries[0].groupLevel, view.userLevel, `seed ${i + 1}: user depth entry level mismatch`);
  assert.equal(userDepthEntries[0].isUser, true, `seed ${i + 1}: user depth marker missing`);
  assert.ok(Number.isFinite(userDepthEntries[0].depthScore), `seed ${i + 1}: user depth score invalid`);

  rows.push({
    seed: i + 1,
    organizationId: view.id,
    organizationName: view.name,
    levelOrder: view.levelOrder,
    userLevel: view.userLevel,
    userPosition: view.userPosition,
    userAssignmentLevels: assignmentLevels,
    userDepthScore: userDepthEntries[0].depthScore,
    depthEntryCount,
    rosterCounts
  });
}

const report = {
  schema: "THE_CALL_UP_V50_1A_ORGANIZATION_DEPTH",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  levelOrder: LEVELS,
  seeds: seedCount,
  rows
};

fs.mkdirSync(new URL("../reports/", import.meta.url), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
