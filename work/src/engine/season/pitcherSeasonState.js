import { advanceHealthState, createHealthState, getHealthPublicView, healthAvailability, normalizeHealthState } from "./injuryState.js";
import { createPitcherAgingState, normalizePitcherAgingState } from "./agingState.js";
import { applyAnnualPitcherDevelopment, createPitcherDevelopmentState, normalizePitcherDevelopmentState, pitcherDevelopmentDelta } from "./developmentState.js";

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampRating(value) { return clamp(Math.round(value), 20, 99); }

function createPitcherSeasonState(player, developmentProfile = null) {
  if (!player?.id || !player?.pitching) throw new TypeError("pitcher Player가 필요합니다.");
  return freeze({
    playerId: player.id,
    fatigue: 0,
    health: createHealthState(player, { kind: "PITCHER" }),
    aging: createPitcherAgingState(),
    development: createPitcherDevelopmentState(player, developmentProfile ?? {}),
    appearances: 0,
    lastAppearanceDate: null,
    lastPitchCount: 0
  });
}

function normalizePitcherSeasonState(state, player, developmentProfile = null) {
  const base = createPitcherSeasonState(player, developmentProfile);
  if (!state) return base;
  const aging = normalizePitcherAgingState(state.aging ?? null);
  let development = normalizePitcherDevelopmentState(state.development ?? null, player, developmentProfile ?? {});
  if (state.development?.version !== 2 && aging.processedSeasons.length > 0) {
    development = freeze({ ...development, processedOffseasons: [...new Set([...development.processedOffseasons, ...aging.processedSeasons])].sort() });
  }
  return freeze({
    ...base,
    ...state,
    health: normalizeHealthState(state.health ?? null, player, { kind: "PITCHER" }),
    aging,
    development
  });
}

function recoverPitcherSeasonState(state, player, days = 1) {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days는 0 이상의 정수여야 합니다.");
  if (days === 0) return state;
  const role = player?.pitching?.role ?? "RP";
  const perDay = role === "SP" ? 21 : 34;
  return freeze({ ...state, fatigue: clamp(state.fatigue - perDay * days, 0, 100), health: advanceHealthState(state.health, days) });
}

function currentPitcherDevelopmentRatings(player, state) {
  const gains = state.development?.gains ?? {};
  const ageMods = normalizePitcherAgingState(state.aging).modifiers;
  const pitching = player.pitching ?? {};
  return {
    control: Number(pitching.control ?? 50) + Number(gains.control ?? 0) + ageMods.control,
    command: Number(pitching.command ?? 50) + Number(gains.command ?? 0) + ageMods.command,
    movement: Number(pitching.movement ?? 50) + Number(gains.movement ?? 0) + ageMods.movement,
    pitchability: Number(pitching.pitchability ?? 50) + Number(gains.pitchability ?? 0) + ageMods.pitchability,
    stamina: Number(pitching.stamina ?? 50) + Number(gains.stamina ?? 0) + ageMods.stamina,
    stuff: Number(player.derived?.stuff ?? 50) + Number(gains.stuff ?? 0) + ageMods.stuff,
    velocityMph: Number(pitching.pitchVelocityMph ?? 92) + Number(gains.velocityMph ?? 0) + ageMods.velocityMph
  };
}

function convertPitcherProgressToGains(player, development, progress, state) {
  const gains = { ...development.gains };
  const nextProgress = { ...progress };
  for (const tool of Object.keys(nextProgress)) {
    while (nextProgress[tool] >= 1) {
      const current = currentPitcherDevelopmentRatings(player, { ...state, development: { ...development, gains } })[tool];
      const ceiling = Number(development.ceilings?.[tool] ?? current);
      if (current >= ceiling) {
        nextProgress[tool] = Math.min(nextProgress[tool], 0.99);
        break;
      }
      gains[tool] = Number((Number(gains[tool] ?? 0) + (tool === "velocityMph" ? 0.1 : 1)).toFixed(2));
      nextProgress[tool] -= 1;
    }
  }
  return { gains, progress: nextProgress };
}

function applyPitcherSeasonGame(state, player, { pitchCount = 0, pitchingLine = null, date = null, level = "AAA", developmentMultiplier = 1 } = {}) {
  if (!Number.isFinite(developmentMultiplier) || developmentMultiplier <= 0) throw new RangeError("developmentMultiplier는 0보다 큰 유한한 값이어야 합니다.");
  if (!Number.isFinite(pitchCount) || pitchCount < 0) throw new RangeError("pitchCount는 0 이상의 유한한 값이어야 합니다.");
  if (pitchCount === 0) return state;
  const role = player?.pitching?.role ?? "RP";
  const workload = role === "SP"
    ? Math.min(100, pitchCount * 0.88)
    : Math.min(100, 10 + pitchCount * 1.85);
  const delta = pitcherDevelopmentDelta({
    player,
    development: state.development,
    pitchingLine,
    pitchCount,
    age: state.health?.age,
    level,
    currentRatings: currentPitcherDevelopmentRatings(player, state)
  });
  const progress = Object.fromEntries(Object.keys(state.development.progress).map((tool) => [tool, state.development.progress[tool] + (delta[tool] ?? 0) * developmentMultiplier]));
  const converted = convertPitcherProgressToGains(player, state.development, progress, state);
  return freeze({
    ...state,
    fatigue: clamp(state.fatigue + workload, 0, 100),
    appearances: state.appearances + 1,
    lastAppearanceDate: date ?? state.lastAppearanceDate,
    lastPitchCount: Math.round(pitchCount),
    development: { ...state.development, progress: converted.progress, gains: converted.gains }
  });
}

