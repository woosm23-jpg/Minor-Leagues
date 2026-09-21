import { calibrationConfig } from "../../config/calibration.js";
import { FAST_SIM_LOOKUP_V38 } from "../../config/fastSimLookup.v38.js";
import { getLaunchTypeProbabilities } from "./launchAngle.js";
import { getPAOutcomeProbabilities, samplePAOutcome } from "./outcomeModel.js";
import { samplePitchCount } from "./pitchCount.js";
import { getSprayZoneProbabilities, toAbsoluteFieldAngle } from "./sprayDirection.js";

const TYPES = Object.freeze(['GB', 'LD', 'FB', 'PU']);
const ZONES = Object.freeze(['PULL', 'CENTER', 'OPPO']);
const HIT_OUTCOMES = Object.freeze(['1B', '2B', '3B']);
const REPRESENTATIVE_LA = Object.freeze({ GB: 2, LD: 17, FB: 32, PU: 58 });
const REPRESENTATIVE_RELATIVE_SPRAY = Object.freeze({ PULL: 27, CENTER: 0, OPPO: -27 });

function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function logit(p) { const x = clamp(p, 0.000001, 0.999999); return Math.log(x / (1 - x)); }
function logistic(x) { return 1 / (1 + Math.exp(-x)); }

function sampleCategorical(probabilities, order, rng) {
  let roll = rng.next();
  for (const key of order) {
    const p = probabilities[key] ?? 0;
    if (roll < p) return key;
    roll -= p;
  }
  return order.at(-1);
}

function nearestLabel(value, entries) {
  let best = entries[0];
  let bestDistance = Math.abs(value - best[1]);
  for (let i = 1; i < entries.length; i += 1) {
    const d = Math.abs(value - entries[i][1]);
    if (d < bestDistance) { best = entries[i]; bestDistance = d; }
  }
  return best[0];
}

function linearRatingZ(value) { return (value - 50) / 15; }

function selectPowerTier(context) {
  const value = 0.65 * context.hitter.rawPower + 0.35 * context.hitter.powerUtilization;
  return value < 46 ? 'LOW' : value > 54 ? 'HIGH' : 'MID';
}

function selectQualityTier(context) {
  const h = context.hitter, p = context.pitcher;
  const score =
    0.55 * (h.contact - 50) +
    0.12 * (h.rawPower - 50) +
    0.18 * (h.powerUtilization - 50) -
    0.38 * (p.movement - 50) -
    0.17 * (p.command - 50);
  return score < -4.5 ? 'LOW' : score > 4.5 ? 'HIGH' : 'MID';
}

function averageWallFt(park) {
  const points = park?.wallProfile ?? [];
  return points.length ? points.reduce((sum, row) => sum + row.distanceFt, 0) / points.length : FAST_SIM_LOOKUP_V38.parkMeta.NEUTRAL.averageWallFt;
}

function selectParkTier(context) {
  const carry = context.park?.carryFactor ?? 1;
  const wall = averageWallFt(context.park);
  let best = 'NEUTRAL', bestDistance = Infinity;
  for (const [label, meta] of Object.entries(FAST_SIM_LOOKUP_V38.parkMeta)) {
    const distance = Math.abs(carry - meta.carryFactor) / 0.02 + Math.abs(wall - meta.averageWallFt) / 15;
    if (distance < bestDistance) { best = label; bestDistance = distance; }
  }
  return best;
}

function interpolateWall(park, angle) {
  const points = park?.wallProfile ?? [];
  if (points.length < 2) return { distanceFt: 362, heightFt: 8 };
  for (let i = 0; i < points.length - 1; i += 1) {
    const left = points[i], right = points[i + 1];
    if (angle >= left.angleDegrees && angle <= right.angleDegrees) {
      const t = (angle - left.angleDegrees) / (right.angleDegrees - left.angleDegrees || 1);
      return {
        distanceFt: left.distanceFt + (right.distanceFt - left.distanceFt) * t,
        heightFt: left.heightFt + (right.heightFt - left.heightFt) * t
      };
    }
  }
  const endpoint = angle < 0 ? points[0] : points.at(-1);
  return { distanceFt: endpoint.distanceFt, heightFt: endpoint.heightFt };
}

function primaryPosition(type, angle, distanceFt) {
  const g = calibrationConfig.defense.fielderSpecific.geometry;
  if (type === 'GB' || type === 'PU' || (type === 'LD' && distanceFt < g.shallowLineDriveFt) || (type === 'FB' && distanceFt < g.shallowFlyBallFt)) {
    if (type === 'PU' && distanceFt <= g.catcherPopupFt && Math.abs(angle) <= g.catcherPopupHalfAngle) return 'C';
    if (type === 'GB' && Math.abs(angle) <= g.pitcherGroundBallHalfAngle) return 'P';
    if (angle < g.thirdBaseBoundary) return '3B';
    if (angle < g.shortstopBoundary) return 'SS';
    if (angle <= g.secondBaseBoundary) return '2B';
    return '1B';
  }
  if (angle < g.outfieldLeftBoundary) return 'LF';
  if (angle > g.outfieldRightBoundary) return 'RF';
  return 'CF';
}

