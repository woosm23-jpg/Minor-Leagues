import fs from "node:fs";
import crypto from "node:crypto";
import { seasonApi } from "../src/api/seasonApi.js";

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const quiet = process.argv.includes("--quiet");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const golden = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/v26-upper-core-golden.json", import.meta.url), "utf8"));
const goldenBySeed = new Map(golden.rows.map((row) => [row.seed, row]));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function upperCoreComparable(payload) {
  const ids = new Set();
  for (const level of ["AAA", "MLB"]) {
    for (const roster of Object.values(payload.fixture.levelLeagues[level].rosters)) {
      for (const id of Object.keys(roster.players)) ids.add(id);
    }
  }
  const pick = (obj) => Object.fromEntries([...ids].sort().filter((id) => obj[id]).map((id) => [id, obj[id]]));
  return {
    levelSeasons: { AAA: payload.levelSeasons.AAA, MLB: payload.levelSeasons.MLB },
    levelLeagues: { AAA: payload.fixture.levelLeagues.AAA, MLB: payload.fixture.levelLeagues.MLB },
    organization: {
      userLevel: payload.fixture.organization.userLevel,
      AAA: payload.fixture.organization.levels.AAA,
      MLB: payload.fixture.organization.levels.MLB
    },
    playerStates: pick(payload.playerStates),
    pitcherStates: pick(payload.pitcherStates),
    roleStates: pick(payload.roleStates ?? {})
  };
}

const rows = [];
for (let n = 1; n <= seedCount; n += 1) {
  const seed = `v26-stability-${n}`;
  let season = seasonApi.createDemoSeason({ seed, startDate: "2026-04-01" });
  season = seasonApi.simulateToSeasonEnd(season.seasonId);
  const payload = seasonApi.serializeSeason(season.seasonId);
  const currentHash = sha256(upperCoreComparable(payload));
  const reference = goldenBySeed.get(seed);
  const serializedLevels = Object.keys(payload.levelSeasons ?? {}).sort();
  const lowerStats = Object.fromEntries(["A", "AA"].map((level) => [level, {
    games: payload.levelSeasons[level]?.completedGames ?? 0,
    battingRows: Object.keys(payload.levelSeasons[level]?.playerBatting ?? {}).length,
    pitchingRows: Object.keys(payload.levelSeasons[level]?.playerPitching ?? {}).length
  }]));
  const restored = seasonApi.restoreSeason(structuredClone(payload));
  const row = {
    seed,
    status: season.status,
    worldGames: season.progress.worldLeagueGamesCompleted,
    worldTotal: season.progress.worldLeagueGamesTotal,
    levels: Object.fromEntries(["A", "AA", "AAA", "MLB"].map((level) => [level, {
      completed: season.userStatsByLevel[level].leagueGamesCompleted,
      status: season.userStatsByLevel[level].status,
      userGames: season.userStatsByLevel[level].userSeasonLine.G
    }])),
    userRestGames: season.userRole.restGames,
    organizationSimulated: season.organization.levelSummaries.filter((item) => item.simulated).map((item) => item.level).sort(),
    serializedLevels,
    lowerStats,
    upperCoreReferenceHash: reference?.sha256 ?? null,
    currentHash,
    upperCoreStable: Boolean(reference && reference.sha256 === currentHash),
    roundTrip: restored.progress.worldLeagueGamesCompleted === 560
      && Object.keys(seasonApi.serializeSeason(restored.seasonId).levelSeasons ?? {}).sort().join(",") === "A,AA,AAA,MLB",
    gameVersion: payload.gameVersion
  };
  rows.push(row);

  if (verify) {
    if (row.status !== "COMPLETE" || row.worldGames !== 560 || row.worldTotal !== 560) throw new Error(`${seed}: four-level world completion regression`);
    for (const level of ["A", "AA", "AAA", "MLB"]) {
      if (row.levels[level].completed !== 112 || row.levels[level].status !== "COMPLETE") throw new Error(`${seed}: ${level} season completion regression`);
    }
    if (row.levels.AAA.userGames !== 27 || row.userRestGames !== 1 || row.levels.A.userGames !== 0 || row.levels.AA.userGames !== 0 || row.levels.MLB.userGames !== 0) {
      throw new Error(`${seed}: user assignment/rest regression`);
    }
    if (row.organizationSimulated.join(",") !== "A,AA,AAA,MLB" || row.serializedLevels.join(",") !== "A,AA,AAA,MLB") throw new Error(`${seed}: four-level structure/serialization regression`);
    if (row.lowerStats.A.games !== 112 || row.lowerStats.AA.games !== 112 || row.lowerStats.A.battingRows < 70 || row.lowerStats.AA.battingRows < 70 || row.lowerStats.A.pitchingRows < 30 || row.lowerStats.AA.pitchingRows < 30) {
      throw new Error(`${seed}: A/AA real stat accumulation regression`);
    }
    if (!row.upperCoreStable) throw new Error(`${seed}: v26 AAA/MLB authoritative core changed`);
    if (!row.roundTrip || row.gameVersion !== "phase3_position_assignment_v36") throw new Error(`${seed}: v26 persistence/version regression`);
  }
}

const report = { version: "v26", sourceGolden: golden.sourceVersion, seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (!quiet) console.log(JSON.stringify(report, null, 2));
