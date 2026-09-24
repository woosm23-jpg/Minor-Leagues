import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonGameFixture } from "../src/services/demoSeasonFactory.js";
import { simulateSeasonFixtureGame } from "../src/services/seasonGameService.js";
import { pitcherAvailability } from "../src/engine/season/pitcherSeasonState.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";
const REPORT = "reports/phase3-postseason-workload-baseline-4h-v1.json";
const SEED = "phase3-4h-postseason-workload-baseline";

function readSnapshot() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, SNAPSHOT))).toString("utf8"));
}

function stateView(state) {
  if (!state) return null;
  return {
    fatigue: Number(state.fatigue ?? 0),
    appearances: Number(state.appearances ?? 0),
    lastAppearanceDate: state.lastAppearanceDate ?? null,
    lastPitchCount: Number(state.lastPitchCount ?? 0),
    availability: pitcherAvailability(state)
  };
}

function rosterForPostseason(roster, ids) {
  const permitted = new Set(ids);
  return {
    ...roster,
    players: Object.fromEntries(Object.entries(roster.players ?? {}).filter(([id]) => permitted.has(id))),
    names: Object.fromEntries(Object.entries(roster.names ?? {}).filter(([id]) => permitted.has(id))),
    lineup: (roster.lineup ?? []).filter((id) => permitted.has(id)),
    lineupSlots: (roster.lineupSlots ?? []).filter((slot) => permitted.has(slot.starterId)),
    bench: (roster.bench ?? []).filter((row) => permitted.has(row.playerId)),
    defense: Object.fromEntries(Object.entries(roster.defense ?? {}).filter(([, id]) => permitted.has(id))),
    positionPlayers: (roster.positionPlayers ?? []).filter((id) => permitted.has(id)),
    starters: (roster.starters ?? []).filter((id) => permitted.has(id)),
    bullpen: (roster.bullpen ?? []).filter((id) => permitted.has(id)),
    pitchers: (roster.pitchers ?? []).filter((id) => permitted.has(id))
  };
}

function replayFixture(payload, game, series, gameIndex) {
  const mlb = payload.fixture.levelLeagues.MLB;
  const rosters = { ...mlb.rosters };
  for (const id of [game.awayTeamId, game.homeTeamId]) {
    rosters[id] = rosterForPostseason(mlb.rosters[id], payload.postseasonState.rosters[id]);
  }
  const seasonFixture = {
    ...payload.fixture,
    levelLeagues: { ...payload.fixture.levelLeagues, MLB: { ...mlb, rosters } }
  };
  const scheduleGame = {
    gameId: game.gameId,
    date: game.date,
    awayTeamId: game.awayTeamId,
    homeTeamId: game.homeTeamId,
    status: "SCHEDULED",
    seriesId: series.seriesId,
    seriesGame: gameIndex + 1,
    gamesInSeries: series.bestOf,
    awayRotationIndex: gameIndex % 5,
    homeRotationIndex: gameIndex % 5
  };
  return createSeasonGameFixture({
    seasonFixture, scheduleGame,
    playerStates: payload.playerStates,
    pitcherStates: payload.pitcherStates,
    roleStates: payload.roleStates,
    level: "MLB"
  });
}

function dateGap(from, to) {
  return from ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) : null;
}

function careerInput(organizationId) {
  return {
    name: "Postseason Workload QA", nationality: "대한민국", hometown: "구미",
    age: 18, heightCm: 180, weightKg: 78, bodyType: "ATHLETIC",
    bats: "R", throws: "R", primaryPosition: "SS", archetype: "BALANCED",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"], organizationMode: "FAVORITE",
    favoriteOrganizationId: String(organizationId)
  };
}

