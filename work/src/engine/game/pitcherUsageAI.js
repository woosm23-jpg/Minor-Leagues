import { pitchingCalibration } from "../../config/pitchingCalibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";
import { calculatePitcherFatigue, resolvePitcherUsageRole } from "./pitcherFatigue.js";

const BULLPEN_ROLES = Object.freeze(["CLOSER", "SETUP", "MIDDLE", "LONG"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freeze(child)])
    ));
  }
  return value;
}

function lookupFrom(players) {
  if (players instanceof Map) return (id) => players.get(id);
  if (players && typeof players === "object") return (id) => players[id];
  throw new TypeError("players는 Map 또는 ID-keyed object여야 합니다.");
}

function validatePlan(plan, team) {
  if (!plan || typeof plan !== "object") {
    throw new TypeError(`${team} pitching plan이 필요합니다.`);
  }
  if (typeof plan.starterId !== "string" || !plan.starterId) {
    throw new TypeError(`${team}.starterId가 필요합니다.`);
  }
  if (!Array.isArray(plan.bullpenIds)) {
    throw new TypeError(`${team}.bullpenIds는 배열이어야 합니다.`);
  }
}

function getSoftLimit(player, config, { startedGame = false } = {}) {
  const role = resolvePitcherUsageRole(
    player.pitching?.role ?? "SP",
    { startedGame }
  );
  const stamina = player.pitching?.stamina ?? 50;
  const z = ratingToLatent(stamina);

  if (role === "SP") {
    return config.usage.starterSoftLimitAt50Stamina
      + z * config.usage.starterSoftLimitPerLatent;
  }

  return config.usage.relieverSoftLimitAt50Stamina
    + z * config.usage.relieverSoftLimitPerLatent;
}

function hasCompletedEntryHalf(state, usage) {
  return Boolean(usage) && state.inning > usage.entryInning;
}

function canRemoveReliever(state, usage, config) {
  return usage.battersFaced >= config.usage.relieverMinimumBatters
    || hasCompletedEntryHalf(state, usage);
}

function shouldHook({ state, player, usage, config, startedGame = false }) {
  if (!usage) return false;

  const role = resolvePitcherUsageRole(
    player.pitching?.role ?? "SP",
    { startedGame }
  );
  const stamina = player.pitching?.stamina ?? 50;
  const fatigue = calculatePitcherFatigue(
    { pitchCount: usage.pitchCount, stamina, role, startedGame },
    config
  );
  const limit = getSoftLimit(player, config, { startedGame });

  if (role === "SP") {
    if (
      usage.outsRecorded >= 21 &&
      usage.runsAllowed <= config.usage.starterFinishGameMaxRuns
    ) {
      const finishLimit =
        config.usage.starterFinishGameLimitAt50Stamina
        + ratingToLatent(stamina)
          * config.usage.starterFinishGameLimitPerLatent;
      if (usage.pitchCount < finishLimit) return false;
    }

    if (usage.pitchCount >= limit) return true;

    if (
      usage.runsAllowed >= config.usage.starterEmergencyRunThreshold &&
      usage.pitchCount >= config.usage.starterEmergencyMinimumPitches
    ) {
      return true;
    }

    if (
      fatigue >= config.usage.highFatigueThreshold &&
      usage.pitchCount >= config.usage.starterMinimumPitchesBeforeFatigueHook
    ) {
      return true;
    }

    return false;
  }

  if (!canRemoveReliever(state, usage, config)) return false;
  return usage.pitchCount >= limit
    || fatigue >= config.usage.highFatigueThreshold;
}

function relieverQuality(player) {
  const p = player?.pitching ?? {};
  return Number(player?.derived?.stuff ?? 50) * 0.36
    + Number(p.command ?? 50) * 0.19
    + Number(p.movement ?? 50) * 0.18
    + Number(p.pitchability ?? 50) * 0.15
    + Number(p.control ?? 50) * 0.07
    + Number(p.stamina ?? 50) * 0.05;
}

