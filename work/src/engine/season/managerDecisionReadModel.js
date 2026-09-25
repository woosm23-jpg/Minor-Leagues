const REASON_CODES = new Set([
  "STARTING_LINEUP", "PLAYER_REQUEST_APPROVED", "INJURY_UNAVAILABLE",
  "FATIGUE_REST", "COMPETITION_DIRECT", "UTILITY_COVER",
  "BENCH_ROLE", "OTHER_LINEUP_DECISION"
]);
const APPEARANCES = new Set(["STARTED", "BENCH_PA", "NOT_STARTED"]);
const LEVELS = new Set(["A", "HIGH_A", "AA", "AAA", "MLB"]);

// Read the lineup that the manager actually selected. Never infer a decision
// from the user's desired role or secretly change the lineup or results.
function completedUserManagerDecision({ fixture, game, level, userTeamId,
  userPlayerId, battingBySide = {} } = {}) {
  if (!fixture?.players?.[userPlayerId] || !game?.gameId || !LEVELS.has(level)) return null;
  const side = fixture.teams?.away?.id === userTeamId ? "away"
    : fixture.teams?.home?.id === userTeamId ? "home" : null;
  if (!side) return null;
  const plan = fixture.dailyLineups?.[side];
  if (!plan) return null;
  const started = (plan.lineup ?? []).includes(userPlayerId);
  const pa = Number(battingBySide?.[side]?.[userPlayerId]?.PA ?? 0);
  const appearance = started ? "STARTED" : pa > 0 ? "BENCH_PA" : "NOT_STARTED";
  const replacement = (plan.replacements ?? []).find(row => row.forPlayerId === userPlayerId) ?? null;
  let reasonCode = "OTHER_LINEUP_DECISION";
  if (started) reasonCode = "STARTING_LINEUP";
  else if (fixture.voluntaryRest?.approved === true &&
    (plan.voluntaryRest?.approved === true || replacement?.kind === "PLAYER_REST_REQUEST")) {
    reasonCode = "PLAYER_REQUEST_APPROVED";
  } else if ((plan.unavailable ?? []).includes(userPlayerId)) reasonCode = "INJURY_UNAVAILABLE";
  else if ((plan.rested ?? []).includes(userPlayerId)) reasonCode = "FATIGUE_REST";
  else if (replacement?.kind === "COMPETITION_DIRECT") reasonCode = "COMPETITION_DIRECT";
  else if (replacement?.kind === "UTILITY_BACKFILL") reasonCode = "UTILITY_COVER";
  else if ((plan.bench ?? []).some(row => row.playerId === userPlayerId)) reasonCode = "BENCH_ROLE";
  const decision = Object.freeze({ version: 1, date: game.date, gameId: game.gameId,
    level, appearance, reasonCode, replacementPlayerId: replacement?.playerId ?? null });
  validateUserManagerDecision(decision);
  return decision;
}

function validateUserManagerDecision(value, label = "lastManagerDecision") {
  if (value == null) return true; // Legacy saves did not record lineup reasons.
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
      typeof value.gameId !== "string" || !value.gameId || !LEVELS.has(value.level) ||
      !APPEARANCES.has(value.appearance) || !REASON_CODES.has(value.reasonCode) ||
      (value.replacementPlayerId !== null &&
        (typeof value.replacementPlayerId !== "string" || !value.replacementPlayerId))) {
    throw new RangeError(`${label} 경기 기용 판단 데이터가 잘못되었습니다.`);
  }
  return true;
}

function getUserManagerDecisionPublicView(value) {
  validateUserManagerDecision(value);
  return value ? Object.freeze({ ...value }) : null;
}

export { completedUserManagerDecision, validateUserManagerDecision,
  getUserManagerDecisionPublicView };
