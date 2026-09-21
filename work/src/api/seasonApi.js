import { createSaveUniverseFromMasterSnapshot, createSyntheticUniverseDescriptor, normalizeSaveUniverse, validateMasterSnapshot } from "../data/masterSnapshot.js";
import { inferRealWorldUniverse } from "../data/realWorldInference.js";
import { playerAssignedTeamId, playerOrganizationId } from "../data/rosterAvailability.js";
import { gameApi } from "./gameApi.js";
import { createCareerSeasonFixture, createDemoSeasonFixture, createSeasonGameFixture, ensureDemoMultiLevelFixture } from "../services/demoSeasonFactory.js";
import { createProductionCareerSeasonFixture, ensureProductionSeasonFixture, getProductionOrganizationOptions, createNextProductionSeasonFixture } from "../services/productionSeasonFactory.js";
import { buildCareerCreationPlan, getCareerCreationCatalog } from "../services/careerCreationService.js";
import { simulateSeasonFixtureGame } from "../services/seasonGameService.js";
import { createSeasonState, getAllPlayerSeasonBatting, getGamesOnDate, getNextTeamGame, getPlayerSeasonBattingLine, getPlayerSeasonPitchingLine, getRecentTeamResults, getSeriesGames, getStandingsTable, getUserSeasonLine, recordSeasonGame, setSeasonCurrentDate } from "../engine/season/seasonState.js";
import { applyAnnualPositionPlayerDevelopment, applyPositionPlayerGame, createPositionPlayerSeasonState, getPositionPlayerSeasonView, getSeasonDevelopedPlayer, getSeasonEffectivePlayer, recoverPositionPlayer, setPositionPlayerTrainingFocus, normalizePositionPlayerSeasonState } from "../engine/season/playerSeasonState.js";
import { applyAnnualPitcherSeasonDevelopment, applyPitcherSeasonGame, createPitcherSeasonState, getPitcherSeasonView, getSeasonDevelopedPitcher, recoverPitcherSeasonState, normalizePitcherSeasonState, pitcherAvailability } from "../engine/season/pitcherSeasonState.js";
import { healthAvailability, maybeApplyInjury } from "../engine/season/injuryState.js";
import { applyAnnualPitcherAging, applyAnnualPositionPlayerAging } from "../engine/season/agingState.js";
import { restoreSeasonSession, serializeSeasonSession } from "../services/seasonSerialization.js";
import { resetSeasonStatesForNewYear } from "../services/seasonRolloverService.js";
import { createProductionEcologyState, normalizeProductionEcologyState, advanceProductionOffseasonEcology } from "../services/productionOffseasonEcology.js";
import { applyRoleGame, createOrganizationRoleStates, getRolePublicView, normalizeRoleStates, reviewRoleIfDue } from "../engine/season/roleSystem.js";
import { applyOrganizationReview, createOrganizationReviewState, evaluateAaaMlbPitcherMovement, evaluateAaaMlbPromotion, evaluateMinorLevelPitcherMovement, evaluateMinorLevelPromotion, getOrganizationEvaluationPublicView, getOrganizationReviewPublicView, isOrganizationReviewDue, normalizeOrganizationReviewState } from "../engine/season/promotionAI.js";
import { executeAdjacentLevelSwap } from "../services/organizationRosterService.js";
import { createCareerEventState, getCareerTimelinePublicView, normalizeCareerEventState, recordGameCareerMoments, recordOrganizationCareerEvents, recordRoleChangeCareerEvent } from "../engine/career/careerEvents.js";
import { getUtilityPathwayView } from "../engine/season/utilityUsage.js";
import { getPositionPlayingTimeView } from "../engine/season/playingTimeReadModel.js";
import { getRoleFitFeedback } from "../engine/season/roleFitFeedback.js";
import { applyScoutingReview, buildScoutingReport, createScoutingState, markScoutingReviewProcessed, normalizeScoutingState, prospectRankingScore } from "../engine/season/scoutingState.js";
import { createContractState, normalizeContractState, getMlbServiceWindow, advanceContractStateToDate, creditContractServiceDate, getContractPublicView } from "../engine/career/contractState.js";
import { createRosterControlState, normalizeRosterControlState, advanceRosterControlToDate, getRosterControlPublicView, knownFortyManCount, prepareAaaMlbRosterMove } from "../engine/career/rosterControlState.js";

