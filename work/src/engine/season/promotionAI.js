import { organizationCalibration } from "../../config/organizationCalibration.js";

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function daysBetween(a, b) {
  if (!a || !b || a === b) return 0;
  return Math.max(0, Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000));
}

function createOrganizationReviewState({ startDate = "2026-04-01" } = {}) {
  return freeze({
    schemaVersion: 1,
    lastReviewDate: startDate,
    reviews: 0,
    lastTransactionDate: null,
    latestEvaluations: {},
    transactions: []
  });
}

function normalizeOrganizationReviewState(state, { startDate = "2026-04-01" } = {}) {
  const base = createOrganizationReviewState({ startDate });
  if (!state || typeof state !== "object") return base;
  return freeze({
    ...base,
    ...state,
    schemaVersion: 1,
    latestEvaluations: state.latestEvaluations && typeof state.latestEvaluations === "object" ? state.latestEvaluations : {},
    transactions: Array.isArray(state.transactions) ? state.transactions.slice(-40) : []
  });
}

function isOrganizationReviewDue(state, date, config = organizationCalibration) {
  return daysBetween(state?.lastReviewDate, date) >= config.reviewCadenceDays;
}

function performanceAdjustment(line, level, config) {
  const games = Number(line?.G ?? 0), pa = Number(line?.PA ?? 0);
  const isMlb = level === "MLB";
  const minGames = isMlb ? config.minimumMlbGames : config.minimumAaaGames;
  const minPA = isMlb ? config.minimumMlbPA : config.minimumAaaPA;
  if (games < minGames || pa < minPA) return Object.freeze({ adjustment: 0, sampleReady: false, reliability: 0 });
  const ops = Number(line?.OPS ?? 0);
  const raw = clamp((ops - config.performance.referenceOPS) * config.performance.opsScale, -config.performance.maxAdjustment, config.performance.maxAdjustment);
  const reliabilityPA = isMlb ? config.performance.mlbReliabilityPA : config.performance.aaaReliabilityPA;
  const reliability = clamp(pa / reliabilityPA, 0, 1);
  return Object.freeze({ adjustment: raw * reliability, sampleReady: true, reliability });
}

function fatiguePenalty(fatigue, config) {
  return clamp(Number(fatigue ?? 0), 0, 100) / 100 * config.fatiguePenaltyAt100;
}

function needBonus(incumbentDepthScore, config) {
  return clamp((config.rosterNeed.weakIncumbentScore - incumbentDepthScore) * config.rosterNeed.scale, 0, config.rosterNeed.maxBonus);
}

function readiness(depthScore, config) {
  if (depthScore >= config.readiness.mlbReadyDepthScore) return "MLB_READY";
  if (depthScore >= config.readiness.nearDepthScore) return "NEAR";
  return "DEVELOPING";
}
function pathStatus(candidateDepth, incumbentDepth, config) {
  const gap = incumbentDepth - candidateDepth;
  if (gap >= config.path.blockedGap) return "BLOCKED";
  if (gap >= -config.path.competitiveGap) return "COMPETITIVE";
  return "CLEAR";
}

function candidateReasons({ candidate, incumbent, aaaPerf, mlbPerf, need, candidateScore, incumbentScore, config }) {
  const reasons = [];
  if (incumbent.depthScore - candidate.depthScore >= config.path.blockedGap && mlbPerf.adjustment > -config.performance.notableAdjustment) reasons.push("BLOCKED_BY_ESTABLISHED_STARTER");
  if (candidate.depthScore >= config.readiness.mlbReadyDepthScore) reasons.push("CURRENT_ABILITY");
  if (aaaPerf.adjustment >= config.performance.notableAdjustment) reasons.push("AAA_RECENT_PERFORMANCE");
  if (mlbPerf.adjustment <= -config.performance.notableAdjustment) reasons.push("MLB_RECENT_STRUGGLES");
  if (need >= 0.6) reasons.push("MLB_ROSTER_NEED");
  if ((candidate.roleState?.momentum ?? 0) >= 0.22) reasons.push("ROLE_MOMENTUM");
  if ((candidate.fatigue ?? 0) >= 60) reasons.push("FATIGUE_MANAGEMENT");
  if (candidateScore < incumbentScore + config.promotionMargin && !reasons.includes("BLOCKED_BY_ESTABLISHED_STARTER")) reasons.push("AAA_EVERYDAY_PLAYING_TIME");
  return [...new Set(reasons)].slice(0, 4);
}

