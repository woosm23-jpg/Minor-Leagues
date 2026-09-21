import { evaluateAiRetirements } from "./retirementSystem.js";
import { generateAmateurClass } from "./generatedTalent.js";

const LEAGUE_ECOLOGY_VERSION = 1;
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function ageOf(p) { return Math.round(Number(p?.physical?.age ?? p?.age ?? 27)); }
function ovrOf(p) { return Number(p?.ovr ?? p?.overall ?? 50); }

function planAnnualAmateurSupply({ population, targetPopulation, retiredCount = 0, releasedCount = 0, reserveTarget = 0 } = {}) {
  const pop = Math.max(0, Math.round(Number(population) || 0));
  const target = Math.max(0, Math.round(Number(targetPopulation) || 0));
  const openings = Math.max(0, target + Math.max(0, Math.round(reserveTarget)) - pop + Math.max(0, Math.round(retiredCount)) + Math.max(0, Math.round(releasedCount)));
  const total = openings;
  const draft = Math.round(total * 0.64);
  const international = Math.round(total * 0.31);
  const undrafted = Math.max(0, total - draft - international);
  return freeze({ total, draft, international, undrafted });
}

function cleanupCandidates(players, { targetPopulation, protectedIds = new Set(), annualCleanupCount = 0 } = {}) {
  const excess = Math.max(0, players.length - targetPopulation);
  const lowUpside = players.filter((p) => ageOf(p) >= 27 && ovrOf(p) < 47 && !protectedIds.has(String(p.id))).length;
  const count = Math.min(players.length, Math.max(excess, Math.min(lowUpside, Math.max(0, Math.round(annualCleanupCount)))));
  if (!count) return [];
  return [...players]
    .filter((p) => !protectedIds.has(String(p.id)))
    .sort((a, b) => {
      const aa = ageOf(a), ba = ageOf(b), ao = ovrOf(a), bo = ovrOf(b);
      const as = ao - Math.max(0, aa - 25) * 1.8;
      const bs = bo - Math.max(0, ba - 25) * 1.8;
      return as - bs || ba - aa || String(a.id).localeCompare(String(b.id));
    })
    .slice(0, count)
    .map((p) => String(p.id));
}

function nextAnnualEcology({ players, year, seed, targetPopulation, previousClassStrength = 0, userPlayerId = null, marketById = new Map(), contextById = new Map() } = {}) {
  if (!Array.isArray(players)) throw new TypeError("ecology players 배열이 필요합니다.");
  if (!Number.isInteger(year)) throw new TypeError("ecology year가 필요합니다.");
  const target = Math.max(1, Math.round(Number(targetPopulation ?? players.length)));
  const aged = players.map((p) => ({ ...p, physical: { ...(p.physical ?? {}), age: clamp(ageOf(p) + 1, 16, 55) } }));
  const retire = evaluateAiRetirements(aged, { seed, seasonKey: String(year), userPlayerId, marketById, contextById });
  const retiredSet = new Set(retire.retiredIds);
  let survivors = aged.filter((p) => !retiredSet.has(String(p.id)));
  const cleanupIds = cleanupCandidates(survivors, {
    targetPopulation: target,
    protectedIds: new Set(userPlayerId ? [String(userPlayerId)] : []),
    // Annual organizational cleanup keeps low-upside older depth from blocking
    // amateur talent even in seasons with unusually few formal retirements.
    annualCleanupCount: Math.round(target * 0.025)
  });
  const cleanupSet = new Set(cleanupIds);
  survivors = survivors.filter((p) => !cleanupSet.has(String(p.id)));
  const supply = planAnnualAmateurSupply({ population: survivors.length, targetPopulation: target });
  let serial = 0;
  const draft = generateAmateurClass({ seed, year, size: supply.draft, previousClassStrength, entryPath: "DRAFT", idOffset: serial }); serial += supply.draft;
  const international = generateAmateurClass({ seed, year, size: supply.international, previousClassStrength: draft.classStrength, entryPath: "INTERNATIONAL", idOffset: serial }); serial += supply.international;
  const undrafted = generateAmateurClass({ seed, year, size: supply.undrafted, previousClassStrength: (draft.classStrength + international.classStrength) / 2, entryPath: "UNDRAFTED", idOffset: serial });
  const entrants = [...draft.players, ...international.players, ...undrafted.players];
  const nextPlayers = [...survivors, ...entrants];
  const combinedStrength = entrants.length
    ? Number(((draft.classStrength * draft.players.length + international.classStrength * international.players.length + undrafted.classStrength * undrafted.players.length) / entrants.length).toFixed(4))
    : 0;
  return freeze({
    version: LEAGUE_ECOLOGY_VERSION,
    year,
    players: nextPlayers,
    retiredIds: retire.retiredIds,
    releasedIds: cleanupIds,
    entrants,
    supply,
    classStrength: combinedStrength,
    populationBefore: players.length,
    populationAfter: nextPlayers.length
  });
}

export { LEAGUE_ECOLOGY_VERSION, planAnnualAmateurSupply, cleanupCandidates, nextAnnualEcology };
