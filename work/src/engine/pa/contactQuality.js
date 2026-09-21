import { calibrationConfig } from "../../config/calibration.js";
import { sampleStandardNormal } from "../distributions/normal.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const CONTACT_QUALITY_BUCKETS = Object.freeze([
  "POOR",
  "WEAK",
  "NORMAL",
  "SOLID",
  "PERFECT"
]);

function assertResolvedBIPContext(context) {
  if (!context || typeof context !== "object" || !context.hitter || !context.pitcher) {
    throw new TypeError("Contact Quality 계산에는 resolved PA context가 필요합니다.");
  }

  for (const key of ["contact", "rawPower", "powerUtilization"]) {
    ratingToLatent(context.hitter[key]);
  }

  for (const key of ["movement", "command"]) {
    ratingToLatent(context.pitcher[key]);
  }
}

/**
 * Mean of the continuous Contact Quality latent distribution.
 *
 * Contact is the primary driver. Raw Power only has a small role here because
 * its strongest physical effect belongs in the subsequent EV model. Power
 * Utilization represents how efficiently physical power is converted into
 * damaging contact. Movement/Command suppress contact quality.
 */
function getContactQualityMean(context, config = calibrationConfig) {
  assertResolvedBIPContext(context);

  const params = config.contactQuality;
  const hitterWeights = params.hitterWeights;
  const pitcherWeights = params.pitcherDefenseWeights;

  const hitterAbility =
    hitterWeights.contact * ratingToLatent(context.hitter.contact) +
    hitterWeights.rawPower * ratingToLatent(context.hitter.rawPower) +
    hitterWeights.powerUtilization * ratingToLatent(context.hitter.powerUtilization);

  const pitcherSuppression =
    pitcherWeights.movement * ratingToLatent(context.pitcher.movement) +
    pitcherWeights.command * ratingToLatent(context.pitcher.command);

  const approachAdjustment = params.approachMeanAdjustments[context.approach ?? "BALANCED"];
  if (typeof approachAdjustment !== "number") {
    throw new RangeError(`Contact Quality approach 설정이 없습니다: ${context.approach}`);
  }

  return params.battleScale * (hitterAbility - pitcherSuppression) + approachAdjustment;
}

function bucketContactQuality(latent, config = calibrationConfig) {
  if (typeof latent !== "number" || !Number.isFinite(latent)) {
    throw new TypeError("Contact Quality latent는 유한한 number여야 합니다.");
  }

  const t = config.contactQuality.bucketThresholds;
  if (latent < t.poorMax) return "POOR";
  if (latent < t.weakMax) return "WEAK";
  if (latent < t.normalMax) return "NORMAL";
  if (latent < t.solidMax) return "SOLID";
  return "PERFECT";
}

function sampleContactQuality(context, rng, config = calibrationConfig) {
  const mean = getContactQualityMean(context, config);
  const noise = sampleStandardNormal(rng) * config.contactQuality.noiseStdDev;
  const latent = mean + noise;

  return Object.freeze({
    latent,
    mean,
    bucket: bucketContactQuality(latent, config)
  });
}

export { CONTACT_QUALITY_BUCKETS, getContactQualityMean, bucketContactQuality, sampleContactQuality };