function classifyBullpenRoles({ bullpenIds, lookup }) {
  const rows = bullpenIds.map((id) => {
    const player = lookup(id);
    if (!player) throw new RangeError(`불펜 투수를 찾을 수 없습니다: ${id}`);
    return {
      id,
      explicitRole: String(player?.pitching?.role ?? "RP").toUpperCase(),
      quality: relieverQuality(player),
      stamina: Number(player?.pitching?.stamina ?? 50)
    };
  });

  const result = {};

  const explicitCloser = rows
    .filter((row) => row.explicitRole === "CL")
    .sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id))[0] ?? null;

  if (explicitCloser) result[explicitCloser.id] = "CLOSER";

  const remaining = rows
    .filter((row) => !Object.hasOwn(result, row.id))
    .sort((a, b) => b.quality - a.quality || a.id.localeCompare(b.id));

  if (!explicitCloser && remaining.length) {
    result[remaining.shift().id] = "CLOSER";
  }

  if (remaining.length) result[remaining.shift().id] = "SETUP";

  if (remaining.length) {
    const long = [...remaining].sort(
      (a, b) =>
        b.stamina - a.stamina ||
        a.quality - b.quality ||
        a.id.localeCompare(b.id)
    )[0];
    result[long.id] = "LONG";
  }

  for (const row of remaining) {
    if (!Object.hasOwn(result, row.id)) result[row.id] = "MIDDLE";
  }

  return freeze(result);
}

function scoreDiff(state, team) {
  const other = team === "away" ? "home" : "away";
  return Number(state?.score?.[team] ?? 0)
    - Number(state?.score?.[other] ?? 0);
}

function leverageTarget(state, fieldingTeam) {
  const diff = scoreDiff(state, fieldingTeam);
  const closeGame = Math.abs(diff) <= 3;

  if (state.inning >= 9 && closeGame) {
    return diff >= 1 ? "CLOSER" : "SETUP";
  }
  if (state.inning === 8 && closeGame) return "SETUP";
  if (state.inning >= 7 && closeGame) return "MIDDLE";
  if (state.inning <= 6 || Math.abs(diff) >= 4) return "LONG";
  return "MIDDLE";
}

function roleFitBonus(target, role) {
  const table = {
    CLOSER: { CLOSER: 18, SETUP: 10, MIDDLE: 2, LONG: -8 },
    SETUP: { CLOSER: 7, SETUP: 18, MIDDLE: 6, LONG: -6 },
    MIDDLE: { CLOSER: 0, SETUP: 6, MIDDLE: 12, LONG: 7 },
    LONG: { CLOSER: -10, SETUP: -4, MIDDLE: 8, LONG: 18 }
  };
  return table[target]?.[role] ?? 0;
}

function bullpenMetaFor(plan, id) {
  return plan?.bullpenMeta?.[id] ?? {};
}

function availabilityPenalty(meta) {
  const availability = String(meta?.availability ?? "READY").toUpperCase();
  if (availability === "UNAVAILABLE") return 100;
  if (availability === "LIMITED") return 10;
  return 0;
}

function recoveryPenalty(meta) {
  const status = String(
    meta?.recoveryStatus ?? "READY"
  ).toUpperCase();

  if (status === "REST") return 80;
  if (status === "LIMITED") return 12;
  return 0;
}

function candidateScore({ player, role, target, meta }) {
  const pregameFatigue = Math.max(
    0,
    Math.min(100, Number(meta?.pregameFatigue ?? 0))
  );

  return relieverQuality(player)
    + roleFitBonus(target, role)
    - pregameFatigue * 0.18
    - availabilityPenalty(meta)
    - recoveryPenalty(meta);
}

