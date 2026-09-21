import { hashSeed } from "../rng.js";

const SCOUTING_STATE_VERSION = 1;
const SCOUTING_CONFIDENCE = Object.freeze(["LOW", "FAIR", "GOOD", "HIGH"]);
const SCOUTING_RISK = Object.freeze(["LOW", "MEDIUM", "HIGH", "EXTREME"]);

const POSITION_TOOLS = Object.freeze(["contact", "power", "vision", "discipline", "defense", "speed"]);
const PITCHER_TOOLS = Object.freeze(["stuff", "command", "movement", "control", "pitchability", "stamina", "velocity"]);
const LEVEL_BASE_EXPOSURE = Object.freeze({ A: 0.24, HIGH_A: 0.30, AA: 0.38, AAA: 0.50, MLB: 0.72 });
const LEVEL_REVIEW_GAIN = Object.freeze({ A: 0.055, HIGH_A: 0.052, AA: 0.048, AAA: 0.043, MLB: 0.032 });
const LEVEL_RISK = Object.freeze({ A: 15, HIGH_A: 12, AA: 8, AAA: 4, MLB: 0 });
const LEVEL_ETA = Object.freeze({ A: 3, HIGH_A: 3, AA: 2, AAA: 1, MLB: 0 });
const POSITION_VALUE = Object.freeze({ C: 2.8, SS: 2.8, CF: 2.2, "2B": 1.2, "3B": 1.0, RF: 0.5, LF: 0, "1B": -0.6, DH: -1.2, SP: 2.0, RP: -0.4, P: 1.0 });
const RISK_PENALTY = Object.freeze({ LOW: 0, MEDIUM: 1.5, HIGH: 3.5, EXTREME: 5.5 });

const CONFIDENCE_SCORE = Object.freeze({ LOW: 0, FAIR: 1, GOOD: 2, HIGH: 3 });
const SCORE_CONFIDENCE = Object.freeze(["LOW", "FAIR", "GOOD", "HIGH"]);

function normalizedConfidence(value, fallback = null) {
  const raw = String(value ?? "").toUpperCase();
  return SCOUTING_CONFIDENCE.includes(raw) ? raw : fallback;
}

function futureConfidenceBand(exposureConfidence, potentialConfidence = null) {
  const current = normalizedConfidence(exposureConfidence, "LOW");
  const source = normalizedConfidence(potentialConfidence, null);
  if (!source) return current;
  const score = Math.round(CONFIDENCE_SCORE[current] * 0.55 + CONFIDENCE_SCORE[source] * 0.45);
  return SCORE_CONFIDENCE[clamp(score, 0, 3)];
}

function confidenceUncertaintyScale(confidence) {
  return ({ HIGH: 0.76, GOOD: 0.88, FAIR: 1.00, LOW: 1.12 })[normalizedConfidence(confidence, "FAIR")];
}

const INTERNAL_GRADE_POINTS = Object.freeze([
  [20, 20], [25, 30], [35, 40], [50, 50], [58, 55], [65, 60], [73, 65], [80, 70], [88, 75], [95, 80], [99, 80]
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso || fromIso === toIso) return 0;
  return Math.max(0, Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000));
}
function randomKeyFor(playerId, seed = "") { return hashSeed(`scouting-hidden-v${SCOUTING_STATE_VERSION}:${seed || "legacy"}:${playerId}`); }
function signedNoise(randomKey, playerId, salt) {
  const u = (hashSeed(`scouting-noise-v${SCOUTING_STATE_VERSION}:${randomKey}:${playerId}:${salt}`) % 10001) / 10000;
  return u * 2 - 1;
}
function snapGrade(value) { return clamp(Math.round(value / 5) * 5, 20, 80); }

