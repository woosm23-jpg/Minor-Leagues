import { ratingFit2025 } from "../../config/ratingFit.2025.js";
import { inverseStandardNormalCdf } from "../distributions/normalQuantile.js";

/**
 * Shared Phase 0 Rating -> latent axis.
 *
 * The GDD's rating percentile anchors are now frozen against the completed
 * 2025 MLB Statcast empirical percentile reference rather than rounded z-score
 * sketches. Exact raw-metric thresholds are intentionally NOT encoded here;
 * future hitter/pitcher inference models translate their own observed metrics
 * to empirical percentiles before using this common ability axis.
 */
const RATING_MIN = 20;
const RATING_MAX = 99;
const RATING_FIT_ID = ratingFit2025.id;

const RATING_PERCENTILE_ANCHORS = Object.freeze(
  ratingFit2025.anchors.map(({ rating, percentile }) => Object.freeze([rating, percentile]))
);

const RATING_LATENT_ANCHORS = Object.freeze(
  RATING_PERCENTILE_ANCHORS.map(([rating, percentile]) =>
    Object.freeze([rating, inverseStandardNormalCdf(percentile)])
  )
);

const LATENT_MIN = RATING_LATENT_ANCHORS[0][1];
const LATENT_MAX = RATING_LATENT_ANCHORS.at(-1)[1];

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label}은(는) 유한한 number여야 합니다.`);
  }
}

function clampRating(rating) {
  assertFiniteNumber(rating, "Rating");
  return Math.min(RATING_MAX, Math.max(RATING_MIN, rating));
}

/**
 * Convert 20–99 rating to the internal empirical-percentile latent ability.
 * Values outside the public scale are clamped; invalid numeric data throws.
 */
function ratingToLatent(rating) {
  const r = clampRating(rating);

  for (let i = 0; i < RATING_LATENT_ANCHORS.length - 1; i += 1) {
    const [r0, z0] = RATING_LATENT_ANCHORS[i];
    const [r1, z1] = RATING_LATENT_ANCHORS[i + 1];

    if (r >= r0 && r <= r1) {
      const t = (r - r0) / (r1 - r0);
      return z0 + (z1 - z0) * t;
    }
  }

  throw new RangeError(`Rating 변환 구간을 찾지 못했습니다: ${r}`);
}

/**
 * Development/calibration helper for converting latent values back to the
 * rating scale. This is an internal inverse utility, not user-facing scouting
 * truth. The result may be fractional.
 */
function latentToRating(latent) {
  assertFiniteNumber(latent, "Latent");
  const z = Math.min(LATENT_MAX, Math.max(LATENT_MIN, latent));

  for (let i = 0; i < RATING_LATENT_ANCHORS.length - 1; i += 1) {
    const [r0, z0] = RATING_LATENT_ANCHORS[i];
    const [r1, z1] = RATING_LATENT_ANCHORS[i + 1];

    if (z >= z0 && z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return r0 + (r1 - r0) * t;
    }
  }

  throw new RangeError(`Latent 역변환 구간을 찾지 못했습니다: ${z}`);
}

export { RATING_MIN, RATING_MAX, RATING_FIT_ID, RATING_PERCENTILE_ANCHORS, RATING_LATENT_ANCHORS, clampRating, ratingToLatent, latentToRating };