function incumbentReasons({ candidate, incumbent, aaaPerf, mlbPerf, swap, cooldown, config }) {
  const reasons = [];
  if (mlbPerf.adjustment <= -config.performance.notableAdjustment) reasons.push("MLB_RECENT_STRUGGLES");
  if (candidate.depthScore >= config.readiness.mlbReadyDepthScore) reasons.push("AAA_REPLACEMENT_READY");
  if (aaaPerf.adjustment >= config.performance.notableAdjustment) reasons.push("AAA_REPLACEMENT_PERFORMANCE");
  if ((incumbent.roleState?.momentum ?? 0) <= -0.22) reasons.push("ROLE_MOMENTUM_FALLING");
  if (cooldown) reasons.push("TRANSACTION_STABILITY");
  if (!swap && !cooldown) reasons.push("MLB_ROLE_STABILITY");
  return [...new Set(reasons)].slice(0, 4);
}

/**
 * Periodic AAA <-> MLB same-position replacement evaluator.
 * It decides only. Roster mutation belongs to RosterService.
 *
 * v24 added real MLB season performance for the incumbent, but shrinks small
 * samples heavily so a few bad games cannot erase current ability/role value.
 */
function evaluateAaaMlbPromotion({ date, candidate, incumbent, lastTransactionDate = null, config = organizationCalibration }) {
  if (!candidate?.id || !incumbent?.id) throw new TypeError("promotion candidate/incumbent가 필요합니다.");
  const aaaPerf = performanceAdjustment(candidate.seasonLine, "AAA", config);
  const mlbPerf = performanceAdjustment(incumbent.seasonLine, "MLB", config);
  const need = needBonus(incumbent.depthScore, config);
  const candidateMomentum = clamp(Number(candidate.roleState?.momentum ?? 0), -1, 1) * config.roleMomentumScale;
  const incumbentMomentum = clamp(Number(incumbent.roleState?.momentum ?? 0), -1, 1) * config.incumbentMomentumScale;
  const candidateScore = candidate.depthScore + aaaPerf.adjustment + candidateMomentum + need - fatiguePenalty(candidate.fatigue, config);
  const incumbentBonus = config.incumbentRoleBonus[incumbent.roleState?.role] ?? 0.35;
  const incumbentScore = incumbent.depthScore + incumbentBonus + mlbPerf.adjustment + incumbentMomentum - fatiguePenalty(incumbent.fatigue, config);
  const sampleReady = aaaPerf.sampleReady;
  const mlbSampleReady = mlbPerf.sampleReady;
  const cooldown = lastTransactionDate ? daysBetween(lastTransactionDate, date) < config.transactionCooldownDays : false;
  const injuryBlocked = Boolean(candidate.injured || incumbent.injured);
  const eligible = sampleReady && !cooldown && !injuryBlocked;
  const promote = eligible && candidateScore >= incumbentScore + config.promotionMargin;
  const candidateReasonCodes = candidateReasons({ candidate, incumbent, aaaPerf, mlbPerf, need, candidateScore, incumbentScore, config });
  const incumbentReasonCodes = incumbentReasons({ candidate, incumbent, aaaPerf, mlbPerf, swap: promote, cooldown, config });
  return freeze({
    date,
    position: candidate.position,
    candidateId: candidate.id,
    incumbentId: incumbent.id,
    readiness: readiness(candidate.depthScore, config),
    path: promote ? "CLEAR" : pathStatus(candidate.depthScore, incumbent.depthScore, config),
    decision: promote ? "PROMOTE" : "HOLD",
    incumbentDecision: promote ? "DEMOTE" : "HOLD",
    sampleReady,
    mlbSampleReady,
    cooldown,
    injuryBlocked,
    reasonCodes: candidateReasonCodes,
    candidateReasonCodes,
    incumbentReasonCodes,
    // Debug/test-only internals. Never expose through the public API.
    internal: freeze({ candidateScore, incumbentScore, aaaPerf: aaaPerf.adjustment, mlbPerf: mlbPerf.adjustment, need })
  });
}


