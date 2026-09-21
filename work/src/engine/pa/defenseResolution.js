import { calibrationConfig } from "../../config/calibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const BATTED_BALL_FINAL_OUTCOMES = Object.freeze(["OUT", "ROE", "1B", "2B", "3B", "HR"]);
const DEFENSE_MODES = Object.freeze({ AGGREGATE: "AGGREGATE", FIELDERS: "FIELDERS" });
const FIELDING_POSITIONS = Object.freeze(["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);

function assertBattedBallInputs(exitVelocity, launchAngle, spray, wallClearance) {
  if (!exitVelocity || typeof exitVelocity.mph !== "number" || !Number.isFinite(exitVelocity.mph)) {
    throw new TypeError("Defense resolution에는 유효한 Exit Velocity가 필요합니다.");
  }
  if (!launchAngle || !["GB", "LD", "FB", "PU"].includes(launchAngle.type)) {
    throw new TypeError("Defense resolution에는 유효한 Launch Angle type이 필요합니다.");
  }
  if (!spray || typeof spray.fieldAngleDegrees !== "number" || !Number.isFinite(spray.fieldAngleDegrees)) {
    throw new TypeError("Defense resolution에는 유효한 Spray 결과가 필요합니다.");
  }
  if (!wallClearance || typeof wallClearance.homeRun !== "boolean") {
    throw new TypeError("Defense resolution에는 wall clearance 결과가 필요합니다.");
  }
}

function assertRating(value, label) {
  try {
    ratingToLatent(value);
  } catch (error) {
    throw new TypeError(`${label}: ${error.message}`);
  }
}

function normalizeFielder(fielder, position) {
  if (!fielder || typeof fielder !== "object") {
    throw new TypeError(`defense.fielders.${position}가 필요합니다.`);
  }
  if (typeof fielder.id !== "string" || fielder.id.length === 0) {
    throw new TypeError(`defense.fielders.${position}.id가 필요합니다.`);
  }
  if (fielder.position !== undefined && fielder.position !== position) {
    throw new RangeError(`${fielder.id}의 position이 ${position}과 일치하지 않습니다.`);
  }
  for (const key of ["reaction", "speed", "fielding", "armStrength", "armAccuracy"]) {
    assertRating(fielder[key], `defense.fielders.${position}.${key}`);
  }
  const familiarity = fielder.familiarity ?? 1;
  if (typeof familiarity !== "number" || !Number.isFinite(familiarity) || familiarity <= 0 || familiarity > 1) {
    throw new RangeError(`defense.fielders.${position}.familiarity는 0 초과 1 이하이어야 합니다.`);
  }
  return Object.freeze({
    id: fielder.id,
    position,
    reaction: fielder.reaction,
    speed: fielder.speed,
    fielding: fielder.fielding,
    armStrength: fielder.armStrength,
    armAccuracy: fielder.armAccuracy,
    familiarity
  });
}

function createNeutralDefense(config = calibrationConfig) {
  const defense = config.defense.neutralDefense;
  return Object.freeze({ mode: DEFENSE_MODES.AGGREGATE, ...defense });
}

function normalizeDefense(defense, config = calibrationConfig) {
  const resolved = defense ?? createNeutralDefense(config);
  if (resolved.mode === DEFENSE_MODES.FIELDERS || resolved.fielders) {
    const fielders = {};
    for (const position of FIELDING_POSITIONS) {
      fielders[position] = normalizeFielder(resolved.fielders?.[position], position);
    }
    return Object.freeze({ mode: DEFENSE_MODES.FIELDERS, fielders: Object.freeze(fielders) });
  }

  for (const key of ["infieldRange", "outfieldRange", "fielding"]) {
    assertRating(resolved[key], `defense.${key}`);
  }
  return Object.freeze({
    mode: DEFENSE_MODES.AGGREGATE,
    infieldRange: resolved.infieldRange,
    outfieldRange: resolved.outfieldRange,
    fielding: resolved.fielding
  });
}

function logit(p) {
  return Math.log(p / (1 - p));
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function clampProbability(p) {
  return Math.max(0.000001, Math.min(0.999999, p));
}

function sampleCategorical(probabilities, order, rng) {
  let roll = rng.next();
  for (const key of order) {
    if (roll < probabilities[key]) return key;
    roll -= probabilities[key];
  }
  return order.at(-1);
}

/**
 * Aggregate-defense hit probability for a non-HR batted ball.
 *
 * This function remains the calibration anchor. Fielder-specific defense
 * decomposes the corresponding average-fielder out probability into
 * Reaction/Speed -> Reach -> Fielding -> Throw/Race stages, so an all-50
 * alignment returns to the same league-neutral expectation.
 */
function getNonHrHitProbability(
  exitVelocity,
  launchAngle,
  spray,
  defense,
  config = calibrationConfig
) {
  if (defense?.mode === DEFENSE_MODES.FIELDERS || defense?.fielders) {
    throw new TypeError("getNonHrHitProbability에는 aggregate defense가 필요합니다.");
  }
  const params = config.defense;
  const type = launchAngle.type;
  const base = params.neutralHitProbabilityByType[type];
  const evDelta = (exitVelocity.mph - params.referenceExitVelocityMph) / 10;
  const lineProximity = Math.abs(spray.fieldAngleDegrees) / 45;

  const rangeRating = type === "GB" ? defense.infieldRange : defense.outfieldRange;
  const defenseZ =
    params.rangeWeight * ratingToLatent(rangeRating) +
    params.fieldingWeight * ratingToLatent(defense.fielding);

  let value =
    logit(base) +
    params.evLogitPer10Mph[type] * evDelta +
    params.lineAngleLogitBonus[type] * lineProximity -
    params.defenseLogitScale[type] * defenseZ;

  if (type === "LD" && exitVelocity.mph >= 95) value += params.hardLineDriveLogitBonus;
  if ((type === "FB" || type === "PU") && exitVelocity.mph < 75) value -= params.weakAirLogitPenalty;

  return logistic(value);
}

function getExtraBaseProbabilities(exitVelocity, launchAngle, spray, wallClearance, config) {
  const params = config.defense.extraBase;
  const base = params.baseWeightsByType[launchAngle.type];
  const projected = wallClearance.projectedDistanceFt;
  const wallDistance = wallClearance.wallDistanceFt;
  const denominator = Math.max(1, wallDistance - params.depthFloorFt);
  const depth = Math.max(0, Math.min(1, (projected - params.depthFloorFt) / denominator));
  const absAngle = Math.abs(spray.fieldAngleDegrees);
  const gapDistance = Math.abs(absAngle - params.gapCenterDegrees);
  const gapScore = Math.max(0, 1 - gapDistance / params.gapHalfWidthDegrees);
  const centerScore = Math.max(0, 1 - absAngle / params.centerTripleHalfWidthDegrees);

  const weights = {
    "1B": base["1B"],
    "2B": base["2B"] * (1 + params.doubleDepthBoost * depth + params.doubleGapBoost * gapScore),
    "3B": base["3B"] * (1 + params.tripleDepthBoost * depth + params.tripleGapBoost * gapScore + params.tripleCenterBoost * centerScore)
  };

  const total = weights["1B"] + weights["2B"] + weights["3B"];
  return Object.freeze({
    "1B": weights["1B"] / total,
    "2B": weights["2B"] / total,
    "3B": weights["3B"] / total
  });
}

function infieldPositionForAngle(angle, type, projectedDistanceFt, geometry) {
  if (type === "PU" && projectedDistanceFt <= geometry.catcherPopupFt && Math.abs(angle) <= geometry.catcherPopupHalfAngle) {
    return "C";
  }
  if (type === "GB" && Math.abs(angle) <= geometry.pitcherGroundBallHalfAngle) return "P";
  if (angle < geometry.thirdBaseBoundary) return "3B";
  if (angle < geometry.shortstopBoundary) return "SS";
  if (angle <= geometry.secondBaseBoundary) return "2B";
  return "1B";
}

/**
 * Assign the primary fielder from fair-territory angle, batted-ball class and
 * projected depth. This is intentionally a compact Phase 1 positioning model;
 * exact starting coordinates and wall routes are a later fidelity layer.
 */
function selectResponsibleFielder(launchAngle, spray, wallClearance, defense, config = calibrationConfig) {
  const normalized = normalizeDefense(defense, config);
  if (normalized.mode !== DEFENSE_MODES.FIELDERS) {
    throw new TypeError("selectResponsibleFielder에는 FIELDERS defense가 필요합니다.");
  }
  const geometry = config.defense.fielderSpecific.geometry;
  const angle = spray.fieldAngleDegrees;
  const depth = wallClearance.projectedDistanceFt;
  const type = launchAngle.type;

  let position;
  const useInfield =
    type === "GB" ||
    type === "PU" ||
    (type === "LD" && depth < geometry.shallowLineDriveFt) ||
    (type === "FB" && depth < geometry.shallowFlyBallFt);

  if (useInfield) {
    position = infieldPositionForAngle(angle, type, depth, geometry);
  } else if (angle < geometry.outfieldLeftBoundary) {
    position = "LF";
  } else if (angle > geometry.outfieldRightBoundary) {
    position = "RF";
  } else {
    position = "CF";
  }

  return normalized.fielders[position];
}

function familiarityLatent(familiarity) {
  // 1.0 = neutral. Lower familiarity creates a modest penalty at each stage
  // without inventing a new permanent rating.
  return (familiarity - 1) * 1.25;
}

/**
 * Return the stage probabilities for a fielder-specific non-HR opportunity.
 * Useful for debugging, calibration and player-safe explanations later.
 */
function getFielderSpecificStageProbabilities({
  exitVelocity,
  launchAngle,
  spray,
  wallClearance,
  defense,
  batterSpeed = 50,
  config = calibrationConfig
}) {
  assertBattedBallInputs(exitVelocity, launchAngle, spray, wallClearance);
  assertRating(batterSpeed, "batterSpeed");
  const normalized = normalizeDefense(defense, config);
  if (normalized.mode !== DEFENSE_MODES.FIELDERS) {
    throw new TypeError("fielder-specific probability에는 FIELDERS defense가 필요합니다.");
  }

  const params = config.defense.fielderSpecific;
  const fielder = selectResponsibleFielder(launchAngle, spray, wallClearance, normalized, config);
  const neutralDefense = createNeutralDefense(config);
  const neutralHitProbability = getNonHrHitProbability(
    exitVelocity,
    launchAngle,
    spray,
    neutralDefense,
    config
  );
  const neutralOutProbability = 1 - neutralHitProbability;
  const cleanNeutral = params.neutralCleanProbabilityByType[launchAngle.type];
  const throwNeutral = launchAngle.type === "GB" ? params.neutralGroundBallThrowProbability : 1;
  const neutralReach = clampProbability(neutralOutProbability / (cleanNeutral * throwNeutral));

  const weights = params.reachWeightsByType[launchAngle.type];
  const familiarityZ = familiarityLatent(fielder.familiarity);
  const reachZ =
    weights.reaction * ratingToLatent(fielder.reaction) +
    weights.speed * ratingToLatent(fielder.speed) +
    familiarityZ;
  const reachProbability = logistic(
    logit(neutralReach) + params.reachLogitScaleByType[launchAngle.type] * reachZ
  );

  const cleanProbability = logistic(
    logit(cleanNeutral) + params.fieldingLogitScale * (ratingToLatent(fielder.fielding) + familiarityZ)
  );

  let throwProbability = 1;
  if (launchAngle.type === "GB") {
    const throwConfig = params.groundBallThrow;
    const armZ =
      throwConfig.armStrengthWeight * ratingToLatent(fielder.armStrength) +
      throwConfig.armAccuracyWeight * ratingToLatent(fielder.armAccuracy) +
      familiarityZ;
    throwProbability = logistic(
      logit(params.neutralGroundBallThrowProbability) +
      throwConfig.armLogitScale * armZ -
      throwConfig.batterSpeedLogitScale * ratingToLatent(batterSpeed)
    );
  }

  return Object.freeze({
    fielder,
    neutralHitProbability,
    neutralOutProbability,
    reachProbability,
    cleanProbability,
    throwProbability,
    estimatedOutProbability: reachProbability * cleanProbability * throwProbability
  });
}


/**
 * Probability that an otherwise fieldable out is converted to an official
 * error. This partitions the historical non-hit BIP bucket; it does not steal
 * probability mass from calibrated hits.
 */
function getOfficialErrorProbabilities({
  launchAngle,
  stageProbabilities,
  config = calibrationConfig
}) {
  if (!launchAngle || !["GB", "LD", "FB", "PU"].includes(launchAngle.type)) {
    throw new TypeError("official error probability에는 유효한 Launch Angle type이 필요합니다.");
  }
  if (!stageProbabilities?.fielder) {
    throw new TypeError("official error probability에는 fielder stage 정보가 필요합니다.");
  }
  const params = config.defense.fielderSpecific.error;
  const fielder = stageProbabilities.fielder;
  const fieldingZ = ratingToLatent(fielder.fielding) + familiarityLatent(fielder.familiarity);
  const accuracyZ = ratingToLatent(fielder.armAccuracy) + familiarityLatent(fielder.familiarity);
  const routineDelta = (stageProbabilities.reachProbability ?? params.referenceReachProbability) - params.referenceReachProbability;
  const type = launchAngle.type;
  const base = params.neutralProbabilityOnWouldBeOutByType[type];
  const accuracyWeight = type === "GB" ? params.armAccuracySkillLogitScale : 0;
  const errorProbability = logistic(
    logit(base) -
    params.fieldingSkillLogitScale * fieldingZ -
    accuracyWeight * accuracyZ +
    params.routineOpportunityLogitScale * routineDelta
  );

  let throwingErrorShare = 0;
  if (type === "GB") {
    throwingErrorShare = logistic(
      logit(params.groundBallThrowErrorShare) +
      params.throwShareAccuracyLogitScale * (fieldingZ - accuracyZ)
    );
  }

  return Object.freeze({ errorProbability, throwingErrorShare });
}

function sampleHitOutcome(exitVelocity, launchAngle, spray, wallClearance, rng, config) {
  const extraBaseProbabilities = getExtraBaseProbabilities(
    exitVelocity,
    launchAngle,
    spray,
    wallClearance,
    config
  );
  const outcome = sampleCategorical(extraBaseProbabilities, ["1B", "2B", "3B"], rng);
  return { outcome, extraBaseProbabilities };
}

function resolveFielderSpecificDefenseOutcome({
  exitVelocity,
  launchAngle,
  spray,
  wallClearance,
  defense,
  batterSpeed,
  rng,
  config
}) {
  const stages = getFielderSpecificStageProbabilities({
    exitVelocity,
    launchAngle,
    spray,
    wallClearance,
    defense,
    batterSpeed,
    config
  });

  const reached = rng.next() < stages.reachProbability;
  if (!reached) {
    const hit = sampleHitOutcome(exitVelocity, launchAngle, spray, wallClearance, rng, config);
    return Object.freeze({
      outcome: hit.outcome,
      hit: true,
      bases: hit.outcome === "1B" ? 1 : hit.outcome === "2B" ? 2 : 3,
      hitProbability: 1 - stages.estimatedOutProbability,
      extraBaseProbabilities: hit.extraBaseProbabilities,
      defense,
      defensiveMode: DEFENSE_MODES.FIELDERS,
      responsibleFielderId: stages.fielder.id,
      responsiblePosition: stages.fielder.position,
      stageProbabilities: stages,
      stages: Object.freeze({ reached: false, fieldedCleanly: false, throwCompleted: false }),
      failureStage: "REACH"
    });
  }

  const fieldedCleanly = rng.next() < stages.cleanProbability;
  if (!fieldedCleanly) {
    return Object.freeze({
      outcome: "1B",
      hit: true,
      bases: 1,
      hitProbability: 1 - stages.estimatedOutProbability,
      extraBaseProbabilities: null,
      defense,
      defensiveMode: DEFENSE_MODES.FIELDERS,
      responsibleFielderId: stages.fielder.id,
      responsiblePosition: stages.fielder.position,
      stageProbabilities: stages,
      stages: Object.freeze({ reached: true, fieldedCleanly: false, throwCompleted: false }),
      failureStage: "FIELD"
    });
  }

  if (launchAngle.type === "GB") {
    const throwCompleted = rng.next() < stages.throwProbability;
    if (!throwCompleted) {
      return Object.freeze({
        outcome: "1B",
        hit: true,
        bases: 1,
        hitProbability: 1 - stages.estimatedOutProbability,
        extraBaseProbabilities: null,
        defense,
        defensiveMode: DEFENSE_MODES.FIELDERS,
        responsibleFielderId: stages.fielder.id,
        responsiblePosition: stages.fielder.position,
        stageProbabilities: stages,
        stages: Object.freeze({ reached: true, fieldedCleanly: true, throwCompleted: false }),
        failureStage: "THROW_RACE"
      });
    }
  }

  const officialError = getOfficialErrorProbabilities({
    launchAngle,
    stageProbabilities: stages,
    config
  });
  if (rng.next() < officialError.errorProbability) {
    const throwingError = launchAngle.type === "GB" && rng.next() < officialError.throwingErrorShare;
    return Object.freeze({
      outcome: "ROE",
      hit: false,
      reachedOnError: true,
      bases: 1,
      hitProbability: 1 - stages.estimatedOutProbability,
      errorProbability: officialError.errorProbability,
      extraBaseProbabilities: null,
      defense,
      defensiveMode: DEFENSE_MODES.FIELDERS,
      responsibleFielderId: stages.fielder.id,
      responsiblePosition: stages.fielder.position,
      error: Object.freeze({
        charged: true,
        fielderId: stages.fielder.id,
        position: stages.fielder.position,
        type: throwingError ? "THROWING" : "FIELDING"
      }),
      stageProbabilities: stages,
      stages: Object.freeze({ reached: true, fieldedCleanly: true, throwCompleted: true }),
      failureStage: throwingError ? "ERROR_THROW" : "ERROR_FIELD"
    });
  }

  return Object.freeze({
    outcome: "OUT",
    hit: false,
    reachedOnError: false,
    bases: 0,
    hitProbability: 1 - stages.estimatedOutProbability,
    errorProbability: officialError.errorProbability,
    extraBaseProbabilities: null,
    defense,
    defensiveMode: DEFENSE_MODES.FIELDERS,
    responsibleFielderId: stages.fielder.id,
    responsiblePosition: stages.fielder.position,
    error: null,
    stageProbabilities: stages,
    stages: Object.freeze({ reached: true, fieldedCleanly: true, throwCompleted: true }),
    failureStage: null
  });
}

function resolveAggregateDefenseOutcome({ exitVelocity, launchAngle, spray, wallClearance, defense, rng, config }) {
  const hitProbability = getNonHrHitProbability(
    exitVelocity,
    launchAngle,
    spray,
    defense,
    config
  );

  if (rng.next() >= hitProbability) {
    return Object.freeze({
      outcome: "OUT",
      hit: false,
      bases: 0,
      hitProbability,
      extraBaseProbabilities: null,
      defense,
      defensiveMode: DEFENSE_MODES.AGGREGATE
    });
  }

  const hit = sampleHitOutcome(exitVelocity, launchAngle, spray, wallClearance, rng, config);
  return Object.freeze({
    outcome: hit.outcome,
    hit: true,
    bases: hit.outcome === "1B" ? 1 : hit.outcome === "2B" ? 2 : 3,
    hitProbability,
    extraBaseProbabilities: hit.extraBaseProbabilities,
    defense,
    defensiveMode: DEFENSE_MODES.AGGREGATE
  });
}

function resolveDefenseOutcome({
  exitVelocity,
  launchAngle,
  spray,
  wallClearance,
  defense,
  batterSpeed = 50,
  rng,
  config = calibrationConfig
}) {
  assertBattedBallInputs(exitVelocity, launchAngle, spray, wallClearance);
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("Defense resolution에는 next()를 제공하는 RNG가 필요합니다.");
  }

  const resolvedDefense = normalizeDefense(defense, config);

  if (wallClearance.homeRun) {
    return Object.freeze({
      outcome: "HR",
      hit: true,
      bases: 4,
      hitProbability: 1,
      extraBaseProbabilities: null,
      defense: resolvedDefense,
      defensiveMode: resolvedDefense.mode,
      responsibleFielderId: null,
      responsiblePosition: null
    });
  }

  if (resolvedDefense.mode === DEFENSE_MODES.FIELDERS) {
    return resolveFielderSpecificDefenseOutcome({
      exitVelocity,
      launchAngle,
      spray,
      wallClearance,
      defense: resolvedDefense,
      batterSpeed,
      rng,
      config
    });
  }

  return resolveAggregateDefenseOutcome({
    exitVelocity,
    launchAngle,
    spray,
    wallClearance,
    defense: resolvedDefense,
    rng,
    config
  });
}

export { BATTED_BALL_FINAL_OUTCOMES, DEFENSE_MODES, FIELDING_POSITIONS, createNeutralDefense, normalizeDefense, getNonHrHitProbability, selectResponsibleFielder, getFielderSpecificStageProbabilities, getOfficialErrorProbabilities, resolveDefenseOutcome };
