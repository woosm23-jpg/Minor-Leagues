import { advanceHealthState, createHealthState, getHealthPublicView, normalizeHealthState } from "./injuryState.js";
import { createPositionAgingState, normalizePositionAgingState } from "./agingState.js";
import { applyAnnualPositionDevelopment, createPositionDevelopmentState, normalizePositionDevelopmentState, positionDevelopmentDelta } from "./developmentState.js";

const MAX_RECENT_FORM_GAMES = 14;

const TRAINING_FOCUSES = Object.freeze([
  "BALANCED",
  "CONTACT",
  "POWER",
  "PLATE_DISCIPLINE",
  "DEFENSE",
  "SPEED"
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampRating(value) {
  return clamp(Math.round(value), 20, 99);
}

function initialPositionFamiliarity(player, positionProfile = null) {
  const profile = positionProfile ?? player?.positioning ?? {};
  const primary = profile.primaryPosition ?? "DH";
  const supplied = profile.familiarity ?? {};
  return Object.fromEntries(Object.entries({ [primary]: 1, ...supplied }).map(([position, value]) => [position, clamp(Number(value) || 0, 0.35, 1)]));
}

function initialPositionReps(player, positionProfile = null) {
  return Object.fromEntries(Object.keys(initialPositionFamiliarity(player, positionProfile)).map((position) => [position, 0]));
}

function familiarityGainPerGame(player) {
  const adaptability = clamp(Number(player?.positioning?.adaptability ?? 50), 20, 99);
  return 0.004 + ((adaptability - 20) / 79) * 0.008;
}

function applyPositionFamiliarityRep(state, player, position) {
  if (!position || position === "DH" || position === "P") return { familiarity: { ...(state.positionFamiliarity ?? initialPositionFamiliarity(player)) }, reps: { ...(state.positionReps ?? initialPositionReps(player)) } };
  const familiarity = { ...(state.positionFamiliarity ?? initialPositionFamiliarity(player)) };
  const reps = { ...(state.positionReps ?? initialPositionReps(player)) };
  const primary = state.primaryPosition ?? player?.positioning?.primaryPosition ?? "DH";
  if (position === primary) familiarity[position] = 1;
  else {
    const current = familiarity[position] ?? 0.45;
    familiarity[position] = clamp(current + familiarityGainPerGame(player) * (1 - current), 0.35, 1);
  }
  reps[position] = (reps[position] ?? 0) + 1;
  return { familiarity, reps };
}

function createPositionPlayerSeasonState(player, positionProfile = null, developmentProfile = null) {
  const id = player?.id;
  if (typeof id !== "string" || !id) throw new TypeError("player.id가 필요합니다.");
  const profile = positionProfile ?? player?.positioning ?? { primaryPosition: "DH", familiarity: { DH: 1 } };
  const developmentOptions = developmentProfile ?? {};
  return freeze({
    playerId: id,
    primaryPosition: profile.primaryPosition ?? "DH",
    fatigue: 0,
    health: createHealthState(player, { kind: "POSITION" }),
    aging: createPositionAgingState(),
    form: 0,
    recentForm: [],
    gamesPlayed: 0,
    lastGameDate: null,
    positionFamiliarity: initialPositionFamiliarity(player, profile),
    positionReps: initialPositionReps(player, profile),
    development: createPositionDevelopmentState(player, developmentOptions)
  });
}

function normalizePositionPlayerSeasonState(state, player, positionProfile = null, developmentProfile = null) {
  const base = createPositionPlayerSeasonState(player, positionProfile, developmentProfile);
  if (!state) return base;
  const familiarity = { ...base.positionFamiliarity, ...(state.positionFamiliarity ?? {}) };
  const reps = { ...base.positionReps, ...(state.positionReps ?? {}) };
  const aging = normalizePositionAgingState(state.aging ?? null);
  let development = normalizePositionDevelopmentState(state.development ?? null, player, developmentProfile ?? {});
  if (state.development?.version !== 2 && aging.processedSeasons.length > 0) {
    development = freeze({ ...development, processedOffseasons: [...new Set([...development.processedOffseasons, ...aging.processedSeasons])].sort() });
  }
  return freeze({
    ...base,
    ...state,
    primaryPosition: state.primaryPosition ?? base.primaryPosition,
    positionFamiliarity: familiarity,
    positionReps: reps,
    health: normalizeHealthState(state.health ?? null, player, { kind: "POSITION" }),
    aging,
    development
  });
}

function fatigueBand(fatigue) {
  const value = clamp(Number(fatigue) || 0, 0, 100);
  if (value <= 20) return "FRESH";
  if (value <= 40) return "NORMAL";
  if (value <= 60) return "TIRED";
  if (value <= 80) return "FATIGUED";
  return "EXHAUSTED";
}

function formBand(form) {
  const value = clamp(Number(form) || 0, -1, 1);
  if (value >= 0.35) return "HOT";
  if (value >= 0.12) return "GOOD";
  if (value <= -0.35) return "COLD";
  if (value <= -0.12) return "POOR";
  return "NORMAL";
}

function recoverPositionPlayer(state, days = 1) {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days는 0 이상의 정수여야 합니다.");
  if (days === 0) return state;
  const recoveryPerDay = 14;
  return freeze({ ...state, fatigue: clamp(state.fatigue - recoveryPerDay * days, 0, 100), health: advanceHealthState(state.health, days) });
}

function gameWorkload(position, appearanceType = "START") {
  if (appearanceType === "PINCH_HIT") return 5;
  if (appearanceType === "PINCH_RUN") return 4;
  if (appearanceType === "DEFENSIVE_REPLACEMENT") return 7;
  if (position === "C") return 20;
  if (position === "DH") return 10;
  return 17;
}

function formScore(line) {
  const PA = Number(line?.PA ?? 0);
  if (PA <= 0) return 0;
  const H = Number(line?.H ?? 0);
  const doubles = Number(line?.doubles ?? 0);
  const triples = Number(line?.triples ?? 0);
  const HR = Number(line?.HR ?? 0);
  const BB = Number(line?.BB ?? 0);
  const HBP = Number(line?.HBP ?? 0);
  const SO = Number(line?.SO ?? 0);
  const singles = Math.max(0, H - doubles - triples - HR);
  const weighted = singles + doubles * 1.55 + triples * 2.0 + HR * 2.45 + (BB + HBP) * 0.72 - SO * 0.12;
  const perPA = weighted / PA;
  return clamp((perPA - 0.33) / 0.55, -1, 1);
}

function redistributeDevelopmentDelta(delta, focus) {
  if (focus === "BALANCED") return { ...delta };
  if (!TRAINING_FOCUSES.includes(focus)) throw new RangeError(`지원하지 않는 Training Focus입니다: ${focus}`);

  // Training focus changes allocation, not the amount of development earned.
  // This preserves v13's total in-season growth budget and only redirects 25%
  // of non-focused progress into the selected training area.
  const share = 0.25;
  const next = { ...delta };
  const targets = focus === "PLATE_DISCIPLINE"
    ? ["vision", "discipline"]
    : [focus.toLowerCase()];
  const targetSet = new Set(targets);
  let redirected = 0;

  for (const tool of Object.keys(next)) {
    if (targetSet.has(tool)) continue;
    const amount = next[tool] * share;
    next[tool] -= amount;
    redirected += amount;
  }
  for (const tool of targets) next[tool] += redirected / targets.length;
  return next;
}

function setPositionPlayerTrainingFocus(state, focus) {
  if (!state?.development) throw new TypeError("position-player season state가 필요합니다.");
  if (!TRAINING_FOCUSES.includes(focus)) throw new RangeError(`지원하지 않는 Training Focus입니다: ${focus}`);
  return freeze({
    ...state,
    development: { ...state.development, focus }
  });
}

function currentToolRating(player, gains, tool) {
  const hitting = player.hitting ?? {};
  const fielding = player.fielding ?? {};
  const running = player.running ?? {};
  const tendencies = player.tendencies ?? {};
  if (tool === "contact") return Math.max(hitting.contactR ?? 50, hitting.contactL ?? 50) + gains.contact;
  if (tool === "power") return Math.max(tendencies.powerUtilizationR ?? 50, tendencies.powerUtilizationL ?? 50) + gains.power;
  if (tool === "vision") return (hitting.vision ?? 50) + gains.vision;
  if (tool === "discipline") return (hitting.discipline ?? 50) + gains.discipline;
  if (tool === "defense") return Math.max(fielding.fielding ?? 50, fielding.reaction ?? 50) + gains.defense;
  if (tool === "speed") return (running.speed ?? 50) + gains.speed;
  return 50;
}

function convertProgressToGains(player, development, progress) {
  const gains = { ...development.gains };
  const nextProgress = { ...progress };
  for (const tool of Object.keys(nextProgress)) {
    while (nextProgress[tool] >= 1) {
      const current = currentToolRating(player, gains, tool);
      const ceiling = development.ceilings[tool];
      if (current >= ceiling) {
        nextProgress[tool] = Math.min(nextProgress[tool], 0.99);
        break;
      }
      gains[tool] += 1;
      nextProgress[tool] -= 1;
    }
  }
  return { gains, progress: nextProgress };
}

function currentDevelopmentRatings(player, state) {
  const gains = state.development.gains;
  const ageMods = normalizePositionAgingState(state.aging).modifiers;
  const hitting = player.hitting ?? {}, fielding = player.fielding ?? {}, running = player.running ?? {}, tendencies = player.tendencies ?? {};
  return {
    contact: Math.max(hitting.contactR ?? 50, hitting.contactL ?? 50) + gains.contact + ageMods.contact,
    power: Math.max(tendencies.powerUtilizationR ?? hitting.rawPower ?? 50, tendencies.powerUtilizationL ?? hitting.rawPower ?? 50) + gains.power + ageMods.power,
    vision: (hitting.vision ?? 50) + gains.vision + ageMods.vision,
    discipline: (hitting.discipline ?? 50) + gains.discipline + ageMods.discipline,
    defense: Math.max((fielding.fielding ?? 50) + ageMods.fielding, (fielding.reaction ?? 50) + ageMods.reaction) + gains.defense,
    speed: (running.speed ?? 50) + gains.speed + ageMods.speed
  };
}

function applyPositionPlayerGame(state, player, { battingLine, position = "DH", date = null, appearanceType = "START", level = "AAA", developmentMultiplier = 1 } = {}) {
  if (!Number.isFinite(developmentMultiplier) || developmentMultiplier <= 0) throw new RangeError("developmentMultiplier는 0보다 큰 유한한 값이어야 합니다.");
  const positionState = applyPositionFamiliarityRep(state, player, position);
  const recent = [...state.recentForm, formScore(battingLine)].slice(-MAX_RECENT_FORM_GAMES);
  const form = recent.length ? recent.reduce((sum, value, index) => sum + value * (index + 1), 0) / recent.reduce((sum, _value, index) => sum + index + 1, 0) : 0;
  const delta = redistributeDevelopmentDelta(positionDevelopmentDelta({
    player,
    development: state.development,
    battingLine,
    position,
    appearanceType,
    age: state.health?.age,
    level,
    currentRatings: currentDevelopmentRatings(player, state)
  }), state.development.focus ?? "BALANCED");
  const devProgress = Object.fromEntries(Object.keys(state.development.progress).map((tool) => [tool, state.development.progress[tool] + (delta[tool] ?? 0) * developmentMultiplier]));
  const converted = convertProgressToGains(player, state.development, devProgress);
  return freeze({
    ...state,
    fatigue: clamp(state.fatigue + gameWorkload(position, appearanceType), 0, 100),
    form: clamp(form, -1, 1),
    recentForm: recent,
    gamesPlayed: state.gamesPlayed + 1,
    lastGameDate: date ?? state.lastGameDate,
    positionFamiliarity: positionState.familiarity,
    positionReps: positionState.reps,
    development: {
      ...state.development,
      progress: converted.progress,
      gains: converted.gains
    }
  });
}

function applyAnnualPositionPlayerDevelopment(state, player, { seasonKey } = {}) {
  if (!state?.development || state.playerId !== player?.id) throw new TypeError("position-player development에는 일치하는 state/player가 필요합니다.");
  const result = applyAnnualPositionDevelopment(state.development, player, {
    seasonKey,
    age: state.health?.age,
    currentRatings: currentDevelopmentRatings(player, state)
  });
  if (!result.applied) return freeze({ state, applied: false, outcome: null });
  return freeze({ state: freeze({ ...state, development: result.development }), applied: true, outcome: result.outcome });
}

function applyDelta(value, delta) {
  return clampRating((value ?? 50) + delta);
}

/**
 * Return the player's current developed talent without temporary Form/Fatigue.
 * Hidden development rate/ceilings remain inside the season state and are not
 * surfaced by this helper. Canonical base ratings remain untouched.
 */
function getSeasonDevelopedPlayer(player, state) {
  if (!state) return player;
  const gains = state.development.gains;
  const aging = normalizePositionAgingState(state.aging);
  const ageMods = aging.modifiers;
  return freeze({
    ...player,
    positioning: {
      ...(player.positioning ?? {}),
      primaryPosition: state.primaryPosition ?? player.positioning?.primaryPosition ?? "DH",
      familiarity: { ...(state.positionFamiliarity ?? player.positioning?.familiarity ?? {}) }
    },
    hitting: {
      ...player.hitting,
      contactR: applyDelta(player.hitting.contactR, gains.contact + ageMods.contact),
      contactL: applyDelta(player.hitting.contactL, gains.contact + ageMods.contact),
      rawPower: applyDelta(player.hitting.rawPower, Math.floor(gains.power * 0.35) + Math.ceil(ageMods.power * 0.5)),
      vision: applyDelta(player.hitting.vision, gains.vision + ageMods.vision),
      discipline: applyDelta(player.hitting.discipline, gains.discipline + ageMods.discipline)
    },
    tendencies: {
      ...player.tendencies,
      powerUtilizationR: applyDelta(player.tendencies.powerUtilizationR, gains.power + ageMods.power),
      powerUtilizationL: applyDelta(player.tendencies.powerUtilizationL, gains.power + ageMods.power)
    },
    fielding: {
      ...player.fielding,
      fielding: applyDelta(player.fielding.fielding, gains.defense + ageMods.fielding),
      reaction: applyDelta(player.fielding.reaction, gains.defense + ageMods.reaction),
      armStrength: applyDelta(player.fielding.armStrength, ageMods.armStrength),
      armAccuracy: applyDelta(player.fielding.armAccuracy, ageMods.armAccuracy)
    },
    running: {
      ...player.running,
      speed: applyDelta(player.running.speed, gains.speed + ageMods.speed)
    }
  });
}

/**
 * Return a game-only Player snapshot. Development changes current talent;
 * Form/Fatigue are temporary context effects layered on top.
 */
function getSeasonEffectivePlayer(player, state) {
  if (!state) return player;
  const developed = getSeasonDevelopedPlayer(player, state);
  const formDelta = Math.round(clamp(state.form, -1, 1) * 2);
  const fatigue = clamp(state.fatigue, 0, 100);
  const contactFatigue = Math.round((fatigue / 100) * 3);
  const speedFatigue = Math.round((fatigue / 100) * 5);
  const reactionFatigue = Math.round((fatigue / 100) * 5);
  const accuracyFatigue = Math.round((fatigue / 100) * 3);

  return freeze({
    ...developed,
    hitting: {
      ...developed.hitting,
      contactR: applyDelta(developed.hitting.contactR, formDelta - contactFatigue),
      contactL: applyDelta(developed.hitting.contactL, formDelta - contactFatigue),
      vision: applyDelta(developed.hitting.vision, Math.round(formDelta * 0.5))
    },
    fielding: {
      ...developed.fielding,
      reaction: applyDelta(developed.fielding.reaction, -reactionFatigue),
      armAccuracy: applyDelta(developed.fielding.armAccuracy, -accuracyFatigue)
    },
    running: {
      ...developed.running,
      speed: applyDelta(developed.running.speed, -speedFatigue)
    }
  });
}

function getPositionPlayerSeasonView(state) {
  if (!state) return null;
  return freeze({
    fatigue: Number(state.fatigue.toFixed(1)),
    fatigueBand: fatigueBand(state.fatigue),
    health: getHealthPublicView(state.health),
    form: Number(state.form.toFixed(3)),
    formBand: formBand(state.form),
    gamesPlayed: state.gamesPlayed,
    positionFamiliarity: Object.fromEntries(Object.entries(state.positionFamiliarity ?? {}).map(([key, value]) => [key, Number(value.toFixed(3))])),
    positionReps: { ...(state.positionReps ?? {}) },
    development: {
      focus: state.development.focus,
      progress: Object.fromEntries(Object.entries(state.development.progress).map(([key, value]) => [key, Number(value.toFixed(3))])),
      gains: { ...state.development.gains }
    }
  });
}

export { TRAINING_FOCUSES, createPositionPlayerSeasonState, normalizePositionPlayerSeasonState, fatigueBand, formBand, recoverPositionPlayer, setPositionPlayerTrainingFocus, applyPositionPlayerGame, applyAnnualPositionPlayerDevelopment, getSeasonDevelopedPlayer, getSeasonEffectivePlayer, getPositionPlayerSeasonView };
