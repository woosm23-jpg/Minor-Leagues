const ROSTER_RULESETS = Object.freeze({
  ruleset_2026: Object.freeze({
    id: "ruleset_2026",
    fortyManLimit: 40,
    activeRosterReference: 26,
    standardOptionYears: 3,
    optionYearMinorDays: 20,
    maxOptionalAssignmentsPerSeason: 5,
    dfaResolutionDays: 7,
    outrightRejectServiceDays: 861,
    outrightFreeAgencyElectionServiceDays: 517,
    rule5ProtectionYearsSigned18OrYounger: 5,
    rule5ProtectionYearsSigned19OrOlder: 4,
    fourthOption: "SPECIAL_CASE_DEFERRED",
    verifiedOn: "2026-09-21",
    source: "MLB Glossary / 2022-26 CBA-era transaction rules"
  })
});

function getRosterRuleset(id = "ruleset_2026") {
  const ruleset = ROSTER_RULESETS[id];
  if (!ruleset) throw new RangeError(`지원하지 않는 roster ruleset입니다: ${id}`);
  return ruleset;
}

function waiverPriority(rows = []) {
  return [...rows].sort((a, b) => {
    const ap = Number(a.pct ?? a.winningPct ?? 0);
    const bp = Number(b.pct ?? b.winningPct ?? 0);
    if (ap !== bp) return ap - bp;
    const app = Number(a.previousSeasonPct ?? 0);
    const bpp = Number(b.previousSeasonPct ?? 0);
    if (app !== bpp) return app - bpp;
    return String(a.teamId ?? "").localeCompare(String(b.teamId ?? ""));
  });
}

export { ROSTER_RULESETS, getRosterRuleset, waiverPriority };
