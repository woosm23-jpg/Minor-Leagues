function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function resetPositionStateForNewSeason(state) {
  if (!state?.playerId) throw new TypeError("position season state가 필요합니다.");
  return freeze({
    ...state,
    fatigue: 0,
    form: 0,
    recentForm: [],
    gamesPlayed: 0,
    lastGameDate: null,
    positionReps: Object.fromEntries(Object.keys(state.positionReps ?? {}).map((position) => [position, 0]))
  });
}

function resetPitcherStateForNewSeason(state) {
  if (!state?.playerId) throw new TypeError("pitcher season state가 필요합니다.");
  return freeze({
    ...state,
    fatigue: 0,
    appearances: 0,
    lastAppearanceDate: null,
    lastPitchCount: 0
  });
}

function resetRoleStateForNewSeason(state, startDate) {
  if (!state?.playerId) throw new TypeError("role state가 필요합니다.");
  if (typeof startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new TypeError("startDate가 필요합니다.");
  return freeze({
    ...state,
    momentum: 0,
    recentFeedback: [],
    gamesTracked: 0,
    gamesSinceReview: 0,
    lastReviewDate: startDate,
    lastGameDate: null
  });
}

function resetSeasonStatesForNewYear({ playerStates = {}, pitcherStates = {}, roleStates = {}, startDate } = {}) {
  return freeze({
    playerStates: Object.fromEntries(Object.entries(playerStates).map(([id, state]) => [id, resetPositionStateForNewSeason(state)])),
    pitcherStates: Object.fromEntries(Object.entries(pitcherStates).map(([id, state]) => [id, resetPitcherStateForNewSeason(state)])),
    roleStates: Object.fromEntries(Object.entries(roleStates).map(([id, state]) => [id, resetRoleStateForNewSeason(state, startDate)]))
  });
}

export { resetPositionStateForNewSeason, resetPitcherStateForNewSeason, resetRoleStateForNewSeason, resetSeasonStatesForNewYear };