function minorPairKey(fromLevel, toLevel) { return `${fromLevel}_${toLevel}`; }
function validateMinorPair(fromLevel, toLevel, config) {
  const ok = (config.ladder?.adjacentPairs ?? []).some((row) => row.fromLevel === fromLevel && row.toLevel === toLevel);
  if (!ok) throw new RangeError(`지원하지 않는 minor 이동 구간입니다: ${fromLevel}->${toLevel}`);
}
function minorReadiness(depthScore, toLevel, config) {
  if (depthScore >= config.ladder.readyDepthScore[toLevel]) return "READY";
  if (depthScore >= config.ladder.nearDepthScore[toLevel]) return "NEAR";
  return "DEVELOPING";
}
function minorNeedBonus(incumbentDepthScore, toLevel, config) {
  const weak = config.ladder.weakIncumbentScore[toLevel];
  return clamp((weak - incumbentDepthScore) * config.ladder.needScale, 0, config.ladder.maxNeedBonus);
}
function minorCandidateReasons({ candidate, lowerPerf, upperPerf, need, candidateScore, incumbentScore, cooldown, toLevel, config }) {
  const reasons = [];
  if (candidate.depthScore >= config.ladder.readyDepthScore[toLevel]) reasons.push("CURRENT_ABILITY");
  if (lowerPerf.adjustment >= config.performance.notableAdjustment) reasons.push("LOWER_LEVEL_RECENT_PERFORMANCE");
  if (upperPerf.adjustment <= -config.performance.notableAdjustment) reasons.push("UPPER_LEVEL_RECENT_STRUGGLES");
  if (need >= 0.5) reasons.push("UPPER_LEVEL_DEPTH_NEED");
  if ((candidate.roleState?.momentum ?? 0) >= 0.22) reasons.push("ROLE_MOMENTUM");
  if ((candidate.fatigue ?? 0) >= 60) reasons.push("FATIGUE_MANAGEMENT");
  if (cooldown) reasons.push("TRANSACTION_STABILITY");
  if (candidateScore < incumbentScore + config.ladder.promotionMargin[minorPairKey(candidate.fromLevel ?? "", toLevel)] && !cooldown) reasons.push("DEVELOPMENT_PATH_STABILITY");
  return [...new Set(reasons)].slice(0, 4);
}
function minorIncumbentReasons({ candidate, lowerPerf, upperPerf, promote, cooldown, toLevel, config }) {
  const reasons = [];
  if (upperPerf.adjustment <= -config.performance.notableAdjustment) reasons.push("UPPER_LEVEL_RECENT_STRUGGLES");
  if (candidate.depthScore >= config.ladder.readyDepthScore[toLevel]) reasons.push("LOWER_LEVEL_REPLACEMENT_READY");
  if (lowerPerf.adjustment >= config.performance.notableAdjustment) reasons.push("LOWER_LEVEL_REPLACEMENT_PERFORMANCE");
  if (cooldown) reasons.push("TRANSACTION_STABILITY");
  if (!promote && !cooldown) reasons.push("UPPER_LEVEL_ROLE_STABILITY");
  return [...new Set(reasons)].slice(0, 4);
}

/**
 * Periodic A->AA or AA->AAA same-position evaluator.
 * Lower-minor reviews intentionally emphasize stable development paths more
 * than the MLB-ready evaluator while still using the same simulated season
 * lines and current public ability. It decides only; RosterService mutates.
 */
