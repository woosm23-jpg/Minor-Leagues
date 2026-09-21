const HIT_OUTCOMES = new Set(["1B", "2B", "3B", "HR"]);

function freezeFielding(fielding = []) {
  return Object.freeze(fielding.map((delta) => Object.freeze({ ...delta })));
}

function freezeEvent(event) {
  return Object.freeze({
    ...event,
    batting: Object.freeze({ ...event.batting }),
    pitching: Object.freeze({ ...event.pitching }),
    fielding: freezeFielding(event.fielding),
    scoredRunnerIds: Object.freeze([...(event.scoredRunnerIds ?? [])])
  });
}

function emptyBattingDelta() {
  return {
    PA: 0,
    AB: 0,
    R: 0,
    H: 0,
    doubles: 0,
    triples: 0,
    HR: 0,
    RBI: 0,
    BB: 0,
    HBP: 0,
    SO: 0,
    SF: 0,
    GDP: 0,
    TB: 0,
    ROE: 0
  };
}

function emptyPitchingDelta() {
  return {
    BF: 0,
    outsRecorded: 0,
    H: 0,
    doubles: 0,
    triples: 0,
    HR: 0,
    BB: 0,
    HBP: 0,
    SO: 0,
    R: 0,
    Pitches: 0
  };
}

function addFieldingDelta(map, playerId, delta) {
  if (!playerId) return;
  const current = map.get(playerId) ?? { playerId, PO: 0, A: 0, E: 0, DP: 0 };
  for (const key of ["PO", "A", "E", "DP"]) current[key] += delta[key] ?? 0;
  map.set(playerId, current);
}

function getAlignment(before, fieldingTeam) {
  return before?.defensiveAlignment?.[fieldingTeam] ?? null;
}

function receiverPositionForAdvancementKind(kind) {
  if (kind === "SECOND_HOME_SINGLE" || kind === "FIRST_HOME_DOUBLE" || kind === "TAG_HOME") return "C";
  if (kind === "FIRST_THIRD_SINGLE" || kind === "TAG_SECOND_THIRD") return "3B";
  if (kind === "TAG_FIRST_SECOND") return "2B";
  return null;
}

function appendAdvancementOutFielding(map, play, alignment) {
  if (!alignment) return;
  for (const event of play.advancementEvents ?? []) {
    if (!event?.out || event.kind === "GROUND_BALL_DOUBLE_PLAY") continue;
    const receiverPosition = receiverPositionForAdvancementKind(event.kind);
    if (!receiverPosition) continue;
    addFieldingDelta(map, event.throwingFielderId, { A: 1 });
    addFieldingDelta(map, alignment[receiverPosition], { PO: 1 });
  }
}

function fieldingDeltasForPA({ before, play, paResult, officialOutcome }) {
  const alignment = getAlignment(before, play.fieldingTeam);
  if (!alignment) return [];
  const map = new Map();

  if (officialOutcome === "ROE") {
    const error = play.error ?? paResult?.battedBallResult?.defense?.error;
    addFieldingDelta(map, error?.fielderId ?? play.responsibleFielderId, { E: 1 });
    return [...map.values()];
  }

  if (officialOutcome === "K") {
    addFieldingDelta(map, alignment.C, { PO: 1 });
    return [...map.values()];
  }

  const launchType = paResult?.launchAngle?.type ?? null;
  const responsibleId = play.responsibleFielderId;
  const responsiblePosition = play.responsiblePosition;

  if (officialOutcome === "OUT") {
    if (launchType === "GB") {
      if (play.isGroundBallDoublePlay) {
        const pivotPosition = responsiblePosition === "SS" || responsiblePosition === "3B" ? "2B" : "SS";
        const pivotId = alignment[pivotPosition];
        addFieldingDelta(map, responsibleId, { A: 1, DP: 1 });
        addFieldingDelta(map, pivotId, { PO: 1, A: 1, DP: 1 });
        addFieldingDelta(map, alignment["1B"], { PO: 1, DP: 1 });
      } else if (responsiblePosition === "1B") {
        addFieldingDelta(map, responsibleId, { PO: 1 });
      } else {
        addFieldingDelta(map, responsibleId, { A: 1 });
        addFieldingDelta(map, alignment["1B"], { PO: 1 });
      }
    } else {
      addFieldingDelta(map, responsibleId, { PO: 1 });
    }
  }

  appendAdvancementOutFielding(map, play, alignment);
  return [...map.values()];
}

