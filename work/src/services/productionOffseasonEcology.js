import { generateAmateurClass } from "../engine/career/generatedTalent.js";
import { currentOvr } from "../engine/career/generatedCareerPathway.js";
import { evaluateAiRetirements } from "../engine/career/retirementSystem.js";
import { createPositionPlayerSeasonState, getSeasonDevelopedPlayer } from "../engine/season/playerSeasonState.js";
import { createPitcherSeasonState, getSeasonDevelopedPitcher } from "../engine/season/pitcherSeasonState.js";
import { consumeAmateurReserveForDeficits } from "../engine/career/amateurAcquisition.js";

const PRODUCTION_ECOLOGY_VERSION = 1;
const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const LINEUP_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function finite(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function isPitcher(player) { return player?.positioning == null; }
function roleKey(player) { return isPitcher(player) ? "P" : "H"; }
function playerName(player, fallback = null) { return player?.fullName ?? fallback ?? String(player?.id ?? "Unknown"); }
function levelIndex(level) { const i = LEVELS.indexOf(level); return i < 0 ? LEVELS.length - 1 : i; }

function organizationForTeam(dataUniverse, level, teamId) {
  const id = String(teamId);
  if (level === "MLB") return id;
  const row = dataUniverse?.data?.affiliations?.find((item) => item.level === level && String(item.teamId) === id);
  return row ? String(row.organizationId) : null;
}

function teamForOrganization(dataUniverse, level, organizationId) {
  const org = String(organizationId);
  if (level === "MLB") return org;
  const row = dataUniverse?.data?.affiliations?.find((item) => item.level === level && String(item.organizationId) === org);
  return row ? String(row.teamId) : null;
}

function developedPlayer(player, playerStates, pitcherStates) {
  const id = String(player.id);
  if (isPitcher(player)) {
    const state = pitcherStates?.[id] ?? null;
    const developed = state ? getSeasonDevelopedPitcher(player, state) : player;
    return { ...developed, physical: { ...(developed.physical ?? player.physical ?? {}), age: Math.round(finite(state?.health?.age, player?.physical?.age ?? 27)) } };
  }
  const state = playerStates?.[id] ?? null;
  const developed = state ? getSeasonDevelopedPlayer(player, state) : player;
  return { ...developed, physical: { ...(developed.physical ?? player.physical ?? {}), age: Math.round(finite(state?.health?.age, player?.physical?.age ?? 27)) } };
}

function collectActivePlayers(fixture, dataUniverse, playerStates, pitcherStates) {
  const rows = [];
  const seen = new Set();
  for (const level of LEVELS) {
    const league = fixture?.levelLeagues?.[level];
    if (!league) continue;
    for (const [teamId, roster] of Object.entries(league.rosters ?? {})) {
      const organizationId = organizationForTeam(dataUniverse, level, teamId);
      if (!organizationId) throw new RangeError(`production ecology 조직을 찾을 수 없습니다: ${level}:${teamId}`);
      for (const [id, player] of Object.entries(roster.players ?? {})) {
        if (seen.has(id)) throw new RangeError(`production ecology active roster 중복 선수: ${id}`);
        seen.add(id);
        const developed = developedPlayer(player, playerStates, pitcherStates);
        rows.push({
          id,
          player,
          developed,
          ovr: currentOvr(developed),
          level,
          teamId: String(teamId),
          organizationId,
          role: roleKey(player),
          name: roster.names?.[id] ?? playerName(player),
          generated: player?.generated === true
        });
      }
    }
  }
  return rows;
}

function targetRoleCounts(rows) {
  const targets = new Map();
  for (const row of rows) {
    const key = `${row.organizationId}|${row.role}|${row.level}`;
    targets.set(key, (targets.get(key) ?? 0) + 1);
  }
  return targets;
}

function createProductionEcologyState({ fixture } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") return null;
  const year = Number(String(fixture.startDate ?? "").slice(0, 4));
  if (!Number.isInteger(year)) throw new RangeError("production ecology 시작 연도를 확인할 수 없습니다.");
  return freeze({
    version: PRODUCTION_ECOLOGY_VERSION,
    year,
    classStrength: 0,
    totalRetired: 0,
    totalGenerated: 0,
    lastOffseason: null,
    history: []
  });
}

function normalizeProductionEcologyState(state, { fixture } = {}) {
  const fallback = createProductionEcologyState({ fixture });
  if (!fallback) return null;
  if (!state || typeof state !== "object") return fallback;
  return freeze({
    version: PRODUCTION_ECOLOGY_VERSION,
    year: Number.isInteger(state.year) ? state.year : fallback.year,
    classStrength: finite(state.classStrength, 0),
    totalRetired: Math.max(0, Math.round(finite(state.totalRetired, 0))),
    totalGenerated: Math.max(0, Math.round(finite(state.totalGenerated, 0))),
    lastOffseason: state.lastOffseason ?? null,
    history: Array.isArray(state.history) ? state.history.slice(-24) : []
  });
}

function generateReplacementPool({ seed, year, pitcherNeeded, hitterNeeded, previousClassStrength }) {
  const totalNeeded = pitcherNeeded + hitterNeeded;
  if (!totalNeeded) return { selected: [], classStrength: previousClassStrength };
  let factor = 1.28;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const total = Math.max(totalNeeded + 12, Math.ceil(totalNeeded * factor));
    const draftN = Math.round(total * 0.64);
    const internationalN = Math.round(total * 0.31);
    const undraftedN = Math.max(0, total - draftN - internationalN);
    let offset = 0;
    const draft = generateAmateurClass({ seed, year, size: draftN, previousClassStrength, entryPath: "DRAFT", idOffset: offset }); offset += draftN;
    const intl = generateAmateurClass({ seed, year, size: internationalN, previousClassStrength: draft.classStrength, entryPath: "INTERNATIONAL", idOffset: offset }); offset += internationalN;
    const undrafted = generateAmateurClass({ seed, year, size: undraftedN, previousClassStrength: (draft.classStrength + intl.classStrength) / 2, entryPath: "UNDRAFTED", idOffset: offset });
    const all = [...draft.players, ...intl.players, ...undrafted.players];
    const pitchers = all.filter(isPitcher).slice(0, pitcherNeeded);
    const hitters = all.filter((p) => !isPitcher(p)).slice(0, hitterNeeded);
    if (pitchers.length === pitcherNeeded && hitters.length === hitterNeeded) {
      const selected = [...pitchers, ...hitters];
      const selectedStrength = selected.length ? selected.reduce((sum, p) => sum + finite(p.generatedProfile?.talentZ, 0), 0) / selected.length : previousClassStrength;
      return { selected, classStrength: Number(selectedStrength.toFixed(4)) };
    }
    factor *= 1.35;
  }
  throw new RangeError(`replacement class role mix를 충족하지 못했습니다: P${pitcherNeeded}/H${hitterNeeded}`);
}