function internalRatingTo2080(value) {
  const rating = clamp(finite(value, 50), 20, 99);
  for (let i = 1; i < INTERNAL_GRADE_POINTS.length; i += 1) {
    const [x1, y1] = INTERNAL_GRADE_POINTS[i - 1];
    const [x2, y2] = INTERNAL_GRADE_POINTS[i];
    if (rating <= x2) {
      const t = (rating - x1) / Math.max(1e-9, x2 - x1);
      return snapGrade(y1 + (y2 - y1) * t);
    }
  }
  return 80;
}

function initialExposure(level, age) {
  const base = LEVEL_BASE_EXPOSURE[level] ?? 0.40;
  const experience = age >= 27 ? 0.08 : age >= 24 ? 0.05 : age >= 21 ? 0.02 : 0;
  return Number(clamp(base + experience, 0.18, 0.88).toFixed(4));
}

function createScoutingState(player, { seed = "", level = "AA", age = null, startDate = "2026-04-01" } = {}) {
  if (!player?.id) throw new TypeError("scouting state에는 player.id가 필요합니다.");
  const resolvedAge = clamp(Math.round(finite(age, player?.physical?.age ?? 22)), 16, 50);
  return freeze({
    version: SCOUTING_STATE_VERSION,
    randomKey: randomKeyFor(player.id, seed),
    exposure: initialExposure(level, resolvedAge),
    observations: 0,
    lastUpdateDate: startDate,
    processedReviews: []
  });
}

function normalizeScoutingState(existing, player, options = {}) {
  const base = createScoutingState(player, options);
  if (!existing || typeof existing !== "object") return base;
  return freeze({
    ...base,
    ...existing,
    version: SCOUTING_STATE_VERSION,
    randomKey: Number.isInteger(existing.randomKey) ? existing.randomKey >>> 0 : base.randomKey,
    exposure: Number(clamp(finite(existing.exposure, base.exposure), 0.15, 0.995).toFixed(4)),
    observations: Math.max(0, Math.round(finite(existing.observations, 0))),
    lastUpdateDate: typeof existing.lastUpdateDate === "string" ? existing.lastUpdateDate : base.lastUpdateDate,
    processedReviews: [...new Set(Array.isArray(existing.processedReviews) ? existing.processedReviews.filter((value) => typeof value === "string" && value) : [])].slice(-24)
  });
}

function markScoutingReviewProcessed(state, reviewKey) {
  if (!state || state.version !== SCOUTING_STATE_VERSION) throw new TypeError("유효한 scouting state가 필요합니다.");
  if (typeof reviewKey !== "string" || !reviewKey) throw new TypeError("scouting review key가 필요합니다.");
  if (state.processedReviews.includes(reviewKey)) return state;
  return freeze({ ...state, processedReviews: [...state.processedReviews, reviewKey].slice(-24) });
}

function applyScoutingReview(state, player, { date, level = "AA", reviewKey = null } = {}) {
  if (!state || state.version !== SCOUTING_STATE_VERSION) throw new TypeError("유효한 scouting state가 필요합니다.");
  if (!player?.id) throw new TypeError("scouting review에는 player.id가 필요합니다.");
  if (typeof date !== "string" || !date) throw new TypeError("scouting review date가 필요합니다.");
  const key = reviewKey ?? `${date}:${level}`;
  if (state.processedReviews.includes(key)) return freeze({ state, applied: false });
  const elapsedBonus = clamp(daysBetween(state.lastUpdateDate, date) / 28, 0, 1) * 0.012;
  const gain = (LEVEL_REVIEW_GAIN[level] ?? 0.045) + elapsedBonus;
  const next = freeze({
    ...state,
    exposure: Number(clamp(state.exposure + gain * (1 - state.exposure * 0.55), 0.15, 0.995).toFixed(4)),
    observations: state.observations + 1,
    lastUpdateDate: date,
    processedReviews: [...state.processedReviews, key].slice(-24)
  });
  return freeze({ state: next, applied: true });
}

function scoutingConfidence(exposure) {
  const value = clamp(finite(exposure, 0.4), 0, 1);
  if (value >= 0.82) return "HIGH";
  if (value >= 0.62) return "GOOD";
  if (value >= 0.40) return "FAIR";
  return "LOW";
}

