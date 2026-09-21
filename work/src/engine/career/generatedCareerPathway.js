import { SeededRng } from "../rng.js";
import {
  createPositionPlayerSeasonState,
  applyPositionPlayerGame,
  applyAnnualPositionPlayerDevelopment,
  getSeasonDevelopedPlayer
} from "../season/playerSeasonState.js";
import {
  createPitcherSeasonState,
  applyPitcherSeasonGame,
  applyAnnualPitcherSeasonDevelopment,
  getSeasonDevelopedPitcher
} from "../season/pitcherSeasonState.js";
import { applyAnnualPositionPlayerAging, applyAnnualPitcherAging } from "../season/agingState.js";

const GENERATED_PATHWAY_VERSION = 3;
const LEVELS = Object.freeze(["A", "HIGH_A", "AA", "AAA", "MLB"]);
const PROMOTION_TARGET = Object.freeze({ A: "HIGH_A", HIGH_A: "AA", AA: "AAA", AAA: "MLB", MLB: null });
const PROMOTION_ABILITY = Object.freeze({ A: 33, HIGH_A: 36, AA: 40.5, AAA: 45.5 });

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function finite(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function isPitcher(player) { return player?.positioning == null; }
function ageOfRecord(record) { return Math.round(finite(record?.state?.health?.age, record?.player?.physical?.age ?? 20)); }

function currentHitterOvr(player) {
  const h = player?.hitting ?? {}, t = player?.tendencies ?? {}, f = player?.fielding ?? {}, r = player?.running ?? {};
  const contact = Math.max(finite(h.contactR, 50), finite(h.contactL, 50));
  const power = Math.max(finite(t.powerUtilizationR, h.rawPower ?? 50), finite(t.powerUtilizationL, h.rawPower ?? 50));
  const defense = Math.max(finite(f.fielding, 50), finite(f.reaction, 50));
  return Number((contact * 0.22 + power * 0.24 + finite(h.vision, 50) * 0.13 + finite(h.discipline, 50) * 0.13 + defense * 0.14 + finite(r.speed, 50) * 0.14).toFixed(2));
}

function currentPitcherOvr(player) {
  const p = player?.pitching ?? {};
  return Number((finite(player?.derived?.stuff, 50) * 0.24 + finite(p.movement, 50) * 0.17 + finite(p.control, 50) * 0.18 + finite(p.command, 50) * 0.16 + finite(p.pitchability, 50) * 0.15 + finite(p.stamina, 50) * 0.10).toFixed(2));
}

function currentOvr(player) { return isPitcher(player) ? currentPitcherOvr(player) : currentHitterOvr(player); }

function initialLevelForGeneratedPlayer(player) {
  if (!player?.generatedProfile) throw new TypeError("generatedProfile이 있는 선수가 필요합니다.");
  const background = player.generatedProfile.background;
  const ovr = currentOvr(player);
  if (background === "INTERNATIONAL") return ovr >= 43 && player.physical.age >= 19 ? "HIGH_A" : "A";
  if (background === "HIGH_SCHOOL") return ovr >= 42 ? "HIGH_A" : "A";
  if (background === "JUCO") return ovr >= 45 ? "AA" : ovr >= 38 ? "HIGH_A" : "A";
  // College players are more polished but still begin in the minors.
  return ovr >= 45 ? "AA" : ovr >= 37 ? "HIGH_A" : "A";
}

function organizationLoad(records, orgId) {
  let total = 0;
  const positions = new Map();
  for (const r of records) {
    if (r.organizationId !== orgId) continue;
    total += 1;
    const key = isPitcher(r.player) ? (r.player.pitching?.role ?? "RP") : (r.player.positioning?.primaryPosition ?? "DH");
    positions.set(key, (positions.get(key) ?? 0) + 1);
  }
  return { total, positions };
}

function chooseOrganization(player, organizationIds, assigned, rng) {
  const role = isPitcher(player) ? (player.pitching?.role ?? "RP") : (player.positioning?.primaryPosition ?? "DH");
  const ranked = organizationIds.map((id) => {
    const load = organizationLoad(assigned, id);
    const roleLoad = load.positions.get(role) ?? 0;
    return { id, score: load.total * 1.0 + roleLoad * 0.55 + rng.next() * 0.12 };
  }).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return ranked[0].id;
}

function createPathwayRecord(player, { organizationId, year, seed }) {
  const level = initialLevelForGeneratedPlayer(player);
  const profile = { seed, startingProfile: player.generatedProfile };
  const state = isPitcher(player)
    ? createPitcherSeasonState(player, profile)
    : createPositionPlayerSeasonState(player, player.positioning, profile);
  return freeze({
    version: GENERATED_PATHWAY_VERSION,
    player,
    state,
    organizationId,
    level,
    entryYear: year,
    seasons: 0,
    seasonsAtLevel: 0,
    mlbDebutYear: null,
    history: [{ year, type: "SIGNED", organizationId, level }]
  });
}

function assignGeneratedEntrants(players, { seed, year, organizationIds } = {}) {
  if (!Array.isArray(players)) throw new TypeError("players 배열이 필요합니다.");
  if (typeof seed !== "string" || !seed) throw new TypeError("seed가 필요합니다.");
  if (!Number.isInteger(year)) throw new TypeError("year가 필요합니다.");
  if (!Array.isArray(organizationIds) || organizationIds.length === 0) throw new TypeError("organizationIds가 필요합니다.");
  const orgs = [...new Set(organizationIds.map(String))].sort();
  const rng = new SeededRng(`generated-pathway-v${GENERATED_PATHWAY_VERSION}:${seed}:${year}`);
  const assigned = [];
  for (const player of [...players].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const organizationId = chooseOrganization(player, orgs, assigned, rng);
    assigned.push(createPathwayRecord(player, { organizationId, year, seed }));
  }
  return freeze(assigned);
}

function hitterLine(developed, level, rng) {
  const ovr = currentHitterOvr(developed);
  const levelBase = ({ A: 31, HIGH_A: 35, AA: 39, AAA: 44, MLB: 50 })[level] ?? 44;
  const edge = clamp((ovr - levelBase) / 22, -0.42, 0.42);
  const PA = 6;
  const avg = clamp(0.235 + edge * 0.12 + (rng.next() - 0.5) * 0.025, 0.145, 0.365);
  const bbRate = clamp(0.075 + (finite(developed.hitting?.discipline, 50) - 50) * 0.0012, 0.035, 0.145);
  const kRate = clamp(0.235 - (finite(developed.hitting?.vision, 50) - 50) * 0.0015, 0.105, 0.37);
  const H = Math.round(PA * avg);
  const BB = Math.min(PA - H, Math.round(PA * bbRate));
  const SO = Math.min(PA - H - BB, Math.round(PA * kRate));
  const power = Math.max(finite(developed.tendencies?.powerUtilizationR, 50), finite(developed.tendencies?.powerUtilizationL, 50));
  const HR = Math.min(H, power >= 58 && rng.next() < 0.28 ? 1 : 0);
  const doubles = Math.min(H - HR, power >= 48 && rng.next() < 0.32 ? 1 : 0);
  const triples = Math.min(H - HR - doubles, finite(developed.running?.speed, 50) >= 65 && rng.next() < 0.08 ? 1 : 0);
  const SB = finite(developed.running?.speed, 50) >= 60 && rng.next() < 0.22 ? 1 : 0;
  return { PA, H, doubles, triples, HR, BB, HBP: 0, SO, SB };
}

function pitcherLine(developed, level, rng) {
  const role = developed.pitching?.role ?? "RP";
  const BF = role === "SP" ? 22 : 6;
  const stuff = finite(developed.derived?.stuff, 50), control = finite(developed.pitching?.control, 50), movement = finite(developed.pitching?.movement, 50);
  const levelBase = ({ A: 31, HIGH_A: 35, AA: 39, AAA: 44, MLB: 50 })[level] ?? 44;
  const ovr = currentPitcherOvr(developed), edge = clamp((ovr - levelBase) / 22, -0.42, 0.42);
  const kRate = clamp(0.205 + (stuff - 50) * 0.0021 + edge * 0.06, 0.10, 0.39);
  const bbRate = clamp(0.09 - (control - 50) * 0.0012 - edge * 0.018, 0.035, 0.17);
  const hrRate = clamp(0.031 - (movement - 50) * 0.00045 - edge * 0.008, 0.008, 0.075);
  const SO = Math.round(BF * kRate);
  const BB = Math.round(BF * bbRate);
  const HR = rng.next() < clamp(BF * hrRate, 0, 0.85) ? 1 : 0;
  const H = Math.max(HR, Math.round(BF * clamp(0.235 - edge * 0.045, 0.16, 0.32)));
  const pitches = role === "SP" ? 86 : 24;
  return { BF, SO, BB, H, HR, HBP: 0, Pitches: pitches };
}

function averageLines(lines) {
  if (!lines.length) return {};
  const keys = new Set(lines.flatMap((line) => Object.keys(line)));
  return Object.fromEntries([...keys].map((key) => [key, lines.reduce((sum, line) => sum + finite(line[key], 0), 0) / lines.length]));
}

function simulateSeasonRepsFast(record, { year, seed }) {
  let state = record.state;
  const rng = new SeededRng(`generated-pathway-fast-season-v${GENERATED_PATHWAY_VERSION}:${seed}:${year}:${record.player.id}`);
  const pitcher = isPitcher(record.player);
  if (pitcher) {
    const role = record.player.pitching?.role ?? "RP";
    const chunkWeights = role === "SP" ? [5, 5, 5, 5, 5, 5] : [8, 8, 7, 7, 7, 7];
    for (const weight of chunkWeights) {
      const developed = getSeasonDevelopedPitcher(record.player, state);
      const lines = Array.from({ length: weight }, () => pitcherLine(developed, record.level, rng));
      const line = averageLines(lines);
      state = applyPitcherSeasonGame(state, record.player, {
        pitchCount: finite(line.Pitches, role === "SP" ? 86 : 24),
        pitchingLine: line,
        date: `${year}-07-01`,
        level: record.level,
        developmentMultiplier: weight
      });
      state = { ...state, fatigue: 0 };
    }
    const dev = applyAnnualPitcherSeasonDevelopment(state, record.player, { seasonKey: String(year) });
    state = dev.state;
    state = applyAnnualPitcherAging(state, record.player, { seasonKey: String(year) }).state;
    return freeze(state);
  }
  for (let chunk = 0; chunk < 6; chunk += 1) {
    const developed = getSeasonDevelopedPlayer(record.player, state);
    const lines = Array.from({ length: 12 }, () => hitterLine(developed, record.level, rng));
    const line = averageLines(lines);
    state = applyPositionPlayerGame(state, record.player, {
      battingLine: line,
      position: state.primaryPosition ?? record.player.positioning?.primaryPosition ?? "DH",
      date: `${year}-07-01`,
      appearanceType: "START",
      level: record.level,
      developmentMultiplier: 12
    });
    state = { ...state, fatigue: 0 };
  }
  const dev = applyAnnualPositionPlayerDevelopment(state, record.player, { seasonKey: String(year) });
  state = dev.state;
  state = applyAnnualPositionPlayerAging(state, record.player, { seasonKey: String(year) }).state;
  return freeze(state);
}

function simulateSeasonReps(record, { year, seed }) {
  let state = record.state;
  const rng = new SeededRng(`generated-pathway-season-v${GENERATED_PATHWAY_VERSION}:${seed}:${year}:${record.player.id}`);
  const pitcher = isPitcher(record.player);
  if (pitcher) {
    const reps = (record.player.pitching?.role ?? "RP") === "SP" ? 30 : 44;
    for (let i = 0; i < reps; i += 1) {
      const developed = getSeasonDevelopedPitcher(record.player, state);
      const line = pitcherLine(developed, record.level, rng);
      state = applyPitcherSeasonGame(state, record.player, { pitchCount: line.Pitches, pitchingLine: line, date: `${year}-07-01`, level: record.level });
      state = { ...state, fatigue: 0 };
    }
    const dev = applyAnnualPitcherSeasonDevelopment(state, record.player, { seasonKey: String(year) });
    state = dev.state;
    state = applyAnnualPitcherAging(state, record.player, { seasonKey: String(year) }).state;
    return freeze(state);
  }
  for (let i = 0; i < 72; i += 1) {
    const developed = getSeasonDevelopedPlayer(record.player, state);
    const line = hitterLine(developed, record.level, rng);
    state = applyPositionPlayerGame(state, record.player, { battingLine: line, position: state.primaryPosition ?? record.player.positioning?.primaryPosition ?? "DH", date: `${year}-07-01`, appearanceType: "START", level: record.level });
    state = { ...state, fatigue: 0 };
  }
  const dev = applyAnnualPositionPlayerDevelopment(state, record.player, { seasonKey: String(year) });
  state = dev.state;
  state = applyAnnualPositionPlayerAging(state, record.player, { seasonKey: String(year) }).state;
  return freeze(state);
}

function developedSnapshot(record, state = record.state) {
  const developed = isPitcher(record.player) ? getSeasonDevelopedPitcher(record.player, state) : getSeasonDevelopedPlayer(record.player, state);
  return freeze({ ...developed, physical: { ...(developed.physical ?? record.player.physical ?? {}), age: Math.round(finite(state?.health?.age, record.player.physical?.age ?? 20)) }, ovr: currentOvr(developed) });
}

function rebalanceGeneratedMlbOpportunity(records, { year, targetShare = 0.197, minMlbOvr = 44, targetPitcherShare = 0.533, pitcherFloorOffset = -2 } = {}) {
  if (!Array.isArray(records)) throw new TypeError("records 배열이 필요합니다.");
  if (!Number.isInteger(year)) throw new TypeError("year가 필요합니다.");
  const share = clamp(finite(targetShare, 0.197), 0.10, 0.35);
  const floor = clamp(finite(minMlbOvr, 44), 35, 60);
  const pitcherShare = clamp(finite(targetPitcherShare, 0.533), 0.40, 0.65);
  const pitcherFloor = clamp(floor + finite(pitcherFloorOffset, -2), 35, 60);
  const byOrg = new Map();
  for (const record of records) {
    const key = String(record.organizationId ?? "");
    const rows = byOrg.get(key) ?? [];
    rows.push(record);
    byOrg.set(key, rows);
  }
  const next = [];
  for (const orgRows of byOrg.values()) {
    const target = Math.max(1, Math.round(orgRows.length * share));
    const eligible = orgRows
      .filter((record) => record.level === "AAA" || record.level === "MLB")
      .map((record) => {
        const ovr = currentOvr(developedSnapshot(record));
        const incumbent = record.level === "MLB";
        const previouslyDebuted = record.mlbDebutYear != null;
        return {
          record,
          ovr,
          pitcher: record.player.positioning == null,
          incumbent,
          previouslyDebuted,
          // Small roster-continuity credit prevents needless annual option churn.
          // It is intentionally much smaller than a full OVR grade so talent still wins.
          selectionScore: ovr + (incumbent ? 1.25 : previouslyDebuted ? 0.45 : 0)
        };
      })
      .sort((a, b) => b.selectionScore - a.selectionScore || b.ovr - a.ovr || String(a.record.player.id).localeCompare(String(b.record.player.id)));
    const targetPitchers = Math.round(target * pitcherShare);
    const targetHitters = Math.max(0, target - targetPitchers);
    const canHoldMlbJob = (row, roleFloor) => {
      // A first-time call-up must clear the MLB readiness floor. Existing / previously
      // debuted players get a small grace band so the roster does not churn merely to
      // hit a target headcount every year.
      if (!row.previouslyDebuted) return row.ovr >= Math.max(roleFloor, PROMOTION_ABILITY.AAA);
      return row.ovr >= roleFloor - 1;
    };
    const selectRole = (pitcher, count, roleFloor) => eligible
      .filter((row) => row.pitcher === pitcher && canHoldMlbJob(row, roleFloor))
      .slice(0, count);
    const selected = [
      ...selectRole(true, targetPitchers, pitcherFloor),
      ...selectRole(false, targetHitters, floor)
    ];
    const selectedIds = new Set(selected.map((row) => String(row.record.player.id)));
    if (selected.length < target) {
      for (const row of eligible) {
        const id = String(row.record.player.id);
        const roleFloor = row.pitcher ? pitcherFloor : floor;
        if (selectedIds.has(id) || !canHoldMlbJob(row, roleFloor)) continue;
        selected.push(row); selectedIds.add(id);
        if (selected.length >= target) break;
      }
    }
    const mlbIds = new Set(selected.map((row) => String(row.record.player.id)));
    for (const record of orgRows) {
      if (record.level !== "AAA" && record.level !== "MLB") { next.push(record); continue; }
      const shouldBeMlb = mlbIds.has(String(record.player.id));
      const level = shouldBeMlb ? "MLB" : "AAA";
      if (level === record.level) { next.push(record); continue; }
      const ovr = currentOvr(developedSnapshot(record));
      const history = [...record.history, {
        year,
        type: shouldBeMlb ? "MLB_ROSTER_PROMOTION" : "MLB_OPTION_DEMOTION",
        fromLevel: record.level,
        toLevel: level,
        organizationId: record.organizationId,
        ovr: Number(ovr.toFixed(2))
      }];
      if (shouldBeMlb && record.mlbDebutYear == null) history.push({ year, type: "MLB_DEBUT_PATHWAY", organizationId: record.organizationId });
      next.push(freeze({
        ...record,
        level,
        seasonsAtLevel: 0,
        mlbDebutYear: record.mlbDebutYear ?? (shouldBeMlb ? year : null),
        history
      }));
    }
  }
  return freeze(next);
}

function promotionReadiness(record, developed) {
  if (record.level === "MLB") return freeze({ promote: false, target: null, score: currentOvr(developed), threshold: null, reason: "ALREADY_MLB" });
  const threshold = PROMOTION_ABILITY[record.level];
  const score = currentOvr(developed);
  const age = ageOfRecord(record);
  const levelAgeBonus = record.level === "A" && age >= 21 ? 1.1 : record.level === "HIGH_A" && age >= 22 ? 0.7 : record.level === "AA" && age >= 23 ? 0.4 : 0;
  const minSeasons = record.level === "AAA" ? 1 : 0;
  const eligible = record.seasonsAtLevel >= minSeasons;
  return freeze({ promote: eligible && score + levelAgeBonus >= threshold, target: PROMOTION_TARGET[record.level], score, threshold, age, levelAgeBonus, eligible });
}

function advanceGeneratedPathwaySeasonFast(record, { year, seed } = {}) {
  if (!record?.player?.id || !record?.state) throw new TypeError("pathway record가 필요합니다.");
  if (!Number.isInteger(year)) throw new TypeError("year가 필요합니다.");
  const state = simulateSeasonRepsFast(record, { year, seed });
  const developed = developedSnapshot(record, state);
  const readiness = promotionReadiness({ ...record, state }, developed);
  const previousLevel = record.level;
  // AAA players do not debut merely by clearing a development threshold. They become
  // MLB-ready here, then rebalanceGeneratedMlbOpportunity() awards a real roster spot.
  const mlbReady = readiness.promote && previousLevel === "AAA" && readiness.target === "MLB";
  const promoted = readiness.promote && !mlbReady;
  const level = promoted ? readiness.target : previousLevel;
  const mlbDebutYear = record.mlbDebutYear;
  const history = [...record.history];
  if (promoted) history.push({ year, type: "PLAYER_PROMOTED", fromLevel: previousLevel, toLevel: level, organizationId: record.organizationId, ovr: Number(readiness.score.toFixed(2)) });
  if (mlbReady && record.lastReview?.mlbReady !== true) history.push({ year, type: "MLB_READY", organizationId: record.organizationId, ovr: Number(readiness.score.toFixed(2)) });
  return freeze({
    ...record,
    state,
    level,
    seasons: record.seasons + 1,
    seasonsAtLevel: promoted ? 0 : record.seasonsAtLevel + 1,
    mlbDebutYear,
    history,
    lastReview: { year, previousLevel, level, promoted, mlbReady, ...readiness, ovr: Number(readiness.score.toFixed(2)) }
  });
}

function advanceGeneratedPathwaySeason(record, { year, seed } = {}) {
  if (!record?.player?.id || !record?.state) throw new TypeError("pathway record가 필요합니다.");
  if (!Number.isInteger(year)) throw new TypeError("year가 필요합니다.");
  const state = simulateSeasonReps(record, { year, seed });
  const developed = developedSnapshot(record, state);
  const readiness = promotionReadiness({ ...record, state }, developed);
  const previousLevel = record.level;
  // AAA players do not debut merely by clearing a development threshold. They become
  // MLB-ready here, then rebalanceGeneratedMlbOpportunity() awards a real roster spot.
  const mlbReady = readiness.promote && previousLevel === "AAA" && readiness.target === "MLB";
  const promoted = readiness.promote && !mlbReady;
  const level = promoted ? readiness.target : previousLevel;
  const mlbDebutYear = record.mlbDebutYear;
  const history = [...record.history];
  if (promoted) history.push({ year, type: "PLAYER_PROMOTED", fromLevel: previousLevel, toLevel: level, organizationId: record.organizationId, ovr: Number(readiness.score.toFixed(2)) });
  if (mlbReady && record.lastReview?.mlbReady !== true) history.push({ year, type: "MLB_READY", organizationId: record.organizationId, ovr: Number(readiness.score.toFixed(2)) });
  return freeze({
    ...record,
    state,
    level,
    seasons: record.seasons + 1,
    seasonsAtLevel: promoted ? 0 : record.seasonsAtLevel + 1,
    mlbDebutYear,
    history,
    lastReview: { year, previousLevel, level, promoted, mlbReady, ...readiness, ovr: Number(readiness.score.toFixed(2)) }
  });
}

function advanceGeneratedCohort(records, { year, seed } = {}) {
  return freeze(records.map((record) => advanceGeneratedPathwaySeason(record, { year, seed })));
}

function advanceGeneratedCohortFast(records, { year, seed } = {}) {
  return freeze(records.map((record) => advanceGeneratedPathwaySeasonFast(record, { year, seed })));
}

export {
  GENERATED_PATHWAY_VERSION,
  LEVELS,
  PROMOTION_ABILITY,
  currentOvr,
  initialLevelForGeneratedPlayer,
  assignGeneratedEntrants,
  developedSnapshot,
  promotionReadiness,
  rebalanceGeneratedMlbOpportunity,
  advanceGeneratedPathwaySeason,
  advanceGeneratedPathwaySeasonFast,
  advanceGeneratedCohort,
  advanceGeneratedCohortFast
};
