import { createPhase1Hitter, createPhase1Pitcher } from "../engine/player/playerFixtures.js";
import { importSnapshotSchedule, generateFutureProductionSchedule } from "../engine/season/schedule.js";
import { validateMasterSnapshot } from "../data/masterSnapshot.js";
import { isPlayerGameAvailable, playerAssignedLevel, playerAssignedTeamId, playerAvailability, playerOrganizationId, playerRosterStatus } from "../data/rosterAvailability.js";
import { inferRealPlayerPotentialProfile } from "../data/realWorldPotential.js";

const PRODUCTION_WORLD_VERSION = 1;
const PRODUCTION_LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const LINEUP_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]);
const DEFENSE_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);
const MIN_PRODUCTION_HITTERS = 10; // 9 starters + at least 1 real bench player
const MIN_PRODUCTION_PITCHERS = 8; // 5 starters + at least 3 bullpen arms

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clampRating(value, fallback = 50) {
  const n = Number(value);
  return Math.max(20, Math.min(99, Math.round(Number.isFinite(n) ? n : fallback)));
}

function normalizePosition(value) {
  const p = String(value ?? "DH").toUpperCase().replaceAll(" ", "");
  if (["C","1B","2B","3B","SS","LF","CF","RF","DH"].includes(p)) return p;
  if (["OF","OUTFIELD"].includes(p)) return "CF";
  if (["IF","INF","INFIELD"].includes(p)) return "2B";
  if (p === "P") return "P";
  return "DH";
}

function secondaryPositions(primary) {
  const map = {
    C: {}, "1B": { DH: 1, LF: 0.55 }, "2B": { SS: 0.78, "3B": 0.70 },
    "3B": { "1B": 0.78, "2B": 0.62 }, SS: { "2B": 0.90, "3B": 0.80 },
    LF: { RF: 0.84, CF: 0.68 }, CF: { LF: 0.92, RF: 0.92 }, RF: { LF: 0.84, CF: 0.68 },
    DH: { "1B": 0.50 }
  };
  return map[primary] ?? {};
}

function productionFacts(player, hiddenDevelopmentPrior = null) {
  return freeze({
    physical: {
      age: player.age == null ? null : Number(player.age),
      birthDate: player.birthDate ?? null,
      height: player.height ?? null,
      weight: player.weight == null ? null : Number(player.weight)
    },
    realWorld: {
      sourceTeamId: playerAssignedTeamId(player),
      sourceLevel: playerAssignedLevel(player),
      organizationId: player.organizationId ?? null,
      rosterStatus: playerRosterStatus(player),
      availability: playerAvailability(player),
      on40Man: player.on40Man ?? null,
      mlbActive: player.mlbActive ?? null,
      injuryListType: player.injuryListType ?? null,
      mlbDebutDate: player.mlbDebutDate ?? null,
      sourceId: player.sourceId ?? null,
      hiddenDevelopmentPrior
    }
  });
}

function engineHitter(player, inference, { seed = "" } = {}) {
  const r = inference?.ratings ?? {};
  const primaryPosition = normalizePosition(player.position);
  const engine = createPhase1Hitter({
    id: String(player.id), bats: player.bats ?? "R", throws: player.throws ?? "R", ovr: clampRating(inference?.overall),
    contactR: clampRating(r.contactR), contactL: clampRating(r.contactL), rawPower: clampRating(r.rawPower),
    vision: clampRating(r.vision), discipline: clampRating(r.discipline),
    powerUtilizationR: clampRating(r.powerUtilizationR), powerUtilizationL: clampRating(r.powerUtilizationL),
    launchTendency: 50, sprayPull: 50, sprayCenter: 50, sprayOppo: 50,
    speed: clampRating(r.speed), stealing: clampRating(r.stealing), baserunning: clampRating(r.baserunning),
    fielding: clampRating(r.fielding), reaction: clampRating(r.reaction), armStrength: clampRating(r.armStrength), armAccuracy: clampRating(r.armAccuracy),
    primaryPosition, secondaryPositions: secondaryPositions(primaryPosition), adaptability: 55
  });
  const hiddenDevelopmentPrior = inferRealPlayerPotentialProfile({ player: engine, sourcePlayer: player, inference, seed });
  return freeze({ ...engine, ...productionFacts(player, hiddenDevelopmentPrior) });
}

