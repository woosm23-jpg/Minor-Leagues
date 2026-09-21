const BATTING_FIELDS = Object.freeze([
  "PA", "AB", "R", "H", "doubles", "triples", "HR", "RBI", "BB", "HBP", "SO", "SF", "GDP", "TB", "ROE", "SB", "CS", "PKO"
]);
const PITCHING_FIELDS = Object.freeze([
  "BF", "outsRecorded", "H", "doubles", "triples", "HR", "BB", "HBP", "SO", "R", "Pitches"
]);
const FIELDING_FIELDS = Object.freeze(["PO", "A", "E", "DP"]);

function zeroLine(fields) {
  return Object.fromEntries(fields.map((field) => [field, 0]));
}

function createBattingLine(playerId) {
  return Object.freeze({ playerId, ...zeroLine(BATTING_FIELDS) });
}

function createPitchingLine(playerId) {
  return Object.freeze({ playerId, ...zeroLine(PITCHING_FIELDS) });
}

function createFieldingLine(playerId) {
  return Object.freeze({ playerId, ...zeroLine(FIELDING_FIELDS) });
}

function cloneTeam(team) {
  return {
    battingOrder: [...team.battingOrder],
    batting: Object.fromEntries(Object.entries(team.batting).map(([id, line]) => [id, { ...line }])),
    pitching: Object.fromEntries(Object.entries(team.pitching).map(([id, line]) => [id, { ...line }])),
    fielding: Object.fromEntries(Object.entries(team.fielding ?? {}).map(([id, line]) => [id, { ...line }]))
  };
}

function freezeTeam(team) {
  return Object.freeze({
    battingOrder: Object.freeze([...team.battingOrder]),
    batting: Object.freeze(Object.fromEntries(Object.entries(team.batting).map(([id, line]) => [id, Object.freeze({ ...line })]))),
    pitching: Object.freeze(Object.fromEntries(Object.entries(team.pitching).map(([id, line]) => [id, Object.freeze({ ...line })]))),
    fielding: Object.freeze(Object.fromEntries(Object.entries(team.fielding ?? {}).map(([id, line]) => [id, Object.freeze({ ...line })])))
  });
}

function freezeBoxScore(boxScore) {
  return Object.freeze({
    ...boxScore,
    teams: Object.freeze({
      away: freezeTeam(boxScore.teams.away),
      home: freezeTeam(boxScore.teams.home)
    }),
    lineScore: Object.freeze({
      away: Object.freeze({ ...boxScore.lineScore.away }),
      home: Object.freeze({ ...boxScore.lineScore.home })
    })
  });
}

function initialFieldingIds(initialState, team, pitcherId) {
  const alignment = initialState.defensiveAlignment?.[team];
  const ids = alignment ? Object.values(alignment) : [pitcherId];
  return [...new Set(ids.filter(Boolean))];
}

function createBoxScore(initialState) {
  if (!initialState || typeof initialState !== "object") throw new TypeError("initialState가 필요합니다.");

  const team = (teamKey, lineup, pitcherId) => ({
    battingOrder: [...lineup],
    batting: Object.fromEntries(lineup.map((id) => [id, { ...createBattingLine(id) }])),
    pitching: { [pitcherId]: { ...createPitchingLine(pitcherId) } },
    fielding: Object.fromEntries(initialFieldingIds(initialState, teamKey, pitcherId).map((id) => [id, { ...createFieldingLine(id) }]))
  });

  return freezeBoxScore({
    schemaVersion: 3,
    gameId: initialState.gameId,
    teams: {
      away: team("away", initialState.lineups.away, initialState.currentPitcherId.away),
      home: team("home", initialState.lineups.home, initialState.currentPitcherId.home)
    },
    lineScore: { away: {}, home: {} }
  });
}

function incrementLine(line, delta, fields) {
  const next = { ...line };
  for (const field of fields) next[field] = (next[field] ?? 0) + (delta?.[field] ?? 0);
  return next;
}

function ensurePitcher(team, pitcherId) {
  if (!team.pitching[pitcherId]) team.pitching[pitcherId] = { ...createPitchingLine(pitcherId) };
  if (!team.fielding[pitcherId]) team.fielding[pitcherId] = { ...createFieldingLine(pitcherId) };
}

function ensureFielder(team, playerId) {
  if (!playerId) return;
  if (!team.fielding[playerId]) team.fielding[playerId] = { ...createFieldingLine(playerId) };
}

