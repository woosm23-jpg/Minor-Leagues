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

function setPitcherTools(player, value) {
  if (!player?.pitching) return;
  for (const key of ["control", "command", "movement", "pitchability", "stamina"]) if (key in player.pitching) player.pitching[key] = value;
  if (player.derived && "stuff" in player.derived) player.derived.stuff = value;
}

function setEveryPitcherFixtureCopy(payload, playerId, value) {
  for (const roster of Object.values(payload.fixture.rosters ?? {})) if (roster.players?.[playerId]) setPitcherTools(roster.players[playerId], value);
  for (const league of Object.values(payload.fixture.levelLeagues ?? {})) for (const roster of Object.values(league.rosters ?? {})) if (roster.players?.[playerId]) setPitcherTools(roster.players[playerId], value);
  for (const affiliate of Object.values(payload.fixture.organization?.levels ?? {})) if (affiliate.roster?.players?.[playerId]) setPitcherTools(affiliate.roster.players[playerId], value);
}

function strongSpLine() {
  return { G: 5, GS: 5, BF: 120, outsRecorded: 81, H: 18, doubles: 2, triples: 0, HR: 1, BB: 5, HBP: 0, SO: 36, R: 6, Pitches: 420 };
}
function weakSpLine() {
  return { G: 6, GS: 6, BF: 150, outsRecorded: 90, H: 45, doubles: 8, triples: 1, HR: 9, BB: 18, HBP: 1, SO: 20, R: 28, Pitches: 560 };
}
function daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000); }
function lineCopy(payload, level, id) { return structuredClone(payload.levelSeasons?.[level]?.playerPitching?.[id] ?? null); }

function forceSpPromotion(season) {
  const payload = structuredClone(seasonApi.serializeSeason(season.seasonId));
  const aaa = payload.fixture.organization.levels.AAA.roster;
  const mlb = payload.fixture.organization.levels.MLB.roster;
  const candidateId = aaa.starters[0];
  const incumbentId = mlb.starters[0];
  for (const id of aaa.starters) setEveryPitcherFixtureCopy(payload, id, id === candidateId ? 99 : 35);
  for (const id of mlb.starters) setEveryPitcherFixtureCopy(payload, id, 25);
  payload.levelSeasons.AAA.playerPitching ??= {};
  payload.levelSeasons.MLB.playerPitching ??= {};
  payload.levelSeasons.AAA.playerPitching[candidateId] = strongSpLine();
  for (const id of mlb.starters) payload.levelSeasons.MLB.playerPitching[id] = weakSpLine();
  payload.pitcherStates[candidateId].fatigue = 0;
  for (const id of mlb.starters) payload.pitcherStates[id].fatigue = 0;
  const restored = seasonApi.restoreSeason(payload);
  const moved = seasonApi.runOrganizationReview(restored.seasonId, { force: true });
  return { season: moved, candidateId, incumbentId };
}

