import { calibrationConfig } from "../../config/calibration.js";
import { sampleStandardNormal } from "../distributions/normal.js";
import { ratingToLatent } from "../ratings/latentRating.js";

function assertContext(context) {
  if (!context || typeof context !== "object" || !context.hitter || !context.pitcher) {
    throw new TypeError("Exit Velocity 계산에는 resolved PA context가 필요합니다.");
  }

  for (const key of ["rawPower", "powerUtilization"]) {
    ratingToLatent(context.hitter[key]);
  }

  const pitchVelocity = context.pitcher.pitchVelocityMph;
  if (
    pitchVelocity !== null &&
    pitchVelocity !== undefined &&
    (typeof pitchVelocity !== "number" || !Number.isFinite(pitchVelocity))
  ) {
    throw new TypeError("pitchVelocityMph는 유한한 number 또는 null이어야 합니다.");
  }
}

function assertContactQuality(contactQuality) {
  if (
    !contactQuality ||
    typeof contactQuality !== "object" ||
    typeof contactQuality.latent !== "number" ||
    !Number.isFinite(contactQuality.latent)
  ) {
    throw new TypeError("Exit Velocity 계산에는 유효한 Contact Quality가 필요합니다.");
  }
}

/**
 * Raw Power-driven soft physical EV ceiling.
 *
 * Power Utilization intentionally does not enter this function. Utilization can
 * help a hitter reach damaging contact more often, but Raw Power owns the
 * high-end physical ceiling so Max EV remains a useful inverse-model signal.
 * The sampler compresses rare overshoots instead of hard-clamping every event
 * to this value; this avoids an artificial probability spike at one exact mph.
 */
function getMaxExitVelocityMph(context, config = calibrationConfig) {
  assertContext(context);
  const params = config.exitVelocity;
  const rawPowerLatent = ratingToLatent(context.hitter.rawPower);
  const ceiling = params.neutralMaxMph + params.maxMphPerRawPowerLatent * rawPowerLatent;
  return Math.min(params.globalMaxMph, Math.max(params.globalMinMaxMph, ceiling));
}

/**
 * Deterministic center of the EV distribution before residual event noise.
 *
 * Contact Quality has intentionally asymmetric slopes: mishits can lose a lot
 * of EV while excellent contact gains are bounded by the hitter's physical
 * ceiling. This shape allows neutral MLB mean EV and Hard-Hit% to coexist,
 * which a single symmetric normal distribution cannot reproduce well.
 */
function getExitVelocityLocationMph(context, contactQuality, config = calibrationConfig) {
  assertContext(context);
  assertContactQuality(contactQuality);

  const params = config.exitVelocity;
  const quality = contactQuality.latent;
  const qualityEffect =
    quality >= 0
      ? quality * params.contactQualityPositiveMphPerLatent
      : quality * params.contactQualityNegativeMphPerLatent;

  const rawPowerEffect =
    ratingToLatent(context.hitter.rawPower) * params.rawPowerMphPerLatent;
  const utilizationEffect =
    ratingToLatent(context.hitter.powerUtilization) * params.powerUtilizationMphPerLatent;

  const incomingVelocity =
    context.pitcher.pitchVelocityMph ?? params.referencePitchVelocityMph;
  const pitchVelocityEffect =
    (incomingVelocity - params.referencePitchVelocityMph) *
    params.incomingPitchVelocityTransfer;

  return (
    params.neutralContactCenterMph +
    qualityEffect +
    rawPowerEffect +
    utilizationEffect +
    pitchVelocityEffect
  );
}

function sampleExitVelocity(context, contactQuality, rng, config = calibrationConfig) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("sampleExitVelocity에는 next()를 제공하는 RNG가 필요합니다.");
  }

  const params = config.exitVelocity;
  const locationMph = getExitVelocityLocationMph(context, contactQuality, config);
  const maxMph = getMaxExitVelocityMph(context, config);
  const residual = sampleStandardNormal(rng) * params.residualStdDevMph;
  const unclampedMph = locationMph + residual;
  const ceilingAdjustedMph =
    unclampedMph > maxMph
      ? maxMph + (unclampedMph - maxMph) * params.ceilingOvershootRetention
      : unclampedMph;
  const mph = Math.min(params.globalMaxMph, Math.max(params.globalMinMph, ceilingAdjustedMph));

  return Object.freeze({
    mph,
    locationMph,
    maxMph,
    hardHit: mph >= params.hardHitThresholdMph
  });
}

export { getMaxExitVelocityMph, getExitVelocityLocationMph, sampleExitVelocity };
