import { healthAvailability } from "./injuryState.js";

const FIELD_POSITIONS = new Set(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);

function availableSecondaryPositions(state, player) {
  const primary = state?.primaryPosition ?? player?.positioning?.primaryPosition ?? "DH";
  const familiarity = state?.positionFamiliarity ?? player?.positioning?.familiarity ?? {};
  return Object.freeze(Object.keys(familiarity)
    .filter((position) => FIELD_POSITIONS.has(position) && position !== primary)
    .sort());
}

function setSecondaryPositionTraining(state, player, targetPosition) {
  if (!state || !player || state.playerId !== player.id) {
    throw new TypeError("부포지션 훈련에는 일치하는 선수 상태가 필요합니다.");
  }
  if (targetPosition !== null && !availableSecondaryPositions(state, player).includes(targetPosition)) {
    throw new RangeError(`선택할 수 없는 부포지션 훈련입니다: ${targetPosition}`);
  }
  if ((state.positionTraining?.targetPosition ?? null) === targetPosition) return state;
  return Object.freeze({ ...state, positionTraining: Object.freeze({
    targetPosition, trainedDays: 0, lastTrainingDate: null
  }) });
}

// This is calendar practice, not a real game rep. It changes no development
// budget, rating, role, roster slot, or lineup decision directly.
function advanceSecondaryPositionTraining(state, player, { days, date } = {}) {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("훈련 진행 날짜가 잘못되었습니다.");
  const training = state?.positionTraining ?? null;
  if (!training?.targetPosition || days === 0) return state;
  const position = training.targetPosition;
  if (!availableSecondaryPositions(state, player).includes(position)) return state;
  // Conservative injury rule: no practice credit for an interval that began
  // while injured; returning to play never earns retroactive training.
  if (healthAvailability(state.health) !== "AVAILABLE") return state;
  const current = Number(state.positionFamiliarity[position]);
  if (!Number.isFinite(current) || current < 0.35 || current > 1) {
    throw new RangeError("부포지션 친숙도 값이 잘못되었습니다.");
  }
  const adaptability = Math.max(20, Math.min(99, Number(player.positioning?.adaptability ?? 50)));
  const dailyGain = 0.003 + ((adaptability - 20) / 79) * 0.002;
  const next = Math.min(1, Math.max(current,
    Number((1 - (1 - current) * Math.pow(1 - dailyGain, days)).toFixed(6))));
  return Object.freeze({
    ...state,
    positionFamiliarity: Object.freeze({ ...state.positionFamiliarity, [position]: next }),
    positionTraining: Object.freeze({
      targetPosition: position,
      trainedDays: training.trainedDays + days,
      lastTrainingDate: date
    })
  });
}

function validateSecondaryPositionTraining(value, label = "positionTraining") {
  if (value == null) return true; // Historical saves predate this feature.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 값이 잘못되었습니다.`);
  }
  if (value.targetPosition !== null && !FIELD_POSITIONS.has(value.targetPosition)) {
    throw new RangeError(`${label} 부포지션이 잘못되었습니다.`);
  }
  if (!Number.isInteger(value.trainedDays) || value.trainedDays < 0 || value.trainedDays > 100000) {
    throw new RangeError(`${label} 훈련 일수가 잘못되었습니다.`);
  }
  if (value.lastTrainingDate !== null &&
      (typeof value.lastTrainingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.lastTrainingDate))) {
    throw new RangeError(`${label} 훈련 날짜가 잘못되었습니다.`);
  }
  return true;
}

export {
  availableSecondaryPositions, setSecondaryPositionTraining,
  advanceSecondaryPositionTraining, validateSecondaryPositionTraining
};
