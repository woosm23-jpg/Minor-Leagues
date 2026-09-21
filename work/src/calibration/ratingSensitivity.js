import { calibrationConfig } from "../config/calibration.js";
import { getContactQualityMean } from "../engine/pa/contactQuality.js";
import { buildPAContext } from "../engine/pa/context.js";
import { getExitVelocityLocationMph, getMaxExitVelocityMph } from "../engine/pa/exitVelocity.js";
import { getLaunchTypeProbabilities } from "../engine/pa/launchAngle.js";
import { getPAOutcomeProbabilities } from "../engine/pa/outcomeModel.js";
import { simulatePA } from "../engine/pa/paEngine.js";
import { SeededRng } from "../engine/rng.js";

export const SENSITIVITY_RATINGS = Object.freeze([20, 30, 40, 50, 65, 80, 90]);

export const SENSITIVITY_TOOLS = Object.freeze([
  "contact",
  "vision",
  "discipline",
  "rawPower",
  "powerUtilization",
  "launchTendency",
  "control",
  "command",
  "movement",
  "stuff"
]);

const FINAL_OUTCOMES = Object.freeze(["BB", "HBP", "K", "OUT", "1B", "2B", "3B", "HR"]);
const CONTACT_OUTCOMES = Object.freeze(["OUT", "1B", "2B", "3B", "HR"]);
const LA_TYPES = Object.freeze(["GB", "LD", "FB", "PU"]);

function neutralHitter() {
  return {
    bats: "R",
    contactR: 50,
    contactL: 50,
    rawPower: 50,
    powerUtilizationR: 50,
    powerUtilizationL: 50,
    launchTendency: 50,
    sprayPull: 50,
    sprayCenter: 50,
    sprayOppo: 50,
    vision: 50,
    discipline: 50
  };
}

function neutralPitcher() {
  return {
    throws: "R",
    control: 50,
    command: 50,
    movement: 50,
    pitchability: 50,
    stuff: 50
  };
}

export function buildSensitivityContext(tool, rating) {
  if (!SENSITIVITY_TOOLS.includes(tool)) {
    throw new RangeError(`지원하지 않는 sensitivity tool입니다: ${tool}`);
  }

  const hitter = neutralHitter();
  const pitcher = neutralPitcher();

  switch (tool) {
    case "contact":
      hitter.contactR = rating;
      hitter.contactL = rating;
      break;
    case "powerUtilization":
      hitter.powerUtilizationR = rating;
      hitter.powerUtilizationL = rating;
      break;
    case "vision":
    case "discipline":
    case "rawPower":
    case "launchTendency":
      hitter[tool] = rating;
      break;
    case "control":
    case "command":
    case "movement":
    case "stuff":
      pitcher[tool] = rating;
      break;
    default:
      throw new RangeError(`처리되지 않은 sensitivity tool입니다: ${tool}`);
  }

  return buildPAContext({ hitter, pitcher, approach: "BALANCED" });
}

export function getDeterministicSensitivityCell(tool, rating, config = calibrationConfig) {
  const context = buildSensitivityContext(tool, rating);
  const paProbabilities = getPAOutcomeProbabilities(context, config);
  const contactQualityMean = getContactQualityMean(context, config);
  const maxExitVelocityMph = getMaxExitVelocityMph(context, config);
  const evLocationAtMeanQualityMph = getExitVelocityLocationMph(
    context,
    { latent: contactQualityMean },
    config
  );
  const launchTypeProbabilities = getLaunchTypeProbabilities(context, config);

  return Object.freeze({
    tool,
    rating,
    paProbabilities,
    contactQualityMean,
    maxExitVelocityMph,
    evLocationAtMeanQualityMph,
    launchTypeProbabilities
  });
}

function createCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function toRates(counts, denominator, keys) {
  return Object.fromEntries(keys.map((key) => [key, denominator ? counts[key] / denominator : 0]));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    mean: total / values.length,
    p05: percentile(sorted, 0.05),
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted.at(-1)
  });
}

