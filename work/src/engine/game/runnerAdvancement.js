import { gameplayCalibration } from "../../config/gameplayCalibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const RUNNER_OUTCOMES = new Set(["BB", "HBP", "ROE", "1B", "2B", "3B", "HR", "K", "OUT"]);
const OUTFIELD_POSITIONS = new Set(["LF", "CF", "RF"]);

function assertBases(bases) {
  if (!bases || typeof bases !== "object") throw new TypeError("bases 객체가 필요합니다.");
  for (const key of ["first", "second", "third"]) {
    if (!(key in bases)) throw new TypeError(`bases.${key}가 필요합니다.`);
  }
}

function assertRng(rng) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("주자 진루에는 next()를 제공하는 RNG가 필요합니다.");
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function logit(p) {
  const safe = clamp(p, 0.000001, 0.999999);
  return Math.log(safe / (1 - safe));
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function neutralRunner(id) {
  return Object.freeze({ id, speed: 50, baserunning: 50 });
}

function getRunnerProfile(id, resolver) {
  if (id === null) return null;
  if (typeof resolver !== "function") return neutralRunner(id);
  const profile = resolver(id);
  if (!profile || profile.id !== id) throw new RangeError(`주자 profile을 찾을 수 없습니다: ${id}`);
  for (const key of ["speed", "baserunning"]) ratingToLatent(profile[key]);
  return profile;
}

function getProjectedDistance(paResult, fallback = 220) {
  const value = paResult?.battedBallResult?.wallClearance?.projectedDistanceFt;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getFieldAngle(paResult) {
  const value = paResult?.spray?.fieldAngleDegrees;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getOutfieldThrower(paResult, config) {
  const defense = paResult?.battedBallResult?.defense?.defense;
  const fielders = defense?.fielders;
  if (!fielders) {
    return Object.freeze({ id: null, position: "CF", armStrength: 50, armAccuracy: 50 });
  }
  const angle = getFieldAngle(paResult);
  const boundary = config.detailedBaserunning.outfieldBoundaryDegrees;
  const position = angle < -boundary ? "LF" : angle > boundary ? "RF" : "CF";
  const fielder = fielders[position];
  if (!fielder) return Object.freeze({ id: null, position, armStrength: 50, armAccuracy: 50 });
  return Object.freeze({
    id: fielder.id,
    position,
    armStrength: fielder.armStrength,
    armAccuracy: fielder.armAccuracy
  });
}

function lateGameAggression(kind, gameContext, outs) {
  if (!gameContext || gameContext.inning < 7) return 0;
  const diff = gameContext.battingScore - gameContext.fieldingScore;
  if (outs === 2) return 0.08;
  if (kind === "SECOND_HOME_SINGLE" || kind === "FIRST_HOME_DOUBLE" || kind === "TAG_HOME") {
    if (diff < 0 && diff >= -2) return 0.10;
    if (diff === 0) return 0.04;
  }
  if (kind === "FIRST_THIRD_SINGLE" && diff > 0) return -0.05;
  return 0;
}

function angleRunValue(kind, angle, config) {
  const scale = config.detailedBaserunning.angleLogitScale;
  if (kind === "FIRST_THIRD_SINGLE") {
    // A ball to RF generally creates the longest throw to third; LF the shortest.
    return scale * clamp(angle / 45, -1, 1);
  }
  if (kind === "SECOND_HOME_SINGLE" || kind === "FIRST_HOME_DOUBLE") {
    // Corner outfielders have a somewhat shorter/direct throw home than deep CF.
    return scale * 0.35 * clamp(Math.abs(angle) / 45 - 0.35, -0.35, 0.65);
  }
  return 0;
}

/**
 * Separate decision from execution for a non-forced advancement opportunity.
 * Baserunning improves decision quality; Speed dominates the actual race.
 */
function getAdvancementOpportunity({
  kind,
  runner,
  outs,
  paResult,
  gameContext = null,
  config = gameplayCalibration
}) {
  const spec = config.detailedBaserunning.opportunities[kind];
  if (!spec) throw new RangeError(`지원하지 않는 진루 opportunity입니다: ${kind}`);
  if (!Number.isInteger(outs) || outs < 0 || outs > 2) throw new RangeError("outs는 0–2여야 합니다.");
  const runnerProfile = runner ?? neutralRunner("neutral");
  const speedZ = ratingToLatent(runnerProfile.speed);
  const baserunningZ = ratingToLatent(runnerProfile.baserunning);
  const thrower = getOutfieldThrower(paResult, config);
  const armStrengthZ = ratingToLatent(thrower.armStrength);
  const armAccuracyZ = ratingToLatent(thrower.armAccuracy);
  const distance = getProjectedDistance(paResult, spec.referenceDistanceFt);
  const depthDelta = (distance - spec.referenceDistanceFt) / spec.distanceScaleFt;
  const angle = getFieldAngle(paResult);

  const execution = config.detailedBaserunning.execution;
  const successLogit =
    logit(spec.neutralSuccessProbability) +
    execution.speedLogitScale * speedZ +
    execution.baserunningRouteLogitScale * baserunningZ +
    spec.depthSuccessLogitScale * depthDelta +
    angleRunValue(kind, angle, config) -
    execution.armStrengthLogitScale * armStrengthZ -
    execution.armAccuracyLogitScale * armAccuracyZ;
  const successProbability = logistic(successLogit);

  const decision = config.detailedBaserunning.decision;
  const quality = successProbability - spec.neutralSuccessProbability;
  const decisionSharpness = Math.max(0.45, 1 + decision.baserunningSharpnessScale * baserunningZ);
  const attemptLogit =
    logit(spec.neutralAttemptProbabilityByOuts[outs]) +
    decision.opportunityQualityLogitScale * quality * decisionSharpness +
    decision.speedAwarenessLogitScale * speedZ +
    lateGameAggression(kind, gameContext, outs);
  const attemptProbability = logistic(attemptLogit);

  return Object.freeze({
    kind,
    runnerId: runnerProfile.id,
    attemptProbability,
    successProbability,
    projectedDistanceFt: distance,
    fieldAngleDegrees: angle,
    throwingFielderId: thrower.id,
    throwingPosition: thrower.position,
    armStrength: thrower.armStrength,
    armAccuracy: thrower.armAccuracy
  });
}

function sampleOpportunity({ kind, runner, outs, paResult, gameContext, rng, config }) {
  const opportunity = getAdvancementOpportunity({ kind, runner, outs, paResult, gameContext, config });
  const attempted = rng.next() < opportunity.attemptProbability;
  if (!attempted) {
    return Object.freeze({ ...opportunity, attempted: false, success: false, out: false });
  }
  const success = rng.next() < opportunity.successProbability;
  return Object.freeze({ ...opportunity, attempted: true, success, out: !success });
}

function frozenResult({
  bases,
  scoredRunnerIds = [],
  additionalOuts = 0,
  outRunnerIds = [],
  isSacrificeFly = false,
  isGroundBallDoublePlay = false,
  advancementEvents = []
}) {
  return Object.freeze({
    bases: Object.freeze({ ...bases }),
    scoredRunnerIds: Object.freeze([...scoredRunnerIds]),
    additionalOuts,
    outRunnerIds: Object.freeze([...outRunnerIds]),
    isSacrificeFly: Boolean(isSacrificeFly),
    isGroundBallDoublePlay: Boolean(isGroundBallDoublePlay),
    advancementEvents: Object.freeze(advancementEvents.map((event) => Object.freeze({ ...event })))
  });
}

function adjustedGroundAdvanceProbability(base, runner, scale = 0.10) {
  const speedZ = ratingToLatent(runner.speed);
  const baserunningZ = ratingToLatent(runner.baserunning);
  return logistic(logit(base) + scale * (0.65 * speedZ + 0.35 * baserunningZ));
}

function resolveGroundOut({ bases, outs, rng, paResult, getRunnerProfile: profileResolver, gameContext, config }) {
  const next = { ...bases };
  const scored = [];
  const outRunnerIds = [];
  const events = [];
  let additionalOuts = 0;

  const firstRunner = getRunnerProfile(next.first, profileResolver);
  if (firstRunner && outs < 2) {
    const dpBase = config.runnerAdvancement.groundBallDoublePlayProbabilityByOuts[outs];
    const fielder = getOutfieldThrower(paResult, config); // neutral/OF fallback; primary arm below if available
    const primary = paResult?.battedBallResult?.defense;
    const primaryFielder = primary?.responsiblePosition && primary?.defense?.fielders?.[primary.responsiblePosition];
    const armZ = primaryFielder
      ? 0.5 * ratingToLatent(primaryFielder.armStrength) + 0.5 * ratingToLatent(primaryFielder.armAccuracy)
      : 0;
    const runnerZ = 0.70 * ratingToLatent(firstRunner.speed) + 0.30 * ratingToLatent(firstRunner.baserunning);
    const dpProbability = logistic(logit(dpBase) + 0.12 * armZ - 0.14 * runnerZ);
    if (rng.next() < dpProbability) {
      outRunnerIds.push(next.first);
      next.first = null;
      additionalOuts = 1;
      events.push({ kind: "GROUND_BALL_DOUBLE_PLAY", runnerId: firstRunner.id, attempted: true, success: false, out: true, attemptProbability: dpProbability, successProbability: 0 });
      return frozenResult({ bases: next, additionalOuts, outRunnerIds, isGroundBallDoublePlay: true, advancementEvents: events });
    }
    void fielder;
  }

  if (outs >= 2) return frozenResult({ bases: next });

  if (next.third !== null) {
    const runner = getRunnerProfile(next.third, profileResolver);
    const p = adjustedGroundAdvanceProbability(config.runnerAdvancement.groundOutFromThirdScoreByOuts[outs], runner, 0.08);
    if (rng.next() < p) {
      scored.push(next.third);
      events.push({ kind: "GROUND_THIRD_HOME", runnerId: next.third, attempted: true, success: true, out: false, attemptProbability: p, successProbability: 1 });
      next.third = null;
    }
  }
  if (next.second !== null && next.third === null) {
    const runner = getRunnerProfile(next.second, profileResolver);
    const p = adjustedGroundAdvanceProbability(config.runnerAdvancement.groundOutFromSecondToThirdByOuts[outs], runner);
    if (rng.next() < p) {
      events.push({ kind: "GROUND_SECOND_THIRD", runnerId: next.second, attempted: true, success: true, out: false, attemptProbability: p, successProbability: 1 });
      next.third = next.second;
      next.second = null;
    }
  }
  if (next.first !== null && next.second === null) {
    const runner = getRunnerProfile(next.first, profileResolver);
    const p = adjustedGroundAdvanceProbability(config.runnerAdvancement.groundOutFromFirstToSecondByOuts[outs], runner);
    if (rng.next() < p) {
      events.push({ kind: "GROUND_FIRST_SECOND", runnerId: next.first, attempted: true, success: true, out: false, attemptProbability: p, successProbability: 1 });
      next.second = next.first;
      next.first = null;
    }
  }
  return frozenResult({ bases: next, scoredRunnerIds: scored, advancementEvents: events });
}

function resolveReachedOnError({ bases, batterId, paResult }) {
  const next = { first: batterId, second: null, third: null };
  const scored = [];
  const position = paResult?.battedBallResult?.defense?.responsiblePosition ?? null;
  const isOutfieldError = OUTFIELD_POSITIONS.has(position);

  // Infield errors advance only forced runners in this Phase 1 baseline.
  // Outfield errors allow each existing runner one base because the ball has
  // already passed the initial catch/fielding opportunity. Extra error bases
  // and relay mistakes are deferred to the deeper scoring layer.
  if (isOutfieldError) {
    if (bases.third !== null) scored.push(bases.third);
    if (bases.second !== null) next.third = bases.second;
    if (bases.first !== null) next.second = bases.first;
    return frozenResult({ bases: next, scoredRunnerIds: scored });
  }

  if (bases.first !== null) {
    next.second = bases.first;
    if (bases.second !== null) {
      next.third = bases.second;
      if (bases.third !== null) scored.push(bases.third);
    } else if (bases.third !== null) {
      next.third = bases.third;
    }
  } else {
    next.second = bases.second;
    next.third = bases.third;
  }
  return frozenResult({ bases: next, scoredRunnerIds: scored });
}

function resolveCaughtAir({ bases, outs, rng, paResult, getRunnerProfile: profileResolver, gameContext, config }) {
  if (outs >= 2) return frozenResult({ bases });
  const launchType = paResult?.launchAngle?.type ?? null;
  if (launchType !== "FB" && launchType !== "LD") return frozenResult({ bases });
  const distance = getProjectedDistance(paResult, 0);
  if (distance < config.detailedBaserunning.tagUp.minProjectedDistanceFt) return frozenResult({ bases });

  const next = { ...bases };
  const scored = [];
  const outsOnBases = [];
  const events = [];
  let additionalOuts = 0;

  if (next.third !== null && outs + additionalOuts < 2) {
    const runner = getRunnerProfile(next.third, profileResolver);
    const event = sampleOpportunity({ kind: "TAG_HOME", runner, outs, paResult, gameContext, rng, config });
    events.push(event);
    if (event.attempted) {
      if (event.success) {
        scored.push(next.third);
        next.third = null;
        return frozenResult({ bases: next, scoredRunnerIds: scored, isSacrificeFly: true, advancementEvents: events });
      }
      outsOnBases.push(next.third);
      next.third = null;
      additionalOuts += 1;
      if (outs + 1 + additionalOuts >= 3) return frozenResult({ bases: next, additionalOuts, outRunnerIds: outsOnBases, advancementEvents: events });
    }
  }

  if (next.second !== null && next.third === null && outs + 1 + additionalOuts < 3) {
    const runner = getRunnerProfile(next.second, profileResolver);
    const event = sampleOpportunity({ kind: "TAG_SECOND_THIRD", runner, outs, paResult, gameContext, rng, config });
    events.push(event);
    if (event.attempted) {
      if (event.success) {
        next.third = next.second;
        next.second = null;
      } else {
        outsOnBases.push(next.second);
        next.second = null;
        additionalOuts += 1;
      }
    }
  }

  if (next.first !== null && next.second === null && outs + 1 + additionalOuts < 3) {
    const runner = getRunnerProfile(next.first, profileResolver);
    const event = sampleOpportunity({ kind: "TAG_FIRST_SECOND", runner, outs, paResult, gameContext, rng, config });
    events.push(event);
    if (event.attempted) {
      if (event.success) {
        next.second = next.first;
        next.first = null;
      } else {
        outsOnBases.push(next.first);
        next.first = null;
        additionalOuts += 1;
      }
    }
  }

  return frozenResult({ bases: next, scoredRunnerIds: scored, additionalOuts, outRunnerIds: outsOnBases, advancementEvents: events });
}

function resolveRunnerAdvancement({
  bases,
  batterId,
  outcome,
  outs,
  rng,
  paResult = null,
  getRunnerProfile: profileResolver = null,
  gameContext = null,
  config = gameplayCalibration
}) {
  assertBases(bases);
  if (typeof batterId !== "string" || batterId.length === 0) throw new TypeError("batterId는 비어 있지 않은 문자열이어야 합니다.");
  if (!RUNNER_OUTCOMES.has(outcome)) throw new RangeError(`지원하지 않는 최종 PA 결과입니다: ${outcome}`);
  if (!Number.isInteger(outs) || outs < 0 || outs > 2) throw new RangeError("outs는 PA 시작 시점의 0–2 정수여야 합니다.");

  if (outcome === "K") return frozenResult({ bases });

  if (outcome === "OUT") {
    const launchType = paResult?.launchAngle?.type ?? null;
    if (launchType === "GB") {
      assertRng(rng);
      return resolveGroundOut({ bases, outs, rng, paResult, getRunnerProfile: profileResolver, gameContext, config });
    }
    assertRng(rng);
    return resolveCaughtAir({ bases, outs, rng, paResult, getRunnerProfile: profileResolver, gameContext, config });
  }

  if (outcome === "ROE") {
    return resolveReachedOnError({ bases, batterId, paResult });
  }

  if (outcome === "BB" || outcome === "HBP") {
    const next = { ...bases };
    const scored = [];
    if (bases.first !== null) {
      if (bases.second !== null) {
        if (bases.third !== null) scored.push(bases.third);
        next.third = bases.second;
      }
      next.second = bases.first;
    }
    next.first = batterId;
    return frozenResult({ bases: next, scoredRunnerIds: scored });
  }

  assertRng(rng);

  if (outcome === "1B") {
    const next = { first: batterId, second: null, third: null };
    const scored = [];
    const outRunnerIds = [];
    const events = [];
    let additionalOuts = 0;

    if (bases.third !== null) scored.push(bases.third);

    if (bases.second !== null && outs + additionalOuts < 3) {
      const runner = getRunnerProfile(bases.second, profileResolver);
      const event = sampleOpportunity({ kind: "SECOND_HOME_SINGLE", runner, outs, paResult, gameContext, rng, config });
      events.push(event);
      if (!event.attempted) next.third = bases.second;
      else if (event.success) scored.push(bases.second);
      else {
        outRunnerIds.push(bases.second);
        additionalOuts += 1;
      }
    }

    if (bases.first !== null && outs + additionalOuts < 3) {
      if (next.third !== null) {
        next.second = bases.first;
      } else {
        const runner = getRunnerProfile(bases.first, profileResolver);
        const event = sampleOpportunity({ kind: "FIRST_THIRD_SINGLE", runner, outs, paResult, gameContext, rng, config });
        events.push(event);
        if (!event.attempted) next.second = bases.first;
        else if (event.success) next.third = bases.first;
        else {
          outRunnerIds.push(bases.first);
          additionalOuts += 1;
        }
      }
    }

    return frozenResult({ bases: next, scoredRunnerIds: scored, additionalOuts, outRunnerIds, advancementEvents: events });
  }

  if (outcome === "2B") {
    const next = { first: null, second: batterId, third: null };
    const scored = [];
    const outRunnerIds = [];
    const events = [];
    let additionalOuts = 0;
    if (bases.third !== null) scored.push(bases.third);
    if (bases.second !== null) scored.push(bases.second);
    if (bases.first !== null && outs < 3) {
      const runner = getRunnerProfile(bases.first, profileResolver);
      const event = sampleOpportunity({ kind: "FIRST_HOME_DOUBLE", runner, outs, paResult, gameContext, rng, config });
      events.push(event);
      if (!event.attempted) next.third = bases.first;
      else if (event.success) scored.push(bases.first);
      else {
        outRunnerIds.push(bases.first);
        additionalOuts = 1;
      }
    }
    return frozenResult({ bases: next, scoredRunnerIds: scored, additionalOuts, outRunnerIds, advancementEvents: events });
  }

  if (outcome === "3B") {
    const scored = [bases.third, bases.second, bases.first].filter((id) => id !== null);
    return frozenResult({ bases: { first: null, second: null, third: batterId }, scoredRunnerIds: scored });
  }

  const scored = [bases.third, bases.second, bases.first, batterId].filter((id) => id !== null);
  return frozenResult({ bases: { first: null, second: null, third: null }, scoredRunnerIds: scored });
}

export { getAdvancementOpportunity, resolveRunnerAdvancement };
