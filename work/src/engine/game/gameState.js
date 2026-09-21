import { ruleset2026 } from "../../config/ruleset.2026.js";
import { resolveRunnerAdvancement } from "./runnerAdvancement.js";

const GAME_STATUS = Object.freeze({ IN_PROGRESS: "IN_PROGRESS", FINAL: "FINAL" });
const INNING_HALF = Object.freeze({ TOP: "TOP", BOTTOM: "BOTTOM" });
const FIELDING_POSITIONS = Object.freeze(["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);

const TERMINAL_OUTCOMES = new Set(["BB", "HBP", "K", "OUT", "ROE", "1B", "2B", "3B", "HR"]);

function assertId(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label}는 비어 있지 않은 문자열이어야 합니다.`);
  }
}

function normalizeLineup(lineup, label) {
  if (!Array.isArray(lineup) || lineup.length !== 9) {
    throw new RangeError(`${label}은 정확히 9명의 선수 ID를 가져야 합니다.`);
  }
  lineup.forEach((id, index) => assertId(id, `${label}[${index}]`));
  if (new Set(lineup).size !== lineup.length) {
    throw new RangeError(`${label}에는 중복 선수 ID가 있을 수 없습니다.`);
  }
  return Object.freeze([...lineup]);
}


function normalizeDefensiveAlignment(alignment, label, pitcherId) {
  if (alignment === null || alignment === undefined) return null;
  if (!alignment || typeof alignment !== "object" || Array.isArray(alignment)) {
    throw new TypeError(`${label}은 position -> playerId object여야 합니다.`);
  }

  const normalized = { P: pitcherId };
  for (const position of FIELDING_POSITIONS) {
    if (position === "P") continue;
    const id = alignment[position];
    assertId(id, `${label}.${position}`);
    normalized[position] = id;
  }

  const ids = FIELDING_POSITIONS.map((position) => normalized[position]);
  if (new Set(ids).size !== ids.length) {
    throw new RangeError(`${label}에는 중복 수비수 ID가 있을 수 없습니다.`);
  }
  return Object.freeze(normalized);
}

function freezeDefensiveAlignment(defensiveAlignment) {
  return Object.freeze({
    away: defensiveAlignment?.away ? Object.freeze({ ...defensiveAlignment.away }) : null,
    home: defensiveAlignment?.home ? Object.freeze({ ...defensiveAlignment.home }) : null
  });
}

function freezePitcherUsage(pitcherUsage) {
  return Object.freeze(Object.fromEntries(
    Object.entries(pitcherUsage).map(([team, usageById]) => [
      team,
      Object.freeze(Object.fromEntries(
        Object.entries(usageById).map(([id, usage]) => [id, Object.freeze({ ...usage })])
      ))
    ])
  ));
}

function createPitcherUsageRecord(pitcherId, inning, half) {
  return {
    pitcherId,
    entryInning: inning,
    entryHalf: half,
    pitchCount: 0,
    battersFaced: 0,
    outsRecorded: 0,
    runsAllowed: 0
  };
}

function freezeState(state) {
  return Object.freeze({
    ...state,
    lineups: Object.freeze({
      away: Object.freeze([...state.lineups.away]),
      home: Object.freeze([...state.lineups.home])
    }),
    currentPitcherId: Object.freeze({ ...state.currentPitcherId }),
    defensiveAlignment: freezeDefensiveAlignment(state.defensiveAlignment),
    pitcherUsage: freezePitcherUsage(state.pitcherUsage),
    substitutions: Object.freeze([...(state.substitutions ?? [])].map((row) => Object.freeze({ ...row }))),
    battingOrderIndex: Object.freeze({ ...state.battingOrderIndex }),
    bases: Object.freeze({ ...state.bases }),
    score: Object.freeze({ ...state.score }),
    result: state.result ? Object.freeze({ ...state.result }) : null,
    lastPlay: state.lastPlay ? Object.freeze({ ...state.lastPlay }) : null
  });
}

function createGameState({
  gameId,
  awayLineup,
  homeLineup,
  awayPitcherId,
  homePitcherId,
  awayDefense = null,
  homeDefense = null,
  regulationInnings = ruleset2026.innings,
  automaticRunnerInExtras = ruleset2026.regularSeasonAutomaticRunnerInExtras
}) {
  assertId(gameId, "gameId");
  assertId(awayPitcherId, "awayPitcherId");
  assertId(homePitcherId, "homePitcherId");
  if (!Number.isInteger(regulationInnings) || regulationInnings < 1) {
    throw new RangeError("regulationInnings는 1 이상의 정수여야 합니다.");
  }

  return freezeState({
    schemaVersion: 6,
    gameId,
    regulationInnings,
    automaticRunnerInExtras: Boolean(automaticRunnerInExtras),
    status: GAME_STATUS.IN_PROGRESS,
    inning: 1,
    half: INNING_HALF.TOP,
    outs: 0,
    bases: { first: null, second: null, third: null },
    score: { away: 0, home: 0 },
    lineups: {
      away: normalizeLineup(awayLineup, "awayLineup"),
      home: normalizeLineup(homeLineup, "homeLineup")
    },
    battingOrderIndex: { away: 0, home: 0 },
    currentPitcherId: { away: awayPitcherId, home: homePitcherId },
    defensiveAlignment: {
      away: normalizeDefensiveAlignment(awayDefense, "awayDefense", awayPitcherId),
      home: normalizeDefensiveAlignment(homeDefense, "homeDefense", homePitcherId)
    },
    pitcherUsage: {
      away: { [awayPitcherId]: createPitcherUsageRecord(awayPitcherId, 1, INNING_HALF.BOTTOM) },
      home: { [homePitcherId]: createPitcherUsageRecord(homePitcherId, 1, INNING_HALF.TOP) }
    },
    plateAppearances: 0,
    substitutions: [],
    result: null,
    walkOff: false,
    lastPlay: null
  });
}

function getBattingTeam(state) {
  return state.half === INNING_HALF.TOP ? "away" : "home";
}

function getFieldingTeam(state) {
  return state.half === INNING_HALF.TOP ? "home" : "away";
}

function getCurrentBatterId(state) {
  const team = getBattingTeam(state);
  return state.lineups[team][state.battingOrderIndex[team]];
}

function getCurrentPitcherId(state) {
  return state.currentPitcherId[getFieldingTeam(state)];
}

function activeDefensivePosition(state, team, playerId) {
  for (const [position, id] of Object.entries(state.defensiveAlignment?.[team] ?? {})) {
    if (position !== "P" && id === playerId) return position;
  }
  return null;
}

/**
 * Apply an official position-player substitution while preserving the batting
 * slot. This owns only authoritative game-state mutation; the bench AI decides
 * whether a move should happen. Removed players cannot re-enter.
 */
function substitutePositionPlayer(state, { team, outPlayerId, inPlayerId, reason, position = null } = {}) {
  if (!state || typeof state !== "object") throw new TypeError("GameState가 필요합니다.");
  if (state.status !== GAME_STATUS.IN_PROGRESS) throw new RangeError("종료된 경기에는 선수를 교체할 수 없습니다.");
  if (team !== "away" && team !== "home") throw new RangeError("team은 away/home이어야 합니다.");
  assertId(outPlayerId, "outPlayerId");
  assertId(inPlayerId, "inPlayerId");
  if (outPlayerId === inPlayerId) throw new RangeError("교체 전후 선수는 달라야 합니다.");
  const allowedReasons = new Set(["PINCH_HIT", "PINCH_RUN", "DEFENSIVE_REPLACEMENT"]);
  if (!allowedReasons.has(reason)) throw new RangeError(`지원하지 않는 교체 사유입니다: ${reason}`);

  const lineup = state.lineups?.[team] ?? [];
  const slotIndex = lineup.indexOf(outPlayerId);
  if (slotIndex < 0) throw new RangeError(`현재 타순에 없는 outPlayerId입니다: ${outPlayerId}`);
  if (lineup.includes(inPlayerId)) throw new RangeError(`이미 현재 타순에 있는 inPlayerId입니다: ${inPlayerId}`);
  if (state.currentPitcherId?.[team] === inPlayerId) throw new RangeError("현재 투수는 포지션 선수 교체로 투입할 수 없습니다.");
  const history = state.substitutions ?? [];
  if (history.some((row) => row.inPlayerId === inPlayerId || row.outPlayerId === inPlayerId)) {
    throw new RangeError(`이미 경기에 사용된 교체 선수는 재투입할 수 없습니다: ${inPlayerId}`);
  }

  const battingTeam = getBattingTeam(state);
  const nextBases = { ...state.bases };
  const occupiedBases = Object.entries(nextBases).filter(([, id]) => id === outPlayerId);
  if (reason === "PINCH_RUN" && (battingTeam !== team || occupiedBases.length === 0)) {
    throw new RangeError("대주자는 현재 공격 팀의 베이스 주자와 교체해야 합니다.");
  }
  for (const [base] of occupiedBases) nextBases[base] = inPlayerId;

  const priorPosition = activeDefensivePosition(state, team, outPlayerId);
  const resolvedPosition = position ?? priorPosition ?? "DH";
  if (priorPosition && resolvedPosition !== priorPosition) {
    throw new RangeError("v37 포지션 선수 교체는 기존 수비 위치 또는 DH 타순 슬롯만 승계할 수 있습니다.");
  }
  if (!priorPosition && resolvedPosition !== "DH") {
    throw new RangeError("DH 타순 슬롯 교체는 DH 위치를 유지해야 합니다.");
  }

  const nextLineup = [...lineup];
  nextLineup[slotIndex] = inPlayerId;
  const nextAlignment = state.defensiveAlignment?.[team]
    ? { ...state.defensiveAlignment[team] }
    : null;
  if (priorPosition && nextAlignment) nextAlignment[priorPosition] = inPlayerId;

  const substitution = {
    inning: state.inning,
    half: state.half,
    plateAppearances: state.plateAppearances,
    team,
    slotIndex,
    outPlayerId,
    inPlayerId,
    reason,
    position: resolvedPosition
  };

  return freezeState({
    ...state,
    lineups: { ...state.lineups, [team]: nextLineup },
    bases: nextBases,
    defensiveAlignment: {
      ...state.defensiveAlignment,
      [team]: nextAlignment
    },
    substitutions: [...history, substitution]
  });
}

function setCurrentPitcher(state, team, pitcherId) {
  if (state.status !== GAME_STATUS.IN_PROGRESS) {
    throw new RangeError("종료된 경기의 투수를 변경할 수 없습니다.");
  }
  if (team !== "away" && team !== "home") throw new RangeError("team은 away/home이어야 합니다.");
  assertId(pitcherId, "pitcherId");
  const existing = state.pitcherUsage[team][pitcherId];
  const entryHalf = team === "home" ? INNING_HALF.TOP : INNING_HALF.BOTTOM;
  return freezeState({
    ...state,
    currentPitcherId: { ...state.currentPitcherId, [team]: pitcherId },
    defensiveAlignment: {
      ...state.defensiveAlignment,
      [team]: state.defensiveAlignment?.[team]
        ? { ...state.defensiveAlignment[team], P: pitcherId }
        : null
    },
    pitcherUsage: {
      ...state.pitcherUsage,
      [team]: {
        ...state.pitcherUsage[team],
        [pitcherId]: existing ?? createPitcherUsageRecord(pitcherId, state.inning, entryHalf)
      }
    }
  });
}

function winnerFromScore(score) {
  if (score.away > score.home) return "away";
  if (score.home > score.away) return "home";
  return null;
}

function finalState(state, { walkOff = false, lastPlay = state.lastPlay } = {}) {
  const winner = winnerFromScore(state.score);
  if (!winner) throw new Error("동점 상태를 FINAL로 만들 수 없습니다.");
  return freezeState({
    ...state,
    status: GAME_STATUS.FINAL,
    walkOff,
    result: { winner, loser: winner === "away" ? "home" : "away" },
    lastPlay
  });
}

function advanceBattingOrder(state, battingTeam) {
  return {
    ...state.battingOrderIndex,
    [battingTeam]: (state.battingOrderIndex[battingTeam] + 1) % state.lineups[battingTeam].length
  };
}

function getAutomaticRunnerId(state, battingTeam) {
  const lineup = state.lineups[battingTeam];
  const leadoffIndex = state.battingOrderIndex[battingTeam];
  return lineup[(leadoffIndex - 1 + lineup.length) % lineup.length];
}

function basesForHalfStart(state, battingTeam, inning) {
  if (!state.automaticRunnerInExtras || inning <= state.regulationInnings) {
    return { first: null, second: null, third: null };
  }
  return {
    first: null,
    second: getAutomaticRunnerId(state, battingTeam),
    third: null
  };
}

function endHalfInning(state) {
  const cleared = { ...state, outs: 0, bases: { first: null, second: null, third: null } };

  if (state.half === INNING_HALF.TOP) {
    if (state.inning >= state.regulationInnings && state.score.home > state.score.away) {
      return finalState(cleared);
    }
    return freezeState({
      ...cleared,
      half: INNING_HALF.BOTTOM,
      bases: basesForHalfStart(cleared, "home", cleared.inning)
    });
  }

  if (state.inning >= state.regulationInnings && state.score.home !== state.score.away) {
    return finalState(cleared);
  }

  const nextInning = state.inning + 1;
  return freezeState({
    ...cleared,
    inning: nextInning,
    half: INNING_HALF.TOP,
    bases: basesForHalfStart(cleared, "away", nextInning)
  });
}

/** Apply a steal/caught-stealing/pickoff event without consuming a PA. */
function applyRunningPlay(state, runningPlay) {
  if (!state || typeof state !== "object") throw new TypeError("GameState가 필요합니다.");
  if (state.status !== GAME_STATUS.IN_PROGRESS) throw new RangeError("종료된 경기에는 주루 이벤트를 적용할 수 없습니다.");
  if (!runningPlay || !["SB", "CS", "PICKOFF"].includes(runningPlay.kind)) {
    throw new RangeError("유효한 runningPlay가 필요합니다.");
  }
  const { runnerId, fromBase, toBase, kind } = runningPlay;
  if (!["first", "second", "third"].includes(fromBase) || !["second", "third", "home"].includes(toBase)) {
    throw new RangeError("runningPlay base 정보가 잘못되었습니다.");
  }
  if (state.bases[fromBase] !== runnerId) {
    throw new RangeError(`주자 ${runnerId}가 ${fromBase}에 없습니다.`);
  }

  const battingTeam = getBattingTeam(state);
  const fieldingTeam = getFieldingTeam(state);
  const pitcherId = getCurrentPitcherId(state);
  const nextBases = { ...state.bases, [fromBase]: null };
  let outsRecorded = 0;
  if (kind === "SB") {
    if (toBase === "home") throw new RangeError("Phase 1에서는 steal of home을 아직 지원하지 않습니다.");
    if (nextBases[toBase] !== null) throw new RangeError(`도루 목표 베이스 ${toBase}가 비어 있지 않습니다.`);
    nextBases[toBase] = runnerId;
  } else {
    outsRecorded = 1;
  }

  const currentUsage = state.pitcherUsage[fieldingTeam][pitcherId];
  if (!currentUsage) throw new RangeError(`현재 투수 usage를 찾을 수 없습니다: ${pitcherId}`);
  const nextPitcherUsage = {
    ...state.pitcherUsage,
    [fieldingTeam]: {
      ...state.pitcherUsage[fieldingTeam],
      [pitcherId]: {
        ...currentUsage,
        outsRecorded: currentUsage.outsRecorded + outsRecorded
      }
    }
  };
  const lastPlay = Object.freeze({
    playType: "RUNNING",
    inning: state.inning,
    half: state.half,
    battingTeam,
    fieldingTeam,
    pitcherId,
    catcherId: runningPlay.catcherId ?? null,
    runnerId,
    kind,
    fromBase,
    toBase,
    targetBase: runningPlay.targetBase,
    outsRecorded,
    attemptProbability: runningPlay.attemptProbability ?? null,
    successProbability: runningPlay.successProbability ?? null,
    pickoffOutProbability: runningPlay.pickoffOutProbability ?? null
  });

  let next = freezeState({
    ...state,
    outs: state.outs + outsRecorded,
    bases: nextBases,
    pitcherUsage: nextPitcherUsage,
    lastPlay
  });
  if (next.outs >= 3) next = endHalfInning(next);
  return next;
}

/**
 * Apply one already-resolved PA to authoritative game state.
 *
 * Baseball outcome math stays in the PA/runner engines; this function owns
 * official game progression: score, outs, bases, batting order, innings, and
 * walk-off/final state.
 */
function applyPAResult(state, paResult, rng, options = {}) {
  if (!state || typeof state !== "object") throw new TypeError("GameState가 필요합니다.");
  if (state.status !== GAME_STATUS.IN_PROGRESS) {
    throw new RangeError("종료된 경기에는 PA를 적용할 수 없습니다.");
  }
  const outcome = paResult?.finalOutcome;
  if (!TERMINAL_OUTCOMES.has(outcome)) {
    throw new RangeError(`유효한 finalOutcome이 아닙니다: ${outcome}`);
  }

  const battingTeam = getBattingTeam(state);
  const batterId = getCurrentBatterId(state);
  const pitcherId = getCurrentPitcherId(state);
  const isOut = outcome === "K" || outcome === "OUT";
  const runnerProfileResolver = options?.runnerProfileResolver ?? null;
  if (runnerProfileResolver !== null && typeof runnerProfileResolver !== "function") {
    throw new TypeError("runnerProfileResolver는 함수 또는 null이어야 합니다.");
  }
  const advancement = resolveRunnerAdvancement({
    bases: state.bases,
    batterId,
    outcome,
    outs: state.outs,
    rng,
    paResult,
    getRunnerProfile: runnerProfileResolver,
    gameContext: {
      inning: state.inning,
      regulationInnings: state.regulationInnings,
      battingScore: state.score[battingTeam],
      fieldingScore: state.score[getFieldingTeam(state)]
    }
  });

  const nextScore = { ...state.score };
  const isWalkOffSituation =
    battingTeam === "home" && state.inning >= state.regulationInnings;
  const countedRuns = [];

  for (const runnerId of advancement.scoredRunnerIds) {
    if (isWalkOffSituation && outcome !== "HR" && nextScore.home > nextScore.away) break;
    nextScore[battingTeam] += 1;
    countedRuns.push(runnerId);
  }

  // Runner outs can occur after hits/ROE as well as on batter outs. They must
  // always count toward the inning and pitcher/fielding reconciliation.
  const outsRecorded = (isOut ? 1 : 0) + advancement.additionalOuts;
  const nextOuts = state.outs + outsRecorded;
  const pitchCount = paResult.pitchCount ?? 0;
  if (!Number.isInteger(pitchCount) || pitchCount < 0) {
    throw new RangeError("paResult.pitchCount는 0 이상의 정수여야 합니다.");
  }
  const fieldingTeam = getFieldingTeam(state);
  const currentUsage = state.pitcherUsage[fieldingTeam][pitcherId];
  if (!currentUsage) throw new RangeError(`현재 투수 usage를 찾을 수 없습니다: ${pitcherId}`);
  const nextPitcherUsage = {
    ...state.pitcherUsage,
    [fieldingTeam]: {
      ...state.pitcherUsage[fieldingTeam],
      [pitcherId]: {
        ...currentUsage,
        pitchCount: currentUsage.pitchCount + pitchCount,
        battersFaced: currentUsage.battersFaced + 1,
        outsRecorded: currentUsage.outsRecorded + outsRecorded,
        runsAllowed: currentUsage.runsAllowed + countedRuns.length
      }
    }
  };
  const lastPlay = {
    playType: "PA",
    paNumber: state.plateAppearances + 1,
    inning: state.inning,
    half: state.half,
    batterId,
    pitcherId,
    outcome,
    pitchCount,
    battingTeam,
    fieldingTeam,
    runsScored: countedRuns.length,
    outsRecorded,
    outRunnerIds: advancement.outRunnerIds,
    scoredRunnerIds: Object.freeze([...countedRuns]),
    isSacrificeFly: advancement.isSacrificeFly,
    isGroundBallDoublePlay: advancement.isGroundBallDoublePlay,
    responsibleFielderId: paResult?.battedBallResult?.defense?.responsibleFielderId ?? null,
    responsiblePosition: paResult?.battedBallResult?.defense?.responsiblePosition ?? null,
    defensiveMode: paResult?.battedBallResult?.defense?.defensiveMode ?? null,
    defensiveFailureStage: paResult?.battedBallResult?.defense?.failureStage ?? null,
    reachedOnError: Boolean(paResult?.battedBallResult?.defense?.reachedOnError),
    error: paResult?.battedBallResult?.defense?.error
      ? Object.freeze({ ...paResult.battedBallResult.defense.error })
      : null,
    advancementEvents: Object.freeze([...(advancement.advancementEvents ?? [])])
  };

  let next = freezeState({
    ...state,
    outs: nextOuts,
    bases: advancement.bases,
    score: nextScore,
    battingOrderIndex: advanceBattingOrder(state, battingTeam),
    pitcherUsage: nextPitcherUsage,
    plateAppearances: state.plateAppearances + 1,
    lastPlay
  });

  if (
    isWalkOffSituation &&
    outcome !== "HR" &&
    next.score.home > next.score.away
  ) {
    return finalState(next, { walkOff: true, lastPlay });
  }
  if (
    isWalkOffSituation &&
    outcome === "HR" &&
    next.score.home > next.score.away
  ) {
    return finalState(next, { walkOff: true, lastPlay });
  }

  if (next.outs >= 3) return endHalfInning(next);
  return next;
}

export { GAME_STATUS, INNING_HALF, FIELDING_POSITIONS, createGameState, getBattingTeam, getFieldingTeam, getCurrentBatterId, getCurrentPitcherId, substitutePositionPlayer, setCurrentPitcher, applyRunningPlay, applyPAResult };
