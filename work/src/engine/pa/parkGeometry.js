import { calibrationConfig } from "../../config/calibration.js";

const WALL_ANGLES = Object.freeze([-45, -22.5, 0, 22.5, 45]);

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label}은(는) 유한한 number여야 합니다.`);
  }
}

function validateWallProfile(park) {
  if (!park || typeof park !== "object" || !Array.isArray(park.wallProfile)) {
    throw new TypeError("park.wallProfile이 필요합니다.");
  }
  if (park.wallProfile.length !== WALL_ANGLES.length) {
    throw new RangeError(`park.wallProfile은 ${WALL_ANGLES.length}개 지점을 가져야 합니다.`);
  }

  for (let i = 0; i < park.wallProfile.length; i += 1) {
    const point = park.wallProfile[i];
    if (!point || typeof point !== "object") throw new TypeError("유효하지 않은 park wall point입니다.");
    assertFiniteNumber(point.angleDegrees, "park wall angle");
    assertFiniteNumber(point.distanceFt, "park wall distance");
    assertFiniteNumber(point.heightFt, "park wall height");
    if (Math.abs(point.angleDegrees - WALL_ANGLES[i]) > 1e-9) {
      throw new RangeError(`park wall angle은 ${WALL_ANGLES.join(", ")} 순서를 따라야 합니다.`);
    }
    if (point.distanceFt < 250 || point.distanceFt > 500) {
      throw new RangeError("park wall distance는 250–500 ft 범위여야 합니다.");
    }
    if (point.heightFt < 0 || point.heightFt > 60) {
      throw new RangeError("park wall height는 0–60 ft 범위여야 합니다.");
    }
  }
}

function createNeutralPark(config = calibrationConfig) {
  const park = config.park.neutralPark;
  return Object.freeze({
    id: park.id,
    name: park.name,
    carryFactor: park.carryFactor,
    wallProfile: Object.freeze(park.wallProfile.map((point) => Object.freeze({ ...point })))
  });
}

function normalizePark(park, config = calibrationConfig) {
  const resolved = park ?? createNeutralPark(config);
  validateWallProfile(resolved);
  const carryFactor = resolved.carryFactor ?? 1;
  assertFiniteNumber(carryFactor, "park.carryFactor");
  if (carryFactor < 0.85 || carryFactor > 1.15) {
    throw new RangeError("park.carryFactor는 0.85–1.15 범위여야 합니다.");
  }

  return Object.freeze({
    id: resolved.id ?? "custom_park",
    name: resolved.name ?? "Custom Park",
    carryFactor,
    wallProfile: Object.freeze(resolved.wallProfile.map((point) => Object.freeze({ ...point })))
  });
}

function getWallAtFieldAngle(park, fieldAngleDegrees) {
  validateWallProfile(park);
  assertFiniteNumber(fieldAngleDegrees, "fieldAngleDegrees");
  if (fieldAngleDegrees < -45 || fieldAngleDegrees > 45) {
    throw new RangeError("fieldAngleDegrees는 -45–45° 범위여야 합니다.");
  }

  const points = park.wallProfile;
  for (let i = 0; i < points.length - 1; i += 1) {
    const left = points[i];
    const right = points[i + 1];
    if (fieldAngleDegrees >= left.angleDegrees && fieldAngleDegrees <= right.angleDegrees) {
      const span = right.angleDegrees - left.angleDegrees;
      const t = span === 0 ? 0 : (fieldAngleDegrees - left.angleDegrees) / span;
      return Object.freeze({
        distanceFt: left.distanceFt + (right.distanceFt - left.distanceFt) * t,
        heightFt: left.heightFt + (right.heightFt - left.heightFt) * t
      });
    }
  }

  const endpoint = fieldAngleDegrees < 0 ? points[0] : points.at(-1);
  return Object.freeze({ distanceFt: endpoint.distanceFt, heightFt: endpoint.heightFt });
}

/**
 * Calibrated trajectory surrogate for Phase 0.
 *
 * This is not a direct HR probability. EV + numeric LA determine a projected
 * carry distance, which is then compared with the actual wall at the sampled
 * spray angle. Later park/weather work can replace this surrogate without
 * changing the causal order.
 */
function estimateCarryDistanceFt(exitVelocityMph, launchAngleDegrees, park, config = calibrationConfig) {
  assertFiniteNumber(exitVelocityMph, "exitVelocityMph");
  assertFiniteNumber(launchAngleDegrees, "launchAngleDegrees");
  const params = config.park.trajectory;
  const carryFactor = park?.carryFactor ?? 1;
  const angleDelta = launchAngleDegrees - params.optimalLaunchAngleDegrees;
  const rawDistance =
    params.interceptFt +
    params.feetPerMph * exitVelocityMph -
    params.anglePenaltyFtPerDegreeSquared * angleDelta * angleDelta;
  return Math.max(0, rawDistance * carryFactor);
}

function resolveWallClearance(exitVelocity, launchAngle, spray, park, config = calibrationConfig) {
  if (!exitVelocity || typeof exitVelocity.mph !== "number") {
    throw new TypeError("Park resolution에는 Exit Velocity 결과가 필요합니다.");
  }
  if (!launchAngle || typeof launchAngle.degrees !== "number") {
    throw new TypeError("Park resolution에는 Launch Angle 결과가 필요합니다.");
  }
  if (!spray || typeof spray.fieldAngleDegrees !== "number") {
    throw new TypeError("Park resolution에는 Spray 결과가 필요합니다.");
  }

  const normalizedPark = normalizePark(park, config);
  const wall = getWallAtFieldAngle(normalizedPark, spray.fieldAngleDegrees);
  const projectedDistanceFt = estimateCarryDistanceFt(
    exitVelocity.mph,
    launchAngle.degrees,
    normalizedPark,
    config
  );
  const params = config.park.trajectory;
  const requiredDistanceFt = wall.distanceFt + wall.heightFt * params.wallHeightDistanceFactor;
  const eligibleLaunch =
    launchAngle.degrees >= params.homeRunLaunchAngleMin &&
    launchAngle.degrees <= params.homeRunLaunchAngleMax;
  const clearanceMarginFt = projectedDistanceFt - requiredDistanceFt;
  const homeRun = eligibleLaunch && clearanceMarginFt >= 0;

  return Object.freeze({
    parkId: normalizedPark.id,
    wallDistanceFt: wall.distanceFt,
    wallHeightFt: wall.heightFt,
    requiredDistanceFt,
    projectedDistanceFt,
    clearanceMarginFt,
    eligibleLaunch,
    homeRun
  });
}

export { createNeutralPark, normalizePark, getWallAtFieldAngle, estimateCarryDistanceFt, resolveWallClearance };
