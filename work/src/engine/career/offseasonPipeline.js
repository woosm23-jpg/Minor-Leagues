const OFFSEASON_STATE_VERSION = 1;
const OFFSEASON_PHASES = Object.freeze([
  "SEASON_REVIEW",
  "SERVICE_CONTRACT_STATUS",
  "EXTENSIONS",
  "NON_TENDER_ARBITRATION",
  "FREE_AGENCY_TRADES",
  "ORGANIZATIONAL_CLEANUP",
  "DEVELOPMENT_AGING",
  "SCOUTING_REEVALUATION",
  "RETIREMENT_DECISIONS",
  "PROJECTED_ROSTERS",
  "SPRING_TRAINING",
  "ROSTER_CUTS",
  "OPENING_DAY"
]);

const OFFSEASON_PHASE_LABELS = Object.freeze({
  SEASON_REVIEW: "Season Review",
  SERVICE_CONTRACT_STATUS: "Service / Contract",
  EXTENSIONS: "Extensions",
  NON_TENDER_ARBITRATION: "Non-tender / Arbitration",
  FREE_AGENCY_TRADES: "Free Agency + Trades",
  ORGANIZATIONAL_CLEANUP: "Organizational Cleanup",
  DEVELOPMENT_AGING: "Development / Aging",
  SCOUTING_REEVALUATION: "Scouting Reevaluation",
  RETIREMENT_DECISIONS: "Retirement Decisions",
  PROJECTED_ROSTERS: "Projected Rosters",
  SPRING_TRAINING: "Spring Training",
  ROSTER_CUTS: "Roster Cuts",
  OPENING_DAY: "Opening Day"
});

function clone(value) { return structuredClone(value); }
function assertDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}

function createOffseasonState({
  seasonYear,
  startDate,
  userPlayerId,
  organizationId,
  seasonReview = {}
} = {}) {
  if (!Number.isInteger(seasonYear)) throw new TypeError("offseason seasonYear가 필요합니다.");
  assertDate(startDate, "offseason startDate");
  if (typeof userPlayerId !== "string" || !userPlayerId) throw new TypeError("offseason userPlayerId가 필요합니다.");
  return {
    schemaVersion: OFFSEASON_STATE_VERSION,
    seasonYear,
    userPlayerId,
    organizationId: organizationId == null ? null : String(organizationId),
    status: "ACTIVE",
    currentPhase: OFFSEASON_PHASES[0],
    startedDate: startDate,
    completedDate: null,
    processedPhases: [],
    phaseResults: {},
    seasonReview: clone(seasonReview)
  };
}

function validateOffseasonState(state, label = "offseasonState") {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if (state.schemaVersion !== OFFSEASON_STATE_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  if (!Number.isInteger(state.seasonYear)) throw new TypeError(`${label}.seasonYear가 필요합니다.`);
  if (typeof state.userPlayerId !== "string" || !state.userPlayerId) throw new TypeError(`${label}.userPlayerId가 필요합니다.`);
  if (!["ACTIVE", "COMPLETE"].includes(state.status)) throw new RangeError(`${label}.status가 잘못되었습니다.`);
  assertDate(state.startedDate, `${label}.startedDate`);
  if (state.completedDate !== null) assertDate(state.completedDate, `${label}.completedDate`);
  if (!Array.isArray(state.processedPhases)) throw new TypeError(`${label}.processedPhases가 필요합니다.`);
  if (new Set(state.processedPhases).size !== state.processedPhases.length) throw new RangeError(`${label}.processedPhases가 중복됩니다.`);
  for (let index = 0; index < state.processedPhases.length; index += 1) {
    if (state.processedPhases[index] !== OFFSEASON_PHASES[index]) throw new RangeError(`${label}.processedPhases 순서가 잘못되었습니다.`);
  }
  if (!state.phaseResults || typeof state.phaseResults !== "object" || Array.isArray(state.phaseResults)) throw new TypeError(`${label}.phaseResults가 필요합니다.`);
  if (state.status === "ACTIVE") {
    const expected = OFFSEASON_PHASES[state.processedPhases.length] ?? null;
    if (state.currentPhase !== expected) throw new RangeError(`${label}.currentPhase가 처리 순서와 일치하지 않습니다.`);
    if (state.completedDate !== null) throw new RangeError(`${label}.ACTIVE 상태에 completedDate가 있습니다.`);
  } else {
    if (state.processedPhases.length !== OFFSEASON_PHASES.length) throw new RangeError(`${label}.COMPLETE인데 phase가 남았습니다.`);
    if (state.currentPhase !== null) throw new RangeError(`${label}.COMPLETE인데 currentPhase가 남았습니다.`);
    if (state.completedDate === null) throw new RangeError(`${label}.COMPLETE에 completedDate가 필요합니다.`);
  }
  return true;
}

function normalizeOffseasonState(existing, options = {}) {
  if (existing === undefined || existing === null) return null;
  validateOffseasonState(existing);
  if (options.userPlayerId && existing.userPlayerId !== options.userPlayerId) throw new RangeError("offseason userPlayerId 불일치");
  return clone(existing);
}

function completeOffseasonPhase(state, { phase, date, result = {} } = {}) {
  validateOffseasonState(state);
  assertDate(date, "offseason phase date");
  if (!OFFSEASON_PHASES.includes(phase)) throw new RangeError(`지원하지 않는 offseason phase입니다: ${phase}`);
  if (state.processedPhases.includes(phase)) return { state: clone(state), applied: false };
  if (state.status !== "ACTIVE") throw new RangeError("완료된 offseason에는 phase를 적용할 수 없습니다.");
  if (state.currentPhase !== phase) throw new RangeError(`offseason phase 순서가 잘못되었습니다: ${state.currentPhase} -> ${phase}`);
  const next = clone(state);
  next.processedPhases.push(phase);
  next.phaseResults[phase] = clone(result);
  const nextPhase = OFFSEASON_PHASES[next.processedPhases.length] ?? null;
  if (nextPhase === null) {
    next.status = "COMPLETE";
    next.currentPhase = null;
    next.completedDate = date;
  } else {
    next.currentPhase = nextPhase;
  }
  validateOffseasonState(next);
  return { state: next, applied: true };
}

function getOffseasonPublicView(state) {
  if (!state) return null;
  validateOffseasonState(state);
  const lastPhase = state.processedPhases.at(-1) ?? null;
  return Object.freeze({
    seasonYear: state.seasonYear,
    status: state.status,
    currentPhase: state.currentPhase,
    currentPhaseLabel: state.currentPhase ? OFFSEASON_PHASE_LABELS[state.currentPhase] : "Complete",
    processedPhases: Object.freeze([...state.processedPhases]),
    completedCount: state.processedPhases.length,
    totalPhases: OFFSEASON_PHASES.length,
    lastPhase,
    lastPhaseLabel: lastPhase ? OFFSEASON_PHASE_LABELS[lastPhase] : null,
    lastResult: lastPhase ? Object.freeze(clone(state.phaseResults[lastPhase] ?? {})) : null,
    seasonReview: Object.freeze(clone(state.seasonReview ?? {}))
  });
}

export {
  OFFSEASON_STATE_VERSION,
  OFFSEASON_PHASES,
  OFFSEASON_PHASE_LABELS,
  createOffseasonState,
  validateOffseasonState,
  normalizeOffseasonState,
  completeOffseasonPhase,
  getOffseasonPublicView
};
