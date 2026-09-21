import { writeFileSync } from "node:fs";
import { ratingFit2025 } from "../src/config/ratingFit.2025.js";
import {
  RATING_FIT_ID,
  RATING_LATENT_ANCHORS,
  RATING_PERCENTILE_ANCHORS,
  ratingToLatent
} from "../src/engine/ratings/latentRating.js";

const PRIOR_V7 = new Map([
  [20, -2.33],
  [30, -1.28],
  [40, -0.67],
  [50, 0.0],
  [65, 0.67],
  [80, 1.28],
  [90, 1.88],
  [95, 2.33],
  [99, 2.7]
]);

const rows = RATING_PERCENTILE_ANCHORS.map(([rating, percentile], index) => {
  const latent = RATING_LATENT_ANCHORS[index][1];
  const prior = PRIOR_V7.get(rating) ?? null;
  return {
    rating,
    empiricalPercentile: percentile,
    latent,
    priorV7Latent: prior,
    deltaVsV7: prior === null ? null : latent - prior,
    source: ratingFit2025.anchors[index].source,
    extrapolated: Boolean(ratingFit2025.anchors[index].extrapolated)
  };
});

const report = {
  schemaVersion: 1,
  reportId: "phase0-rating-fit-v8",
  fitId: RATING_FIT_ID,
  createdForProject: "2026-09-18",
  environment: ratingFit2025.environment,
  source: ratingFit2025.source,
  method: ratingFit2025.method,
  anchors: rows,
  acceptance: {
    neutral50IsExactlyZero: ratingToLatent(50) === 0,
    strictMonotonic: rows.every((row, index) => index === 0 || row.latent > rows[index - 1].latent),
    rating95Is99thPercentile: rows.find((row) => row.rating === 95)?.empiricalPercentile === 0.99,
    rating99IsRarerThan95:
      rows.find((row) => row.rating === 99)?.empiricalPercentile >
      rows.find((row) => row.rating === 95)?.empiricalPercentile
  },
  interpretation: {
    sharedAxis:
      "This report freezes the shared Rating->latent curve only. It does not claim that raw Max EV, K%, BB%, OAA, Sprint Speed, or pitch metrics share the same units.",
    importerBoundary:
      "Future real-data inference estimates each tool from its own raw observations and uncertainty, maps that estimate to an MLB empirical percentile, and then uses this shared rating axis.",
    phase0Consequence:
      "Replacing the rounded v7 z anchors with exact empirical-percentile quantiles should make only tiny changes from Rating 20 through 95; Rating 99 gets the deliberate rare-tail extension. Neutral Rating 50 is unchanged."
  }
};

const json = JSON.stringify(report, null, 2) + "\n";
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const path = process.argv[outputIndex + 1];
  if (!path) throw new Error("--output 뒤에 파일 경로가 필요합니다.");
  writeFileSync(path, json, "utf8");
  console.error(`Rating fit report written: ${path}`);
} else {
  process.stdout.write(json);
}

if (Object.values(report.acceptance).some((value) => value !== true)) process.exitCode = 1;
