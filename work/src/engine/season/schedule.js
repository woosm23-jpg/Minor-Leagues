function assertTeamIds(teamIds) {
  if (!Array.isArray(teamIds) || teamIds.length < 4 || teamIds.length % 2 !== 0) {
    throw new RangeError("teamIds는 4개 이상의 짝수 팀 배열이어야 합니다.");
  }
  if (new Set(teamIds).size !== teamIds.length) throw new RangeError("teamIds에는 중복이 있을 수 없습니다.");
  teamIds.forEach((id) => {
    if (typeof id !== "string" || !id) throw new TypeError("teamId는 비어 있지 않은 문자열이어야 합니다.");
  });
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`잘못된 날짜입니다: ${isoDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function createRounds(teamIds) {
  const teams = [...teamIds];
  const fixed = teams[0];
  let rotating = teams.slice(1);
  const rounds = [];
  const roundCount = teams.length - 1;

  for (let round = 0; round < roundCount; round += 1) {
    const row = [fixed, ...rotating];
    const pairs = [];
    for (let i = 0; i < row.length / 2; i += 1) {
      pairs.push([row[i], row[row.length - 1 - i]]);
    }
    rounds.push(pairs);
    rotating = [rotating.at(-1), ...rotating.slice(0, -1)];
  }
  return rounds;
}

/**
 * Development schedule: each round-robin pairing is a 2-game series.
 * cycles=2 means every pair meets in two series with home/away flipped,
 * giving 28 games/team in an 8-team league.
 */
function generateRoundRobinSchedule({
  teamIds,
  startDate = "2026-04-01",
  gamesPerSeries = 2,
  cycles = 2,
  offDayEverySeries = 4
}) {
  assertTeamIds(teamIds);
  if (!Number.isInteger(gamesPerSeries) || gamesPerSeries < 1) throw new RangeError("gamesPerSeries는 1 이상의 정수여야 합니다.");
  if (!Number.isInteger(cycles) || cycles < 1) throw new RangeError("cycles는 1 이상의 정수여야 합니다.");
  if (!Number.isInteger(offDayEverySeries) || offDayEverySeries < 0) throw new RangeError("offDayEverySeries는 0 이상의 정수여야 합니다.");

  const baseRounds = createRounds(teamIds);
  const schedule = [];
  const teamGameIndex = Object.fromEntries(teamIds.map((id) => [id, 0]));
  let dayOffset = 0;
  let globalSeriesIndex = 0;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (let roundIndex = 0; roundIndex < baseRounds.length; roundIndex += 1) {
      const seriesDate = addDays(startDate, dayOffset);
      const pairings = baseRounds[roundIndex];
      const seriesRecords = [];

      for (let pairIndex = 0; pairIndex < pairings.length; pairIndex += 1) {
        const [a, b] = pairings[pairIndex];
        const flip = ((roundIndex + pairIndex) % 2 === 1);
        const primaryHome = flip ? a : b;
        const primaryAway = flip ? b : a;
        const homeTeamId = cycle % 2 === 0 ? primaryHome : primaryAway;
        const awayTeamId = cycle % 2 === 0 ? primaryAway : primaryHome;
        const seriesId = `series_${cycle + 1}_${roundIndex + 1}_${pairIndex + 1}`;
        seriesRecords.push({ seriesId, homeTeamId, awayTeamId });
      }

      for (let gameInSeries = 0; gameInSeries < gamesPerSeries; gameInSeries += 1) {
        const date = addDays(seriesDate, gameInSeries);
        for (const series of seriesRecords) {
          const awayRotationIndex = teamGameIndex[series.awayTeamId] % 4;
          const homeRotationIndex = teamGameIndex[series.homeTeamId] % 4;
          teamGameIndex[series.awayTeamId] += 1;
          teamGameIndex[series.homeTeamId] += 1;
          const gameId = `g_${date.replaceAll("-", "")}_${series.awayTeamId}_${series.homeTeamId}`;
          schedule.push(Object.freeze({
            gameId,
            date,
            seriesId: series.seriesId,
            seriesGame: gameInSeries + 1,
            gamesInSeries: gamesPerSeries,
            awayTeamId: series.awayTeamId,
            homeTeamId: series.homeTeamId,
            awayRotationIndex,
            homeRotationIndex,
            status: "SCHEDULED",
            awayRuns: null,
            homeRuns: null,
            winnerTeamId: null
          }));
        }
      }

      globalSeriesIndex += 1;
      dayOffset += gamesPerSeries;
      if (offDayEverySeries > 0 && globalSeriesIndex % offDayEverySeries === 0) dayOffset += 1;
    }
  }

  return Object.freeze(schedule.sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId)));
}

function teamSchedule(schedule, teamId) {
  return Object.freeze(schedule.filter((game) => game.homeTeamId === teamId || game.awayTeamId === teamId));
}

function uniqueScheduleDates(schedule) {
  return Object.freeze([...new Set(schedule.map((game) => game.date))].sort());
}

/**
 * Convert a versioned Master Snapshot schedule into the engine schedule shape.
 * Source results/status are deliberately not replayed: a new career re-simulates
 * the season from the imported pairing/date/venue facts.
 */
function importSnapshotSchedule({ games, teamIds, level, resetResults = true }) {
  assertTeamIds(teamIds);
  const allowed = new Set(teamIds.map(String));
  const rows = (games ?? [])
    .filter((game) => game?.level === level && game?.gameType !== "S")
    .filter((game) => allowed.has(String(game.awayTeamId)) && allowed.has(String(game.homeTeamId)))
    .map((game) => ({ ...game, awayTeamId: String(game.awayTeamId), homeTeamId: String(game.homeTeamId) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.gamePk).localeCompare(String(b.gamePk)));
  if (!rows.length) throw new RangeError(`${level} snapshot schedule이 비어 있습니다.`);

  const teamGameIndex = Object.fromEntries(teamIds.map((id) => [String(id), 0]));
  const seriesCounters = new Map();
  const lastSeries = new Map();
  const output = [];
  for (const row of rows) {
    const awayTeamId = String(row.awayTeamId), homeTeamId = String(row.homeTeamId);
    if (awayTeamId === homeTeamId) throw new RangeError(`동일 팀 schedule game은 허용되지 않습니다: ${row.gamePk}`);
    const pairKey = [awayTeamId, homeTeamId].sort().join(":");
    const previous = lastSeries.get(pairKey);
    const date = String(row.date).slice(0, 10);
    const gap = previous ? Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${previous.date}T00:00:00Z`)) / 86400000) : Infinity;
    const sameHome = previous?.homeTeamId === homeTeamId;
    let seriesIndex = seriesCounters.get(pairKey) ?? 0;
    if (!previous || gap > 2 || !sameHome) seriesIndex += 1;
    seriesCounters.set(pairKey, seriesIndex);
    const seriesId = `real_${level}_${pairKey.replaceAll(":", "_")}_${seriesIndex}`;
    const priorSeriesGames = output.filter((game) => game.seriesId === seriesId).length;
    const awayRotationIndex = teamGameIndex[awayTeamId] % 5;
    const homeRotationIndex = teamGameIndex[homeTeamId] % 5;
    teamGameIndex[awayTeamId] += 1; teamGameIndex[homeTeamId] += 1;
    output.push(Object.freeze({
      gameId: `real_${level}_${row.gamePk}`,
      sourceGamePk: String(row.gamePk),
      date,
      seriesId,
      seriesGame: priorSeriesGames + 1,
      gamesInSeries: null,
      awayTeamId,
      homeTeamId,
      awayRotationIndex,
      homeRotationIndex,
      venueId: row.venueId == null ? null : String(row.venueId),
      sourceStatus: row.status ?? null,
      status: resetResults ? "SCHEDULED" : (String(row.status).toLowerCase().includes("final") ? "FINAL" : "SCHEDULED"),
      awayRuns: resetResults ? null : row.awayScore ?? null,
      homeRuns: resetResults ? null : row.homeScore ?? null,
      winnerTeamId: resetResults || row.awayScore == null || row.homeScore == null ? null : (Number(row.awayScore) > Number(row.homeScore) ? awayTeamId : homeTeamId)
    }));
    lastSeries.set(pairKey, { date, homeTeamId });
  }

  const bySeries = new Map();
  for (const game of output) bySeries.set(game.seriesId, (bySeries.get(game.seriesId) ?? 0) + 1);
  return Object.freeze(output.map((game) => Object.freeze({ ...game, gamesInSeries: bySeries.get(game.seriesId) ?? 1 })));
}