function prepareSpDemotion(season, promotedId, replacementId) {
  const payload = structuredClone(seasonApi.serializeSeason(season.seasonId));
  setEveryPitcherFixtureCopy(payload, promotedId, 20);
  setEveryPitcherFixtureCopy(payload, replacementId, 99);
  if (payload.pitcherStates[promotedId]) payload.pitcherStates[promotedId].fatigue = 0;
  if (payload.pitcherStates[replacementId]) payload.pitcherStates[replacementId].fatigue = 0;
  return seasonApi.restoreSeason(payload);
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

  let baseline = seasonApi.createDemoSeason({ seed: `v25-baseline-${n}`, startDate: "2026-04-01" });
  baseline = seasonApi.simulateToSeasonEnd(baseline.seasonId);
  const baselinePayload = seasonApi.serializeSeason(baseline.seasonId);
  const baselinePitchingRows = Object.keys(baselinePayload.levelSeasons.AAA.playerPitching ?? {}).length + Object.keys(baselinePayload.levelSeasons.MLB.playerPitching ?? {}).length;

  let lifecycle = seasonApi.createDemoSeason({ seed: `v25-pitcher-${n}`, startDate: "2026-04-01" });
  for (let game = 0; game < 8; game += 1) lifecycle = seasonApi.simulateCurrentGame(lifecycle.seasonId);
  const promoted = forceSpPromotion(lifecycle);
  lifecycle = promoted.season;
  const promotionEvent = lifecycle.organization.recentTransactions.find((event) => event.type === "PLAYER_PROMOTED" && event.playerId === promoted.candidateId && event.position === "SP") ?? null;
  const callupPayload = seasonApi.serializeSeason(lifecycle.seasonId);
  const aaaLineAtCallup = lineCopy(callupPayload, "AAA", promoted.candidateId);
  lifecycle = prepareSpDemotion(lifecycle, promoted.candidateId, promoted.incumbentId);

  let safety = 0;
  let demotionEvent = null;
  while (!demotionEvent && lifecycle.nextGame && safety < 24) {
    lifecycle = seasonApi.simulateCurrentGame(lifecycle.seasonId);
    safety += 1;
    demotionEvent = lifecycle.organization.recentTransactions.find((event) => event.type === "PLAYER_DEMOTED" && event.playerId === promoted.candidateId && event.position === "SP") ?? null;
  }
  const demotionPayload = seasonApi.serializeSeason(lifecycle.seasonId);
  const aaaLineAtDemotion = lineCopy(demotionPayload, "AAA", promoted.candidateId);
  const mlbLineAtDemotion = lineCopy(demotionPayload, "MLB", promoted.candidateId);
  const aaaFrozenDuringMlb = JSON.stringify(aaaLineAtCallup) === JSON.stringify(aaaLineAtDemotion);
  const remainingAaaGamesAfterDemotion = (demotionPayload.levelSeasons?.AAA?.schedule ?? []).filter((game) =>
    game.status !== "FINAL" && game.date > (demotionEvent?.date ?? "9999-12-31")
  ).length;
  const mlbLineFrozen = structuredClone(mlbLineAtDemotion);
  lifecycle = seasonApi.simulateToSeasonEnd(lifecycle.seasonId);
  const finalPayload = seasonApi.serializeSeason(lifecycle.seasonId);
  const finalAaaLine = lineCopy(finalPayload, "AAA", promoted.candidateId);
  const finalMlbLine = lineCopy(finalPayload, "MLB", promoted.candidateId);

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T18:${String(n).padStart(2,"0")}:00.000Z` });
  const saveId = `v25-pitcher-${n}`;
  await saveService.saveSeason(lifecycle.seasonId, { saveId, label: `V25 Pitcher ${n}` });
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
      spReview: baseline.organization.pitcherEvaluations.SP?.kind === "PITCHER" && baseline.organization.pitcherEvaluations.SP?.sampleReady,
      rpReview: baseline.organization.pitcherEvaluations.RP?.kind === "PITCHER" && baseline.organization.pitcherEvaluations.RP?.sampleReady,
      pitchingRows: baselinePitchingRows,
      gameVersion: baselinePayload.gameVersion
    },
    pitcherLifecycle: {
      promoted: Boolean(promotionEvent),
      promotionDate: promotionEvent?.date ?? null,
      demoted: Boolean(demotionEvent),
      demotionDate: demotionEvent?.date ?? null,
      cooldownDays: promotionEvent && demotionEvent ? daysBetween(promotionEvent.date, demotionEvent.date) : null,
      mlbBFAtDemotion: Number(mlbLineAtDemotion?.BF ?? 0),
      mlbRunsAtDemotion: Number(mlbLineAtDemotion?.R ?? 0),
      aaaFrozenDuringMlb,
      remainingAaaGamesAfterDemotion,
      aaaResumedAfterDemotion: remainingAaaGamesAfterDemotion > 0
        ? Number(finalAaaLine?.G ?? 0) > Number(aaaLineAtDemotion?.G ?? 0)
        : JSON.stringify(finalAaaLine) === JSON.stringify(aaaLineAtDemotion),
      mlbFrozenAfterDemotion: JSON.stringify(finalMlbLine) === JSON.stringify(mlbLineFrozen),
      worldGames: lifecycle.progress.worldLeagueGamesCompleted,
      finalStatus: lifecycle.status,
      userLevel: lifecycle.currentLevel,
      roundTrip: restored.progress.worldLeagueGamesCompleted === lifecycle.progress.worldLeagueGamesCompleted && restored.currentLevel === lifecycle.currentLevel,
      gameVersion: finalPayload.gameVersion
    }
  };
  rows.push(row);

  if (verify) {
    const b = row.baseline;
    if (b.status !== "COMPLETE" || b.userLevel !== "AAA" || b.aaaUserGames !== 27 || b.mlbUserGames !== 0 || b.worldGames !== 560) throw new Error(`seed ${n}: baseline world regression`);
    if (b.reviews !== 4 || !b.spReview || !b.rpReview || b.pitchingRows < 100 || b.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: baseline pitcher review/stat regression`);
    const r = row.pitcherLifecycle;
    if (!r.promoted || !r.demoted) throw new Error(`seed ${n}: SP promotion/demotion lifecycle regression`);
    if (r.cooldownDays < 14) throw new Error(`seed ${n}: pitcher transaction cooldown regression`);
    if (r.mlbBFAtDemotion < 40 || r.mlbRunsAtDemotion < 5) throw new Error(`seed ${n}: real MLB pitching sample regression`);
    if (!r.aaaFrozenDuringMlb || !r.aaaResumedAfterDemotion || !r.mlbFrozenAfterDemotion) throw new Error(`seed ${n}: pitcher level-split stat freeze/resume regression`);
    if (r.finalStatus !== "COMPLETE" || r.worldGames !== 560 || r.userLevel !== "AAA" || !r.roundTrip || r.gameVersion !== "phase3_position_assignment_v36") throw new Error(`seed ${n}: pitcher persistence/completion regression`);
  }
}

const report = { version: "v25", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (!quiet) console.log(JSON.stringify(report, null, 2));