function evaluateMinorLevelPromotion({ date, fromLevel, toLevel, candidate, incumbent, lastTransactionDate = null, config = organizationCalibration }) {
  validateMinorPair(fromLevel, toLevel, config);
  if (!candidate?.id || !incumbent?.id) throw new TypeError("minor promotion candidate/incumbent가 필요합니다.");
  const lowerPerf = performanceAdjustment(candidate.seasonLine, fromLevel, config);
  const upperPerf = performanceAdjustment(incumbent.seasonLine, toLevel, config);
  const need = minorNeedBonus(incumbent.depthScore, toLevel, config);
  const candidateMomentum = clamp(Number(candidate.roleState?.momentum ?? 0), -1, 1) * config.ladder.roleMomentumScale;
  const incumbentMomentum = clamp(Number(incumbent.roleState?.momentum ?? 0), -1, 1) * config.ladder.roleMomentumScale * 0.5;
  const candidateScore = candidate.depthScore + lowerPerf.adjustment * config.ladder.performanceWeight + candidateMomentum + need
    - clamp(Number(candidate.fatigue ?? 0), 0, 100) / 100 * config.ladder.fatiguePenaltyAt100;
  const incumbentScore = incumbent.depthScore + config.ladder.incumbentRoleBonus + upperPerf.adjustment * config.ladder.upperPerformanceWeight + incumbentMomentum
    - clamp(Number(incumbent.fatigue ?? 0), 0, 100) / 100 * config.ladder.fatiguePenaltyAt100;
  const cooldown = lastTransactionDate ? daysBetween(lastTransactionDate, date) < config.transactionCooldownDays : false;
  const margin = config.ladder.promotionMargin[minorPairKey(fromLevel, toLevel)];
  const injuryBlocked = Boolean(candidate.injured || incumbent.injured);
  const eligible = lowerPerf.sampleReady && !cooldown && !injuryBlocked;
  const promote = eligible && candidateScore >= incumbentScore + margin;
  const candidateWithLevel = { ...candidate, fromLevel };
  const candidateReasonCodes = minorCandidateReasons({ candidate: candidateWithLevel, lowerPerf, upperPerf, need, candidateScore, incumbentScore, cooldown, toLevel, config });
  const incumbentReasonCodes = minorIncumbentReasons({ candidate, lowerPerf, upperPerf, promote, cooldown, toLevel, config });
  return freeze({
    kind: "POSITION_PLAYER",
    date, fromLevel, toLevel,
    evaluationKey: `${fromLevel}_${toLevel}_${candidate.position}`,
    position: candidate.position,
    candidateId: candidate.id,
    incumbentId: incumbent.id,
    readiness: minorReadiness(candidate.depthScore, toLevel, config),
    path: promote ? "CLEAR" : pathStatus(candidate.depthScore, incumbent.depthScore, config),
    decision: promote ? "PROMOTE" : "HOLD",
    incumbentDecision: promote ? "DEMOTE" : "HOLD",
    sampleReady: lowerPerf.sampleReady,
    upperSampleReady: upperPerf.sampleReady,
    mlbSampleReady: false,
    cooldown,
    injuryBlocked,
    reasonCodes: candidateReasonCodes,
    candidateReasonCodes,
    incumbentReasonCodes,
    internal: freeze({ candidateScore, incumbentScore, lowerPerf: lowerPerf.adjustment, upperPerf: upperPerf.adjustment, need })
  });
}


