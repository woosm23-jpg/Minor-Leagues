import { SeededRng } from "../engine/rng.js";
import { simulatePA } from "../engine/pa/paEngine.js";
import { GAME_STATUS, applyPAResult, applyRunningPlay, getBattingTeam, getCurrentBatterId, getCurrentPitcherId, getFieldingTeam, setCurrentPitcher, substitutePositionPlayer } from "../engine/game/gameState.js";
import { createPAStatEvent, createRunnerStatEvent } from "../engine/game/statEvents.js";
import { resolvePrePARunningPlay } from "../engine/game/stealEngine.js";
import { applyStatEvents, createBoxScore, deriveBattingRates, registerPositionPlayerAppearance, sumBattingTeam, sumFieldingTeam, sumPitchingTeam } from "../engine/game/boxScore.js";
import { createPlayerContextResolver } from "../engine/player/playerContextResolver.js";
import { createPitcherUsageManager } from "../engine/game/pitcherUsageAI.js";
import { createLateGameBenchManager } from "../engine/game/benchUsageAI.js";
import { PA_APPROACHES } from "../engine/pa/outcomeModel.js";
import { createQuickABDemoFixture } from "../services/demoGameFactory.js";
import { createProductionPitchSelectionResolver } from "../services/productionPitchArsenal.js";

const sessions = new Map();
const MAX_AUTO_PA = 500;
const GAME_CHECKPOINT_FORMAT = "THE_CALL_UP_GAME_CHECKPOINT";
const GAME_CHECKPOINT_SCHEMA_VERSION = 1;

function clone(value) {
  return structuredClone(value);
}

function assertSession(gameId) {
  const session = sessions.get(gameId);
  if (!session) throw new RangeError(`게임 세션을 찾을 수 없습니다: ${gameId}`);
  return session;
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  }
  return value;
}

function applyPitcherManager(session) {
  if (session.state.status !== GAME_STATUS.IN_PROGRESS) return;
  const fieldingTeam = getFieldingTeam(session.state);
  const nextPitcherId = session.pitcherManager({ state: session.state, fieldingTeam });
  if (nextPitcherId && nextPitcherId !== getCurrentPitcherId(session.state)) {
    session.state = setCurrentPitcher(session.state, fieldingTeam, nextPitcherId);
    session.events.push(Object.freeze({ type: "PITCHING_CHANGE", inning: session.state.inning, half: session.state.half, team: fieldingTeam, pitcherId: nextPitcherId }));
  }
}

function applyBenchManager(session) {
  if (!session.benchManager || session.state.status !== GAME_STATUS.IN_PROGRESS) return;
  let substitutionsThisPA = 0;
  while (substitutionsThisPA < 3 && session.state.status === GAME_STATUS.IN_PROGRESS) {
    const battingTeam = getBattingTeam(session.state);
    const fieldingTeam = getFieldingTeam(session.state);
    const action = session.benchManager({ state: session.state, battingTeam, fieldingTeam });
    if (!action) break;
    const before = session.state;
    session.state = substitutePositionPlayer(session.state, action);
    session.boxScore = registerPositionPlayerAppearance(session.boxScore, action.team, action.inPlayerId);
    session.events.push(Object.freeze({ type: "SUBSTITUTION", ...action, before, after: session.state }));
    substitutionsThisPA += 1;
  }
}

function userStealCandidate(session) {
  const userId = session.fixture.userPlayerId;
  const state = session.state;
  if (!userId || state.status !== GAME_STATUS.IN_PROGRESS || state.outs >= 3) return null;
  if (state.bases.first === userId && state.bases.second === null) {
    return Object.freeze({ runnerId: userId, fromBase: "first", toBase: "second", targetBase: 2 });
  }
  if (state.bases.second === userId && state.bases.first === null && state.bases.third === null) {
    return Object.freeze({ runnerId: userId, fromBase: "second", toBase: "third", targetBase: 3 });
  }
  return null;
}

