const PREFERENCES = new Set(["OPEN", "EVERYDAY", "VERSATILE"]);
const VERSATILE_ROLES = new Set(["UTILITY", "ROTATION"]);
const EVERYDAY_ROLES = new Set(["STARTER", "AAA_STARTER"]);
const MAX_LINEUP_NUDGE = 0.35;

function validatePlayerRolePreference(value, label = "rolePreference") {
  if (value == null) return true; // Saves from earlier builds have no preference.
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PREFERENCES.has(value.mode) ||
      typeof value.requestedDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.requestedDate)) {
    throw new RangeError(`${label} 역할 선호 데이터가 잘못되었습니다.`);
  }
  return true;
}

function setPlayerRolePreference(state, mode, date) {
  if (!state?.playerId || !PREFERENCES.has(mode) ||
      typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError("역할 선호 선택이 잘못되었습니다.");
  }
  if ((state.rolePreference?.mode ?? "OPEN") === mode) return state;
  return Object.freeze({ ...state,
    rolePreference: Object.freeze({ mode, requestedDate: date }) });
}

// Only a marginal lineup consideration, not a rating, injury, role or promotion
// modifier. A player must already have the relevant manager-assigned role.
function rolePreferenceLineupBonus({ preference = null, role = null,
  baselineStarter = false, position = null, primaryPosition = null,
  coverageEligible = false } = {}) {
  const mode = preference?.mode ?? "OPEN";
  if (mode === "EVERYDAY" && baselineStarter && EVERYDAY_ROLES.has(role)) {
    return MAX_LINEUP_NUDGE;
  }
  if (mode === "VERSATILE" && !baselineStarter && VERSATILE_ROLES.has(role) &&
      position && position !== primaryPosition && coverageEligible) {
    return MAX_LINEUP_NUDGE;
  }
  return 0;
}

// This is an observed match between the preference, actual role and completed
// playing time. It is NOT a promise or a hidden organizational decision score.
function getRolePreferenceView(state, roleState = null, playingTime = null) {
  const raw = state?.rolePreference ?? null;
  validatePlayerRolePreference(raw);
  const mode = raw?.mode ?? "OPEN";
  const role = roleState?.role ?? null;
  const games = Math.max(0, Number(playingTime?.gamesPlayed ?? 0));
  const secondaryGames = Math.max(0, Number(playingTime?.secondaryGames ?? 0));
  let fitBand = "OPEN";
  let reasonCode = "NO_REQUEST";
  if (mode === "EVERYDAY") {
    if (EVERYDAY_ROLES.has(role) && games >= 4) {
      fitBand = "ALIGNED"; reasonCode = "EVERYDAY_ROLE_AND_GAMES";
    } else if (games < 4) {
      fitBand = "EVALUATING"; reasonCode = "PLAYING_TIME_SAMPLE";
    } else {
      fitBand = "NOT_YET"; reasonCode = "MANAGER_ROLE_DIFFERENT";
    }
  } else if (mode === "VERSATILE") {
    if (VERSATILE_ROLES.has(role) && secondaryGames >= 2) {
      fitBand = "ALIGNED"; reasonCode = "VERSATILE_ROLE_AND_REPS";
    } else if (games < 4) {
      fitBand = "EVALUATING"; reasonCode = "PLAYING_TIME_SAMPLE";
    } else {
      fitBand = "NOT_YET"; reasonCode = "VERSATILITY_NOT_ESTABLISHED";
    }
  }
  return Object.freeze({ mode, requestedDate: raw?.requestedDate ?? null,
    fitBand, reasonCode, effect: "MARGINAL_ROLE_ALIGNED_LINEUP_CONSIDERATION",
    managerControlsRole: true });
}

export { PREFERENCES, MAX_LINEUP_NUDGE, validatePlayerRolePreference,
  setPlayerRolePreference, rolePreferenceLineupBonus, getRolePreferenceView };