function pitcherPerformanceAdjustment(line, role, level, config) {
  const params = config.pitcher.performance;
  const bf = Number(line?.BF ?? 0);
  const outs = Number(line?.outsRecorded ?? 0);
  const levelKey = level === "MLB" ? "MLB" : "AAA";
  const minBF = level === "MLB" ? params.minMlbBF[role] : params.minAaaBF[role];
  const minOuts = level === "MLB" ? params.minMlbOuts[role] : params.minAaaOuts[role];
  if (bf < minBF || outs < minOuts) return Object.freeze({ adjustment: 0, sampleReady: false, reliability: 0 });
  const ra9 = Number(line?.RA9 ?? (outs > 0 ? Number(line?.R ?? 0) * 27 / outs : params.referenceRA9));
  const whip = Number(line?.WHIP ?? (outs > 0 ? (Number(line?.H ?? 0) + Number(line?.BB ?? 0)) * 3 / outs : params.referenceWHIP));
  const kbb = Number(line?.KBB ?? (bf > 0 ? (Number(line?.SO ?? 0) - Number(line?.BB ?? 0)) / bf : params.referenceKMinusBB));
  const raw =
    (params.referenceRA9 - ra9) * params.ra9Weight +
    (params.referenceWHIP - whip) * params.whipWeight +
    (kbb - params.referenceKMinusBB) * params.kMinusBbWeight;
  const reliability = clamp(bf / params.reliabilityBF[`${levelKey}_${role}`], 0, 1);
  return Object.freeze({
    adjustment: clamp(raw, -params.maxAdjustment, params.maxAdjustment) * reliability,
    sampleReady: true,
    reliability
  });
}

function pitcherReadiness(depthScore, config) {
  if (depthScore >= config.pitcher.readiness.mlbReadyDepthScore) return "MLB_READY";
  if (depthScore >= config.pitcher.readiness.nearDepthScore) return "NEAR";
  return "DEVELOPING";
}

function pitcherFatiguePenalty(state, config) {
  return clamp(Number(state?.fatigue ?? 0), 0, 100) / 100 * config.pitcher.fatiguePenaltyAt100;
}

function pitcherCandidateReasons({ role, candidate, incumbent, aaaPerf, mlbPerf, candidateScore, incumbentScore, cooldown, config }) {
  const reasons = [];
  const fatigue = Number(candidate.pitcherState?.fatigue ?? 0);
  if (candidate.depthScore >= config.pitcher.readiness.mlbReadyDepthScore) reasons.push("PITCHER_CURRENT_ABILITY");
  if (fatigue >= config.pitcher.limitedFatigue) reasons.push("PITCHER_WORKLOAD");
  if (aaaPerf.adjustment >= config.pitcher.performance.notableAdjustment) reasons.push("AAA_PITCHING_PERFORMANCE");
  if (mlbPerf.adjustment <= -config.pitcher.performance.notableAdjustment) reasons.push("MLB_PITCHING_STRUGGLES");
  if (role === "SP" && incumbent.depthScore <= config.rosterNeed.weakIncumbentScore) reasons.push("MLB_ROTATION_NEED");
  if (role === "RP" && incumbent.depthScore <= config.rosterNeed.weakIncumbentScore) reasons.push("MLB_BULLPEN_NEED");
  if (cooldown) reasons.push("TRANSACTION_STABILITY");
  if (candidateScore < incumbentScore + config.pitcher.promotionMargin[role] && !cooldown) reasons.push("PITCHER_ROLE_STABILITY");
  return [...new Set(reasons)].slice(0, 4);
}

function pitcherIncumbentReasons({ role, candidate, incumbent, aaaPerf, mlbPerf, swap, cooldown, config }) {
  const reasons = [];
  if (mlbPerf.adjustment <= -config.pitcher.performance.notableAdjustment) reasons.push("MLB_PITCHING_STRUGGLES");
  if (candidate.depthScore >= config.pitcher.readiness.mlbReadyDepthScore) reasons.push("AAA_PITCHER_READY");
  if (aaaPerf.adjustment >= config.pitcher.performance.notableAdjustment) reasons.push("AAA_PITCHING_PERFORMANCE");
  if (role === "SP") reasons.push("ROTATION_DEPTH");
  if (role === "RP") reasons.push("BULLPEN_DEPTH");
  if (cooldown) reasons.push("TRANSACTION_STABILITY");
  if (!swap && !cooldown) reasons.push("PITCHER_ROLE_STABILITY");
  return [...new Set(reasons)].slice(0, 4);
}

