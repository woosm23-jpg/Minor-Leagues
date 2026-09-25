const RECORD_CATEGORIES = Object.freeze([
  Object.freeze({ key: "H", label: "안타", kind: "HITTER", section: "batting", field: "H" }),
  Object.freeze({ key: "HR", label: "홈런", kind: "HITTER", section: "batting", field: "HR" }),
  Object.freeze({ key: "RBI", label: "타점", kind: "HITTER", section: "batting", field: "RBI" }),
  Object.freeze({ key: "SB", label: "도루", kind: "HITTER", section: "batting", field: "SB" }),
  Object.freeze({ key: "SO", label: "탈삼진", kind: "PITCHER", section: "pitching", field: "SO" }),
  Object.freeze({ key: "IP", label: "투구 이닝", kind: "PITCHER", section: "pitching", field: "outsRecorded" })
]);
const cachedRecords = new WeakMap();

function safeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value) : 0;
}

function inningsDisplay(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// This is a game-world record table, NOT historical real-MLB all-time records.
// The ledger only includes MLB games completed inside this career save.
function getCareerRecordsPublicView(state) {
  if (!state || typeof state !== "object") return null;
  if (Object.isFrozen(state) && cachedRecords.has(state)) return cachedRecords.get(state);
  const years = [...new Set((state.recordedSeasons ?? [])
    .filter(Number.isInteger))].sort((a, b) => a - b);
  const ledger = Object.values(state.careerLedger ?? {})
    .filter(entry => entry && safeCount(entry.mlbSeasons) > 0);
  const userId = String(state.userPlayerId ?? "");
  const categories = Object.fromEntries(RECORD_CATEGORIES.map(spec => {
    const rows = ledger.filter(entry => (entry.isPitcher === true) === (spec.kind === "PITCHER"))
      .map(entry => {
        const value = safeCount(entry.totals?.[spec.section]?.[spec.field]);
        return {
          playerId: String(entry.playerId), name: String(entry.name ?? entry.playerId),
          position: String(entry.position ?? "-"), value,
          display: spec.key === "IP" ? inningsDisplay(value) : String(value),
          mlbSeasons: safeCount(entry.mlbSeasons),
          firstMlbYear: entry.firstMlbYear ?? null,
          lastMlbYear: entry.lastMlbYear ?? null
        };
      }).filter(entry => entry.value > 0)
      .sort((a, b) => b.value - a.value || a.playerId.localeCompare(b.playerId));
    const index = rows.findIndex(entry => entry.playerId === userId);
    return [spec.key, Object.freeze({
      label: spec.label, unit: spec.key === "IP" ? "BASEBALL_INNINGS" : "COUNT",
      userRank: index < 0 ? null : index + 1,
      totalEligible: rows.length,
      leaders: Object.freeze(rows.slice(0, 5).map((entry, i) => Object.freeze({ ...entry, rank: i + 1 })))
    })];
  }));
  const result = Object.freeze({
    scope: "SIMULATED_MLB_IN_THIS_SAVE_ONLY",
    startYear: Number.isInteger(state.startYear) ? state.startYear : null,
    throughYear: years.at(-1) ?? null,
    includedSeasons: Object.freeze(years),
    categories: Object.freeze(categories)
  });
  if (Object.isFrozen(state)) cachedRecords.set(state, result);
  return result;
}

export { RECORD_CATEGORIES, getCareerRecordsPublicView };
