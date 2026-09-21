import { SeededRng } from "../rng.js";
import { createPhase1Hitter } from "./playerFixtures.js";

const AMATEUR_PROFILE_VERSION = 3;
const AMATEUR_PROFILE_GENERATION_SEED_VERSION = 2;

const USER_PRIMARY_POSITIONS = Object.freeze(["1B", "2B", "3B", "SS", "LF", "CF", "RF"]);
const BODY_TYPES = Object.freeze(["LEAN", "AVERAGE", "ATHLETIC", "STURDY", "POWER_FRAME"]);
const STARTING_ARCHETYPES = Object.freeze([
  "HIT_FIRST",
  "POWER_FIRST",
  "POWER_SPEED",
  "GLOVE_FIRST",
  "ATHLETIC",
  "DISCIPLINE_FIRST",
  "RAW_TOOLS",
  "BALANCED"
]);

const VISIBLE_TRAITS = Object.freeze([
  "QUICK_BAT",
  "RAW_STRENGTH",
  "ADVANCED_APPROACH",
  "TWO_STRIKE_HITTER",
  "PULL_POWER",
  "ALL_FIELDS_HITTER",
  "FASTBALL_HUNTER",
  "BREAKING_BALL_HITTER",
  "SOFT_HANDS",
  "QUICK_FIRST_STEP",
  "STRONG_ARM",
  "ACCURATE_ARM",
  "VERSATILE",
  "ELITE_BURST",
  "AGGRESSIVE_RUNNER",
  "SMART_BASERUNNER",
  "BASE_STEALER"
]);

const HIDDEN_DEVELOPMENT_TRAITS = Object.freeze([
  "LATE_BLOOMER",
  "EARLY_DEVELOPER",
  "HIGH_VARIANCE",
  "POLISHED"
]);

const CORE_TOOLS = Object.freeze([
  "contact",
  "power",
  "vision",
  "discipline",
  "defense",
  "reaction",
  "arm",
  "speed"
]);

const ARCHETYPE_WEIGHTS = Object.freeze({
  HIT_FIRST:            { contact: 1.55, power: 0.85, vision: 1.25, discipline: 1.10, defense: 0.90, reaction: 0.95, arm: 0.85, speed: 0.95 },
  POWER_FIRST:          { contact: 0.90, power: 1.75, vision: 0.85, discipline: 1.00, defense: 0.85, reaction: 0.85, arm: 1.00, speed: 0.80 },
  POWER_SPEED:          { contact: 0.95, power: 1.45, vision: 0.90, discipline: 0.90, defense: 0.90, reaction: 1.05, arm: 0.95, speed: 1.45 },
  GLOVE_FIRST:          { contact: 0.90, power: 0.75, vision: 0.95, discipline: 0.95, defense: 1.65, reaction: 1.50, arm: 1.25, speed: 1.05 },
  ATHLETIC:             { contact: 0.95, power: 1.00, vision: 0.90, discipline: 0.90, defense: 1.15, reaction: 1.30, arm: 1.20, speed: 1.50 },
  DISCIPLINE_FIRST:     { contact: 1.05, power: 0.90, vision: 1.55, discipline: 1.65, defense: 0.85, reaction: 0.90, arm: 0.80, speed: 0.90 },
  RAW_TOOLS:            { contact: 0.82, power: 1.55, vision: 0.70, discipline: 0.72, defense: 1.05, reaction: 1.25, arm: 1.35, speed: 1.35 },
  BALANCED:             { contact: 1.00, power: 1.00, vision: 1.00, discipline: 1.00, defense: 1.00, reaction: 1.00, arm: 1.00, speed: 1.00 }
});