function assignEntrantsToOrganizationDeficits(players, deficits) {
  const remaining = new Map(deficits);
  const assignments = [];
  for (const player of [...players].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const role = roleKey(player);
    const choices = [...remaining.entries()]
      .filter(([key, count]) => count > 0 && key.endsWith(`|${role}`))
      .map(([key, count]) => ({ key, count, organizationId: key.split("|")[0] }))
      .sort((a, b) => b.count - a.count || a.organizationId.localeCompare(b.organizationId));
    const choice = choices[0];
    if (!choice) throw new RangeError(`replacement entrant 조직 deficit이 없습니다: ${player.id}:${role}`);
    remaining.set(choice.key, choice.count - 1);
    assignments.push({ player, organizationId: choice.organizationId, role });
  }
  if ([...remaining.values()].some((count) => count !== 0)) throw new RangeError("replacement entrant 조직 배정 후 deficit이 남았습니다.");
  return assignments;
}

function allocationScore(row, targetLevel) {
  const distance = Math.abs(levelIndex(row.level) - levelIndex(targetLevel));
  const continuity = row.level === targetLevel ? 3.0 : distance === 1 ? 0.9 : 0;
  const age = finite(row.developed?.physical?.age ?? row.player?.physical?.age, 24);
  const maturity = targetLevel === "MLB" ? Math.min(1.3, Math.max(-1.3, (age - 23) * 0.18)) : 0;
  const prospectPenalty = row.newEntrant && targetLevel === "MLB" ? 8 : row.newEntrant && targetLevel === "AAA" ? 4 : 0;
  return row.ovr + continuity + maturity - prospectPenalty;
}

