import { PA_APPROACHES } from "./outcomeModel.js";
import { ratingToLatent } from "../ratings/latentRating.js";
import { normalizePark } from "./parkGeometry.js";
import { normalizeDefense } from "./defenseResolution.js";

const HANDEDNESS = Object.freeze(["R", "L"]);
const BAT_SIDES = Object.freeze(["R", "L", "S"]);

function assertObject(value, label) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label}가 필요합니다.`);
  }
}

function assertHand(value, label, allowed) {
  if (!allowed.includes(value)) {
    throw new RangeError(`${label}은(는) ${allowed.join("/")} 중 하나여야 합니다.`);
  }
}

function assertRating(value, label) {
  try {
    ratingToLatent(value);
  } catch (error) {
    throw new TypeError(`${label}: ${error.message}`);
  }
}

function resolveOptionalPitchVelocity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("pitcher.pitchVelocityMph는 유한한 number여야 합니다.");
  }
  if (value < 55 || value > 110) {
    throw new RangeError("pitcher.pitchVelocityMph는 55–110 mph 범위여야 합니다.");
  }
  return value;
}

function resolveOptionalFatigue(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("pitcher.fatigue는 0–100 범위의 유한한 number여야 합니다.");
  }
  return value;
}

function resolveOptionalHitterSpeed(value) {
  const resolved = value === undefined || value === null ? 50 : value;
  assertRating(resolved, "hitter.speed");
  return resolved;
}

/**
 * Determine the side from which the hitter bats for this PA.
 * Switch hitters bat opposite the pitcher's throwing hand.
 */
function resolveBatterSide(bats, pitcherThrows) {
  assertHand(bats, "hitter.bats", BAT_SIDES);
  assertHand(pitcherThrows, "pitcher.throws", HANDEDNESS);

  if (bats === "S") return pitcherThrows === "R" ? "L" : "R";
  return bats;
}

/**
 * Build the minimal, resolved PAContext consumed by Phase 0 engines.
 *
 * Split convention:
 * - contactR/contactL = hitter quality versus RHP/LHP
 * - powerUtilizationR/powerUtilizationL = utilization versus RHP/LHP
 * - sprayPull/sprayCenter/sprayOppo = hidden relative directional style ratings
 *
 * No hidden platoon bonus is added here. Matchup differences come from the
 * stored split ratings themselves, preventing a double-counted handedness buff.
 *
 * park/defense are explicit PA dependencies. If omitted in Phase 0, versioned
 * neutral park and aggregate neutral defense are injected. This avoids hidden
 * user/team modifiers while keeping the resolver ready for real park snapshots
 * and fielder-specific defense in Phase 1.
 *
 * pitchVelocityMph is optional during compressed Phase 0 Quick AB. If omitted,
 * the EV engine uses its versioned neutral reference velocity. A future pitch
 * selection layer can provide the actual incoming pitch velocity here.
 */
function buildPAContext({ hitter, pitcher, park = null, defense = null, approach = "BALANCED" }) {
  assertObject(hitter, "hitter");
  assertObject(pitcher, "pitcher");

  assertHand(hitter.bats, "hitter.bats", BAT_SIDES);
  assertHand(pitcher.throws, "pitcher.throws", HANDEDNESS);

  for (const key of [
    "contactR",
    "contactL",
    "rawPower",
    "powerUtilizationR",
    "powerUtilizationL",
    "launchTendency",
    "sprayPull",
    "sprayCenter",
    "sprayOppo",
    "vision",
    "discipline"
  ]) {
    assertRating(hitter[key], `hitter.${key}`);
  }

  for (const key of ["control", "command", "movement", "pitchability", "stuff"]) {
    assertRating(pitcher[key], `pitcher.${key}`);
  }

  if (!PA_APPROACHES.includes(approach)) {
    throw new RangeError(`지원하지 않는 PA approach입니다: ${approach}`);
  }

  const pitcherHand = pitcher.throws;
  const batterSide = resolveBatterSide(hitter.bats, pitcherHand);
  const vsRight = pitcherHand === "R";

  return Object.freeze({
    schemaVersion: 6,
    approach,
    matchup: Object.freeze({
      pitcherHand,
      batterSide,
      sameSide: batterSide === pitcherHand
    }),
    hitter: Object.freeze({
      contact: vsRight ? hitter.contactR : hitter.contactL,
      rawPower: hitter.rawPower,
      powerUtilization: vsRight
        ? hitter.powerUtilizationR
        : hitter.powerUtilizationL,
      launchTendency: hitter.launchTendency,
      sprayPull: hitter.sprayPull,
      sprayCenter: hitter.sprayCenter,
      sprayOppo: hitter.sprayOppo,
      vision: hitter.vision,
      discipline: hitter.discipline,
      speed: resolveOptionalHitterSpeed(hitter.speed)
    }),
    park: normalizePark(park),
    defense: normalizeDefense(defense),
    pitcher: Object.freeze({
      control: pitcher.control,
      command: pitcher.command,
      movement: pitcher.movement,
      pitchability: pitcher.pitchability,
      // Stuff is already derived upstream from arsenal/role in the full model.
      stuff: pitcher.stuff,
      pitchVelocityMph: resolveOptionalPitchVelocity(pitcher.pitchVelocityMph),
      fatigue: resolveOptionalFatigue(pitcher.fatigue)
    })
  });
}

export { resolveBatterSide, buildPAContext };
