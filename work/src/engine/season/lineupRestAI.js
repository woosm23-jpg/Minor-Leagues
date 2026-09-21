import { rolePriority } from "./roleSystem.js";
import { canUtilityCover, utilityFamiliarity } from "./utilityUsage.js";
import { optimizePositionAssignments } from "./positionAssignment.js";
import { healthAvailability } from "./injuryState.js";

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function fatigueOf(playerStates, id) {
  return Number(playerStates?.[id]?.fatigue ?? 0);
}

function available(playerStates, id) {
  return healthAvailability(playerStates?.[id]?.health) !== "INJURED";
}

function thresholdFor(position, role = null) {
  let base = 40;
  if (position === "C") base = 30;
  else if (position === "CF" || position === "SS") base = 36;
  const priority = rolePriority(role);
  // Persistent role only nudges rest tolerance. It never bypasses fatigue.
  const protection = Math.round((priority - 0.5) * 4);
  return Math.max(24, Math.min(52, base + protection));
}

function eligibleForRest(slot, playerStates, roleStates) {
  const fatigue = fatigueOf(playerStates, slot.starterId);
  return fatigue >= thresholdFor(slot.position, roleStates?.[slot.starterId]?.role);
}

function directBenchCoverage(roster, playerStates, roleStates, benchPlayerId, position) {
  return canUtilityCover(roster, playerStates, roleStates, benchPlayerId, position);
}

function findUtilityShift(slots, roster, playerStates, roleStates, targetSlot, usedBenchIds) {
  const movers = slots
    .filter((slot) => slot !== targetSlot && slot.playerId === slot.starterId)
    .filter((slot) => available(playerStates, slot.starterId))
    .filter((slot) => fatigueOf(playerStates, slot.starterId) < 52)
    .filter((slot) => canUtilityCover(roster, playerStates, roleStates, slot.starterId, targetSlot.position));

  const options = [];
  for (const mover of movers) {
    for (const bench of roster.bench ?? []) {
      if (usedBenchIds.has(bench.playerId)) continue;
      if (!available(playerStates, bench.playerId)) continue;
      if (fatigueOf(playerStates, bench.playerId) >= 52) continue;
      if (!canUtilityCover(roster, playerStates, roleStates, bench.playerId, mover.position)) continue;
      options.push({
        mover,
        bench,
        moverFamiliarity: utilityFamiliarity(roster, playerStates, mover.starterId, targetSlot.position),
        backfillFamiliarity: utilityFamiliarity(roster, playerStates, bench.playerId, mover.position)
      });
    }
  }
  options.sort((a, b) => b.moverFamiliarity - a.moverFamiliarity
    || b.backfillFamiliarity - a.backfillFamiliarity
    || fatigueOf(playerStates, a.mover.starterId) - fatigueOf(playerStates, b.mover.starterId)
    || a.mover.position.localeCompare(b.mover.position)
    || a.bench.playerId.localeCompare(b.bench.playerId));
  return options[0] ?? null;
}

/**
 * Daily lineup/rest AI.
 *
 * Stage 1 is the v32 direct bench replacement path and remains authoritative.
 * Stage 2 is a conservative utility fallback used only when a tired starter
 * still has no direct replacement. A sufficiently familiar starter may slide
 * to the uncovered position while an unused bench player backfills the mover's
 * original position. This makes real secondary-position reps possible without
 * rewriting stable baseline lineups.
 */