function userRunningDecisionSnapshot(session) {
  const candidate = userStealCandidate(session);
  if (!candidate || isUserTurn(session)) return null;
  return Object.freeze({
    ...candidate,
    prompt: candidate.targetBase === 2 ? "2루 도루를 시도할까요?" : "3루 도루를 시도할까요?"
  });
}

function resolvePrePA(session, { forceAttempt = false } = {}) {
  const resolver = session.contextResolver.runningGameResolver;
  if (!resolver || session.state.status !== GAME_STATUS.IN_PROGRESS) return null;
  if (session.suppressUserAutoRunning && userStealCandidate(session)) return null;

  const runningPlay = resolvePrePARunningPlay({ state: session.state, rng: session.rng, resolveProfiles: resolver, forceAttempt });
  if (!runningPlay) return null;

  const before = session.state;
  session.state = applyRunningPlay(session.state, runningPlay);
  const event = createRunnerStatEvent({ before, after: session.state, runningPlay });
  session.boxScore = applyStatEvents(session.boxScore, event);
  session.events.push(Object.freeze({ type: "RUNNING", runningPlay, event, before, after: session.state }));
  return Object.freeze({ runningPlay, before, after: session.state });
}

function simulateNextPA(session, approach = "BALANCED") {
  if (!PA_APPROACHES.includes(approach)) throw new RangeError(`지원하지 않는 approach입니다: ${approach}`);
  if (session.state.status !== GAME_STATUS.IN_PROGRESS) return null;
  if (session.state.plateAppearances >= MAX_AUTO_PA) throw new RangeError("Quick AB 데모가 500 PA 안에 종료되지 않았습니다.");

  applyPitcherManager(session);
  applyBenchManager(session);
  const prePA = resolvePrePA(session);
  if (prePA && (
    prePA.before.inning !== prePA.after.inning ||
    prePA.before.half !== prePA.after.half ||
    prePA.after.status !== GAME_STATUS.IN_PROGRESS
  )) {
    return Object.freeze({ type: "RUNNING_ONLY", runningPlay: prePA.runningPlay });
  }

  const batterId = getCurrentBatterId(session.state);
  const pitcherId = getCurrentPitcherId(session.state);
  session.currentApproach = batterId === session.fixture.userPlayerId ? approach : "BALANCED";
  const context = session.contextResolver({ state: session.state, batterId, pitcherId });
  const paResult = simulatePA(context, session.rng);
  const before = session.state;
  session.state = applyPAResult(session.state, paResult, session.rng, {
    runnerProfileResolver: session.contextResolver.runnerProfileResolver
  });
  const statEvent = createPAStatEvent({ before, after: session.state, paResult, batterId, pitcherId });
  session.boxScore = applyStatEvents(session.boxScore, statEvent);
  const record = Object.freeze({ type: "PA", batterId, pitcherId, approach: session.currentApproach, paResult, statEvent, before, after: session.state });
  session.events.push(record);
  if (batterId === session.fixture.userPlayerId) session.lastUserPA = record;
  return record;
}

function isUserTurn(session) {
  return Boolean(session.fixture.userPlayerId) && session.state.status === GAME_STATUS.IN_PROGRESS && getCurrentBatterId(session.state) === session.fixture.userPlayerId;
}

function advanceToUserTurn(session) {
  let safety = 0;
  while (session.state.status === GAME_STATUS.IN_PROGRESS && !isUserTurn(session)) {
    simulateNextPA(session, "BALANCED");
    safety += 1;
    if (safety > MAX_AUTO_PA) throw new RangeError("사용자 다음 타석 탐색이 안전 한도를 초과했습니다.");
  }
}

function playerName(session, playerId) {
  if (!playerId) return null;
  return session.fixture.names[playerId] ?? playerId;
}

function baseSnapshot(session) {
  return Object.fromEntries(Object.entries(session.state.bases).map(([base, id]) => [base, id ? { id, name: playerName(session, id) } : null]));
}

