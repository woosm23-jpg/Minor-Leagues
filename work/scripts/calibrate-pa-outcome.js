import { writeFileSync } from "node:fs";
import { calibrationConfig } from "../src/config/calibration.js";
import { buildPAContext } from "../src/engine/pa/context.js";
import { simulatePA } from "../src/engine/pa/paEngine.js";
import { PA_OUTCOMES } from "../src/engine/pa/outcomeModel.js";
import { CONTACT_QUALITY_BUCKETS, sampleContactQuality } from "../src/engine/pa/contactQuality.js";
import { sampleExitVelocity } from "../src/engine/pa/exitVelocity.js";
import { BATTED_BALL_TYPES, sampleLaunchAngle } from "../src/engine/pa/launchAngle.js";
import { SPRAY_ZONES, sampleSprayDirection } from "../src/engine/pa/sprayDirection.js";
import { SeededRng } from "../src/engine/rng.js";

const BATTED_BALL_OUTCOMES = Object.freeze(["OUT", "1B", "2B", "3B", "HR"]);
const FINAL_OUTCOMES = Object.freeze(["BB", "HBP", "K", ...BATTED_BALL_OUTCOMES]);

function makeContext({ rawPower = 50, powerUtilization = 50, launchTendency = 50, sprayPull = 50, defense = null, park = null } = {}) {
  return buildPAContext({
    hitter: {
      bats: "R",
      contactR: 50,
      contactL: 50,
      rawPower,
      powerUtilizationR: powerUtilization,
      powerUtilizationL: powerUtilization,
      launchTendency,
      sprayPull,
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
    defense,
    park,
    approach: "BALANCED"
  });
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    mean,
    min: sorted[0],
    p05: percentile(0.05),
    p25: percentile(0.25),
    p50: percentile(0.50),
    p75: percentile(0.75),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1)
  };
}

function rates(counts, denominator, keys) {
  return Object.fromEntries(keys.map((key) => [key, denominator ? counts[key] / denominator : 0]));
}

