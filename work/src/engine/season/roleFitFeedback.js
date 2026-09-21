const VERSATILITY_ROLES = new Set(["UTILITY", "ROTATION"]);
const FEEDBACK_MIN_GAMES = 6;
const FEEDBACK_MIN_DAYS = 7;
const DECISION_MIN_GAMES = 10;
const DECISION_MIN_DAYS = 14;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso || fromIso === toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function evaluate(roleState, playingTime, { currentDate = null } = {}) {
  const role = roleState?.role ?? null;
  const applicable = VERSATILITY_ROLES.has(role);
  if (!applicable) {
    return freeze({
      role,
      applicable: false,
      fitBand: "NOT_APPLICABLE",
      reasonCodes: ["PRIMARY_ROLE_TRACK"],
      gamesPlayed: Math.max(0, Number(playingTime?.gamesPlayed ?? 0)),
      secondaryGames: Math.max(0, Number(playingTime?.secondaryGames ?? 0)),
      daysInRole: currentDate ? daysBetween(roleState?.roleSinceDate, currentDate) : 0
    });
  }

  const gamesPlayed = Math.max(0, Math.floor(Number(playingTime?.gamesPlayed ?? 0)));
  const secondaryGames = Math.max(0, Math.floor(Number(playingTime?.secondaryGames ?? 0)));
  const secondaryShare = Math.max(0, Math.min(1, Number(playingTime?.secondaryShare ?? 0)));
  const daysInRole = currentDate ? daysBetween(roleState?.roleSinceDate, currentDate) : 0;

  if (secondaryGames >= 3 || (secondaryGames >= 2 && secondaryShare >= 0.25)) {
    return freeze({ role, applicable: true, fitBand: "ALIGNED", reasonCodes: ["MULTI_POSITION_USAGE_CONFIRMED"], gamesPlayed, secondaryGames, daysInRole });
  }
  if (secondaryGames > 0) {
    return freeze({ role, applicable: true, fitBand: "DEVELOPING", reasonCodes: ["SECONDARY_USAGE_STARTED"], gamesPlayed, secondaryGames, daysInRole });
  }
  if (gamesPlayed < FEEDBACK_MIN_GAMES || daysInRole < FEEDBACK_MIN_DAYS) {
    return freeze({ role, applicable: true, fitBand: "EVALUATING", reasonCodes: ["ROLE_USAGE_SAMPLE_BUILDING"], gamesPlayed, secondaryGames, daysInRole });
  }
  return freeze({ role, applicable: true, fitBand: "USAGE_GAP", reasonCodes: ["VERSATILITY_ROLE_NOT_REALIZED"], gamesPlayed, secondaryGames, daysInRole });
}

/**
 * Player-safe, qualitative Role Fit feedback. It is derived from the same
 * authoritative completed-game playing-time model used by v34 and contains no
 * hidden thresholds, score weights, or decision direction.
 */
function getRoleFitFeedback(roleState, playingTime, options = {}) {
  const result = evaluate(roleState, playingTime, options);
  return freeze({
    role: result.role,
    applicable: result.applicable,
    fitBand: result.fitBand,
    reasonCodes: [...result.reasonCodes]
  });
}

/**
 * Internal opt-in decision signal for forced regression only in v35.
 * The production season flow does not pass this signal to role review.
 */
function getRoleFitDecisionSignal(roleState, playingTime, options = {}) {
  const result = evaluate(roleState, playingTime, options);
  const eligible = result.applicable
    && result.fitBand === "USAGE_GAP"
    && result.gamesPlayed >= DECISION_MIN_GAMES
    && result.daysInRole >= DECISION_MIN_DAYS;
  return freeze({
    eligible,
    direction: eligible ? -1 : 0,
    reasonCode: eligible ? "SUSTAINED_ROLE_USAGE_GAP" : null
  });
}

export { getRoleFitFeedback, getRoleFitDecisionSignal };
