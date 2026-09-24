import { createGameState } from "../engine/game/gameState.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../engine/player/playerFixtures.js";
import { generateRoundRobinSchedule } from "../engine/season/schedule.js";
import { getSeasonEffectivePlayer } from "../engine/season/playerSeasonState.js";
import { buildDailyLineup } from "../engine/season/lineupRestAI.js";
import { getSeasonEffectivePitcher, orderAvailableBullpen, selectSeasonStarter } from "../engine/season/pitcherSeasonState.js";
import { healthAvailability } from "../engine/season/injuryState.js";
import { resolveProductionGamePark } from "./productionParkResolver.js";

const POSITION_ORDER = Object.freeze(["SS", "CF", "1B", "DH", "RF", "3B", "2B", "C", "LF"]);
const DEFENSE_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);

function clampRating(value) { return Math.max(20, Math.min(99, Math.round(value))); }

function hitter(id, base, offset = 0, overrides = {}) {
  const v = (value) => clampRating(value + offset);
  return createPhase1Hitter({
    id,
    contactR: v(base.contactR ?? 50), contactL: v(base.contactL ?? 50), rawPower: v(base.rawPower ?? 50),
    vision: v(base.vision ?? 50), discipline: v(base.discipline ?? 50),
    powerUtilizationR: v(base.powerUtilizationR ?? base.rawPower ?? 50),
    powerUtilizationL: v(base.powerUtilizationL ?? base.rawPower ?? 50),
    launchTendency: v(base.launchTendency ?? 50), speed: v(base.speed ?? 50),
    stealing: v(base.stealing ?? base.speed ?? 50), baserunning: v(base.baserunning ?? base.speed ?? 50),
    fielding: v(base.fielding ?? 50), reaction: v(base.reaction ?? base.fielding ?? 50),
    armStrength: v(base.armStrength ?? 50), armAccuracy: v(base.armAccuracy ?? 50),
    ...overrides
  });
}

function pitcher(id, offset = 0, starter = true, index = 0) {
  const v = (value) => clampRating(value + offset);
  return createPhase1Pitcher({
    id, throws: index % 3 === 1 ? "L" : "R",
    control: v(starter ? 55 + (index % 2) * 2 : 56 + index),
    command: v(starter ? 55 + ((index + 1) % 3) : 57 + index),
    movement: v(starter ? 56 + (index % 3) : 60 + index),
    pitchability: v(starter ? 56 + ((index + 2) % 3) : 58 + index),
    stuff: v(starter ? 58 + (index % 2) * 2 : 64 + index),
    pitchVelocityMph: (starter ? 93.2 : 95.0) + index * 0.45 + offset * 0.04,
    stamina: starter ? v(58 + (index % 3) * 3) : v(38 + (index % 2)),
    role: starter ? "SP" : (index === 2 ? "CL" : "RP"), holdRunner: v(53 + ((index * 3) % 8)),
    fielding: v(50), reaction: v(50)
  });
}

const BASE_BY_POSITION = Object.freeze({
  SS: { contactR: 55, contactL: 53, rawPower: 45, vision: 58, discipline: 54, speed: 64, baserunning: 61, fielding: 68, reaction: 69, armStrength: 63, armAccuracy: 66 },
  CF: { contactR: 54, contactL: 52, rawPower: 52, vision: 56, discipline: 55, speed: 70, stealing: 66, baserunning: 68, fielding: 68, reaction: 71, armStrength: 61, armAccuracy: 62 },
  "1B": { contactR: 54, contactL: 51, rawPower: 68, vision: 50, discipline: 59, speed: 33, fielding: 58, reaction: 52, armStrength: 48, armAccuracy: 58, launchTendency: 62 },
  DH: { contactR: 53, contactL: 54, rawPower: 70, vision: 49, discipline: 57, speed: 35, fielding: 40, reaction: 40, launchTendency: 64 },
  RF: { contactR: 54, contactL: 53, rawPower: 59, vision: 53, discipline: 54, speed: 58, fielding: 61, reaction: 60, armStrength: 70, armAccuracy: 64 },
  "3B": { contactR: 52, contactL: 54, rawPower: 58, vision: 52, discipline: 53, speed: 45, fielding: 62, reaction: 60, armStrength: 70, armAccuracy: 62 },
  "2B": { contactR: 53, contactL: 53, rawPower: 43, vision: 60, discipline: 56, speed: 61, fielding: 67, reaction: 68, armStrength: 54, armAccuracy: 68 },
  C: { contactR: 49, contactL: 50, rawPower: 54, vision: 50, discipline: 56, speed: 28, stealing: 24, baserunning: 43, fielding: 69, reaction: 68, armStrength: 75, armAccuracy: 71 },
  LF: { contactR: 52, contactL: 53, rawPower: 56, vision: 53, discipline: 52, speed: 55, fielding: 56, reaction: 55, armStrength: 56, armAccuracy: 56 }
});


