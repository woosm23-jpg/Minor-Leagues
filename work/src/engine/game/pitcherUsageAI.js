import { pitchingCalibration } from "../../config/pitchingCalibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";
import { calculatePitcherFatigue, resolvePitcherUsageRole } from "./pitcherFatigue.js";

function lookupFrom(players) {
  if (players instanceof Map) return (id) => players.get(id);
  if (players && typeof players === "object") return (id) => players[id];
  throw new TypeError("players는 Map 또는 ID-keyed object여야 합니다.");
}

function validatePlan(plan, team) {
  if (!plan || typeof plan !== "object") throw new TypeError(`${team} pitching plan이 필요합니다.`);
  if (typeof plan.starterId !== "string" || plan.starterId.length === 0) throw new TypeError(`${team}.starterId가 필요합니다.`);
  if (!Array.isArray(plan.bullpenIds)) throw new TypeError(`${team}.bullpenIds는 배열이어야 합니다.`);
}

function getSoftLimit(player, config, { startedGame = false } = {}) {
  const role = resolvePitcherUsageRole(player.pitching?.role ?? "SP", { startedGame });
  const stamina = player.pitching?.stamina ?? 50;
  const z = ratingToLatent(stamina);
  if (role === "SP") return config.usage.starterSoftLimitAt50Stamina + z * config.usage.starterSoftLimitPerLatent;
  return config.usage.relieverSoftLimitAt50Stamina + z * config.usage.relieverSoftLimitPerLatent;
}

function hasCompletedEntryHalf(state, usage) {
  if (!usage) return false;
  // A reliever who entered an earlier inning has necessarily completed the
  // inning in which he entered before his team fields again.
  return state.inning > usage.entryInning;
}

function canRemoveReliever(state, usage, config) {
  return usage.battersFaced >= config.usage.relieverMinimumBatters || hasCompletedEntryHalf(state, usage);
}

function shouldHook({ state, player, usage, config, startedGame = false }) {
  if (!usage) return false;
  const role = resolvePitcherUsageRole(player.pitching?.role ?? "SP", { startedGame });
  const stamina = player.pitching?.stamina ?? 50;
  const fatigue = calculatePitcherFatigue({ pitchCount: usage.pitchCount, stamina, role, startedGame }, config);
  const limit = getSoftLimit(player, config, { startedGame });

  if (role === "SP") {
    if (usage.outsRecorded >= 21 && usage.runsAllowed <= config.usage.starterFinishGameMaxRuns) {
      const finishLimit =
        config.usage.starterFinishGameLimitAt50Stamina +
        ratingToLatent(stamina) * config.usage.starterFinishGameLimitPerLatent;
      if (usage.pitchCount < finishLimit) return false;
    }
    if (usage.pitchCount >= limit) return true;
    if (
      usage.runsAllowed >= config.usage.starterEmergencyRunThreshold &&
      usage.pitchCount >= config.usage.starterEmergencyMinimumPitches
    ) return true;
    if (
      fatigue >= config.usage.highFatigueThreshold &&
      usage.pitchCount >= config.usage.starterMinimumPitchesBeforeFatigueHook
    ) return true;
    return false;
  }

  if (!canRemoveReliever(state, usage, config)) return false;
  return usage.pitchCount >= limit || fatigue >= config.usage.highFatigueThreshold;
}

function nextAvailableBullpen(plan, teamUsage) {
  const used = new Set(Object.keys(teamUsage));
  return plan.bullpenIds.find((id) => !used.has(id)) ?? null;
}

/**
 * Basic Phase 1 pitcher-usage AI. It only decides whether to make a change and
 * which pre-ordered bullpen arm is next. GameState/Services execute the change.
 * Leverage roles and multi-day availability are intentionally deferred.
 */
function createPitcherUsageManager({ players, pitchingPlans, config = pitchingCalibration }) {
  const lookup = lookupFrom(players);
  for (const team of ["away", "home"]) validatePlan(pitchingPlans?.[team], team);

  return ({ state, fieldingTeam }) => {
    const currentId = state.currentPitcherId[fieldingTeam];
    const player = lookup(currentId);
    if (!player) throw new RangeError(`투수를 찾을 수 없습니다: ${currentId}`);
    const teamUsage = state.pitcherUsage[fieldingTeam] ?? {};
    const usage = teamUsage[currentId];
    const startedGame = Object.keys(teamUsage)[0] === currentId;
    if (!shouldHook({ state, player, usage, config, startedGame })) return null;
    return nextAvailableBullpen(pitchingPlans[fieldingTeam], state.pitcherUsage[fieldingTeam]);
  };
}

export { createPitcherUsageManager };