function chooseBullpenArm({ state, fieldingTeam, plan, lookup }) {
  const used = new Set(
    Object.keys(state.pitcherUsage?.[fieldingTeam] ?? {})
  );
  const roles = classifyBullpenRoles({
    bullpenIds: plan.bullpenIds,
    lookup
  });
  const target = leverageTarget(state, fieldingTeam);

  const candidates = plan.bullpenIds
    .filter((id) => !used.has(id))
    .map((id) => {
      const player = lookup(id);
      if (!player) throw new RangeError(`불펜 투수를 찾을 수 없습니다: ${id}`);
      const role = roles[id] ?? "MIDDLE";
      const meta = bullpenMetaFor(plan, id);

      return {
        id,
        role,
        meta,
        quality: relieverQuality(player),
        score: candidateScore({ player, role, target, meta })
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.quality - a.quality ||
        a.id.localeCompare(b.id)
    );

  const normal = candidates.filter(
    (row) => {
      const availability = String(
        row.meta?.availability ?? "READY"
      ).toUpperCase();
      const recovery = String(
        row.meta?.recoveryStatus ?? "READY"
      ).toUpperCase();

      return availability !== "INJURED" &&
        availability !== "UNAVAILABLE" &&
        recovery !== "REST";
    }
  );

  if (normal.length > 0) {
    return normal[0].id;
  }

  // Emergency: preserve the game's ability to finish if every usable
  // reliever is resting or otherwise unavailable. Never use an injured arm.
  const emergency = candidates.filter(
    (row) =>
      String(
        row.meta?.availability ?? "READY"
      ).toUpperCase() !== "INJURED"
  );

  return emergency[0]?.id ?? null;
}

/**
 * Third-time-through overlay. An established starter gets extra protection
 * only in a close game, from the third pass through the batting order onward,
 * and only after meaningful pitch workload or trouble.
 */
function shouldTtoHook({ state, fieldingTeam, player, usage, config }) {
  if (!usage || !player?.pitching) return false;
  if (state.inning < 6 || state.inning > 8) return false;
  if (Math.abs(scoreDiff(state, fieldingTeam)) > 3) return false;
  if (Number(usage.battersFaced ?? 0) < 18) return false;
  if (Number(usage.pitchCount ?? 0) < 78) return false;
  if (Number(usage.outsRecorded ?? 0) >= 21) return false;

  const fatigue = calculatePitcherFatigue({
    pitchCount: usage.pitchCount,
    stamina: player.pitching.stamina ?? 50,
    role: "SP",
    startedGame: true
  }, config);

  return Number(usage.runsAllowed ?? 0) >= 3 || fatigue >= 72;
}

function isFreshTtoArm(plan, pitcherId) {
  if (!pitcherId) return false;
  const meta = bullpenMetaFor(plan, pitcherId);
  return String(meta.availability ?? "READY").toUpperCase() === "READY"
    && String(meta.recoveryStatus ?? "READY").toUpperCase() === "READY"
    && Number(meta.pregameFatigue ?? 0) < 42;
}

/**
 * Keeps the original Phase 1 hook and adds a narrow third-time-through overlay.
 */
function createPitcherUsageManager({
  players,
  pitchingPlans,
  config = pitchingCalibration
}) {
  const lookup = lookupFrom(players);

  for (const team of ["away", "home"]) {
    validatePlan(pitchingPlans?.[team], team);
  }

  return ({ state, fieldingTeam }) => {
    const currentId = state.currentPitcherId[fieldingTeam];
    const player = lookup(currentId);
    if (!player) throw new RangeError(`투수를 찾을 수 없습니다: ${currentId}`);

    const teamUsage = state.pitcherUsage[fieldingTeam] ?? {};
    const usage = teamUsage[currentId];
    const startedGame = Object.keys(teamUsage)[0] === currentId;

    const baseHook = shouldHook({
      state,
      player,
      usage,
      config,
      startedGame
    });

    if (!baseHook) {
      // A third-time-through hook is a limited overlay, never an emergency
      // reason to use an exhausted or unavailable reliever.
      if (!startedGame || !shouldTtoHook({
        state,
        fieldingTeam,
        player,
        usage,
        config
      })) return null;
    }

    const plan = pitchingPlans[fieldingTeam];
    const nextArm = chooseBullpenArm({
      state,
      fieldingTeam,
      plan,
      lookup
    });

    if (!baseHook && !isFreshTtoArm(plan, nextArm)) return null;
    return nextArm;
  };
}

export {
  BULLPEN_ROLES,
  relieverQuality,
  classifyBullpenRoles,
  leverageTarget,
  shouldTtoHook,
  createPitcherUsageManager
};