const sessions = new Map();
const CURRENT_GAME_VERSION = "full_career_roster_rules_v52";

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function assertSession(seasonId) { const s = sessions.get(seasonId); if (!s) throw new RangeError(`시즌 세션을 찾을 수 없습니다: ${seasonId}`); return s; }
function daysBetween(fromIso, toIso) {
  if (fromIso === toIso) return 0;
  const from = new Date(`${fromIso}T00:00:00Z`), to = new Date(`${toIso}T00:00:00Z`);
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`시즌 날짜가 역행했습니다: ${fromIso} -> ${toIso}`);
  return days;
}
function addIsoDays(isoDate, days) {
  if (!Number.isInteger(days)) throw new RangeError("days는 정수여야 합니다.");
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`유효한 날짜가 아닙니다: ${isoDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const IMPORTANT_CAREER_EVENT_TYPES = new Set([
  "PLAYER_PROMOTED", "PLAYER_DEMOTED", "ROLE_CHANGED",
  "PRO_DEBUT", "MLB_DEBUT", "FIRST_MLB_HIT", "FIRST_MLB_HR", "FIRST_MLB_RBI", "FIRST_MLB_SB"
]);
const MAJOR_INJURY_SEVERITIES = new Set(["MAJOR", "SEASON_ENDING"]);

const SIMULATED_LEVELS = Object.freeze(["A", "HIGH_A", "AA", "AAA", "MLB"]);

function levelLeague(session, level) {
  const league = session.fixture.levelLeagues?.[level];
  if (league) return league;
  if (level === "AAA") return { level: "AAA", teams: Object.values(session.state.teams), rosters: session.fixture.rosters, schedule: session.state.schedule, userTeamId: session.fixture.userTeamId };
  return null;
}

function stateForLevel(session, level) {
  if (session.levelStates?.[level]) return session.levelStates[level];
  return level === "AAA" ? session.state : null;
}

function setStateForLevel(session, level, state) {
  session.levelStates = { ...(session.levelStates ?? { AAA: session.state }), [level]: state };
  if (level === "AAA") session.state = state;
}

function currentUserLevel(session) {
  const level = session.fixture.organization?.userLevel ?? "AAA";
  return stateForLevel(session, level) ? level : "AAA";
}

function userTeamIdForLevel(session, level = currentUserLevel(session)) {
  return levelLeague(session, level)?.userTeamId ?? session.fixture.userTeamId;
}

function currentLevelState(session) { return stateForLevel(session, currentUserLevel(session)); }

function allFixtureRosters(fixture) {
  const byKey = new Map();
  const add = (roster) => { if (roster?.team?.id) byKey.set(roster.team.id, roster); };
  for (const roster of Object.values(fixture.rosters ?? {})) add(roster);
  for (const league of Object.values(fixture.levelLeagues ?? {})) for (const roster of Object.values(league.rosters ?? {})) add(roster);
  for (const affiliate of Object.values(fixture.organization?.levels ?? {})) add(affiliate?.roster);
  return [...byKey.values()];
}

function createLevelSeasonStates(fixture, seasonId, startDate) {
  const states = {};
  for (const level of SIMULATED_LEVELS) {
    const league = fixture.levelLeagues?.[level];
    if (!league) continue;
    states[level] = createSeasonState({
      seasonId: level === "AAA" ? seasonId : `${seasonId}_${level}`,
      leagueId: league.leagueId ?? `DEV_${level}_8`,
      teams: league.teams, schedule: league.schedule, userTeamId: league.userTeamId, userPlayerId: fixture.userPlayerId, startDate
    });
  }
  return states;
}

function positionProfileFromRoster(roster, playerId) {
  const player = roster.players?.[playerId] ?? null;
  if (player?.positioning?.primaryPosition) return player.positioning;
  const starter = roster.lineupSlots?.find((slot) => slot.starterId === playerId) ?? null;
  if (starter) return { primaryPosition: starter.position, familiarity: { [starter.position]: 1 } };
  const bench = roster.bench?.find((item) => item.playerId === playerId) ?? null;
  if (bench) {
    const primary = bench.coverage?.[0] ?? "DH";
    return { primaryPosition: primary, familiarity: Object.fromEntries((bench.coverage ?? [primary]).map((position) => [position, 1])) };
  }
  return { primaryPosition: "DH", familiarity: { DH: 1 } };
}

function developmentProfileForPlayer(fixture, playerId, player = null) {
  const startingProfile = playerId === fixture.userPlayerId
    ? fixture.careerProfile?.startingProfile ?? null
    : player?.realWorld?.hiddenDevelopmentPrior ?? null;
  return { seed: fixture.seed ?? "", startingProfile };
}

function initializePlayerStates(fixture) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const id of roster.positionPlayers ?? []) {
    if (!states[id]) states[id] = createPositionPlayerSeasonState(roster.players[id], positionProfileFromRoster(roster, id), developmentProfileForPlayer(fixture, id, roster.players[id]));
  }
  return states;
}

function normalizePlayerStates(fixture, existing = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const id of roster.positionPlayers ?? []) {
    if (states[id]) continue;
    states[id] = normalizePositionPlayerSeasonState(existing[id] ?? null, roster.players[id], positionProfileFromRoster(roster, id), developmentProfileForPlayer(fixture, id, roster.players[id]));
  }
  return states;
}
function initializePitcherStates(fixture) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const id of roster.pitchers ?? []) {
    if (!states[id]) states[id] = createPitcherSeasonState(roster.players[id], developmentProfileForPlayer(fixture, id, roster.players[id]));
  }
  return states;
}

function normalizePitcherStates(fixture, existing = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const id of roster.pitchers ?? []) {
    if (states[id]) continue;
    states[id] = normalizePitcherSeasonState(existing[id] ?? null, roster.players[id], developmentProfileForPlayer(fixture, id, roster.players[id]));
  }
  return states;
}

function fixtureLevelForPlayer(fixture, playerId) {
  for (const level of fixture.organization?.levelOrder ?? []) {
    if (fixture.organization?.levels?.[level]?.roster?.players?.[playerId]) return level;
  }
  for (const [level, league] of Object.entries(fixture.levelLeagues ?? {})) {
    for (const roster of Object.values(league.rosters ?? {})) if (roster.players?.[playerId]) return level;
  }
  return "AA";
}

function initializeScoutingStates(fixture, playerStates, pitcherStates, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const [id, player] of Object.entries(roster.players ?? {})) {
    if (states[id]) continue;
    const age = playerStates?.[id]?.health?.age ?? pitcherStates?.[id]?.health?.age ?? player?.physical?.age ?? null;
    states[id] = createScoutingState(player, { seed: fixture.seed ?? "", level: fixtureLevelForPlayer(fixture, id), age, startDate });
  }
  return states;
}

function normalizeScoutingStates(fixture, existing, playerStates, pitcherStates, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) for (const [id, player] of Object.entries(roster.players ?? {})) {
    if (states[id]) continue;
    const age = playerStates?.[id]?.health?.age ?? pitcherStates?.[id]?.health?.age ?? player?.physical?.age ?? null;
    states[id] = normalizeScoutingState(existing?.[id] ?? null, player, { seed: fixture.seed ?? "", level: fixtureLevelForPlayer(fixture, id), age, startDate });
  }
  return states;
}

function initializeContractStates(fixture, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) {
    for (const [id, player] of Object.entries(roster.players ?? {})) {
      if (states[id]) continue;
      states[id] = createContractState({
        playerId: id,
        player,
        startDate,
        initialLevel: fixtureLevelForPlayer(fixture, id),
        isUser: id === fixture.userPlayerId
      });
    }
  }
  return states;
}

function normalizeContractStatesForFixture(fixture, existing = {}, { startDate = fixture?.startDate ?? "2026-04-01", resetClock = false } = {}) {
  const states = structuredClone(existing ?? {});
  for (const roster of allFixtureRosters(fixture)) {
    for (const [id, player] of Object.entries(roster.players ?? {})) {
      states[id] = normalizeContractState(states[id] ?? null, {
        playerId: id,
        player,
        startDate,
        initialLevel: fixtureLevelForPlayer(fixture, id),
        isUser: id === fixture.userPlayerId,
        resetClock
      });
    }
  }
  return states;
}

function fixtureOrganizationIdForPlayer(fixture, playerId, player = null) {
  for (const level of fixture.organization?.levelOrder ?? []) {
    if (fixture.organization?.levels?.[level]?.roster?.players?.[playerId]) return String(fixture.organization.id);
  }
  return player?.realWorld?.organizationId != null ? String(player.realWorld.organizationId) : null;
}

function initializeRosterControlStates(fixture, { startDate = fixture?.startDate ?? "2026-04-01" } = {}) {
  const states = {};
  for (const roster of allFixtureRosters(fixture)) {
    for (const [id, player] of Object.entries(roster.players ?? {})) {
      if (states[id]) continue;
      states[id] = createRosterControlState({
        playerId: id,
        player,
        startDate,
        initialLevel: fixtureLevelForPlayer(fixture, id),
        organizationId: fixtureOrganizationIdForPlayer(fixture, id, player),
        isUser: id === fixture.userPlayerId
      });
    }
  }
  return states;
}

function normalizeRosterControlStatesForFixture(fixture, existing = {}, { startDate = fixture?.startDate ?? "2026-04-01", resetSeason = false } = {}) {
  const states = structuredClone(existing ?? {});
  for (const roster of allFixtureRosters(fixture)) {
    for (const [id, player] of Object.entries(roster.players ?? {})) {
      const currentLevel = fixtureLevelForPlayer(fixture, id);
      states[id] = normalizeRosterControlState(states[id] ?? null, {
        playerId: id,
        player,
        startDate,
        currentLevel,
        initialLevel: currentLevel,
        organizationId: fixtureOrganizationIdForPlayer(fixture, id, player),
        isUser: id === fixture.userPlayerId,
        resetSeason
      });
    }
  }
  return states;
}

function currentOrganizationPlayerIds(session) {
  const ids = [];
  for (const level of session.fixture.organization?.levelOrder ?? []) {
    ids.push(...Object.keys(session.fixture.organization?.levels?.[level]?.roster?.players ?? {}));
  }
  return [...new Set(ids)];
}

function advanceCurrentOrganizationRosterControlStates(session, date) {
  if (!session.rosterControlStates) return;
  const next = { ...session.rosterControlStates };
  for (const id of currentOrganizationPlayerIds(session)) {
    if (!next[id]) continue;
    next[id] = advanceRosterControlToDate(next[id], { toDate: date });
  }
  session.rosterControlStates = next;
}

function currentOrganizationKnownFortyManCount(session) {
  return knownFortyManCount(session.rosterControlStates ?? {}, currentOrganizationPlayerIds(session));
}

function currentMlbPlayerIds(session) {
  const league = levelLeague(session, "MLB");
  return [...new Set(Object.values(league?.rosters ?? {}).flatMap((roster) => Object.keys(roster.players ?? {})))];
}

function advanceCurrentMlbContractStates(session, date) {
  if (!session.contractStates) return;
  const serviceWindow = getMlbServiceWindow(session.fixture);
  if (!serviceWindow) return;
  const next = { ...session.contractStates };
  for (const id of currentMlbPlayerIds(session)) {
    if (!next[id]) continue;
    next[id] = advanceContractStateToDate(next[id], { toDate: date, level: "MLB", serviceWindow });
  }
  session.contractStates = next;
}

function reconcileCurrentMlbServiceDate(session, date) {
  if (!session.contractStates) return;
  const serviceWindow = getMlbServiceWindow(session.fixture);
  if (!serviceWindow) return;
  const next = { ...session.contractStates };
  for (const id of currentMlbPlayerIds(session)) {
    if (!next[id]) continue;
    next[id] = creditContractServiceDate(next[id], { date, level: "MLB", serviceWindow });
  }
  session.contractStates = next;
}

function recoverAllPlayersToDate(session, date) {
  const days = daysBetween(session.playerStateDate, date);
  if (days > 0) {
    advanceCurrentMlbContractStates(session, date);
    advanceCurrentOrganizationRosterControlStates(session, date);
    session.playerStates = Object.fromEntries(Object.entries(session.playerStates).map(([id, state]) => [id, recoverPositionPlayer(state, days)]));
    session.pitcherStates = Object.fromEntries(Object.entries(session.pitcherStates).map(([id, state]) => {
      const player = findPlayer(session, id);
      return [id, recoverPitcherSeasonState(state, player, days)];
    }));
    session.playerStateDate = date;
  }
  for (const level of SIMULATED_LEVELS) {
    const state = stateForLevel(session, level);
    if (state && state.currentDate !== date) setStateForLevel(session, level, setSeasonCurrentDate(state, date));
  }
}

function organizationPlayerRecord(session, playerId) {
  for (const level of session.fixture.organization?.levelOrder ?? []) {
    const affiliate = session.fixture.organization?.levels?.[level];
    const roster = affiliate?.roster;
    if (roster?.players?.[playerId]) return { level, affiliate, roster, player: roster.players[playerId] };
  }
  return null;
}

function findPlayer(session, playerId) {
  for (const roster of allFixtureRosters(session.fixture)) if (roster.players?.[playerId]) return roster.players[playerId];
  const organizationRecord = organizationPlayerRecord(session, playerId);
  if (organizationRecord) return organizationRecord.player;
  throw new RangeError(`시즌 Player를 찾을 수 없습니다: ${playerId}`);
}
function scheduleGameById(session, gameId, level = session.activeLevel ?? currentUserLevel(session)) {
  const state = stateForLevel(session, level);
  const game = state?.schedule.find((item) => item.gameId === gameId);
  if (!game) throw new RangeError(`시즌 경기 일정을 찾을 수 없습니다: ${level}:${gameId}`);
  return game;
}
function userSideForGame(session, game, level = currentUserLevel(session)) {
  const userTeamId = userTeamIdForLevel(session, level);
  if (game.awayTeamId === userTeamId) return "away";
  if (game.homeTeamId === userTeamId) return "home";
  return null;
}
function battingMapFromResult(result, side) { return result.boxScore.teams[side].batting; }
function battingMapFromSnapshot(snapshot, side) { return Object.fromEntries((snapshot.boxScore?.batting?.[side] ?? []).map((line) => [line.id, line])); }
function pitchingMapFromResult(result, side) { return result.boxScore.teams[side].pitching; }
function pitchingMapFromSnapshot(snapshot, side) { return Object.fromEntries((snapshot.boxScore?.pitching?.[side] ?? []).map((line) => [line.id, line])); }
function mergeBattingMaps(bySide) { return { ...(bySide.away ?? {}), ...(bySide.home ?? {}) }; }
function mergePitchingMaps(bySide) { return { ...(bySide.away ?? {}), ...(bySide.home ?? {}) }; }

function baseOccupancy(bases) {
  if (!bases) return null;
  return { first: Boolean(bases.first), second: Boolean(bases.second), third: Boolean(bases.third) };
}

function contextTeamFields(fixture, side) {
  const opponentSide = side === "away" ? "home" : "away";
  return {
    userSide: side,
    teamName: fixture.teams?.[side]?.name ?? fixture.teams?.[side]?.shortName ?? null,
    opponentTeamName: fixture.teams?.[opponentSide]?.name ?? fixture.teams?.[opponentSide]?.shortName ?? null
  };
}

function paMomentContext(record, fixture, side) {
  const stat = record?.statEvent ?? null;
  const before = record?.before ?? null;
  const after = record?.after ?? null;
  if (!stat || !before) return null;
  const sameHalf = after && before.inning === after.inning && before.half === after.half;
  return {
    kind: "PA", phase: "PA", inning: stat.inning ?? before.inning ?? null, half: stat.half ?? before.half ?? null,
    paNumber: stat.paNumber ?? null, outsBefore: before.outs ?? null,
    outsAfter: Math.min(3, Number(before.outs ?? 0) + Number(stat.pitching?.outsRecorded ?? 0)),
    basesBefore: baseOccupancy(before.bases), basesAfter: sameHalf ? baseOccupancy(after?.bases) : null,
    scoreBefore: before.score ?? null, scoreAfter: after?.score ?? null,
    outcome: stat.outcome ?? null, rbi: Number(stat.batting?.RBI ?? 0),
    runsScored: Number(stat.scoredRunnerIds?.length ?? 0), pitchCount: Number(stat.pitching?.Pitches ?? 0),
    ...contextTeamFields(fixture, side)
  };
}

function runningMomentContextFromSimLog(record, play, fixture, side) {
  const stateAfterRun = record?.before ?? null;
  if (!stateAfterRun || !play) return null;
  const beforeBases = { ...(stateAfterRun.bases ?? {}) };
  if (play.toBase && play.toBase !== "home") beforeBases[play.toBase] = null;
  if (play.fromBase) beforeBases[play.fromBase] = play.runnerId ?? true;
  return {
    kind: "RUNNING", phase: "PRE_PA", inning: stateAfterRun.inning ?? null, half: stateAfterRun.half ?? null,
    paNumber: record?.statEvent?.paNumber ?? null, outsBefore: stateAfterRun.outs ?? null, outsAfter: stateAfterRun.outs ?? null,
    basesBefore: baseOccupancy(beforeBases), basesAfter: baseOccupancy(stateAfterRun.bases),
    scoreBefore: stateAfterRun.score ?? null, scoreAfter: stateAfterRun.score ?? null,
    runningKind: play.kind ?? null, fromBase: play.fromBase ?? null, toBase: play.toBase ?? null,
    ...contextTeamFields(fixture, side)
  };
}

function enrichSnapshotEventContext(event, fixture, side) {
  if (!event) return null;
  return { ...event, ...contextTeamFields(fixture, side) };
}

function collectMomentContextsFromSimResult(result, fixture, playerId) {
  const side = fixture?.userTeam ?? null;
  if (!side || !playerId) return null;
  const contexts = {};
  const hitOutcomes = new Set(["1B", "2B", "3B", "HR"]);
  for (const record of result?.log ?? []) {
    for (const play of record?.prePAEvents ?? []) {
      if (play?.runnerId === playerId && play.kind === "SB" && !contexts.FIRST_MLB_SB) {
        contexts.FIRST_MLB_SB = runningMomentContextFromSimLog(record, play, fixture, side);
      }
    }
    if (record?.batterId !== playerId) continue;
    const context = paMomentContext(record, fixture, side);
    if (!contexts.APPEARANCE) contexts.APPEARANCE = context;
    const outcome = record?.statEvent?.outcome ?? null;
    if (!contexts.FIRST_MLB_HIT && hitOutcomes.has(outcome)) contexts.FIRST_MLB_HIT = context;
    if (!contexts.FIRST_MLB_HR && outcome === "HR") contexts.FIRST_MLB_HR = context;
    if (!contexts.FIRST_MLB_RBI && Number(record?.statEvent?.batting?.RBI ?? 0) > 0) contexts.FIRST_MLB_RBI = context;
  }
  return contexts;
}

function collectMomentContextsFromGameSnapshot(snapshot, fixture, playerId) {
  const side = fixture?.userTeam ?? null;
  if (!side || !playerId) return null;
  const contexts = {};
  const hitOutcomes = new Set(["1B", "2B", "3B", "HR"]);
  for (const event of snapshot?.userOfficialEvents ?? []) {
    const context = enrichSnapshotEventContext(event, fixture, side);
    if (event.kind === "RUNNING") {
      if (event.runningKind === "SB" && !contexts.FIRST_MLB_SB) contexts.FIRST_MLB_SB = context;
      continue;
    }
    if (event.kind !== "PA") continue;
    if (!contexts.APPEARANCE) contexts.APPEARANCE = context;
    if (!contexts.FIRST_MLB_HIT && hitOutcomes.has(event.outcome)) contexts.FIRST_MLB_HIT = context;
    if (!contexts.FIRST_MLB_HR && event.outcome === "HR") contexts.FIRST_MLB_HR = context;
    if (!contexts.FIRST_MLB_RBI && Number(event.rbi ?? 0) > 0) contexts.FIRST_MLB_RBI = context;
  }
  return contexts;
}

function inferCompletedCareerMomentKeys(levelStates) {
  const completed = new Set();
  const states = levelStates ?? {};
  const anyAppearance = Object.values(states).some((state) => Number(state?.userSeason?.G ?? 0) > 0);
  if (anyAppearance) completed.add("PRO_DEBUT");
  const mlb = states.MLB?.userSeason ?? null;
  if (Number(mlb?.G ?? 0) > 0) completed.add("MLB_DEBUT");
  if (Number(mlb?.H ?? 0) > 0) completed.add("FIRST_MLB_HIT");
  if (Number(mlb?.HR ?? 0) > 0) completed.add("FIRST_MLB_HR");
  if (Number(mlb?.RBI ?? 0) > 0) completed.add("FIRST_MLB_RBI");
  if (Number(mlb?.SB ?? 0) > 0) completed.add("FIRST_MLB_SB");
  return [...completed];
}

function recordCompletedGameCareerMoments(session, level, game, fixture, battingBySide, momentContexts = null) {
  const playerId = session.fixture.userPlayerId;
  const side = fixture?.userPlayerId === playerId ? fixture.userTeam : null;
  if (!side) return;
  const battingLine = battingBySide?.[side]?.[playerId] ?? null;
  const teamId = fixture.teams?.[side]?.id ?? null;
  const opponentSide = side === "away" ? "home" : "away";
  const opponentTeamId = fixture.teams?.[opponentSide]?.id ?? null;
  session.careerEventState = recordGameCareerMoments(session.careerEventState, {
    playerId, date: game.date, level, gameId: game.gameId, appeared: true, battingLine, teamId, opponentTeamId, momentContexts
  });
}

function positionForFixturePlayer(fixture, side, playerId, finalState = null) {
  for (const [position, id] of Object.entries(fixture.initialState.defensiveAlignment?.[side] ?? {})) {
    if (position !== "P" && id === playerId) return position;
  }
  const incoming = (finalState?.substitutions ?? []).find((row) => row.team === side && row.inPlayerId === playerId);
  if (incoming?.position) return incoming.position;
  return "DH";
}

function appearanceTypeForFixturePlayer(fixture, side, playerId, finalState = null) {
  if ((fixture.initialState.lineups?.[side] ?? []).includes(playerId)) return "START";
  const incoming = (finalState?.substitutions ?? []).find((row) => row.team === side && row.inPlayerId === playerId);
  return incoming?.reason ?? "START";
}

function participantIdsForSide(fixture, side, lines, finalState = null) {
  const ids = new Set(fixture.initialState.lineups?.[side] ?? []);
  for (const playerId of Object.keys(lines ?? {})) ids.add(playerId);
  for (const row of finalState?.substitutions ?? []) {
    if (row.team !== side) continue;
    ids.add(row.outPlayerId);
    ids.add(row.inPlayerId);
  }
  return [...ids];
}

function injuryActivityForPosition(position, appearanceType) {
  if (appearanceType === "PINCH_HIT") return "PINCH_HIT";
  if (appearanceType === "PINCH_RUN") return "PINCH_RUN";
  if (appearanceType === "DEFENSIVE_REPLACEMENT") return "DEFENSIVE_REPLACEMENT";
  if (position === "C") return "CATCHER_START";
  return "POSITION_START";
}

function applyPostgamePositionInjury(session, fixture, player, state, { position, appearanceType, date }) {
  const checked = maybeApplyInjury(state.health, player, {
    seed: `${fixture.seed}:${player.id}:${appearanceType}:${position}`,
    date,
    fatigue: state.fatigue,
    age: player?.physical?.age ?? null,
    activity: injuryActivityForPosition(position, appearanceType),
    kind: "POSITION"
  });
  return checked.event ? freeze({ ...state, health: checked.health }) : state;
}

function applyPostgamePitcherInjury(fixture, player, state, { side, playerId, date }) {
  const starterId = fixture.initialState.currentPitcherId?.[side] ?? null;
  const activity = starterId === playerId ? "PITCHER_START" : "PITCHER_RELIEF";
  const checked = maybeApplyInjury(state.health, player, {
    seed: `${fixture.seed}:${player.id}:${activity}`,
    date,
    fatigue: state.fatigue,
    age: player?.physical?.age ?? null,
    activity,
    kind: "PITCHER"
  });
  return checked.event ? freeze({ ...state, health: checked.health }) : state;
}

function applyCompletedGamePlayerStates(session, fixture, battingBySide, date, finalState = null) {
  for (const side of ["away", "home"]) {
    const lines = battingBySide[side] ?? {};
    for (const playerId of participantIdsForSide(fixture, side, lines, finalState)) {
      const player = findPlayer(session, playerId);
      const line = lines[playerId] ?? { PA: 0 };
      const current = session.playerStates[playerId] ?? createPositionPlayerSeasonState(player);
      const position = positionForFixturePlayer(fixture, side, playerId, finalState);
      const appearanceType = appearanceTypeForFixturePlayer(fixture, side, playerId, finalState);
      const played = applyPositionPlayerGame(current, player, { battingLine: line, position, appearanceType, date, level: fixture.level ?? "AAA" });
      session.playerStates[playerId] = applyPostgamePositionInjury(session, fixture, player, played, { position, appearanceType, date });
    }
  }
}

function applyCompletedGameRoleStates(session, fixture, battingBySide, date, finalState = null) {
  for (const side of ["away", "home"]) {
    const lines = battingBySide[side] ?? {};
    for (const playerId of participantIdsForSide(fixture, side, lines, finalState)) {
      const current = session.roleStates?.[playerId];
      if (!current) continue;
      const played = applyRoleGame(current, { battingLine: lines[playerId] ?? { PA: 0 }, date });
      const reviewed = reviewRoleIfDue(played, { date });
      session.roleStates = { ...session.roleStates, [playerId]: reviewed };
      if (playerId === session.fixture.userPlayerId && reviewed.role !== current.role) {
        session.careerEventState = recordRoleChangeCareerEvent(session.careerEventState, {
          playerId, date, level: reviewed.level, fromRole: current.role, toRole: reviewed.role
        });
      }
    }
  }
}

function applyCompletedGamePitcherStates(session, fixture, pitchingBySide, date) {
  for (const side of ["away", "home"]) {
    for (const [playerId, line] of Object.entries(pitchingBySide[side] ?? {})) {
      let player;
      try { player = findPlayer(session, playerId); } catch { continue; }
      if (!player?.pitching) continue;
      const current = session.pitcherStates[playerId] ?? createPitcherSeasonState(player);
      const played = applyPitcherSeasonGame(current, player, { pitchCount: Number(line.Pitches ?? 0), pitchingLine: line, date, level: fixture.level ?? "AAA" });
      session.pitcherStates[playerId] = applyPostgamePitcherInjury(fixture, player, played, { side, playerId, date });
    }
  }
}

function nextUserGame(session) {
  const level = currentUserLevel(session);
  const state = stateForLevel(session, level);
  return state ? getNextTeamGame(state, userTeamIdForLevel(session, level)) : null;
}

function earliestPendingWorldDate(session) {
  let earliest = null;
  for (const level of SIMULATED_LEVELS) {
    const state = stateForLevel(session, level);
    if (!state) continue;
    for (const game of state.schedule) {
      if (game.status === "FINAL") continue;
      if (earliest === null || game.date < earliest) earliest = game.date;
    }
  }
  return earliest;
}

function prepareNextUserGameChronologically(session) {
  let safety = 0;
  while (!worldComplete(session)) {
    const level = currentUserLevel(session);
    const game = nextUserGame(session);
    if (!game) return { level, game: null };

    const earliest = earliestPendingWorldDate(session);
    if (earliest === null || earliest >= game.date) return { level, game };
    if (earliest < session.playerStateDate) {
      throw new RangeError(`미처리 월드 일정이 현재 날짜보다 과거입니다: ${earliest} < ${session.playerStateDate}`);
    }

    recoverAllPlayersToDate(session, earliest);
    simulateWorldDate(session, earliest);
    runOrganizationReviewIfDue(session, earliest);
    applySeasonEndAgingIfNeeded(session);

    safety += 1;
    if (safety > 420) throw new RangeError("사용자 경기 전 월드 일정 정리가 안전 한도를 초과했습니다.");
  }
  return { level: currentUserLevel(session), game: nextUserGame(session) };
}

function updateCurrentDateToNextUserGame(session) {
  const next = nextUserGame(session);
  if (!next) return;
  const earliest = earliestPendingWorldDate(session);
  const target = earliest && earliest < next.date ? earliest : next.date;
  if (target >= session.playerStateDate) recoverAllPlayersToDate(session, target);
}

function recordResult(session, level, game, { awayRuns, homeRuns, userBattingLine = null, battingBySide = null, pitchingBySide = null, startingPitcherIds = [] }) {
  const state = stateForLevel(session, level);
  setStateForLevel(session, level, recordSeasonGame(state, {
    gameId: game.gameId, awayRuns, homeRuns, userBattingLine,
    battingByPlayer: battingBySide ? mergeBattingMaps(battingBySide) : null,
    pitchingByPlayer: pitchingBySide ? mergePitchingMaps(pitchingBySide) : null,
    startingPitcherIds
  }));
}

function finalizeSimulatedFixture(session, level, game, fixture, result) {
  const battingBySide = { away: battingMapFromResult(result, "away"), home: battingMapFromResult(result, "home") };
  const pitchingBySide = { away: pitchingMapFromResult(result, "away"), home: pitchingMapFromResult(result, "home") };
  const userBattingLine = fixture.userPlayerId && fixture.userTeam ? battingBySide[fixture.userTeam][session.fixture.userPlayerId] ?? null : null;
  recordResult(session, level, game, {
    awayRuns: result.awayRuns, homeRuns: result.homeRuns, userBattingLine, battingBySide, pitchingBySide,
    startingPitcherIds: [fixture.initialState.currentPitcherId.away, fixture.initialState.currentPitcherId.home]
  });
  recordCompletedGameCareerMoments(session, level, game, fixture, battingBySide, collectMomentContextsFromSimResult(result, fixture, session.fixture.userPlayerId));
  applyCompletedGamePlayerStates(session, fixture, battingBySide, game.date, result.state);
  applyCompletedGameRoleStates(session, fixture, battingBySide, game.date, result.state);
  applyCompletedGamePitcherStates(session, fixture, pitchingBySide, game.date);
}

function simulateScheduledGame(session, level, game, { skipRecovery = false } = {}) {
  if (!skipRecovery) recoverAllPlayersToDate(session, game.date);
  const fixture = createSeasonGameFixture({ seasonFixture: session.fixture, scheduleGame: game, playerStates: session.playerStates, pitcherStates: session.pitcherStates, roleStates: session.roleStates, level });
  const result = simulateSeasonFixtureGame(fixture, { seed: level === "AAA" ? `${session.fixture.seed}:${game.gameId}` : `${session.fixture.seed}:${level}:${game.gameId}` });
  finalizeSimulatedFixture(session, level, game, fixture, result);
  return result;
}

function simulateWorldDate(session, date, { excludeLevel = null, excludeGameId = null } = {}) {
  recoverAllPlayersToDate(session, date);
  for (const level of SIMULATED_LEVELS) {
    const state = stateForLevel(session, level);
    if (!state) continue;
    for (const game of getGamesOnDate(state, date)) {
      if (game.status === "FINAL") continue;
      if (level === excludeLevel && game.gameId === excludeGameId) continue;
      simulateScheduledGame(session, level, game);
    }
  }
}

function worldComplete(session) {
  return SIMULATED_LEVELS.every((level) => !stateForLevel(session, level) || stateForLevel(session, level).status === "COMPLETE");
}

function seasonAgingKey(session) {
  const startDate = session.fixture?.startDate ?? session.state?.startDate ?? session.state?.currentDate ?? "unknown";
  return session.state.seasonId + ":" + String(startDate).slice(0, 10);
}

function applySeasonEndAgingIfNeeded(session) {
  if (!worldComplete(session)) return { appliedPosition: 0, appliedPitcher: 0, developedPosition: 0, developedPitcher: 0, migrations: 0 };
  const seasonKey = seasonAgingKey(session);
  let appliedPosition = 0;
  let appliedPitcher = 0;
  let developedPosition = 0;
  let developedPitcher = 0;
  let migrations = 0;
  const nextPlayerStates = { ...session.playerStates };
  for (const [playerId, state] of Object.entries(session.playerStates ?? {})) {
    const player = findPlayer(session, playerId);
    const developed = applyAnnualPositionPlayerDevelopment(state, player, { seasonKey });
    const result = applyAnnualPositionPlayerAging(developed.state, player, { seasonKey });
    nextPlayerStates[playerId] = result.state;
    if (developed.applied) developedPosition += 1;
    if (result.applied) appliedPosition += 1;
    if (result.migration) migrations += 1;
  }
  const nextPitcherStates = { ...session.pitcherStates };
  for (const [playerId, state] of Object.entries(session.pitcherStates ?? {})) {
    const player = findPlayer(session, playerId);
    const developed = applyAnnualPitcherSeasonDevelopment(state, player, { seasonKey });
    const result = applyAnnualPitcherAging(developed.state, player, { seasonKey });
    nextPitcherStates[playerId] = result.state;
    if (developed.applied) developedPitcher += 1;
    if (result.applied) appliedPitcher += 1;
  }
  session.playerStates = nextPlayerStates;
  session.pitcherStates = nextPitcherStates;
  // Offseason development/aging changes hidden talent. Re-scout once after the
  // completed-season pass; the review key makes repeated completed-season opens
  // idempotent just like aging/development.
  applyOrganizationScoutingReview(session, session.state.currentDate, `offseason:${seasonKey}`);
  return { appliedPosition, appliedPitcher, developedPosition, developedPitcher, migrations };
}

function advanceCompletedProductionSeason(session) {
  if (!worldComplete(session)) throw new RangeError("완료된 시즌만 다음 시즌으로 진행할 수 있습니다.");
  if (session.fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("현재 다음 시즌 진행은 Production 커리어에서만 지원합니다.");
  clearActiveGame(session);
  applySeasonEndAgingIfNeeded(session);
  const currentYear = Number(String(session.fixture.startDate ?? session.state.startDate).slice(0, 4));
  if (!Number.isInteger(currentYear)) throw new RangeError("현재 시즌 연도를 확인할 수 없습니다.");
  const nextStartDate = `${currentYear + 1}-03-25`;

  // Heal offseason injuries/fatigue on the authoritative player states before
  // seasonal counters are reset. Long-term development/aging/scouting state is
  // intentionally preserved across years.
  recoverAllPlayersToDate(session, nextStartDate);
  const scheduledFixture = createNextProductionSeasonFixture(session.fixture, { startDate: nextStartDate });
  const ecology = advanceProductionOffseasonEcology({
    fixture: scheduledFixture,
    dataUniverse: session.dataUniverse,
    playerStates: session.playerStates,
    pitcherStates: session.pitcherStates,
    ecologyState: session.leagueEcologyState,
    year: currentYear + 1,
    userPlayerId: session.fixture.userPlayerId
  });
  session.fixture = ecology.fixture;
  session.leagueEcologyState = ecology.ecologyState;
  session.contractStates = normalizeContractStatesForFixture(session.fixture, session.contractStates ?? {}, {
    startDate: nextStartDate,
    resetClock: true
  });
  session.rosterControlStates = normalizeRosterControlStatesForFixture(session.fixture, session.rosterControlStates ?? {}, {
    startDate: nextStartDate,
    resetSeason: true
  });
  const reset = resetSeasonStatesForNewYear({ playerStates: ecology.playerStates, pitcherStates: ecology.pitcherStates, roleStates: session.roleStates, startDate: nextStartDate });
  session.playerStates = reset.playerStates;
  session.pitcherStates = reset.pitcherStates;
  session.roleStates = normalizeRoleStates(reset.roleStates, session.fixture, { startDate: nextStartDate });
  session.scoutingStates = normalizeScoutingStates(session.fixture, session.scoutingStates, session.playerStates, session.pitcherStates, { startDate: nextStartDate });
  session.organizationState = normalizeOrganizationReviewState({
    ...(session.organizationState ?? {}),
    lastReviewDate: nextStartDate,
    latestEvaluations: {}
  }, { startDate: nextStartDate });

  const seasonId = session.state.seasonId;
  session.levelStates = createLevelSeasonStates(session.fixture, seasonId, nextStartDate);
  session.state = session.levelStates.AAA;
  session.playerStateDate = nextStartDate;
  reconcileCurrentMlbServiceDate(session, nextStartDate);
  session.lastProgress = null;
  session.activeGameId = null;
  session.activeScheduleGameId = null;
  session.activeLevel = null;
  session.finalizedActiveGameId = null;
  session.activeFixture = null;
  return snapshot(session);
}

function finalizeInteractiveGameIfNeeded(session, gameSnapshot) {
  if (!gameSnapshot || gameSnapshot.status !== "FINAL" || !session.activeScheduleGameId) return false;
  if (session.finalizedActiveGameId === session.activeScheduleGameId) return false;
  const level = session.activeLevel ?? currentUserLevel(session);
  const game = scheduleGameById(session, session.activeScheduleGameId, level), fixture = session.activeFixture;
  const battingBySide = { away: battingMapFromSnapshot(gameSnapshot, "away"), home: battingMapFromSnapshot(gameSnapshot, "home") };
  const pitchingBySide = { away: pitchingMapFromSnapshot(gameSnapshot, "away"), home: pitchingMapFromSnapshot(gameSnapshot, "home") };
  recordResult(session, level, game, {
    awayRuns: gameSnapshot.score.away, homeRuns: gameSnapshot.score.home, userBattingLine: gameSnapshot.userLine, battingBySide, pitchingBySide,
    startingPitcherIds: [fixture.initialState.currentPitcherId.away, fixture.initialState.currentPitcherId.home]
  });
  recordCompletedGameCareerMoments(session, level, game, fixture, battingBySide, collectMomentContextsFromGameSnapshot(gameSnapshot, fixture, session.fixture.userPlayerId));
  applyCompletedGamePlayerStates(session, fixture, battingBySide, game.date, gameSnapshot);
  applyCompletedGameRoleStates(session, fixture, battingBySide, game.date, gameSnapshot);
  applyCompletedGamePitcherStates(session, fixture, pitchingBySide, game.date);
  simulateWorldDate(session, game.date, { excludeLevel: level, excludeGameId: game.gameId });
  runOrganizationReviewIfDue(session, game.date);
  applySeasonEndAgingIfNeeded(session);
  session.finalizedActiveGameId = game.gameId; session.activeFixture = null;
  updateCurrentDateToNextUserGame(session);
  return true;
}

function teamRecord(session, level = currentUserLevel(session)) {
  const state = stateForLevel(session, level);
  const teamId = userTeamIdForLevel(session, level);
  const line = state.standings[teamId];
  return { ...line, games: line.W + line.L, pct: line.W + line.L > 0 ? line.W / (line.W + line.L) : 0 };
}
function scheduleGameView(session, game, level = currentUserLevel(session)) {
  if (!game) return null;
  const state = stateForLevel(session, level);
  const userTeamId = userTeamIdForLevel(session, level);
  const away = state.teams[game.awayTeamId], home = state.teams[game.homeTeamId];
  return { ...game, level, awayTeam: away, homeTeam: home, userSide: userSideForGame(session, game, level), opponent: game.awayTeamId === userTeamId ? home : away };
}
function currentSeriesView(session, nextGame, level = currentUserLevel(session)) {
  if (!nextGame) return null;
  const state = stateForLevel(session, level);
  const userTeamId = userTeamIdForLevel(session, level);
  const games = getSeriesGames(state, nextGame.seriesId)
    .filter((game) => game.awayTeamId === userTeamId || game.homeTeamId === userTeamId)
    .map((game) => scheduleGameView(session, game, level));
  return { seriesId: nextGame.seriesId, level, games, completed: games.filter((game) => game.status === "FINAL").length, total: games.length, opponent: scheduleGameView(session, nextGame, level).opponent };
}
function recentResultsView(session, level = currentUserLevel(session)) {
  const state = stateForLevel(session, level);
  const userTeamId = userTeamIdForLevel(session, level);
  return getRecentTeamResults(state, userTeamId, 6).map((game) => {
    const view = scheduleGameView(session, game, level);
    const userRuns = view.userSide === "home" ? game.homeRuns : game.awayRuns, oppRuns = view.userSide === "home" ? game.awayRuns : game.homeRuns;
    return { ...view, userRuns, oppRuns, result: userRuns > oppRuns ? "W" : "L" };
  });
}

function roleInfoFromRoster(roster, playerId) {
  const player = roster.players?.[playerId] ?? null;
  const profilePositions = Object.entries(player?.positioning?.familiarity ?? {}).filter(([, value]) => Number(value) >= 0.45).map(([position]) => position);
  const profilePrimary = player?.positioning?.primaryPosition ?? null;
  const starter = roster.lineupSlots?.find((slot) => slot.starterId === playerId) ?? null;
  if (starter) return { role: "STARTER", primaryPosition: profilePrimary ?? starter.position, positions: profilePositions.length ? profilePositions : [starter.position] };
  const bench = roster.bench?.find((item) => item.playerId === playerId) ?? null;
  if (bench) return { role: "BENCH", primaryPosition: profilePrimary ?? bench.coverage?.[0] ?? "DH", positions: profilePositions.length ? profilePositions : [...(bench.coverage ?? ["DH"])] };
  if (roster.starters?.includes(playerId)) return { role: "SP", primaryPosition: "P", positions: ["P"] };
  if (roster.bullpen?.includes(playerId)) return { role: roster.players[playerId].pitching?.role ?? "RP", primaryPosition: "P", positions: ["P"] };
  return { role: "ROSTER", primaryPosition: "DH", positions: ["DH"] };
}

function rosterRoleInfo(session, playerId) {
  const org = organizationPlayerRecord(session, playerId);
  if (org) return { teamId: org.affiliate.team.id, organizationLevel: org.level, ...roleInfoFromRoster(org.roster, playerId) };
  for (const level of SIMULATED_LEVELS) {
    const league = levelLeague(session, level);
    for (const [teamId, roster] of Object.entries(league?.rosters ?? {})) {
      if (!roster.players?.[playerId]) continue;
      return { teamId, organizationLevel: level, ...roleInfoFromRoster(roster, playerId) };
    }
  }
  return { teamId: null, organizationLevel: null, role: "UNKNOWN", primaryPosition: null, positions: [] };
}

function playerIdentity(session, playerId) {
  const rosterInfo = rosterRoleInfo(session, playerId);
  if (rosterInfo.teamId) {
    const level = rosterInfo.organizationLevel ?? currentUserLevel(session);
    const league = levelLeague(session, level);
    const roster = league?.rosters?.[rosterInfo.teamId] ?? organizationPlayerRecord(session, playerId)?.roster ?? null;
    const state = stateForLevel(session, level);
    const team = state?.teams?.[rosterInfo.teamId] ?? roster?.team ?? null;
    const positionState = session.playerStates?.[playerId] ?? null;
    const primaryPosition = positionState?.primaryPosition ?? rosterInfo.primaryPosition;
    const positions = [...new Set([primaryPosition, ...(rosterInfo.positions ?? []), ...Object.keys(positionState?.positionFamiliarity ?? {})].filter(Boolean))];
    return {
      id: playerId,
      name: roster?.names?.[playerId] ?? playerId,
      teamId: rosterInfo.teamId,
      team,
      organizationLevel: rosterInfo.organizationLevel,
      role: session.roleStates?.[playerId]?.role ?? rosterInfo.role,
      primaryPosition,
      positions,
      active: Boolean(state?.teams?.[rosterInfo.teamId])
    };
  }
  return { id: playerId, name: playerId, teamId: null, team: null, organizationLevel: null, role: "UNKNOWN", primaryPosition: null, positions: [], active: false };
}

function visibleRatings(player) {
  return {
    contactR: player.hitting?.contactR ?? null,
    contactL: player.hitting?.contactL ?? null,
    rawPower: player.hitting?.rawPower ?? null,
    vision: player.hitting?.vision ?? null,
    discipline: player.hitting?.discipline ?? null,
    fielding: player.fielding?.fielding ?? null,
    reaction: player.fielding?.reaction ?? null,
    armStrength: player.fielding?.armStrength ?? null,
    armAccuracy: player.fielding?.armAccuracy ?? null,
    speed: player.running?.speed ?? null,
    stealing: player.running?.stealing ?? null,
    baserunning: player.running?.baserunning ?? null
  };
}

const LEADER_SPECS = Object.freeze([
  Object.freeze({ key: "AVG", label: "AVG", qualify: true, format: "RATE" }),
  Object.freeze({ key: "OBP", label: "OBP", qualify: true, format: "RATE" }),
  Object.freeze({ key: "SLG", label: "SLG", qualify: true, format: "RATE" }),
  Object.freeze({ key: "OPS", label: "OPS", qualify: true, format: "RATE" }),
  Object.freeze({ key: "HR", label: "HR", qualify: false, format: "COUNT" }),
  Object.freeze({ key: "RBI", label: "RBI", qualify: false, format: "COUNT" }),
  Object.freeze({ key: "H", label: "H", qualify: false, format: "COUNT" }),
  Object.freeze({ key: "BB", label: "BB", qualify: false, format: "COUNT" }),
  Object.freeze({ key: "SB", label: "SB", qualify: false, format: "COUNT" })
]);

function rankedCategory(rows, spec, minPA, userPlayerId) {
  const eligible = rows
    .filter((row) => !spec.qualify || row.PA >= minPA)
    .sort((a, b) => Number(b[spec.key] ?? 0) - Number(a[spec.key] ?? 0) || b.PA - a.PA || a.id.localeCompare(b.id))
    .map((row, index) => ({ rank: index + 1, ...row, value: Number(row[spec.key] ?? 0) }));
  const userIndex = eligible.findIndex((row) => row.id === userPlayerId);
  const userRank = userIndex >= 0 ? userIndex + 1 : null;
  const neighborhood = userIndex >= 10
    ? eligible.slice(Math.max(0, userIndex - 2), Math.min(eligible.length, userIndex + 3))
    : [];
  return {
    key: spec.key, label: spec.label, format: spec.format, qualificationRequired: spec.qualify,
    qualificationPA: spec.qualify ? minPA : 0, totalEligible: eligible.length, userRank,
    top: eligible.slice(0, 10), neighborhood
  };
}

function leadersView(session, level = currentUserLevel(session)) {
  const state = stateForLevel(session, level);
  const all = getAllPlayerSeasonBatting(state);
  const maxTeamGames = Math.max(0, ...Object.values(state.standings).map((line) => line.W + line.L));
  const minPA = Math.max(1, Math.floor(maxTeamGames * 2.2));
  const rows = Object.entries(all).map(([id, line]) => ({ ...playerIdentity(session, id), ...line }));
  const categories = Object.fromEntries(LEADER_SPECS.map((spec) => [spec.key, rankedCategory(rows, spec, minPA, session.fixture.userPlayerId)]));
  return {
    qualificationPA: minPA,
    categoryOrder: LEADER_SPECS.map((spec) => spec.key),
    categories,
    // v13-v18 compatibility for compact home/legacy consumers.
    AVG: categories.AVG.top.slice(0, 5),
    OPS: categories.OPS.top.slice(0, 5),
    HR: categories.HR.top.slice(0, 5),
    RBI: categories.RBI.top.slice(0, 5),
    SB: categories.SB.top.slice(0, 5)
  };
}

function playerRankSummary(leaders, playerId, userPlayerId) {
  return Object.fromEntries((leaders.categoryOrder ?? []).map((key) => {
    const category = leaders.categories?.[key];
    const visibleRank = category?.top?.find((row) => row.id === playerId)?.rank
      ?? category?.neighborhood?.find((row) => row.id === playerId)?.rank
      ?? null;
    const rank = visibleRank ?? (playerId === userPlayerId ? category?.userRank ?? null : null);
    return [key, rank];
  }));
}

function playerDetailView(session, playerId, leaders = null) {
  const identity = playerIdentity(session, playerId);
  const base = findPlayer(session, playerId);
  const status = session.playerStates[playerId] ?? null;
  const developed = status ? getSeasonDevelopedPlayer(base, status) : base;
  const effective = status ? getSeasonEffectivePlayer(base, status) : base;
  const detailLevel = identity.organizationLevel && stateForLevel(session, identity.organizationLevel) ? identity.organizationLevel : currentUserLevel(session);
  const seasonLine = getPlayerSeasonBattingLine(stateForLevel(session, detailLevel), playerId);
  const seasonLinesByLevel = Object.fromEntries(SIMULATED_LEVELS.map((level) => [level, getPlayerSeasonBattingLine(stateForLevel(session, level), playerId)]));
  const leaderState = leaders ?? leadersView(session, detailLevel);
  const orgRecord = organizationPlayerRecord(session, playerId);
  const detailRoster = orgRecord?.roster ?? levelLeague(session, detailLevel)?.rosters?.[identity.teamId] ?? null;
  const utilityPathway = detailRoster ? getUtilityPathwayView(detailRoster, session.playerStates, session.roleStates, playerId) : null;
  const roleState = session.roleStates?.[playerId] ?? null;
  const playingTime = status ? getPositionPlayingTimeView(status, roleState) : null;
  const roleFit = getRoleFitFeedback(roleState, playingTime, { currentDate: session.state.currentDate });
  const isUser = playerId === session.fixture.userPlayerId;
  const careerProfile = isUser && session.fixture.careerProfile ? Object.freeze({
    identity: Object.freeze({ ...session.fixture.careerProfile.identity }),
    archetype: session.fixture.careerProfile.archetype,
    visibleTraits: Object.freeze([...(session.fixture.careerProfile.visibleTraits ?? [])]),
    organizationChoice: Object.freeze({ ...(session.fixture.careerProfile.organizationChoice ?? {}) })
  }) : null;
  return {
    ...identity,
    isUser,
    bats: base.bats,
    throws: base.throws,
    status: status ? getPositionPlayerSeasonView(status) : null,
    ratings: {
      current: visibleRatings(developed),
      gameEffective: visibleRatings(effective)
    },
    effectiveRatings: visibleRatings(effective),
    scouting: scoutingReportForPlayer(session, playerId),
    careerProfile,
    contract: getContractPublicView(session.contractStates?.[playerId] ?? null, {
      currentLevel: identity.organizationLevel ?? detailLevel,
      currentDate: session.state.currentDate
    }),
    rosterControl: getRosterControlPublicView(session.rosterControlStates?.[playerId] ?? null),
    seasonLine,
    seasonLinesByLevel,
    roleState: getRolePublicView(roleState, { currentDate: session.state.currentDate }),
    utilityPathway,
    playingTime,
    roleFit,
    leaderRanks: playerRankSummary(leaderState, playerId, session.fixture.userPlayerId)
  };
}

function userPlayerView(session, leaders = null) {
  return playerDetailView(session, session.fixture.userPlayerId, leaders);
}
const ORGANIZATION_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH", "SP", "RP"]);
const POSITION_PLAYER_REVIEW_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]);
const ORGANIZATION_REVIEW_PAIRS = Object.freeze([Object.freeze({ fromLevel: "A", toLevel: "HIGH_A" }), Object.freeze({ fromLevel: "HIGH_A", toLevel: "AA" }), Object.freeze({ fromLevel: "AA", toLevel: "AAA" }), Object.freeze({ fromLevel: "AAA", toLevel: "MLB" })]);

function currentOrganizationPlayer(session, playerId) {
  const base = findPlayer(session, playerId);
  const state = session.playerStates[playerId] ?? null;
  return state ? getSeasonDevelopedPlayer(base, state) : base;
}

function hitterDepthScore(player, position) {
  const h = player.hitting ?? {}, f = player.fielding ?? {}, r = player.running ?? {};
  const contact = ((h.contactR ?? 50) + (h.contactL ?? 50)) / 2;
  const offense = contact * 0.34 + (h.rawPower ?? 50) * 0.24 + (h.vision ?? 50) * 0.11 + (h.discipline ?? 50) * 0.11;
  let defense = (f.fielding ?? 50) * 0.10 + (f.reaction ?? 50) * 0.06 + (f.armStrength ?? 50) * 0.02 + (f.armAccuracy ?? 50) * 0.02;
  if (["SS", "2B", "CF"].includes(position)) defense += (r.speed ?? 50) * 0.06;
  if (["C", "3B", "RF"].includes(position)) defense += (f.armStrength ?? 50) * 0.04;
  if (position === "DH") defense *= 0.25;
  const familiarity = position === "DH" ? 1 : Number(player?.positioning?.familiarity?.[position] ?? 1);
  const familiarityPenalty = Math.max(0, 1 - familiarity) * 12;
  return offense + defense - familiarityPenalty;
}

function pitcherDepthScore(player, role) {
  const p = player.pitching ?? {};
  const stuff = player.derived?.stuff ?? 50;
  const base = stuff * 0.32 + (p.command ?? 50) * 0.22 + (p.movement ?? 50) * 0.20 + (p.control ?? 50) * 0.16 + (p.pitchability ?? 50) * 0.10;
  return role === "SP" ? base + (p.stamina ?? 50) * 0.12 : base + stuff * 0.08;
}

function rosterCandidatesForPosition(roster, position) {
  if (position === "SP") return [...(roster.starters ?? [])];
  if (position === "RP") return [...(roster.bullpen ?? [])];
  const ids = [];
  const starter = roster.lineupSlots?.find((slot) => slot.position === position)?.starterId ?? null;
  if (starter) ids.push(starter);
  for (const bench of roster.bench ?? []) if (bench.coverage?.includes(position) && !ids.includes(bench.playerId)) ids.push(bench.playerId);
  return ids;
}

function depthCandidatesForPosition(roster, position) {
  if (position === "SP" || position === "RP") return rosterCandidatesForPosition(roster, position);
  const ids = [...rosterCandidatesForPosition(roster, position)];
  for (const playerId of roster.positionPlayers ?? []) {
    if (ids.includes(playerId)) continue;
    const familiarity = Number(roster.players?.[playerId]?.positioning?.familiarity?.[position] ?? 0);
    if (familiarity >= 0.60) ids.push(playerId);
  }
  return ids;
}

function promotionCandidateInput(session, level, position, playerId) {
  const player = currentOrganizationPlayer(session, playerId);
  return {
    id: playerId,
    position,
    depthScore: hitterDepthScore(player, position),
    seasonLine: getPlayerSeasonBattingLine(stateForLevel(session, level), playerId),
    roleState: session.roleStates?.[playerId] ?? null,
    fatigue: session.playerStates?.[playerId]?.fatigue ?? 0,
    injured: healthAvailability(session.playerStates?.[playerId]?.health) === "INJURED"
  };
}

function pitcherMovementInput(session, level, role, playerId) {
  const player = currentOrganizationPlayer(session, playerId);
  return {
    id: playerId,
    position: role,
    depthScore: pitcherDepthScore(player, role),
    seasonLine: getPlayerSeasonPitchingLine(stateForLevel(session, level), playerId),
    pitcherState: session.pitcherStates?.[playerId] ?? null,
    injured: pitcherAvailability(session.pitcherStates?.[playerId]) === "INJURED"
  };
}

function lastTransactionDateForPairPosition(session, fromLevel, toLevel, position) {
  const match = [...(session.organizationState?.transactions ?? [])].reverse().find((event) => {
    if (event.position !== position) return false;
    return (event.fromLevel === fromLevel && event.toLevel === toLevel) || (event.fromLevel === toLevel && event.toLevel === fromLevel);
  });
  return match?.date ?? null;
}

function pairPositionEvaluation(session, date, fromLevel, toLevel, position) {
  const organization = session.fixture.organization;
  const lowerIds = rosterCandidatesForPosition(organization.levels[fromLevel].roster, position);
  const upperIds = rosterCandidatesForPosition(organization.levels[toLevel].roster, position);
  if (!lowerIds.length || !upperIds.length) return null;
  const rankedLower = lowerIds.map((id) => promotionCandidateInput(session, fromLevel, position, id)).sort((a, b) => b.depthScore - a.depthScore || a.id.localeCompare(b.id));
  const rankedUpper = upperIds.map((id) => promotionCandidateInput(session, toLevel, position, id)).sort((a, b) => b.depthScore - a.depthScore || a.id.localeCompare(b.id));
  const upperStarterId = organization.levels[toLevel].roster.lineupSlots?.find((slot) => slot.position === position)?.starterId ?? null;
  const incumbent = rankedUpper.find((row) => row.id === upperStarterId) ?? rankedUpper[0];
  const lastTransactionDate = lastTransactionDateForPairPosition(session, fromLevel, toLevel, position);
  if (fromLevel === "AAA" && toLevel === "MLB") {
    return freeze({
      ...evaluateAaaMlbPromotion({ date, candidate: rankedLower[0], incumbent, lastTransactionDate }),
      fromLevel, toLevel, evaluationKey: `${fromLevel}_${toLevel}_${position}`
    });
  }
  return evaluateMinorLevelPromotion({ date, fromLevel, toLevel, candidate: rankedLower[0], incumbent, lastTransactionDate });
}

function pairPitcherEvaluation(session, date, fromLevel, toLevel, role) {
  const organization = session.fixture.organization;
  const lowerIds = rosterCandidatesForPosition(organization.levels[fromLevel].roster, role);
  const upperIds = rosterCandidatesForPosition(organization.levels[toLevel].roster, role);
  if (!lowerIds.length || !upperIds.length) return null;
  const candidates = lowerIds.map((id) => pitcherMovementInput(session, fromLevel, role, id));
  const incumbents = upperIds.map((id) => pitcherMovementInput(session, toLevel, role, id));
  const lastTransactionDate = lastTransactionDateForPairPosition(session, fromLevel, toLevel, role);
  const pairEvaluations = [];
  for (const candidate of candidates) for (const incumbent of incumbents) {
    const evaluation = fromLevel === "AAA" && toLevel === "MLB"
      ? freeze({ ...evaluateAaaMlbPitcherMovement({ date, role, candidate, incumbent, lastTransactionDate }), fromLevel, toLevel, evaluationKey: `${fromLevel}_${toLevel}_${role}` })
      : evaluateMinorLevelPitcherMovement({ date, fromLevel, toLevel, role, candidate, incumbent, lastTransactionDate });
    pairEvaluations.push(evaluation);
  }
  return pairEvaluations.sort((a, b) =>
    (b.internal.candidateScore - b.internal.incumbentScore) - (a.internal.candidateScore - a.internal.incumbentScore)
    || a.candidateId.localeCompare(b.candidateId)
    || a.incumbentId.localeCompare(b.incumbentId)
  )[0] ?? null;
}

function playerPathwayStatus(session, playerId, identity = playerIdentity(session, playerId)) {
  if (!organizationPlayerRecord(session, playerId)) return "COMPETITIVE";
  const level = identity.organizationLevel;
  if (!level || level === "MLB") return "CLEAR";
  const order = session.fixture.organization?.levelOrder ?? SIMULATED_LEVELS.slice().reverse();
  const index = order.indexOf(level);
  if (index <= 0) return "CLEAR";
  const nextLevel = order[index - 1];
  const position = identity.role === "SP" || identity.role === "RP" ? identity.role : (identity.primaryPosition ?? "DH");
  const upperRoster = session.fixture.organization?.levels?.[nextLevel]?.roster;
  if (!upperRoster) return "CLEAR";
  const ids = rosterCandidatesForPosition(upperRoster, position);
  if (!ids.length) return "CLEAR";
  const player = currentOrganizationPlayer(session, playerId);
  const candidateScore = position === "SP" || position === "RP" ? pitcherDepthScore(player, position) : hitterDepthScore(player, position);
  const blockerScore = Math.max(...ids.map((id) => {
    const incumbent = currentOrganizationPlayer(session, id);
    return position === "SP" || position === "RP" ? pitcherDepthScore(incumbent, position) : hitterDepthScore(incumbent, position);
  }));
  const gap = blockerScore - candidateScore;
  if (gap >= 5) return "BLOCKED";
  if (gap >= -2) return "COMPETITIVE";
  return "CLEAR";
}

function scoutingReportForPlayer(session, playerId) {
  const base = findPlayer(session, playerId);
  const identity = playerIdentity(session, playerId);
  const pitcherState = session.pitcherStates?.[playerId] ?? null;
  const positionState = session.playerStates?.[playerId] ?? null;
  const isPitcher = Boolean(pitcherState && !positionState);
  const developed = isPitcher ? getSeasonDevelopedPitcher(base, pitcherState) : positionState ? getSeasonDevelopedPlayer(base, positionState) : base;
  const state = session.scoutingStates?.[playerId] ?? createScoutingState(base, {
    seed: session.fixture.seed ?? "", level: identity.organizationLevel ?? "AA",
    age: positionState?.health?.age ?? pitcherState?.health?.age ?? base?.physical?.age ?? null,
    startDate: session.state.currentDate
  });
  return buildScoutingReport({
    player: developed, scouting: state, development: (isPitcher ? pitcherState : positionState)?.development ?? null,
    potentialProfile: base?.realWorld?.hiddenDevelopmentPrior ?? null,
    publicScouting: productionSourcePlayer(session, playerId)?.publicScouting ?? null,
    age: positionState?.health?.age ?? pitcherState?.health?.age ?? base?.physical?.age ?? null,
    level: identity.organizationLevel ?? "AA", primaryPosition: identity.primaryPosition ?? "DH",
    role: isPitcher ? (identity.role === "SP" || identity.role === "RP" ? identity.role : base?.pitching?.role ?? "RP") : identity.role,
    injuryHistory: (isPitcher ? pitcherState : positionState)?.health?.history ?? null,
    pathway: playerPathwayStatus(session, playerId, identity), kind: isPitcher ? "PITCHER" : "POSITION"
  });
}

function applyOrganizationScoutingReview(session, date, reviewKey = null) {
  const next = { ...(session.scoutingStates ?? {}) };
  let applied = 0;
  for (const playerId of Object.keys(next)) {
    const player = findPlayer(session, playerId);
    const identity = playerIdentity(session, playerId);
    const result = applyScoutingReview(next[playerId], player, { date, level: identity.organizationLevel ?? fixtureLevelForPlayer(session.fixture, playerId), reviewKey: reviewKey ?? `org:${date}` });
    next[playerId] = result.state;
    if (result.applied) applied += 1;
  }
  session.scoutingStates = next;
  return applied;
}


function productionSourcePlayer(session, playerId) {
  if (session.fixture?.worldMode !== "PRODUCTION_REAL") return null;
  return session.dataUniverse?.data?.players?.find((player) => String(player.id) === String(playerId)) ?? null;
}

function productionOrganizationTeam(session, sourcePlayer, playerId = null) {
  if (session.fixture?.worldMode !== "PRODUCTION_REAL") return null;
  const data = session.dataUniverse?.data;
  const teamById = new Map((data?.teams ?? []).map((team) => [String(team.id), team]));
  let organizationId = sourcePlayer ? playerOrganizationId(sourcePlayer, teamById) : null;
  if (!organizationId && playerId) {
    const identity = playerIdentity(session, playerId);
    const level = identity.organizationLevel;
    if (level === "MLB") organizationId = identity.teamId;
    else {
      const affiliation = data?.affiliations?.find((row) => row.level === level && String(row.teamId) === String(identity.teamId));
      organizationId = affiliation?.organizationId ?? null;
    }
  }
  const mlbTeam = data?.teams?.find((team) => team.level === "MLB" && String(team.id) === String(organizationId)) ?? null;
  return mlbTeam ? freeze({ id: String(mlbTeam.id), name: mlbTeam.name, shortName: mlbTeam.abbreviation || mlbTeam.name }) : null;
}

function isWorldProspectEligible(session, playerId, level) {
  if (!level || level === "MLB") return false;
  if (session.fixture?.worldMode !== "PRODUCTION_REAL") return true;
  const source = productionSourcePlayer(session, playerId);
  if (source) {
    // Snapshot v1 does not carry official MLB rookie-eligibility/service thresholds.
    // Conservative production fallback: players with an MLB debut are excluded from
    // Top 100 until authoritative rookie-eligibility data is added to the snapshot.
    return source.mlbDebutDate == null;
  }
  const base = findPlayer(session, playerId);
  return base?.generated === true && base?.generatedCareer?.mlbDebutYear == null;
}

function worldProspectRankings(session) {
  const rows = [];
  for (const playerId of Object.keys(session.scoutingStates ?? {})) {
    const identity = playerIdentity(session, playerId);
    const level = identity.organizationLevel ?? fixtureLevelForPlayer(session.fixture, playerId);
    if (!isWorldProspectEligible(session, playerId, level)) continue;
    const playerState = session.playerStates?.[playerId] ?? null;
    const pitcherState = session.pitcherStates?.[playerId] ?? null;
    const base = findPlayer(session, playerId);
    const source = productionSourcePlayer(session, playerId);
    const age = playerState?.health?.age ?? pitcherState?.health?.age ?? base?.physical?.age ?? source?.age ?? 22;
    const position = identity.role === "SP" || identity.role === "RP" ? identity.role : (identity.primaryPosition ?? "DH");
    const scouting = scoutingReportForPlayer(session, playerId);
    const organizationTeam = productionOrganizationTeam(session, source, playerId);
    rows.push({ playerId, identity, organizationTeam, level, position, age, scouting, score: prospectRankingScore(scouting, { age, level, position }) });
  }
  return rows.sort((a, b) => b.score - a.score || b.scouting.futureValue - a.scouting.futureValue || a.playerId.localeCompare(b.playerId))
    .slice(0, 100).map((row, index) => freeze({
      rank: index + 1, id: row.playerId, name: row.identity.name, level: row.level,
      team: row.organizationTeam ?? row.identity.team, position: row.position, age: row.age,
      futureValue: row.scouting.futureValue, futureValueRange: row.scouting.futureValueRange,
      confidence: row.scouting.futureConfidence ?? row.scouting.confidence,
      currentConfidence: row.scouting.currentConfidence ?? row.scouting.confidence,
      futureConfidence: row.scouting.futureConfidence ?? row.scouting.confidence,
      risk: row.scouting.risk, eta: row.scouting.eta, pathway: row.scouting.pathway,
      isUser: row.playerId === session.fixture.userPlayerId
    }));
}

function organizationProspectRankings(session) {
  const rows = [];
  const organization = session.fixture.organization;
  for (const level of organization?.levelOrder ?? []) {
    if (level === "MLB") continue;
    const affiliate = organization.levels?.[level];
    for (const playerId of Object.keys(affiliate?.roster?.players ?? {})) {
      const identity = playerIdentity(session, playerId);
      const playerState = session.playerStates?.[playerId] ?? null;
      const pitcherState = session.pitcherStates?.[playerId] ?? null;
      const age = playerState?.health?.age ?? pitcherState?.health?.age ?? affiliate.roster.players[playerId]?.physical?.age ?? 22;
      const position = identity.role === "SP" || identity.role === "RP" ? identity.role : (identity.primaryPosition ?? "DH");
      const scouting = scoutingReportForPlayer(session, playerId);
      rows.push({ playerId, name: identity.name, level, team: identity.team, position, age, scouting, score: prospectRankingScore(scouting, { age, level, position }) });
    }
  }
  return rows.sort((a, b) => b.score - a.score || b.scouting.futureValue - a.scouting.futureValue || a.playerId.localeCompare(b.playerId))
    .slice(0, 20).map((row, index) => freeze({ rank: index + 1, id: row.playerId, name: row.name, level: row.level, team: row.team, position: row.position, age: row.age, futureValue: row.scouting.futureValue, futureValueRange: row.scouting.futureValueRange, confidence: row.scouting.futureConfidence ?? row.scouting.confidence, currentConfidence: row.scouting.currentConfidence ?? row.scouting.confidence, futureConfidence: row.scouting.futureConfidence ?? row.scouting.confidence, risk: row.scouting.risk, eta: row.scouting.eta, pathway: row.scouting.pathway, isUser: row.playerId === session.fixture.userPlayerId }));
}

function runOrganizationReviewIfDue(session, date, { force = false } = {}) {
  if (!force && !isOrganizationReviewDue(session.organizationState, date)) return false;
  applyOrganizationScoutingReview(session, date, `org:${date}`);
  const organization = session.fixture.organization;
  if (!organization?.levels) return false;
  const evaluations = [];
  for (const pair of ORGANIZATION_REVIEW_PAIRS) {
    if (!organization.levels[pair.fromLevel]?.roster || !organization.levels[pair.toLevel]?.roster) continue;
    for (const position of POSITION_PLAYER_REVIEW_POSITIONS) {
      const evaluation = pairPositionEvaluation(session, date, pair.fromLevel, pair.toLevel, position);
      if (evaluation) evaluations.push(evaluation);
    }
    for (const role of ["SP", "RP"]) {
      const evaluation = pairPitcherEvaluation(session, date, pair.fromLevel, pair.toLevel, role);
      if (evaluation) evaluations.push(evaluation);
    }
  }

  // At most one adjacent-level transaction per scheduled review. This prevents
  // cascades (A->AA->AAA in one day) and keeps the persistent-role cadence.
  const transactionCandidate = evaluations
    .filter((row) => row.decision === "PROMOTE")
    .sort((a, b) => (b.internal.candidateScore - b.internal.incumbentScore) - (a.internal.candidateScore - a.internal.incumbentScore)
      || ORGANIZATION_REVIEW_PAIRS.findIndex((p) => p.fromLevel === b.fromLevel && p.toLevel === b.toLevel) - ORGANIZATION_REVIEW_PAIRS.findIndex((p) => p.fromLevel === a.fromLevel && p.toLevel === a.toLevel)
      || a.position.localeCompare(b.position))[0] ?? null;
  let transactionEvents = [];
  let reviewEvaluations = evaluations;
  if (transactionCandidate) {
    let rosterPrep = null;
    if (transactionCandidate.fromLevel === "AAA" && transactionCandidate.toLevel === "MLB") {
      rosterPrep = prepareAaaMlbRosterMove({
        states: session.rosterControlStates,
        candidateId: transactionCandidate.candidateId,
        incumbentId: transactionCandidate.incumbentId,
        date,
        organizationId: String(session.fixture.organization.id),
        organizationPlayerIds: currentOrganizationPlayerIds(session)
      });
      if (!rosterPrep.allowed) {
        reviewEvaluations = evaluations.map((row) => row !== transactionCandidate ? row : freeze({
          ...row,
          decision: "HOLD",
          incumbentDecision: "HOLD",
          reasonCodes: [...new Set([...(row.reasonCodes ?? []), rosterPrep.blockCode])],
          candidateReasonCodes: [...new Set([...(row.candidateReasonCodes ?? row.reasonCodes ?? []), rosterPrep.blockCode])],
          incumbentReasonCodes: [...new Set([...(row.incumbentReasonCodes ?? row.reasonCodes ?? []), rosterPrep.blockCode])]
        }));
      }
    }
    if (!rosterPrep || rosterPrep.allowed) {
      const moved = executeAdjacentLevelSwap({
        fixture: session.fixture,
        roleStates: session.roleStates,
        fromLevel: transactionCandidate.fromLevel,
        toLevel: transactionCandidate.toLevel,
        promotePlayerId: transactionCandidate.candidateId,
        demotePlayerId: transactionCandidate.incumbentId,
        position: transactionCandidate.position,
        date,
        promoteReasonCodes: [...new Set([...(transactionCandidate.candidateReasonCodes ?? transactionCandidate.reasonCodes ?? []), ...(rosterPrep?.candidateReasonCodes ?? [])])],
        demoteReasonCodes: [...new Set([...(transactionCandidate.incumbentReasonCodes ?? transactionCandidate.reasonCodes ?? []), ...(rosterPrep?.incumbentReasonCodes ?? [])])]
      });
      session.fixture = moved.fixture;
      session.roleStates = moved.roleStates;
      if (rosterPrep?.allowed) session.rosterControlStates = rosterPrep.states;
      transactionEvents = moved.events;
      session.careerEventState = recordOrganizationCareerEvents(session.careerEventState, moved.events, { userPlayerId: session.fixture.userPlayerId });
    }
  }
  session.organizationState = applyOrganizationReview(session.organizationState, { date, evaluations: reviewEvaluations, transactionEvents });
  reconcileCurrentMlbServiceDate(session, date);
  return true;
}

function depthEntry(session, level, affiliate, position, playerId, rank) {
  const identity = playerIdentity(session, playerId);
  const player = currentOrganizationPlayer(session, playerId);
  const score = position === "SP" || position === "RP" ? pitcherDepthScore(player, position) : hitterDepthScore(player, position);
  return {
    rank, id: playerId, name: identity.name, level, team: affiliate.team, role: identity.role, primaryPosition: identity.primaryPosition,
    isUser: playerId === session.fixture.userPlayerId, depthScore: Math.round(score * 10) / 10,
    ratings: visibleRatings(player)
  };
}

function organizationView(session) {
  const organization = session.fixture.organization;
  if (!organization?.levels) return null;
  const depthCharts = {};
  for (const position of ORGANIZATION_POSITIONS) {
    depthCharts[position] = organization.levelOrder.map((level) => {
      const affiliate = organization.levels[level];
      const ids = depthCandidatesForPosition(affiliate.roster, position);
      const rows = ids.map((id) => ({ id, score: position === "SP" || position === "RP"
        ? pitcherDepthScore(currentOrganizationPlayer(session, id), position)
        : hitterDepthScore(currentOrganizationPlayer(session, id), position) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return { level, team: affiliate.team, simulated: Boolean(affiliate.simulated), entries: rows.map((row, index) => depthEntry(session, level, affiliate, position, row.id, index + 1)) };
    });
  }
  const levelSummaries = organization.levelOrder.map((level) => {
    const affiliate = organization.levels[level];
    return { level, team: affiliate.team, simulated: Boolean(affiliate.simulated), positionPlayers: affiliate.roster.positionPlayers.length, pitchers: affiliate.roster.pitchers.length, isUserLevel: level === organization.userLevel };
  });
  const userIdentity = playerIdentity(session, session.fixture.userPlayerId);
  const userPosition = userIdentity.primaryPosition ?? "CF";
  const levelIndex = organization.levelOrder.indexOf(organization.userLevel);
  const nextLevel = levelIndex > 0 ? organization.levelOrder[levelIndex - 1] : null;
  const nextBlocker = nextLevel ? depthCharts[userPosition]?.find((group) => group.level === nextLevel)?.entries?.[0] ?? null : null;
  const allEvaluations = Object.values(session.organizationState?.latestEvaluations ?? {});
  const upwardEvaluation = allEvaluations.find((row) => row?.candidateId === session.fixture.userPlayerId && row.fromLevel === organization.userLevel && row.toLevel === nextLevel) ?? null;
  const downwardEvaluation = allEvaluations.find((row) => row?.incumbentId === session.fixture.userPlayerId && row.toLevel === organization.userLevel) ?? null;
  const recentUserEvaluation = allEvaluations.filter((row) => row && (row.candidateId === session.fixture.userPlayerId || row.incumbentId === session.fixture.userPlayerId))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))[0] ?? null;
  const rawEvaluation = upwardEvaluation ?? downwardEvaluation ?? recentUserEvaluation;
  const userEvaluation = rawEvaluation ? getOrganizationEvaluationPublicView(rawEvaluation, { playerId: session.fixture.userPlayerId }) : null;
  const review = getOrganizationReviewPublicView(session.organizationState, { currentDate: session.state.currentDate });
  const pitcherEvaluations = Object.fromEntries(["SP", "RP"].map((role) => {
    const raw = session.organizationState?.latestEvaluations?.[role] ?? null;
    if (!raw) return [role, null];
    const view = getOrganizationEvaluationPublicView(raw);
    return [role, {
      ...view,
      candidate: { id: raw.candidateId, name: playerIdentity(session, raw.candidateId).name },
      incumbent: { id: raw.incumbentId, name: playerIdentity(session, raw.incumbentId).name }
    }];
  }));
  const recentTransactions = (session.organizationState?.transactions ?? []).slice(-6).reverse().map((event) => ({
    ...event,
    playerName: playerIdentity(session, event.playerId).name
  }));
  return {
    id: organization.id, name: organization.name, userLevel: organization.userLevel, levelOrder: [...organization.levelOrder],
    positionOptions: [...ORGANIZATION_POSITIONS], userPosition, levelSummaries, depthCharts, review, userEvaluation, pitcherEvaluations, recentTransactions,
    prospectRankings: organizationProspectRankings(session),
    pathway: { nextLevel, blockedBy: nextBlocker }
  };
}

function userPitchingStaffView(session, level = currentUserLevel(session)) {
  const league = levelLeague(session, level);
  const roster = league?.rosters?.[userTeamIdForLevel(session, level)];
  if (!roster) return [];
  return [...roster.starters, ...roster.bullpen].map((id) => ({ id, name: roster.names[id], role: roster.players[id].pitching.role, ...getPitcherSeasonView(session.pitcherStates[id]) }));
}

function progressCheckpoint(session) {
  const events = session.careerEventState?.events ?? [];
  const health = session.playerStates?.[session.fixture.userPlayerId]?.health ?? null;
  return {
    sequence: events.length ? Number(events[events.length - 1].sequence ?? events.length) : 0,
    injuryId: health?.activeInjury?.injuryId ?? null
  };
}

function importantProgressStop(session, checkpoint) {
  const events = session.careerEventState?.events ?? [];
  const event = events.find((row) => Number(row.sequence ?? 0) > checkpoint.sequence
    && (IMPORTANT_CAREER_EVENT_TYPES.has(row.type) || ["MAJOR", "CAREER"].includes(row.importance)));
  if (event) return { kind: "CAREER_EVENT", date: event.date, event: { ...event, reasonCodes: [...(event.reasonCodes ?? [])] } };
  const injury = session.playerStates?.[session.fixture.userPlayerId]?.health?.activeInjury ?? null;
  if (injury && injury.injuryId !== checkpoint.injuryId && MAJOR_INJURY_SEVERITIES.has(injury.severity)) {
    return { kind: "MAJOR_INJURY", date: injury.startDate, injury: { ...injury } };
  }
  return null;
}

function progressResult(session, { command, startedDate, targetDate = null, stopReason, stop = null, gamesBefore = 0 } = {}) {
  const endedDate = session.state.currentDate;
  const gamesAfter = Object.values(session.levelStates ?? { AAA: session.state }).reduce((sum, row) => sum + Number(row.completedGames ?? 0), 0);
  return freeze({
    command, startedDate, endedDate, targetDate, stopReason, stop,
    daysAdvanced: Math.max(0, daysBetween(startedDate, endedDate)),
    worldGamesSimulated: Math.max(0, gamesAfter - gamesBefore)
  });
}

function advanceByCalendar(session, { command, targetDate = null, stopOnImportant = true } = {}) {
  const startedDate = session.state.currentDate;
  const gamesBefore = Object.values(session.levelStates ?? { AAA: session.state }).reduce((sum, row) => sum + Number(row.completedGames ?? 0), 0);
  const checkpoint = progressCheckpoint(session);
  if (session.activeGameId) {
    const level = session.activeLevel ?? currentUserLevel(session);
    const activeSchedule = session.activeScheduleGameId ? scheduleGameById(session, session.activeScheduleGameId, level) : null;
    if (activeSchedule && activeSchedule.status !== "FINAL") {
      const finalGame = gameApi.simulateToFinal(session.activeGameId, { approach: "BALANCED" });
      finalizeInteractiveGameIfNeeded(session, finalGame);
    }
    clearActiveGame(session);
    const activeStop = stopOnImportant ? importantProgressStop(session, checkpoint) : null;
    if (activeStop) {
      const result = progressResult(session, { command, startedDate, targetDate, stopReason: "IMPORTANT_EVENT", stop: activeStop, gamesBefore });
      session.lastProgress = result;
      return result;
    }
  }
  let cursor = session.state.currentDate;
  let safety = 0;
  while (!worldComplete(session)) {
    if (targetDate && cursor >= targetDate) {
      recoverAllPlayersToDate(session, targetDate);
      const result = progressResult(session, { command, startedDate, targetDate, stopReason: "DATE_REACHED", gamesBefore });
      session.lastProgress = result;
      return result;
    }
    recoverAllPlayersToDate(session, cursor);
    simulateWorldDate(session, cursor);
    runOrganizationReviewIfDue(session, cursor);
    applySeasonEndAgingIfNeeded(session);
    const stop = stopOnImportant ? importantProgressStop(session, checkpoint) : null;
    const nextDate = addIsoDays(cursor, 1);
    if (!worldComplete(session)) recoverAllPlayersToDate(session, nextDate);
    if (stop) {
      const result = progressResult(session, { command, startedDate, targetDate, stopReason: "IMPORTANT_EVENT", stop, gamesBefore });
      session.lastProgress = result;
      return result;
    }
    if (worldComplete(session)) break;
    cursor = nextDate;
    safety += 1;
    if (safety > 420) throw new RangeError("달력 진행이 안전 한도를 초과했습니다.");
  }
  const result = progressResult(session, { command, startedDate, targetDate, stopReason: "SEASON_END", gamesBefore });
  session.lastProgress = result;
  return result;
}

function snapshot(session) {
  const level = currentUserLevel(session);
  const state = stateForLevel(session, level);
  const userTeamId = userTeamIdForLevel(session, level);
  const nextGame = nextUserGame(session), activeGame = session.activeGameId ? gameApi.getGame(session.activeGameId) : null;
  const standings = getStandingsTable(state), userSchedule = state.schedule.filter((g) => g.awayTeamId === userTeamId || g.homeTeamId === userTeamId);
  const gamesPlayed = userSchedule.filter((g) => g.status === "FINAL").length, userLine = getUserSeasonLine(state);
  const userRoleState = session.roleStates?.[session.fixture.userPlayerId] ?? null;
  const levelSinceDate = userRoleState?.levelSinceDate ?? userRoleState?.roleSinceDate ?? session.fixture.startDate ?? state.currentDate;
  const assignmentTeamGames = userSchedule.filter((g) => g.status === "FINAL" && g.date >= levelSinceDate).length;
  const leaders = leadersView(session, level);
  const levelStats = Object.fromEntries(SIMULATED_LEVELS.map((itemLevel) => {
    const itemState = stateForLevel(session, itemLevel);
    const itemTeamId = userTeamIdForLevel(session, itemLevel);
    const itemSchedule = itemState.schedule.filter((g) => g.awayTeamId === itemTeamId || g.homeTeamId === itemTeamId);
    const line = getUserSeasonLine(itemState);
    const standing = itemState.standings[itemTeamId];
    return [itemLevel, {
      level: itemLevel, userSeasonLine: line,
      record: { ...standing, games: standing.W + standing.L, pct: standing.W + standing.L > 0 ? standing.W / (standing.W + standing.L) : 0 },
      gamesPlayed: itemSchedule.filter((g) => g.status === "FINAL").length,
      totalGames: itemSchedule.length,
      leagueGamesCompleted: itemState.completedGames,
      leagueGamesTotal: itemState.schedule.length,
      status: itemState.status
    }];
  }));
  const worldLeagueCompleted = Object.values(session.levelStates ?? { AAA: session.state }).reduce((sum, row) => sum + row.completedGames, 0);
  const worldLeagueTotal = Object.values(session.levelStates ?? { AAA: session.state }).reduce((sum, row) => sum + row.schedule.length, 0);
  return freeze({
    apiVersion: "internal_season_api_v24", seasonId: session.state.seasonId, seasonYear: Number(String(session.fixture.startDate ?? session.state.startDate).slice(0,4)), startDate: session.fixture.startDate ?? session.state.startDate, status: worldComplete(session) ? "COMPLETE" : "REGULAR_SEASON", currentDate: session.state.currentDate,
    currentLevel: level, userTeam: state.teams[userTeamId], userPlayer: userPlayerView(session, leaders), record: teamRecord(session, level), userSeasonLine: userLine, userStatsByLevel: levelStats,
    userRole: (() => {
      const playingTime = getPositionPlayingTimeView(session.playerStates?.[session.fixture.userPlayerId] ?? null, userRoleState);
      return {
        gamesStarted: userLine.G,
        teamGames: assignmentTeamGames,
        restGames: Math.max(0, assignmentTeamGames - userLine.G),
        assignment: getRolePublicView(userRoleState, { currentDate: session.state.currentDate }),
        playingTime,
        roleFit: getRoleFitFeedback(userRoleState, playingTime, { currentDate: session.state.currentDate })
      };
    })(),
    nextGame: scheduleGameView(session, nextGame, level), currentSeries: currentSeriesView(session, nextGame, level), standings, leaders, organization: organizationView(session), worldProspectRankings: worldProspectRankings(session), careerTimeline: getCareerTimelinePublicView(session.careerEventState),
    levelStandings: Object.fromEntries(SIMULATED_LEVELS.map((itemLevel) => [itemLevel, getStandingsTable(stateForLevel(session, itemLevel))])),
    pitchingStaff: userPitchingStaffView(session, level), recentResults: recentResultsView(session, level),
    progress: { gamesPlayed, totalGames: userSchedule.length, leagueGamesCompleted: state.completedGames, leagueGamesTotal: state.schedule.length, worldLeagueGamesCompleted: worldLeagueCompleted, worldLeagueGamesTotal: worldLeagueTotal },
    dataUniverse: session.dataUniverse ? { schemaVersion: session.dataUniverse.schemaVersion, origin: session.dataUniverse.origin, sourceSnapshot: session.dataUniverse.sourceSnapshot, copiedAtCareerStart: session.dataUniverse.copiedAtCareerStart, snapshotDate: session.dataUniverse.snapshotDate, independent: session.dataUniverse.independent } : null,
    leagueEcology: session.leagueEcologyState ? { year: session.leagueEcologyState.year, totalRetired: session.leagueEcologyState.totalRetired, totalGenerated: session.leagueEcologyState.totalGenerated, lastOffseason: session.leagueEcologyState.lastOffseason } : null,
    lastProgress: session.lastProgress ?? null,
    activeGame, activeScheduleGameId: session.activeScheduleGameId, activeLevel: session.activeLevel ?? null
  });
}

function startCurrentGameInternal(session) {
  let safety = 0;
  while (true) {
    const prepared = prepareNextUserGameChronologically(session);
    const level = prepared.level, game = prepared.game; if (!game) return null;
    recoverAllPlayersToDate(session, game.date);
    if (session.activeGameId && session.activeScheduleGameId === game.gameId && session.activeLevel === level) return gameApi.getGame(session.activeGameId);
    if (session.activeGameId) gameApi.closeGame(session.activeGameId);
    const fixture = createSeasonGameFixture({ seasonFixture: session.fixture, scheduleGame: game, playerStates: session.playerStates, pitcherStates: session.pitcherStates, roleStates: session.roleStates, level });
    if (!fixture.userPlayerId) {
      const result = simulateSeasonFixtureGame(fixture, { seed: level === "AAA" ? `${session.fixture.seed}:${game.gameId}` : `${session.fixture.seed}:${level}:${game.gameId}` });
      finalizeSimulatedFixture(session, level, game, fixture, result);
      simulateWorldDate(session, game.date, { excludeLevel: level, excludeGameId: game.gameId });
      runOrganizationReviewIfDue(session, game.date); applySeasonEndAgingIfNeeded(session); updateCurrentDateToNextUserGame(session);
      safety += 1; if (safety > 24) throw new RangeError("다음 사용자 출전 탐색이 안전 한도를 초과했습니다.");
      continue;
    }
    const gameSnapshot = gameApi.createGameFromFixture({ fixture, seed: level === "AAA" ? `${session.fixture.seed}:${game.gameId}:interactive` : `${session.fixture.seed}:${level}:${game.gameId}:interactive` });
    session.activeGameId = gameSnapshot.gameId; session.activeScheduleGameId = game.gameId; session.activeLevel = level; session.finalizedActiveGameId = null; session.activeFixture = fixture;
    return gameSnapshot;
  }
}
function clearActiveGame(session) {
  if (session.activeGameId) gameApi.closeGame(session.activeGameId);
  session.activeGameId = null; session.activeScheduleGameId = null; session.activeLevel = null; session.finalizedActiveGameId = null; session.activeFixture = null;
}

function catchUpLegacyLevelStates(session) {
  const present = session.levelStates ?? { AAA: session.state };
  const missingLevels = SIMULATED_LEVELS.filter((level) => !present[level]);
  if (missingLevels.length === 0) return;

  // Legacy saves may contain only AAA (v22) or AAA+MLB (v23-v25). Rebuild only
  // missing level timelines in an isolated scratch world. Existing authoritative
  // levels, user state and transaction participants are never replayed or
  // overwritten. This keeps old career results stable while backfilling missing lower levels such as A/High-A/AA.
  const originalState = session.state;
  const originalLevelStates = session.levelStates ?? { AAA: session.state };
  const originalPlayerStates = session.playerStates;
  const originalPitcherStates = session.pitcherStates;
  const originalContractStates = session.contractStates;
  const originalRosterControlStates = session.rosterControlStates;
  const originalRoleStates = session.roleStates;
  const originalPlayerStateDate = session.playerStateDate;
  const startDate = session.fixture.startDate ?? originalState.startDate ?? originalState.currentDate;
  const currentDate = originalState.currentDate;
  const created = createLevelSeasonStates(session.fixture, originalState.seasonId, startDate);

  session.state = created.AAA;
  session.levelStates = created;
  session.playerStates = initializePlayerStates(session.fixture);
  session.pitcherStates = initializePitcherStates(session.fixture);
  session.contractStates = initializeContractStates(session.fixture, { startDate });
  session.rosterControlStates = initializeRosterControlStates(session.fixture, { startDate });
  reconcileCurrentMlbServiceDate(session, startDate);
  session.roleStates = createOrganizationRoleStates(session.fixture, { startDate });
  session.playerStateDate = startDate;

  const inclusive = originalState.status === "COMPLETE";
  const targetDates = [...new Set(missingLevels.flatMap((level) => created[level]?.schedule.map((game) => game.date) ?? []))]
    .filter((date) => inclusive ? date <= currentDate : date < currentDate)
    .sort();
  for (const date of targetDates) {
    recoverAllPlayersToDate(session, date);
    for (const level of missingLevels) {
      const state = stateForLevel(session, level);
      if (!state) continue;
      for (const game of getGamesOnDate(state, date)) {
        if (game.status !== "FINAL") simulateScheduledGame(session, level, game);
      }
    }
  }
  recoverAllPlayersToDate(session, currentDate);

  const reconstructedStates = session.levelStates;
  const reconstructedPlayerStates = session.playerStates;
  const reconstructedPitcherStates = session.pitcherStates;
  const protectedIds = new Set([
    session.fixture.userPlayerId,
    ...((session.organizationState?.transactions ?? []).map((event) => event.playerId).filter(Boolean))
  ]);

  session.state = originalState;
  session.levelStates = { ...originalLevelStates };
  session.playerStates = { ...originalPlayerStates };
  session.pitcherStates = { ...originalPitcherStates };
  session.contractStates = originalContractStates;
  session.rosterControlStates = originalRosterControlStates;
  for (const level of missingLevels) {
    if (reconstructedStates[level]) session.levelStates[level] = reconstructedStates[level];
    const league = levelLeague(session, level);
    const positionIds = new Set(Object.values(league?.rosters ?? {}).flatMap((roster) => roster.positionPlayers ?? []));
    const pitcherIds = new Set(Object.values(league?.rosters ?? {}).flatMap((roster) => roster.pitchers ?? []));
    for (const playerId of positionIds) {
      if (!protectedIds.has(playerId) && reconstructedPlayerStates[playerId]) session.playerStates[playerId] = reconstructedPlayerStates[playerId];
    }
    for (const playerId of pitcherIds) {
      if (!protectedIds.has(playerId) && reconstructedPitcherStates[playerId]) session.pitcherStates[playerId] = reconstructedPitcherStates[playerId];
    }
  }
  session.roleStates = originalRoleStates;
  session.playerStateDate = originalPlayerStateDate;
}

function createSessionFromFixture(fixture, { seed, startDate, dataUniverse = null }) {
  const seasonId = `season_${seed.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const levelStates = createLevelSeasonStates(fixture, seasonId, startDate);
  const roleStates = createOrganizationRoleStates(fixture, { startDate });
  const playerStates = initializePlayerStates(fixture);
  const pitcherStates = initializePitcherStates(fixture);
  const scoutingStates = initializeScoutingStates(fixture, playerStates, pitcherStates, { startDate });
  const contractStates = initializeContractStates(fixture, { startDate });
  const rosterControlStates = initializeRosterControlStates(fixture, { startDate });
  const initialLevel = fixture.organization?.userLevel ?? roleStates[fixture.userPlayerId]?.level ?? "AAA";
  const session = {
    fixture, state: levelStates.AAA, levelStates,
    dataUniverse: normalizeSaveUniverse(dataUniverse ?? createSyntheticUniverseDescriptor({ startDate, sourceVersion: CURRENT_GAME_VERSION }), { startDate, sourceVersion: CURRENT_GAME_VERSION }),
    playerStates, pitcherStates, scoutingStates, contractStates, rosterControlStates,
    roleStates, organizationState: createOrganizationReviewState({ startDate }),
    careerEventState: createCareerEventState({ userPlayerId: fixture.userPlayerId, startDate, initialLevel }),
    leagueEcologyState: fixture.worldMode === "PRODUCTION_REAL" ? createProductionEcologyState({ fixture }) : null,
    playerStateDate: startDate,
    lastProgress: null,
    activeGameId: null, activeScheduleGameId: null, activeLevel: null, finalizedActiveGameId: null, activeFixture: null
  };
  reconcileCurrentMlbServiceDate(session, startDate);
  sessions.set(seasonId, session);
  return snapshot(session);
}

const seasonApi = Object.freeze({
  getCareerCreationCatalog({ masterSnapshot = null } = {}) {
    if (masterSnapshot?.metadata?.productionReady === true) {
      validateMasterSnapshot(masterSnapshot, { requireProductionCoverage: true });
      const universe = inferRealWorldUniverse(createSaveUniverseFromMasterSnapshot(masterSnapshot, { copiedAtCareerStart: masterSnapshot.metadata.snapshotDate, sourceVersion: CURRENT_GAME_VERSION }));
      return getCareerCreationCatalog({ organizations: getProductionOrganizationOptions(universe) });
    }
    return getCareerCreationCatalog();
  },
  previewNewCareer({ seed, input, masterSnapshot = null } = {}) {
    let organizations = null;
    if (masterSnapshot?.metadata?.productionReady === true) {
      validateMasterSnapshot(masterSnapshot, { requireProductionCoverage: true });
      const universe = inferRealWorldUniverse(createSaveUniverseFromMasterSnapshot(masterSnapshot, { copiedAtCareerStart: masterSnapshot.metadata.snapshotDate, sourceVersion: CURRENT_GAME_VERSION }));
      organizations = getProductionOrganizationOptions(universe);
    }
    return buildCareerCreationPlan({ seed, input, organizations }).publicPreview;
  },
  createCareerSeason({ seed, startDate = "2026-04-01", input, masterSnapshot = null } = {}) {
    const production = masterSnapshot?.metadata?.productionReady === true;
    if (production) validateMasterSnapshot(masterSnapshot, { requireProductionCoverage: true });
    const dataUniverse = masterSnapshot
      ? inferRealWorldUniverse(createSaveUniverseFromMasterSnapshot(masterSnapshot, { copiedAtCareerStart: startDate, sourceVersion: CURRENT_GAME_VERSION }))
      : createSyntheticUniverseDescriptor({ startDate, sourceVersion: CURRENT_GAME_VERSION });
    const organizations = production ? getProductionOrganizationOptions(dataUniverse) : null;
    const careerPlan = buildCareerCreationPlan({ seed, input, organizations });
    const fixture = production
      ? createProductionCareerSeasonFixture({ seed, careerPlan, universe: dataUniverse })
      : createCareerSeasonFixture({ seed, startDate, careerPlan });
    return createSessionFromFixture(fixture, { seed, startDate: fixture.startDate ?? startDate, dataUniverse });
  },
  createDemoSeason({ seed = "THE_CALL_UP_SEASON_V1", startDate = "2026-04-01" } = {}) {
    const fixture = createDemoSeasonFixture({ seed, startDate });
    return createSessionFromFixture(fixture, { seed, startDate, dataUniverse: createSyntheticUniverseDescriptor({ startDate, sourceVersion: CURRENT_GAME_VERSION }) });
  },
  getSeason(seasonId) { return snapshot(assertSession(seasonId)); },
  getPlayerDetail(seasonId, playerId) {
    const session = assertSession(seasonId);
    return freeze(playerDetailView(session, playerId));
  },
  runOrganizationReview(seasonId, { force = false } = {}) {
    const session = assertSession(seasonId);
    runOrganizationReviewIfDue(session, session.state.currentDate, { force });
    updateCurrentDateToNextUserGame(session);
    return snapshot(session);
  },
  setTrainingFocus(seasonId, focus) {
    const session = assertSession(seasonId);
    const playerId = session.fixture.userPlayerId;
    session.playerStates = { ...session.playerStates, [playerId]: setPositionPlayerTrainingFocus(session.playerStates[playerId], focus) };
    return snapshot(session);
  },
  serializeSeason(seasonId) {
    const session = assertSession(seasonId);
    let activeGameCheckpoint = null;
    if (session.activeGameId) {
      const active = gameApi.getGame(session.activeGameId);
      if (active.status === "IN_PROGRESS") activeGameCheckpoint = gameApi.createCheckpoint(session.activeGameId);
      else clearActiveGame(session);
    }
    return serializeSeasonSession(session, { activeGameCheckpoint });
  },
  restoreSeason(payload) {
    const restored = restoreSeasonSession(payload);
    restored.fixture = restored.fixture?.worldMode === "PRODUCTION_REAL"
      ? ensureProductionSeasonFixture(restored.fixture)
      : ensureDemoMultiLevelFixture(restored.fixture);
    restored.dataUniverse = inferRealWorldUniverse(normalizeSaveUniverse(restored.dataUniverse ?? null, { startDate: restored.fixture.startDate ?? restored.state.currentDate, sourceVersion: CURRENT_GAME_VERSION }));
    restored.playerStates = normalizePlayerStates(restored.fixture, restored.playerStates);
    restored.pitcherStates = normalizePitcherStates(restored.fixture, restored.pitcherStates);
    restored.contractStates = normalizeContractStatesForFixture(restored.fixture, restored.contractStates ?? {}, {
      startDate: restored.playerStateDate ?? restored.fixture.startDate ?? restored.state.currentDate
    });
    restored.rosterControlStates = normalizeRosterControlStatesForFixture(restored.fixture, restored.rosterControlStates ?? {}, {
      startDate: restored.playerStateDate ?? restored.fixture.startDate ?? restored.state.currentDate
    });
    const hadScoutingStates = Boolean(restored.scoutingStates);
    // Legacy v43 saves had no scouting state. Backfill at the restore date so
    // past review cycles are not retroactively replayed. Existing v44 states
    // retain their original observation history exactly.
    restored.scoutingStates = normalizeScoutingStates(restored.fixture, restored.scoutingStates, restored.playerStates, restored.pitcherStates, {
      startDate: hadScoutingStates ? (restored.fixture.startDate ?? restored.state.currentDate) : restored.state.currentDate
    });
    // A completed legacy season already passed its offseason development/aging
    // before scouting existed. Mark that offseason review as acknowledged
    // without fabricating observations; reopening/completing the same season
    // therefore cannot mutate the newly backfilled scouting state.
    if (!hadScoutingStates && worldComplete(restored)) {
      const legacyOffseasonKey = `offseason:${seasonAgingKey(restored)}`;
      restored.scoutingStates = Object.fromEntries(Object.entries(restored.scoutingStates).map(([playerId, state]) => [playerId, markScoutingReviewProcessed(state, legacyOffseasonKey)]));
    }
    restored.roleStates = normalizeRoleStates(restored.roleStates, restored.fixture, { startDate: restored.fixture.startDate ?? restored.state.currentDate });
    restored.organizationState = normalizeOrganizationReviewState(restored.organizationState, { startDate: restored.fixture.startDate ?? restored.state.currentDate });
    restored.leagueEcologyState = restored.fixture?.worldMode === "PRODUCTION_REAL"
      ? normalizeProductionEcologyState(restored.leagueEcologyState, { fixture: restored.fixture })
      : null;
    restored.careerEventState = normalizeCareerEventState(restored.careerEventState, {
      userPlayerId: restored.fixture.userPlayerId,
      startDate: restored.fixture.startDate ?? restored.state.currentDate,
      initialLevel: restored.fixture.organization?.userLevel ?? restored.roleStates?.[restored.fixture.userPlayerId]?.level ?? "AAA",
      organizationTransactions: restored.organizationState?.transactions ?? [],
      completedMomentKeys: inferCompletedCareerMomentKeys(restored.levelStates ?? { AAA: restored.state })
    });
    catchUpLegacyLevelStates(restored);
    restored.state = restored.levelStates.AAA;
    const previous = sessions.get(restored.state.seasonId);
    if (previous?.activeGameId) gameApi.closeGame(previous.activeGameId);
    const checkpoint = restored.activeGameCheckpoint;
    delete restored.activeGameCheckpoint;
    if (checkpoint) {
      const gameSnapshot = gameApi.restoreCheckpoint(checkpoint);
      restored.activeGameId = gameSnapshot.gameId;
      restored.activeScheduleGameId = checkpoint.gameId;
      restored.activeFixture = checkpoint.fixture;
      restored.activeLevel = restored.activeLevel ?? checkpoint.fixture?.level ?? "AAA";
    }
    restored.lastProgress = null;
    sessions.set(restored.state.seasonId, restored);
    return snapshot(restored);
  },
  startCurrentGame(seasonId) { const session = assertSession(seasonId); session.lastProgress = null; startCurrentGameInternal(session); return snapshot(session); },
  playUserPA(seasonId, approach) {
    const session = assertSession(seasonId); session.lastProgress = null; const game = startCurrentGameInternal(session); if (!game) return snapshot(session);
    const next = gameApi.playUserPA(session.activeGameId, approach); finalizeInteractiveGameIfNeeded(session, next); return snapshot(session);
  },
  resolveUserRunningDecision(seasonId, choice) {
    const session = assertSession(seasonId);
    if (!session.activeGameId) return snapshot(session);
    session.lastProgress = null;
    const next = gameApi.resolveUserRunningDecision(session.activeGameId, choice);
    finalizeInteractiveGameIfNeeded(session, next);
    return snapshot(session);
  },
  simulateSevenDays(seasonId) {
    const session = assertSession(seasonId);
    const targetDate = addIsoDays(session.state.currentDate, 7);
    advanceByCalendar(session, { command: "SEVEN_DAYS", targetDate, stopOnImportant: true });
    return snapshot(session);
  },
  simulateToImportantEvent(seasonId) {
    const session = assertSession(seasonId);
    advanceByCalendar(session, { command: "IMPORTANT_EVENT", targetDate: null, stopOnImportant: true });
    return snapshot(session);
  },
  simulateCurrentGame(seasonId) {
    const session = assertSession(seasonId); session.lastProgress = null;
    const prepared = prepareNextUserGameChronologically(session), level = prepared.level, game = prepared.game; if (!game) return snapshot(session);
    recoverAllPlayersToDate(session, game.date);
    if (session.activeGameId && session.activeScheduleGameId === game.gameId && session.activeLevel === level) {
      const finalGame = gameApi.simulateToFinal(session.activeGameId, { approach: "BALANCED" }); finalizeInteractiveGameIfNeeded(session, finalGame);
    } else {
      simulateScheduledGame(session, level, game);
      simulateWorldDate(session, game.date, { excludeLevel: level, excludeGameId: game.gameId });
      runOrganizationReviewIfDue(session, game.date); applySeasonEndAgingIfNeeded(session); updateCurrentDateToNextUserGame(session);
    }
    return snapshot(session);
  },
  simulateCurrentSeries(seasonId) {
    const session = assertSession(seasonId);
    session.lastProgress = null;
    const prepared = prepareNextUserGameChronologically(session), startLevel = prepared.level, first = prepared.game; if (!first) return snapshot(session);
    const seriesId = first.seriesId, userTeamId = userTeamIdForLevel(session, startLevel);
    if (session.activeGameId && session.activeScheduleGameId === first.gameId && session.activeLevel === startLevel) {
      const finalGame = gameApi.simulateToFinal(session.activeGameId, { approach: "BALANCED" });
      finalizeInteractiveGameIfNeeded(session, finalGame); clearActiveGame(session);
      if (currentUserLevel(session) !== startLevel) return snapshot(session);
    } else if (session.activeGameId) clearActiveGame(session);
    const remainingState = stateForLevel(session, startLevel);
    const remaining = getSeriesGames(remainingState, seriesId).filter((g) => (g.awayTeamId === userTeamId || g.homeTeamId === userTeamId) && g.status !== "FINAL" && g.date >= session.playerStateDate).sort((a,b)=>a.date.localeCompare(b.date));
    for (const game of remaining) {
      if (currentUserLevel(session) !== startLevel) break;
      const nextPrepared = prepareNextUserGameChronologically(session);
      if (nextPrepared.level !== startLevel || nextPrepared.game?.gameId !== game.gameId) break;
      recoverAllPlayersToDate(session, game.date);
      simulateScheduledGame(session, startLevel, game);
      simulateWorldDate(session, game.date, { excludeLevel: startLevel, excludeGameId: game.gameId });
      runOrganizationReviewIfDue(session, game.date);
    }
    applySeasonEndAgingIfNeeded(session); updateCurrentDateToNextUserGame(session); return snapshot(session);
  },
  simulateToSeasonEnd(seasonId) {
    const session = assertSession(seasonId);
    if (session.activeGameId) {
      const level = session.activeLevel ?? currentUserLevel(session);
      const activeSchedule = session.activeScheduleGameId ? scheduleGameById(session, session.activeScheduleGameId, level) : null;
      if (activeSchedule && activeSchedule.status !== "FINAL") {
        const finalGame = gameApi.simulateToFinal(session.activeGameId, { approach: "BALANCED" });
        finalizeInteractiveGameIfNeeded(session, finalGame);
      }
      clearActiveGame(session);
    }
    while (!worldComplete(session)) {
      const pending = SIMULATED_LEVELS.flatMap((itemLevel) => {
        const state = stateForLevel(session, itemLevel);
        if (!state) return [];
        return state.schedule
          .filter((row) => row.status !== "FINAL")
          .map((row) => ({ level: itemLevel, date: row.date, gameId: row.gameId }));
      }).sort((a, b) => a.date.localeCompare(b.date) || a.level.localeCompare(b.level) || a.gameId.localeCompare(b.gameId));
      if (pending.length === 0) break;
      const date = pending[0].date;
      const before = pending.length;
      recoverAllPlayersToDate(session, date);
      simulateWorldDate(session, date);
      runOrganizationReviewIfDue(session, date);
      const after = SIMULATED_LEVELS.reduce((sum, itemLevel) => {
        const state = stateForLevel(session, itemLevel);
        return sum + (state ? state.schedule.filter((row) => row.status !== "FINAL").length : 0);
      }, 0);
      if (after >= before) {
        throw new RangeError(`멀티레벨 시즌 시뮬레이션이 진행되지 않았습니다: ${date} (${before} -> ${after})`);
      }
    }
    applySeasonEndAgingIfNeeded(session);
    return snapshot(session);
  },
  advanceToNextSeason(seasonId) { const session = assertSession(seasonId); return advanceCompletedProductionSeason(session); },
  closeActiveGame(seasonId) { const session=assertSession(seasonId); clearActiveGame(session); return snapshot(session); },
  resetDemoSeason(seasonId, options={}) { const session=assertSession(seasonId); clearActiveGame(session); sessions.delete(seasonId); return this.createDemoSeason(options); }
});

export { seasonApi };
