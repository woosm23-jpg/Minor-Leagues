import { getPAOutcomeProbabilities, samplePAOutcome } from "./outcomeModel.js";
import { sampleContactQuality } from "./contactQuality.js";
import { sampleExitVelocity } from "./exitVelocity.js";
import { sampleLaunchAngle } from "./launchAngle.js";
import { sampleSprayDirection } from "./sprayDirection.js";
import { resolveBattedBall } from "./battedBallResolution.js";
import { samplePitchCount } from "./pitchCount.js";

/**
 * Phase 0 structured PA result.
 *
 * Resolution order currently implemented:
 * BB / HBP / K / BIP competition -> Contact Quality -> Exit Velocity -> Launch Angle/BIP type -> Spray
 * -> Park geometry -> aggregate or fielder-specific defense resolution.
 */
function simulatePA(context, rng) {
  const probabilities = getPAOutcomeProbabilities(context);
  const outcome = samplePAOutcome(probabilities, rng);
  const contactQuality = outcome === "BIP" ? sampleContactQuality(context, rng) : null;
  const exitVelocity =
    contactQuality === null ? null : sampleExitVelocity(context, contactQuality, rng);
  const launchAngle =
    contactQuality === null ? null : sampleLaunchAngle(context, contactQuality, rng);
  const spray = launchAngle === null ? null : sampleSprayDirection(context, launchAngle, rng);
  const battedBallResult =
    spray === null ? null : resolveBattedBall(context, exitVelocity, launchAngle, spray, rng);
  const finalOutcome = outcome === "BIP" ? battedBallResult.outcome : outcome;
  const pitchCount = samplePitchCount(outcome, rng);

  return Object.freeze({
    schemaVersion: 9,
    outcome,
    finalOutcome,
    terminal: true,
    probabilities,
    selectedPitchType: context.pitcher.pitchType ?? null,
    selectedPitchVelocityMph: context.pitcher.pitchVelocityMph ?? null,
    pitchCount,
    contactQuality,
    exitVelocity,
    launchAngle,
    spray,
    battedBallResult
  });
}

export { simulatePA };
