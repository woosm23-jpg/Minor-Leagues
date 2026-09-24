const MS_PER_DAY = 86400000;

function utcDay(isoDate) {
  if (
    typeof isoDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)
  ) {
    return null;
  }

  const time = Date.parse(`${isoDate}T00:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== isoDate
  ) {
    return null;
  }

  return Math.floor(time / MS_PER_DAY);
}

/**
 * Independent of season-state recovery: a pitcher can have a low
 * numerical fatigue after an off day and still need workload protection.
 * The existing lastAppearanceDate / lastPitchCount are authoritative.
 */
function assessBullpenRecovery({
  gameDate,
  lastAppearanceDate = null,
  lastPitchCount = 0
} = {}) {
  const current = utcDay(gameDate);
  if (current === null) {
    throw new TypeError("유효한 gameDate가 필요합니다.");
  }

  if (lastAppearanceDate == null) {
    return Object.freeze({
      status: "READY",
      daysSinceAppearance: null,
      reason: "NO_PRIOR_APPEARANCE"
    });
  }

  const previous = utcDay(lastAppearanceDate);
  if (previous === null) {
    return Object.freeze({
      status: "LIMITED",
      daysSinceAppearance: null,
      reason: "UNVERIFIED_APPEARANCE_DATE"
    });
  }

  const gap = current - previous;
  const pitches = Number.isFinite(Number(lastPitchCount))
    ? Math.max(0, Number(lastPitchCount))
    : 0;

  if (gap < 0) {
    return Object.freeze({
      status: "REST",
      daysSinceAppearance: gap,
      reason: "FUTURE_APPEARANCE_DATE"
    });
  }

  if (gap === 0) {
    return Object.freeze({
      status: "REST",
      daysSinceAppearance: gap,
      reason: "ALREADY_PITCHED_TODAY"
    });
  }

  if (gap === 1 && pitches >= 30) {
    return Object.freeze({
      status: "REST",
      daysSinceAppearance: gap,
      reason: "HEAVY_PREVIOUS_DAY"
    });
  }

  if (
    (gap === 1 && pitches >= 18) ||
    (gap === 2 && pitches >= 45)
  ) {
    return Object.freeze({
      status: "LIMITED",
      daysSinceAppearance: gap,
      reason: "RECENT_WORKLOAD"
    });
  }

  return Object.freeze({
    status: "READY",
    daysSinceAppearance: gap,
    reason: "RECOVERED"
  });
}

export { assessBullpenRecovery };