function enginePitcher(player, inference, { seed = "" } = {}) {
  const r = inference?.ratings ?? {};
  const engine = createPhase1Pitcher({
    id: String(player.id), throws: player.throws ?? "R", ovr: clampRating(inference?.overall),
    control: clampRating(r.control), command: clampRating(r.command), movement: clampRating(r.movement),
    pitchability: clampRating(r.pitchability), stuff: clampRating(r.stuff),
    pitchVelocityMph: r.pitchVelocityMph == null ? null : Number(r.pitchVelocityMph),
    stamina: clampRating(r.stamina), role: inference?.role ?? "RP", fielding: 50, reaction: 50, armStrength: 55, armAccuracy: 50
  });
  const hiddenDevelopmentPrior = inferRealPlayerPotentialProfile({ player: engine, sourcePlayer: player, inference, seed });
  return freeze({ ...engine, ...productionFacts(player, hiddenDevelopmentPrior) });
}

function positionFit(player, slot) {
  const p = normalizePosition(player.position);
  if (slot === "DH") return 1;
  if (p === slot) return 5;
  if ((slot === "LF" || slot === "CF" || slot === "RF") && ["LF","CF","RF"].includes(p)) return 3;
  if (["2B","3B","SS"].includes(slot) && ["2B","3B","SS"].includes(p)) return 2;
  if (slot === "1B" && ["1B","3B"].includes(p)) return 2;
  return 0;
}

function pickLineup(hitters, inferenceById) {
  const remaining = [...hitters];
  const slots = [];
  for (const position of LINEUP_POSITIONS) {
    remaining.sort((a, b) => {
      const af = positionFit(a, position), bf = positionFit(b, position);
      if (bf !== af) return bf - af;
      return Number(inferenceById.get(String(b.id))?.overall ?? 50) - Number(inferenceById.get(String(a.id))?.overall ?? 50) || String(a.id).localeCompare(String(b.id));
    });
    const selected = remaining.shift();
    if (!selected) throw new RangeError(`production roster의 야수 수가 부족합니다: ${position}`);
    slots.push({ position, player: selected });
  }
  return { slots, remaining };
}

function benchCoverage(player) {
  const p = normalizePosition(player.position);
  if (p === "C") return ["C"];
  if (["2B","3B","SS"].includes(p)) return [p, ...["2B","3B","SS"].filter((x) => x !== p)];
  if (["LF","CF","RF"].includes(p)) return [p, ...["LF","CF","RF"].filter((x) => x !== p)];
  if (p === "1B") return ["1B","DH","LF","RF"];
  return ["DH","1B","LF","RF"];
}