const BODY_TYPE_WEIGHTS = Object.freeze({
  LEAN:        { power: 0.97, defense: 1.02, reaction: 1.04, arm: 0.99, speed: 1.06 },
  AVERAGE:     { contact: 1.00, power: 1.00, vision: 1.00, discipline: 1.00, defense: 1.00, reaction: 1.00, arm: 1.00, speed: 1.00 },
  ATHLETIC:    { power: 0.99, defense: 1.03, reaction: 1.04, arm: 1.02, speed: 1.05 },
  STURDY:      { contact: 1.01, power: 1.04, defense: 1.01, reaction: 0.99, arm: 1.03, speed: 0.96 },
  POWER_FRAME: { contact: 0.98, power: 1.07, defense: 0.98, reaction: 0.97, arm: 1.04, speed: 0.94 }
});

const POSITION_WEIGHTS = Object.freeze({
  "1B": { power: 1.10, defense: 0.98, arm: 0.93, speed: 0.82 },
  "2B": { contact: 1.04, defense: 1.10, reaction: 1.12, speed: 1.08, arm: 0.96 },
  "3B": { power: 1.05, defense: 1.04, reaction: 1.03, arm: 1.15, speed: 0.92 },
  SS:   { defense: 1.15, reaction: 1.17, arm: 1.10, speed: 1.10, power: 0.92 },
  LF:   { power: 1.07, arm: 0.97, defense: 0.95, speed: 0.98 },
  CF:   { defense: 1.08, reaction: 1.12, speed: 1.20, arm: 1.02, power: 0.96 },
  RF:   { power: 1.04, arm: 1.16, defense: 1.02, speed: 1.00 }
});

const TRAIT_TILTS = Object.freeze({
  QUICK_BAT:             { contact: 1.13 },
  RAW_STRENGTH:          { power: 1.16 },
  ADVANCED_APPROACH:     { vision: 1.10, discipline: 1.13 },
  TWO_STRIKE_HITTER:     { contact: 1.07, vision: 1.06 },
  PULL_POWER:            { power: 1.09 },
  ALL_FIELDS_HITTER:     { contact: 1.06, vision: 1.05 },
  FASTBALL_HUNTER:       { contact: 1.06, power: 1.04 },
  BREAKING_BALL_HITTER:  { vision: 1.09, contact: 1.04 },
  SOFT_HANDS:            { defense: 1.12 },
  QUICK_FIRST_STEP:      { reaction: 1.13 },
  STRONG_ARM:            { arm: 1.15 },
  ACCURATE_ARM:          { arm: 1.08, defense: 1.04 },
  VERSATILE:             { defense: 1.04, reaction: 1.04 },
  ELITE_BURST:           { speed: 1.14, reaction: 1.04 },
  AGGRESSIVE_RUNNER:     { speed: 1.05 },
  SMART_BASERUNNER:      { speed: 1.04, vision: 1.03 },
  BASE_STEALER:          { speed: 1.10 }
});

const SECONDARY_BY_PRIMARY = Object.freeze({
  "1B": { LF: 0.58 },
  "2B": { SS: 0.70, "3B": 0.64 },
  "3B": { "1B": 0.70, "2B": 0.58 },
  SS: { "2B": 0.76, "3B": 0.66 },
  LF: { RF: 0.70, CF: 0.56 },
  CF: { LF: 0.76, RF: 0.76 },
  RF: { LF: 0.70, CF: 0.58 }
});