export function simulateSensitivityCell(
  tool,
  rating,
  { sampleSize = 20_000, seed = `phase0-sensitivity-${tool}-${rating}` } = {}
) {
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    throw new RangeError("sampleSize는 양의 정수여야 합니다.");
  }

  const deterministic = getDeterministicSensitivityCell(tool, rating);
  const context = buildSensitivityContext(tool, rating);
  const rng = new SeededRng(seed);
  const finalCounts = createCounts(FINAL_OUTCOMES);
  const contactCounts = createCounts(CONTACT_OUTCOMES);
  const launchCounts = createCounts(LA_TYPES);
  const contactQualityLatents = [];
  const exitVelocities = [];
  const launchAngles = [];
  let hardHits = 0;
  let sweetSpots = 0;
  let bbe = 0;
  let totalBases = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    const result = simulatePA(context, rng);
    finalCounts[result.finalOutcome] += 1;

    if (result.outcome !== "BIP") continue;
    bbe += 1;
    contactCounts[result.finalOutcome] += 1;
    contactQualityLatents.push(result.contactQuality.latent);
    exitVelocities.push(result.exitVelocity.mph);
    launchAngles.push(result.launchAngle.degrees);
    launchCounts[result.launchAngle.type] += 1;
    if (result.exitVelocity.hardHit) hardHits += 1;
    if (result.launchAngle.sweetSpot) sweetSpots += 1;

    if (result.finalOutcome === "1B") totalBases += 1;
    else if (result.finalOutcome === "2B") totalBases += 2;
    else if (result.finalOutcome === "3B") totalBases += 3;
    else if (result.finalOutcome === "HR") totalBases += 4;
  }

  const hitCount =
    contactCounts["1B"] + contactCounts["2B"] + contactCounts["3B"] + contactCounts.HR;

  return Object.freeze({
    ...deterministic,
    sampleSize,
    seed,
    bbeSamples: bbe,
    sampled: Object.freeze({
      finalOutcomeRatesPerPA: toRates(finalCounts, sampleSize, FINAL_OUTCOMES),
      contactOutcomeRates: toRates(contactCounts, bbe, CONTACT_OUTCOMES),
      hitRatePerPA: hitCount / sampleSize,
      hitRateOnContact: bbe ? hitCount / bbe : 0,
      hrRatePerPA: finalCounts.HR / sampleSize,
      hrRateOnContact: bbe ? contactCounts.HR / bbe : 0,
      totalBasesPerPA: totalBases / sampleSize,
      contactQuality: summarize(contactQualityLatents),
      exitVelocityMph: summarize(exitVelocities),
      hardHitRate: bbe ? hardHits / bbe : 0,
      launchAngleDegrees: summarize(launchAngles),
      launchTypeRates: toRates(launchCounts, bbe, LA_TYPES),
      launchSweetSpotRate: bbe ? sweetSpots / bbe : 0
    })
  });
}

function isStrictlyIncreasing(values, epsilon = 1e-12) {
  return values.every((value, index) => index === 0 || value > values[index - 1] + epsilon);
}

function isStrictlyDecreasing(values, epsilon = 1e-12) {
  return values.every((value, index) => index === 0 || value < values[index - 1] - epsilon);
}

function maxSpread(values) {
  return Math.max(...values) - Math.min(...values);
}

function makeCheck(name, pass, details) {
  return Object.freeze({ name, pass: Boolean(pass), details });
}