function allocateOrganizationRole(rows, targetByLevel, { userPlayerId = null } = {}) {
  const assignments = new Map();
  const pool = [...rows];
  const locked = pool.find((row) => String(row.id) === String(userPlayerId ?? "")) ?? null;
  if (locked) assignments.set(locked.id, locked.level);
  const available = pool.filter((row) => row !== locked);
  for (const level of LEVELS) {
    let count = targetByLevel[level] ?? 0;
    if (locked?.level === level) count -= 1;
    if (count < 0) throw new RangeError(`locked user가 ${level} target을 초과했습니다.`);
    available.sort((a, b) => allocationScore(b, level) - allocationScore(a, level) || b.ovr - a.ovr || String(a.id).localeCompare(String(b.id)));
    const selected = available.splice(0, count);
    if (selected.length !== count) throw new RangeError(`production ecology ${level} 배정 인원이 부족합니다: ${selected.length}/${count}`);
    for (const row of selected) assignments.set(row.id, level);
  }
  if (available.length) throw new RangeError(`production ecology 배정되지 않은 선수가 남았습니다: ${available.length}`);
  return assignments;
}

function positionFit(player, slot) {
  const p = String(player?.positioning?.primaryPosition ?? "DH").toUpperCase();
  if (slot === "DH") return 1;
  if (p === slot) return 5;
  if (["LF", "CF", "RF"].includes(slot) && ["LF", "CF", "RF"].includes(p)) return 3;
  if (["2B", "3B", "SS"].includes(slot) && ["2B", "3B", "SS"].includes(p)) return 2;
  if (slot === "1B" && ["1B", "3B"].includes(p)) return 2;
  return 0;
}

function benchCoverage(player) {
  const p = String(player?.positioning?.primaryPosition ?? "DH").toUpperCase();
  if (p === "C") return ["C"];
  if (["2B", "3B", "SS"].includes(p)) return [p, ...["2B", "3B", "SS"].filter((x) => x !== p)];
  if (["LF", "CF", "RF"].includes(p)) return [p, ...["LF", "CF", "RF"].filter((x) => x !== p)];
  if (p === "1B") return ["1B", "DH", "LF", "RF"];
  return ["DH", "1B", "LF", "RF"];
}

function rebuildRoster(priorRoster, rows, { userPlayerId = null } = {}) {
  const hitters = rows.filter((row) => row.role === "H");
  const pitchers = rows.filter((row) => row.role === "P");
  if (hitters.length < 9 || pitchers.length < 8) throw new RangeError(`${priorRoster.team?.name ?? priorRoster.team?.id} ecology roster coverage 부족: H${hitters.length}/P${pitchers.length}`);
  const remaining = [...hitters];
  const slots = [];
  for (const position of LINEUP_POSITIONS) {
    remaining.sort((a, b) => positionFit(b.player, position) - positionFit(a.player, position) || b.ovr - a.ovr || String(a.id).localeCompare(String(b.id)));
    let selectedIndex = 0;
    if (userPlayerId && position !== "DH") {
      const userIndex = remaining.findIndex((row) => String(row.id) === String(userPlayerId) && String(row.player?.positioning?.primaryPosition ?? "") === position);
      if (userIndex >= 0) selectedIndex = userIndex;
    }
    const selected = remaining.splice(selectedIndex, 1)[0];
    slots.push({ position, row: selected });
  }
  if (userPlayerId && !slots.some((slot) => String(slot.row.id) === String(userPlayerId))) {
    const userIndex = remaining.findIndex((row) => String(row.id) === String(userPlayerId));
    if (userIndex >= 0) {
      const user = remaining.splice(userIndex, 1)[0];
      const dhIndex = slots.findIndex((slot) => slot.position === "DH");
      remaining.push(slots[dhIndex].row);
      slots[dhIndex] = { position: "DH", row: user };
    }
  }
  const lineupSlots = slots.map(({ position, row }) => ({ position, starterId: String(row.id) }));
  const lineup = lineupSlots.map((slot) => slot.starterId);
  const defense = Object.fromEntries(LINEUP_POSITIONS.filter((p) => p !== "DH").map((position) => [position, lineupSlots.find((slot) => slot.position === position).starterId]));
  const bench = remaining.map((row) => ({ playerId: String(row.id), coverage: benchCoverage(row.player) }));
  const rankedPitchers = [...pitchers].sort((a, b) => b.ovr - a.ovr || String(a.id).localeCompare(String(b.id)));
  const preferredStarters = rankedPitchers.filter((row) => String(row.player?.pitching?.role ?? "RP") === "SP");
  const starters = [...preferredStarters, ...rankedPitchers.filter((row) => !preferredStarters.includes(row))].slice(0, 5).map((row) => String(row.id));
  const starterSet = new Set(starters);
  const bullpen = rankedPitchers.filter((row) => !starterSet.has(String(row.id))).map((row) => String(row.id));
  const players = Object.fromEntries(rows.map((row) => [String(row.id), row.player]));
  const names = Object.fromEntries(rows.map((row) => [String(row.id), row.name]));
  return freeze({
    ...priorRoster,
    players,
    names,
    lineup,
    lineupSlots,
    defense,
    bench,
    positionPlayers: hitters.map((row) => String(row.id)),
    pitchers: pitchers.map((row) => String(row.id)),
    starters,
    bullpen
  });
}

