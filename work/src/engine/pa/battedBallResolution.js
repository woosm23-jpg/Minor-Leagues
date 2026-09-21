import { calibrationConfig } from "../../config/calibration.js";
import { resolveWallClearance } from "./parkGeometry.js";
import { resolveDefenseOutcome } from "./defenseResolution.js";

/**
 * Resolve the terminal Phase 0 result of a ball put in play.
 *
 * HR is never sampled directly. It can only occur when the already-generated
 * EV + LA + spray trajectory clears the wall at that exact field angle.
 */
function resolveBattedBall(context, exitVelocity, launchAngle, spray, rng, config = calibrationConfig) {
  const wallClearance = resolveWallClearance(
    exitVelocity,
    launchAngle,
    spray,
    context.park,
    config
  );
  const defense = resolveDefenseOutcome({
    exitVelocity,
    launchAngle,
    spray,
    wallClearance,
    defense: context.defense,
    batterSpeed: context.hitter.speed,
    rng,
    config
  });

  return Object.freeze({
    outcome: defense.outcome,
    hit: defense.hit,
    bases: defense.bases,
    wallClearance,
    defense
  });
}

export { resolveBattedBall };
