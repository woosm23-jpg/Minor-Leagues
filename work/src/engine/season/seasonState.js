import { deriveBattingRates } from "../game/boxScore.js";

const BAT_KEYS = Object.freeze(["PA", "AB", "R", "H", "doubles", "triples", "HR", "RBI", "BB", "HBP", "SO", "SF", "GDP", "TB", "SB", "CS"]);
const PITCH_KEYS = Object.freeze(["BF", "outsRecorded", "H", "doubles", "triples", "HR", "BB", "HBP", "SO", "R", "Pitches"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function emptyBattingTotals() {
  return Object.fromEntries(BAT_KEYS.map((key) => [key, 0]));
}

function emptyPitchingTotals() {
  return { G: 0, GS: 0, ...Object.fromEntries(PITCH_KEYS.map((key) => [key, 0])) };
}

function createStanding(teamId) {
  return { teamId, W: 0, L: 0, RS: 0, RA: 0 };
}

function normalizeGame(game) {
  return { ...game };
}

function derivePitchingRates(line) {
  const outs = Number(line?.outsRecorded ?? 0);
  const bf = Number(line?.BF ?? 0);
  const innings = outs / 3;
  const ra9 = outs > 0 ? Number(line?.R ?? 0) * 27 / outs : 0;
  const whip = outs > 0 ? (Number(line?.H ?? 0) + Number(line?.BB ?? 0)) * 3 / outs : 0;
  const kRate = bf > 0 ? Number(line?.SO ?? 0) / bf : 0;
  const bbRate = bf > 0 ? Number(line?.BB ?? 0) / bf : 0;
  const hrRate = bf > 0 ? Number(line?.HR ?? 0) / bf : 0;
  return freeze({ IP: innings, RA9: ra9, WHIP: whip, KRate: kRate, BBRate: bbRate, KBB: kRate - bbRate, HRRate: hrRate });
}

function createSeasonState({ seasonId, leagueId = "DEV_8", teams, schedule, userTeamId, userPlayerId, startDate }) {
  if (typeof seasonId !== "string" || !seasonId) throw new TypeError("seasonId가 필요합니다.");
  if (!Array.isArray(teams) || teams.length < 2) throw new RangeError("teams가 필요합니다.");
  if (!Array.isArray(schedule) || schedule.length === 0) throw new RangeError("schedule이 필요합니다.");
  const teamIds = teams.map((team) => team.id);
  if (!teamIds.includes(userTeamId)) throw new RangeError("userTeamId가 teams에 없습니다.");

  return freeze({
    schemaVersion: 1,
    seasonId,
    leagueId,
    startDate,
    currentDate: startDate,
    status: "REGULAR_SEASON",
    userTeamId,
    userPlayerId,
    teams: Object.fromEntries(teams.map((team) => [team.id, { ...team }])),
    schedule: schedule.map(normalizeGame),
    standings: Object.fromEntries(teamIds.map((id) => [id, createStanding(id)])),
    userSeason: { G: 0, ...emptyBattingTotals() },
    playerBatting: {},
    playerPitching: {},
    completedGames: 0
  });
}

function recordSeasonGame(state, {
  gameId,
  awayRuns,
  homeRuns,
  userBattingLine = null,
  battingByPlayer = null,
  pitchingByPlayer = null,
  startingPitcherIds = []
}) {
  const index = state.schedule.findIndex((game) => game.gameId === gameId);
  if (index < 0) throw new RangeError(`schedule game을 찾을 수 없습니다: ${gameId}`);
  const original = state.schedule[index];
  if (original.status === "FINAL") return state;
  if (!Number.isInteger(awayRuns) || awayRuns < 0 || !Number.isInteger(homeRuns) || homeRuns < 0 || awayRuns === homeRuns) {
    throw new RangeError("정규 경기 결과는 0 이상의 정수이며 동점일 수 없습니다.");
  }

  const winnerTeamId = awayRuns > homeRuns ? original.awayTeamId : original.homeTeamId;
  const loserTeamId = winnerTeamId === original.awayTeamId ? original.homeTeamId : original.awayTeamId;
  const nextSchedule = state.schedule.map((game, gameIndex) => gameIndex === index ? {
    ...game,
    status: "FINAL",
    awayRuns,
    homeRuns,
    winnerTeamId
  } : { ...game });

  const standings = Object.fromEntries(Object.entries(state.standings).map(([id, line]) => [id, { ...line }]));
  standings[original.awayTeamId].RS += awayRuns;
  standings[original.awayTeamId].RA += homeRuns;
  standings[original.homeTeamId].RS += homeRuns;
  standings[original.homeTeamId].RA += awayRuns;
  standings[winnerTeamId].W += 1;
  standings[loserTeamId].L += 1;

  const userSeason = { ...state.userSeason };
  const userInGame = original.awayTeamId === state.userTeamId || original.homeTeamId === state.userTeamId;
  if (userInGame && userBattingLine) {
    userSeason.G += 1;
    for (const key of BAT_KEYS) userSeason[key] += Number(userBattingLine[key] ?? 0);
  }

  const playerBatting = Object.fromEntries(Object.entries(state.playerBatting ?? {}).map(([id, line]) => [id, { ...line }]));
  if (battingByPlayer && typeof battingByPlayer === "object") {
    for (const [playerId, line] of Object.entries(battingByPlayer)) {
      const PA = Number(line?.PA ?? 0);
      if (PA <= 0) continue;
      const current = playerBatting[playerId] ?? { G: 0, ...emptyBattingTotals() };
      current.G += 1;
      for (const key of BAT_KEYS) current[key] += Number(line?.[key] ?? 0);
      playerBatting[playerId] = current;
    }
  }

  const starterSet = new Set(startingPitcherIds.filter(Boolean));
  const playerPitching = Object.fromEntries(Object.entries(state.playerPitching ?? {}).map(([id, line]) => [id, { ...line }]));
  if (pitchingByPlayer && typeof pitchingByPlayer === "object") {
    for (const [playerId, line] of Object.entries(pitchingByPlayer)) {
      const bf = Number(line?.BF ?? 0);
      const pitches = Number(line?.Pitches ?? 0);
      if (bf <= 0 && pitches <= 0) continue;
      const current = playerPitching[playerId] ?? emptyPitchingTotals();
      current.G += 1;
      if (starterSet.has(playerId)) current.GS += 1;
      for (const key of PITCH_KEYS) current[key] += Number(line?.[key] ?? 0);
      playerPitching[playerId] = current;
    }
  }

  const completedGames = state.completedGames + 1;
  const allDone = completedGames >= state.schedule.length;
  return freeze({
    ...state,
    schedule: nextSchedule,
    standings,
    userSeason,
    playerBatting,
    playerPitching,
    completedGames,
    status: allDone ? "COMPLETE" : state.status
  });
}

function setSeasonCurrentDate(state, currentDate) {
  return freeze({ ...state, currentDate });
}

function getUserSeasonLine(state) {
  return freeze({ ...state.userSeason, ...deriveBattingRates(state.userSeason) });
}

function getPlayerSeasonBattingLine(state, playerId) {
  const line = state.playerBatting?.[playerId] ?? { G: 0, ...emptyBattingTotals() };
  return freeze({ ...line, ...deriveBattingRates(line) });
}

function getAllPlayerSeasonBatting(state) {
  return freeze(Object.fromEntries(Object.entries(state.playerBatting ?? {}).map(([id, line]) => [id, { ...line, ...deriveBattingRates(line) }])));
}

function getPlayerSeasonPitchingLine(state, playerId) {
  const line = state.playerPitching?.[playerId] ?? emptyPitchingTotals();
  return freeze({ ...line, ...derivePitchingRates(line) });
}

function getAllPlayerSeasonPitching(state) {
  return freeze(Object.fromEntries(Object.entries(state.playerPitching ?? {}).map(([id, line]) => [id, { ...line, ...derivePitchingRates(line) }])));
}

function getStandingsTable(state) {
  const rows = Object.values(state.standings).map((line) => {
    const games = line.W + line.L;
    return {
      ...line,
      games,
      pct: games > 0 ? line.W / games : 0,
      runDiff: line.RS - line.RA,
      team: state.teams[line.teamId]
    };
  }).sort((a, b) => b.pct - a.pct || b.runDiff - a.runDiff || b.RS - a.RS || a.teamId.localeCompare(b.teamId));
  return freeze(rows.map((row, index) => ({ ...row, rank: index + 1 })));
}

function getNextTeamGame(state, teamId) {
  return state.schedule.find((game) => game.status !== "FINAL" && (game.awayTeamId === teamId || game.homeTeamId === teamId)) ?? null;
}

function getGamesOnDate(state, date) {
  return freeze(state.schedule.filter((game) => game.date === date));
}

function getSeriesGames(state, seriesId) {
  return freeze(state.schedule.filter((game) => game.seriesId === seriesId));
}

function getRecentTeamResults(state, teamId, limit = 6) {
  return freeze(state.schedule
    .filter((game) => game.status === "FINAL" && (game.awayTeamId === teamId || game.homeTeamId === teamId))
    .sort((a, b) => b.date.localeCompare(a.date) || b.gameId.localeCompare(a.gameId))
    .slice(0, limit));
}

export { derivePitchingRates, createSeasonState, recordSeasonGame, setSeasonCurrentDate, getUserSeasonLine, getPlayerSeasonBattingLine, getAllPlayerSeasonBatting, getPlayerSeasonPitchingLine, getAllPlayerSeasonPitching, getStandingsTable, getNextTeamGame, getGamesOnDate, getSeriesGames, getRecentTeamResults };