const TRAIT_TENDENCY_EFFECTS = Object.freeze({
  PULL_POWER: { sprayPull: 8, sprayCenter: -4, sprayOppo: -4, launchTendency: 3 },
  ALL_FIELDS_HITTER: { sprayPull: -3, sprayCenter: 1, sprayOppo: 2 },
  RAW_STRENGTH: { powerUtilizationR: 3, powerUtilizationL: 3 },
  QUICK_BAT: { powerUtilizationR: 1, powerUtilizationL: 1 },
  AGGRESSIVE_RUNNER: { runnerAggression: 9 },
  SMART_BASERUNNER: { runnerDecision: 9 },
  BASE_STEALER: { stealIntent: 10 },
  VERSATILE: { adaptability: 12 }
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundRating(value) {
  return clamp(Math.round(value), 20, 99);
}

function assertChoice(value, allowed, label) {
  if (!allowed.includes(value)) throw new RangeError(`${label} 값이 올바르지 않습니다: ${value}`);
}

function normalizeTraits(traits) {
  if (!Array.isArray(traits)) throw new TypeError("visibleTraits는 배열이어야 합니다.");
  const unique = [...new Set(traits)];
  if (unique.length !== traits.length) throw new RangeError("visibleTraits에 중복 특성을 넣을 수 없습니다.");
  if (unique.length > 2) throw new RangeError("visibleTraits는 최대 2개까지 선택할 수 있습니다.");
  unique.forEach((trait) => assertChoice(trait, VISIBLE_TRAITS, "visible trait"));
  return unique;
}

function weightedNoise(rng) {
  // Centered, bounded noise. Avoids a single lucky roll dominating the profile.
  return (rng.next() + rng.next() + rng.next() - 1.5) / 1.5;
}

function buildWeights(archetype, primaryPosition, visibleTraits, bodyType = "AVERAGE") {
  const weights = { ...ARCHETYPE_WEIGHTS[archetype] };
  const body = BODY_TYPE_WEIGHTS[bodyType] ?? BODY_TYPE_WEIGHTS.AVERAGE;
  for (const [tool, multiplier] of Object.entries(body)) weights[tool] *= multiplier;
  const position = POSITION_WEIGHTS[primaryPosition] ?? {};
  for (const [tool, multiplier] of Object.entries(position)) weights[tool] *= multiplier;
  for (const trait of visibleTraits) {
    for (const [tool, multiplier] of Object.entries(TRAIT_TILTS[trait] ?? {})) weights[tool] *= multiplier;
  }
  return weights;
}

function allocateControlledTalent({ rng, weights, age }) {
  // Older amateur starters are slightly more ready now, but younger starters keep more ceiling room.
  // Total current-talent budget stays tightly controlled so archetype/traits reallocate talent
  // instead of granting free extra talent.
  const readiness = (age - 18) * 1.35;
  const base = 39 + readiness;
  const totalBudget = 92 + readiness * 1.2;
  const jittered = {};
  let totalWeight = 0;
  for (const tool of CORE_TOOLS) {
    const noise = 1 + weightedNoise(rng) * 0.11;
    jittered[tool] = Math.max(0.25, weights[tool] * noise);
    totalWeight += jittered[tool];
  }

  const ratings = {};
  for (const tool of CORE_TOOLS) {
    const share = jittered[tool] / totalWeight;
    ratings[tool] = roundRating(base + totalBudget * share * CORE_TOOLS.length / 8);
  }

  // Tiny zero-sum correction keeps aggregate starting talent within a narrow band after rounding.
  const targetSum = Math.round((base * CORE_TOOLS.length) + totalBudget);
  let delta = targetSum - CORE_TOOLS.reduce((sum, tool) => sum + ratings[tool], 0);
  const correctionOrder = [...CORE_TOOLS].sort((a, b) => jittered[b] - jittered[a]);
  let cursor = 0;
  while (delta !== 0 && cursor < 200) {
    const tool = correctionOrder[cursor % correctionOrder.length];
    const step = delta > 0 ? 1 : -1;
    const next = ratings[tool] + step;
    if (next >= 20 && next <= 99) {
      ratings[tool] = next;
      delta -= step;
    }
    cursor += 1;
  }
  return ratings;
}

function createCeilings({ rng, ratings, age, hiddenTrait }) {
  const youngRoom = (22 - age) * 1.35;
  const traitRoom = hiddenTrait === "LATE_BLOOMER" ? 3.5
    : hiddenTrait === "EARLY_DEVELOPER" ? -1.5
      : hiddenTrait === "HIGH_VARIANCE" ? 1.8
        : 0;
  return Object.freeze(Object.fromEntries(CORE_TOOLS.map((tool) => {
    const variance = 5 + rng.next() * 7;
    const room = variance + youngRoom + traitRoom + (hiddenTrait === "HIGH_VARIANCE" ? weightedNoise(rng) * 4 : 0);
    return [tool, roundRating(Math.max(ratings[tool] + 3, ratings[tool] + room))];
  })));
}

function hiddenDevelopmentTrait(rng) {
  return HIDDEN_DEVELOPMENT_TRAITS[Math.floor(rng.next() * HIDDEN_DEVELOPMENT_TRAITS.length)];
}

function buildTendencies({ visibleTraits, ratings, rng }) {
  const base = {
    powerUtilizationR: roundRating(ratings.power - 2 + weightedNoise(rng) * 3),
    powerUtilizationL: roundRating(ratings.power - 2 + weightedNoise(rng) * 3),
    launchTendency: roundRating(48 + (ratings.power - 50) * 0.16 + weightedNoise(rng) * 4),
    sprayPull: 50,
    sprayCenter: 50,
    sprayOppo: 50,
    runnerAggression: 50,
    runnerDecision: 50,
    stealIntent: 50,
    adaptability: 50
  };
  for (const trait of visibleTraits) {
    for (const [key, amount] of Object.entries(TRAIT_TENDENCY_EFFECTS[trait] ?? {})) {
      base[key] = clamp((base[key] ?? 50) + amount, 20, 99);
    }
  }
  return base;
}

function buildSecondaryPositions(primaryPosition, visibleTraits) {
  const base = { ...(SECONDARY_BY_PRIMARY[primaryPosition] ?? {}) };
  if (visibleTraits.includes("VERSATILE")) {
    for (const position of USER_PRIMARY_POSITIONS) {
      if (position === primaryPosition) continue;
      if (base[position] == null && position !== "1B") continue;
      if (base[position] != null) base[position] = Math.min(0.80, base[position] + 0.08);
    }
  }
  return Object.freeze(base);
}

function validateAge(age) {
  if (!Number.isInteger(age) || age < 18 || age > 22) {
    throw new RangeError("starting age는 18~22 정수여야 합니다.");
  }
}

/**
 * Deterministic, save-safe starting-profile generator used by the v40 New Career flow.
 * Existing legacy/demo careers remain separate regression anchors.
 */
function generateAmateurPositionPlayer({
  seed,
  id = "user_player",
  age = 20,
  bats = "R",
  throws = "R",
  primaryPosition = "CF",
  bodyType = "AVERAGE",
  archetype = "BALANCED",
  visibleTraits = []
} = {}) {
  if (seed == null || seed === "") throw new TypeError("seed가 필요합니다.");
  if (typeof id !== "string" || !id.trim()) throw new TypeError("id가 필요합니다.");
  validateAge(age);
  assertChoice(primaryPosition, USER_PRIMARY_POSITIONS, "primary position");
  assertChoice(bodyType, BODY_TYPES, "body type");
  assertChoice(archetype, STARTING_ARCHETYPES, "archetype");
  assertChoice(bats, ["R", "L", "S"], "bats");
  assertChoice(throws, ["R", "L"], "throws");
  const traits = normalizeTraits(visibleTraits);

  const rng = new SeededRng(`amateur-profile-v${AMATEUR_PROFILE_GENERATION_SEED_VERSION}:${seed}:${id}`);
  const hiddenTrait = hiddenDevelopmentTrait(rng);
  const weights = buildWeights(archetype, primaryPosition, traits, bodyType);
  const ratings = allocateControlledTalent({ rng, weights, age });
  const ceilings = createCeilings({ rng, ratings, age, hiddenTrait });
  const tendencies = buildTendencies({ visibleTraits: traits, ratings, rng });
  const devRng = new SeededRng(`amateur-development-v${AMATEUR_PROFILE_VERSION}:${seed}:${id}`);
  const rateTrait = hiddenTrait === "EARLY_DEVELOPER" ? 0.04 : hiddenTrait === "LATE_BLOOMER" ? -0.02 : hiddenTrait === "POLISHED" ? 0.02 : 0;
  const developmentRate = Number(clamp(0.86 + devRng.next() * 0.28 + rateTrait, 0.72, 1.28).toFixed(4));
  const workEthic = Number((0.86 + devRng.next() * 0.28).toFixed(4));
  const secondaryPositions = buildSecondaryPositions(primaryPosition, traits);

  const stealing = roundRating(ratings.speed + (traits.includes("BASE_STEALER") ? 5 : 0));
  const baserunning = roundRating((ratings.speed + ratings.vision) / 2 + (traits.includes("SMART_BASERUNNER") ? 4 : 0));
  const hitter = createPhase1Hitter({
    id,
    bats,
    throws,
    contactR: ratings.contact,
    contactL: roundRating(ratings.contact + weightedNoise(rng) * 2.5),
    rawPower: ratings.power,
    vision: ratings.vision,
    discipline: ratings.discipline,
    powerUtilizationR: tendencies.powerUtilizationR,
    powerUtilizationL: tendencies.powerUtilizationL,
    launchTendency: tendencies.launchTendency,
    sprayPull: tendencies.sprayPull,
    sprayCenter: tendencies.sprayCenter,
    sprayOppo: tendencies.sprayOppo,
    speed: ratings.speed,
    stealing,
    baserunning,
    fielding: ratings.defense,
    reaction: ratings.reaction,
    armStrength: ratings.arm,
    armAccuracy: roundRating((ratings.arm + ratings.defense) / 2),
    primaryPosition,
    secondaryPositions,
    adaptability: tendencies.adaptability
  });

  return Object.freeze({
    version: AMATEUR_PROFILE_VERSION,
    player: hitter,
    startingProfile: Object.freeze({
      age,
      primaryPosition,
      bodyType,
      archetype,
      visibleTraits: Object.freeze([...traits]),
      // This exists in authoritative state for future development, but UI/read models must not expose it.
      hiddenDevelopmentTrait: hiddenTrait,
      developmentRate,
      workEthic,
      ceilings,
      tendencies: Object.freeze({
        runnerAggression: tendencies.runnerAggression,
        runnerDecision: tendencies.runnerDecision,
        stealIntent: tendencies.stealIntent
      }),
      talentBudget: Object.freeze({
        currentToolSum: CORE_TOOLS.reduce((sum, tool) => sum + ratings[tool], 0),
        ceilingToolSum: CORE_TOOLS.reduce((sum, tool) => sum + ceilings[tool], 0)
      })
    })
  });
}

/** Player-safe preview for v40 creation UI. Hidden traits/ceilings are deliberately omitted. */
function getAmateurProfilePreview(generated) {
  if (!generated?.player || !generated?.startingProfile) throw new TypeError("generated amateur profile이 필요합니다.");
  const { player, startingProfile } = generated;
  return Object.freeze({
    version: generated.version,
    archetype: startingProfile.archetype,
    visibleTraits: Object.freeze([...startingProfile.visibleTraits]),
    age: startingProfile.age,
    primaryPosition: startingProfile.primaryPosition,
    bodyType: startingProfile.bodyType ?? "AVERAGE",
    tools: Object.freeze({
      contact: Math.round((player.hitting.contactR + player.hitting.contactL) / 2),
      power: player.hitting.rawPower,
      vision: player.hitting.vision,
      discipline: player.hitting.discipline,
      defense: player.fielding.fielding,
      reaction: player.fielding.reaction,
      arm: player.fielding.armStrength,
      speed: player.running.speed
    })
  });
}

export { AMATEUR_PROFILE_VERSION, USER_PRIMARY_POSITIONS, BODY_TYPES, STARTING_ARCHETYPES, VISIBLE_TRAITS, HIDDEN_DEVELOPMENT_TRAITS, generateAmateurPositionPlayer, getAmateurProfilePreview };