function receiverPositionForRunningPlay(kind, targetBase, fromBase) {
  if (kind === "CS") {
    if (targetBase === 2) return "2B";
    if (targetBase === 3) return "3B";
  }
  if (kind === "PICKOFF") {
    if (fromBase === "first") return "1B";
    if (fromBase === "second") return "2B";
    if (fromBase === "third") return "3B";
  }
  return null;
}

function fieldingDeltasForRunningPlay(before, play) {
  const alignment = getAlignment(before, play.fieldingTeam);
  if (!alignment || play.outsRecorded !== 1) return [];
  const map = new Map();
  const receiverPosition = receiverPositionForRunningPlay(play.kind, play.targetBase, play.fromBase);
  if (!receiverPosition) return [];

  if (play.kind === "CS") {
    addFieldingDelta(map, play.catcherId ?? alignment.C, { A: 1 });
    addFieldingDelta(map, alignment[receiverPosition], { PO: 1 });
  } else if (play.kind === "PICKOFF") {
    addFieldingDelta(map, play.pitcherId, { A: 1 });
    addFieldingDelta(map, alignment[receiverPosition], { PO: 1 });
  }
  return [...map.values()];
}

/**
 * Build the official-stat event for one completed PA.
 *
 * GameState owns score/base/out progression. This module interprets that
 * authoritative transition into official counting-stat deltas. No persistent
 * stat object is mutated here.
 */