function applyAnnualPitcherSeasonDevelopment(state, player, { seasonKey } = {}) {
  if (!state?.development || state.playerId !== player?.id) throw new TypeError("pitcher development에는 일치하는 state/player가 필요합니다.");
  const result = applyAnnualPitcherDevelopment(state.development, player, {
    seasonKey,
    age: state.health?.age,
    currentRatings: currentPitcherDevelopmentRatings(player, state)
  });
  if (!result.applied) return freeze({ state, applied: false, outcome: null });
  return freeze({ state: freeze({ ...state, development: result.development }), applied: true, outcome: result.outcome });
}

function pitcherAvailability(state) {
  if (healthAvailability(state?.health) === "INJURED") return "INJURED";
  const fatigue = Number(state?.fatigue ?? 0);
  if (fatigue >= 72) return "UNAVAILABLE";
  if (fatigue >= 42) return "LIMITED";
  return "READY";
}

/** Current developed pitcher talent without temporary fatigue. */
function getSeasonDevelopedPitcher(player, state) {
  if (!state || !player?.pitching) return player;
  const gains = state.development?.gains ?? {};
  const ageMods = normalizePitcherAgingState(state.aging).modifiers;
  return freeze({
    ...player,
    pitching: {
      ...player.pitching,
      control: clampRating(player.pitching.control + Number(gains.control ?? 0) + ageMods.control),
      command: clampRating(player.pitching.command + Number(gains.command ?? 0) + ageMods.command),
      movement: clampRating(player.pitching.movement + Number(gains.movement ?? 0) + ageMods.movement),
      pitchability: clampRating(player.pitching.pitchability + Number(gains.pitchability ?? 0) + ageMods.pitchability),
      stamina: clampRating(player.pitching.stamina + Number(gains.stamina ?? 0) + ageMods.stamina),
      pitchVelocityMph: player.pitching.pitchVelocityMph == null ? null : Number((player.pitching.pitchVelocityMph + Number(gains.velocityMph ?? 0) + ageMods.velocityMph).toFixed(2))
    },
    derived: {
      ...player.derived,
      stuff: clampRating((player.derived?.stuff ?? 50) + Number(gains.stuff ?? 0) + ageMods.stuff)
    }
  });
}

/** Game-only pregame pitcher snapshot. Canonical ratings remain untouched. */
function getSeasonEffectivePitcher(player, state) {
  if (!state || !player?.pitching) return player;
  const developed = getSeasonDevelopedPitcher(player, state);
  const fatigue = clamp(Number(state.fatigue ?? 0), 0, 100);
  const factor = fatigue / 100;
  return freeze({
    ...developed,
    pitching: {
      ...developed.pitching,
      command: clampRating(developed.pitching.command - 5 * factor),
      movement: clampRating(developed.pitching.movement - 4 * factor),
      stamina: clampRating(developed.pitching.stamina - 9 * factor),
      pitchVelocityMph: developed.pitching.pitchVelocityMph == null ? null : developed.pitching.pitchVelocityMph - 0.9 * factor
    },
    derived: {
      ...developed.derived,
      stuff: clampRating((developed.derived?.stuff ?? 50) - 5 * factor)
    }
  });
}

function selectSeasonStarter(roster, rotationIndex, pitcherStates = {}) {
  const scheduled = roster.starters[rotationIndex % roster.starters.length];
  const availableStarters = [...roster.starters].filter((id) => pitcherAvailability(pitcherStates?.[id]) !== "INJURED");
  if (availableStarters.includes(scheduled)) {
    const scheduledFatigue = Number(pitcherStates?.[scheduled]?.fatigue ?? 0);
    if (scheduledFatigue < 58) return scheduled;
  }
  if (availableStarters.length > 0) return availableStarters.sort((a, b) =>
    Number(pitcherStates?.[a]?.fatigue ?? 0) - Number(pitcherStates?.[b]?.fatigue ?? 0) || a.localeCompare(b)
  )[0];
  const emergency = [...(roster.bullpen ?? [])].filter((id) => pitcherAvailability(pitcherStates?.[id]) !== "INJURED").sort((a, b) =>
    Number(pitcherStates?.[a]?.fatigue ?? 0) - Number(pitcherStates?.[b]?.fatigue ?? 0) || a.localeCompare(b)
  );
  return emergency[0] ?? scheduled;
}

function orderAvailableBullpen(roster, pitcherStates = {}) {
  const ranked = [...roster.bullpen].sort((a, b) => {
    const fa = Number(pitcherStates?.[a]?.fatigue ?? 0);
    const fb = Number(pitcherStates?.[b]?.fatigue ?? 0);
    return fa - fb || a.localeCompare(b);
  });
  const healthy = ranked.filter((id) => pitcherAvailability(pitcherStates?.[id]) !== "INJURED");
  const usable = healthy.filter((id) => pitcherAvailability(pitcherStates?.[id]) !== "UNAVAILABLE");
  return freeze(usable.length > 0 ? usable : healthy.slice(0, 1));
}

function getPitcherSeasonView(state) {
  if (!state) return null;
  return freeze({
    fatigue: Number((state.fatigue ?? 0).toFixed(1)),
    availability: pitcherAvailability(state),
    health: getHealthPublicView(state.health),
    appearances: state.appearances,
    lastPitchCount: state.lastPitchCount
  });
}

export { createPitcherSeasonState, normalizePitcherSeasonState, recoverPitcherSeasonState, applyPitcherSeasonGame, applyAnnualPitcherSeasonDevelopment, pitcherAvailability, getSeasonDevelopedPitcher, getSeasonEffectivePitcher, selectSeasonStarter, orderAvailableBullpen, getPitcherSeasonView };