function estimateInternal(trueValue, state, playerId, salt, { future = false, velocity = false, uncertaintyScale = 1 } = {}) {
  const exposure = clamp(finite(state?.exposure, 0.4), 0.15, 0.995);
  const trueInternal = velocity ? velocityToInternal(trueValue) : clamp(finite(trueValue, 50), 20, 99);
  const maxError = future ? 16 : 10;
  const minError = future ? 3.2 : 1.8;
  const uncertainty = (minError + (1 - exposure) * (maxError - minError)) * clamp(finite(uncertaintyScale, 1), 0.65, 1.35);
  const bias = signedNoise(state.randomKey, playerId, salt) * uncertainty * 0.82;
  const midpoint = clamp(trueInternal + bias, 20, 99);
  const halfRange = uncertainty * (future ? 0.78 : 0.62);
  return {
    midpoint,
    low: clamp(midpoint - halfRange, 20, 99),
    high: clamp(midpoint + halfRange, 20, 99)
  };
}

function gradeEstimate(trueValue, state, playerId, salt, options = {}) {
  const estimate = estimateInternal(trueValue, state, playerId, salt, options);
  const grade = internalRatingTo2080(estimate.midpoint);
  let low = internalRatingTo2080(estimate.low);
  let high = internalRatingTo2080(estimate.high);
  if (low > grade) low = grade;
  if (high < grade) high = grade;
  if (options.future && options.rangeConfidence) {
    const confidence = normalizedConfidence(options.rangeConfidence, "FAIR");
    const minHalfRange = ({ HIGH: 2.5, GOOD: 5, FAIR: 7.5, LOW: 10 })[confidence];
    low = Math.min(low, snapGrade(grade - minHalfRange));
    high = Math.max(high, snapGrade(grade + minHalfRange));
  }
  return freeze({ grade, range: freeze({ low, high }) });
}

function velocityToInternal(mph) {
  const v = clamp(finite(mph, 92), 84, 103);
  const points = [[84,20],[88,35],[90,45],[92,50],[94,58],[96,66],[98,76],[100,86],[102,95],[103,99]];
  for (let i = 1; i < points.length; i += 1) {
    const [x1,y1] = points[i - 1], [x2,y2] = points[i];
    if (v <= x2) return y1 + ((v - x1) / (x2 - x1)) * (y2 - y1);
  }
  return 99;
}

function positionCurrent(player) {
  const h = player?.hitting ?? {}, f = player?.fielding ?? {}, r = player?.running ?? {}, t = player?.tendencies ?? {};
  return {
    contact: ((finite(h.contactR, 50) + finite(h.contactL, 50)) / 2),
    power: Math.max(finite(h.rawPower, 50), finite(t.powerUtilizationR, h.rawPower ?? 50), finite(t.powerUtilizationL, h.rawPower ?? 50)),
    vision: finite(h.vision, 50), discipline: finite(h.discipline, 50),
    defense: (finite(f.fielding, 50) * 0.56 + finite(f.reaction, 50) * 0.44), speed: finite(r.speed, 50)
  };
}

function pitcherCurrent(player) {
  const p = player?.pitching ?? {};
  return {
    stuff: finite(player?.derived?.stuff, 50), command: finite(p.command, 50), movement: finite(p.movement, 50),
    control: finite(p.control, 50), pitchability: finite(p.pitchability, 50), stamina: finite(p.stamina, 50), velocity: finite(p.pitchVelocityMph, 92)
  };
}

function positionFuture(development, current) {
  const c = development?.reachableProjection ?? development?.ceilings ?? {};
  return {
    contact: Math.max(current.contact, finite(c.contact, current.contact)), power: Math.max(current.power, finite(c.power, current.power)),
    vision: Math.max(current.vision, finite(c.vision, current.vision)), discipline: Math.max(current.discipline, finite(c.discipline, current.discipline)),
    defense: Math.max(current.defense, finite(c.defense, current.defense)), speed: Math.max(current.speed, finite(c.speed, current.speed))
  };
}