function secondaryPositionsForStarter(position, isUser = false) {
  if (isUser && position === "CF") return Object.freeze({ LF: 0.72, RF: 0.72 });
  const map = {
    SS: { "2B": 0.90, "3B": 0.82 },
    "2B": { SS: 0.86, "3B": 0.78 },
    "3B": { "1B": 0.82, "2B": 0.72 },
    CF: { LF: 0.90, RF: 0.90 },
    LF: { RF: 0.82, CF: 0.72 },
    RF: { LF: 0.82, CF: 0.72 },
    "1B": { DH: 1.0, LF: 0.68 },
    C: {},
    DH: { "1B": 0.62 }
  };
  return Object.freeze({ ...(map[position] ?? {}) });
}

function adaptabilityForId(id) {
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 44 + ((h >>> 0) % 31);
}


const ORGANIZATION_LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const LEVEL_OFFSETS = Object.freeze({ MLB: 12, AAA: 0, AA: -6, HIGH_A: -9, A: -12 });

function affiliateTeam(baseTeam, level) {
  if (level === "AAA") return baseTeam;
  return Object.freeze({
    id: `${baseTeam.id}_${level}`,
    name: `${baseTeam.name} ${level}`,
    shortName: `${baseTeam.shortName} ${level}`,
    offset: (baseTeam.offset ?? 0) + LEVEL_OFFSETS[level]
  });
}

function createDemoOrganization(baseTeam, currentRoster, mlbRoster = null) {
  const levels = {};
  for (const level of ORGANIZATION_LEVELS) {
    if (level === "AAA") {
      levels[level] = Object.freeze({ level, team: currentRoster.team, roster: currentRoster, simulated: true });
      continue;
    }
    if (level === "MLB" && mlbRoster) {
      levels[level] = Object.freeze({ level, team: mlbRoster.team, roster: mlbRoster, simulated: true });
      continue;
    }
    const team = affiliateTeam(baseTeam, level);
    const roster = createTeamRoster(team, "__no_user__");
    levels[level] = Object.freeze({ level, team: roster.team, roster, simulated: level === "MLB" });
  }
  return Object.freeze({
    id: `ORG_${baseTeam.id}`,
    name: `${baseTeam.name} 조직`,
    levels: Object.freeze(levels),
    levelOrder: ORGANIZATION_LEVELS,
    userLevel: "AAA"
  });
}

function ensureDemoOrganizationFixture(fixture) {
  if (fixture?.organization?.levels) return fixture;
  const baseTeam = DEMO_TEAM_DEFS.find((team) => team.id === fixture?.userTeamId) ?? fixture?.teams?.find?.((team) => team.id === fixture?.userTeamId);
  const currentRoster = fixture?.rosters?.[fixture?.userTeamId];
  if (!baseTeam || !currentRoster) throw new RangeError("사용자 organization을 구성할 roster가 없습니다.");
  return Object.freeze({ ...fixture, organization: createDemoOrganization(baseTeam, currentRoster) });
}

