import { gameplayCalibration } from "../../config/gameplayCalibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

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

function assertRng(rng) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("도루/견제 해석에는 next() RNG가 필요합니다.");
  }
}

function assertRatingProfile(profile, fields, label) {
  if (!profile || typeof profile !== "object") throw new TypeError(`${label} profile이 필요합니다.`);
  for (const field of fields) ratingToLatent(profile[field]);
}

function getCandidate(bases) {
  if (!bases || typeof bases !== "object") throw new TypeError("bases가 필요합니다.");
  if (bases.first !== null && bases.second === null) {
    return { runnerId: bases.first, fromBase: "first", toBase: "second", targetBase: 2 };
  }
  // Double-steal interaction is intentionally deferred. For a steal of third,
  // use the clean Statcast-like opportunity: runner on 2B, no runner on 1B/3B.
  if (bases.second !== null && bases.first === null && bases.third === null) {
    return { runnerId: bases.second, fromBase: "second", toBase: "third", targetBase: 3 };
  }
  return null;
}

function catcherPackageZ(catcher) {
  return (
    0.46 * ratingToLatent(catcher.armStrength) +
    0.30 * ratingToLatent(catcher.armAccuracy) +
    0.24 * ratingToLatent(catcher.reaction)
  );
}

function lateGameAttemptAdjustment({ inning, regulationInnings, battingScore, fieldingScore, outs, targetBase }) {
  if (!Number.isInteger(inning) || inning < 1) return 0;
  if (inning < Math.max(7, regulationInnings - 2)) return 0;
  const diff = battingScore - fieldingScore;
  if (Math.abs(diff) >= 4) return -0.18;
  if (diff === 0 && outs < 2) return targetBase === 2 ? 0.08 : 0.04;
  if (diff < 0 && diff >= -2 && outs < 2) return 0.05;
  return 0;
}

/**
 * Return deterministic attempt/success probabilities for one steal opportunity.
 * Stealing owns jump/read/timing; Speed owns much of the race itself.
 */
function getStealOpportunity({
  targetBase,
  runner,
  pitcher,
  catcher,
  outs,
  gameContext = null,
  config = gameplayCalibration
}) {
  if (targetBase !== 2 && targetBase !== 3) throw new RangeError("targetBase는 2 또는 3이어야 합니다.");
  if (!Number.isInteger(outs) || outs < 0 || outs > 2) throw new RangeError("outs는 0–2여야 합니다.");
  assertRatingProfile(runner, ["speed", "stealing", "baserunning"], "runner");
  assertRatingProfile(pitcher, ["holdRunner"], "pitcher");
  assertRatingProfile(catcher, ["reaction", "armStrength", "armAccuracy"], "catcher");

  const steal = config.stealing;
  const target = steal.targets[targetBase === 2 ? "second" : "third"];
  const speedZ = ratingToLatent(runner.speed);
  const stealingZ = ratingToLatent(runner.stealing);
  const baserunningZ = ratingToLatent(runner.baserunning);
  const holdZ = ratingToLatent(pitcher.holdRunner);
  const catcherZ = catcherPackageZ(catcher);

  const successLogit =
    logit(target.neutralSuccessProbability) +
    steal.execution.stealingLogitScale * stealingZ +
    steal.execution.speedLogitScale * speedZ +
    steal.execution.baserunningLogitScale * baserunningZ -
    steal.execution.holdRunnerLogitScale * holdZ -
    steal.execution.catcherLogitScale * catcherZ;
  const successProbability = logistic(successLogit);

  // Better Baserunning does not simply mean "run more". It sharpens response
  // to whether the current pitcher/catcher matchup is actually favorable.
  const quality = successProbability - target.neutralSuccessProbability;
  const decisionSharpness = Math.max(0.45, 1 + steal.decision.baserunningSharpnessScale * baserunningZ);
  const attemptLogit =
    logit(target.neutralAttemptProbabilityByOuts[outs]) +
    steal.decision.stealingAggressionLogitScale * stealingZ +
    steal.decision.speedAwarenessLogitScale * speedZ +
    steal.decision.opportunityQualityLogitScale * quality * decisionSharpness -
    steal.decision.holdDeterrenceLogitScale * holdZ -
    steal.decision.catcherDeterrenceLogitScale * catcherZ +
    lateGameAttemptAdjustment({
      inning: gameContext?.inning ?? 1,
      regulationInnings: gameContext?.regulationInnings ?? 9,
      battingScore: gameContext?.battingScore ?? 0,
      fieldingScore: gameContext?.fieldingScore ?? 0,
      outs,
      targetBase
    });
  const attemptProbability = logistic(attemptLogit);

  const pickoffLogit =
    logit(target.neutralPickoffOutProbability) +
    steal.pickoff.holdRunnerLogitScale * holdZ -
    steal.pickoff.baserunningLogitScale * baserunningZ +
    steal.pickoff.leadAggressionLogitScale * stealingZ;
  const pickoffOutProbability = logistic(pickoffLogit);

  return Object.freeze({
    runnerId: runner.id,
    targetBase,
    attemptProbability,
    successProbability,
    pickoffOutProbability,
    pitcherId: pitcher.id ?? null,
    catcherId: catcher.id ?? null
  });
}