function createPAStatEvent({ before, after, paResult, batterId, pitcherId }) {
  if (!before || !after) throw new TypeError("before/after GameState가 필요합니다.");
  if (!paResult || typeof paResult !== "object") throw new TypeError("paResult가 필요합니다.");
  if (typeof batterId !== "string" || batterId.length === 0) throw new TypeError("batterId가 필요합니다.");
  if (typeof pitcherId !== "string" || pitcherId.length === 0) throw new TypeError("pitcherId가 필요합니다.");

  const play = after.lastPlay;
  if (!play || play.paNumber !== before.plateAppearances + 1) {
    throw new RangeError("PA 직후 GameState의 lastPlay가 필요합니다.");
  }

  const engineOutcome = paResult.finalOutcome;
  const officialOutcome = play.reachedOnError || engineOutcome === "ROE" ? "ROE" : engineOutcome;
  const batting = emptyBattingDelta();
  const pitching = emptyPitchingDelta();
  const runsScored = play.scoredRunnerIds.length;
  const isSacrificeFly = Boolean(play.isSacrificeFly);
  const isGroundBallDoublePlay = Boolean(play.isGroundBallDoublePlay);

  batting.PA = 1;
  pitching.BF = 1;
  pitching.outsRecorded = play.outsRecorded;
  pitching.R = runsScored;
  pitching.Pitches = play.pitchCount ?? paResult.pitchCount ?? 0;

  if (officialOutcome === "BB") {
    batting.BB = 1;
    batting.RBI = runsScored;
    pitching.BB = 1;
  } else if (officialOutcome === "HBP") {
    batting.HBP = 1;
    batting.RBI = runsScored;
    pitching.HBP = 1;
  } else if (officialOutcome === "K") {
    batting.AB = 1;
    batting.SO = 1;
    pitching.SO = 1;
  } else if (officialOutcome === "OUT") {
    if (isSacrificeFly) {
      batting.SF = 1;
      batting.RBI = runsScored;
    } else {
      batting.AB = 1;
      batting.GDP = isGroundBallDoublePlay ? 1 : 0;
      batting.RBI = isGroundBallDoublePlay ? 0 : runsScored;
    }
  } else if (officialOutcome === "ROE") {
    batting.AB = 1;
    batting.ROE = 1;
    // Baseline scoring: a run that scores because of the error is not credited
    // as an RBI. Judged RBI-on-error exceptions are deferred.
    batting.RBI = 0;
  } else if (HIT_OUTCOMES.has(officialOutcome)) {
    batting.AB = 1;
    batting.H = 1;
    batting.RBI = runsScored;
    pitching.H = 1;

    if (officialOutcome === "1B") batting.TB = 1;
    else if (officialOutcome === "2B") {
      batting.doubles = 1;
      batting.TB = 2;
      pitching.doubles = 1;
    } else if (officialOutcome === "3B") {
      batting.triples = 1;
      batting.TB = 3;
      pitching.triples = 1;
    } else {
      batting.HR = 1;
      batting.TB = 4;
      batting.R = 1;
      pitching.HR = 1;
    }
  } else {
    throw new RangeError(`지원하지 않는 공식기록 결과입니다: ${officialOutcome}`);
  }

  const fielding = fieldingDeltasForPA({ before, play, paResult, officialOutcome });

  return freezeEvent({
    schemaVersion: 3,
    type: "PA_STAT",
    gameId: before.gameId,
    paNumber: play.paNumber,
    inning: play.inning,
    half: play.half,
    battingTeam: play.battingTeam,
    fieldingTeam: play.fieldingTeam,
    batterId,
    pitcherId,
    outcome: officialOutcome,
    engineOutcome,
    reachedOnError: officialOutcome === "ROE",
    error: play.error ? Object.freeze({ ...play.error }) : null,
    isSacrificeFly,
    isGroundBallDoublePlay,
    batting,
    pitching,
    fielding,
    scoredRunnerIds: play.scoredRunnerIds
  });
}

/** Build an official running stat event without consuming a PA. */
function createRunnerStatEvent({ before, after, runningPlay }) {
  if (!before || !after) throw new TypeError("before/after GameState가 필요합니다.");
  if (!runningPlay || !["SB", "CS", "PICKOFF"].includes(runningPlay.kind)) {
    throw new RangeError("유효한 runningPlay가 필요합니다.");
  }
  const play = before.lastPlay === after.lastPlay ? null : (after.lastPlay?.playType === "RUNNING" ? after.lastPlay : null);
  const authoritative = play ?? after.lastPlay;
  if (!authoritative || authoritative.playType !== "RUNNING") {
    throw new RangeError("주루 이벤트 직후 GameState lastPlay가 필요합니다.");
  }
  return freezeEvent({
    schemaVersion: 2,
    type: "RUNNER_STAT",
    gameId: before.gameId,
    inning: authoritative.inning,
    half: authoritative.half,
    battingTeam: authoritative.battingTeam,
    fieldingTeam: authoritative.fieldingTeam,
    runnerId: authoritative.runnerId,
    pitcherId: authoritative.pitcherId,
    catcherId: authoritative.catcherId,
    kind: authoritative.kind,
    fromBase: authoritative.fromBase,
    toBase: authoritative.toBase,
    targetBase: authoritative.targetBase,
    outsRecorded: authoritative.outsRecorded,
    batting: Object.freeze({
      SB: authoritative.kind === "SB" ? 1 : 0,
      CS: authoritative.kind === "CS" ? 1 : 0,
      PKO: authoritative.kind === "PICKOFF" ? 1 : 0
    }),
    pitching: Object.freeze({ outsRecorded: authoritative.outsRecorded }),
    fielding: fieldingDeltasForRunningPlay(before, authoritative),
    scoredRunnerIds: []
  });
}

export { createPAStatEvent, createRunnerStatEvent };