const DEMO_TEAM_DEFS = Object.freeze([
  { id: "BLU", name: "콜업 블루", shortName: "BLU", offset: 0 },
  { id: "FOX", name: "레드 폭스", shortName: "FOX", offset: 2 },
  { id: "BEA", name: "베이 베어스", shortName: "BEA", offset: -2 },
  { id: "COM", name: "시티 코멧츠", shortName: "COM", offset: 4 },
  { id: "WAV", name: "코스트 웨이브", shortName: "WAV", offset: -1 },
  { id: "OWL", name: "나이트 아울스", shortName: "OWL", offset: 1 },
  { id: "ELK", name: "밸리 엘크스", shortName: "ELK", offset: -4 },
  { id: "JET", name: "메트로 제츠", shortName: "JET", offset: 3 }
]);

function createTeamRoster(team, userPlayerId, { userTeamId = "BLU", userPosition = "CF", userPlayer = null, userName = "강민준" } = {}) {
  const players = {}, names = {}, lineup = [], positionToId = {}, lineupSlots = [];

  POSITION_ORDER.forEach((position, index) => {
    let id = `${team.id.toLowerCase()}_${position.toLowerCase()}`;
    const isUser = team.id === userTeamId && position === userPosition;
    if (isUser) id = userPlayerId;
    const bats = index % 3 === 1 ? "L" : index % 4 === 0 ? "S" : "R";
    const positionProfile = {
      primaryPosition: position,
      secondaryPositions: secondaryPositionsForStarter(position, isUser),
      adaptability: adaptabilityForId(id)
    };
    const custom = isUser ? {
      bats: "R", contactR: 58, contactL: 55, rawPower: 64, vision: 57, discipline: 55,
      powerUtilizationR: 63, powerUtilizationL: 60, launchTendency: 57,
      sprayPull: 60, sprayCenter: 52, sprayOppo: 46, speed: 69, stealing: 64, baserunning: 65,
      fielding: 64, reaction: 66, armStrength: 63, armAccuracy: 61, ...positionProfile
    } : { bats, ...positionProfile };
    players[id] = isUser && userPlayer ? userPlayer : hitter(id, BASE_BY_POSITION[position], team.offset, custom);
    names[id] = isUser ? userName : `${team.shortName} ${position}`;
    lineup.push(id);
    lineupSlots.push(Object.freeze({ position, starterId: id }));
    if (position !== "DH") positionToId[position] = id;
  });

  const benchDefs = [
    { key: "bc", label: "백업 C", base: "C", coverage: ["C"] },
    { key: "bi", label: "유틸 IF", base: "2B", coverage: ["SS", "2B", "3B"] },
    { key: "bo", label: "4번째 OF", base: "LF", coverage: ["LF", "CF", "RF"] },
    { key: "bb", label: "벤치 BAT", base: "1B", coverage: ["1B", "DH", "LF", "RF"] }
  ];
  const bench = benchDefs.map((def, index) => {
    const id = `${team.id.toLowerCase()}_${def.key}`;
    players[id] = hitter(id, BASE_BY_POSITION[def.base], team.offset - 5 + (index % 2), {
      bats: index % 2 ? "L" : "R",
      primaryPosition: def.base,
      secondaryPositions: Object.fromEntries(def.coverage.filter((position) => position !== def.base && position !== "DH").map((position) => [position, 1])),
      adaptability: adaptabilityForId(id)
    });
    names[id] = `${team.shortName} ${def.label}`;
    return Object.freeze({ playerId: id, coverage: Object.freeze(def.coverage) });
  });

  const starters = [], bullpen = [];
  for (let i = 0; i < 4; i += 1) {
    const id = `${team.id.toLowerCase()}_sp${i + 1}`;
    players[id] = pitcher(id, team.offset, true, i); names[id] = `${team.shortName} 선발${i + 1}`; starters.push(id);
  }
  for (let i = 0; i < 3; i += 1) {
    const id = `${team.id.toLowerCase()}_rp${i + 1}`;
    players[id] = pitcher(id, team.offset, false, i); names[id] = `${team.shortName} 불펜${i + 1}`; bullpen.push(id);
  }

  return Object.freeze({
    team, players: Object.freeze(players), names: Object.freeze(names),
    lineup: Object.freeze(lineup), lineupSlots: Object.freeze(lineupSlots),
    defense: Object.freeze(Object.fromEntries(DEFENSE_POSITIONS.map((position) => [position, positionToId[position]]))),
    bench: Object.freeze(bench), positionPlayers: Object.freeze([...lineup, ...bench.map((item) => item.playerId)]),
    starters: Object.freeze(starters), bullpen: Object.freeze(bullpen), pitchers: Object.freeze([...starters, ...bullpen])
  });
}