function pitcherFuture(development, current) {
  const c = development?.reachableProjection ?? development?.ceilings ?? {};
  return {
    stuff: Math.max(current.stuff, finite(c.stuff, current.stuff)), command: Math.max(current.command, finite(c.command, current.command)),
    movement: Math.max(current.movement, finite(c.movement, current.movement)), control: Math.max(current.control, finite(c.control, current.control)),
    pitchability: Math.max(current.pitchability, finite(c.pitchability, current.pitchability)), stamina: Math.max(current.stamina, finite(c.stamina, current.stamina)),
    velocity: Math.max(current.velocity, finite(c.velocityMph, current.velocity))
  };
}

function midpointInternal(estimate) {
  const low = estimate.range.low, high = estimate.range.high, grade = estimate.grade;
  // Convert already-rounded public grades to a stable 20-80 scale value. This is
  // intentionally the only input used by FV/ranking so hidden ceilings never leak.
  return (low + grade * 2 + high) / 4;
}

function positionFutureValue(toolReports, primaryPosition) {
  const v = Object.fromEntries(Object.entries(toolReports).map(([tool, row]) => [tool, midpointInternal(row.future)]));
  const offense = v.contact * 0.29 + v.power * 0.25 + v.vision * 0.11 + v.discipline * 0.10;
  let defenseWeight = 0.17, speedWeight = 0.08;
  if (["SS","CF","2B","C"].includes(primaryPosition)) { defenseWeight = 0.21; speedWeight = 0.10; }
  if (["1B","DH","LF"].includes(primaryPosition)) { defenseWeight = 0.11; speedWeight = 0.05; }
  const raw = offense + v.defense * defenseWeight + v.speed * speedWeight + (POSITION_VALUE[primaryPosition] ?? 0) * 0.45;
  return snapGrade(raw / (0.29 + 0.25 + 0.11 + 0.10 + defenseWeight + speedWeight));
}

function pitcherFutureValue(toolReports, role) {
  const v = Object.fromEntries(Object.entries(toolReports).map(([tool, row]) => [tool, midpointInternal(row.future)]));
  const raw = v.stuff * 0.25 + v.command * 0.19 + v.movement * 0.17 + v.control * 0.12 + v.pitchability * 0.10 + v.velocity * 0.11 + v.stamina * (role === "SP" ? 0.12 : 0.04);
  const denom = role === "SP" ? 1.06 : 0.98;
  return snapGrade(raw / denom + (role === "SP" ? 1.0 : 0));
}

function currentValue(toolReports, kind, roleOrPosition) {
  const v = Object.fromEntries(Object.entries(toolReports).map(([tool, row]) => [tool, midpointInternal(row.current)]));
  if (kind === "PITCHER") {
    const raw = v.stuff * 0.28 + v.command * 0.21 + v.movement * 0.18 + v.control * 0.13 + v.pitchability * 0.10 + v.velocity * 0.10 + v.stamina * (roleOrPosition === "SP" ? 0.10 : 0.03);
    return snapGrade(raw / (roleOrPosition === "SP" ? 1.10 : 1.03));
  }
  const raw = v.contact * 0.31 + v.power * 0.25 + v.vision * 0.12 + v.discipline * 0.10 + v.defense * 0.14 + v.speed * 0.08;
  return snapGrade(raw);
}