function futureRoundRobinPairs(teamIds) {
  const rounds = createRounds(teamIds);
  return rounds.map((pairs) => pairs.map(([a, b]) => [String(a), String(b)]));
}

/**
 * Future-year 30-team fallback generator. It is intentionally schedule-fact
 * generation, not a standings/result shortcut. Every pair meets for five games
 * and the first 17 circle-method rounds receive one extra game, yielding exactly
 * 162 games and 81 home games per club.
 *
 * The start-year still uses imported real pairings/dates; this generator is only
 * for years after the snapshot season when no official schedule exists yet.
 */
function generateFutureProductionSchedule({ teamIds, startDate = "2027-03-25" }) {
  if (!Array.isArray(teamIds) || teamIds.length !== 30 || new Set(teamIds).size !== 30) {
    throw new RangeError("production future schedule은 중복 없는 30개 팀이 필요합니다.");
  }
  const ids = teamIds.map(String);
  const rounds = futureRoundRobinPairs(ids);
  const schedule = [];
  const homeCounts = Object.fromEntries(ids.map((id) => [id, 0]));
  const gameCounts = Object.fromEntries(ids.map((id) => [id, 0]));
  let dayOffset = 0;
  let roundNo = 0;

  // A balanced 30-team round-robin gives every club 14 or 15 home dates over
  // the 29 opponent rounds. Alternating that orientation across five complete
  // cycles leaves clubs on 72 or 73 home games after 145 games. Reversing the
  // orientation for the first 17 rounds then supplies exactly the missing 9 or
  // 8 home dates respectively: 162 games, 81 home / 81 away for every club.
  const balancedAHome = (roundIndex, pairIndex) => (
    pairIndex === 0 ? roundIndex % 2 === 0 : pairIndex % 2 === 0
  );

  const appendRound = ({ roundIndex, flipHome = false, phase }) => {
    const date = addDays(startDate, dayOffset);
    roundNo += 1;
    for (let pairIndex = 0; pairIndex < rounds[roundIndex].length; pairIndex += 1) {
      const [a, b] = rounds[roundIndex][pairIndex];
      const aHome = balancedAHome(roundIndex, pairIndex) !== flipHome;
      const homeTeamId = aHome ? a : b;
      const awayTeamId = aHome ? b : a;
      const awayRotationIndex = gameCounts[awayTeamId] % 5;
      const homeRotationIndex = gameCounts[homeTeamId] % 5;
      gameCounts[awayTeamId] += 1;
      gameCounts[homeTeamId] += 1;
      homeCounts[homeTeamId] += 1;
      schedule.push(Object.freeze({
        gameId: `future_${date.replaceAll("-", "")}_${awayTeamId}_${homeTeamId}`,
        date,
        seriesId: `future_${phase}_r${roundNo}`,
        seriesGame: 1,
        gamesInSeries: 1,
        awayTeamId,
        homeTeamId,
        awayRotationIndex,
        homeRotationIndex,
        status: "SCHEDULED",
        awayRuns: null,
        homeRuns: null,
        winnerTeamId: null
      }));
    }
    dayOffset += 1;
    // Keep the fallback calendar within a normal major-league season length
    // without pretending to reproduce a future official schedule.
    if (roundNo % 14 === 0) dayOffset += 1;
  };

  for (let cycle = 0; cycle < 5; cycle += 1) {
    for (let r = 0; r < rounds.length; r += 1) {
      appendRound({ roundIndex: r, flipHome: cycle % 2 === 1, phase: `c${cycle + 1}` });
    }
  }
  for (let r = 0; r < 17; r += 1) {
    appendRound({ roundIndex: r, flipHome: true, phase: "extra" });
  }

  for (const id of ids) {
    if (gameCounts[id] !== 162) throw new Error(`future schedule ${id} 경기 수 오류: ${gameCounts[id]}`);
    if (homeCounts[id] !== 81) throw new Error(`future schedule ${id} 홈 경기 수 오류: ${homeCounts[id]}`);
  }
  if (schedule.length !== 2430) throw new Error(`future schedule 전체 경기 수 오류: ${schedule.length}`);
  return Object.freeze(schedule.sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId)));
}

export { generateRoundRobinSchedule, teamSchedule, uniqueScheduleDates, importSnapshotSchedule, generateFutureProductionSchedule };