/**
 * Resolve at most one pre-PA running event. Pickoffs are checked before the
 * steal decision; otherwise the runner may hold, steal successfully, or be CS.
 */
function resolvePrePARunningPlay({
  state,
  rng,
  resolveProfiles,
  config = gameplayCalibration,
  forceAttempt = false
}) {
  assertRng(rng);
  if (!state || typeof state !== "object") throw new TypeError("GameState가 필요합니다.");
  if (typeof resolveProfiles !== "function") throw new TypeError("resolveProfiles 함수가 필요합니다.");
  if (state.status !== "IN_PROGRESS" || state.outs >= 3) return null;

  const candidate = getCandidate(state.bases);
  if (!candidate) return null;

  const fieldingTeam = state.half === "TOP" ? "home" : "away";
  const battingTeam = fieldingTeam === "home" ? "away" : "home";
  const pitcherId = state.currentPitcherId[fieldingTeam];
  const profiles = resolveProfiles({
    state,
    runnerId: candidate.runnerId,
    pitcherId,
    fieldingTeam,
    battingTeam,
    targetBase: candidate.targetBase
  });
  if (!profiles || typeof profiles !== "object") throw new TypeError("running-game profiles가 필요합니다.");

  const opportunity = getStealOpportunity({
    targetBase: candidate.targetBase,
    runner: profiles.runner,
    pitcher: profiles.pitcher,
    catcher: profiles.catcher,
    outs: state.outs,
    gameContext: {
      inning: state.inning,
      regulationInnings: state.regulationInnings,
      battingScore: state.score[battingTeam],
      fieldingScore: state.score[fieldingTeam]
    },
    config
  });

  if (rng.next() < opportunity.pickoffOutProbability) {
    return Object.freeze({
      kind: "PICKOFF",
      runnerId: candidate.runnerId,
      fromBase: candidate.fromBase,
      toBase: candidate.toBase,
      targetBase: candidate.targetBase,
      out: true,
      pitcherId,
      catcherId: profiles.catcher.id ?? null,
      ...opportunity
    });
  }

  if (!forceAttempt && rng.next() >= opportunity.attemptProbability) return null;
  const success = rng.next() < opportunity.successProbability;
  return Object.freeze({
    kind: success ? "SB" : "CS",
    runnerId: candidate.runnerId,
    fromBase: candidate.fromBase,
    toBase: candidate.toBase,
    targetBase: candidate.targetBase,
    out: !success,
    pitcherId,
    catcherId: profiles.catcher.id ?? null,
    ...opportunity
  });
}

export { getStealOpportunity, resolvePrePARunningPlay };