/**
 * Periodic AAA <-> MLB pitcher replacement evaluator.
 * SP and RP are evaluated as separate depth groups. It decides only; roster
 * mutation belongs to RosterService. Actual pitching lines come from the same
 * GameEngine box score stream used by the rest of the season model.
 */
function evaluateAaaMlbPitcherMovement({ date, role, candidate, incumbent, lastTransactionDate = null, config = organizationCalibration }) {
  if (!['SP', 'RP'].includes(role)) throw new RangeError(`pitcher movement role은 SP/RP여야 합니다: ${role}`);
  if (!candidate?.id || !incumbent?.id) throw new TypeError("pitcher candidate/incumbent가 필요합니다.");
  const aaaPerf = pitcherPerformanceAdjustment(candidate.seasonLine, role, "AAA", config);
  const mlbPerf = pitcherPerformanceAdjustment(incumbent.seasonLine, role, "MLB", config);
  const candidateFatigue = Number(candidate.pitcherState?.fatigue ?? 0);
  const incumbentFatigue = Number(incumbent.pitcherState?.fatigue ?? 0);
  const candidateScore = candidate.depthScore + aaaPerf.adjustment - pitcherFatiguePenalty(candidate.pitcherState, config);
  const incumbentScore = incumbent.depthScore + config.pitcher.incumbentRoleBonus[role] + mlbPerf.adjustment - pitcherFatiguePenalty(incumbent.pitcherState, config);
  const cooldown = lastTransactionDate ? daysBetween(lastTransactionDate, date) < config.transactionCooldownDays : false;
  const workloadReady = candidateFatigue < config.pitcher.unavailableFatigue;
  const injuryBlocked = Boolean(candidate.injured || incumbent.injured);
  const eligible = aaaPerf.sampleReady && workloadReady && !cooldown && !injuryBlocked;
  const promote = eligible && candidateScore >= incumbentScore + config.pitcher.promotionMargin[role];
  const candidateReasonCodes = pitcherCandidateReasons({ role, candidate, incumbent, aaaPerf, mlbPerf, candidateScore, incumbentScore, cooldown, config });
  const incumbentReasonCodes = pitcherIncumbentReasons({ role, candidate, incumbent, aaaPerf, mlbPerf, swap: promote, cooldown, config });
  return freeze({
    kind: "PITCHER",
    date,
    position: role,
    candidateId: candidate.id,
    incumbentId: incumbent.id,
    readiness: pitcherReadiness(candidate.depthScore, config),
    path: promote ? "CLEAR" : pathStatus(candidate.depthScore, incumbent.depthScore, config),
    decision: promote ? "PROMOTE" : "HOLD",
    incumbentDecision: promote ? "DEMOTE" : "HOLD",
    sampleReady: aaaPerf.sampleReady,
    mlbSampleReady: mlbPerf.sampleReady,
    workloadReady,
    cooldown,
    injuryBlocked,
    reasonCodes: candidateReasonCodes,
    candidateReasonCodes,
    incumbentReasonCodes,
    internal: freeze({ candidateScore, incumbentScore, aaaPerf: aaaPerf.adjustment, mlbPerf: mlbPerf.adjustment, candidateFatigue, incumbentFatigue })
  });
}


