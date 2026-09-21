import { generateAmateurClass } from "./generatedTalent.js";
import {
  assignGeneratedEntrants,
  advanceGeneratedCohortFast,
  currentOvr,
  developedSnapshot,
  rebalanceGeneratedMlbOpportunity
} from "./generatedCareerPathway.js";
import { evaluateAiRetirements } from "./retirementSystem.js";

const GENERATED_LEAGUE_LIFECYCLE_VERSION = 3;
const LEVELS = Object.freeze(["A", "HIGH_A", "AA", "AAA", "MLB"]);

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function finite(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function releaseBlockedMinor(record) {
  if (record.level === "MLB") return false;
  const player = developedSnapshot(record);
  const age = finite(player.physical?.age, 24);
  const ovr = currentOvr(player);
  const ageLimit = ({ A: 24, HIGH_A: 25, AA: 27, AAA: 29 })[record.level] ?? 29;
  const levelFloor = ({ A: 32, HIGH_A: 36, AA: 40, AAA: 44 })[record.level] ?? 44;
  if (age >= ageLimit + 2 && record.seasonsAtLevel >= 2 && ovr < levelFloor - 2) return true;
  return age >= 31;
}

function generateEntrants({ seed, year, size, classStrength, organizationIds }) {
  const total = Math.max(0, Math.round(finite(size, 0)));
  if (!total) return freeze({ records: [], classStrength });
  const draftN = Math.round(total * 0.64);
  const internationalN = Math.round(total * 0.31);
  const undraftedN = Math.max(0, total - draftN - internationalN);
  let idOffset = 0;
  const draft = generateAmateurClass({ seed, year, size: draftN, previousClassStrength: classStrength, entryPath: "DRAFT", idOffset });
  idOffset += draftN;
  const international = generateAmateurClass({ seed, year, size: internationalN, previousClassStrength: draft.classStrength, entryPath: "INTERNATIONAL", idOffset });
  idOffset += internationalN;
  const undrafted = generateAmateurClass({ seed, year, size: undraftedN, previousClassStrength: (draft.classStrength + international.classStrength) / 2, entryPath: "UNDRAFTED", idOffset });
  const players = [...draft.players, ...international.players, ...undrafted.players];
  const nextStrength = players.length
    ? (draft.classStrength * draftN + international.classStrength * internationalN + undrafted.classStrength * undraftedN) / players.length
    : classStrength;
  return freeze({
    records: assignGeneratedEntrants(players, { seed, year, organizationIds }),
    classStrength: Number(nextStrength.toFixed(6))
  });
}

function snapshotGeneratedLeague(state, { year = state.year } = {}) {
  const records = state.records ?? [];
  const levels = Object.fromEntries(LEVELS.map((level) => [level, records.filter((r) => r.level === level).length]));
  const ovrs = records.map((r) => currentOvr(developedSnapshot(r)));
  const mlbOvrs = records.filter((r) => r.level === "MLB").map((r) => currentOvr(developedSnapshot(r)));
  const ages = records.map((r) => finite(developedSnapshot(r).physical?.age, 24));
  return freeze({
    year,
    active: records.length,
    levels,
    levelShares: Object.fromEntries(LEVELS.map((level) => [level, records.length ? levels[level] / records.length : 0])),
    meanOvr: mean(ovrs),
    mlbMeanOvr: mean(mlbOvrs),
    meanAge: mean(ages),
    under25: ages.filter((age) => age < 25).length,
    age35plus: ages.filter((age) => age >= 35).length,
    debutCount: state.debutAges?.length ?? 0,
    meanDebutAge: mean(state.debutAges ?? []),
    generatedCount: state.generatedCount ?? 0,
    releasedCount: state.releasedCount ?? 0,
    retiredCount: state.retiredCount ?? 0,
    classStrength: finite(state.classStrength, 0)
  });
}

function createGeneratedLeagueLifecycle({ seed, startYear, annualEntrants, organizationIds, targetMlbShare = 0.197, minMlbOvr = 47.5, targetMlbPitcherShare = 0.533, pitcherMlbFloorOffset = -2 } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("seed가 필요합니다.");
  if (!Number.isInteger(startYear)) throw new TypeError("startYear가 필요합니다.");
  if (!Array.isArray(organizationIds) || organizationIds.length === 0) throw new TypeError("organizationIds가 필요합니다.");
  const entrantCount = Math.max(1, Math.round(finite(annualEntrants, 0)));
  const entrantBatch = generateEntrants({ seed, year: startYear, size: entrantCount, classStrength: 0, organizationIds });
  const state = {
    version: GENERATED_LEAGUE_LIFECYCLE_VERSION,
    seed,
    year: startYear,
    annualEntrants: entrantCount,
    organizationIds: [...new Set(organizationIds.map(String))].sort(),
    targetMlbShare: clamp(finite(targetMlbShare, 0.197), 0.10, 0.35),
    minMlbOvr: clamp(finite(minMlbOvr, 47.5), 35, 60),
    targetMlbPitcherShare: clamp(finite(targetMlbPitcherShare, 0.533), 0.40, 0.65),
    pitcherMlbFloorOffset: clamp(finite(pitcherMlbFloorOffset, -2), -6, 2),
    classStrength: entrantBatch.classStrength,
    records: entrantBatch.records,
    generatedCount: entrantBatch.records.length,
    retiredCount: 0,
    releasedCount: 0,
    debutAges: []
  };
  return freeze({ ...state, snapshot: snapshotGeneratedLeague(state, { year: startYear }) });
}

function advanceGeneratedLeagueLifecycle(state, { year = state.year + 1 } = {}) {
  if (!state?.records || !Array.isArray(state.records)) throw new TypeError("generated league lifecycle state가 필요합니다.");
  if (!Number.isInteger(year) || year <= state.year) throw new RangeError("year는 현재 lifecycle year보다 커야 합니다.");
  let current = state;
  for (let y = state.year + 1; y <= year; y += 1) {
    const debutedBefore = new Set(current.records.filter((r) => r.mlbDebutYear != null).map((r) => String(r.player.id)));
    let records = advanceGeneratedCohortFast(current.records, { year: y, seed: current.seed });
    records = rebalanceGeneratedMlbOpportunity(records, { year: y, targetShare: current.targetMlbShare, minMlbOvr: current.minMlbOvr, targetPitcherShare: current.targetMlbPitcherShare, pitcherFloorOffset: current.pitcherMlbFloorOffset });
    const debutAges = [...current.debutAges];
    for (const record of records) {
      if (record.mlbDebutYear === y && !debutedBefore.has(String(record.player.id))) debutAges.push(record.state.health.age);
    }

    const developed = records.map((r) => developedSnapshot(r));
    const contextById = new Map(records.map((r) => [String(r.player.id), {
      playingTimeOpportunity: r.level === "MLB" ? 0.55 : 0.12,
      role: r.level === "MLB" ? "MLB_REGULAR" : "MINORS"
    }]));
    const retirements = evaluateAiRetirements(developed, { seed: current.seed, seasonKey: String(y), contextById });
    const retiredIds = new Set(retirements.retiredIds);
    records = records.filter((r) => !retiredIds.has(String(r.player.id)));

    const beforeCleanup = records.length;
    records = records.filter((r) => !releaseBlockedMinor(r));
    const releasedThisYear = beforeCleanup - records.length;

    const entrants = generateEntrants({
      seed: current.seed,
      year: y,
      size: current.annualEntrants,
      classStrength: current.classStrength,
      organizationIds: current.organizationIds
    });
    records = [...records, ...entrants.records];
    const next = {
      ...current,
      year: y,
      records,
      classStrength: entrants.classStrength,
      generatedCount: current.generatedCount + entrants.records.length,
      retiredCount: current.retiredCount + retiredIds.size,
      releasedCount: current.releasedCount + releasedThisYear,
      debutAges
    };
    current = freeze({ ...next, snapshot: snapshotGeneratedLeague(next, { year: y }) });
  }
  return current;
}

export {
  GENERATED_LEAGUE_LIFECYCLE_VERSION,
  LEVELS,
  releaseBlockedMinor,
  snapshotGeneratedLeague,
  createGeneratedLeagueLifecycle,
  advanceGeneratedLeagueLifecycle
};