function createProductionRoster(team, snapshotPlayers, universe, inferenceById, { userPlayer = null, userPlayerName = null, seed = "" } = {}) {
  const playersForTeam = snapshotPlayers.filter((player) => String(playerAssignedTeamId(player)) === String(team.id) && isPlayerGameAvailable(player));
  const pitchers = playersForTeam.filter((player) => inferenceById.get(String(player.id))?.type === "PITCHER");
  const hitters = playersForTeam.filter((player) => inferenceById.get(String(player.id))?.type !== "PITCHER");
  if (hitters.length < MIN_PRODUCTION_HITTERS) throw new RangeError(`${team.name} production roster 야수가 부족합니다: ${hitters.length} < ${MIN_PRODUCTION_HITTERS}`);
  if (pitchers.length < MIN_PRODUCTION_PITCHERS) throw new RangeError(`${team.name} production roster 투수가 부족합니다: ${pitchers.length} < ${MIN_PRODUCTION_PITCHERS}`);

  const picked = pickLineup(hitters, inferenceById);
  const slots = picked.slots;
  const remaining = picked.remaining;
  if (userPlayer) {
    const preferred = normalizePosition(userPlayer.positioning?.primaryPosition ?? "DH");
    const slot = slots.find((row) => row.position === preferred) ?? slots.find((row) => row.position === "DH") ?? slots[0];
    if (slot?.player) remaining.unshift(slot.player);
    slot.player = { id: userPlayer.id, position: preferred, fullName: userPlayerName ?? "User Player" };
  }
  const enginePlayers = {};
  const names = {};
  for (const player of hitters) {
    enginePlayers[String(player.id)] = engineHitter(player, inferenceById.get(String(player.id)), { seed });
    names[String(player.id)] = player.fullName;
  }
  for (const player of pitchers) {
    enginePlayers[String(player.id)] = enginePitcher(player, inferenceById.get(String(player.id)), { seed });
    names[String(player.id)] = player.fullName;
  }
  if (userPlayer) {
    enginePlayers[userPlayer.id] = userPlayer;
    names[userPlayer.id] = userPlayerName ?? "User Player";
  }

  const lineupSlots = slots.map(({ position, player }) => ({ position, starterId: String(player.id) }));
  const lineup = lineupSlots.map((slot) => slot.starterId);
  const defense = Object.fromEntries(DEFENSE_POSITIONS.map((position) => [position, lineupSlots.find((slot) => slot.position === position).starterId]));
  const bench = remaining.slice(0, Math.max(4, remaining.length)).map((player) => ({ playerId: String(player.id), coverage: benchCoverage(player) }));

  const rankedPitchers = [...pitchers].sort((a, b) => Number(inferenceById.get(String(b.id))?.overall ?? 50) - Number(inferenceById.get(String(a.id))?.overall ?? 50) || String(a.id).localeCompare(String(b.id)));
  const preferredStarters = rankedPitchers.filter((p) => inferenceById.get(String(p.id))?.role === "SP");
  const starters = [...preferredStarters, ...rankedPitchers.filter((p) => !preferredStarters.includes(p))].slice(0, 5).map((p) => String(p.id));
  const starterSet = new Set(starters);
  const bullpen = rankedPitchers.filter((p) => !starterSet.has(String(p.id))).map((p) => String(p.id));
  if (bullpen.length < 3) throw new RangeError(`${team.name} production bullpen이 부족합니다: ${bullpen.length} < 3`);

  return freeze({
    team: { id: String(team.id), name: team.name, shortName: team.abbreviation || team.name },
    players: enginePlayers, names, lineup, lineupSlots, defense, bench,
    positionPlayers: [...hitters.map((p) => String(p.id)), ...(userPlayer ? [userPlayer.id] : [])],
    starters, bullpen, pitchers: pitchers.map((p) => String(p.id))
  });
}

function teamRowsForLevel(universe, level) {
  return universe.data.teams.filter((team) => team.level === level && team.active !== false);
}

function affiliateTeamId(universe, organizationId, level) {
  if (level === "MLB") return String(organizationId);
  return String(universe.data.affiliations.find((row) => String(row.organizationId) === String(organizationId) && row.level === level)?.teamId ?? "");
}

function getProductionOrganizationTeamIds(universe, organizationId) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("organization team ids에는 Master Snapshot universe가 필요합니다.");
  return freeze(Object.fromEntries(PRODUCTION_LEVELS.map((level) => [level, affiliateTeamId(universe, organizationId, level)])));
}

function getProductionOrganizationOptions(universe) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("production organization에는 Master Snapshot universe가 필요합니다.");
  const teams = teamRowsForLevel(universe, "MLB").sort((a, b) => a.name.localeCompare(b.name));
  if (teams.length !== 30) throw new RangeError(`production MLB 조직 수가 30이 아닙니다: ${teams.length}`);
  return freeze(teams.map((team) => ({ id: String(team.id), name: team.name, shortName: team.abbreviation || team.name, pool: "PRODUCTION_30", provisional: false })));
}