function runPA(sampleSize, seed) {
  const rng = new SeededRng(seed);
  const context = makeContext();
  const counts = Object.fromEntries(PA_OUTCOMES.map((outcome) => [outcome, 0]));
  const finalCounts = Object.fromEntries(FINAL_OUTCOMES.map((outcome) => [outcome, 0]));
  const battedBallOutcomeCounts = Object.fromEntries(BATTED_BALL_OUTCOMES.map((outcome) => [outcome, 0]));
  const qualityCounts = Object.fromEntries(CONTACT_QUALITY_BUCKETS.map((bucket) => [bucket, 0]));
  const qualityLatents = [];
  const exitVelocities = [];
  let hardHits = 0;
  const launchAngles = [];
  const battedBallTypeCounts = Object.fromEntries(BATTED_BALL_TYPES.map((type) => [type, 0]));
  let launchSweetSpots = 0;
  const sprayCounts = Object.fromEntries(SPRAY_ZONES.map((zone) => [zone, 0]));
  const sprayByLaunchGroup = {
    GB: Object.fromEntries(SPRAY_ZONES.map((zone) => [zone, 0])),
    AIR: Object.fromEntries(SPRAY_ZONES.map((zone) => [zone, 0]))
  };
  const sprayLaunchGroupCounts = { GB: 0, AIR: 0 };
  const fieldAngles = [];
  const projectedDistances = [];
  const hrClearanceMargins = [];

  for (let i = 0; i < sampleSize; i += 1) {
    const result = simulatePA(context, rng);
    counts[result.outcome] += 1;
    finalCounts[result.finalOutcome] += 1;
    if (result.contactQuality) {
      battedBallOutcomeCounts[result.finalOutcome] += 1;
      qualityCounts[result.contactQuality.bucket] += 1;
      qualityLatents.push(result.contactQuality.latent);
      exitVelocities.push(result.exitVelocity.mph);
      if (result.exitVelocity.hardHit) hardHits += 1;
      launchAngles.push(result.launchAngle.degrees);
      battedBallTypeCounts[result.launchAngle.type] += 1;
      if (result.launchAngle.sweetSpot) launchSweetSpots += 1;
      sprayCounts[result.spray.zone] += 1;
      sprayByLaunchGroup[result.spray.launchGroup][result.spray.zone] += 1;
      sprayLaunchGroupCounts[result.spray.launchGroup] += 1;
      fieldAngles.push(result.spray.fieldAngleDegrees);
      projectedDistances.push(result.battedBallResult.wallClearance.projectedDistanceFt);
      if (result.finalOutcome === "HR") {
        hrClearanceMargins.push(result.battedBallResult.wallClearance.clearanceMarginFt);
      }
    }
  }

  const bbeSamples = qualityLatents.length;
  return {
    sampleSize,
    seed,
    rates: rates(counts, sampleSize, PA_OUTCOMES),
    counts,
    finalOutcome: {
      counts: finalCounts,
      rates: rates(finalCounts, sampleSize, FINAL_OUTCOMES)
    },
    battedBallResult: {
      bbeSamples,
      counts: battedBallOutcomeCounts,
      rates: rates(battedBallOutcomeCounts, bbeSamples, BATTED_BALL_OUTCOMES),
      projectedDistanceFt: projectedDistances.length ? summarize(projectedDistances) : null,
      hrClearanceMarginFt: hrClearanceMargins.length ? summarize(hrClearanceMargins) : null
    },
    contactQuality: {
      bipSamples: bbeSamples,
      bucketRates: Object.fromEntries(
        CONTACT_QUALITY_BUCKETS.map((bucket) => [bucket, bbeSamples ? qualityCounts[bucket] / bbeSamples : 0])
      ),
      latent: bbeSamples ? summarize(qualityLatents) : null
    },
    exitVelocity: {
      bbeSamples,
      mph: bbeSamples ? summarize(exitVelocities) : null,
      hardHitRate: bbeSamples ? hardHits / bbeSamples : 0
    },
    launchAngle: {
      bbeSamples,
      degrees: bbeSamples ? summarize(launchAngles) : null,
      sweetSpotRate: bbeSamples ? launchSweetSpots / bbeSamples : 0,
      typeRates: rates(battedBallTypeCounts, bbeSamples, BATTED_BALL_TYPES)
    },
    spray: {
      bbeSamples,
      fieldAngleDegrees: bbeSamples ? summarize(fieldAngles) : null,
      zoneRates: rates(sprayCounts, bbeSamples, SPRAY_ZONES),
      byLaunchGroup: Object.fromEntries(
        ["GB", "AIR"].map((group) => [group, rates(sprayByLaunchGroup[group], sprayLaunchGroupCounts[group], SPRAY_ZONES)])
      )
    }
  };
}

function runPowerProfile(rawPower, sampleSize = 50_000) {
  const context = makeContext({ rawPower });
  const rng = new SeededRng(`phase0-ev-power-${rawPower}`);
  const exitVelocities = [];
  let hardHits = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    const quality = sampleContactQuality(context, rng);
    const ev = sampleExitVelocity(context, quality, rng);
    exitVelocities.push(ev.mph);
    if (ev.hardHit) hardHits += 1;
  }

  return {
    rawPower,
    sampleSize,
    mph: summarize(exitVelocities),
    hardHitRate: hardHits / sampleSize
  };
}

function runPowerResultProfile(rawPower, sampleSize = 50_000) {
  const context = makeContext({ rawPower });
  const rng = new SeededRng(`phase0-final-power-${rawPower}`);
  const counts = Object.fromEntries(BATTED_BALL_OUTCOMES.map((outcome) => [outcome, 0]));
  let bbe = 0;
  for (let i = 0; i < sampleSize; i += 1) {
    const result = simulatePA(context, rng);
    if (result.outcome !== "BIP") continue;
    bbe += 1;
    counts[result.finalOutcome] += 1;
  }
  return { rawPower, paSamples: sampleSize, bbeSamples: bbe, rates: rates(counts, bbe, BATTED_BALL_OUTCOMES) };
}