function userTeamIdForLevel(level, baseUserTeamId = "BLU") {
  return level === "AAA" ? baseUserTeamId : `${baseUserTeamId}_${level}`;
}

function createLevelLeague({ level, startDate, baseTeams, existingUserRoster = null, baseUserTeamId = "BLU" }) {
  const defs = level === "AAA" ? baseTeams : baseTeams.map((team) => affiliateTeam(team, level));
  const teams = defs.map((team) => Object.freeze({ id: team.id, name: team.name, shortName: team.shortName }));
  const rosters = Object.fromEntries(defs.map((team) => {
    const roster = existingUserRoster && team.id === existingUserRoster.team.id ? existingUserRoster : createTeamRoster(team, "__no_user__");
    return [team.id, roster];
  }));
  const schedule = generateRoundRobinSchedule({ teamIds: teams.map((team) => team.id), startDate, gamesPerSeries: 2, cycles: 2, offDayEverySeries: 4 });
  return Object.freeze({ level, teams: Object.freeze(teams), rosters: Object.freeze(rosters), schedule, userTeamId: userTeamIdForLevel(level, baseUserTeamId) });
}

/**
 * Ensure the full-season ladder has independent A / High-A / AA / AAA / MLB leagues.
 * Existing AAA/MLB fixtures are preserved byte-for-byte where possible so
 * v23-v25 deterministic regression seeds remain stable; only missing levels are
 * synthesized in their own RNG/team-id namespaces.
 */
function ensureDemoMultiLevelFixture(fixture) {
  let base = ensureDemoOrganizationFixture(fixture);
  const existing = base.levelLeagues ?? {};
  if (ORGANIZATION_LEVELS.every((level) => existing[level])) {
    const levels = Object.fromEntries(ORGANIZATION_LEVELS.map((level) => {
      const affiliate = base.organization.levels[level];
      return [level, Object.freeze({ ...affiliate, simulated: true })];
    }));
    if (ORGANIZATION_LEVELS.every((level) => base.organization.levels[level]?.simulated)) return base;
    return Object.freeze({ ...base, organization: Object.freeze({ ...base.organization, levels: Object.freeze(levels) }) });
  }

  const aaaLeague = existing.AAA ?? Object.freeze({ level: "AAA", teams: base.teams, rosters: base.rosters, schedule: base.schedule, userTeamId: base.userTeamId });
  const levelLeagues = { AAA: aaaLeague };
  for (const level of ["MLB", "AA", "HIGH_A", "A"]) {
    const prior = existing[level];
    if (prior) {
      levelLeagues[level] = prior;
      continue;
    }
    const orgRoster = base.organization?.levels?.[level]?.roster ?? null;
    levelLeagues[level] = createLevelLeague({ level, startDate: base.startDate, baseTeams: DEMO_TEAM_DEFS, existingUserRoster: orgRoster, baseUserTeamId: base.userTeamId });
  }

  const organizationLevels = { ...base.organization.levels };
  for (const level of ORGANIZATION_LEVELS) {
    const league = levelLeagues[level];
    const userRoster = league.rosters[league.userTeamId];
    const previous = organizationLevels[level];
    organizationLevels[level] = Object.freeze({
      ...(previous ?? {}),
      level,
      team: userRoster.team,
      roster: userRoster,
      simulated: true
    });
    // Organization transactions are authoritative. If the organization roster
    // differs from a legacy level-league copy, keep the organization roster.
    levelLeagues[level] = Object.freeze({
      ...league,
      rosters: Object.freeze({ ...league.rosters, [userRoster.team.id]: organizationLevels[level].roster })
    });
  }

  const organization = Object.freeze({
    ...base.organization,
    levels: Object.freeze(organizationLevels),
    userLevel: base.organization?.userLevel ?? "AAA"
  });
  return Object.freeze({ ...base, organization, levelLeagues: Object.freeze(levelLeagues) });
}

