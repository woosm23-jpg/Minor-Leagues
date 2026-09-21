import { calibrationConfig } from "../../config/calibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const BATTED_BALL_TYPES = Object.freeze(["GB", "LD", "FB", "PU"]);

function assertContext(context) {
  if (!context || typeof context !== "object" || !context.hitter) {
    throw new TypeError("Launch Angle 계산에는 resolved PA context가 필요합니다.");
  }
  ratingToLatent(context.hitter.launchTendency);
}

function assertContactQuality(contactQuality) {
  if (
    !contactQuality ||
    typeof contactQuality !== "object" ||
    typeof contactQuality.latent !== "number" ||
    !Number.isFinite(contactQuality.latent)
  ) {
    throw new TypeError("Launch Angle 계산에는 유효한 Contact Quality가 필요합니다.");
  }
}

function softmax(logits) {
  const max = Math.max(...Object.values(logits));
  const weights = Object.fromEntries(
    Object.entries(logits).map(([key, value]) => [key, Math.exp(value - max)])
  );
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.freeze(
    Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]))
  );
}

function sampleCategorical(probabilities, rng) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("Launch Angle sampling에는 next()를 제공하는 RNG가 필요합니다.");
  }

  let roll = rng.next();
  for (const type of BATTED_BALL_TYPES) {
    const probability = probabilities[type];
    if (typeof probability !== "number" || probability < 0 || !Number.isFinite(probability)) {
      throw new TypeError(`유효하지 않은 ${type} 확률입니다.`);
    }
    if (roll < probability) return type;
    roll -= probability;
  }
  return "PU";
}

/**
 * One-uniform triangular sampler. Fixed RNG consumption keeps save/checkpoint
 * reasoning simple while avoiding hard piles at the batted-ball boundaries.
 */
function sampleTriangular(min, mode, max, rng) {
  if (!(min <= mode && mode <= max) || min === max) {
    throw new RangeError("유효하지 않은 triangular 분포 파라미터입니다.");
  }
  const u = rng.next();
  const f = (mode - min) / (max - min);
  if (u < f) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/**
 * MLB/Statcast guideline classification from numeric launch angle.
 * The numeric angle is authoritative; BIP type is always derived from it.
 */
function classifyBattedBallType(degrees) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) {
    throw new TypeError("Launch Angle은 유한한 number여야 합니다.");
  }
  if (degrees < 10) return "GB";
  if (degrees < 25) return "LD";
  if (degrees <= 50) return "FB";
  return "PU";
}

/**
 * Launch tendency changes the shape of contact, not its overall quality.
 * A high tendency shifts probability from grounders toward air balls. The
 * baseline logits reproduce the completed 2025 MLB batted-ball profile for a
 * 50-tendency BALANCED hitter before sampling variance.
 */
function getLaunchTypeProbabilities(context, config = calibrationConfig) {
  assertContext(context);
  const params = config.launchAngle;
  const tendencyZ = ratingToLatent(context.hitter.launchTendency);
  const approach = context.approach ?? "BALANCED";
  const approachAdjustment = params.approachLogitAdjustments[approach];
  if (!approachAdjustment) {
    throw new RangeError(`Launch Angle approach 설정이 없습니다: ${approach}`);
  }

  const logits = {};
  for (const type of BATTED_BALL_TYPES) {
    const base = params.neutralTypeRates[type];
    logits[type] =
      Math.log(base) +
      params.tendencyScale * params.tendencyLogitLoadings[type] * tendencyZ +
      approachAdjustment[type];
  }
  return softmax(logits);
}

function getTypeModeDegrees(type, contactQuality, config) {
  const profile = config.launchAngle.typeProfiles[type];
  const shifted = profile.mode + profile.qualityModeShiftPerLatent * contactQuality.latent;
  const epsilon = 1e-6;
  return Math.min(profile.max - epsilon, Math.max(profile.min + epsilon, shifted));
}

function isLaunchAngleSweetSpot(degrees, config = calibrationConfig) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) {
    throw new TypeError("Launch Angle은 유한한 number여야 합니다.");
  }
  const { min, max } = config.launchAngle.sweetSpotDegrees;
  return degrees >= min && degrees <= max;
}

/**
 * Sample a numeric launch angle, then derive GB/LD/FB/PU from that final value.
 *
 * The mixture component is only a calibrated generator for the continuous LA
 * distribution. It is not an independently authoritative BIP result. Contact
 * Quality nudges each component's mode toward/away from more useful angles,
 * while hitter launch tendency controls ground/air frequency.
 */
function sampleLaunchAngle(context, contactQuality, rng, config = calibrationConfig) {
  assertContext(context);
  assertContactQuality(contactQuality);
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("sampleLaunchAngle에는 next()를 제공하는 RNG가 필요합니다.");
  }

  const probabilities = getLaunchTypeProbabilities(context, config);
  const component = sampleCategorical(probabilities, rng);
  const profile = config.launchAngle.typeProfiles[component];
  const modeDegrees = getTypeModeDegrees(component, contactQuality, config);
  const degrees = sampleTriangular(profile.min, modeDegrees, profile.max, rng);
  const type = classifyBattedBallType(degrees);

  // Component ranges are deliberately aligned to Statcast thresholds. If this
  // invariant ever breaks after calibration edits, fail loudly rather than
  // allowing numeric LA and BIP type to disagree.
  if (type !== component) {
    throw new Error(`Launch Angle component/type 불일치: component=${component}, LA=${degrees}, type=${type}`);
  }

  return Object.freeze({
    degrees,
    type,
    sweetSpot: isLaunchAngleSweetSpot(degrees, config),
    component,
    modeDegrees,
    probabilities
  });
}

export { BATTED_BALL_TYPES, classifyBattedBallType, getLaunchTypeProbabilities, isLaunchAngleSweetSpot, sampleLaunchAngle };