function riskBand({ state, development, age, level, current, future, injuryHistory, kind, potentialConfidence = null, publicRisk = null, toolReports = null }) {
  const gapTools = Object.keys(current);
  const gap = gapTools.reduce((sum, tool) => {
    const c = tool === "velocity" ? velocityToInternal(current[tool]) : current[tool];
    const f = tool === "velocity" ? velocityToInternal(future[tool]) : future[tool];
    return sum + Math.max(0, f - c);
  }, 0) / Math.max(1, gapTools.length);
  let score = (1 - state.exposure) * 42 + (LEVEL_RISK[level] ?? 8) + clamp(gap * 0.85, 0, 16);
  if (age <= 20) score += 11; else if (age <= 23) score += 7; else if (age <= 26) score += 3;
  if (development?.hiddenTrait === "HIGH_VARIANCE") score += 8;
  if (Math.abs(finite(development?.trajectory, 1) - 1) >= 0.08) score += 4;
  score += clamp(finite(injuryHistory?.major, 0) * 4 + finite(injuryHistory?.total, 0) * 0.8, 0, 11);
  const sourceConfidence = normalizedConfidence(potentialConfidence, null);
  if (sourceConfidence) score += ({ HIGH: -4, GOOD: -2, FAIR: 0, LOW: 4 })[sourceConfidence];
  const normalizedPublicRisk = String(publicRisk ?? "").trim().toUpperCase();
  if (normalizedPublicRisk) {
    score += ({ LOW: -4, MED: 0, MEDIUM: 0, HIGH: 5, EXTREME: 9 })[normalizedPublicRisk] ?? 0;
  }
  if (toolReports) {
    const widths = Object.values(toolReports).map((row) => Math.max(0, finite(row?.future?.range?.high, 50) - finite(row?.future?.range?.low, 50)));
    const averageWidth = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 10;
    score += clamp((averageWidth - 10) * 0.28, -2, 4);
  }
  if (kind === "PITCHER") score += 2.5;
  if (score >= 68) return "EXTREME";
  if (score >= 49) return "HIGH";
  if (score >= 31) return "MEDIUM";
  return "LOW";
}

function etaBand({ level, currentGrade, age }) {
  if (level === "MLB") return "MLB_READY";
  let years = LEVEL_ETA[level] ?? 2;
  if (currentGrade >= 60) years -= 1;
  else if (currentGrade <= 40) years += 1;
  if (age >= 25 && currentGrade >= 50) years -= 1;
  years = clamp(years, 0, 4);
  if (years === 0) return "MLB_READY";
  if (years === 1) return "1_YEAR";
  if (years === 2) return "2_YEARS";
  return "3_PLUS_YEARS";
}

function fvRange(toolReports, fv) {
  let spread = 0;
  let count = 0;
  for (const row of Object.values(toolReports)) {
    spread += Math.max(0, row.future.range.high - row.future.range.low);
    count += 1;
  }
  const width = clamp(Math.round((spread / Math.max(1, count)) / 5) * 5, 5, 15);
  return freeze({ low: clamp(fv - width, 20, 80), high: clamp(fv + width, 20, 80) });
}

