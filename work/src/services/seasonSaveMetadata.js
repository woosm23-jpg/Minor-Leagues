function userPlayerName(payload, playerId, fallbackRoster) {
  if (fallbackRoster?.names?.[playerId]) return fallbackRoster.names[playerId];
  for (const level of payload.fixture.organization?.levelOrder ?? []) {
    const name = payload.fixture.organization?.levels?.[level]?.roster?.names?.[playerId];
    if (name) return name;
  }
  return playerId ?? "선수";
}

function teamGames(payload, teamId) {
  return payload.season.schedule.filter((game) => game.awayTeamId === teamId || game.homeTeamId === teamId);
}

function buildSeasonSaveMetadata(payload, { saveId, label, updatedAt, extra = {} } = {}) {
  const level = payload.fixture.organization?.userLevel ?? "AAA";
  const season = payload.levelSeasons?.[level] ?? payload.season;
  const teamId = payload.fixture.levelLeagues?.[level]?.userTeamId ?? payload.fixture.userTeamId;
  const playerId = payload.fixture.userPlayerId;
  const roster = payload.fixture.levelLeagues?.[level]?.rosters?.[teamId] ?? payload.fixture.rosters?.[teamId];
  const team = season.teams?.[teamId] ?? null;
  const standings = season.standings?.[teamId] ?? { W: 0, L: 0 };
  const schedule = season.schedule.filter((game) => game.awayTeamId === teamId || game.homeTeamId === teamId);
  const gamesPlayed = schedule.filter((game) => game.status === "FINAL").length;
  return {
    saveId,
    seasonId: payload.seasonId,
    label,
    updatedAt,
    schemaVersion: payload.schemaVersion,
    gameVersion: payload.gameVersion,
    currentDate: payload.season.currentDate,
    status: Object.values(payload.levelSeasons ?? { AAA: payload.season }).every((row) => row.status === "COMPLETE") ? "COMPLETE" : "REGULAR_SEASON",
    currentLevel: level,
    hasActiveGame: Boolean(payload.activeGameCheckpoint),
    userPlayerName: userPlayerName(payload, playerId, roster),
    userTeamName: team?.name ?? teamId ?? "팀",
    userTeamShortName: team?.shortName ?? teamId ?? "",
    wins: Number(standings.W ?? 0),
    losses: Number(standings.L ?? 0),
    gamesPlayed,
    totalGames: schedule.length,
    ...extra
  };
}

export { buildSeasonSaveMetadata };