function currentMatchup(session) {
  if (session.state.status !== GAME_STATUS.IN_PROGRESS) return null;
  const batterId = getCurrentBatterId(session.state);
  const pitcherId = getCurrentPitcherId(session.state);
  return {
    batter: { id: batterId, name: playerName(session, batterId) },
    pitcher: { id: pitcherId, name: playerName(session, pitcherId) },
    userAtBat: batterId === session.fixture.userPlayerId
  };
}

function userLineSnapshot(session) {
  if (!session.fixture.userPlayerId || !session.fixture.userTeam) return null;
  const line = session.boxScore.teams[session.fixture.userTeam].batting[session.fixture.userPlayerId];
  if (!line) return null;
  const rates = deriveBattingRates(line);
  return { ...line, ...rates };
}

function teamTotalsSnapshot(session) {
  return {
    away: sumBattingTeam(session.boxScore.teams.away),
    home: sumBattingTeam(session.boxScore.teams.home)
  };
}


function battingLinesSnapshot(session, teamKey) {
  const team = session.boxScore.teams[teamKey];
  const starterIds = [...team.battingOrder];
  const substituteIds = Object.keys(team.batting).filter((playerId) => !starterIds.includes(playerId));
  return [...starterIds, ...substituteIds].map((playerId, index) => {
    const line = team.batting[playerId];
    return {
      order: index < starterIds.length ? index + 1 : null,
      substitute: index >= starterIds.length,
      id: playerId,
      name: playerName(session, playerId),
      ...line,
      ...deriveBattingRates(line)
    };
  });
}

function pitchingLinesSnapshot(session, teamKey) {
  const team = session.boxScore.teams[teamKey];
  return Object.values(team.pitching).map((line) => ({
    id: line.playerId,
    name: playerName(session, line.playerId),
    ...line
  }));
}

function fieldingLinesSnapshot(session, teamKey) {
  const team = session.boxScore.teams[teamKey];
  return Object.values(team.fielding ?? {}).map((line) => ({
    id: line.playerId,
    name: playerName(session, line.playerId),
    ...line
  }));
}

function boxScoreSnapshot(session) {
  const recordedInnings = [
    ...Object.keys(session.boxScore.lineScore.away),
    ...Object.keys(session.boxScore.lineScore.home)
  ].map(Number).filter(Number.isFinite);
  const maxInning = Math.max(9, session.state.inning, ...recordedInnings, 1);
  const innings = Array.from({ length: maxInning }, (_, index) => index + 1);
  return {
    innings,
    lineScore: session.boxScore.lineScore,
    batting: {
      away: battingLinesSnapshot(session, "away"),
      home: battingLinesSnapshot(session, "home")
    },
    pitching: {
      away: pitchingLinesSnapshot(session, "away"),
      home: pitchingLinesSnapshot(session, "home")
    },
    fielding: {
      away: fieldingLinesSnapshot(session, "away"),
      home: fieldingLinesSnapshot(session, "home")
    },
    totals: {
      away: {
        batting: sumBattingTeam(session.boxScore.teams.away),
        pitching: sumPitchingTeam(session.boxScore.teams.away),
        fielding: sumFieldingTeam(session.boxScore.teams.away)
      },
      home: {
        batting: sumBattingTeam(session.boxScore.teams.home),
        pitching: sumPitchingTeam(session.boxScore.teams.home),
        fielding: sumFieldingTeam(session.boxScore.teams.home)
      }
    }
  };
}