function resolveProductionStartingLevel(age) {
  const a = Number(age);
  if (a <= 18) return "A";
  if (a === 19) return "HIGH_A";
  if (a === 20) return "AA";
  return "AAA";
}

function validateProductionRuntimeUniverse(universe) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("production runtime에는 Master Snapshot universe가 필요합니다.");
  if (!universe.inference?.players?.length) throw new RangeError("production runtime에는 v46 inference가 필요합니다.");
  const inferenceById = new Map((universe.inference.players ?? []).map((row) => [String(row.playerId), row]));
  for (const level of PRODUCTION_LEVELS) {
    const teams = teamRowsForLevel(universe, level);
    if (teams.length !== 30) throw new RangeError(`production ${level} 팀 수가 30이 아닙니다: ${teams.length}`);
    const scheduleRows = universe.data.schedule.filter((game) => game.level === level && game.gameType !== "S");
    const scheduleCounts = Object.fromEntries(teams.map((team) => [String(team.id), 0]));
    for (const game of scheduleRows) {
      if (scheduleCounts[String(game.awayTeamId)] !== undefined) scheduleCounts[String(game.awayTeamId)] += 1;
      if (scheduleCounts[String(game.homeTeamId)] !== undefined) scheduleCounts[String(game.homeTeamId)] += 1;
    }
    for (const team of teams) {
      if ((scheduleCounts[String(team.id)] ?? 0) < 100) throw new RangeError(`${level} 실제 일정 coverage가 부족합니다: ${team.name} ${(scheduleCounts[String(team.id)] ?? 0)}경기`);
      const roster = universe.data.players.filter((player) => String(playerAssignedTeamId(player)) === String(team.id) && isPlayerGameAvailable(player));
      const pitcherCount = roster.filter((player) => inferenceById.get(String(player.id))?.type === "PITCHER").length;
      const hitterCount = roster.length - pitcherCount;
      if (hitterCount < MIN_PRODUCTION_HITTERS || pitcherCount < MIN_PRODUCTION_PITCHERS) throw new RangeError(`${team.name} production roster coverage가 부족합니다: H${hitterCount}/P${pitcherCount}`);
    }
  }
  for (const org of teamRowsForLevel(universe, "MLB")) {
    for (const level of PRODUCTION_LEVELS.slice(1)) if (!affiliateTeamId(universe, org.id, level)) throw new RangeError(`${org.name} ${level} 제휴팀이 없습니다.`);
  }
  return true;
}

function createLevelLeague({ universe, level, selectedOrgId, startDate, inferenceById, userPlayer = null, userPlayerName = null, userLevel = null, seed = "" }) {
  const sourceTeams = teamRowsForLevel(universe, level);
  const teams = sourceTeams.map((team) => freeze({ id: String(team.id), name: team.name, shortName: team.abbreviation || team.name }));
  const userTeamId = affiliateTeamId(universe, selectedOrgId, level);
  const rosters = Object.fromEntries(sourceTeams.map((team) => {
    const insertUser = userPlayer && level === userLevel && String(team.id) === String(userTeamId);
    return [String(team.id), createProductionRoster(team, universe.data.players, universe, inferenceById, { userPlayer: insertUser ? userPlayer : null, userPlayerName, seed })];
  }));
  const schedule = importSnapshotSchedule({ games: universe.data.schedule, teamIds: teams.map((team) => team.id), level, resetResults: true });
  return freeze({
    level,
    leagueId: `PROD_${universe.sourceSnapshot?.season ?? "REAL"}_${level}_30`,
    teams,
    rosters,
    schedule,
    userTeamId,
    scheduleSource: "MASTER_SNAPSHOT"
  });
}

