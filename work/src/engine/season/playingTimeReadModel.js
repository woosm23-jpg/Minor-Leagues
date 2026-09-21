const ROLE_UTILITY_FAMILY = new Set(["UTILITY", "ROTATION"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clampShare(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundShare(value) {
  return Number(clampShare(value).toFixed(3));
}

function normalizedReps(state) {
  const reps = {};
  for (const [position, raw] of Object.entries(state?.positionReps ?? {})) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    reps[position] = Math.max(0, Math.floor(value));
  }
  return reps;
}

function usageBand({ gamesPlayed, primaryGames, secondaryGames, dhGames }) {
  if (gamesPlayed <= 0) return "NO_SAMPLE";
  if (secondaryGames >= 3 && secondaryGames / gamesPlayed >= 0.25) return "MULTI_POSITION";
  if (secondaryGames > 0) return "SECONDARY_USED";
  if (dhGames > primaryGames) return "DH_HEAVY";
  return "PRIMARY_HEAVY";
}

function roleUsageBand(role, secondaryGames) {
  if (!ROLE_UTILITY_FAMILY.has(role)) return secondaryGames > 0 ? "VERSATILITY_USED" : "PRIMARY_TRACK";
  if (secondaryGames >= 3) return "UTILITY_ACTIVE";
  if (secondaryGames > 0) return "UTILITY_EMERGING";
  return "UTILITY_PENDING";
}

/**
 * Read-only playing-time model derived entirely from authoritative season state.
 * It never changes lineup, role, promotion, or game simulation decisions.
 */
function getPositionPlayingTimeView(state, roleState = null) {
  if (!state) return null;
  const gamesPlayed = Math.max(0, Math.floor(Number(state.gamesPlayed ?? 0)));
  const primaryPosition = state.primaryPosition ?? "DH";
  const reps = normalizedReps(state);
  const fieldGames = Object.values(reps).reduce((sum, value) => sum + value, 0);
  const dhGames = Math.max(0, gamesPlayed - fieldGames);
  const primaryGames = primaryPosition === "DH" ? dhGames : Number(reps[primaryPosition] ?? 0);
  const secondaryGames = Object.entries(reps).reduce((sum, [position, games]) => sum + (position === primaryPosition ? 0 : games), 0);
  const positions = new Set([primaryPosition, ...Object.keys(state.positionFamiliarity ?? {}), ...Object.keys(reps)]);
  if (dhGames > 0 || primaryPosition === "DH") positions.add("DH");

  const rows = [...positions].map((position) => {
    const games = position === "DH" ? dhGames : Number(reps[position] ?? 0);
    const type = position === primaryPosition ? "PRIMARY" : position === "DH" ? "DH" : "SECONDARY";
    return freeze({ position, type, games, share: gamesPlayed > 0 ? roundShare(games / gamesPlayed) : 0 });
  }).sort((a, b) => b.games - a.games || (a.type === "PRIMARY" ? -1 : b.type === "PRIMARY" ? 1 : a.position.localeCompare(b.position)));

  const role = roleState?.role ?? null;
  return freeze({
    gamesPlayed,
    primaryPosition,
    primaryGames,
    secondaryGames,
    dhGames,
    utilityGames: secondaryGames,
    primaryShare: gamesPlayed > 0 ? roundShare(primaryGames / gamesPlayed) : 0,
    secondaryShare: gamesPlayed > 0 ? roundShare(secondaryGames / gamesPlayed) : 0,
    dhShare: gamesPlayed > 0 ? roundShare(dhGames / gamesPlayed) : 0,
    usageBand: usageBand({ gamesPlayed, primaryGames, secondaryGames, dhGames }),
    roleUsageBand: roleUsageBand(role, secondaryGames),
    positions: freeze(rows)
  });
}

export { getPositionPlayingTimeView };
