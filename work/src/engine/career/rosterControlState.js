import { getRosterRuleset } from "./rosterRules.js";

const ROSTER_CONTROL_VERSION = 1;
const BASELINES = new Set(["KNOWN_ZERO", "UNKNOWN_REAL_WORLD"]);
const ASSIGNMENTS = new Set([
  "MINORS", "MLB_ACTIVE", "OPTIONED", "OPTIONED_UNKNOWN",
  "DFA_PENDING", "WAIVERS_PENDING", "OUTRIGHTED", "CLAIMED_40_MAN"
]);

class RosterRuleError extends RangeError {
  constructor(code, message) {
    super(message);
    this.name = "RosterRuleError";
    this.code = code;
  }
}

function clone(value) { return structuredClone(value); }
function assertIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}
function addIsoDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new TypeError(`유효한 날짜가 아닙니다: ${iso}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  if (fromIso === toIso) return 0;
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`roster clock가 역행했습니다: ${fromIso} -> ${toIso}`);
  return days;
}
function isRealWorldPlayer(player) {
  return Boolean(player?.realWorld?.sourceId || player?.realWorld?.sourceTeamId || player?.realWorld?.organizationId);
}

function createRosterControlState({
  playerId, player = null, startDate, initialLevel = "A",
  organizationId = null, isUser = false, rulesetId = "ruleset_2026"
}) {
  if (typeof playerId !== "string" || !playerId) throw new TypeError("roster playerId가 필요합니다.");
  assertIsoDate(startDate, "roster startDate");
  const rules = getRosterRuleset(rulesetId);
  const unknownReal = !isUser && isRealWorldPlayer(player);
  const mlb = initialLevel === "MLB";
  return {
    schemaVersion: ROSTER_CONTROL_VERSION,
    rulesetId: rules.id,
    playerId,
    organizationId: organizationId === null ? null : String(organizationId),
    baseline: unknownReal ? "UNKNOWN_REAL_WORLD" : "KNOWN_ZERO",
    on40Man: mlb ? true : (unknownReal ? null : false),
    fortyManAddedDate: mlb ? startDate : null,
    assignmentStatus: mlb ? "MLB_ACTIVE" : "MINORS",
    option: {
      yearsTotal: unknownReal ? null : rules.standardOptionYears,
      yearsUsed: unknownReal ? null : 0,
      remaining: unknownReal ? null : rules.standardOptionYears,
      assignmentsThisSeason: 0,
      minorDaysThisSeason: 0,
      minorDaysThisAssignment: 0,
      yearUsedThisSeason: unknownReal ? null : false,
      assignmentStartDate: null
    },
    dfa: null,
    priorOutrights: unknownReal ? null : 0,
    lastClockDate: startDate
  };
}

function validateRosterControlState(state, label = "rosterControlState") {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if (state.schemaVersion !== ROSTER_CONTROL_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  const rules = getRosterRuleset(state.rulesetId);
  if (typeof state.playerId !== "string" || !state.playerId) throw new TypeError(`${label}.playerId가 필요합니다.`);
  if (!BASELINES.has(state.baseline)) throw new RangeError(`${label}.baseline이 잘못되었습니다.`);
  if (![true, false, null].includes(state.on40Man)) throw new TypeError(`${label}.on40Man이 잘못되었습니다.`);
  if (!ASSIGNMENTS.has(state.assignmentStatus)) throw new RangeError(`${label}.assignmentStatus가 잘못되었습니다.`);
  assertIsoDate(state.lastClockDate, `${label}.lastClockDate`);
  if (state.fortyManAddedDate !== null) assertIsoDate(state.fortyManAddedDate, `${label}.fortyManAddedDate`);
  if (!state.option || typeof state.option !== "object") throw new TypeError(`${label}.option이 필요합니다.`);
  for (const key of ["assignmentsThisSeason", "minorDaysThisSeason", "minorDaysThisAssignment"]) {
    if (!Number.isInteger(state.option[key]) || state.option[key] < 0) throw new RangeError(`${label}.option.${key}가 잘못되었습니다.`);
  }
  if (state.option.assignmentsThisSeason > rules.maxOptionalAssignmentsPerSeason) throw new RangeError(`${label}.option.assignmentsThisSeason이 제한을 초과했습니다.`);
  if (state.baseline === "KNOWN_ZERO") {
    for (const key of ["yearsTotal", "yearsUsed", "remaining"]) {
      if (!Number.isInteger(state.option[key]) || state.option[key] < 0) throw new RangeError(`${label}.option.${key}가 잘못되었습니다.`);
    }
    if (state.option.yearsUsed + state.option.remaining !== state.option.yearsTotal) throw new RangeError(`${label}.option year 합계가 맞지 않습니다.`);
    if (typeof state.option.yearUsedThisSeason !== "boolean") throw new TypeError(`${label}.option.yearUsedThisSeason이 boolean이어야 합니다.`);
  } else {
    if (state.option.yearsTotal !== null || state.option.yearsUsed !== null || state.option.remaining !== null || state.option.yearUsedThisSeason !== null) {
      throw new RangeError(`${label}: 실존 unknown option baseline은 숫자를 추정하지 않습니다.`);
    }
  }
  if (state.option.assignmentStartDate !== null) assertIsoDate(state.option.assignmentStartDate, `${label}.option.assignmentStartDate`);
  if (state.dfa !== null) {
    if (typeof state.dfa !== "object") throw new TypeError(`${label}.dfa가 잘못되었습니다.`);
    assertIsoDate(state.dfa.designatedDate, `${label}.dfa.designatedDate`);
    assertIsoDate(state.dfa.deadlineDate, `${label}.dfa.deadlineDate`);
    if (state.dfa.placedOnWaiversDate !== null) assertIsoDate(state.dfa.placedOnWaiversDate, `${label}.dfa.placedOnWaiversDate`);
    if (state.dfa.resolvedDate !== null) assertIsoDate(state.dfa.resolvedDate, `${label}.dfa.resolvedDate`);
  }
  return true;
}

function normalizeRosterControlState(existing, options) {
  if (!existing) return createRosterControlState(options);
  validateRosterControlState(existing);
  const next = clone(existing);
  if (next.playerId !== options.playerId) throw new RangeError(`roster playerId 불일치: ${next.playerId} != ${options.playerId}`);
  if (options.organizationId !== undefined && options.organizationId !== null) next.organizationId = String(options.organizationId);
  if (options.resetSeason === true) return resetRosterControlForSeason(next, options);
  return next;
}

function consumeOptionYearIfDue(state, rules) {
  if (state.baseline !== "KNOWN_ZERO") return state;
  if (state.option.yearUsedThisSeason || state.option.minorDaysThisSeason < rules.optionYearMinorDays) return state;
  if (state.option.remaining <= 0) throw new RosterRuleError("OUT_OF_OPTIONS", "사용 가능한 option year가 없습니다.");
  const next = clone(state);
  next.option.yearsUsed += 1;
  next.option.remaining -= 1;
  next.option.yearUsedThisSeason = true;
  return next;
}

function advanceRosterControlToDate(state, { toDate }) {
  validateRosterControlState(state);
  assertIsoDate(toDate, "roster toDate");
  if (toDate < state.lastClockDate) throw new RangeError(`roster clock가 역행했습니다: ${state.lastClockDate} -> ${toDate}`);
  if (toDate === state.lastClockDate) return clone(state);
  const rules = getRosterRuleset(state.rulesetId);
  let next = clone(state);
  const days = daysBetween(next.lastClockDate, toDate);
  if (["OPTIONED", "OPTIONED_UNKNOWN"].includes(next.assignmentStatus)) {
    next.option.minorDaysThisSeason += days;
    next.option.minorDaysThisAssignment += days;
    next = consumeOptionYearIfDue(next, rules);
  }
  next.lastClockDate = toDate;
  return next;
}

function addTo40Man(state, { date, knownFortyManCount }) {
  validateRosterControlState(state);
  assertIsoDate(date, "40-man date");
  const rules = getRosterRuleset(state.rulesetId);
  if (state.on40Man === true) return clone(state);
  if (!Number.isInteger(knownFortyManCount) || knownFortyManCount < 0) throw new RangeError("known 40-man count가 필요합니다.");
  if (knownFortyManCount >= rules.fortyManLimit) throw new RosterRuleError("FORTY_MAN_FULL", "검증 가능한 40-man 슬롯이 가득 찼습니다.");
  const next = clone(state);
  next.on40Man = true;
  next.fortyManAddedDate = next.fortyManAddedDate ?? date;
  next.assignmentStatus = "MLB_ACTIVE";
  next.lastClockDate = date;
  return next;
}

function recallToMlb(state, { date }) {
  validateRosterControlState(state);
  assertIsoDate(date, "recall date");
  if (state.on40Man !== true) throw new RosterRuleError("NOT_ON_40_MAN", "MLB recall 전에 40-man 등록이 필요합니다.");
  const next = advanceRosterControlToDate(state, { toDate: date });
  next.assignmentStatus = "MLB_ACTIVE";
  next.option.assignmentStartDate = null;
  next.option.minorDaysThisAssignment = 0;
  return next;
}

function optionToMinors(state, { date }) {
  validateRosterControlState(state);
  assertIsoDate(date, "option date");
  const rules = getRosterRuleset(state.rulesetId);
  if (state.on40Man !== true) throw new RosterRuleError("NOT_ON_40_MAN", "40-man 선수가 아니므로 option assignment를 사용할 수 없습니다.");
  let next = advanceRosterControlToDate(state, { toDate: date });
  if (next.option.assignmentsThisSeason >= rules.maxOptionalAssignmentsPerSeason) {
    throw new RosterRuleError("OPTION_ASSIGNMENT_LIMIT", "시즌 optional assignment 횟수 제한에 도달했습니다.");
  }
  if (next.baseline === "KNOWN_ZERO" && next.option.remaining <= 0) {
    throw new RosterRuleError("OUT_OF_OPTIONS", "사용 가능한 option year가 없습니다.");
  }
  next.option.assignmentsThisSeason += 1;
  next.option.minorDaysThisSeason += 1;
  next.option.minorDaysThisAssignment = 1;
  next.option.assignmentStartDate = date;
  next.assignmentStatus = next.baseline === "UNKNOWN_REAL_WORLD" ? "OPTIONED_UNKNOWN" : "OPTIONED";
  next.lastClockDate = date;
  next = consumeOptionYearIfDue(next, rules);
  return next;
}

function designateForAssignment(state, { date }) {
  validateRosterControlState(state);
  assertIsoDate(date, "DFA date");
  const rules = getRosterRuleset(state.rulesetId);
  const next = advanceRosterControlToDate(state, { toDate: date });
  if (next.on40Man !== true) throw new RosterRuleError("NOT_ON_40_MAN", "DFA는 40-man 선수에게만 적용됩니다.");
  next.on40Man = false;
  next.assignmentStatus = "DFA_PENDING";
  next.option.assignmentStartDate = null;
  next.option.minorDaysThisAssignment = 0;
  next.dfa = {
    status: "DFA_PENDING",
    designatedDate: date,
    deadlineDate: addIsoDays(date, rules.dfaResolutionDays),
    placedOnWaiversDate: null,
    resolvedDate: null,
    claimedByOrganizationId: null
  };
  return next;
}

function placeOnOutrightWaivers(state, { date }) {
  validateRosterControlState(state);
  assertIsoDate(date, "waiver date");
  const next = advanceRosterControlToDate(state, { toDate: date });
  if (!next.dfa || next.assignmentStatus !== "DFA_PENDING") throw new RosterRuleError("NO_PENDING_DFA", "pending DFA가 없습니다.");
  if (date > next.dfa.deadlineDate) throw new RosterRuleError("DFA_DEADLINE_EXPIRED", "DFA 처리 기한을 넘겼습니다.");
  next.assignmentStatus = "WAIVERS_PENDING";
  next.dfa.status = "WAIVERS_PENDING";
  next.dfa.placedOnWaiversDate = date;
  return next;
}

function resolveOutrightWaivers(state, { date, claimedByOrganizationId = null, knownServiceDays = 0 }) {
  validateRosterControlState(state);
  assertIsoDate(date, "waiver resolution date");
  const rules = getRosterRuleset(state.rulesetId);
  const next = advanceRosterControlToDate(state, { toDate: date });
  if (!next.dfa || next.assignmentStatus !== "WAIVERS_PENDING") throw new RosterRuleError("NO_PENDING_WAIVERS", "pending outright waivers가 없습니다.");
  next.dfa.resolvedDate = date;
  if (claimedByOrganizationId !== null) {
    next.organizationId = String(claimedByOrganizationId);
    next.on40Man = true;
    next.assignmentStatus = "CLAIMED_40_MAN";
    next.dfa.status = "CLAIMED";
    next.dfa.claimedByOrganizationId = String(claimedByOrganizationId);
    return { state: next, result: "CLAIMED", rights: null };
  }
  next.on40Man = false;
  next.assignmentStatus = "OUTRIGHTED";
  next.dfa.status = "CLEARED";
  if (next.priorOutrights !== null) next.priorOutrights += 1;
  const rights = {
    canRejectMinorAssignment: Number(knownServiceDays) >= rules.outrightRejectServiceDays,
    canElectFreeAgency: Number(knownServiceDays) >= rules.outrightFreeAgencyElectionServiceDays || Number(state.priorOutrights ?? 0) > 0
  };
  return { state: next, result: "CLEARED", rights };
}

function resetRosterControlForSeason(state, { startDate, currentLevel = "A" }) {
  validateRosterControlState(state);
  assertIsoDate(startDate, "roster season startDate");
  const next = clone(state);
  next.option.assignmentsThisSeason = 0;
  next.option.minorDaysThisSeason = 0;
  next.option.minorDaysThisAssignment = 0;
  next.option.yearUsedThisSeason = next.baseline === "KNOWN_ZERO" ? false : null;
  next.option.assignmentStartDate = null;
  next.lastClockDate = startDate;
  if (next.dfa && ["DFA_PENDING", "WAIVERS_PENDING"].includes(next.assignmentStatus)) return next;
  if (currentLevel === "MLB") {
    next.on40Man = true;
    next.fortyManAddedDate = next.fortyManAddedDate ?? startDate;
    next.assignmentStatus = "MLB_ACTIVE";
    return next;
  }
  if (next.on40Man === true) return optionToMinors(next, { date: startDate });
  next.assignmentStatus = "MINORS";
  return next;
}

function getRosterControlPublicView(state) {
  if (!state) return null;
  validateRosterControlState(state);
  const rules = getRosterRuleset(state.rulesetId);
  return Object.freeze({
    rulesetId: state.rulesetId,
    baseline: state.baseline,
    on40Man: state.on40Man,
    assignmentStatus: state.assignmentStatus,
    fortyManAddedDate: state.fortyManAddedDate,
    options: Object.freeze({
      yearsTotal: state.option.yearsTotal,
      yearsUsed: state.option.yearsUsed,
      remaining: state.option.remaining,
      assignmentsThisSeason: state.option.assignmentsThisSeason,
      maxAssignmentsPerSeason: rules.maxOptionalAssignmentsPerSeason,
      minorDaysThisSeason: state.option.minorDaysThisSeason,
      yearUseThresholdDays: rules.optionYearMinorDays,
      historicalBaselineKnown: state.baseline === "KNOWN_ZERO"
    }),
    dfa: state.dfa ? Object.freeze({
      status: state.dfa.status,
      designatedDate: state.dfa.designatedDate,
      deadlineDate: state.dfa.deadlineDate
    }) : null,
    ruleSummary: Object.freeze({
      fortyManLimit: rules.fortyManLimit,
      standardOptionYears: rules.standardOptionYears,
      dfaResolutionDays: rules.dfaResolutionDays
    })
  });
}

function knownFortyManCount(states, playerIds) {
  return playerIds.reduce((count, id) => count + (states?.[id]?.on40Man === true ? 1 : 0), 0);
}

function prepareAaaMlbRosterMove({ states, candidateId, incumbentId, date, organizationId, organizationPlayerIds }) {
  const original = states ?? {};
  const next = clone(original);
  const knownCount = knownFortyManCount(next, organizationPlayerIds);
  const candidate = next[candidateId];
  const incumbent = next[incumbentId];
  if (!candidate || !incumbent) return { allowed: false, states: original, blockCode: "ROSTER_STATE_MISSING", candidateReasonCodes: [], incumbentReasonCodes: [] };
  try {
    const candidateWas40 = candidate.on40Man === true;
    let candidateNext = addTo40Man(candidate, { date, knownFortyManCount: knownCount });
    candidateNext.organizationId = String(organizationId);
    candidateNext = recallToMlb(candidateNext, { date });
    let incumbentNext = optionToMinors(incumbent, { date });
    incumbentNext.organizationId = String(organizationId);
    next[candidateId] = candidateNext;
    next[incumbentId] = incumbentNext;
    return {
      allowed: true,
      states: next,
      blockCode: null,
      candidateReasonCodes: candidateWas40 ? ["FORTY_MAN_ELIGIBLE"] : ["FORTY_MAN_ADDED"],
      incumbentReasonCodes: [incumbent.baseline === "UNKNOWN_REAL_WORLD" ? "OPTION_STATUS_UNKNOWN" : "OPTIONED_TO_MINORS"]
    };
  } catch (error) {
    const code = error?.code === "OUT_OF_OPTIONS" ? "OUT_OF_OPTIONS_WAIVERS_REQUIRED"
      : error?.code === "OPTION_ASSIGNMENT_LIMIT" ? "OPTION_ASSIGNMENT_LIMIT"
      : error?.code === "FORTY_MAN_FULL" ? "FORTY_MAN_FULL"
      : error?.code ?? "ROSTER_RULE_BLOCK";
    return { allowed: false, states: original, blockCode: code, candidateReasonCodes: [code], incumbentReasonCodes: [code] };
  }
}

export {
  ROSTER_CONTROL_VERSION,
  RosterRuleError,
  createRosterControlState,
  normalizeRosterControlState,
  validateRosterControlState,
  advanceRosterControlToDate,
  addTo40Man,
  recallToMlb,
  optionToMinors,
  designateForAssignment,
  placeOnOutrightWaivers,
  resolveOutrightWaivers,
  resetRosterControlForSeason,
  getRosterControlPublicView,
  knownFortyManCount,
  prepareAaaMlbRosterMove
};
