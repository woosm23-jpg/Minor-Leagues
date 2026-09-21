import fs from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";

function memoryRepository() {
  const store = new Map();
  return {
    async put(record) { store.set(record.saveId, structuredClone(record)); return structuredClone(record); },
    async get(id) { return store.has(id) ? structuredClone(store.get(id)) : null; },
    async getMeta(id) { const row=store.get(id); if(!row) return null; const {payload:_p,...meta}=row; return structuredClone(meta); },
    async list() { return [...store.values()].map(({payload:_p,...meta})=>structuredClone(meta)); },
    async delete(id) { return store.delete(id); }
  };
}

function weakenMlbCfAndForcePromotion(season) {
  const payload = structuredClone(seasonApi.serializeSeason(season.seasonId));
  const mlb = payload.fixture.organization.levels.MLB.roster;
  const cfIds = [
    mlb.lineupSlots.find((row) => row.position === "CF")?.starterId,
    ...mlb.bench.filter((row) => row.coverage.includes("CF")).map((row) => row.playerId)
  ].filter(Boolean);
  for (const id of cfIds) {
    const player = mlb.players[id];
    if (!player) continue;
    for (const key of ["contactR", "contactL", "rawPower", "vision", "discipline"]) player.hitting[key] = 20;
    for (const key of ["fielding", "reaction", "armStrength", "armAccuracy"]) player.fielding[key] = 20;
    for (const key of ["speed", "stealing", "baserunning"]) player.running[key] = 20;
  }
  const restored = seasonApi.restoreSeason(payload);
  return seasonApi.runOrganizationReview(restored.seasonId, { force: true });
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const startArg = process.argv.find((arg) => arg.startsWith("--start="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const quiet = process.argv.includes("--quiet");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const seedStart = Number(startArg?.slice(8) ?? 1);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const n = seedStart + i;

  // Baseline path: user remains AAA-blocked, while AAA+MLB world advances together.
  let baseline = seasonApi.createDemoSeason({ seed: `v23-multilevel-baseline-${n}`, startDate: "2026-04-01" });
  baseline = seasonApi.simulateToSeasonEnd(baseline.seasonId);
  const baselinePayload = seasonApi.serializeSeason(baseline.seasonId);

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T14:${String(i).padStart(2,"0")}:00.000Z` });
  const saveId = `v23-world-${n}`;
  await saveService.saveSeason(baseline.seasonId, { saveId, label: `V23 World ${n}` });
  const restoredBaseline = await saveService.loadSeason(saveId);

  // Call-up path: accumulate real AAA stats, promote, then accumulate real MLB stats.
  let callup = seasonApi.createDemoSeason({ seed: `v23-multilevel-callup-${n}`, startDate: "2026-04-01" });
  for (let game = 0; game < 8; game += 1) callup = seasonApi.simulateCurrentGame(callup.seasonId);
  const aaaGamesAtCallup = callup.userStatsByLevel.AAA.userSeasonLine.G;
  const worldGamesAtCallup = callup.progress.worldLeagueGamesCompleted;
  callup = weakenMlbCfAndForcePromotion(callup);
  const promoted = callup.currentLevel === "MLB" && callup.organization.userLevel === "MLB";
  const preMlbAssignmentTeamGames = callup.userRole.teamGames;
  callup = seasonApi.simulateCurrentGame(callup.seasonId);
  const mlbFirstGameG = callup.userStatsByLevel.MLB.userSeasonLine.G;
  const aaaFrozenAfterMlbGame = callup.userStatsByLevel.AAA.userSeasonLine.G === aaaGamesAtCallup;
  const assignmentAfterFirst = { teamGames: callup.userRole.teamGames, restGames: callup.userRole.restGames };
  callup = seasonApi.simulateToSeasonEnd(callup.seasonId);

  const callupPayload = seasonApi.serializeSeason(callup.seasonId);
  const restoredCallup = seasonApi.restoreSeason(structuredClone(callupPayload));

  // v22 compatibility: drop v23-only parallel league payload and reconstruct MLB.
  let legacySource = seasonApi.createDemoSeason({ seed: `v23-legacy-${n}`, startDate: "2026-04-01" });
  for (let game = 0; game < 5; game += 1) legacySource = seasonApi.simulateCurrentGame(legacySource.seasonId);
  const legacyPayload = structuredClone(seasonApi.serializeSeason(legacySource.seasonId));
  delete legacyPayload.levelSeasons;
  delete legacyPayload.activeLevel;
  delete legacyPayload.fixture.levelLeagues;
  legacyPayload.gameVersion = "phase3_promotion_ai_v22";
  const legacyRestored = seasonApi.restoreSeason(legacyPayload);
  const legacyNext = seasonApi.serializeSeason(legacyRestored.seasonId);

  const row = {
    seed: n,
    baseline: {
      status: baseline.status,
      level: baseline.currentLevel,
      aaaTeamGames: baseline.userStatsByLevel.AAA.gamesPlayed,
      aaaUserGames: baseline.userStatsByLevel.AAA.userSeasonLine.G,
      aaaRestGames: baseline.userRole.restGames,
      aaaLeagueGames: baseline.userStatsByLevel.AAA.leagueGamesCompleted,
      mlbLeagueGames: baseline.userStatsByLevel.MLB.leagueGamesCompleted,
      mlbUserGames: baseline.userStatsByLevel.MLB.userSeasonLine.G,
      worldGames: baseline.progress.worldLeagueGamesCompleted,
      blocked: baseline.organization.userEvaluation?.readiness === "MLB_READY" && baseline.organization.userEvaluation?.path === "BLOCKED",
      roundTrip: restoredBaseline.progress.worldLeagueGamesCompleted === 560 && restoredBaseline.userStatsByLevel.AAA.userSeasonLine.G === baseline.userStatsByLevel.AAA.userSeasonLine.G,
      serializedLevels: Object.keys(baselinePayload.levelSeasons ?? {}).sort()
    },
    callup: {
      promoted,
      worldGamesAtCallup,
      aaaGamesAtCallup,
      preMlbAssignmentTeamGames,
      mlbFirstGameG,
      aaaFrozenAfterMlbGame,
      assignmentAfterFirst,
      status: callup.status,
      level: callup.currentLevel,
      aaaUserGames: callup.userStatsByLevel.AAA.userSeasonLine.G,
      mlbUserGames: callup.userStatsByLevel.MLB.userSeasonLine.G,
      mlbAssignmentTeamGames: callup.userRole.teamGames,
      mlbRestGames: callup.userRole.restGames,
      aaaLeagueGames: callup.userStatsByLevel.AAA.leagueGamesCompleted,
      mlbLeagueGames: callup.userStatsByLevel.MLB.leagueGamesCompleted,
      worldGames: callup.progress.worldLeagueGamesCompleted,
      roundTrip: restoredCallup.currentLevel === "MLB" && restoredCallup.progress.worldLeagueGamesCompleted === 560 && restoredCallup.userStatsByLevel.AAA.userSeasonLine.G === callup.userStatsByLevel.AAA.userSeasonLine.G && restoredCallup.userStatsByLevel.MLB.userSeasonLine.G === callup.userStatsByLevel.MLB.userSeasonLine.G,
      gameVersion: callupPayload.gameVersion
    },
    legacy: {
      mlbLeagueGames: legacyRestored.userStatsByLevel.MLB.leagueGamesCompleted,
      currentLevel: legacyRestored.currentLevel,
      gameVersion: legacyNext.gameVersion,
      hasLevelSeasons: Boolean(legacyNext.levelSeasons?.A && legacyNext.levelSeasons?.HIGH_A && legacyNext.levelSeasons?.AA && legacyNext.levelSeasons?.AAA && legacyNext.levelSeasons?.MLB)
    }
  };

  rows.push(row);

  if (verify) {
    const b = row.baseline;
    if (b.status !== "COMPLETE" || b.level !== "AAA") throw new Error(`seed ${n}: baseline completion/level regression`);
    if (b.aaaTeamGames !== 28 || b.aaaUserGames !== 27 || b.aaaRestGames !== 1) throw new Error(`seed ${n}: AAA baseline role/rest regression`);
    if (b.aaaLeagueGames !== 112 || b.mlbLeagueGames !== 112 || b.worldGames !== 560) throw new Error(`seed ${n}: parallel world completion regression`);
    if (b.mlbUserGames !== 0 || !b.blocked || !b.roundTrip) throw new Error(`seed ${n}: baseline blocked/save regression`);
    if (b.serializedLevels.join(",") !== "A,AA,AAA,HIGH_A,MLB") throw new Error(`seed ${n}: level serialization missing`);

    const c = row.callup;
    if (!c.promoted || c.preMlbAssignmentTeamGames !== 0) throw new Error(`seed ${n}: promotion/assignment boundary regression`);
    if (c.mlbFirstGameG !== 1 || !c.aaaFrozenAfterMlbGame || c.assignmentAfterFirst.teamGames !== 1 || c.assignmentAfterFirst.restGames !== 0) throw new Error(`seed ${n}: first MLB game stats/rest regression`);
    if (c.status !== "COMPLETE" || c.level !== "MLB" || c.aaaUserGames !== c.aaaGamesAtCallup || c.mlbUserGames <= 0) throw new Error(`seed ${n}: level split stats regression`);
    if (c.aaaLeagueGames !== 112 || c.mlbLeagueGames !== 112 || c.worldGames !== 560) throw new Error(`seed ${n}: call-up world completion regression`);
    if (c.mlbAssignmentTeamGames !== c.mlbUserGames + c.mlbRestGames || !c.roundTrip || c.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: call-up save/rest accounting regression`);

    const l = row.legacy;
    if (l.currentLevel !== "AAA" || l.mlbLeagueGames <= 0 || !l.hasLevelSeasons || l.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: v22 legacy reconstruction regression`);
  }
}

const report = { version: "v23", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (!quiet) console.log(JSON.stringify(report, null, 2));