function getDemoOrganizationOptions() {
  return Object.freeze(DEMO_TEAM_DEFS.map(({ id, name, shortName }) => Object.freeze({ id, name, shortName })));
}

function createCareerSeasonFixture({ seed, startDate = "2026-04-01", careerPlan } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("career season seed가 필요합니다.");
  if (!careerPlan?.generated?.player || !careerPlan?.identity || !careerPlan?.organization?.teamId) {
    throw new TypeError("검증된 careerPlan이 필요합니다.");
  }
  const userPlayerId = careerPlan.generated.player.id;
  const userTeamId = careerPlan.organization.teamId;
  const userPosition = careerPlan.identity.primaryPosition;
  const userName = careerPlan.identity.name;
  const userPlayer = Object.freeze({ ...careerPlan.generated.player, physical: Object.freeze({ ...(careerPlan.generated.player.physical ?? {}), age: careerPlan.identity.age }) });
  if (!DEMO_TEAM_DEFS.some((team) => team.id === userTeamId)) throw new RangeError(`지원하지 않는 개발 조직입니다: ${userTeamId}`);

  const teams = DEMO_TEAM_DEFS.map((team) => Object.freeze({ id: team.id, name: team.name, shortName: team.shortName }));
  const rosters = Object.fromEntries(DEMO_TEAM_DEFS.map((team) => [team.id, createTeamRoster(team, userPlayerId, {
    userTeamId, userPosition, userPlayer, userName
  })]));
  const schedule = generateRoundRobinSchedule({ teamIds: teams.map((team) => team.id), startDate, gamesPerSeries: 2, cycles: 2, offDayEverySeries: 4 });
  const careerProfile = Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze({ ...careerPlan.identity }),
    archetype: careerPlan.generated.startingProfile.archetype,
    visibleTraits: Object.freeze([...careerPlan.generated.startingProfile.visibleTraits]),
    startingProfile: careerPlan.generated.startingProfile,
    organizationChoice: Object.freeze({ ...careerPlan.organization })
  });
  const base = Object.freeze({ seed, startDate, userPlayerId, userTeamId, teams: Object.freeze(teams), rosters: Object.freeze(rosters), schedule, careerProfile });
  return ensureDemoMultiLevelFixture(base);
}

function createDemoSeasonFixture({ seed = "THE_CALL_UP_SEASON_V1", startDate = "2026-04-01" } = {}) {
  const userPlayerId = "user_001", userTeamId = "BLU";
  const teams = DEMO_TEAM_DEFS.map((team) => Object.freeze({ id: team.id, name: team.name, shortName: team.shortName }));
  const rosters = Object.fromEntries(DEMO_TEAM_DEFS.map((team) => [team.id, createTeamRoster(team, userPlayerId)]));
  const schedule = generateRoundRobinSchedule({ teamIds: teams.map((team) => team.id), startDate, gamesPerSeries: 2, cycles: 2, offDayEverySeries: 4 });
  const base = Object.freeze({ seed, startDate, userPlayerId, userTeamId, teams: Object.freeze(teams), rosters: Object.freeze(rosters), schedule });
  return ensureDemoMultiLevelFixture(base);
}