/** Lower-minor SP/RP counterpart to evaluateMinorLevelPromotion. */
function evaluateMinorLevelPitcherMovement({ date, fromLevel, toLevel, role, candidate, incumbent, lastTransactionDate = null, config = organizationCalibration }) {
  validateMinorPair(fromLevel, toLevel, config);
  if (!["SP", "RP"].includes(role)) throw new RangeError(`pitcher movement role은 SP/RP여야 합니다: ${role}`);
  if (!candidate?.id || !incumbent?.id) throw new TypeError("minor pitcher candidate/incumbent가 필요합니다.");
  const lowerPerf = pitcherPerformanceAdjustment(candidate.seasonLine, role, fromLevel, config);
  const upperPerf = pitcherPerformanceAdjustment(incumbent.seasonLine, role, toLevel, config);
  const candidateFatigue = Number(candidate.pitcherState?.fatigue ?? 0);
  const incumbentFatigue = Number(incumbent.pitcherState?.fatigue ?? 0);
  const candidateScore = candidate.depthScore + lowerPerf.adjustment * config.ladder.pitcherPerformanceWeight - pitcherFatiguePenalty(candidate.pitcherState, config);
  const incumbentScore = incumbent.depthScore + config.ladder.pitcherIncumbentRoleBonus[role] + upperPerf.adjustment * config.ladder.pitcherUpperPerformanceWeight - pitcherFatiguePenalty(incumbent.pitcherState, config);
  const cooldown = lastTransactionDate ? daysBetween(lastTransactionDate, date) < config.transactionCooldownDays : false;
  const workloadReady = candidateFatigue < config.pitcher.unavailableFatigue;
  const margin = config.ladder.pitcherPromotionMargin[`${fromLevel}_${toLevel}_${role}`];
  const injuryBlocked = Boolean(candidate.injured || incumbent.injured);
  const eligible = lowerPerf.sampleReady && workloadReady && !cooldown && !injuryBlocked;
  const promote = eligible && candidateScore >= incumbentScore + margin;
  const candidateReasonCodes = [];
  if (candidate.depthScore >= config.ladder.readyDepthScore[toLevel]) candidateReasonCodes.push("PITCHER_CURRENT_ABILITY");
  if (lowerPerf.adjustment >= config.pitcher.performance.notableAdjustment) candidateReasonCodes.push("LOWER_LEVEL_PITCHING_PERFORMANCE");
  if (upperPerf.adjustment <= -config.pitcher.performance.notableAdjustment) candidateReasonCodes.push("UPPER_LEVEL_PITCHING_STRUGGLES");
  if (candidateFatigue >= config.pitcher.limitedFatigue) candidateReasonCodes.push("PITCHER_WORKLOAD");
  if (cooldown) candidateReasonCodes.push("TRANSACTION_STABILITY");
  if (!promote && !cooldown) candidateReasonCodes.push("PITCHER_ROLE_STABILITY");
  const incumbentReasonCodes = [];
  if (upperPerf.adjustment <= -config.pitcher.performance.notableAdjustment) incumbentReasonCodes.push("UPPER_LEVEL_PITCHING_STRUGGLES");
  if (candidate.depthScore >= config.ladder.readyDepthScore[toLevel]) incumbentReasonCodes.push("LOWER_LEVEL_PITCHER_READY");
  incumbentReasonCodes.push(role === "SP" ? "ROTATION_DEPTH" : "BULLPEN_DEPTH");
  if (cooldown) incumbentReasonCodes.push("TRANSACTION_STABILITY");
  return freeze({
    kind: "PITCHER", date, fromLevel, toLevel,
    evaluationKey: `${fromLevel}_${toLevel}_${role}`,
    position: role, candidateId: candidate.id, incumbentId: incumbent.id,
    readiness: minorReadiness(candidate.depthScore, toLevel, config),
    path: promote ? "CLEAR" : pathStatus(candidate.depthScore, incumbent.depthScore, config),
    decision: promote ? "PROMOTE" : "HOLD", incumbentDecision: promote ? "DEMOTE" : "HOLD",
    sampleReady: lowerPerf.sampleReady, upperSampleReady: upperPerf.sampleReady, mlbSampleReady: false,
    workloadReady, cooldown, injuryBlocked,
    reasonCodes: [...new Set(candidateReasonCodes)].slice(0, 4),
    candidateReasonCodes: [...new Set(candidateReasonCodes)].slice(0, 4),
    incumbentReasonCodes: [...new Set(incumbentReasonCodes)].slice(0, 4),
    internal: freeze({ candidateScore, incumbentScore, lowerPerf: lowerPerf.adjustment, upperPerf: upperPerf.adjustment, candidateFatigue, incumbentFatigue })
  });
}

