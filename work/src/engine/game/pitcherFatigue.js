import { pitchingCalibration } from "../../config/pitchingCalibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assertRole(role) {
  if (role !== "SP" && role !== "RP" && role !== "CL") {
    throw new RangeError(`pitcher role은 SP/RP/CL이어야 합니다: ${role}`);
  }
}

function getPitcherCapacityPitches(stamina, role, config = pitchingCalibration) {
  assertRole(role);
  const z = ratingToLatent(stamina);
  const reliever = role !== "SP";
  const base = reliever
    ? config.fatigue.relieverCapacityPitchesAt50Stamina
    : config.fatigue.starterCapacityPitchesAt50Stamina;
  const perLatent = reliever
    ? config.fatigue.relieverCapacityPitchesPerLatent
    : config.fatigue.starterCapacityPitchesPerLatent;
  return Math.max(12, base + z * perLatent);
}

/**
 * 0–100 game fatigue. The curve is intentionally workload-shaped rather than
 * a flat per-pitch subtraction. At neutral stamina, ~50 pitches is Fresh/Normal,
 * ~85 pitches is Fatigued, and ~100 pitches approaches Exhausted.
 */
function calculatePitcherFatigue({ pitchCount, stamina = 50, role = "SP" }, config = pitchingCalibration) {
  if (!Number.isFinite(pitchCount) || pitchCount < 0) throw new RangeError("pitchCount는 0 이상의 유한한 값이어야 합니다.");
  const capacity = getPitcherCapacityPitches(stamina, role, config);
  const ratio = pitchCount / capacity;
  return clamp(100 * ratio * ratio, 0, 100);
}

function getEffectivePitcherRatings({
  control,
  command,
  movement,
  stuff,
  pitchVelocityMph = null,
  stamina = 50,
  role = "SP",
  pitchCount = 0
}, config = pitchingCalibration) {
  for (const [name, value] of Object.entries({ control, command, movement, stuff, stamina })) ratingToLatent(value, name);
  assertRole(role);
  const fatigue = calculatePitcherFatigue({ pitchCount, stamina, role }, config);
  const factor = fatigue / 100;
  const reliever = role !== "SP";
  const rating = (value, penalty, bonus = 0) => clamp(value - penalty * factor + bonus, 20, 99);
  let velocity = pitchVelocityMph;
  if (velocity !== null && velocity !== undefined) {
    if (!Number.isFinite(velocity)) throw new TypeError("pitchVelocityMph는 유한한 number여야 합니다.");
    velocity = velocity
      - config.fatigue.velocityPenaltyMphAt100 * factor
      + (reliever ? config.fatigue.relieverEffortVelocityBonusMph : 0);
  }

  return Object.freeze({
    fatigue,
    control,
    command: rating(command, config.fatigue.commandPenaltyAt100),
    movement: rating(movement, config.fatigue.movementPenaltyAt100),
    stuff: rating(
      stuff,
      config.fatigue.stuffPenaltyAt100,
      reliever ? config.fatigue.relieverEffortStuffBonus : 0
    ),
    pitchVelocityMph: velocity
  });
}

export { getPitcherCapacityPitches, calculatePitcherFatigue, getEffectivePitcherRatings };
