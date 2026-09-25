// Validate archival invariants without altering saved history or awarding prizes.
function auditSeasonHistoryEntry(entry) {
  if (!entry || !Number.isInteger(entry.seasonYear) || !entry.awards || !entry.user) {
    throw new TypeError('시즌 역사 감사에 연도·수상·사용자 기록이 필요합니다.');
  }
  const leagues = Object.values(entry.awards.leagues ?? {});
  const awardIds = new Set();
  const add = (label, winner) => {
    if (!winner) return;
    if (typeof winner.playerId !== 'string' || !winner.playerId) throw new RangeError(`수상 선수 ID 누락: ${label}`);
    const key = `${label}:${winner.playerId}`;
    if (awardIds.has(key)) throw new RangeError(`수상 중복: ${key}`);
    awardIds.add(key);
  };
  for (const [leagueId, league] of Object.entries(entry.awards.leagues ?? {})) {
    add(`${leagueId}:MVP`, league.mvp);
    add(`${leagueId}:CY_YOUNG`, league.cyYoung);
    const positions = new Set();
    for (const winner of league.silverSlugger ?? []) {
      if (positions.has(winner.position)) throw new RangeError(`실버슬러거 포지션 중복: ${leagueId}:${winner.position}`);
      positions.add(winner.position);
      add(`${leagueId}:SS:${winner.position}`, winner);
    }
    if (league.goldGlove?.length && entry.awards.methodology?.goldGlove === 'DEFERRED_FIELDING_EVENT_TOTALS_REQUIRED') {
      throw new RangeError('수비 기록 미확인 시즌에는 골드글러브를 생성할 수 없습니다.');
    }
  }
  add('WORLD_SERIES_MVP', entry.awards.worldSeriesMvp);
  if (entry.awards.worldSeriesMvp && String(entry.awards.worldSeriesMvp.teamId) !== String(entry.championTeamId)) {
    throw new RangeError('월드시리즈 MVP가 우승팀에 속하지 않습니다.');
  }
  const user = entry.user;
  if (!['NONE', 'ORG_CHAMPION_NO_ROSTER', 'ROSTER_CHAMPION'].includes(user.championshipStatus)) {
    throw new RangeError('사용자 우승 이력 구분이 잘못되었습니다.');
  }
  if (user.championshipStatus === 'ROSTER_CHAMPION' && (!user.postseasonRoster || Number(user.postseasonAppearances ?? 0) <= 0)) {
    throw new RangeError('포스트시즌에 실제 참가하지 않은 선수를 선수단 우승으로 기록할 수 없습니다.');
  }
  if (!user.regularSeason || !user.postseason || user.regularSeason === user.postseason) {
    throw new RangeError('정규·포스트시즌 기록은 각각 별도로 보존해야 합니다.');
  }
  if (new Set(user.awards ?? []).size !== (user.awards ?? []).length) {
    throw new RangeError('사용자 중복 수상이 있습니다.');
  }
  return Object.freeze({ seasonYear: entry.seasonYear, pass: true, leaguesAudited: leagues.length,
    awardEntries: awardIds.size, regularAndPostseasonSeparate: true, noDuplicateAwardPositions: true,
    championshipParticipationDistinguished: true,
    goldGloveDeferred: entry.awards.methodology?.goldGlove === 'DEFERRED_FIELDING_EVENT_TOTALS_REQUIRED' });
}
export { auditSeasonHistoryEntry };
