import { getContractRuleset } from "./contractRules.js";
import { validateContractState, applyGuaranteedContractTerms } from "./contractState.js";

const CONTRACT_MARKET_VERSION = 1;
const AGENT_STRATEGIES = Object.freeze(["SECURITY", "BALANCED", "BET_ON_MYSELF"]);
const MARKET_STATUSES = new Set([
  "CONTROLLED", "UNKNOWN_BASELINE", "ARBITRATION_ELIGIBLE",
  "ARBITRATION_PENDING", "ARBITRATION_SETTLED",
  "FREE_AGENT_ELIGIBLE", "FREE_AGENT_OPEN", "SIGNED"
]);

function clone(value) { return structuredClone(value); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v))); }
function roundMoney(v, step = 25000) { return Math.max(step, Math.round(Number(v) / step) * step); }
function assertIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}
function addIsoDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new TypeError(`유효한 날짜가 아닙니다: ${iso}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function stableNoise(key) {
  let h = 2166136261 >>> 0;
  const s = String(key);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 10000) / 10000;
}
function knownServiceDays(contractState) {
  if (!contractState || contractState.baseline?.status !== "KNOWN_ZERO") return null;
  return Number(contractState.baseline?.historicalServiceDays ?? 0) + Number(contractState.simulatedServiceDays ?? 0);
}

function createContractMarketState({ playerId, startDate, agentStrategy = "BALANCED" }) {
  if (typeof playerId !== "string" || !playerId) throw new TypeError("market playerId가 필요합니다.");
  assertIsoDate(startDate, "market startDate");
  if (!AGENT_STRATEGIES.includes(agentStrategy)) throw new RangeError(`지원하지 않는 agent strategy입니다: ${agentStrategy}`);
  return {
    schemaVersion: CONTRACT_MARKET_VERSION,
    playerId,
    agentStrategy,
    status: "CONTROLLED",
    eligibility: {
      arbitration: "NOT_ELIGIBLE",
      freeAgency: false,
      serviceDays: null,
      superTwoCutoffDays: null
    },
    arbitration: null,
    freeAgency: {
      openedDate: null,
      offers: [],
      acceptedOfferId: null,
      lastMarketDate: null
    },
    lastEvaluationDate: startDate,
    history: []
  };
}

function validateContractMarketState(state, label = "contractMarketState") {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if (state.schemaVersion !== CONTRACT_MARKET_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  if (typeof state.playerId !== "string" || !state.playerId) throw new TypeError(`${label}.playerId가 필요합니다.`);
  if (!AGENT_STRATEGIES.includes(state.agentStrategy)) throw new RangeError(`${label}.agentStrategy가 잘못되었습니다.`);
  if (!MARKET_STATUSES.has(state.status)) throw new RangeError(`${label}.status가 잘못되었습니다.`);
  assertIsoDate(state.lastEvaluationDate, `${label}.lastEvaluationDate`);
  if (!state.eligibility || typeof state.eligibility !== "object") throw new TypeError(`${label}.eligibility가 필요합니다.`);
  if (!state.freeAgency || typeof state.freeAgency !== "object" || !Array.isArray(state.freeAgency.offers)) throw new TypeError(`${label}.freeAgency가 필요합니다.`);
  if (!Array.isArray(state.history)) throw new TypeError(`${label}.history가 배열이어야 합니다.`);
  for (const offer of state.freeAgency.offers) {
    if (typeof offer.offerId !== "string" || !offer.offerId) throw new TypeError(`${label}.offerId가 필요합니다.`);
    if (!Number.isInteger(offer.years) || offer.years < 1) throw new RangeError(`${label}.offer years가 잘못되었습니다.`);
    for (const key of ["aav", "totalGuarantee"]) if (!Number.isFinite(Number(offer[key])) || Number(offer[key]) <= 0) throw new RangeError(`${label}.offer ${key}가 잘못되었습니다.`);
    assertIsoDate(offer.createdDate, `${label}.offer.createdDate`);
    assertIsoDate(offer.expiresDate, `${label}.offer.expiresDate`);
  }
  return true;
}

function normalizeContractMarketState(existing, options) {
  if (!existing) return createContractMarketState(options);
  validateContractMarketState(existing);
  if (existing.playerId !== options.playerId) throw new RangeError(`market playerId 불일치: ${existing.playerId} != ${options.playerId}`);
  return clone(existing);
}

function superTwoCutoff(cohortServiceDays = [], percent = 0.22) {
  const rows = cohortServiceDays.filter((x) => Number.isInteger(x) && x >= 0).sort((a, b) => b - a);
  if (!rows.length) return null;
  const count = Math.max(1, Math.ceil(rows.length * percent));
  return rows[Math.min(rows.length - 1, count - 1)];
}

function evaluateEligibility(contractState, {
  cohortServiceDays = [],
  priorSeasonServiceDays = null
} = {}) {
  validateContractState(contractState);
  const rules = getContractRuleset(contractState.rulesetId);
  const serviceDays = knownServiceDays(contractState);
  if (serviceDays === null) {
    return {
      arbitration: "UNKNOWN_BASELINE",
      freeAgency: false,
      serviceDays: null,
      superTwoCutoffDays: null
    };
  }
  const faThreshold = rules.freeAgencyYears * rules.serviceYearDays;
  const arbThreshold = rules.arbitrationYears * rules.serviceYearDays;
  if (serviceDays >= faThreshold) {
    return { arbitration: "NOT_APPLICABLE", freeAgency: true, serviceDays, superTwoCutoffDays: null };
  }
  if (serviceDays >= arbThreshold) {
    return { arbitration: "STANDARD", freeAgency: false, serviceDays, superTwoCutoffDays: null };
  }
  const twoYear = 2 * rules.serviceYearDays;
  if (serviceDays >= twoYear && serviceDays < arbThreshold && Number(priorSeasonServiceDays) >= rules.superTwoMinimumPriorSeasonDays) {
    const cutoff = superTwoCutoff(cohortServiceDays, rules.superTwoPercent);
    if (cutoff !== null && serviceDays >= cutoff) {
      return { arbitration: "SUPER_TWO", freeAgency: false, serviceDays, superTwoCutoffDays: cutoff };
    }
    return { arbitration: "SUPER_TWO_COHORT_MISS", freeAgency: false, serviceDays, superTwoCutoffDays: cutoff };
  }
  return { arbitration: "NOT_ELIGIBLE", freeAgency: false, serviceDays, superTwoCutoffDays: null };
}

function refreshContractMarketState(state, {
  contractState,
  currentDate,
  cohortServiceDays = [],
  priorSeasonServiceDays = null
}) {
  validateContractMarketState(state);
  assertIsoDate(currentDate, "market currentDate");
  const next = clone(state);
  const eligibility = evaluateEligibility(contractState, { cohortServiceDays, priorSeasonServiceDays });
  next.eligibility = eligibility;
  next.lastEvaluationDate = currentDate;
  if (eligibility.serviceDays === null) next.status = "UNKNOWN_BASELINE";
  else if (next.status === "SIGNED" && contractState.terms?.kind === "MLB_GUARANTEED") next.status = "SIGNED";
  else if (next.status === "ARBITRATION_SETTLED" && next.arbitration?.settledSalary !== null && String(next.arbitration?.preparedDate ?? "").slice(0, 4) === currentDate.slice(0, 4)) next.status = "ARBITRATION_SETTLED";
  else if (eligibility.freeAgency) next.status = "FREE_AGENT_ELIGIBLE";
  else if (["STANDARD", "SUPER_TWO"].includes(eligibility.arbitration)) next.status = "ARBITRATION_ELIGIBLE";
  else next.status = "CONTROLLED";
  return next;
}

function setAgentStrategy(state, strategy) {
  validateContractMarketState(state);
  if (!AGENT_STRATEGIES.includes(strategy)) throw new RangeError(`지원하지 않는 agent strategy입니다: ${strategy}`);
  const next = clone(state);
  next.agentStrategy = strategy;
  return next;
}

function arbitrationCenterSalary({
  rulesetId = "ruleset_2026",
  previousSalary = null,
  performanceIndex = 0.5,
  trackRecordIndex = 0.5,
  roleValue = 0.5,
  serviceYears = 3
}) {
  const rules = getContractRuleset(rulesetId);
  const base = Math.max(rules.mlbMinimumSalary, Number(previousSalary ?? rules.mlbMinimumSalary));
  const performance = clamp(performanceIndex, 0, 1);
  const track = clamp(trackRecordIndex, 0, 1);
  const role = clamp(roleValue, 0, 1);
  const serviceBoost = 1 + Math.max(0, Number(serviceYears) - 3) * 0.22;
  const raiseFactor = 1.18 + performance * 1.35 + track * 0.55 + role * 0.45;
  return roundMoney(base * raiseFactor * serviceBoost);
}

function prepareArbitrationCase(state, contractState, {
  date,
  performanceIndex = 0.5,
  trackRecordIndex = 0.5,
  roleValue = 0.5,
  cohortServiceDays = []
}) {
  validateContractMarketState(state);
  validateContractState(contractState);
  assertIsoDate(date, "arbitration date");
  const priorSeasonServiceDays = Number(contractState.serviceBySeason?.[String(Number(date.slice(0, 4)) - 1)] ?? 0);
  const eligibility = evaluateEligibility(contractState, { cohortServiceDays, priorSeasonServiceDays });
  if (!["STANDARD", "SUPER_TWO"].includes(eligibility.arbitration)) throw new RangeError("salary arbitration 자격이 없습니다.");
  const rules = getContractRuleset(contractState.rulesetId);
  const years = eligibility.serviceDays / rules.serviceYearDays;
  const center = arbitrationCenterSalary({
    rulesetId: contractState.rulesetId,
    previousSalary: contractState.terms?.aav ?? contractState.terms?.salaryBasis,
    performanceIndex,
    trackRecordIndex,
    roleValue,
    serviceYears: years
  });
  const teamFigure = roundMoney(Math.max(rules.mlbMinimumSalary, center * 0.90));
  const playerFigure = roundMoney(Math.max(teamFigure + 25000, center * 1.10));
  const next = clone(state);
  next.status = "ARBITRATION_PENDING";
  next.arbitration = {
    eligibility: eligibility.arbitration,
    preparedDate: date,
    teamFigure,
    playerFigure,
    midpoint: roundMoney((teamFigure + playerFigure) / 2),
    settledSalary: null,
    outcome: null
  };
  next.history.push({ type: "ARBITRATION_PREPARED", date, teamFigure, playerFigure });
  return next;
}

function resolveArbitration(state, contractState, {
  date,
  mode = "HEARING",
  performanceIndex = 0.5,
  settlementSalary = null
}) {
  validateContractMarketState(state);
  validateContractState(contractState);
  assertIsoDate(date, "arbitration resolution date");
  if (!state.arbitration || state.status !== "ARBITRATION_PENDING") throw new RangeError("pending arbitration case가 없습니다.");
  let salary;
  let outcome;
  if (mode === "SETTLEMENT") {
    const low = state.arbitration.teamFigure;
    const high = state.arbitration.playerFigure;
    salary = roundMoney(settlementSalary ?? (low + high) / 2);
    salary = Math.min(high, Math.max(low, salary));
    outcome = "SETTLED";
  } else if (mode === "HEARING") {
    salary = clamp(performanceIndex, 0, 1) >= 0.52 ? state.arbitration.playerFigure : state.arbitration.teamFigure;
    outcome = salary === state.arbitration.playerFigure ? "PLAYER_FIGURE_SELECTED" : "TEAM_FIGURE_SELECTED";
  } else {
    throw new RangeError(`지원하지 않는 arbitration resolution mode입니다: ${mode}`);
  }
  const nextMarket = clone(state);
  nextMarket.status = "ARBITRATION_SETTLED";
  nextMarket.arbitration.settledSalary = salary;
  nextMarket.arbitration.outcome = outcome;
  nextMarket.history.push({ type: "ARBITRATION_RESOLVED", date, outcome, salary });
  const nextContract = clone(contractState);
  nextContract.hasMlbContract = true;
  nextContract.terms.kind = "MLB_CONTROL";
  nextContract.terms.years = 1;
  nextContract.terms.totalGuarantee = salary;
  nextContract.terms.aav = salary;
  nextContract.terms.salaryBasis = salary;
  nextContract.terms.expectedRole = nextContract.terms.expectedRole ?? null;
  return { marketState: nextMarket, contractState: nextContract, salary, outcome };
}

function nonTender(state, { date }) {
  validateContractMarketState(state);
  assertIsoDate(date, "non-tender date");
  const next = clone(state);
  next.status = "FREE_AGENT_ELIGIBLE";
  next.history.push({ type: "NON_TENDERED", date });
  return next;
}

function expectedRole(projectedValue) {
  const v = clamp(projectedValue, 0, 1);
  if (v >= 0.82) return "STAR";
  if (v >= 0.65) return "STARTER";
  if (v >= 0.48) return "REGULAR";
  if (v >= 0.32) return "BENCH_OR_PLATOON";
  return "DEPTH";
}

function projectFreeAgentMarket({
  rulesetId = "ruleset_2026",
  age = 29,
  projectedValue = 0.5,
  durability = 0.5,
  trackRecord = 0.5,
  reputation = 0.5,
  positionDemand = 0.5,
  agentStrategy = "BALANCED"
}) {
  const rules = getContractRuleset(rulesetId);
  if (!AGENT_STRATEGIES.includes(agentStrategy)) throw new RangeError(`지원하지 않는 agent strategy입니다: ${agentStrategy}`);
  const pv = clamp(projectedValue, 0, 1);
  const dur = clamp(durability, 0, 1);
  const track = clamp(trackRecord, 0, 1);
  const rep = clamp(reputation, 0, 1);
  const demand = clamp(positionDemand, 0, 1);
  const agePenalty = age <= 27 ? 1.06 : age <= 30 ? 1 : age <= 33 ? 0.86 : age <= 36 ? 0.68 : 0.48;
  const quality = clamp(pv * 0.46 + track * 0.20 + dur * 0.12 + rep * 0.10 + demand * 0.12, 0, 1);
  let aav = rules.mlbMinimumSalary + quality * quality * 36000000 * agePenalty;
  let years = quality >= 0.85 ? 7 : quality >= 0.72 ? 5 : quality >= 0.58 ? 4 : quality >= 0.42 ? 2 : 1;
  if (age >= 34) years = Math.min(years, 3);
  if (age >= 37) years = 1;
  if (agentStrategy === "SECURITY") { years = Math.min(8, years + 1); aav *= 0.94; }
  if (agentStrategy === "BET_ON_MYSELF") { years = Math.max(1, years - 1); aav *= 1.08; }
  aav = roundMoney(Math.max(rules.mlbMinimumSalary, aav));
  return {
    model: "market_model_v53_1",
    aav,
    years,
    totalGuarantee: aav * years,
    expectedRole: expectedRole(pv),
    quality
  };
}

function generateFreeAgentOffers(state, {
  date,
  player,
  teamProfiles,
  maxOffers = 8,
  seed = "v53"
}) {
  validateContractMarketState(state);
  assertIsoDate(date, "free-agent market date");
  if (!Array.isArray(teamProfiles) || teamProfiles.length === 0) throw new TypeError("teamProfiles가 필요합니다.");
  const market = projectFreeAgentMarket({ ...player, agentStrategy: state.agentStrategy });
  const offers = [];
  for (const team of teamProfiles) {
    const need = clamp(team.needScore, 0, 1);
    const budget = clamp(team.budgetScore, 0, 1);
    const competitive = clamp(team.competitiveScore, 0, 1);
    const path = clamp(team.playingTimeScore, 0, 1);
    const interest = need * 0.40 + budget * 0.25 + competitive * 0.15 + path * 0.20;
    if (interest < 0.34) continue;
    const noise = 0.94 + stableNoise(`${seed}:${team.organizationId}`) * 0.12;
    const aav = roundMoney(market.aav * (0.82 + interest * 0.30) * noise);
    let years = market.years;
    if (state.agentStrategy === "SECURITY" && need >= 0.65) years += 1;
    if (budget < 0.35) years = Math.min(years, 2);
    years = Math.max(1, Math.min(8, years));
    const offerId = `fa_${date}_${team.organizationId}_${years}_${aav}`;
    offers.push({
      offerId,
      organizationId: String(team.organizationId),
      organizationName: team.organizationName ?? String(team.organizationId),
      years,
      aav,
      totalGuarantee: aav * years,
      expectedRole: team.expectedRole ?? market.expectedRole,
      interestScore: Number(interest.toFixed(4)),
      createdDate: date,
      expiresDate: addIsoDays(date, 5 + Math.floor(stableNoise(`${offerId}:exp`) * 10)),
      status: "OPEN",
      maxAav: roundMoney(aav * (1.04 + budget * 0.12)),
      maxYears: Math.min(8, years + (need > 0.75 ? 1 : 0))
    });
  }
  offers.sort((a, b) => b.totalGuarantee - a.totalGuarantee || b.aav - a.aav || a.organizationId.localeCompare(b.organizationId));
  const next = clone(state);
  next.status = "FREE_AGENT_OPEN";
  next.freeAgency.openedDate = date;
  next.freeAgency.lastMarketDate = date;
  next.freeAgency.offers = offers.slice(0, maxOffers);
  next.freeAgency.acceptedOfferId = null;
  next.history.push({ type: "FREE_AGENCY_OPENED", date, offerCount: next.freeAgency.offers.length });
  return next;
}

function counterFreeAgentOffer(state, {
  offerId,
  date,
  request = "AAV"
}) {
  validateContractMarketState(state);
  assertIsoDate(date, "counter date");
  if (state.status !== "FREE_AGENT_OPEN") throw new RangeError("free-agent market가 열려 있지 않습니다.");
  const next = clone(state);
  const offer = next.freeAgency.offers.find((x) => x.offerId === offerId);
  if (!offer) throw new RangeError(`offer를 찾을 수 없습니다: ${offerId}`);
  if (date > offer.expiresDate) {
    offer.status = "EXPIRED";
    return { marketState: next, accepted: false, reason: "EXPIRED" };
  }
  let accepted = false;
  if (request === "AAV") {
    const requested = roundMoney(offer.aav * 1.05);
    accepted = requested <= offer.maxAav;
    if (accepted) {
      offer.aav = requested;
      offer.totalGuarantee = requested * offer.years;
    }
  } else if (request === "TERM") {
    const requested = offer.years + 1;
    accepted = requested <= offer.maxYears;
    if (accepted) {
      offer.years = requested;
      offer.totalGuarantee = offer.aav * requested;
    }
  } else {
    throw new RangeError(`지원하지 않는 counter request입니다: ${request}`);
  }
  offer.status = accepted ? "REVISED" : "OPEN";
  next.history.push({ type: "FREE_AGENCY_COUNTER", date, offerId, request, accepted });
  return { marketState: next, accepted, reason: accepted ? "REVISED" : "TEAM_LIMIT" };
}

function acceptFreeAgentOffer(state, contractState, { offerId, date }) {
  validateContractMarketState(state);
  validateContractState(contractState);
  assertIsoDate(date, "offer accept date");
  const offer = state.freeAgency.offers.find((x) => x.offerId === offerId);
  if (!offer) throw new RangeError(`offer를 찾을 수 없습니다: ${offerId}`);
  if (date > offer.expiresDate) throw new RangeError("offer가 만료되었습니다.");
  const nextMarket = clone(state);
  nextMarket.status = "SIGNED";
  nextMarket.freeAgency.acceptedOfferId = offerId;
  nextMarket.freeAgency.offers = nextMarket.freeAgency.offers.map((x) => ({ ...x, status: x.offerId === offerId ? "ACCEPTED" : "CLOSED" }));
  nextMarket.history.push({ type: "FREE_AGENT_SIGNED", date, offerId, organizationId: offer.organizationId });
  const startSeason = Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) >= 10 ? 1 : 0);
  const contract = applyGuaranteedContractTerms(contractState, {
    signedDate: date,
    startSeason,
    years: offer.years,
    totalGuarantee: offer.totalGuarantee,
    aav: offer.aav,
    expectedRole: offer.expectedRole,
    organizationId: offer.organizationId
  });
  return { marketState: nextMarket, contractState: contract, offer: clone(offer) };
}

function evaluateQualifyingOfferEligibility(contractState, {
  marketYear,
  previouslyReceived = false,
  fullSeasonSameOrganization = false
}) {
  validateContractState(contractState);
  const rules = getContractRuleset(contractState.rulesetId);
  if (Number(marketYear) !== 2026) {
    return { eligible: false, status: "FUTURE_CBA_UNVERIFIED", value: null };
  }
  const serviceDays = knownServiceDays(contractState);
  const eligible = serviceDays !== null
    && serviceDays >= rules.freeAgencyYears * rules.serviceYearDays
    && previouslyReceived === false
    && fullSeasonSameOrganization === true;
  return {
    eligible,
    status: eligible ? "ELIGIBLE" : "NOT_ELIGIBLE",
    value: eligible ? rules.qualifyingOfferValue2026 : null
  };
}

function getContractMarketPublicView(state) {
  if (!state) return null;
  validateContractMarketState(state);
  return Object.freeze({
    agentStrategy: state.agentStrategy,
    status: state.status,
    eligibility: Object.freeze({ ...state.eligibility }),
    arbitration: state.arbitration ? Object.freeze({
      eligibility: state.arbitration.eligibility,
      teamFigure: state.arbitration.teamFigure,
      playerFigure: state.arbitration.playerFigure,
      settledSalary: state.arbitration.settledSalary,
      outcome: state.arbitration.outcome
    }) : null,
    freeAgency: Object.freeze({
      openOffers: state.freeAgency.offers.filter((x) => ["OPEN", "REVISED"].includes(x.status)).length,
      acceptedOfferId: state.freeAgency.acceptedOfferId
    })
  });
}

export {
  CONTRACT_MARKET_VERSION,
  AGENT_STRATEGIES,
  createContractMarketState,
  validateContractMarketState,
  normalizeContractMarketState,
  superTwoCutoff,
  evaluateEligibility,
  refreshContractMarketState,
  setAgentStrategy,
  arbitrationCenterSalary,
  prepareArbitrationCase,
  resolveArbitration,
  nonTender,
  projectFreeAgentMarket,
  generateFreeAgentOffers,
  counterFreeAgentOffer,
  acceptFreeAgentOffer,
  evaluateQualifyingOfferEligibility,
  getContractMarketPublicView
};
