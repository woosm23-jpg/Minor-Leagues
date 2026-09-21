const POSITION_PLAYER_ROLES = Object.freeze([
  "STARTER",
  "PLATOON",
  "ROTATION",
  "BENCH",
  "UTILITY",
  "CALL_UP_DEPTH",
  "AAA_STARTER"
]);

const ROLE_PRIORITY = Object.freeze({
  STARTER: 1.00,
  AAA_STARTER: 0.98,
  PLATOON: 0.84,
  ROTATION: 0.74,
  UTILITY: 0.64,
  BENCH: 0.54,
  CALL_UP_DEPTH: 0.46
});

const REVIEW_CADENCE_DAYS = 7;
const MAX_RECENT_FEEDBACK = 12;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso || fromIso === toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  return Number.isFinite(days) ? days : 0;
}

function roleFromBench(bench, level) {
  const coverage = [...(bench?.coverage ?? [])];
  if (coverage.length >= 4 && coverage.includes("DH")) return level === "AAA" ? "CALL_UP_DEPTH" : "PLATOON";
  if (coverage.includes("SS") && coverage.includes("2B") && coverage.includes("3B")) return "UTILITY";
  if (coverage.includes("LF") && coverage.includes("CF") && coverage.includes("RF")) return "ROTATION";
  return "BENCH";
}

function defaultRoleForRosterPlayer(roster, playerId, level = "AAA") {
  if (roster?.lineupSlots?.some((slot) => slot.starterId === playerId)) return level === "AAA" ? "AAA_STARTER" : "STARTER";
  const bench = roster?.bench?.find((row) => row.playerId === playerId) ?? null;
  if (bench) return roleFromBench(bench, level);
  return level === "AAA" ? "CALL_UP_DEPTH" : "BENCH";
}

function roleState(playerId, level, role, startDate) {
  return freeze({
    playerId,
    level,
    role,
    momentum: 0,
    recentFeedback: [],
    gamesTracked: 0,
    gamesSinceReview: 0,
    roleSinceDate: startDate,
    levelSinceDate: startDate,
    lastReviewDate: startDate,
    lastGameDate: null,
    reviews: 0
  });
}

function createOrganizationRoleStates(fixture, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const states = {};
  for (const roster of Object.values(fixture?.rosters ?? {})) {
    for (const playerId of roster.positionPlayers ?? []) {
      states[playerId] = roleState(playerId, "AAA", defaultRoleForRosterPlayer(roster, playerId, "AAA"), startDate);
    }
  }
  const organization = fixture?.organization;
  for (const level of organization?.levelOrder ?? []) {
    const roster = organization.levels?.[level]?.roster;
    if (!roster) continue;
    for (const playerId of roster.positionPlayers ?? []) {
      if (states[playerId]) continue;
      states[playerId] = roleState(playerId, level, defaultRoleForRosterPlayer(roster, playerId, level), startDate);
    }
  }
  return freeze(states);
}

function singleGameFeedback(line) {
  const pa = Number(line?.PA ?? 0);
  if (pa <= 0) return 0;
  const h = Number(line?.H ?? 0);
  const doubles = Number(line?.doubles ?? 0);
  const triples = Number(line?.triples ?? 0);
  const hr = Number(line?.HR ?? 0);
  const bb = Number(line?.BB ?? 0);
  const hbp = Number(line?.HBP ?? 0);
  const so = Number(line?.SO ?? 0);
  const singles = Math.max(0, h - doubles - triples - hr);
  const weighted = singles + doubles * 1.45 + triples * 1.9 + hr * 2.35 + (bb + hbp) * 0.7 - so * 0.1;
  return clamp((weighted / pa - 0.34) / 0.58, -1, 1);
}

function ladder(level) {
  if (level === "AAA") return ["CALL_UP_DEPTH", "BENCH", "UTILITY", "ROTATION", "PLATOON", "AAA_STARTER"];
  return ["BENCH", "UTILITY", "ROTATION", "PLATOON", "STARTER"];
}

function stepRole(role, level, direction) {
  const list = ladder(level);
  const index = Math.max(0, list.indexOf(role));
  const nextIndex = clamp(index + direction, 0, list.length - 1);
  return list[nextIndex] ?? role;
}

