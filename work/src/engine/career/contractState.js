import { classifyContractControl, getContractRuleset, serviceParts } from "./contractRules.js";

const CONTRACT_STATE_VERSION = 1;
const BASELINE_VALUES = new Set(["KNOWN_ZERO", "UNKNOWN_REAL_WORLD"]);
const CONTRACT_KINDS = new Set(["MINOR_LEAGUE_CONTROL", "MLB_CONTROL", "REAL_WORLD_UNKNOWN"]);

function clone(value) {
  return structuredClone(value);
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}

function addIsoDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`유효한 날짜가 아닙니다: ${iso}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  if (fromIso === toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`contract date가 역행했습니다: ${fromIso} -> ${toIso}`);
  return days;
}

function maxDate(a, b) { return a >= b ? a : b; }
function minDate(a, b) { return a <= b ? a : b; }

function isRealWorldPlayer(player) {
  return Boolean(player?.realWorld?.sourceId || player?.realWorld?.sourceTeamId || player?.realWorld?.organizationId);
}

function baseTerms({ unknownReal, mlb, ruleset }) {
  if (unknownReal) {
    return {
      kind: "REAL_WORLD_UNKNOWN",
      years: null,
      totalGuarantee: null,
      aav: null,
      salaryBasis: null,
      currency: ruleset.currency,
      expectedRole: null
    };
  }
  if (mlb) {
    return {
      kind: "MLB_CONTROL",
      years: 1,
      totalGuarantee: ruleset.mlbMinimumSalary,
      aav: ruleset.mlbMinimumSalary,
      salaryBasis: ruleset.mlbMinimumSalary,
      currency: ruleset.currency,
      expectedRole: null
    };
  }
  return {
    kind: "MINOR_LEAGUE_CONTROL",
    years: null,
    totalGuarantee: null,
    aav: null,
    salaryBasis: null,
    currency: ruleset.currency,
    expectedRole: null
  };
}

function createContractState({ playerId, player = null, startDate, initialLevel = "A", isUser = false, rulesetId = "ruleset_2026" }) {
  if (typeof playerId !== "string" || !playerId) throw new TypeError("contract playerId가 필요합니다.");
  assertIsoDate(startDate, "contract startDate");
  const ruleset = getContractRuleset(rulesetId);
  const unknownReal = !isUser && isRealWorldPlayer(player);
  const mlb = initialLevel === "MLB";
  return {
    schemaVersion: CONTRACT_STATE_VERSION,
    rulesetId: ruleset.id,
    playerId,
    baseline: {
      status: unknownReal ? "UNKNOWN_REAL_WORLD" : "KNOWN_ZERO",
      historicalServiceDays: unknownReal ? null : 0
    },
    simulatedServiceDays: 0,
    serviceBySeason: {},
    serviceClockDate: startDate,
    lastCreditedDate: null,
    hasMlbContract: mlb,
    terms: baseTerms({ unknownReal, mlb, ruleset })
  };
}

function validateContractState(state, label = "contractState") {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if (state.schemaVersion !== CONTRACT_STATE_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  getContractRuleset(state.rulesetId);
  if (typeof state.playerId !== "string" || !state.playerId) throw new TypeError(`${label}.playerId가 필요합니다.`);
  if (!state.baseline || typeof state.baseline !== "object") throw new TypeError(`${label}.baseline이 필요합니다.`);
  if (!BASELINE_VALUES.has(state.baseline.status)) throw new RangeError(`${label}.baseline.status가 잘못되었습니다.`);
  if (state.baseline.status === "KNOWN_ZERO") {
    if (!Number.isInteger(state.baseline.historicalServiceDays) || state.baseline.historicalServiceDays < 0) throw new RangeError(`${label}.historicalServiceDays가 잘못되었습니다.`);
  } else if (state.baseline.historicalServiceDays !== null) {
    throw new RangeError(`${label}.unknown baseline은 historicalServiceDays=null이어야 합니다.`);
  }
  if (!Number.isInteger(state.simulatedServiceDays) || state.simulatedServiceDays < 0) throw new RangeError(`${label}.simulatedServiceDays가 잘못되었습니다.`);
  if (!state.serviceBySeason || typeof state.serviceBySeason !== "object" || Array.isArray(state.serviceBySeason)) throw new TypeError(`${label}.serviceBySeason이 필요합니다.`);
  for (const [year, days] of Object.entries(state.serviceBySeason)) {
    if (!/^\d{4}$/.test(year) || !Number.isInteger(days) || days < 0) throw new RangeError(`${label}.serviceBySeason이 잘못되었습니다.`);
  }
  assertIsoDate(state.serviceClockDate, `${label}.serviceClockDate`);
  if (state.lastCreditedDate !== null) assertIsoDate(state.lastCreditedDate, `${label}.lastCreditedDate`);
  if (typeof state.hasMlbContract !== "boolean") throw new TypeError(`${label}.hasMlbContract가 boolean이어야 합니다.`);
  if (!state.terms || typeof state.terms !== "object") throw new TypeError(`${label}.terms가 필요합니다.`);
  if (!CONTRACT_KINDS.has(state.terms.kind)) throw new RangeError(`${label}.terms.kind가 잘못되었습니다.`);
  for (const key of ["years", "totalGuarantee", "aav", "salaryBasis"]) {
    const value = state.terms[key];
    if (value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new RangeError(`${label}.terms.${key}가 잘못되었습니다.`);
  }
  if (typeof state.terms.currency !== "string" || !state.terms.currency) throw new TypeError(`${label}.terms.currency가 필요합니다.`);
  return true;
}

function normalizeContractState(existing, options) {
  if (!existing) return createContractState(options);
  validateContractState(existing);
  const state = clone(existing);
  if (state.playerId !== options.playerId) throw new RangeError(`contract playerId 불일치: ${state.playerId} != ${options.playerId}`);
  if (options.resetClock === true) {
    assertIsoDate(options.startDate, "contract reset startDate");
    state.serviceClockDate = options.startDate;
    state.lastCreditedDate = null;
  }
  return state;
}

function getMlbServiceWindow(fixture) {
  const schedule = fixture?.levelLeagues?.MLB?.schedule ?? [];
  const dates = schedule.map((game) => game.date).filter((date) => typeof date === "string").sort();
  if (!dates.length) return null;
  return Object.freeze({ startDate: dates[0], endDate: dates[dates.length - 1] });
}

function serviceDateEligible(date, window) {
  return Boolean(window && date >= window.startDate && date <= window.endDate);
}

function addContractServiceDays(state, days, { seasonYear, salaryBasis = null } = {}) {
  validateContractState(state);
  if (!Number.isInteger(days) || days < 0) throw new RangeError("추가 service days는 0 이상의 정수여야 합니다.");
  if (!Number.isInteger(Number(seasonYear))) throw new RangeError("service seasonYear가 필요합니다.");
  if (days === 0) return clone(state);
  const next = clone(state);
  const year = String(Number(seasonYear));
  next.simulatedServiceDays += days;
  next.serviceBySeason[year] = Number(next.serviceBySeason[year] ?? 0) + days;
  next.hasMlbContract = true;
  if (next.terms.kind !== "REAL_WORLD_UNKNOWN") {
    const ruleset = getContractRuleset(next.rulesetId);
    const minimum = salaryBasis ?? ruleset.mlbMinimumSalary;
    next.terms.kind = "MLB_CONTROL";
    next.terms.years = next.terms.years ?? 1;
    next.terms.totalGuarantee = next.terms.totalGuarantee ?? minimum;
    next.terms.aav = next.terms.aav ?? minimum;
    next.terms.salaryBasis = minimum;
  }
  return next;
}

function advanceContractStateToDate(state, { toDate, level, serviceWindow }) {
  validateContractState(state);
  assertIsoDate(toDate, "contract toDate");
  if (toDate < state.serviceClockDate) throw new RangeError(`contract clock가 역행했습니다: ${state.serviceClockDate} -> ${toDate}`);
  const next = clone(state);
  if (toDate === next.serviceClockDate) return next;

  if (level === "MLB" && serviceWindow) {
    const first = maxDate(addIsoDays(next.serviceClockDate, 1), serviceWindow.startDate);
    const last = minDate(toDate, serviceWindow.endDate);
    if (first <= last) {
      const days = daysBetween(first, last) + 1;
      const credited = addContractServiceDays(next, days, { seasonYear: Number(first.slice(0, 4)) });
      credited.serviceClockDate = toDate;
      credited.lastCreditedDate = last;
      return credited;
    }
  }
  next.serviceClockDate = toDate;
  return next;
}

function creditContractServiceDate(state, { date, level, serviceWindow }) {
  validateContractState(state);
  assertIsoDate(date, "contract credit date");
  const next = clone(state);
  if (date > next.serviceClockDate) next.serviceClockDate = date;
  if (level !== "MLB" || !serviceDateEligible(date, serviceWindow) || next.lastCreditedDate === date) return next;
  const credited = addContractServiceDays(next, 1, { seasonYear: Number(date.slice(0, 4)) });
  credited.serviceClockDate = date;
  credited.lastCreditedDate = date;
  return credited;
}

function getContractPublicView(state, { currentLevel = null, currentDate = null } = {}) {
  if (!state) return null;
  validateContractState(state);
  const ruleset = getContractRuleset(state.rulesetId);
  const status = classifyContractControl(state, ruleset);
  const baselineKnown = state.baseline.status === "KNOWN_ZERO";
  const knownTotalDays = baselineKnown
    ? Number(state.baseline.historicalServiceDays ?? 0) + state.simulatedServiceDays
    : null;
  const parts = knownTotalDays === null ? null : serviceParts(knownTotalDays, ruleset);
  const year = currentDate?.slice?.(0, 4) ?? null;
  return Object.freeze({
    rulesetId: ruleset.id,
    status,
    baseline: state.baseline.status,
    currentLevel,
    service: Object.freeze({
      knownTotalDays,
      simulatedDaysSinceSave: state.simulatedServiceDays,
      thisSeasonDays: year ? Number(state.serviceBySeason?.[year] ?? 0) : 0,
      years: parts?.years ?? null,
      days: parts?.days ?? null,
      display: parts?.display ?? null
    }),
    terms: Object.freeze({
      kind: state.terms.kind,
      years: state.terms.years,
      totalGuarantee: state.terms.totalGuarantee,
      aav: state.terms.aav,
      salaryBasis: state.terms.salaryBasis,
      currency: state.terms.currency,
      expectedRole: state.terms.expectedRole
    }),
    arbitration: Object.freeze({
      standardEligibleYears: ruleset.arbitrationYears,
      superTwoMinimumPriorSeasonDays: ruleset.superTwoMinimumPriorSeasonDays,
      superTwoPercent: ruleset.superTwoPercent,
      detailedEvaluation: "DEFERRED_V53"
    }),
    freeAgency: Object.freeze({ eligibleYears: ruleset.freeAgencyYears }),
    ruleSummary: Object.freeze({
      serviceYearDays: ruleset.serviceYearDays,
      regularSeasonCalendarDays: ruleset.regularSeasonCalendarDays,
      mlbMinimumSalary: ruleset.mlbMinimumSalary
    })
  });
}

export {
  CONTRACT_STATE_VERSION,
  createContractState,
  normalizeContractState,
  validateContractState,
  getMlbServiceWindow,
  addContractServiceDays,
  advanceContractStateToDate,
  creditContractServiceDate,
  getContractPublicView
};