function createProductionCareerSeasonFixture({ seed, careerPlan, universe } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("production career seed가 필요합니다.");
  if (!careerPlan?.generated?.player || !careerPlan?.identity || !careerPlan?.organization?.teamId) throw new TypeError("검증된 careerPlan이 필요합니다.");
  validateProductionRuntimeUniverse(universe);

  const selectedOrgId = String(careerPlan.organization.teamId);
  if (!getProductionOrganizationOptions(universe).some((org) => org.id === selectedOrgId)) throw new RangeError(`production 조직을 찾을 수 없습니다: ${selectedOrgId}`);
  const userLevel = resolveProductionStartingLevel(careerPlan.identity.age);
  const userPlayer = freeze({ ...careerPlan.generated.player, physical: { ...(careerPlan.generated.player.physical ?? {}), age: careerPlan.identity.age } });
  const allDates = universe.data.schedule.filter((g) => g.gameType !== "S").map((g) => String(g.date)).sort();
  const startDate = allDates[0] ?? universe.snapshotDate;
  const inferenceById = new Map((universe.inference?.players ?? []).map((row) => [String(row.playerId), row]));
  const levelLeagues = {};
  for (const level of PRODUCTION_LEVELS) {
    levelLeagues[level] = createLevelLeague({ universe, level, selectedOrgId, startDate, inferenceById, userPlayer, userPlayerName: careerPlan.identity.name, userLevel, seed });
  }
  const organizationLevels = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const league = levelLeagues[level];
    const teamId = league.userTeamId;
    return [level, freeze({ level, team: league.rosters[teamId].team, roster: league.rosters[teamId], simulated: true })];
  }));
  const aaa = levelLeagues.AAA;
  const careerProfile = freeze({
    schemaVersion: 1, identity: { ...careerPlan.identity }, archetype: careerPlan.generated.startingProfile.archetype,
    visibleTraits: [...careerPlan.generated.startingProfile.visibleTraits], startingProfile: careerPlan.generated.startingProfile,
    organizationChoice: { ...careerPlan.organization }
  });
  return freeze({
    seed, startDate, worldMode: "PRODUCTION_REAL", productionWorldVersion: PRODUCTION_WORLD_VERSION,
    sourceSnapshotId: universe.sourceSnapshot?.id ?? null, sourceSnapshotHash: universe.sourceSnapshot?.hash ?? null,
    scheduleSource: "MASTER_SNAPSHOT", futureScheduleGenerator: "ROUND_ROBIN_162_BALANCED_V47",
    userPlayerId: userPlayer.id, userTeamId: aaa.userTeamId,
    teams: aaa.teams, rosters: aaa.rosters, schedule: aaa.schedule, levelLeagues,
    organization: { id: `ORG_${selectedOrgId}`, organizationId: selectedOrgId, name: careerPlan.organization.teamName, levels: organizationLevels, levelOrder: PRODUCTION_LEVELS, userLevel },
    careerProfile
  });
}

function rehomeProductionUserOrganization(fixture, { universe, organizationId, userLevel = fixture?.organization?.userLevel ?? "AAA" } = {}) {
  ensureProductionSeasonFixture(fixture);
  const orgId=String(organizationId);
  const option=getProductionOrganizationOptions(universe).find((row)=>row.id===orgId);
  if(!option) throw new RangeError(`production 조직을 찾을 수 없습니다: ${orgId}`);
  const teamIds=getProductionOrganizationTeamIds(universe,orgId);
  const levelLeagues=Object.fromEntries(PRODUCTION_LEVELS.map((level)=>{
    const league=fixture.levelLeagues[level], teamId=String(teamIds[level]);
    if(!league?.rosters?.[teamId]) throw new RangeError(`rehome ${level} roster를 찾을 수 없습니다: ${teamId}`);
    return [level,freeze({...league,userTeamId:teamId})];
  }));
  const levels=Object.fromEntries(PRODUCTION_LEVELS.map((level)=>{
    const roster=levelLeagues[level].rosters[levelLeagues[level].userTeamId];
    return [level,freeze({level,team:roster.team,roster,simulated:true})];
  }));
  const aaa=levelLeagues.AAA;
  const careerProfile=fixture.careerProfile ? freeze({
    ...fixture.careerProfile,
    organizationChoice: freeze({
      ...(fixture.careerProfile.organizationChoice ?? {}),
      teamId: orgId,
      teamName: option.name,
      teamShortName: option.shortName,
      pool: option.pool,
      provisional: option.provisional
    })
  }) : fixture.careerProfile;
  return freeze({...fixture,userTeamId:aaa.userTeamId,teams:aaa.teams,rosters:aaa.rosters,schedule:aaa.schedule,levelLeagues,careerProfile,
    organization:freeze({id:`ORG_${orgId}`,organizationId:orgId,name:option.name,levels,levelOrder:PRODUCTION_LEVELS,userLevel})
  });
}

