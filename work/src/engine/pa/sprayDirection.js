import { calibrationConfig } from "../../config/calibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const SPRAY_ZONES = Object.freeze(["PULL", "CENTER", "OPPO"]);

function assertContext(context) {
  if (!context || typeof context !== "object" || !context.hitter || !context.matchup) {
    throw new TypeError("Spray 계산에는 resolved PA context가 필요합니다.");
  }
  for (const key of ["sprayPull", "sprayCenter", "sprayOppo"]) {
    ratingToLatent(context.hitter[key]);
  }
  if (!['R', 'L'].includes(context.matchup.batterSide)) {
    throw new RangeError("Spray 계산에는 R/L batterSide가 필요합니다.");
  }
}

function assertLaunchAngle(launchAngle) {
  if (
    !launchAngle ||
    typeof launchAngle !== "object" ||
    typeof launchAngle.degrees !== "number" ||
    !Number.isFinite(launchAngle.degrees) ||
    !["GB", "LD", "FB", "PU"].includes(launchAngle.type)
  ) {
    throw new TypeError("Spray 계산에는 유효한 Launch Angle 결과가 필요합니다.");
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
    throw new TypeError("Spray sampling에는 next()를 제공하는 RNG가 필요합니다.");
  }

  let roll = rng.next();
  for (const zone of SPRAY_ZONES) {
    const probability = probabilities[zone];
    if (typeof probability !== "number" || probability < 0 || !Number.isFinite(probability)) {
      throw new TypeError(`유효하지 않은 ${zone} spray 확률입니다.`);
    }
    if (roll < probability) return zone;
    roll -= probability;
  }
  return "OPPO";
}

function sampleTriangular(min, mode, max, rng) {
  if (!(min <= mode && mode <= max) || min === max) {
    throw new RangeError("유효하지 않은 spray triangular 분포 파라미터입니다.");
  }
  const u = rng.next();
  const f = (mode - min) / (max - min);
  if (u < f) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/**
 * Internal batter-relative spray sectors.
 *
 * + angle = pull side, - angle = opposite field. These are THE CALL-UP's
 * continuous geometry sectors, not claimed public Statcast angular cutoffs.
 */
function classifyBatterRelativeSpray(degrees) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) {
    throw new TypeError("Spray angle은 유한한 number여야 합니다.");
  }
  if (degrees < -15) return "OPPO";
  if (degrees >= 15) return "PULL";
  return "CENTER";
}

/**
 * Convert batter-relative spray to an absolute park field angle.
 * -45 = LF line, 0 = straightaway CF, +45 = RF line.
 */
function toAbsoluteFieldAngle(batterRelativeDegrees, batterSide) {
  if (typeof batterRelativeDegrees !== "number" || !Number.isFinite(batterRelativeDegrees)) {
    throw new TypeError("batterRelativeDegrees는 유한한 number여야 합니다.");
  }
  if (!['R', 'L'].includes(batterSide)) {
    throw new RangeError("batterSide는 R/L 중 하나여야 합니다.");
  }
  return batterSide === "R" ? -batterRelativeDegrees : batterRelativeDegrees;
}

/**
 * Direction probabilities conditioned on GB versus AIR.
 *
 * The completed 2025 MLB Statcast joint profile is used as the neutral base:
 * grounders are substantially more pull-heavy than airborne contact. Individual
 * hidden spray tendencies are centered against each other, so setting all three
 * to the same rating cannot accidentally change a player's directional shape.
 */
function getSprayZoneProbabilities(context, launchAngle, config = calibrationConfig) {
  assertContext(context);
  assertLaunchAngle(launchAngle);

  const params = config.spray;
  const group = launchAngle.type === "GB" ? "GB" : "AIR";
  const base = params.neutralJointRates[group];
  const approach = context.approach ?? "BALANCED";
  const approachAdjustment = params.approachLogitAdjustments[approach];
  if (!approachAdjustment) {
    throw new RangeError(`Spray approach 설정이 없습니다: ${approach}`);
  }

  const rawLatents = {
    PULL: ratingToLatent(context.hitter.sprayPull),
    CENTER: ratingToLatent(context.hitter.sprayCenter),
    OPPO: ratingToLatent(context.hitter.sprayOppo)
  };
  const meanLatent = Object.values(rawLatents).reduce((sum, value) => sum + value, 0) / 3;

  const logits = {};
  for (const zone of SPRAY_ZONES) {
    const relativeLatent = rawLatents[zone] - meanLatent;
    logits[zone] =
      Math.log(base[zone]) + params.tendencyScale * relativeLatent + approachAdjustment[zone];
  }

  return softmax(logits);
}

/**
 * Generate a continuous spray angle after LA/BIP type is known.
 * Numeric field angle is retained for later asymmetric park geometry.
 */
function sampleSprayDirection(context, launchAngle, rng, config = calibrationConfig) {
  assertContext(context);
  assertLaunchAngle(launchAngle);
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("sampleSprayDirection에는 next()를 제공하는 RNG가 필요합니다.");
  }

  const probabilities = getSprayZoneProbabilities(context, launchAngle, config);
  const zone = sampleCategorical(probabilities, rng);
  const profile = config.spray.zoneProfiles[zone];
  const batterRelativeDegrees = sampleTriangular(profile.min, profile.mode, profile.max, rng);
  const classified = classifyBatterRelativeSpray(batterRelativeDegrees);
  if (classified !== zone) {
    throw new Error(
      `Spray zone/angle 불일치: zone=${zone}, angle=${batterRelativeDegrees}, classified=${classified}`
    );
  }

  const fieldAngleDegrees = toAbsoluteFieldAngle(
    batterRelativeDegrees,
    context.matchup.batterSide
  );

  return Object.freeze({
    zone,
    batterRelativeDegrees,
    fieldAngleDegrees,
    fieldSide: fieldAngleDegrees < -15 ? "LF" : fieldAngleDegrees >= 15 ? "RF" : "CF",
    launchGroup: launchAngle.type === "GB" ? "GB" : "AIR",
    probabilities
  });
}

export { SPRAY_ZONES, classifyBatterRelativeSpray, toAbsoluteFieldAngle, getSprayZoneProbabilities, sampleSprayDirection };