/** Apply immutable official stat events to the game box score. */
function applyStatEvents(boxScore, events) {
  if (!boxScore || typeof boxScore !== "object") throw new TypeError("boxScore가 필요합니다.");
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return boxScore;

  const next = {
    ...boxScore,
    teams: {
      away: cloneTeam(boxScore.teams.away),
      home: cloneTeam(boxScore.teams.home)
    },
    lineScore: {
      away: { ...boxScore.lineScore.away },
      home: { ...boxScore.lineScore.home }
    }
  };

  for (const event of list) {
    if (!event || !["PA_STAT", "RUNNER_STAT"].includes(event.type)) {
      throw new RangeError("PA_STAT 또는 RUNNER_STAT 이벤트만 적용할 수 있습니다.");
    }
    if (event.gameId !== boxScore.gameId) throw new RangeError("다른 경기의 stat event입니다.");

    const offense = next.teams[event.battingTeam];
    const defense = next.teams[event.fieldingTeam];

    if (event.type === "RUNNER_STAT") {
      if (!offense.batting[event.runnerId]) offense.batting[event.runnerId] = { ...createBattingLine(event.runnerId) };
      const runnerLine = offense.batting[event.runnerId];
      offense.batting[event.runnerId] = incrementLine(runnerLine, event.batting, BATTING_FIELDS);
      ensurePitcher(defense, event.pitcherId);
      defense.pitching[event.pitcherId] = incrementLine(defense.pitching[event.pitcherId], event.pitching, PITCHING_FIELDS);
      for (const delta of event.fielding ?? []) {
        ensureFielder(defense, delta.playerId);
        defense.fielding[delta.playerId] = incrementLine(defense.fielding[delta.playerId], delta, FIELDING_FIELDS);
      }
      continue;
    }

    if (!offense.batting[event.batterId]) offense.batting[event.batterId] = { ...createBattingLine(event.batterId) };
    const batterLine = offense.batting[event.batterId];

    offense.batting[event.batterId] = incrementLine(batterLine, event.batting, BATTING_FIELDS);
    ensurePitcher(defense, event.pitcherId);
    defense.pitching[event.pitcherId] = incrementLine(defense.pitching[event.pitcherId], event.pitching, PITCHING_FIELDS);
    for (const delta of event.fielding ?? []) {
      ensureFielder(defense, delta.playerId);
      defense.fielding[delta.playerId] = incrementLine(defense.fielding[delta.playerId], delta, FIELDING_FIELDS);
    }

    for (const runnerId of event.scoredRunnerIds) {
      if (event.outcome === "HR" && runnerId === event.batterId) continue;
      if (!offense.batting[runnerId]) offense.batting[runnerId] = { ...createBattingLine(runnerId) };
      const runnerLine = offense.batting[runnerId];
      offense.batting[runnerId] = { ...runnerLine, R: runnerLine.R + 1 };
    }

    const runs = event.scoredRunnerIds.length;
    const inningKey = String(event.inning);
    next.lineScore[event.battingTeam][inningKey] = (next.lineScore[event.battingTeam][inningKey] ?? 0) + runs;
  }

  return freezeBoxScore(next);
}


/** Register a position-player appearance even if the substitute records 0 PA. */
function registerPositionPlayerAppearance(boxScore, teamKey, playerId) {
  if (!boxScore || typeof boxScore !== "object") throw new TypeError("boxScore가 필요합니다.");
  if (teamKey !== "away" && teamKey !== "home") throw new RangeError("teamKey는 away/home이어야 합니다.");
  if (typeof playerId !== "string" || !playerId) throw new TypeError("playerId가 필요합니다.");
  if (boxScore.teams?.[teamKey]?.batting?.[playerId] && boxScore.teams?.[teamKey]?.fielding?.[playerId]) return boxScore;
  const next = {
    ...boxScore,
    teams: {
      away: cloneTeam(boxScore.teams.away),
      home: cloneTeam(boxScore.teams.home)
    },
    lineScore: { away: { ...boxScore.lineScore.away }, home: { ...boxScore.lineScore.home } }
  };
  const team = next.teams[teamKey];
  if (!team.batting[playerId]) team.batting[playerId] = { ...createBattingLine(playerId) };
  if (!team.fielding[playerId]) team.fielding[playerId] = { ...createFieldingLine(playerId) };
  return freezeBoxScore(next);
}

function sumBattingTeam(teamBox) {
  const total = zeroLine(BATTING_FIELDS);
  for (const line of Object.values(teamBox.batting)) {
    for (const field of BATTING_FIELDS) total[field] += line[field];
  }
  return Object.freeze(total);
}

function sumPitchingTeam(teamBox) {
  const total = zeroLine(PITCHING_FIELDS);
  for (const line of Object.values(teamBox.pitching)) {
    for (const field of PITCHING_FIELDS) total[field] += line[field];
  }
  return Object.freeze(total);
}

function sumFieldingTeam(teamBox) {
  const total = zeroLine(FIELDING_FIELDS);
  for (const line of Object.values(teamBox.fielding ?? {})) {
    for (const field of FIELDING_FIELDS) total[field] += line[field];
  }
  return Object.freeze(total);
}

function deriveBattingRates(line) {
  const avg = line.AB > 0 ? line.H / line.AB : 0;
  const obpDenominator = line.AB + line.BB + line.HBP + line.SF;
  const obp = obpDenominator > 0 ? (line.H + line.BB + line.HBP) / obpDenominator : 0;
  const slg = line.AB > 0 ? line.TB / line.AB : 0;
  return Object.freeze({ AVG: avg, OBP: obp, SLG: slg, OPS: obp + slg });
}

export { createBattingLine, createPitchingLine, createFieldingLine, createBoxScore, applyStatEvents, registerPositionPlayerAppearance, sumBattingTeam, sumPitchingTeam, sumFieldingTeam, deriveBattingRates };
