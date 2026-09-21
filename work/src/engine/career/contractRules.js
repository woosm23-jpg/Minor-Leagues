const CONTRACT_RULESETS = Object.freeze({
  ruleset_2026: Object.freeze({
    id: "ruleset_2026",
    serviceYearDays: 172,
    regularSeasonCalendarDays: 187,
    arbitrationYears: 3,
    freeAgencyYears: 6,
    superTwoMinimumPriorSeasonDays: 86,
    superTwoPercent: 0.22,
    mlbMinimumSalary: 780000,
    qualifyingOfferValue2026: 22025000,
    qualifyingOfferOneCareer: true,
    qualifyingOfferRequiresFullSeasonOrganization: true,
    futureCbaStatus: "UNVERIFIED_PENDING_NEW_CBA",
    simulationPolicy: "FROZEN_RULESET_2026_UNTIL_VERSIONED_REPLACEMENT",
    currency: "USD",
    verifiedOn: "2026-09-22",
    source: "MLB 2022-26 Basic Agreement / MLB Glossary"
  })
});

function getContractRuleset(id = "ruleset_2026") {
  const ruleset = CONTRACT_RULESETS[id];
  if (!ruleset) throw new RangeError(`지원하지 않는 계약 ruleset입니다: ${id}`);
  return ruleset;
}

function serviceParts(totalDays, ruleset = getContractRuleset()) {
  if (!Number.isInteger(totalDays) || totalDays < 0) throw new RangeError("service days는 0 이상의 정수여야 합니다.");
  const years = Math.floor(totalDays / ruleset.serviceYearDays);
  const days = totalDays % ruleset.serviceYearDays;
  return Object.freeze({
    years,
    days,
    display: `${years}.${String(days).padStart(3, "0")}`
  });
}

function classifyContractControl(state, ruleset = getContractRuleset(state?.rulesetId ?? "ruleset_2026")) {
  if (!state) return "UNKNOWN";
  if (state.baseline?.status === "UNKNOWN_REAL_WORLD") return "UNKNOWN_REAL_BASELINE";
  const historical = Number(state.baseline?.historicalServiceDays ?? 0);
  const simulated = Number(state.simulatedServiceDays ?? 0);
  const total = historical + simulated;
  if (state.terms?.kind === "MLB_GUARANTEED") return "SIGNED_CONTRACT";
  if (total >= ruleset.freeAgencyYears * ruleset.serviceYearDays) return "FREE_AGENCY_ELIGIBLE";
  if (total >= ruleset.arbitrationYears * ruleset.serviceYearDays) return "ARBITRATION_ELIGIBLE";
  if (state.hasMlbContract === true || total > 0) return "PRE_ARBITRATION";
  return "MINOR_LEAGUE_CONTROL";
}

export { CONTRACT_RULESETS, getContractRuleset, serviceParts, classifyContractControl };
