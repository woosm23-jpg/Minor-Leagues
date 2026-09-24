const MIN_POSTSEASON_ROSTER_SIZE = 20;

/**
 * A two-way player occupies one postseason roster spot even when listed as a
 * hitter and a pitcher. A two-way player also counts against maxPitchers.
 * Never fabricate a 26th player when the source roster has fewer unique IDs.
 */
function selectPostseasonRosterPlayerIds(roster, {
  excludeId = null,
  forceIncludeId = null,
  rosterSize = 26,
  maxPitchers = 13
} = {}) {
  if (!roster || typeof roster !== "object") throw new TypeError("postseason source roster가 필요합니다.");
  if (!Number.isInteger(rosterSize) || rosterSize < MIN_POSTSEASON_ROSTER_SIZE) throw new RangeError("postseason rosterSize가 잘못되었습니다.");
  if (!Number.isInteger(maxPitchers) || maxPitchers < 1 || maxPitchers >= rosterSize) throw new RangeError("postseason maxPitchers가 잘못되었습니다.");

  const excluded = excludeId == null ? null : String(excludeId);
  const forced = forceIncludeId == null ? null : String(forceIncludeId);
  if (forced !== null && forced === excluded) throw new RangeError("postseason forceIncludeId와 excludeId가 같습니다.");

  const hitters = [], pitchers = [];
  const push = (array, id) => {
    if (id == null || String(id) === "" || String(id) === excluded) return;
    const key = String(id);
    if (!array.includes(key)) array.push(key);
  };
  for (const id of roster.lineup ?? []) push(hitters, id);
  for (const row of roster.bench ?? []) push(hitters, row?.playerId);
  if (forced !== null && (roster.positionPlayers ?? []).some((id) => String(id) === forced)) push(hitters, forced);
  for (const id of roster.positionPlayers ?? []) push(hitters, id);
  for (const id of roster.starters ?? []) push(pitchers, id);
  if (forced !== null && (roster.pitchers ?? []).some((id) => String(id) === forced)) push(pitchers, forced);
  for (const id of roster.bullpen ?? []) push(pitchers, id);
  for (const id of roster.pitchers ?? []) push(pitchers, id);

  const pitcherSet = new Set(pitchers);
  const hitterTarget = rosterSize - maxPitchers;
  const chosenHitters = hitters.slice(0, hitterTarget);
  if (forced !== null && hitters.includes(forced) && !chosenHitters.includes(forced)) {
    if (chosenHitters.length === hitterTarget) chosenHitters.pop();
    chosenHitters.push(forced);
  }

  const selected = [...chosenHitters];
  const selectedSet = new Set(selected);
  let pitcherCount = selected.filter((id) => pitcherSet.has(id)).length;
  const add = (id) => {
    if (selected.length >= rosterSize || selectedSet.has(id)) return false;
    if (pitcherSet.has(id) && pitcherCount >= maxPitchers) return false;
    selected.push(id);
    selectedSet.add(id);
    if (pitcherSet.has(id)) pitcherCount += 1;
    return true;
  };

  const orderedPitchers = forced !== null && pitchers.includes(forced) && !selectedSet.has(forced)
    ? [forced, ...pitchers.filter((id) => id !== forced)]
    : pitchers;
  for (const id of orderedPitchers) add(id);
  for (const id of hitters) add(id);
  for (const id of pitchers) add(id);

  if (forced !== null && (hitters.includes(forced) || pitchers.includes(forced)) && !selectedSet.has(forced)) {
    throw new RangeError(`${roster.team?.name ?? roster.team?.id ?? "team"} postseason 강제 포함 선수가 로스터에서 누락됐습니다: ${forced}`);
  }
  if (selected.length < MIN_POSTSEASON_ROSTER_SIZE) {
    throw new RangeError(`${roster.team?.name ?? roster.team?.id ?? "team"} postseason 로스터에 중복 없는 선수가 부족합니다: ${selected.length} < ${MIN_POSTSEASON_ROSTER_SIZE}`);
  }
  return selected;
}

export { MIN_POSTSEASON_ROSTER_SIZE, selectPostseasonRosterPlayerIds };