function runLaunchTendencyProfile(launchTendency, sampleSize = 50_000) {
  const context = makeContext({ launchTendency });
  const rng = new SeededRng(`phase0-la-tendency-${launchTendency}`);
  const angles = [];
  const counts = Object.fromEntries(BATTED_BALL_TYPES.map((type) => [type, 0]));
  let sweetSpots = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    const quality = sampleContactQuality(context, rng);
    const la = sampleLaunchAngle(context, quality, rng);
    angles.push(la.degrees);
    counts[la.type] += 1;
    if (la.sweetSpot) sweetSpots += 1;
  }

  return {
    launchTendency,
    sampleSize,
    degrees: summarize(angles),
    sweetSpotRate: sweetSpots / sampleSize,
    typeRates: rates(counts, sampleSize, BATTED_BALL_TYPES)
  };
}

function runSprayPullProfile(sprayPull, sampleSize = 50_000) {
  const context = makeContext({ sprayPull });
  const rng = new SeededRng(`phase0-spray-pull-${sprayPull}`);
  const counts = Object.fromEntries(SPRAY_ZONES.map((zone) => [zone, 0]));

  for (let i = 0; i < sampleSize; i += 1) {
    const quality = sampleContactQuality(context, rng);
    const la = sampleLaunchAngle(context, quality, rng);
    const spray = sampleSprayDirection(context, la, rng);
    counts[spray.zone] += 1;
  }

  return {
    sprayPull,
    sprayCenter: 50,
    sprayOppo: 50,
    sampleSize,
    zoneRates: rates(counts, sampleSize, SPRAY_ZONES)
  };
}

const report = {
  calibrationId: calibrationConfig.id,
  reference: calibrationConfig.reference,
  neutralTarget: calibrationConfig.neutral.paOutcome,
  neutralBattedBallResultTarget: calibrationConfig.neutral.battedBallResult,
  neutralExitVelocityTarget: calibrationConfig.neutral.exitVelocity,
  neutralLaunchAngleTarget: calibrationConfig.neutral.launchAngle,
  neutralSprayTarget: calibrationConfig.neutral.spray,
  contactQualityConfig: calibrationConfig.contactQuality,
  exitVelocityConfig: calibrationConfig.exitVelocity,
  launchAngleConfig: calibrationConfig.launchAngle,
  sprayConfig: calibrationConfig.spray,
  parkConfig: calibrationConfig.park,
  defenseConfig: calibrationConfig.defense,
  runs: [
    runPA(10_000, "phase0-neutral-10k"),
    runPA(100_000, "phase0-neutral-100k")
  ],
  exitVelocityPowerProfiles: [30, 50, 80, 90].map((rawPower) => runPowerProfile(rawPower)),
  battedBallPowerProfiles: [30, 50, 80, 90].map((rawPower) => runPowerResultProfile(rawPower)),
  launchTendencyProfiles: [30, 50, 80, 90].map((launchTendency) => runLaunchTendencyProfile(launchTendency)),
  sprayPullProfiles: [30, 50, 80, 90].map((sprayPull) => runSprayPullProfile(sprayPull))
};

const json = JSON.stringify(report, null, 2) + "\n";
const outputFlagIndex = process.argv.indexOf("--output");
if (outputFlagIndex >= 0) {
  const outputPath = process.argv[outputFlagIndex + 1];
  if (!outputPath) throw new Error("--output 뒤에 파일 경로가 필요합니다.");
  writeFileSync(outputPath, json, "utf8");
  console.error(`Calibration report written: ${outputPath}`);
} else {
  process.stdout.write(json);
}
