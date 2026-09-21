import { hashSeed } from "../rng.js";

const AGING_STATE_VERSION = 1;

const POSITION_MODIFIER_KEYS = Object.freeze(["contact", "power", "vision", "discipline", "fielding", "reaction", "armStrength", "armAccuracy", "speed"]);
const PITCHER_MODIFIER_KEYS = Object.freeze(["control", "command", "movement", "pitchability", "stamina", "stuff", "velocityMph"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function emptyModifiers(keys) { return Object.fromEntries(keys.map((key) => [key, 0])); }

function normalizedModifiers(raw, keys) {
  const base = emptyModifiers(keys);
  for (const key of keys) {
    const value = Number(raw?.[key] ?? 0);
    base[key] = Number.isFinite(value) ? value : 0;
  }
  return base;
}

function normalizedProcessed(raw) {
  return [...new Set(Array.isArray(raw) ? raw.filter((value) => typeof value === "string" && value) : [])].sort();
}

function createPositionAgingState() {
  return freeze({ version: AGING_STATE_VERSION, processedSeasons: [], modifiers: emptyModifiers(POSITION_MODIFIER_KEYS), lastMigration: null });
}

function createPitcherAgingState() {
  return freeze({ version: AGING_STATE_VERSION, processedSeasons: [], modifiers: emptyModifiers(PITCHER_MODIFIER_KEYS) });
}

function normalizePositionAgingState(aging) {
  const base = createPositionAgingState();
  if (!aging) return base;
  return freeze({
    ...base,
    ...aging,
    version: AGING_STATE_VERSION,
    processedSeasons: normalizedProcessed(aging.processedSeasons),
    modifiers: normalizedModifiers(aging.modifiers, POSITION_MODIFIER_KEYS),
    lastMigration: aging.lastMigration ?? null
  });
}

function normalizePitcherAgingState(aging) {
  const base = createPitcherAgingState();
  if (!aging) return base;
  return freeze({
    ...base,
    ...aging,
    version: AGING_STATE_VERSION,
    processedSeasons: normalizedProcessed(aging.processedSeasons),
    modifiers: normalizedModifiers(aging.modifiers, PITCHER_MODIFIER_KEYS)
  });
}

function deterministicUnit(playerId, seasonKey, tool) {
  return (hashSeed(`aging-v${AGING_STATE_VERSION}:${playerId}:${seasonKey}:${tool}`) % 10000) / 9999;
}

function annualDecline(age, { start, slope, cap }, playerId, seasonKey, tool) {
  if (age < start) return 0;
  const years = age - start + 1;
  const jitter = deterministicUnit(playerId, seasonKey, tool);
  const raw = years * slope + (jitter - 0.5) * 0.9;
  return clamp(Math.max(0, Math.round(raw)), 0, cap);
}

function positionDeclines(playerId, age, seasonKey) {
  const powerHold = age <= 32 && deterministicUnit(playerId, seasonKey, "power-hold") < 0.38;
  return {
    speed: annualDecline(age, { start: 27, slope: 0.62, cap: 7 }, playerId, seasonKey, "speed"),
    reaction: annualDecline(age, { start: 29, slope: 0.50, cap: 6 }, playerId, seasonKey, "reaction"),
    fielding: annualDecline(age, { start: 30, slope: 0.30, cap: 4 }, playerId, seasonKey, "fielding"),
    armStrength: annualDecline(age, { start: 31, slope: 0.26, cap: 4 }, playerId, seasonKey, "armStrength"),
    armAccuracy: annualDecline(age, { start: 32, slope: 0.20, cap: 3 }, playerId, seasonKey, "armAccuracy"),
    power: powerHold ? 0 : annualDecline(age, { start: 31, slope: 0.30, cap: 4 }, playerId, seasonKey, "power"),
    contact: annualDecline(age, { start: 32, slope: 0.22, cap: 3 }, playerId, seasonKey, "contact"),
    vision: annualDecline(age, { start: 34, slope: 0.15, cap: 2 }, playerId, seasonKey, "vision"),
    discipline: annualDecline(age, { start: 35, slope: 0.13, cap: 2 }, playerId, seasonKey, "discipline")
  };
}

function pitcherDeclines(playerId, age, seasonKey) {
  return {
    stamina: annualDecline(age, { start: 28, slope: 0.58, cap: 7 }, playerId, seasonKey, "stamina"),
    stuff: annualDecline(age, { start: 29, slope: 0.45, cap: 6 }, playerId, seasonKey, "stuff"),
    movement: annualDecline(age, { start: 31, slope: 0.27, cap: 4 }, playerId, seasonKey, "movement"),
    control: annualDecline(age, { start: 33, slope: 0.18, cap: 3 }, playerId, seasonKey, "control"),
    command: annualDecline(age, { start: 33, slope: 0.16, cap: 3 }, playerId, seasonKey, "command"),
    pitchability: annualDecline(age, { start: 35, slope: 0.13, cap: 2 }, playerId, seasonKey, "pitchability"),
    velocityMph: age < 27 ? 0 : Number(clamp((age - 26) * 0.10 + (deterministicUnit(playerId, seasonKey, "velocityMph") - 0.5) * 0.18, 0, 1.25).toFixed(2))
  };
}

function currentPositionTools(player, state, modifiers) {
  const gains = state?.development?.gains ?? {};
  return {
    fielding: Number(player?.fielding?.fielding ?? 50) + Number(gains.defense ?? 0) + modifiers.fielding,
    reaction: Number(player?.fielding?.reaction ?? 50) + Number(gains.defense ?? 0) + modifiers.reaction,
    armStrength: Number(player?.fielding?.armStrength ?? 50) + modifiers.armStrength,
    speed: Number(player?.running?.speed ?? 50) + Number(gains.speed ?? 0) + modifiers.speed
  };
}

function choosePositionMigration(player, state, modifiers, previousModifiers = null) {
  const primary = state?.primaryPosition ?? player?.positioning?.primaryPosition ?? "DH";
  const tools = currentPositionTools(player, state, modifiers);
  const previous = currentPositionTools(player, state, previousModifiers ?? modifiers);
  if (primary === "SS") {
    const rangeScore = tools.fielding * 0.25 + tools.reaction * 0.45 + tools.speed * 0.30;
    const previousRange = previous.fielding * 0.25 + previous.reaction * 0.45 + previous.speed * 0.30;
    const crossed = (previousRange >= 55 && rangeScore < 55)
      || (previous.reaction >= 53 && tools.reaction < 53)
      || (previous.speed >= 49 && tools.speed < 49);
    if (crossed) {
      const destination = tools.armStrength >= 68 && tools.speed < 53 ? "3B" : "2B";
      return freeze({ fromPosition: "SS", toPosition: destination, reason: "RANGE_DECLINE", rangeScore: Number(rangeScore.toFixed(2)) });
    }
  }
  if (primary === "CF") {
    const rangeScore = tools.fielding * 0.24 + tools.reaction * 0.38 + tools.speed * 0.38;
    const previousRange = previous.fielding * 0.24 + previous.reaction * 0.38 + previous.speed * 0.38;
    const crossed = (previousRange >= 58 && rangeScore < 58)
      || (previous.reaction >= 55 && tools.reaction < 55)
      || (previous.speed >= 54 && tools.speed < 54);
    if (crossed) {
      const destination = tools.armStrength >= 63 ? "RF" : "LF";
      return freeze({ fromPosition: "CF", toPosition: destination, reason: "RANGE_DECLINE", rangeScore: Number(rangeScore.toFixed(2)) });
    }
  }
  return null;
}

function migratedPositionState(state, migration) {
  if (!migration) return { primaryPosition: state.primaryPosition, positionFamiliarity: { ...(state.positionFamiliarity ?? {}) } };
  const familiarity = { ...(state.positionFamiliarity ?? {}) };
  familiarity[migration.fromPosition] = Math.max(0.65, Math.min(0.92, Number(familiarity[migration.fromPosition] ?? 1)));
  familiarity[migration.toPosition] = 1;
  return { primaryPosition: migration.toPosition, positionFamiliarity: familiarity };
}

function applyAnnualPositionPlayerAging(state, player, { seasonKey } = {}) {
  if (!state?.playerId || !player?.id || state.playerId !== player.id) throw new TypeError("position-player aging에는 일치하는 state/player가 필요합니다.");
  if (typeof seasonKey !== "string" || !seasonKey) throw new TypeError("aging seasonKey가 필요합니다.");
  const aging = normalizePositionAgingState(state.aging);
  if (aging.processedSeasons.includes(seasonKey)) return freeze({ state, applied: false, migration: null, declines: emptyModifiers(POSITION_MODIFIER_KEYS) });
  const age = clamp(Math.round(Number(state.health?.age ?? player?.physical?.age ?? 26)), 16, 50);
  const declines = positionDeclines(player.id, age, seasonKey);
  const modifiers = { ...aging.modifiers };
  for (const key of POSITION_MODIFIER_KEYS) modifiers[key] = Number(modifiers[key] ?? 0) - Number(declines[key] ?? 0);
  const migration = choosePositionMigration(player, state, modifiers, aging.modifiers);
  const positionState = migratedPositionState(state, migration);
  const nextState = freeze({
    ...state,
    primaryPosition: positionState.primaryPosition,
    positionFamiliarity: positionState.positionFamiliarity,
    health: { ...state.health, age: clamp(age + 1, 16, 50) },
    aging: {
      version: AGING_STATE_VERSION,
      processedSeasons: [...aging.processedSeasons, seasonKey].sort(),
      modifiers,
      lastMigration: migration ? { ...migration, seasonKey } : aging.lastMigration
    }
  });
  return freeze({ state: nextState, applied: true, migration, declines });
}

function applyAnnualPitcherAging(state, player, { seasonKey } = {}) {
  if (!state?.playerId || !player?.id || state.playerId !== player.id) throw new TypeError("pitcher aging에는 일치하는 state/player가 필요합니다.");
  if (typeof seasonKey !== "string" || !seasonKey) throw new TypeError("aging seasonKey가 필요합니다.");
  const aging = normalizePitcherAgingState(state.aging);
  if (aging.processedSeasons.includes(seasonKey)) return freeze({ state, applied: false, declines: emptyModifiers(PITCHER_MODIFIER_KEYS) });
  const age = clamp(Math.round(Number(state.health?.age ?? player?.physical?.age ?? 27)), 16, 50);
  const declines = pitcherDeclines(player.id, age, seasonKey);
  const modifiers = { ...aging.modifiers };
  for (const key of PITCHER_MODIFIER_KEYS) modifiers[key] = Number(modifiers[key] ?? 0) - Number(declines[key] ?? 0);
  const nextState = freeze({
    ...state,
    health: { ...state.health, age: clamp(age + 1, 16, 50) },
    aging: { version: AGING_STATE_VERSION, processedSeasons: [...aging.processedSeasons, seasonKey].sort(), modifiers }
  });
  return freeze({ state: nextState, applied: true, declines });
}

export { AGING_STATE_VERSION, createPositionAgingState, createPitcherAgingState, normalizePositionAgingState, normalizePitcherAgingState, choosePositionMigration, applyAnnualPositionPlayerAging, applyAnnualPitcherAging };
