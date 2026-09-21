import { writeFileSync } from "node:fs";
import { calibrationConfig } from "../src/config/calibration.js";
import { buildPAContext } from "../src/engine/pa/context.js";
import { simulatePA } from "../src/engine/pa/paEngine.js";
import { ratingFit2025 } from "../src/config/ratingFit.2025.js";
import { SeededRng } from "../src/engine/rng.js";

const SAMPLE_SIZE = 1_000_000;
const SEED = "phase0-final-1m-v8";
const FINAL_OUTCOMES = ["BB", "HBP", "K", "OUT", "1B", "2B", "3B", "HR"];
const CONTACT_OUTCOMES = ["OUT", "1B", "2B", "3B", "HR"];
const LA_TYPES = ["GB", "LD", "FB", "PU"];
const SPRAY_ZONES = ["PULL", "CENTER", "OPPO"];

function neutralContext() {
  return buildPAContext({
    hitter: {
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
    },
    pitcher: {
      throws: "R",
      control: 50,
      command: 50,
      movement: 50,
      pitchability: 50,
      stuff: 50
    },
    approach: "BALANCED"
  });
}

function zero(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function rates(counts, denominator, keys) {
  return Object.fromEntries(keys.map((key) => [key, counts[key] / denominator]));
}

function maxAbsError(actual, target, keys) {
  return Math.max(...keys.map((key) => Math.abs(actual[key] - target[key])));
}

const rng = new SeededRng(SEED);
const context = neutralContext();
const finalCounts = zero(FINAL_OUTCOMES);
const contactCounts = zero(CONTACT_OUTCOMES);
const launchCounts = zero(LA_TYPES);
const sprayCounts = zero(SPRAY_ZONES);
let bbe = 0;
let evSum = 0;
let hardHits = 0;
let laSum = 0;
let sweetSpots = 0;

for (let i = 0; i < SAMPLE_SIZE; i += 1) {
  const result = simulatePA(context, rng);
  finalCounts[result.finalOutcome] += 1;
  if (result.outcome !== "BIP") continue;

  bbe += 1;
  contactCounts[result.finalOutcome] += 1;
  launchCounts[result.launchAngle.type] += 1;
  sprayCounts[result.spray.zone] += 1;
  evSum += result.exitVelocity.mph;
  laSum += result.launchAngle.degrees;
  if (result.exitVelocity.hardHit) hardHits += 1;
  if (result.launchAngle.sweetSpot) sweetSpots += 1;
}

const paRates = {
  BB: finalCounts.BB / SAMPLE_SIZE,
  HBP: finalCounts.HBP / SAMPLE_SIZE,
  K: finalCounts.K / SAMPLE_SIZE,
  BIP: bbe / SAMPLE_SIZE
};
const contactRates = rates(contactCounts, bbe, CONTACT_OUTCOMES);
const laRates = rates(launchCounts, bbe, LA_TYPES);
const sprayRates = rates(sprayCounts, bbe, SPRAY_ZONES);
const evAverage = evSum / bbe;
const hardHitRate = hardHits / bbe;
const laAverage = laSum / bbe;
const sweetSpotRate = sweetSpots / bbe;

const checks = [
  {
    id: "pa-outcome-max-abs-error",
    actual: maxAbsError(paRates, calibrationConfig.neutral.paOutcome, ["BB", "HBP", "K", "BIP"]),
    tolerance: 0.0020
  },
  {
    id: "ev-average",
    actual: Math.abs(evAverage - calibrationConfig.neutral.exitVelocity.averageMph),
    tolerance: 0.35
  },
  {
    id: "hard-hit-rate",
    actual: Math.abs(hardHitRate - calibrationConfig.neutral.exitVelocity.hardHitRate),
    tolerance: 0.008
  },
  {
    id: "la-average",
    actual: Math.abs(laAverage - calibrationConfig.neutral.launchAngle.averageDegrees),
    tolerance: 0.40
  },
  {
    id: "la-type-max-abs-error",
    actual: maxAbsError(laRates, calibrationConfig.neutral.launchAngle.typeRates, LA_TYPES),
    tolerance: 0.008
  },
  {
    id: "la-sweet-spot-rate",
    actual: Math.abs(sweetSpotRate - calibrationConfig.neutral.launchAngle.sweetSpotRate),
    tolerance: 0.008
  },
  {
    id: "spray-max-abs-error",
    actual: maxAbsError(sprayRates, calibrationConfig.neutral.spray.zoneRates, SPRAY_ZONES),
    tolerance: 0.008
  },
  {
    id: "contact-result-max-abs-error",
    actual: maxAbsError(contactRates, calibrationConfig.neutral.battedBallResult, CONTACT_OUTCOMES),
    tolerance: 0.005
  }
].map((check) => ({ ...check, pass: check.actual <= check.tolerance }));

const report = {
  schemaVersion: 1,
  reportId: "phase0-final-acceptance-v8",
  calibrationId: calibrationConfig.id,
  ratingFitId: ratingFit2025.id,
  createdForProject: "2026-09-18",
  sampleSize: SAMPLE_SIZE,
  seed: SEED,
  bbeSamples: bbe,
  observed: {
    paRates,
    exitVelocity: { averageMph: evAverage, hardHitRate },
    launchAngle: { averageDegrees: laAverage, sweetSpotRate, typeRates: laRates },
    spray: sprayRates,
    contactResultRates: contactRates
  },
  targets: {
    paRates: calibrationConfig.neutral.paOutcome,
    exitVelocity: calibrationConfig.neutral.exitVelocity,
    launchAngle: calibrationConfig.neutral.launchAngle,
    spray: calibrationConfig.neutral.spray.zoneRates,
    contactResultRates: calibrationConfig.neutral.battedBallResult
  },
  checks,
  passed: checks.every((check) => check.pass)
};

const json = JSON.stringify(report, null, 2) + "\n";
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const path = process.argv[outputIndex + 1];
  if (!path) throw new Error("--output 뒤에 파일 경로가 필요합니다.");
  writeFileSync(path, json, "utf8");
  console.error(`Phase 0 final acceptance written: ${path}`);
} else {
  process.stdout.write(json);
}

if (!report.passed) process.exitCode = 1;