function defenseAdjustment(context, type, position) {
  const defense = context.defense;
  const params = calibrationConfig.defense;
  if (defense?.mode === 'FIELDERS' && defense.fielders?.[position]) {
    const fielder = defense.fielders[position];
    const weights = params.fielderSpecific.reachWeightsByType[type];
    const familiarity = (fielder.familiarity - 1) * 1.25;
    const reachZ = weights.reaction * linearRatingZ(fielder.reaction) + weights.speed * linearRatingZ(fielder.speed) + familiarity;
    const fieldingZ = linearRatingZ(fielder.fielding) + familiarity;
    return 0.68 * reachZ + 0.32 * fieldingZ;
  }
  if (defense?.mode === 'AGGREGATE') {
    const range = type === 'GB' ? defense.infieldRange : defense.outfieldRange;
    return params.rangeWeight * linearRatingZ(range) + params.fieldingWeight * linearRatingZ(defense.fielding);
  }
  return 0;
}

function officialErrorProbability(context, type, position) {
  if (context.defense?.mode !== 'FIELDERS') return 0;
  const fielder = context.defense.fielders?.[position];
  if (!fielder) return 0;
  const params = calibrationConfig.defense.fielderSpecific.error;
  const familiarity = (fielder.familiarity - 1) * 1.25;
  const fieldingZ = linearRatingZ(fielder.fielding) + familiarity;
  const accuracyZ = linearRatingZ(fielder.armAccuracy) + familiarity;
  const accuracyWeight = type === 'GB' ? params.armAccuracySkillLogitScale : 0;
  return logistic(logit(params.neutralProbabilityOnWouldBeOutByType[type]) - params.fieldingSkillLogitScale * fieldingZ - accuracyWeight * accuracyZ);
}

function throwingErrorShare(context, type, position) {
  if (type !== 'GB' || context.defense?.mode !== 'FIELDERS') return 0;
  const fielder = context.defense.fielders?.[position];
  if (!fielder) return 0;
  const params = calibrationConfig.defense.fielderSpecific.error;
  const familiarity = (fielder.familiarity - 1) * 1.25;
  const fieldingZ = linearRatingZ(fielder.fielding) + familiarity;
  const accuracyZ = linearRatingZ(fielder.armAccuracy) + familiarity;
  return logistic(logit(params.groundBallThrowErrorShare) + params.throwShareAccuracyLogitScale * (fieldingZ - accuracyZ));
}

function adjustedTerminalProbabilities(cell, context, type, position) {
  const raw = cell.probabilities;
  const hr = clamp(raw.HR ?? 0, 0, 0.95);
  const nonHrMass = Math.max(0.000001, 1 - hr);
  const rawHit = (raw['1B'] + raw['2B'] + raw['3B']) / nonHrMass;
  const scale = calibrationConfig.defense.defenseLogitScale[type];
  const adjustedHit = logistic(logit(rawHit) - scale * defenseAdjustment(context, type, position));
  const hitMass = nonHrMass * adjustedHit;
  const rawHitMass = Math.max(0.000001, raw['1B'] + raw['2B'] + raw['3B']);
  return Object.freeze({
    HR: hr,
    '1B': hitMass * raw['1B'] / rawHitMass,
    '2B': hitMass * raw['2B'] / rawHitMass,
    '3B': hitMass * raw['3B'] / rawHitMass,
    OUT: nonHrMass - hitMass
  });
}