function applyRoleGame(state, { battingLine, date = null } = {}) {
  if (!state || !POSITION_PLAYER_ROLES.includes(state.role)) throw new TypeError("유효한 position-player role state가 필요합니다.");
  const feedback = singleGameFeedback(battingLine);
  const recentFeedback = [...(state.recentFeedback ?? []), feedback].slice(-MAX_RECENT_FEEDBACK);
  const weighted = recentFeedback.reduce((sum, value, index) => sum + value * (index + 1), 0);
  const denominator = recentFeedback.reduce((sum, _value, index) => sum + index + 1, 0) || 1;
  const recentMean = weighted / denominator;
  const momentum = clamp(state.momentum * 0.82 + recentMean * 0.18, -1, 1);
  return freeze({
    ...state,
    momentum,
    recentFeedback,
    gamesTracked: state.gamesTracked + 1,
    gamesSinceReview: state.gamesSinceReview + 1,
    lastGameDate: date ?? state.lastGameDate
  });
}

function reviewRoleIfDue(state, { date, minimumGames = 4, cadenceDays = REVIEW_CADENCE_DAYS, roleFitDecision = null, enableRoleFitDecision = false } = {}) {
  if (!state || !POSITION_PLAYER_ROLES.includes(state.role)) throw new TypeError("유효한 position-player role state가 필요합니다.");
  if (!date) return state;
  const due = daysBetween(state.lastReviewDate, date) >= cadenceDays && state.gamesSinceReview >= minimumGames;
  if (!due) return state;

  let role = state.role;
  if (state.momentum >= 0.58) role = stepRole(role, state.level, 1);
  else if (state.momentum <= -0.58) role = stepRole(role, state.level, -1);
  else if (enableRoleFitDecision
    && roleFitDecision?.eligible === true
    && roleFitDecision?.direction === -1
    && Math.abs(Number(state.momentum ?? 0)) < 0.22
    && Number(state.reviews ?? 0) >= 1) role = stepRole(role, state.level, -1);

  return freeze({
    ...state,
    role,
    momentum: clamp(state.momentum * 0.62, -1, 1),
    gamesSinceReview: 0,
    lastReviewDate: date,
    roleSinceDate: role === state.role ? state.roleSinceDate : date,
    reviews: state.reviews + 1
  });
}

function rolePriority(role) {
  return ROLE_PRIORITY[role] ?? 0.5;
}

function roleMomentumBand(momentum) {
  const value = Number(momentum ?? 0);
  if (value >= 0.22) return "RISING";
  if (value <= -0.22) return "FALLING";
  return "STEADY";
}

function getRolePublicView(state, { currentDate = null } = {}) {
  if (!state) return null;
  const elapsed = currentDate ? Math.max(0, daysBetween(state.lastReviewDate, currentDate)) : 0;
  return freeze({
    role: state.role,
    level: state.level,
    momentumBand: roleMomentumBand(state.momentum),
    gamesTracked: state.gamesTracked,
    reviews: state.reviews,
    daysInRole: currentDate ? Math.max(0, daysBetween(state.roleSinceDate, currentDate)) : 0,
    reviewDueInDays: Math.max(0, REVIEW_CADENCE_DAYS - elapsed)
  });
}

function normalizeRoleStates(roleStates, fixture, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const defaults = createOrganizationRoleStates(fixture, { startDate });
  if (!roleStates || typeof roleStates !== "object") return defaults;
  const next = { ...defaults };
  for (const [playerId, state] of Object.entries(roleStates)) {
    if (!defaults[playerId]) continue;
    if (!state || !POSITION_PLAYER_ROLES.includes(state.role)) continue;
    next[playerId] = freeze({ ...defaults[playerId], ...state, playerId, level: state.level ?? defaults[playerId].level });
  }
  return freeze(next);
}

export { POSITION_PLAYER_ROLES, defaultRoleForRosterPlayer, createOrganizationRoleStates, applyRoleGame, reviewRoleIfDue, rolePriority, roleMomentumBand, getRolePublicView, normalizeRoleStates };