function main() {
  const master = readSnapshot();
  assert.equal(master.metadata.contentHash, "fnv1a32:f7b34713", "검증 기준 snapshot이 바뀌었습니다.");
  const organizations = seasonApi.getCareerCreationCatalog({ masterSnapshot: master }).organizations;
  assert.equal(organizations.length, 30);

  let season = seasonApi.createCareerSeason({
    seed: SEED, input: careerInput(organizations[0].id), masterSnapshot: master
  });
  season = seasonApi.simulateToSeasonEnd(season.seasonId);
  assert.equal(season.status, "COMPLETE");
  season = seasonApi.startPostseason(season.seasonId);
  assert.equal(season.status, "POSTSEASON");
  const openingPayload = seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(openingPayload, { mode: "FULL" }), true);

  // Both runs start from the same post-start restore checkpoint. Do not mutate gameplay source.
  season = seasonApi.restoreSeason(structuredClone(openingPayload));
  const before = seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(before, { mode: "FULL" }), true);
  season = seasonApi.advancePostseasonRound(season.seasonId);
  const after = seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(after, { mode: "FULL" }), true);
  assert.equal(after.postseasonState.currentRound, "DIVISION_SERIES");
  assert.equal(JSON.stringify(after.levelSeasons.MLB), JSON.stringify(before.levelSeasons.MLB), "정규시즌 기록이 바뀌었습니다.");

  const seriesRows = after.postseasonState.rounds.WILD_CARD;
  assert.equal(seriesRows.length, 4, "와일드카드 4개 시리즈가 필요합니다.");
  assert.ok(seriesRows.every((s) => s.games.length >= 2 && s.games.length <= 3));
  const pitching = after.postseasonState.stats.pitching;
  const usedPitcherIds = Object.keys(pitching).filter((id) => Number(pitching[id]?.Pitches ?? 0) > 0).sort();
  assert.ok(usedPitcherIds.length > 0, "포스트시즌 실투구 기록이 없습니다.");

  const modifiedUsed = usedPitcherIds.filter((id) =>
    JSON.stringify(before.pitcherStates[id] ?? null) !== JSON.stringify(after.pitcherStates[id] ?? null)
  );
  const totals = new Map();
  const representative = [...seriesRows].sort((a, b) => b.games.length - a.games.length)[0];
  const trace = [];
  let replayedGames = 0;
  let exactScoreMatches = 0;
  let priorDate = null;
  let repeatPitcherAppearances = 0;
  const priorAppearance = new Map();

  // Independent per-game replay is a *diagnostic* for the existing gameIndex%5/static-state path.
  // Mismatches are recorded rather than failing a future implementation that updates fatigue.
  for (const series of seriesRows) {
    for (const [index, game] of series.games.entries()) {
      const fixture = replayFixture(before, game, series, index);
      const result = simulateSeasonFixtureGame(fixture, {
        seed: `${before.fixture.seed}:POST:${game.gameId}`
      });
      replayedGames += 1;
      const match = result.awayRuns === game.awayRuns && result.homeRuns === game.homeRuns;
      if (match) exactScoreMatches += 1;
      const appearances = [];
      for (const side of ["away", "home"]) {
        for (const [playerId, line] of Object.entries(result.boxScore.teams[side].pitching ?? {})) {
          const pitches = Number(line.Pitches ?? 0);
          const battersFaced = Number(line.BF ?? 0);
          if (pitches <= 0 && battersFaced <= 0) continue;
          const old = totals.get(playerId) ?? { Pitches: 0, BF: 0, G: 0, GS: 0 };
          old.Pitches += pitches;
          old.BF += battersFaced;
          old.G += 1;
          if (playerId === fixture.initialState.currentPitcherId[side]) old.GS += 1;
          totals.set(playerId, old);
          const key = `${series.seriesId}:${playerId}`;
          const previously = priorAppearance.get(key);
          if (previously) repeatPitcherAppearances += 1;
          priorAppearance.set(key, game.date);
          if (series === representative) appearances.push({
            playerId, side, starter: playerId === fixture.initialState.currentPitcherId[side],
            pitches, battersFaced,
            priorSeriesAppearanceDate: previously ?? null,
            daysSincePriorSeriesAppearance: dateGap(previously, game.date),
            stateAtEachReplayStart: stateView(before.pitcherStates[playerId]),
            stateAfterActualRound: stateView(after.pitcherStates[playerId])
          });
        }
      }
      if (series === representative) {
        trace.push({
          gameId: game.gameId, date: game.date, daysSincePreviousGame: dateGap(priorDate, game.date),
          awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId,
          rotationIndex: index % 5,
          selectedStarterIds: fixture.initialState.currentPitcherId,
          score: { actual: [game.awayRuns, game.homeRuns], staticReplay: [result.awayRuns, result.homeRuns], match },
          pitcherAppearances: appearances
        });
        priorDate = game.date;
      }
    }
  }
  assert.equal(replayedGames, seriesRows.reduce((count, row) => count + row.games.length, 0));
  const exactPitcherStatMatches = [...totals].filter(([id, row]) =>
    ["Pitches", "BF", "G", "GS"].every((key) => Number(pitching[id]?.[key] ?? -1) === row[key])
  ).length;

  season = seasonApi.restoreSeason(structuredClone(openingPayload));
  season = seasonApi.advancePostseasonRound(season.seasonId);
  const repeat = seasonApi.serializeSeason(season.seasonId);
  assert.deepEqual(repeat.postseasonState.rounds.WILD_CARD, after.postseasonState.rounds.WILD_CARD, "same-seed series 결과 불일치");
  assert.deepEqual(repeat.postseasonState.stats, after.postseasonState.stats, "same-seed 포스트시즌 통계 불일치");
  assert.deepEqual(repeat.pitcherStates, after.pitcherStates, "same-seed 투수 상태 불일치");

  const report = {
    schema: "THE_CALL_UP_PHASE3_POSTSEASON_WORKLOAD_BASELINE_4H_V1",
    pass: true,
    scope: "READ_ONLY_GAMEPLAY_BASELINE",
    snapshotHash: master.metadata.contentHash,
    seed: SEED,
    calendar: { beforePlayerStateDate: before.playerStateDate, afterPlayerStateDate: after.playerStateDate },
    observed: {
      seriesCount: seriesRows.length,
      gameCount: replayedGames,
      usedPitcherCount: usedPitcherIds.length,
      actualPostseasonPitchCount: usedPitcherIds.reduce((n, id) => n + Number(pitching[id].Pitches ?? 0), 0),
      usedPitcherStatesChanged: modifiedUsed.length,
      changedPitcherIds: modifiedUsed,
      repeatedWithinSeriesPitcherAppearances: repeatPitcherAppearances,
      pitcherWorkloadCarriedIntoSessionState: modifiedUsed.length > 0,
      gapObserved: modifiedUsed.length === 0,
      gameIndexRotationModulo: 5,
      ordinarySeasonMlbStatsUnchanged: true
    },
    staticPregameReplay: {
      games: replayedGames, scoreMatches: exactScoreMatches,
      pitcherStatRows: totals.size, exactPitcherStatRows: exactPitcherStatMatches,
      method: "Same opening pitcher/player/role states, same gameIndex%5 and postseason seed for each game"
    },
    determinism: { sameSeedRoundReplay: true, statsEqual: true, pitcherStatesEqual: true },
    representativeSeries: {
      seriesId: representative.seriesId,
      gameCount: representative.games.length,
      games: trace
    },
    note: "Baseline only. This report does not change pitcher recovery, rotation or injury rules."
  };
  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, REPORT), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ report: REPORT, pass: true, observed: report.observed, staticPregameReplay: report.staticPregameReplay, determinism: report.determinism }, null, 2));
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