function fastBattedBall(context, rng, type, zone, cell) {
  const relativeAngle = REPRESENTATIVE_RELATIVE_SPRAY[zone];
  const fieldAngleDegrees = toAbsoluteFieldAngle(relativeAngle, context.matchup.batterSide);
  const provisionalDistance = cell.avgDistanceFt;
  const position = primaryPosition(type, fieldAngleDegrees, provisionalDistance);
  const terminalProbabilities = adjustedTerminalProbabilities(cell, context, type, position);
  let outcome = sampleCategorical(terminalProbabilities, ['HR', '1B', '2B', '3B', 'OUT'], rng);
  const errorProbability = outcome === 'OUT' ? officialErrorProbability(context, type, position) : 0;
  let error = null;
  if (outcome === 'OUT' && rng.next() < errorProbability) {
    outcome = 'ROE';
    const throwing = rng.next() < throwingErrorShare(context, type, position);
    const fielder = context.defense?.fielders?.[position] ?? null;
    error = Object.freeze({ charged: true, fielderId: fielder?.id ?? null, position, type: throwing ? 'THROWING' : 'FIELDING' });
  }

  const distanceKey = outcome === 'ROE' ? 'OUT' : outcome;
  let projectedDistanceFt = cell.distanceByOutcomeFt?.[distanceKey] ?? cell.avgDistanceFt;
  const wall = interpolateWall(context.park, fieldAngleDegrees);
  const requiredDistanceFt = wall.distanceFt + wall.heightFt * calibrationConfig.park.trajectory.wallHeightDistanceFactor;
  if (outcome === 'HR') projectedDistanceFt = Math.max(projectedDistanceFt, requiredDistanceFt + 4);
  const fielder = context.defense?.mode === 'FIELDERS' ? context.defense.fielders?.[position] ?? null : null;
  const bases = outcome === '1B' || outcome === 'ROE' ? 1 : outcome === '2B' ? 2 : outcome === '3B' ? 3 : outcome === 'HR' ? 4 : 0;
  const hit = ['1B', '2B', '3B', 'HR'].includes(outcome);
  const defenseResult = Object.freeze({
    outcome,
    hit,
    reachedOnError: outcome === 'ROE',
    bases,
    hitProbability: terminalProbabilities['1B'] + terminalProbabilities['2B'] + terminalProbabilities['3B'] + terminalProbabilities.HR,
    errorProbability,
    extraBaseProbabilities: null,
    defense: context.defense,
    defensiveMode: context.defense?.mode ?? 'AGGREGATE',
    responsibleFielderId: outcome === 'HR' ? null : fielder?.id ?? null,
    responsiblePosition: outcome === 'HR' ? null : position,
    error,
    failureStage: outcome === 'ROE' ? (error?.type === 'THROWING' ? 'ERROR_THROW' : 'ERROR_FIELD') : null,
    fastLookup: Object.freeze({ qualityTier: null, powerTier: null, parkTier: null, type, zone, samples: cell.n })
  });
  return Object.freeze({
    outcome,
    hit,
    bases,
    wallClearance: Object.freeze({
      parkId: context.park?.id ?? 'custom_park',
      wallDistanceFt: wall.distanceFt,
      wallHeightFt: wall.heightFt,
      requiredDistanceFt,
      projectedDistanceFt,
      clearanceMarginFt: projectedDistanceFt - requiredDistanceFt,
      eligibleLaunch: type === 'LD' || type === 'FB',
      homeRun: outcome === 'HR',
      fastApproximation: true
    }),
    defense: defenseResult,
    terminalProbabilities
  });
}

/**
 * v38 Fast PA surrogate. BB/HBP/K/BIP competition remains the shared Detailed
 * model. Only the expensive BIP trajectory/park/defense branch is replaced by
 * a lookup fitted from Detailed simulations. The returned shape stays
 * compatible with GameState, runner advancement and official scoring.
 */
function simulateFastPA(context, rng) {
  if (!context || typeof context !== 'object') throw new TypeError('PA context가 필요합니다.');
  if (!rng || typeof rng.next !== 'function') throw new TypeError('Fast PA RNG가 필요합니다.');
  const probabilities = getPAOutcomeProbabilities(context);
  const outcome = samplePAOutcome(probabilities, rng);
  const pitchCount = samplePitchCount(outcome, rng);
  if (outcome !== 'BIP') {
    return Object.freeze({
      schemaVersion: 10, engineMode: 'FAST', outcome, finalOutcome: outcome, terminal: true,
      probabilities, pitchCount, contactQuality: null, exitVelocity: null, launchAngle: null, spray: null,
      battedBallResult: null, fastLookup: null
    });
  }

  const powerTier = selectPowerTier(context);
  const qualityTier = selectQualityTier(context);
  const parkTier = selectParkTier(context);
  const launchProbabilities = getLaunchTypeProbabilities(context);
  const type = sampleCategorical(launchProbabilities, TYPES, rng);
  const launchAngle = Object.freeze({ type, degrees: REPRESENTATIVE_LA[type], sweetSpot: type === 'LD' || type === 'FB', probabilities: launchProbabilities, fastApproximation: true });
  const sprayProbabilities = getSprayZoneProbabilities(context, launchAngle);
  const zone = sampleCategorical(sprayProbabilities, ZONES, rng);
  const relative = REPRESENTATIVE_RELATIVE_SPRAY[zone];
  const spray = Object.freeze({
    zone,
    batterRelativeDegrees: relative,
    fieldAngleDegrees: toAbsoluteFieldAngle(relative, context.matchup.batterSide),
    fieldSide: zone === 'CENTER' ? 'CF' : (toAbsoluteFieldAngle(relative, context.matchup.batterSide) < 0 ? 'LF' : 'RF'),
    launchGroup: type === 'GB' ? 'GB' : 'AIR',
    probabilities: sprayProbabilities,
    fastApproximation: true
  });
  const cell = FAST_SIM_LOOKUP_V38.lookup[qualityTier][powerTier][parkTier][type][zone];
  const battedBallResult = fastBattedBall(context, rng, type, zone, cell);
  const defense = battedBallResult.defense;
  const patchedDefense = Object.freeze({ ...defense, fastLookup: Object.freeze({ qualityTier, powerTier, parkTier, type, zone, samples: cell.n }) });
  const patchedBatted = Object.freeze({ ...battedBallResult, defense: patchedDefense });

  return Object.freeze({
    schemaVersion: 10,
    engineMode: 'FAST',
    outcome,
    finalOutcome: patchedBatted.outcome,
    terminal: true,
    probabilities,
    pitchCount,
    contactQuality: null,
    exitVelocity: null,
    launchAngle,
    spray,
    battedBallResult: patchedBatted,
    fastLookup: patchedDefense.fastLookup
  });
}

export { simulateFastPA };
