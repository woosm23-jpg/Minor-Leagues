import { getSeasonEffectivePlayer } from "./playerSeasonState.js";
import { rolePriority } from "./roleSystem.js";
import { canUtilityCover, utilityFamiliarity } from "./utilityUsage.js";

const EPSILON = 1e-9;
const MIN_ASSIGNMENT_GAIN = 1.5;

const POSITION_LOAD = Object.freeze({
  C: 1.00,
  SS: 0.82,
  CF: 0.82,
  "2B": 0.62,
  "3B": 0.58,
  RF: 0.52,
  LF: 0.48,
  "1B": 0.36,
  DH: 0.05
});

const DEFENSE_WEIGHTS = Object.freeze({
  C: Object.freeze({ fielding: 0.30, reaction: 0.25, speed: 0.00, armStrength: 0.23, armAccuracy: 0.22 }),
  "1B": Object.freeze({ fielding: 0.42, reaction: 0.30, speed: 0.05, armStrength: 0.08, armAccuracy: 0.15 }),
  "2B": Object.freeze({ fielding: 0.30, reaction: 0.30, speed: 0.18, armStrength: 0.07, armAccuracy: 0.15 }),
  "3B": Object.freeze({ fielding: 0.27, reaction: 0.26, speed: 0.07, armStrength: 0.22, armAccuracy: 0.18 }),
  SS: Object.freeze({ fielding: 0.27, reaction: 0.30, speed: 0.18, armStrength: 0.10, armAccuracy: 0.15 }),
  LF: Object.freeze({ fielding: 0.28, reaction: 0.24, speed: 0.25, armStrength: 0.11, armAccuracy: 0.12 }),
  CF: Object.freeze({ fielding: 0.25, reaction: 0.29, speed: 0.29, armStrength: 0.08, armAccuracy: 0.09 }),
  RF: Object.freeze({ fielding: 0.25, reaction: 0.23, speed: 0.20, armStrength: 0.19, armAccuracy: 0.13 })
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function baselinePositionByPlayer(slots) {
  return Object.fromEntries(slots.map((slot) => [slot.playerId, slot.position]));
}

function canAssign(roster, playerStates, roleStates, playerId, position, baselinePosition) {
  if (position === baselinePosition) return true;
  return canUtilityCover(roster, playerStates, roleStates, playerId, position);
}

function defensiveSkill(player, position) {
  if (position === "DH") return 50;
  const weights = DEFENSE_WEIGHTS[position];
  if (!weights) return 50;
  const fielding = player?.fielding ?? {};
  const running = player?.running ?? {};
  const values = {
    fielding: Number(fielding.fielding ?? 50),
    reaction: Number(fielding.reaction ?? 50),
    speed: Number(running.speed ?? 50),
    armStrength: Number(fielding.armStrength ?? 50),
    armAccuracy: Number(fielding.armAccuracy ?? 50)
  };
  return Object.entries(weights).reduce((sum, [key, weight]) => sum + values[key] * weight, 0);
}

function assignmentScore({ roster, playerStates, roleStates, playerId, position, baselinePosition }) {
  const basePlayer = roster?.players?.[playerId];
  if (!basePlayer) return -Infinity;
  const state = playerStates?.[playerId] ?? null;
  const player = getSeasonEffectivePlayer(basePlayer, state);
  const familiarity = position === "DH" ? 1 : clamp(utilityFamiliarity(roster, playerStates, playerId, position), 0, 1);
  const skill = defensiveSkill(player, position);
  const familiarityMultiplier = 0.60 + familiarity * 0.40;
  const fatigue = clamp(Number(state?.fatigue ?? 0), 0, 100);
  const fatiguePenalty = (fatigue / 100) * 3.2 * (POSITION_LOAD[position] ?? 0.5);
  const role = roleStates?.[playerId]?.role ?? null;
  const stabilityBonus = position === baselinePosition ? 0.8 + rolePriority(role) * 0.8 : 0;
  return skill * familiarityMultiplier - fatiguePenalty + stabilityBonus;
}

function signature(assignments, positions) {
  return positions.map((position) => `${position}:${assignments[position] ?? ""}`).join("|");
}

function better(candidate, current, positions) {
  if (!current) return true;
  if (candidate.score > current.score + EPSILON) return true;
  if (candidate.score < current.score - EPSILON) return false;
  return signature(candidate.assignments, positions) < signature(current.assignments, positions);
}

/**
 * Small deterministic assignment optimizer for an already-selected starting nine.
 *
 * It never adds/removes a hitter from the lineup and never changes batting order.
 * The existing placement is always legal. Alternative placements are available
 * only through the same authoritative utility/secondary-position coverage rules
 * already used by daily lineup construction. A stability preference plus a
 * minimum gain prevents healthy regulars from being shuffled for tiny edges.
 */
function optimizePositionAssignments({ roster, slots, playerStates = {}, roleStates = {} }) {
  if (!Array.isArray(slots) || slots.length === 0) {
    return freeze({ applied: false, assignments: {}, changes: [] });
  }
  const positions = slots.map((slot) => slot.position);
  const players = slots.map((slot) => slot.playerId);
  if (new Set(positions).size !== positions.length || new Set(players).size !== players.length) {
    throw new RangeError("position assignment에는 중복 없는 position/player가 필요합니다.");
  }

  const baselineByPlayer = baselinePositionByPlayer(slots);
  const baselineAssignments = Object.fromEntries(slots.map((slot) => [slot.position, slot.playerId]));
  const scoreFor = (playerId, position) => assignmentScore({
    roster,
    playerStates,
    roleStates,
    playerId,
    position,
    baselinePosition: baselineByPlayer[playerId]
  });
  const baselineScore = positions.reduce((sum, position) => sum + scoreFor(baselineAssignments[position], position), 0);

  const candidates = positions.map((position) => players
    .filter((playerId) => canAssign(roster, playerStates, roleStates, playerId, position, baselineByPlayer[playerId]))
    .sort((a, b) => a.localeCompare(b)));

  // Memoized bitmask assignment search. Nine positions => at most 2^9 states.
  const memo = new Map();
  function solve(positionIndex, usedMask) {
    if (positionIndex >= positions.length) return { score: 0, assignments: {} };
    const key = `${positionIndex}:${usedMask}`;
    if (memo.has(key)) return memo.get(key);
    const position = positions[positionIndex];
    let best = null;
    for (const playerId of candidates[positionIndex]) {
      const playerIndex = players.indexOf(playerId);
      const bit = 1 << playerIndex;
      if ((usedMask & bit) !== 0) continue;
      const tail = solve(positionIndex + 1, usedMask | bit);
      if (!tail) continue;
      const candidate = {
        score: scoreFor(playerId, position) + tail.score,
        assignments: { [position]: playerId, ...tail.assignments }
      };
      if (better(candidate, best, positions.slice(positionIndex))) best = candidate;
    }
    memo.set(key, best);
    return best;
  }

  const optimized = solve(0, 0);
  const gain = optimized ? optimized.score - baselineScore : 0;
  if (!optimized || gain < MIN_ASSIGNMENT_GAIN) {
    return freeze({ applied: false, assignments: baselineAssignments, changes: [] });
  }

  const optimizedPositionByPlayer = Object.fromEntries(Object.entries(optimized.assignments).map(([position, playerId]) => [playerId, position]));
  const changes = players
    .map((playerId) => ({ playerId, fromPosition: baselineByPlayer[playerId], toPosition: optimizedPositionByPlayer[playerId] }))
    .filter((row) => row.fromPosition !== row.toPosition)
    .sort((a, b) => a.playerId.localeCompare(b.playerId));

  if (changes.length === 0) return freeze({ applied: false, assignments: baselineAssignments, changes: [] });
  return freeze({ applied: true, assignments: optimized.assignments, changes });
}

export { optimizePositionAssignments };