function buildScoutingReport({ player, scouting, development = null, potentialProfile = null, publicScouting = null, age = null, level = "AA", primaryPosition = "DH", role = null, injuryHistory = null, pathway = "COMPETITIVE", kind = "POSITION" } = {}) {
  if (!player?.id) throw new TypeError("scouting report에는 player.id가 필요합니다.");
  if (!scouting || scouting.version !== SCOUTING_STATE_VERSION) throw new TypeError("scouting report에는 scouting state가 필요합니다.");
  const resolvedAge = clamp(Math.round(finite(age, player?.physical?.age ?? 22)), 16, 50);
  const pitcher = kind === "PITCHER" || role === "SP" || role === "RP";
  const current = pitcher ? pitcherCurrent(player) : positionCurrent(player);
  const future = pitcher ? pitcherFuture(development, current) : positionFuture(development, current);
  const currentConfidence = scoutingConfidence(scouting.exposure);
  const profileConfidence = normalizedConfidence(potentialProfile?.potentialConfidence ?? publicScouting?.confidence, null);
  const hasPotentialEvidence = Boolean(potentialProfile || publicScouting);
  const futureConfidence = hasPotentialEvidence ? futureConfidenceBand(currentConfidence, profileConfidence) : currentConfidence;
  const profileTools = potentialProfile?.publicScoutingEvidence?.tools ?? {};
  const publicRisk = potentialProfile?.publicScoutingEvidence?.risk ?? publicScouting?.risk ?? null;
  const hasPublicFv = Boolean(potentialProfile?.publicScoutingEvidence?.futureValue ?? publicScouting?.futureValue);
  const tools = {};
  const keys = pitcher ? PITCHER_TOOLS : POSITION_TOOLS;
  for (const tool of keys) {
    const velocity = tool === "velocity";
    const evidenceKey = tool === "velocity" ? "velocityMph" : tool;
    const directEvidence = profileTools?.[evidenceKey] ?? null;
    const directConfidence = normalizedConfidence(directEvidence?.confidence, null);
    const effectiveFutureConfidence = directConfidence
      ? futureConfidenceBand(currentConfidence, directConfidence)
      : futureConfidence;
    const evidenceScale = hasPotentialEvidence
      ? confidenceUncertaintyScale(effectiveFutureConfidence) * (directEvidence ? 0.92 : hasPublicFv ? 0.97 : 1)
      : 1;
    tools[tool] = freeze({
      current: gradeEstimate(current[tool], scouting, player.id, `${tool}:current`, { future: false, velocity }),
      future: gradeEstimate(future[tool], scouting, player.id, `${tool}:future`, { future: true, velocity, uncertaintyScale: evidenceScale, rangeConfidence: hasPotentialEvidence ? effectiveFutureConfidence : null })
    });
  }
  const futureValue = pitcher ? pitcherFutureValue(tools, role ?? "RP") : positionFutureValue(tools, primaryPosition);
  const currentGrade = currentValue(tools, pitcher ? "PITCHER" : "POSITION", role ?? primaryPosition);
  const evidenceFields = hasPotentialEvidence ? {
    currentConfidence,
    futureConfidence,
    futureEvidence: freeze({
      sourceConfidence: profileConfidence,
      publicFutureValue: potentialProfile?.publicFutureValue ?? null,
      publicToolCount: Object.keys(profileTools).length,
      publicRisk
    })
  } : {};
  return freeze({
    version: SCOUTING_STATE_VERSION,
    confidence: currentConfidence,
    ...evidenceFields,
    risk: riskBand({ state: scouting, development, age: resolvedAge, level, current, future, injuryHistory, kind: pitcher ? "PITCHER" : "POSITION", potentialConfidence: hasPotentialEvidence ? profileConfidence : null, publicRisk: hasPotentialEvidence ? publicRisk : null, toolReports: hasPotentialEvidence ? tools : null }),
    currentGrade,
    futureValue,
    futureValueRange: fvRange(tools, futureValue),
    eta: etaBand({ level, currentGrade, age: resolvedAge }),
    pathway: ["CLEAR","COMPETITIVE","BLOCKED"].includes(pathway) ? pathway : "COMPETITIVE",
    tools: freeze(tools),
    lastUpdatedDate: scouting.lastUpdateDate,
    observations: scouting.observations
  });
}

function prospectRankingScore(report, { age = 22, level = "AA", position = "DH" } = {}) {
  if (!report) return -Infinity;
  const levelBonus = ({ A: 0, HIGH_A: 0.5, AA: 1.2, AAA: 2.0, MLB: 2.5 })[level] ?? 0;
  const ageLevelTarget = ({ A: 20, HIGH_A: 21, AA: 22, AAA: 24, MLB: 25 })[level] ?? 23;
  const ageBonus = clamp((ageLevelTarget - finite(age, ageLevelTarget)) * 0.9, -3.5, 4.0);
  return Number((report.futureValue + levelBonus + ageBonus + (POSITION_VALUE[position] ?? 0) - (RISK_PENALTY[report.risk] ?? 2)).toFixed(3));
}

export { SCOUTING_STATE_VERSION, SCOUTING_CONFIDENCE, SCOUTING_RISK, internalRatingTo2080, createScoutingState, normalizeScoutingState, markScoutingReviewProcessed, applyScoutingReview, scoutingConfidence, buildScoutingReport, prospectRankingScore };