function playFeedItem(session, record, index) {
  if (record.type === "SUBSTITUTION") {
    return {
      id: `substitution-${index}`,
      type: "SUBSTITUTION",
      inning: record.before?.inning ?? null,
      half: record.before?.half ?? null,
      team: record.team,
      reason: record.reason,
      position: record.position,
      outPlayer: { id: record.outPlayerId, name: playerName(session, record.outPlayerId) },
      inPlayer: { id: record.inPlayerId, name: playerName(session, record.inPlayerId) },
      rationale: record.rationale ?? null
    };
  }

  if (record.type === "PITCHING_CHANGE") {
    return {
      id: `pitching-change-${index}`,
      type: "PITCHING_CHANGE",
      inning: record.inning ?? null,
      half: record.half ?? null,
      team: record.team,
      pitcher: { id: record.pitcherId, name: playerName(session, record.pitcherId) }
    };
  }

  if (record.type === "RUNNING") {
    const play = record.runningPlay;
    return {
      id: `running-${index}`,
      type: "RUNNING",
      inning: record.event?.inning ?? session.state.inning,
      half: record.event?.half ?? session.state.half,
      kind: play.kind,
      runner: { id: play.runnerId, name: playerName(session, play.runnerId) },
      fromBase: play.fromBase,
      toBase: play.toBase,
      targetBase: play.targetBase,
      outsRecorded: play.outsRecorded ?? 0
    };
  }

  if (record.type === "PA") {
    const stat = record.statEvent;
    const play = record.after?.lastPlay;
    return {
      id: `pa-${stat.paNumber}`,
      type: "PA",
      inning: stat.inning,
      half: stat.half,
      battingTeam: stat.battingTeam,
      batter: { id: record.batterId, name: playerName(session, record.batterId) },
      pitcher: { id: record.pitcherId, name: playerName(session, record.pitcherId) },
      outcome: stat.outcome,
      rbi: stat.batting.RBI,
      runsScored: stat.scoredRunnerIds.length,
      outsRecorded: stat.pitching.outsRecorded,
      pitchCount: stat.pitching.Pitches,
      responsiblePosition: play?.responsiblePosition ?? null,
      reachedOnError: stat.reachedOnError,
      scoreAfter: record.after?.score ?? null
    };
  }

  return { id: `event-${index}`, type: record.type ?? "UNKNOWN" };
}

function playFeedSnapshot(session, limit = 12) {
  const start = Math.max(0, session.events.length - limit);
  return session.events.slice(start).map((record, offset) => playFeedItem(session, record, start + offset)).reverse();
}

function occupancySnapshot(bases) {
  if (!bases) return null;
  return { first: Boolean(bases.first), second: Boolean(bases.second), third: Boolean(bases.third) };
}

function userOfficialEventsSnapshot(session) {
  const userId = session.fixture.userPlayerId;
  if (!userId) return [];
  const rows = [];
  for (const record of session.events) {
    if (record.type === "RUNNING" && record.runningPlay?.runnerId === userId) {
      const before = record.before ?? null;
      const after = record.after ?? null;
      rows.push({
        kind: "RUNNING",
        phase: "PRE_PA",
        inning: record.event?.inning ?? before?.inning ?? null,
        half: record.event?.half ?? before?.half ?? null,
        paNumber: before ? before.plateAppearances + 1 : null,
        outsBefore: before?.outs ?? null,
        outsAfter: after?.outs ?? (before ? before.outs + Number(record.runningPlay?.outsRecorded ?? 0) : null),
        basesBefore: occupancySnapshot(before?.bases),
        basesAfter: occupancySnapshot(after?.bases),
        scoreBefore: before?.score ?? null,
        scoreAfter: after?.score ?? before?.score ?? null,
        runningKind: record.runningPlay?.kind ?? null,
        fromBase: record.runningPlay?.fromBase ?? null,
        toBase: record.runningPlay?.toBase ?? null
      });
      continue;
    }
    if (record.type === "PA" && record.batterId === userId) {
      const stat = record.statEvent;
      const before = record.before;
      const after = record.after;
      const sameHalf = before?.inning === after?.inning && before?.half === after?.half;
      rows.push({
        kind: "PA",
        phase: "PA",
        inning: stat?.inning ?? before?.inning ?? null,
        half: stat?.half ?? before?.half ?? null,
        paNumber: stat?.paNumber ?? null,
        outsBefore: before?.outs ?? null,
        outsAfter: before ? Math.min(3, before.outs + Number(stat?.pitching?.outsRecorded ?? 0)) : null,
        basesBefore: occupancySnapshot(before?.bases),
        basesAfter: sameHalf ? occupancySnapshot(after?.bases) : null,
        scoreBefore: before?.score ?? null,
        scoreAfter: after?.score ?? null,
        outcome: stat?.outcome ?? null,
        rbi: Number(stat?.batting?.RBI ?? 0),
        runsScored: Number(stat?.scoredRunnerIds?.length ?? 0),
        pitchCount: Number(stat?.pitching?.Pitches ?? 0)
      });
    }
  }
  return rows;
}