function applyOrganizationReview(state, { date, evaluations = [], transactionEvents = [] } = {}) {
  const latest = { ...(state?.latestEvaluations ?? {}) };
  for (const evaluation of evaluations) {
    const key = evaluation.evaluationKey ?? evaluation.position;
    latest[key] = evaluation;
    // Preserve the legacy AAA<->MLB position key for v22-v26 consumers/tests.
    if (!evaluation.fromLevel || (evaluation.fromLevel === "AAA" && evaluation.toLevel === "MLB")) latest[evaluation.position] = evaluation;
  }
  const transactions = [...(state?.transactions ?? []), ...transactionEvents].slice(-40);
  const lastTransactionDate = transactionEvents.length ? date : state?.lastTransactionDate ?? null;
  return freeze({
    ...(state ?? createOrganizationReviewState({ startDate: date })),
    schemaVersion: 1,
    lastReviewDate: date,
    reviews: Number(state?.reviews ?? 0) + 1,
    lastTransactionDate,
    latestEvaluations: latest,
    transactions
  });
}

function getOrganizationEvaluationPublicView(evaluation, { playerId = null } = {}) {
  if (!evaluation) return null;
  const isIncumbent = playerId && playerId === evaluation.incumbentId;
  const reasonCodes = isIncumbent ? (evaluation.incumbentReasonCodes ?? []) : (evaluation.candidateReasonCodes ?? evaluation.reasonCodes ?? []);
  const decision = isIncumbent ? (evaluation.incumbentDecision ?? (evaluation.decision === "PROMOTE" ? "DEMOTE" : "HOLD")) : evaluation.decision;
  const replacementPressure = isIncumbent
    ? (decision === "DEMOTE" ? "ACTION" : (evaluation.readiness === "MLB_READY" && evaluation.sampleReady ? "WATCH" : "STABLE"))
    : null;
  return freeze({
    date: evaluation.date,
    kind: evaluation.kind ?? "POSITION_PLAYER",
    position: evaluation.position,
    readiness: isIncumbent ? null : evaluation.readiness,
    path: isIncumbent ? null : evaluation.path,
    decision,
    fromLevel: evaluation.fromLevel ?? "AAA",
    toLevel: evaluation.toLevel ?? "MLB",
    perspective: isIncumbent
      ? ((evaluation.toLevel ?? "MLB") === "MLB" ? "MLB_INCUMBENT" : "UPPER_LEVEL_INCUMBENT")
      : ((evaluation.fromLevel ?? "AAA") === "AAA" && (evaluation.toLevel ?? "MLB") === "MLB" ? "AAA_CANDIDATE" : "LOWER_LEVEL_CANDIDATE"),
    replacementPressure,
    sampleReady: isIncumbent ? Boolean(evaluation.mlbSampleReady ?? evaluation.upperSampleReady) : Boolean(evaluation.sampleReady),
    counterpartSampleReady: isIncumbent ? Boolean(evaluation.sampleReady) : Boolean(evaluation.mlbSampleReady ?? evaluation.upperSampleReady),
    cooldown: evaluation.cooldown,
    reasonCodes: [...reasonCodes]
  });
}

function getOrganizationReviewPublicView(state, { currentDate = null } = {}) {
  if (!state) return null;
  const elapsed = currentDate ? daysBetween(state.lastReviewDate, currentDate) : 0;
  return freeze({
    reviews: state.reviews,
    lastReviewDate: state.lastReviewDate,
    nextReviewInDays: Math.max(0, organizationCalibration.reviewCadenceDays - elapsed),
    lastTransactionDate: state.lastTransactionDate,
    transactions: [...(state.transactions ?? [])].slice(-8)
  });
}

export { createOrganizationReviewState, normalizeOrganizationReviewState, isOrganizationReviewDue, evaluateAaaMlbPromotion, evaluateMinorLevelPromotion, evaluateAaaMlbPitcherMovement, evaluateMinorLevelPitcherMovement, applyOrganizationReview, getOrganizationEvaluationPublicView, getOrganizationReviewPublicView };