function advanceProductionOffseasonEcology({ fixture, dataUniverse, playerStates = {}, pitcherStates = {}, ecologyState = null, amateurAcquisitionState = null, year, userPlayerId = fixture?.userPlayerId } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("production offseason ecology는 Production 월드 전용입니다.");
  if (!Number.isInteger(year)) throw new TypeError("production offseason ecology year가 필요합니다.");
  const state = normalizeProductionEcologyState(ecologyState, { fixture });
  const rows = collectActivePlayers(fixture, dataUniverse, playerStates, pitcherStates);
  const targetCounts = targetRoleCounts(rows);
  const contextById = new Map(rows.map((row) => [row.id, {
    playingTimeOpportunity: row.level === "MLB" ? 0.58 : row.level === "AAA" ? 0.34 : 0.22,
    role: row.level === "MLB" ? "MLB_REGULAR" : "MINORS",
    durability: row.developed?.physical?.durability ?? row.player?.physical?.durability ?? 50
  }]));
  const retirementPlayers = rows.map((row) => ({ ...row.developed, id: row.id, ovr: row.ovr }));
  const retirement = evaluateAiRetirements(retirementPlayers, { seed: fixture.seed ?? "", seasonKey: String(year), userPlayerId, contextById });
  const retiredIds = new Set(retirement.retiredIds);
  const survivors = rows.filter((row) => !retiredIds.has(row.id));

  const deficits = new Map();
  let pitcherNeeded = 0, hitterNeeded = 0;
  for (const row of rows.filter((row) => retiredIds.has(row.id))) {
    const key = `${row.organizationId}|${row.role}`;
    deficits.set(key, (deficits.get(key) ?? 0) + 1);
    if (row.role === "P") pitcherNeeded += 1; else hitterNeeded += 1;
  }

  const amateur = consumeAmateurReserveForDeficits(amateurAcquisitionState, {
    deficits,
    year,
    seed: `${fixture.seed}:live-ecology`
  });
  const entrantAssignments = amateur.assignments;
  const replacement = {
    classStrength: finite(amateur.state?.current?.draft?.descriptor?.classStrength, state.classStrength)
  };
  const nextPlayerStates = Object.fromEntries(Object.entries(playerStates).filter(([id]) => !retiredIds.has(id)));
  const nextPitcherStates = Object.fromEntries(Object.entries(pitcherStates).filter(([id]) => !retiredIds.has(id)));
  const entrants = entrantAssignments.map(({ player, organizationId, role }) => {
    const profile = { seed: fixture.seed ?? "", startingProfile: player.generatedProfile };
    if (role === "P") nextPitcherStates[player.id] = createPitcherSeasonState(player, profile);
    else nextPlayerStates[player.id] = createPositionPlayerSeasonState(player, player.positioning, profile);
    const developed = developedPlayer(player, nextPlayerStates, nextPitcherStates);
    return {
      id: String(player.id), player, developed, ovr: currentOvr(developed), level: "A", teamId: null,
      organizationId, role, name: playerName(player), generated: true, newEntrant: true
    };
  });
  const active = [...survivors, ...entrants];
  if (active.length !== rows.length) throw new RangeError(`production ecology population drift: ${rows.length} -> ${active.length}`);

  const assignments = new Map();
  const organizationIds = [...new Set(rows.map((row) => row.organizationId))].sort();
  for (const organizationId of organizationIds) {
    for (const role of ["H", "P"]) {
      const orgRows = active.filter((row) => row.organizationId === organizationId && row.role === role);
      const targetByLevel = Object.fromEntries(LEVELS.map((level) => [level, targetCounts.get(`${organizationId}|${role}|${level}`) ?? 0]));
      const allocated = allocateOrganizationRole(orgRows, targetByLevel, { userPlayerId });
      for (const [id, level] of allocated) assignments.set(id, level);
    }
  }

  const assignedRows = active.map((row) => {
    const level = assignments.get(row.id);
    if (!level) throw new RangeError(`production ecology level assignment 누락: ${row.id}`);
    const teamId = teamForOrganization(dataUniverse, level, row.organizationId);
    if (!teamId) throw new RangeError(`production ecology affiliate 누락: ${row.organizationId}:${level}`);
    const priorCareer = row.player?.generatedCareer ?? null;
    const mlbDebutYear = priorCareer?.mlbDebutYear ?? (row.generated && level === "MLB" ? year : null);
    const player = row.generated ? freeze({
      ...row.player,
      generatedCareer: {
        ...(priorCareer ?? {}),
        firstEntryYear: priorCareer?.firstEntryYear ?? (row.newEntrant ? year : null),
        mlbDebutYear,
        currentOrganizationId: row.organizationId,
        currentLevel: level,
        lastRosterYear: year
      }
    }) : row.player;
    return { ...row, player, level, teamId };
  });

  const levelLeagues = {};
  for (const level of LEVELS) {
    const league = fixture.levelLeagues[level];
    const rosters = {};
    for (const [teamId, priorRoster] of Object.entries(league.rosters ?? {})) {
      const teamRows = assignedRows.filter((row) => row.level === level && row.teamId === String(teamId));
      rosters[teamId] = rebuildRoster(priorRoster, teamRows, { userPlayerId: String(teamId) === String(league.userTeamId) ? userPlayerId : null });
    }
    levelLeagues[level] = freeze({ ...league, rosters: freeze(rosters) });
  }

  const organizationLevels = Object.fromEntries((fixture.organization?.levelOrder ?? LEVELS).map((level) => {
    const teamId = String(fixture.organization.levels[level].team.id);
    return [level, freeze({ ...fixture.organization.levels[level], roster: levelLeagues[level].rosters[teamId] })];
  }));
  const aaa = levelLeagues.AAA;
  const nextFixture = freeze({
    ...fixture,
    teams: aaa.teams,
    rosters: aaa.rosters,
    schedule: aaa.schedule,
    levelLeagues: freeze(levelLeagues),
    organization: freeze({ ...fixture.organization, levels: freeze(organizationLevels) })
  });

  const retired = rows.filter((row) => retiredIds.has(row.id));
  const generatedIds = new Set(assignedRows.filter((row) => row.generated).map((row) => row.id));
  const lastOffseason = freeze({
    year,
    populationBefore: rows.length,
    populationAfter: assignedRows.length,
    retired: retired.length,
    generated: entrants.length,
    retiredPitchers: retired.filter((row) => row.role === "P").length,
    retiredHitters: retired.filter((row) => row.role === "H").length,
    generatedPitchers: entrants.filter((row) => row.role === "P").length,
    generatedHitters: entrants.filter((row) => row.role === "H").length,
    activatedFromAmateurReserve: amateur.summary.fromReserve,
    undraftedFallback: amateur.summary.fallback,
    amateurReserveRemaining: amateur.summary.reserveRemaining,
    activeGenerated: generatedIds.size,
    retiredIds: [...retiredIds].sort(),
    entrantIds: entrants.map((row) => row.id).sort()
  });
  const nextEcologyState = freeze({
    version: PRODUCTION_ECOLOGY_VERSION,
    year,
    classStrength: replacement.classStrength,
    totalRetired: state.totalRetired + retired.length,
    totalGenerated: state.totalGenerated + entrants.length,
    lastOffseason,
    history: [...state.history, lastOffseason].slice(-24)
  });

  return freeze({
    fixture: nextFixture,
    playerStates: nextPlayerStates,
    pitcherStates: nextPitcherStates,
    ecologyState: nextEcologyState,
    amateurAcquisitionState: amateur.state,
    summary: lastOffseason
  });
}

export {
  PRODUCTION_ECOLOGY_VERSION,
  createProductionEcologyState,
  normalizeProductionEcologyState,
  advanceProductionOffseasonEcology
};
