const UTILITY_FAMILIARITY_THRESHOLD = 0.65;
const UTILITY_ROLES = new Set(["UTILITY", "ROTATION"]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function playerProfile(roster, playerId, playerStates = {}) {
  const player = roster?.players?.[playerId] ?? null;
  const state = playerStates?.[playerId] ?? null;
  const primaryPosition = state?.primaryPosition ?? player?.positioning?.primaryPosition ?? null;
  const familiarity = { ...(player?.positioning?.familiarity ?? {}), ...(state?.positionFamiliarity ?? {}) };
  const reps = { ...(state?.positionReps ?? {}) };
  return { player, state, primaryPosition, familiarity, reps };
}

/**
 * Return positions a player may cover in today's lineup construction.
 * Static roster coverage is always authoritative. Dynamic secondary coverage
 * requires enough familiarity plus either a persistent utility/rotation role
 * or at least one real game rep at that position. This prevents an untouched
 * secondary rating from silently rewriting stable lineups.
 */
function getUtilityCoverage(roster, playerStates = {}, roleStates = {}, playerId) {
  const bench = roster?.bench?.find((row) => row.playerId === playerId) ?? null;
  const staticCoverage = [...(bench?.coverage ?? [])];
  const { primaryPosition, familiarity, reps } = playerProfile(roster, playerId, playerStates);
  const role = roleStates?.[playerId]?.role ?? null;
  const roleEligible = UTILITY_ROLES.has(role);
  const dynamic = [];

  if (primaryPosition) dynamic.push(primaryPosition);
  for (const [position, rawValue] of Object.entries(familiarity)) {
    if (position === "P") continue;
    const value = Number(rawValue ?? 0);
    if (position === primaryPosition) {
      dynamic.push(position);
      continue;
    }
    if (value < UTILITY_FAMILIARITY_THRESHOLD) continue;
    if (roleEligible || Number(reps?.[position] ?? 0) > 0 || staticCoverage.includes(position)) dynamic.push(position);
  }
  return Object.freeze(unique([...staticCoverage, ...dynamic]));
}

function canUtilityCover(roster, playerStates = {}, roleStates = {}, playerId, position) {
  if (!position) return false;
  if (position === "DH") {
    const bench = roster?.bench?.find((row) => row.playerId === playerId) ?? null;
    if (bench?.coverage?.includes("DH")) return true;
  }
  return getUtilityCoverage(roster, playerStates, roleStates, playerId).includes(position);
}

function utilityFamiliarity(roster, playerStates = {}, playerId, position) {
  if (position === "DH") return 1;
  const { primaryPosition, familiarity } = playerProfile(roster, playerId, playerStates);
  if (position === primaryPosition) return 1;
  return Number(familiarity?.[position] ?? 0);
}

function getUtilityPathwayView(roster, playerStates = {}, roleStates = {}, playerId) {
  const { primaryPosition, familiarity, reps } = playerProfile(roster, playerId, playerStates);
  const role = roleStates?.[playerId]?.role ?? null;
  const roleEligible = UTILITY_ROLES.has(role);
  const staticCoverage = new Set(roster?.bench?.find((row) => row.playerId === playerId)?.coverage ?? []);
  const positions = unique([primaryPosition, ...Object.keys(familiarity), ...staticCoverage]);
  return Object.freeze({
    roleEligible,
    positions: Object.freeze(positions.map((position) => {
      const value = position === primaryPosition ? 1 : Number(familiarity?.[position] ?? (position === "DH" && staticCoverage.has("DH") ? 1 : 0));
      const gameReps = Number(reps?.[position] ?? 0);
      const eligible = position === primaryPosition || staticCoverage.has(position) || (value >= UTILITY_FAMILIARITY_THRESHOLD && (roleEligible || gameReps > 0));
      return Object.freeze({ position, familiarity: Number(value.toFixed(3)), reps: gameReps, status: position === primaryPosition ? "PRIMARY" : eligible ? "READY" : value >= 0.5 ? "DEVELOPING" : "LIMITED" });
    }))
  });
}

export { UTILITY_FAMILIARITY_THRESHOLD, getUtilityCoverage, canUtilityCover, utilityFamiliarity, getUtilityPathwayView };