function buildDailyLineup(roster, playerStates = {}, roleStates = {}) {
  if (!roster?.lineupSlots || !Array.isArray(roster.bench)) {
    return freeze({ lineup: [...roster.lineup], defense: { ...roster.defense }, rested: [], unavailable: [], replacements: [], utilityAssignments: [], positionAssignments: [] });
  }

  const slots = roster.lineupSlots.map((slot) => ({ ...slot, playerId: slot.starterId }));
  const rested = [];
  const unavailable = [];
  const replacements = [];
  const utilityAssignments = [];
  const usedBenchIds = new Set();

  // Stage 0: injury availability is authoritative. An injured starter must be
  // removed before ordinary fatigue/rest logic. Prefer direct coverage, then
  // the same conservative utility shift used for rest, and finally an
  // emergency healthy bench assignment so an unavailable player never starts.
  const injuredTargets = slots.filter((slot) => !available(playerStates, slot.starterId));
  for (const targetSlot of injuredTargets) {
    if (targetSlot.playerId !== targetSlot.starterId) continue;
    const direct = (roster.bench ?? []).find((bench) => !usedBenchIds.has(bench.playerId)
      && available(playerStates, bench.playerId)
      && directBenchCoverage(roster, playerStates, roleStates, bench.playerId, targetSlot.position));
    if (direct) {
      unavailable.push(targetSlot.starterId);
      replacements.push({ kind: "INJURY_DIRECT", playerId: direct.playerId, forPlayerId: targetSlot.starterId, position: targetSlot.position });
      targetSlot.playerId = direct.playerId;
      usedBenchIds.add(direct.playerId);
      continue;
    }
    const option = findUtilityShift(slots, roster, playerStates, roleStates, targetSlot, usedBenchIds);
    if (option) {
      const { mover, bench, moverFamiliarity, backfillFamiliarity } = option;
      const moverId = mover.starterId;
      const targetId = targetSlot.starterId;
      mover.playerId = bench.playerId;
      targetSlot.playerId = moverId;
      usedBenchIds.add(bench.playerId);
      unavailable.push(targetId);
      replacements.push({ kind: "INJURY_UTILITY_BACKFILL", playerId: bench.playerId, forPlayerId: moverId, position: mover.position });
      utilityAssignments.push({
        playerId: moverId, fromPosition: mover.position, toPosition: targetSlot.position, forPlayerId: targetId,
        backfillPlayerId: bench.playerId, familiarity: Number(moverFamiliarity.toFixed(3)), backfillFamiliarity: Number(backfillFamiliarity.toFixed(3))
      });
      continue;
    }
    const emergency = (roster.bench ?? []).find((bench) => !usedBenchIds.has(bench.playerId) && available(playerStates, bench.playerId));
    if (emergency) {
      unavailable.push(targetSlot.starterId);
      replacements.push({ kind: "INJURY_EMERGENCY", playerId: emergency.playerId, forPlayerId: targetSlot.starterId, position: targetSlot.position });
      targetSlot.playerId = emergency.playerId;
      usedBenchIds.add(emergency.playerId);
    }
  }

  // Stage 1: preserve the existing direct bench-rest algorithm.
  for (const bench of roster.bench) {
    if (usedBenchIds.has(bench.playerId)) continue;
    if (!available(playerStates, bench.playerId)) continue;
    if (fatigueOf(playerStates, bench.playerId) >= 52) continue;
    const candidates = slots
      .filter((slot) => slot.playerId === slot.starterId && available(playerStates, slot.starterId) && directBenchCoverage(roster, playerStates, roleStates, bench.playerId, slot.position))
      .map((slot) => ({ slot, fatigue: fatigueOf(playerStates, slot.starterId) }))
      .filter(({ slot, fatigue }) => fatigue >= thresholdFor(slot.position, roleStates?.[slot.starterId]?.role))
      .sort((a, b) => b.fatigue - a.fatigue || a.slot.position.localeCompare(b.slot.position));
    const selected = candidates[0];
    if (!selected) continue;
    rested.push(selected.slot.starterId);
    replacements.push({ kind: "DIRECT", playerId: bench.playerId, forPlayerId: selected.slot.starterId, position: selected.slot.position });
    selected.slot.playerId = bench.playerId;
    usedBenchIds.add(bench.playerId);
  }

  // Stage 2: utility fallback. Only uncovered fatigued starters reach here.
  const uncovered = slots
    .filter((slot) => slot.playerId === slot.starterId && available(playerStates, slot.starterId) && eligibleForRest(slot, playerStates, roleStates))
    .sort((a, b) => fatigueOf(playerStates, b.starterId) - fatigueOf(playerStates, a.starterId) || a.position.localeCompare(b.position));

  for (const targetSlot of uncovered) {
    if (targetSlot.playerId !== targetSlot.starterId) continue;
    const option = findUtilityShift(slots, roster, playerStates, roleStates, targetSlot, usedBenchIds);
    if (!option) continue;
    const { mover, bench, moverFamiliarity, backfillFamiliarity } = option;
    const moverId = mover.starterId;
    const targetId = targetSlot.starterId;
    mover.playerId = bench.playerId;
    targetSlot.playerId = moverId;
    usedBenchIds.add(bench.playerId);
    rested.push(targetId);
    replacements.push({ kind: "UTILITY_BACKFILL", playerId: bench.playerId, forPlayerId: moverId, position: mover.position });
    utilityAssignments.push({
      playerId: moverId,
      fromPosition: mover.position,
      toPosition: targetSlot.position,
      forPlayerId: targetId,
      backfillPlayerId: bench.playerId,
      familiarity: Number(moverFamiliarity.toFixed(3)),
      backfillFamiliarity: Number(backfillFamiliarity.toFixed(3))
    });
  }

  // Starting-nine selection and batting order are already fixed above. v36
  // optimizes only the defensive/DH assignment of those same nine players.
  const lineup = slots.map((slot) => slot.playerId);
  const optimized = optimizePositionAssignments({ roster, slots, playerStates, roleStates });
  const defense = {};
  for (const [position, playerId] of Object.entries(optimized.assignments)) {
    if (position !== "DH") defense[position] = playerId;
  }
  return freeze({ lineup, defense, rested, unavailable, replacements, utilityAssignments, positionAssignments: optimized.changes });
}

export { buildDailyLineup };
