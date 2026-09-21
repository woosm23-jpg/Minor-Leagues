import { simulatePA } from "../pa/paEngine.js";
import { GAME_STATUS, applyPAResult, applyRunningPlay, getBattingTeam, getCurrentBatterId, getCurrentPitcherId, getFieldingTeam, setCurrentPitcher, substitutePositionPlayer } from "./gameState.js";
import { createPAStatEvent, createRunnerStatEvent } from "./statEvents.js";
import { resolvePrePARunningPlay } from "./stealEngine.js";
import { applyStatEvents, createBoxScore, registerPositionPlayerAppearance } from "./boxScore.js";

/**
 * Simulate a complete single game using the shared PA engine.
 * The resolver supplies a minimal PAContext for the current batter/pitcher;
 * GameEngine itself knows nothing about player storage or IndexedDB.
 *
 * Official stats are produced only after GameState resolves the play, then flow
 * through StatEvent -> BoxScore. GameState never increments player stats.
 */
function simulateGame({
  initialState,
  contextResolver,
  rng,
  pitcherManager = null,
  benchManager = null,
  runnerProfileResolver = null,
  runningGameResolver = null,
  paSimulator = simulatePA,
  maxPlateAppearances = 500,
  keepLog = false
}) {
  if (!initialState || typeof initialState !== "object") throw new TypeError("initialState가 필요합니다.");
  if (typeof contextResolver !== "function") throw new TypeError("contextResolver 함수가 필요합니다.");
  if (!rng || typeof rng.next !== "function") throw new TypeError("게임 시뮬레이션 RNG가 필요합니다.");
  if (pitcherManager !== null && typeof pitcherManager !== "function") {
    throw new TypeError("pitcherManager는 함수 또는 null이어야 합니다.");
  }
  if (benchManager !== null && typeof benchManager !== "function") {
    throw new TypeError("benchManager는 함수 또는 null이어야 합니다.");
  }
  if (runnerProfileResolver !== null && typeof runnerProfileResolver !== "function") {
    throw new TypeError("runnerProfileResolver는 함수 또는 null이어야 합니다.");
  }
  if (runningGameResolver !== null && typeof runningGameResolver !== "function") {
    throw new TypeError("runningGameResolver는 함수 또는 null이어야 합니다.");
  }
  if (typeof paSimulator !== "function") {
    throw new TypeError("paSimulator는 함수여야 합니다.");
  }
  if (!Number.isInteger(maxPlateAppearances) || maxPlateAppearances <= 0) {
    throw new RangeError("maxPlateAppearances는 양의 정수여야 합니다.");
  }

  const effectiveRunnerResolver = runnerProfileResolver ?? contextResolver.runnerProfileResolver ?? null;
  const effectiveRunningGameResolver = runningGameResolver ?? contextResolver.runningGameResolver ?? null;

  let state = initialState;
  let boxScore = createBoxScore(initialState);
  const statEvents = [];
  const runnerStatEvents = [];
  const runningEvents = [];
  const substitutionEvents = [];
  const log = [];

  while (state.status === GAME_STATUS.IN_PROGRESS) {
    if (state.plateAppearances >= maxPlateAppearances) {
      throw new RangeError(`게임이 ${maxPlateAppearances} PA 안에 종료되지 않았습니다.`);
    }

    if (pitcherManager) {
      const fieldingTeam = getFieldingTeam(state);
      const nextPitcherId = pitcherManager({ state, fieldingTeam });
      if (nextPitcherId && nextPitcherId !== getCurrentPitcherId(state)) {
        state = setCurrentPitcher(state, fieldingTeam, nextPitcherId);
      }
    }

    if (benchManager) {
      let substitutionsThisPA = 0;
      while (substitutionsThisPA < 3 && state.status === GAME_STATUS.IN_PROGRESS) {
        const battingTeam = getBattingTeam(state);
        const fieldingTeam = getFieldingTeam(state);
        const action = benchManager({ state, battingTeam, fieldingTeam });
        if (!action) break;
        const beforeSubstitution = state;
        state = substitutePositionPlayer(state, action);
        boxScore = registerPositionPlayerAppearance(boxScore, action.team, action.inPlayerId);
        substitutionEvents.push(Object.freeze({ ...action, before: beforeSubstitution, after: state }));
        substitutionsThisPA += 1;
      }
    }

    const prePAEvents = [];
    if (effectiveRunningGameResolver) {
      const runningPlay = resolvePrePARunningPlay({
        state,
        rng,
        resolveProfiles: effectiveRunningGameResolver
      });
      if (runningPlay) {
        const beforeRunning = state;
        state = applyRunningPlay(state, runningPlay);
        const runningStatEvent = createRunnerStatEvent({ before: beforeRunning, after: state, runningPlay });
        boxScore = applyStatEvents(boxScore, runningStatEvent);
        runnerStatEvents.push(runningStatEvent);
        runningEvents.push(runningPlay);
        prePAEvents.push(runningPlay);

        // A CS/pickoff can be the third out. The batting order must not advance,
        // so skip directly to the next half-inning iteration without a PA.
        if (state.half !== beforeRunning.half || state.inning !== beforeRunning.inning || state.status !== GAME_STATUS.IN_PROGRESS) {
          continue;
        }
      }
    }

    const batterId = getCurrentBatterId(state);
    const pitcherId = getCurrentPitcherId(state);
    const context = contextResolver({ state, batterId, pitcherId });
    const paResult = paSimulator(context, rng);
    const before = state;
    state = applyPAResult(state, paResult, rng, { runnerProfileResolver: effectiveRunnerResolver });
    const statEvent = createPAStatEvent({ before, after: state, paResult, batterId, pitcherId });
    boxScore = applyStatEvents(boxScore, statEvent);
    statEvents.push(statEvent);

    if (keepLog) {
      log.push(Object.freeze({
        paNumber: state.plateAppearances,
        batterId,
        pitcherId,
        paResult,
        statEvent,
        prePAEvents: Object.freeze([...prePAEvents]),
        before,
        after: state
      }));
    }
  }

  return Object.freeze({
    state,
    boxScore,
    statEvents: Object.freeze(statEvents),
    runnerStatEvents: Object.freeze(runnerStatEvents),
    runningEvents: Object.freeze(runningEvents),
    substitutionEvents: Object.freeze(substitutionEvents),
    log: Object.freeze(log),
    plateAppearances: state.plateAppearances
  });
}

export { simulateGame };