function ensureProductionSeasonFixture(fixture) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") return fixture;
  if (!fixture?.levelLeagues || !fixture?.organization?.levels) throw new RangeError("production fixture의 league/organization 구조가 없습니다.");
  return fixture;
}


function createNextProductionSeasonFixture(fixture, { startDate = null } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("next production season은 production fixture에서만 생성할 수 있습니다.");
  ensureProductionSeasonFixture(fixture);
  const nextStartDate = startDate ?? `${Number(String(fixture.startDate).slice(0,4)) + 1}-03-25`;
  const schedules = createFutureProductionSchedules(fixture, { startDate: nextStartDate });
  const levelLeagues = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const league = fixture.levelLeagues[level];
    return [level, freeze({ ...league, schedule: schedules[level], scheduleSource: "GENERATED_FUTURE" })];
  }));
  const organizationLevels = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const prior = fixture.organization.levels[level];
    const league = levelLeagues[level];
    const teamId = String(prior?.team?.id ?? league.userTeamId);
    const roster = league.rosters[teamId] ?? prior?.roster;
    if (!roster) throw new RangeError(`next production season ${level} 사용자 조직 roster를 찾을 수 없습니다.`);
    return [level, freeze({ ...prior, level, team: roster.team, roster, simulated: true })];
  }));
  const aaa = levelLeagues.AAA;
  return freeze({
    ...fixture,
    startDate: nextStartDate,
    scheduleSource: "GENERATED_FUTURE",
    teams: aaa.teams,
    rosters: aaa.rosters,
    schedule: aaa.schedule,
    levelLeagues,
    organization: freeze({ ...fixture.organization, levels: organizationLevels })
  });
}
function createFutureProductionSchedules(fixture, { startDate = null } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("future production schedule은 production fixture에서만 생성할 수 있습니다.");
  const schedules = {};
  for (const level of PRODUCTION_LEVELS) {
    const league = fixture.levelLeagues[level];
    const teamCount = league.teams.length;
    const gamesPerTeam = Number((league.schedule.length * 2) / teamCount);
    if (!Number.isInteger(gamesPerTeam) || gamesPerTeam < teamCount - 1) throw new RangeError(`${level} future schedule template 경기 수가 잘못되었습니다: ${gamesPerTeam}`);
    schedules[level] = generateFutureProductionSchedule({ teamIds: league.teams.map((team) => team.id), startDate: startDate ?? `${Number(fixture.startDate.slice(0,4)) + 1}-03-25`, gamesPerTeam });
  }
  return freeze(schedules);
}

// v47 keeps player construction isolated here. The phase-1 builder functions are
// used only as immutable engine-shape constructors; source facts and ratings come
// exclusively from the copied snapshot + v46 inference, never from dev fixture constants.

export { PRODUCTION_WORLD_VERSION, PRODUCTION_LEVELS, getProductionOrganizationOptions, getProductionOrganizationTeamIds, rehomeProductionUserOrganization, resolveProductionStartingLevel, validateProductionRuntimeUniverse, createProductionCareerSeasonFixture, ensureProductionSeasonFixture, createFutureProductionSchedules, createNextProductionSeasonFixture };
