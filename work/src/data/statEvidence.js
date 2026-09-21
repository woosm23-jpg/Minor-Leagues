function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function inningsToOuts(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value * 3;
  const text = String(value);
  const [whole, frac = "0"] = text.split(".");
  const w = Number(whole);
  const f = Number(frac);
  if (!Number.isFinite(w) || !Number.isFinite(f)) return 0;
  return Math.max(0, Math.round(w) * 3 + Math.max(0, Math.min(2, Math.round(f))));
}

function outsToInnings(outs) {
  const n = Math.max(0, Math.round(Number(outs) || 0));
  return `${Math.floor(n / 3)}.${n % 3}`;
}

const ADDITIVE = Object.freeze({
  hitting: new Set([
    "gamesPlayed","games","plateAppearances","atBats","runs","hits","doubles","triples","homeRuns","rbi","runsBattedIn",
    "baseOnBalls","intentionalWalks","strikeOuts","hitByPitch","sacBunts","sacFlies","stolenBases","caughtStealing","groundIntoDoublePlay","totalBases"
  ]),
  pitching: new Set([
    "gamesPlayed","gamesPitched","games","gamesStarted","starts","wins","losses","saves","saveOpportunities","holds","blownSaves",
    "battersFaced","atBats","hits","doubles","triples","homeRuns","runs","earnedRuns","baseOnBalls","intentionalWalks","strikeOuts",
    "hitByPitch","balks","wildPitches","pickoffs","stolenBases","caughtStealing","numberOfPitches","strikes"
  ]),
  fielding: new Set([
    "gamesPlayed","games","gamesStarted","starts","putOuts","assists","errors","chances","doublePlays","triplePlays","passedBall","wildPitch","stolenBases","caughtStealing"
  ])
});

function sampleSize(row) {
  const values = row?.values ?? {};
  const group = row?.group;
  if (group === "hitting") return num(values.plateAppearances) ?? num(values.atBats) ?? 0;
  if (group === "pitching") return num(values.battersFaced) ?? inningsToOuts(values.inningsPitched) / 3 * 4.25;
  if (group === "fielding") return num(values.chances) ?? num(values.gamesPlayed) ?? num(values.games) ?? 0;
  return 0;
}

function sameSplitContext(a, b) {
  const av = a?.splitContext ?? { type: "TOTAL" };
  const bv = b?.splitContext ?? { type: "TOTAL" };
  return JSON.stringify(av) === JSON.stringify(bv);
}

function aggregateStatRows(rows = [], { season = null, group = null } = {}) {
  const filtered = rows.filter((row) => (season == null || Number(row.season) === Number(season)) && (group == null || row.group === group));
  if (!filtered.length) return null;
  const targetGroup = group ?? filtered[0].group;
  const compatible = filtered.filter((row) => row.group === targetGroup && sameSplitContext(row, filtered[0]));
  const latest = season == null ? Math.max(...compatible.map((row) => Number(row.season) || 0)) : Number(season);
  const sameSeason = compatible.filter((row) => Number(row.season) === latest);

  // Some feeds can expose an explicit all-team total beside team splits. If that
  // total is at least as large as the combined split sample, trust it instead of
  // double-counting the same events.
  const totalRows = sameSeason.filter((row) => row.teamId == null);
  const splitRows = sameSeason.filter((row) => row.teamId != null);
  if (totalRows.length === 1 && splitRows.length) {
    const totalSample = sampleSize(totalRows[0]);
    const splitSample = splitRows.reduce((sum, row) => sum + sampleSize(row), 0);
    if (totalSample >= splitSample * 0.9) {
      return { season: latest, group: targetGroup, values: { ...(totalRows[0].values ?? {}) }, rows: [totalRows[0]], sample: totalSample };
    }
  }

  const values = {};
  const additive = ADDITIVE[targetGroup] ?? new Set();
  let inningsOuts = 0;
  let fieldingOuts = 0;
  for (const row of sameSeason) {
    for (const [key, raw] of Object.entries(row.values ?? {})) {
      if (key === "inningsPitched") { inningsOuts += inningsToOuts(raw); continue; }
      if (targetGroup === "fielding" && key === "innings") { fieldingOuts += inningsToOuts(raw); continue; }
      if (!additive.has(key)) continue;
      const n = num(raw);
      if (n != null) values[key] = (num(values[key]) ?? 0) + n;
    }
  }
  if (targetGroup === "pitching" && sameSeason.some((row) => row.values?.inningsPitched != null)) values.inningsPitched = outsToInnings(inningsOuts);
  if (targetGroup === "fielding" && sameSeason.some((row) => row.values?.innings != null)) values.innings = outsToInnings(fieldingOuts);

  // Preserve non-additive evidence from the largest-sample row only. Derived
  // rate stats are intentionally recomputed by inference from the summed counts.
  const representative = [...sameSeason].sort((a, b) => sampleSize(b) - sampleSize(a))[0];
  for (const [key, raw] of Object.entries(representative?.values ?? {})) if (!(key in values) && key !== "inningsPitched" && key !== "innings") values[key] = raw;

  return { season: latest, group: targetGroup, values, rows: sameSeason, sample: sameSeason.reduce((sum, row) => sum + sampleSize(row), 0) };
}

function aggregateLatestSeasonValues(rows = []) {
  return aggregateStatRows(rows)?.values ?? {};
}

function positionExperienceFromStats(rows = []) {
  const byPosition = new Map();
  for (const row of rows) {
    if (row.group !== "fielding" || !row.position) continue;
    const position = String(row.position).toUpperCase();
    const values = row.values ?? {};
    const existing = byPosition.get(position) ?? { position, games: 0, starts: 0, inningsOuts: 0, seasons: new Set() };
    existing.games += num(values.gamesPlayed) ?? num(values.games) ?? 0;
    existing.starts += num(values.gamesStarted) ?? num(values.starts) ?? 0;
    existing.inningsOuts += inningsToOuts(values.innings);
    existing.seasons.add(Number(row.season));
    byPosition.set(position, existing);
  }
  return [...byPosition.values()].map((row) => ({
    position: row.position, games: row.games, starts: row.starts, innings: Number((row.inningsOuts / 3).toFixed(1)), seasons: [...row.seasons].sort((a, b) => b - a)
  })).sort((a, b) => b.innings - a.innings || b.games - a.games || a.position.localeCompare(b.position));
}

function sampleFromValues(group, values = {}) {
  if (group === "hitting") return { plateAppearances: num(values.plateAppearances) ?? num(values.atBats) ?? 0 };
  if (group === "pitching") return { battersFaced: num(values.battersFaced) ?? 0, inningsPitched: values.inningsPitched ?? null };
  if (group === "fielding") return { chances: num(values.chances) ?? 0, games: num(values.gamesPlayed) ?? num(values.games) ?? 0 };
  return {};
}

export { aggregateStatRows, aggregateLatestSeasonValues, positionExperienceFromStats, sampleFromValues, inningsToOuts, outsToInnings };