function lastUserPAViewSnapshot(session) {
  const record = session.lastUserPA;
  if (!record) return null;
  const result = record.paResult;
  const stat = record.statEvent;
  const play = record.after?.lastPlay;
  const wall = result?.battedBallResult?.wallClearance ?? null;
  return {
    outcome: stat.outcome,
    approach: record.approach,
    pitchCount: result.pitchCount ?? stat.pitching.Pitches ?? 0,
    rbi: stat.batting.RBI,
    runsScored: stat.scoredRunnerIds.length,
    reachedOnError: stat.reachedOnError,
    contactQuality: result.contactQuality?.bucket ?? null,
    exitVelocityMph: result.exitVelocity?.mph ?? null,
    hardHit: result.exitVelocity?.hardHit ?? false,
    launchAngleDegrees: result.launchAngle?.degrees ?? null,
    battedBallType: result.launchAngle?.type ?? null,
    sprayZone: result.spray?.zone ?? null,
    fieldSide: result.spray?.fieldSide ?? null,
    projectedDistanceFt: wall?.eligibleLaunch ? wall.projectedDistanceFt : null,
    fielder: play?.responsibleFielderId ? {
      id: play.responsibleFielderId,
      name: playerName(session, play.responsibleFielderId),
      position: play.responsiblePosition
    } : null,
    scoreBefore: record.before?.score ?? null,
    scoreAfter: record.after?.score ?? null
  };
}

function resultSnapshot(session) {
  if (session.state.status !== GAME_STATUS.FINAL) return null;
  return {
    winner: session.state.result.winner,
    winnerName: session.fixture.teams[session.state.result.winner].name,
    walkOff: session.state.walkOff
  };
}

function getSnapshotFromSession(session) {
  const state = session.state;
  return freeze({
    apiVersion: "internal_game_api_v2",
    gameId: state.gameId,
    status: state.status,
    userPlayer: session.fixture.userPlayerId ? { id: session.fixture.userPlayerId, name: playerName(session, session.fixture.userPlayerId), team: session.fixture.userTeam } : null,
    teams: session.fixture.teams,
    inning: state.inning,
    half: state.half,
    outs: state.outs,
    score: state.score,
    bases: baseSnapshot(session),
    plateAppearances: state.plateAppearances,
    substitutions: state.substitutions ?? [],
    defensiveAlignment: state.defensiveAlignment,
    matchup: currentMatchup(session),
    userLine: userLineSnapshot(session),
    teamTotals: teamTotalsSnapshot(session),
    boxScore: boxScoreSnapshot(session),
    playFeed: playFeedSnapshot(session),
    userOfficialEvents: userOfficialEventsSnapshot(session),
    lastUserPAView: lastUserPAViewSnapshot(session),
    lastUserPA: session.lastUserPA,
    userRunningDecision: userRunningDecisionSnapshot(session),
    recentEvents: session.events.slice(-8),
    result: resultSnapshot(session)
  });
}


function validateGameCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new TypeError("game checkpoint가 필요합니다.");
  }
  if (checkpoint.format !== GAME_CHECKPOINT_FORMAT) {
    throw new RangeError(`지원하지 않는 game checkpoint format입니다: ${checkpoint.format}`);
  }
  if (checkpoint.schemaVersion !== GAME_CHECKPOINT_SCHEMA_VERSION) {
    throw new RangeError(`지원하지 않는 game checkpoint schema입니다: ${checkpoint.schemaVersion}`);
  }
  if (typeof checkpoint.gameId !== "string" || !checkpoint.gameId) throw new TypeError("checkpoint.gameId가 필요합니다.");
  if (!checkpoint.fixture || typeof checkpoint.fixture !== "object") throw new TypeError("checkpoint.fixture가 필요합니다.");
  if (!checkpoint.state || typeof checkpoint.state !== "object") throw new TypeError("checkpoint.state가 필요합니다.");
  if (!checkpoint.boxScore || typeof checkpoint.boxScore !== "object") throw new TypeError("checkpoint.boxScore가 필요합니다.");
  if (checkpoint.state.gameId !== checkpoint.gameId) throw new RangeError("checkpoint state gameId가 일치하지 않습니다.");
  if (checkpoint.boxScore.gameId !== checkpoint.gameId) throw new RangeError("checkpoint boxScore gameId가 일치하지 않습니다.");
  if (checkpoint.fixture.gameId && checkpoint.fixture.gameId !== checkpoint.gameId) throw new RangeError("checkpoint fixture gameId가 일치하지 않습니다.");
  if (!PA_APPROACHES.includes(checkpoint.currentApproach)) throw new RangeError(`checkpoint approach가 잘못되었습니다: ${checkpoint.currentApproach}`);
  if (!Array.isArray(checkpoint.events)) throw new TypeError("checkpoint.events는 배열이어야 합니다.");
  SeededRng.fromSnapshot(checkpoint.rng);
  return checkpoint;
}

function createCheckpointFromSession(session) {
  return clone({
    format: GAME_CHECKPOINT_FORMAT,
    schemaVersion: GAME_CHECKPOINT_SCHEMA_VERSION,
    gameId: session.state.gameId,
    fixture: session.fixture,
    rng: session.rng.snapshot(),
    state: session.state,
    boxScore: session.boxScore,
    currentApproach: session.currentApproach,
    events: session.events,
    lastUserPA: session.lastUserPA
  });
}

function restoreCheckpointSession(checkpoint) {
  validateGameCheckpoint(checkpoint);
  const saved = clone(checkpoint);
  const session = makeSession({ seed: saved.fixture.seed ?? saved.gameId, fixture: saved.fixture });
  session.rng = SeededRng.fromSnapshot(saved.rng);
  session.state = freeze(saved.state);
  session.boxScore = freeze(saved.boxScore);
  session.currentApproach = saved.currentApproach;
  session.events = saved.events.map((event) => freeze(event));
  session.lastUserPA = saved.lastUserPA ? freeze(saved.lastUserPA) : null;
  return session;
}

function makeSession({ seed, fixture = createQuickABDemoFixture({ seed }) }) {
  const session = {
    fixture,
    rng: new SeededRng(seed),
    state: fixture.initialState,
    boxScore: createBoxScore(fixture.initialState),
    currentApproach: "BALANCED",
    contextResolver: null,
    pitcherManager: null,
    benchManager: null,
    events: [],
    lastUserPA: null,
    suppressUserAutoRunning: false
  };

  session.contextResolver = createPlayerContextResolver({
    players: fixture.players,
    resolvePark: () => fixture.park ?? null,
    resolvePitchVelocity: createProductionPitchSelectionResolver({ seed }),
    resolveApproach: ({ batterId }) => fixture.userPlayerId && batterId === fixture.userPlayerId ? session.currentApproach : "BALANCED"
  });
  session.pitcherManager = createPitcherUsageManager({ players: fixture.players, pitchingPlans: fixture.pitchingPlans });
  session.benchManager = createLateGameBenchManager({ players: fixture.players, benchPlans: fixture.benchPlans ?? {} });
  return session;
}

/**
 * Internal browser-domain API. No HTTP server is required. UI code consumes
 * this contract and never imports PA/Game/Defense engines directly.
 */