export function evaluateDeterministicSensitivity(matrix) {
  const byTool = Object.fromEntries(matrix.map((entry) => [entry.tool, entry.cells]));
  const values = (tool, selector) => byTool[tool].map(selector);
  const checks = [];

  checks.push(
    makeCheck(
      "Contact 상승 → K 확률 단조 감소",
      isStrictlyDecreasing(values("contact", (c) => c.paProbabilities.K)),
      values("contact", (c) => c.paProbabilities.K)
    ),
    makeCheck(
      "Contact 상승 → Contact Quality mean 단조 증가",
      isStrictlyIncreasing(values("contact", (c) => c.contactQualityMean)),
      values("contact", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Vision 상승 → K 확률 단조 감소",
      isStrictlyDecreasing(values("vision", (c) => c.paProbabilities.K)),
      values("vision", (c) => c.paProbabilities.K)
    ),
    makeCheck(
      "Vision은 Contact Quality를 직접 변경하지 않음",
      maxSpread(values("vision", (c) => c.contactQualityMean)) < 1e-12,
      values("vision", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Discipline 상승 → BB 확률 단조 증가",
      isStrictlyIncreasing(values("discipline", (c) => c.paProbabilities.BB)),
      values("discipline", (c) => c.paProbabilities.BB)
    ),
    makeCheck(
      "Discipline은 Contact Quality를 직접 변경하지 않음",
      maxSpread(values("discipline", (c) => c.contactQualityMean)) < 1e-12,
      values("discipline", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Raw Power 상승 → Max EV ceiling 단조 증가",
      isStrictlyIncreasing(values("rawPower", (c) => c.maxExitVelocityMph)),
      values("rawPower", (c) => c.maxExitVelocityMph)
    ),
    makeCheck(
      "Raw Power 상승 → EV location 단조 증가",
      isStrictlyIncreasing(values("rawPower", (c) => c.evLocationAtMeanQualityMph)),
      values("rawPower", (c) => c.evLocationAtMeanQualityMph)
    ),
    makeCheck(
      "Power Utilization 상승 → Contact Quality mean 단조 증가",
      isStrictlyIncreasing(values("powerUtilization", (c) => c.contactQualityMean)),
      values("powerUtilization", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Power Utilization은 Max EV ceiling을 직접 변경하지 않음",
      maxSpread(values("powerUtilization", (c) => c.maxExitVelocityMph)) < 1e-12,
      values("powerUtilization", (c) => c.maxExitVelocityMph)
    ),
    makeCheck(
      "Launch tendency 상승 → GB 확률 단조 감소",
      isStrictlyDecreasing(values("launchTendency", (c) => c.launchTypeProbabilities.GB)),
      values("launchTendency", (c) => c.launchTypeProbabilities.GB)
    ),
    makeCheck(
      "Launch tendency 상승 → FB+PU 확률 단조 증가",
      isStrictlyIncreasing(
        values("launchTendency", (c) => c.launchTypeProbabilities.FB + c.launchTypeProbabilities.PU)
      ),
      values("launchTendency", (c) => c.launchTypeProbabilities.FB + c.launchTypeProbabilities.PU)
    ),
    makeCheck(
      "Control 상승 → BB 확률 단조 감소",
      isStrictlyDecreasing(values("control", (c) => c.paProbabilities.BB)),
      values("control", (c) => c.paProbabilities.BB)
    ),
    makeCheck(
      "Command 상승 → Contact Quality mean 단조 감소",
      isStrictlyDecreasing(values("command", (c) => c.contactQualityMean)),
      values("command", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Movement 상승 → Contact Quality mean 단조 감소",
      isStrictlyDecreasing(values("movement", (c) => c.contactQualityMean)),
      values("movement", (c) => c.contactQualityMean)
    ),
    makeCheck(
      "Stuff 상승 → K 확률 단조 증가",
      isStrictlyIncreasing(values("stuff", (c) => c.paProbabilities.K)),
      values("stuff", (c) => c.paProbabilities.K)
    )
  );

  return Object.freeze({
    passed: checks.every((check) => check.pass),
    checks: Object.freeze(checks)
  });
}

export function buildDeterministicSensitivityMatrix(config = calibrationConfig) {
  return SENSITIVITY_TOOLS.map((tool) => ({
    tool,
    cells: SENSITIVITY_RATINGS.map((rating) =>
      getDeterministicSensitivityCell(tool, rating, config)
    )
  }));
}

export function buildSampledSensitivityMatrix({ sampleSizePerCell = 20_000 } = {}) {
  return SENSITIVITY_TOOLS.map((tool) => ({
    tool,
    cells: SENSITIVITY_RATINGS.map((rating) =>
      simulateSensitivityCell(tool, rating, { sampleSize: sampleSizePerCell })
    )
  }));
}
