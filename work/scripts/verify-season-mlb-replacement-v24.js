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

function setTools(player, value) {
  for (const key of ["contactR", "contactL", "rawPower", "vision", "discipline"]) if (key in player.hitting) player.hitting[key] = value;
  for (const key of ["fielding", "reaction", "armStrength", "armAccuracy"]) if (key in player.fielding) player.fielding[key] = value;
  for (const key of ["speed", "stealing", "baserunning"]) if (key in player.running) player.running[key] = value;
}

function setEveryFixtureCopy(payload, playerId, value) {
  for (const roster of Object.values(payload.fixture.rosters ?? {})) if (roster.players?.[playerId]) setTools(roster.players[playerId], value);
  for (const league of Object.values(payload.fixture.levelLeagues ?? {})) for (const roster of Object.values(league.rosters ?? {})) if (roster.players?.[playerId]) setTools(roster.players[playerId], value);
  for (const affiliate of Object.values(payload.fixture.organization?.levels ?? {})) if (affiliate.roster?.players?.[playerId]) setTools(affiliate.roster.players[playerId], value);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function forceInitialPromotion(season) {
  const payload = structuredClone(seasonApi.serializeSeason(season.seasonId));
  const mlb = payload.fixture.organization.levels.MLB.roster;
  const cfIds = [
    mlb.lineupSlots.find((row) => row.position === "CF")?.starterId,
    ...mlb.bench.filter((row) => row.coverage.includes("CF")).map((row) => row.playerId)
  ].filter(Boolean);
  for (const id of cfIds) setEveryFixtureCopy(payload, id, 20);
  const restored = seasonApi.restoreSeason(payload);
  return seasonApi.runOrganizationReview(restored.seasonId, { force: true });
}

function prepareReplacementPressure(season) {
  const payload = structuredClone(seasonApi.serializeSeason(season.seasonId));
  const replacementId = payload.fixture.organization.levels.AAA.roster.lineupSlots.find((row) => row.position === "CF")?.starterId;
  if (!replacementId) throw new Error("AAA CF replacement를 찾을 수 없습니다.");
  setEveryFixtureCopy(payload, payload.fixture.userPlayerId, 20);
  setEveryFixtureCopy(payload, replacementId, 90);
  return { season: seasonApi.restoreSeason(payload), replacementId };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const startArg = process.argv.find((arg) => arg.startsWith("--start="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const quiet = process.argv.includes("--quiet");
const seedCount = Number(seedArg?.slice(8) ?? 1);
const seedStart = Number(startArg?.slice(8) ?? 1);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const n = seedStart + i;

  // Normal world path must retain the v23 multi-level invariants.
  let baseline = seasonApi.createDemoSeason({ seed: `v24-baseline-${n}`, startDate: "2026-04-01" });
  baseline = seasonApi.simulateToSeasonEnd(baseline.seasonId);
  const baselinePayload = seasonApi.serializeSeason(baseline.seasonId);

  // Explicit replacement path: establish real AAA performance, call up the user,
  // then let real MLB games create the performance sample before the next move.
  let replacement = seasonApi.createDemoSeason({ seed: `v24-replacement-${n}`, startDate: "2026-04-01" });
  for (let game = 0; game < 8; game += 1) replacement = seasonApi.simulateCurrentGame(replacement.seasonId);
  const aaaGamesAtCallup = replacement.userStatsByLevel.AAA.userSeasonLine.G;
  replacement = forceInitialPromotion(replacement);
  const promotionEvent = replacement.organization.recentTransactions.find((event) => event.type === "PLAYER_PROMOTED" && event.playerId === replacement.userPlayer.id) ?? null;
  const prepared = prepareReplacementPressure(replacement);
  replacement = prepared.season;

  let safety = 0;
  while (replacement.currentLevel === "MLB" && safety < 20) {
    replacement = seasonApi.simulateCurrentGame(replacement.seasonId);
    safety += 1;
  }
  const mlbGamesAtDemotion = replacement.userStatsByLevel.MLB.userSeasonLine.G;
  const mlbOpsAtDemotion = replacement.userStatsByLevel.MLB.userSeasonLine.OPS;
  const demotionEvent = replacement.organization.recentTransactions.find((event) => event.type === "PLAYER_DEMOTED" && event.playerId === replacement.userPlayer.id) ?? null;
  const demotionEval = replacement.organization.userEvaluation;
  const aaaFrozenAtDemotion = replacement.userStatsByLevel.AAA.userSeasonLine.G === aaaGamesAtCallup;

  // After demotion the next user game must be AAA and the MLB line must freeze.
  const mlbLineFrozen = structuredClone(replacement.userStatsByLevel.MLB.userSeasonLine);
  let aaaReturnChecks = 0;
  while (replacement.currentLevel === "AAA" && replacement.nextGame && replacement.userStatsByLevel.AAA.userSeasonLine.G === aaaGamesAtCallup && aaaReturnChecks < 3) {
    replacement = seasonApi.simulateCurrentGame(replacement.seasonId);
    aaaReturnChecks += 1;
  }
  const resumedAaa = replacement.userStatsByLevel.AAA.userSeasonLine.G > aaaGamesAtCallup;
  const mlbFrozenAfterAaa = JSON.stringify(replacement.userStatsByLevel.MLB.userSeasonLine) === JSON.stringify(mlbLineFrozen);
  replacement = seasonApi.simulateToSeasonEnd(replacement.seasonId);

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T16:${String(n).padStart(2,"0")}:00.000Z` });
  const saveId = `v24-replacement-${n}`;
  await saveService.saveSeason(replacement.seasonId, { saveId, label: `V24 Replacement ${n}` });
  const restored = await saveService.loadSeason(saveId);

  const row = {
    seed: n,
    baseline: {
      status: baseline.status,
      userLevel: baseline.currentLevel,
      aaaUserGames: baseline.userStatsByLevel.AAA.userSeasonLine.G,
      mlbUserGames: baseline.userStatsByLevel.MLB.userSeasonLine.G,
      worldGames: baseline.progress.worldLeagueGamesCompleted,
      reviews: baseline.organization.review.reviews,
      blocked: baseline.organization.userEvaluation?.readiness === "MLB_READY" && baseline.organization.userEvaluation?.path === "BLOCKED",
      gameVersion: baselinePayload.gameVersion
    },
    replacement: {
      promoted: Boolean(promotionEvent),
      promotionDate: promotionEvent?.date ?? null,
      demoted: Boolean(demotionEvent),
      demotionDate: demotionEvent?.date ?? null,
      cooldownDays: promotionEvent && demotionEvent ? daysBetween(promotionEvent.date, demotionEvent.date) : null,
      mlbGamesAtDemotion,
      mlbOpsAtDemotion,
      aaaFrozenAtDemotion,
      demotionPerspective: demotionEval?.perspective ?? null,
      demotionDecision: demotionEval?.decision ?? null,
      demotionReasons: demotionEval?.reasonCodes ?? [],
      resumedAaa,
      mlbFrozenAfterAaa,
      finalLevel: replacement.currentLevel,
      finalStatus: replacement.status,
      worldGames: replacement.progress.worldLeagueGamesCompleted,
      roundTrip: restored.currentLevel === replacement.currentLevel && restored.progress.worldLeagueGamesCompleted === replacement.progress.worldLeagueGamesCompleted && restored.userStatsByLevel.MLB.userSeasonLine.G === replacement.userStatsByLevel.MLB.userSeasonLine.G,
      publicSafe: demotionEval ? !Object.keys(demotionEval).some((key) => ["internal", "candidateScore", "incumbentScore", "mlbPerf"].includes(key)) : false,
      gameVersion: seasonApi.serializeSeason(replacement.seasonId).gameVersion
    }
  };
  rows.push(row);

  if (verify) {
    const b = row.baseline;
    if (b.status !== "COMPLETE" || b.userLevel !== "AAA" || b.aaaUserGames !== 27 || b.mlbUserGames !== 0 || b.worldGames !== 560) throw new Error(`seed ${n}: v23 baseline regression`);
    if (b.reviews !== 4 || !b.blocked || b.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: baseline organization/version regression`);

    const r = row.replacement;
    if (!r.promoted || !r.demoted || !["AAA", "AA", "A"].includes(r.finalLevel)) throw new Error(`seed ${n}: promotion/demotion lifecycle regression`);
    if (r.cooldownDays < 14) throw new Error(`seed ${n}: transaction cooldown regression`);
    if (r.mlbGamesAtDemotion < 6 || r.mlbOpsAtDemotion >= 0.60) throw new Error(`seed ${n}: MLB performance sample regression`);
    if (!r.aaaFrozenAtDemotion || !r.resumedAaa || !r.mlbFrozenAfterAaa) throw new Error(`seed ${n}: split-level stat freeze/resume regression`);
    if (r.demotionPerspective !== "MLB_INCUMBENT" || r.demotionDecision !== "DEMOTE") throw new Error(`seed ${n}: demotion public perspective regression`);
    if (!r.demotionReasons.includes("MLB_RECENT_STRUGGLES") || !r.demotionReasons.includes("AAA_REPLACEMENT_READY")) throw new Error(`seed ${n}: demotion WHY regression`);
    if (!r.publicSafe || r.finalStatus !== "COMPLETE" || r.worldGames !== 560 || !r.roundTrip || r.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: v24 persistence/completion regression`);
  }
}

const report = { version: "v24", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (!quiet) console.log(JSON.stringify(report, null, 2));