function createSeasonGameFixture({ seasonFixture, scheduleGame, playerStates = null, pitcherStates = null, roleStates = null, level = "AAA" }) {
  const league = seasonFixture.levelLeagues?.[level] ?? { rosters: seasonFixture.rosters, userTeamId: seasonFixture.userTeamId };
  const awayRoster = league.rosters[scheduleGame.awayTeamId];
  const homeRoster = league.rosters[scheduleGame.homeTeamId];
  if (!awayRoster || !homeRoster) throw new RangeError("scheduleGame의 팀 roster를 찾을 수 없습니다.");

  const awayPitcherId = selectSeasonStarter(awayRoster, scheduleGame.awayRotationIndex, pitcherStates);
  const homePitcherId = selectSeasonStarter(homeRoster, scheduleGame.homeRotationIndex, pitcherStates);
  const awayDaily = buildDailyLineup(
    awayRoster,
    playerStates,
    roleStates,
    { opposingPitcher: homeRoster.players?.[homePitcherId] ?? null }
  );
  const homeDaily = buildDailyLineup(
    homeRoster,
    playerStates,
    roleStates,
    { opposingPitcher: awayRoster.players?.[awayPitcherId] ?? null }
  );
  const awayBullpen = orderAvailableBullpen(awayRoster, pitcherStates);
  const homeBullpen = orderAvailableBullpen(homeRoster, pitcherStates);

  const basePlayers = { ...awayRoster.players, ...homeRoster.players };
  const players = Object.freeze(Object.fromEntries(Object.entries(basePlayers).map(([id, player]) => {
    const isPitcher = Boolean(player?.pitching && ((player.pitching.role ?? "RP") === "SP" || player.derived?.stuff > 50));
    return [id, isPitcher
      ? getSeasonEffectivePitcher(player, pitcherStates?.[id] ?? null)
      : getSeasonEffectivePlayer(player, playerStates?.[id] ?? null)];
  })));
  const names = Object.freeze({ ...awayRoster.names, ...homeRoster.names });
  const initialState = createGameState({
    gameId: scheduleGame.gameId,
    awayLineup: awayDaily.lineup, homeLineup: homeDaily.lineup,
    awayPitcherId, homePitcherId, awayDefense: awayDaily.defense, homeDefense: homeDaily.defense
  });

  const userInAway = scheduleGame.awayTeamId === league.userTeamId && awayDaily.lineup.includes(seasonFixture.userPlayerId);
  const userInHome = scheduleGame.homeTeamId === league.userTeamId && homeDaily.lineup.includes(seasonFixture.userPlayerId);
  const park = resolveProductionGamePark({
    parks: seasonFixture.parks ?? [],
    scheduleGame,
    homeTeamId: scheduleGame.homeTeamId,
    level
  });
  return Object.freeze({
    seed: `${seasonFixture.seed}:${level}:${scheduleGame.gameId}`, gameId: scheduleGame.gameId, date: scheduleGame.date, level,
    userPlayerId: (userInAway || userInHome) ? seasonFixture.userPlayerId : null,
    userTeam: userInAway ? "away" : userInHome ? "home" : null,
    teams: Object.freeze({ away: awayRoster.team, home: homeRoster.team }), players, names, park,
    dailyLineups: Object.freeze({ away: awayDaily, home: homeDaily }),
    benchPlans: Object.freeze({
      away: Object.freeze((awayDaily.bench ?? awayRoster.bench ?? []).filter((row) => healthAvailability(playerStates?.[row.playerId]?.health) !== "INJURED").map((row) => Object.freeze({ playerId: row.playerId, coverage: Object.freeze([...(row.coverage ?? [])]) }))),
      home: Object.freeze((homeDaily.bench ?? homeRoster.bench ?? []).filter((row) => healthAvailability(playerStates?.[row.playerId]?.health) !== "INJURED").map((row) => Object.freeze({ playerId: row.playerId, coverage: Object.freeze([...(row.coverage ?? [])]) })))
    }),
    pitchingPlans: Object.freeze({
      away: Object.freeze({ starterId: awayPitcherId, bullpenIds: awayBullpen }),
      home: Object.freeze({ starterId: homePitcherId, bullpenIds: homeBullpen })
    }),
    initialState
  });
}

export { ensureDemoOrganizationFixture, DEMO_TEAM_DEFS, ensureDemoMultiLevelFixture, getDemoOrganizationOptions, createCareerSeasonFixture, createDemoSeasonFixture, createSeasonGameFixture };