const gameApi = Object.freeze({
  createDemoGame({ seed = "THE_CALL_UP_QUICK_AB_V1" } = {}) {
    const session = makeSession({ seed });
    sessions.set(session.state.gameId, session);
    advanceToUserTurn(session);
    return getSnapshotFromSession(session);
  },

  createGameFromFixture({ fixture, seed = fixture?.seed ?? "THE_CALL_UP_GAME" } = {}) {
    if (!fixture || typeof fixture !== "object") throw new TypeError("fixture가 필요합니다.");
    if (!fixture.userPlayerId) throw new RangeError("interactive game fixture에는 userPlayerId가 필요합니다.");
    const session = makeSession({ seed, fixture });
    sessions.set(session.state.gameId, session);
    advanceToUserTurn(session);
    return getSnapshotFromSession(session);
  },

  getGame(gameId) {
    return getSnapshotFromSession(assertSession(gameId));
  },

  createCheckpoint(gameId) {
    return createCheckpointFromSession(assertSession(gameId));
  },

  restoreCheckpoint(checkpoint) {
    const session = restoreCheckpointSession(checkpoint);
    sessions.set(session.state.gameId, session);
    return getSnapshotFromSession(session);
  },

  validateCheckpoint(checkpoint) {
    validateGameCheckpoint(checkpoint);
    return true;
  },

  playUserPA(gameId, approach) {
    const session = assertSession(gameId);
    if (session.state.status === GAME_STATUS.FINAL) return getSnapshotFromSession(session);
    if (!isUserTurn(session)) advanceToUserTurn(session);
    if (session.state.status === GAME_STATUS.FINAL) return getSnapshotFromSession(session);

    const eventCountBefore = session.events.length;
    let playedUserPA = false;
    let safety = 0;
    while (session.state.status === GAME_STATUS.IN_PROGRESS && !playedUserPA) {
      const event = simulateNextPA(session, approach);
      if (event?.type === "PA" && event.batterId === session.fixture.userPlayerId) playedUserPA = true;
      safety += 1;
      if (safety > 20) throw new RangeError("사용자 PA 처리 중 안전 한도를 초과했습니다.");
    }
    if (!userRunningDecisionSnapshot(session)) advanceToUserTurn(session);
    const snapshot = getSnapshotFromSession(session);
    return freeze({ ...snapshot, actionEvents: session.events.slice(eventCountBefore) });
  },

  resolveUserRunningDecision(gameId, choice) {
    if (!["HOLD", "STEAL"].includes(choice)) throw new RangeError(`지원하지 않는 주루 선택입니다: ${choice}`);
    const session = assertSession(gameId);
    const decision = userRunningDecisionSnapshot(session);
    if (!decision) return getSnapshotFromSession(session);

    const eventCountBefore = session.events.length;
    if (choice === "STEAL") {
      const result = resolvePrePA(session, { forceAttempt: true });
      if (!result) throw new RangeError("도루 선택을 처리할 수 있는 주루 기회가 없습니다.");
    }

    session.suppressUserAutoRunning = true;
    try {
      advanceToUserTurn(session);
    } finally {
      session.suppressUserAutoRunning = false;
    }
    const snapshot = getSnapshotFromSession(session);
    return freeze({ ...snapshot, actionEvents: session.events.slice(eventCountBefore) });
  },

  simulateToFinal(gameId, { approach = "BALANCED" } = {}) {
    const session = assertSession(gameId);
    let safety = 0;
    while (session.state.status === GAME_STATUS.IN_PROGRESS) {
      simulateNextPA(session, approach);
      safety += 1;
      if (safety > MAX_AUTO_PA * 2) throw new RangeError("게임 자동 완료가 안전 한도를 초과했습니다.");
    }
    return getSnapshotFromSession(session);
  },

  closeGame(gameId) {
    return sessions.delete(gameId);
  },

  resetDemoGame(gameId, { seed = "THE_CALL_UP_QUICK_AB_V1" } = {}) {
    sessions.delete(gameId);
    return this.createDemoGame({ seed });
  }
});

export { gameApi };
