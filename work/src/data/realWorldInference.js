import { inverseStandardNormalCdf } from "../engine/distributions/normalQuantile.js";
import { latentToRating, ratingToLatent } from "../engine/ratings/latentRating.js";
import { internalRatingTo2080 } from "../engine/season/scoutingState.js";
import { aggregateStatRows, inningsToOuts } from "./statEvidence.js";
import { publicScoutingGrade } from "./publicScoutingPatch.js";

const REAL_WORLD_INFERENCE_SCHEMA_VERSION = 2;
const REAL_WORLD_INFERENCE_MODEL_ID = "real_rating_current_ability_v2_c7";
const MLB_REFERENCE_ENVIRONMENT_2025 = Object.freeze({
  season: 2025, runsPerTeamGame: 4.45, plateAppearancesPerTeamGame: 37.64,
  battingAverage: 0.245, onBasePercentage: 0.315, sluggingPercentage: 0.404,
  homeRunsPerPa: 5650 / 182926, walksPerPa: 15379 / 182926, strikeoutsPerPa: 40645 / 182926
});

const LEVEL_BASE_RATING = Object.freeze({ MLB: 50, AAA: 43, AA: 37, HIGH_A: 32, A: 28 });
const LEVEL_AGE_REFERENCE = Object.freeze({ MLB: 27.9, AAA: 25.4, AA: 23.7, HIGH_A: 22.4, A: 21.5 });
const POSITION_VALUE = Object.freeze({ C: 2.4, SS: 2.2, CF: 1.8, "2B": 0.8, "3B": 0.6, RF: 0.2, LF: -0.3, "1B": -0.6, DH: -1.2, SP: 1.8, SWING: 0.7, RP: -0.4, P: 0.6 });
const RECENCY_WEIGHT = Object.freeze({ 2026: 1.0, 2025: 0.72, 2024: 0.48 });
const TRACKING_K = Object.freeze({
  expectedBattingAverage: 140, barrelPercent: 120, hardHitPercent: 140, maxExitVelocity: 55,
  whiffPercent: 300, chasePercent: 350, sprintSpeed: 10, outsAboveAverage: 180, armStrength: 45,
  hardHitAllowedPercent: 140, barrelAllowedPercent: 120, zonePercent: 350, firstStrikePercent: 160, edgePercent: 350
});
const FASTBALL_FAMILY = new Set(["FF", "SI", "FC", "FA", "FT"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function num(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" && value.trim().endsWith("%")) {
    const n = Number(value.trim().slice(0, -1)); return Number.isFinite(n) ? n / 100 : fallback;
  }
  const n = Number(value); return Number.isFinite(n) ? n : fallback;
}
function rate(value, fallback = null) {
  const n = num(value, fallback); if (n == null) return fallback;
  return Math.abs(n) > 1.5 ? n / 100 : n;
}
function first(values, keys, fallback = null) {
  for (const key of keys) if (values?.[key] != null && values[key] !== "") return values[key];
  return fallback;
}
function safeDiv(a, b, fallback = 0) { return Number(b) > 0 ? Number(a) / Number(b) : fallback; }
function round(value, digits = 4) { const p = 10 ** digits; return Math.round(value * p) / p; }
function innings(value) { return inningsToOuts(value) / 3; }
function sampleWeight(sample, prior) { return clamp(Number(sample || 0) / Math.max(1, Number(sample || 0) + prior), 0, 0.985); }
function z(value, mean, sd, direction = 1) { return direction * ((Number(value) - Number(mean)) / Math.max(1e-9, Number(sd))); }
function baseRating(level) { return LEVEL_BASE_RATING[level] ?? 35; }
function ratingFromZ(zScore, base = 50, weight = 1) {
  const latent = ratingToLatent(base) + clamp(zScore, -2.75, 2.75) * clamp(weight, 0, 1);
  return round(clamp(latentToRating(latent), 20, 99), 2);
}
function ratingFromPercentile(percentile, base = 50, weight = 1) {
  const raw = num(percentile, 50); const p = clamp(raw / (raw > 1 ? 100 : 1), 0.003, 0.997);
  return ratingFromZ(inverseStandardNormalCdf(p), base, weight);
}
function blendRatings(a, b, weightB) {
  const w = clamp(weightB, 0, 1);
  if (a == null) return b; if (b == null) return a;
  return round(clamp(latentToRating(ratingToLatent(a) * (1 - w) + ratingToLatent(b) * w), 20, 99), 2);
}
function combineRatings(parts, priorRating = 50, priorWeight = 0.28) {
  let latentSum = ratingToLatent(priorRating) * priorWeight;
  let weightSum = priorWeight;
  for (const part of parts) {
    if (part?.rating == null || !Number.isFinite(Number(part.rating)) || !(part.weight > 0)) continue;
    latentSum += ratingToLatent(Number(part.rating)) * Number(part.weight);
    weightSum += Number(part.weight);
  }
  return round(clamp(latentToRating(latentSum / Math.max(1e-9, weightSum)), 20, 99), 2);
}
function confidence(sample, advancedCount = 0) {
  const score = sampleWeight(sample, 430) * 0.74 + clamp(advancedCount / 6, 0, 1) * 0.26;
  if (score >= 0.76) return "HIGH";
  if (score >= 0.50) return "GOOD";
  if (score >= 0.26) return "FAIR";
  return "LOW";
}
function recencyWeight(season) { return RECENCY_WEIGHT[Number(season)] ?? (Number(season) > 2026 ? 1 : 0.25); }
function splitType(row) { return String(row?.splitContext?.type ?? "TOTAL").toUpperCase(); }
function isTotalRow(row) { return splitType(row) === "TOTAL"; }
function isHandSplit(row, hand) { return splitType(row) === "OPP_PITCHER_HAND" && String(row?.splitContext?.hand ?? "").toUpperCase() === hand; }

function statRows(data, playerId, group) {
  const key = `${String(playerId)}:${group}`;
  if (data?._statsIndex instanceof Map) return data._statsIndex.get(key) ?? [];
  return (data?.stats ?? []).filter((row) => String(row.playerId) === String(playerId) && row.group === group && row.gameType !== "S");
}
function trackingRows(data, playerId, metricGroup = null) {
  const key = `${String(playerId)}:${metricGroup ?? "*"}`;
  if (data?._trackingIndex instanceof Map) return data._trackingIndex.get(key) ?? [];
  return (data?.tracking ?? []).filter((row) => String(row.playerId) === String(playerId) && (metricGroup == null || row.metricGroup === metricGroup));
}
function arsenalRows(data, playerId) {
  if (data?._arsenalIndex instanceof Map) return data._arsenalIndex.get(String(playerId)) ?? [];
  return (data?.pitchArsenal ?? []).filter((row) => String(row.playerId) === String(playerId));
}

function inferBattingLine(values = {}) {
  const ab = num(first(values, ["atBats", "ab"]), 0) ?? 0;
  const bb = num(first(values, ["baseOnBalls", "walks", "bb"]), 0) ?? 0;
  const hbp = num(first(values, ["hitByPitch", "hbp"]), 0) ?? 0;
  const sf = num(first(values, ["sacFlies", "sf"]), 0) ?? 0;
  const hits = num(first(values, ["hits", "h"]), 0) ?? 0;
  const doubles = num(first(values, ["doubles", "2B"]), 0) ?? 0;
  const triples = num(first(values, ["triples", "3B"]), 0) ?? 0;
  const hr = num(first(values, ["homeRuns", "hr"]), 0) ?? 0;
  const so = num(first(values, ["strikeOuts", "strikeouts", "so"]), 0) ?? 0;
  const pa = num(first(values, ["plateAppearances", "pa"]), ab + bb + hbp + sf) ?? (ab + bb + hbp + sf);
  const tb = num(first(values, ["totalBases", "tb"]), hits + doubles + 2 * triples + 3 * hr) ?? 0;
  return {
    pa, ab, bb, hbp, sf, hits, doubles, triples, hr, so,
    ba: rate(first(values, ["avg", "battingAverage"]), safeDiv(hits, ab, MLB_REFERENCE_ENVIRONMENT_2025.battingAverage)),
    obp: rate(first(values, ["obp", "onBasePercentage"]), safeDiv(hits + bb + hbp, ab + bb + hbp + sf, MLB_REFERENCE_ENVIRONMENT_2025.onBasePercentage)),
    slg: rate(first(values, ["slg", "sluggingPercentage"]), safeDiv(tb, ab, MLB_REFERENCE_ENVIRONMENT_2025.sluggingPercentage)),
    kRate: rate(first(values, ["strikeoutRate", "kPercent", "kPct"]), safeDiv(so, pa, MLB_REFERENCE_ENVIRONMENT_2025.strikeoutsPerPa)),
    bbRate: rate(first(values, ["walkRate", "bbPercent", "bbPct"]), safeDiv(bb, pa, MLB_REFERENCE_ENVIRONMENT_2025.walksPerPa)),
    hrRate: safeDiv(hr, pa, MLB_REFERENCE_ENVIRONMENT_2025.homeRunsPerPa),
    iso: rate(first(values, ["iso", "xiso", "xISO"]), Math.max(0, safeDiv(tb, ab, 0) - safeDiv(hits, ab, 0)))
  };
}
function inferPitchingLine(values = {}) {
  const bf = num(first(values, ["battersFaced", "bf"]), 0) ?? 0;
  const so = num(first(values, ["strikeOuts", "strikeouts", "so"]), 0) ?? 0;
  const bb = num(first(values, ["baseOnBalls", "walks", "bb"]), 0) ?? 0;
  const hr = num(first(values, ["homeRuns", "homeRunsAllowed", "hr"]), 0) ?? 0;
  const ip = innings(first(values, ["inningsPitched", "ip"], 0));
  const games = num(first(values, ["gamesPlayed", "gamesPitched", "games"]), 0) ?? 0;
  const gs = num(first(values, ["gamesStarted", "starts", "gs"]), 0) ?? 0;
  return { bf, so, bb, hr, ip, games, gs,
    kRate: rate(first(values, ["strikeoutRate", "kPercent", "kPct"]), safeDiv(so, bf, MLB_REFERENCE_ENVIRONMENT_2025.strikeoutsPerPa)),
    bbRate: rate(first(values, ["walkRate", "bbPercent", "bbPct"]), safeDiv(bb, bf, MLB_REFERENCE_ENVIRONMENT_2025.walksPerPa)),
    hrRate: safeDiv(hr, bf, MLB_REFERENCE_ENVIRONMENT_2025.homeRunsPerPa), era: num(first(values, ["era"]), null) };
}

function groupPlayerSeasonLevel(rows, predicate = isTotalRow) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.gameType === "S" || !predicate(row)) continue;
    const key = `${Number(row.season)}:${String(row.level)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()].map(([key, parts]) => {
    const [seasonText, level] = key.split(":");
    const agg = aggregateStatRows(parts, { season: Number(seasonText), group: parts[0]?.group });
    return agg ? { season: Number(seasonText), level, values: agg.values, sample: agg.sample, rows: parts } : null;
  }).filter(Boolean).sort((a, b) => b.season - a.season || a.level.localeCompare(b.level));
}

function meanSd(values, { minSd = 0.01, fallbackMean = 0, fallbackSd = 1 } = {}) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 6) return { mean: fallbackMean, sd: fallbackSd, n: nums.length };
  nums.sort((a, b) => a - b);
  const lo = nums[Math.floor(nums.length * 0.03)], hi = nums[Math.min(nums.length - 1, Math.ceil(nums.length * 0.97))];
  const trimmed = nums.filter((v) => v >= lo && v <= hi);
  const mean = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
  const variance = trimmed.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, trimmed.length - 1);
  return { mean, sd: Math.max(minSd, Math.sqrt(variance)), n: nums.length };
}

function inferLeagueEnvironments(data, { reference = MLB_REFERENCE_ENVIRONMENT_2025 } = {}) {
  const levels = ["MLB", "AAA", "AA", "HIGH_A", "A"];
  const result = {};
  for (const level of levels) {
    const finalGames = (data?.schedule ?? []).filter((g) => g.level === level && String(g.status).toLowerCase().includes("final"));
    let runs = 0;
    for (const g of finalGames) runs += (num(g.awayScore, 0) ?? 0) + (num(g.homeScore, 0) ?? 0);
    const totals = (data?.stats ?? []).filter((s) => s.level === level && s.group === "hitting" && isTotalRow(s) && s.gameType !== "S");
    const sums = totals.reduce((acc, row) => {
      const line = inferBattingLine(row.values);
      for (const key of ["pa","ab","bb","hbp","sf","hits","hr","so"]) acc[key] += line[key] ?? 0;
      acc.tb += (line.slg ?? 0) * (line.ab ?? 0); return acc;
    }, {pa:0,ab:0,bb:0,hbp:0,sf:0,hits:0,hr:0,so:0,tb:0});
    const gamesPerTeam = finalGames.length ? finalGames.length * 2 : 0;
    const observed = {
      games: finalGames.length, plateAppearances: sums.pa,
      runsPerTeamGame: gamesPerTeam ? runs / gamesPerTeam : null,
      battingAverage: sums.ab ? sums.hits / sums.ab : null,
      onBasePercentage: (sums.ab+sums.bb+sums.hbp+sums.sf) ? (sums.hits+sums.bb+sums.hbp)/(sums.ab+sums.bb+sums.hbp+sums.sf) : null,
      sluggingPercentage: sums.ab ? sums.tb / sums.ab : null,
      homeRunsPerPa: sums.pa ? sums.hr / sums.pa : null,
      walksPerPa: sums.pa ? sums.bb / sums.pa : null,
      strikeoutsPerPa: sums.pa ? sums.so / sums.pa : null
    };
    result[level] = freeze({ level, referenceSeason: reference.season,
      observed: Object.fromEntries(Object.entries(observed).map(([k,v]) => [k, v == null ? null : round(v, 6)])),
      neutralizers: freeze({
        ba: observed.battingAverage ? round(reference.battingAverage / observed.battingAverage, 5) : 1,
        obp: observed.onBasePercentage ? round(reference.onBasePercentage / observed.onBasePercentage, 5) : 1,
        slg: observed.sluggingPercentage ? round(reference.sluggingPercentage / observed.sluggingPercentage, 5) : 1,
        hr: observed.homeRunsPerPa ? round(reference.homeRunsPerPa / observed.homeRunsPerPa, 5) : 1,
        bb: observed.walksPerPa ? round(reference.walksPerPa / observed.walksPerPa, 5) : 1,
        k: observed.strikeoutsPerPa ? round(reference.strikeoutsPerPa / observed.strikeoutsPerPa, 5) : 1,
        runs: observed.runsPerTeamGame ? round(reference.runsPerTeamGame / observed.runsPerTeamGame, 5) : 1
      }) });
  }
  return freeze(result);
}

function buildStandardPopulation(data) {
  const groups = { hitting: new Map(), pitching: new Map() };
  for (const group of ["hitting", "pitching"]) {
    const byPlayer = new Map();
    for (const row of data.stats ?? []) {
      if (row.group !== group || row.gameType === "S" || !isTotalRow(row) || Number(row.season) < 2024) continue;
      const key = `${row.playerId}:${row.season}:${row.level}`;
      if (!byPlayer.has(key)) byPlayer.set(key, []);
      byPlayer.get(key).push(row);
    }
    const bucket = new Map();
    for (const rows of byPlayer.values()) {
      const agg = aggregateStatRows(rows, { season: rows[0].season, group }); if (!agg) continue;
      const level = rows[0].level, season = Number(rows[0].season), key = `${level}:${season}`;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(group === "hitting" ? inferBattingLine(agg.values) : inferPitchingLine(agg.values));
    }
    for (const [key, lines] of bucket) {
      if (group === "hitting") {
        const eligible = lines.filter((l) => l.pa >= 60);
        groups.hitting.set(key, {
          ba: meanSd(eligible.map((l) => l.ba), { minSd: 0.018, fallbackMean: 0.245, fallbackSd: 0.032 }),
          iso: meanSd(eligible.map((l) => l.iso), { minSd: 0.035, fallbackMean: 0.159, fallbackSd: 0.055 }),
          kRate: meanSd(eligible.map((l) => l.kRate), { minSd: 0.035, fallbackMean: 0.222, fallbackSd: 0.06 }),
          bbRate: meanSd(eligible.map((l) => l.bbRate), { minSd: 0.022, fallbackMean: 0.084, fallbackSd: 0.038 }),
          hrRate: meanSd(eligible.map((l) => l.hrRate), { minSd: 0.007, fallbackMean: 0.031, fallbackSd: 0.014 })
        });
      } else {
        const eligible = lines.filter((l) => l.bf >= 50 || l.ip >= 12);
        groups.pitching.set(key, {
          kRate: meanSd(eligible.map((l) => l.kRate), { minSd: 0.035, fallbackMean: 0.222, fallbackSd: 0.06 }),
          bbRate: meanSd(eligible.map((l) => l.bbRate), { minSd: 0.022, fallbackMean: 0.084, fallbackSd: 0.035 }),
          hrRate: meanSd(eligible.map((l) => l.hrRate), { minSd: 0.007, fallbackMean: 0.031, fallbackSd: 0.014 })
        });
      }
    }
  }
  return groups;
}

const TRACKING_DEFINITION = Object.freeze({
  HITTING_BATTED_BALL: Object.freeze({
    expectedBattingAverage: { denominator: "xbaAtBats", direction: 1, minSd: 0.025 },
    barrelPercent: { denominator: "bbe", direction: 1, minSd: 2.8 },
    hardHitPercent: { denominator: "evBbe", direction: 1, minSd: 5.0 },
    maxExitVelocity: { denominator: "evBbe", direction: 1, minSd: 2.2 }
  }),
  HITTING_SWING: Object.freeze({
    whiffPercent: { denominator: "swings", direction: -1, minSd: 4.0 },
    chasePercent: { denominator: "chaseOpportunities", direction: -1, minSd: 4.0 }
  }),
  RUNNING: Object.freeze({ sprintSpeed: { denominator: "competitiveRuns", direction: 1, minSd: 0.55 } }),
  FIELDING: Object.freeze({
    outsAboveAverage: { denominator: "opportunities", direction: 1, minSd: 2.0 },
    armStrength: { denominator: "qualifyingThrows", direction: 1, minSd: 2.4 }
  }),
  PITCHING_BATTED_BALL: Object.freeze({
    hardHitAllowedPercent: { denominator: "evBbe", direction: -1, minSd: 4.5 },
    barrelAllowedPercent: { denominator: "bbe", direction: -1, minSd: 2.2 }
  }),
  PITCHING_LOCATION: Object.freeze({
    zonePercent: { denominator: "pitches", direction: 1, minSd: 2.5 },
    firstStrikePercent: { denominator: "firstPitches", direction: 1, minSd: 3.5 },
    edgePercent: { denominator: "pitches", direction: 1, minSd: 2.0 }
  }),
  PITCHING_SWING: Object.freeze({
    whiffPercent: { denominator: "swings", direction: 1, minSd: 4.0 },
    chasePercent: { denominator: "chaseOpportunities", direction: 1, minSd: 3.5 }
  })
});

function buildTrackingPopulation(data) {
  const out = new Map();
  for (const [group, metrics] of Object.entries(TRACKING_DEFINITION)) {
    for (const [metric, def] of Object.entries(metrics)) {
      const buckets = new Map();
      for (const row of data.tracking ?? []) {
        if (row.metricGroup !== group || row.values?.[metric] == null) continue;
        const sample = num(row.denominators?.[def.denominator], 0) ?? 0;
        if (sample <= 0) continue;
        const key = `${row.level}:${row.season}:${group}:${metric}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(Number(row.values[metric]));
      }
      for (const [key, values] of buckets) out.set(key, meanSd(values, { minSd: def.minSd, fallbackMean: 0, fallbackSd: def.minSd }));
    }
  }
  return out;
}

function movementEvidenceValue(row, useComparable) {
  if (useComparable) {
    const hx = num(row.movementVsComparable?.horizontal, null), vz = num(row.movementVsComparable?.vertical, null);
    if (hx == null && vz == null) return null;
    return Math.hypot(hx ?? 0, vz ?? 0);
  }
  const hx = num(row.movement?.horizontal, null), vz = num(row.movement?.vertical, null);
  return hx != null && vz != null ? Math.hypot(hx, vz) : null;
}

function buildArsenalPopulation(data) {
  const buckets = new Map();
  for (const row of data.pitchArsenal ?? []) {
    const key = `${row.level}:${row.season}:${row.pitchType}`;
    if (!buckets.has(key)) buckets.set(key, { velo: [], moveRaw: [], moveComparable: [], whiff: [] });
    const b = buckets.get(key);
    const pitches = num(row.samples?.pitches, 0) ?? 0, swings = num(row.samples?.swings, 0) ?? 0;
    const velo = num(row.velocity?.mean, null), whiff = rate(row.whiff?.rate, null);
    const rawMove = movementEvidenceValue(row,false), comparableMove = movementEvidenceValue(row,true);
    if (velo != null && pitches >= 20) b.velo.push(velo);
    if (rawMove != null && pitches >= 20) b.moveRaw.push(rawMove);
    if (comparableMove != null && pitches >= 20) b.moveComparable.push(comparableMove);
    if (whiff != null && swings >= 12) b.whiff.push(whiff);
  }
  const out = new Map();
  for (const [key,b] of buckets) {
    const useComparable = b.moveComparable.length >= 6;
    out.set(key,{
      velo:meanSd(b.velo,{minSd:1.3,fallbackMean:90,fallbackSd:2.2}),
      move:meanSd(useComparable?b.moveComparable:b.moveRaw,{minSd:0.8,fallbackMean:3.5,fallbackSd:2.0}),
      whiff:meanSd(b.whiff,{minSd:0.05,fallbackMean:0.25,fallbackSd:0.09}),
      useComparable
    });
  }
  return out;
}

function trackingMetricEvidence(data, context, playerId, group, metric) {
  const def = TRACKING_DEFINITION[group]?.[metric]; if (!def) return null;
  const currentLevel = data._playerLevelById?.get(String(playerId)) ?? null;
  const parts = [];
  for (const row of trackingRows(data, playerId, group)) {
    // Phase C evidence is level-specific. Historical MLB tracking must not
    // silently leak into a player currently evaluated at AAA/AA/A without an
    // explicit level-translation model.
    if (currentLevel && row.level !== currentLevel) continue;
    if (row.values?.[metric] == null) continue;
    const sample = num(row.denominators?.[def.denominator], 0) ?? 0; if (!(sample > 0)) continue;
    const pop = context.tracking.get(`${row.level}:${row.season}:${group}:${metric}`); if (!pop) continue;
    const rel = sampleWeight(sample, TRACKING_K[metric] ?? 180);
    const metricZ = z(Number(row.values[metric]), pop.mean, pop.sd, def.direction);
    const rating = ratingFromZ(metricZ, baseRating(row.level), rel);
    parts.push({ rating, weight: recencyWeight(row.season) * (0.28 + 0.72 * rel), season: row.season, level: row.level, sample, value: Number(row.values[metric]), z: metricZ });
  }
  if (!parts.length) return null;
  return { rating: combineRatings(parts, baseRating(data._playerLevelById?.get(String(playerId)) ?? "MLB"), 0.12), parts };
}

function legacyPercentileEvidence(values, keys, level, weight = 0.75) {
  const raw = first(values, keys, null); if (raw == null) return null;
  const p = num(raw, null); if (p == null) return null;
  return ratingFromPercentile(p, baseRating(level), weight);
}

function standardHitterEvidence(player, data, context) {
  const rows = statRows(data, player.id, "hitting");
  const groups = groupPlayerSeasonLevel(rows, isTotalRow);
  const metricParts = { contact: [], power: [], vision: [], discipline: [], speed: [], stealing: [], baserunning: [] };
  let totalPa = 0, sb = 0, cs = 0;
  for (const g of groups) {
    const line = inferBattingLine(g.values); totalPa += line.pa * recencyWeight(g.season);
    const pop = context.standard.hitting.get(`${g.level}:${g.season}`) ?? context.standard.hitting.get(`${g.level}:2026`);
    if (!pop) continue;
    const rel = sampleWeight(line.pa, 300); const w = recencyWeight(g.season) * (0.25 + 0.75 * rel);
    const env = context.environments?.[g.level]?.neutralizers ?? {ba:1,slg:1,k:1,bb:1};
    const populationContactZ = z(line.ba, pop.ba.mean, pop.ba.sd) * 0.74 + z(line.kRate, pop.kRate.mean, pop.kRate.sd, -1) * 0.26;
    const environmentContactZ = z(clamp(line.ba * env.ba,0.12,0.42), MLB_REFERENCE_ENVIRONMENT_2025.battingAverage, 0.032) * 0.74 + z(clamp(line.kRate * env.k,0.03,0.45), MLB_REFERENCE_ENVIRONMENT_2025.strikeoutsPerPa, 0.06, -1) * 0.26;
    const contactZ = populationContactZ * 0.78 + environmentContactZ * 0.22;
    const populationPowerZ = z(line.iso, pop.iso.mean, pop.iso.sd) * 0.78 + z(line.hrRate, pop.hrRate.mean, pop.hrRate.sd) * 0.22;
    const environmentPowerZ = z(clamp(line.iso * env.slg,0,0.42), MLB_REFERENCE_ENVIRONMENT_2025.sluggingPercentage - MLB_REFERENCE_ENVIRONMENT_2025.battingAverage, 0.055);
    const powerZ = populationPowerZ * 0.84 + environmentPowerZ * 0.16;
    const visionZ = z(line.kRate, pop.kRate.mean, pop.kRate.sd, -1) * 0.82 + z(clamp(line.kRate * env.k,0.03,0.45), MLB_REFERENCE_ENVIRONMENT_2025.strikeoutsPerPa,0.06,-1) * 0.18;
    const discZ = z(line.bbRate, pop.bbRate.mean, pop.bbRate.sd) * 0.82 + z(clamp(line.bbRate * env.bb,0.01,0.25), MLB_REFERENCE_ENVIRONMENT_2025.walksPerPa,0.038) * 0.18;
    metricParts.contact.push({ rating: ratingFromZ(contactZ, baseRating(g.level), rel), weight: w, season: g.season, level: g.level, sample: line.pa });
    metricParts.power.push({ rating: ratingFromZ(powerZ, baseRating(g.level), rel), weight: w, season: g.season, level: g.level, sample: line.pa });
    metricParts.vision.push({ rating: ratingFromZ(visionZ, baseRating(g.level), rel), weight: w, season: g.season, level: g.level, sample: line.pa });
    metricParts.discipline.push({ rating: ratingFromZ(discZ, baseRating(g.level), rel), weight: w, season: g.season, level: g.level, sample: line.pa });
    const attempts = (num(g.values.stolenBases, 0) ?? 0) + (num(g.values.caughtStealing, 0) ?? 0);
    const attemptRate = safeDiv(attempts, Math.max(1, line.pa));
    const speedZ = z(attemptRate, g.level === "MLB" ? 0.025 : 0.035, 0.03) * 0.35;
    metricParts.speed.push({ rating: ratingFromZ(speedZ, baseRating(g.level), Math.max(0.25, rel * 0.45)), weight: w * 0.35 });
    sb += (num(g.values.stolenBases, 0) ?? 0) * recencyWeight(g.season); cs += (num(g.values.caughtStealing, 0) ?? 0) * recencyWeight(g.season);
  }
  const levelPrior = baseRating(player.level);
  const contact = combineRatings(metricParts.contact, levelPrior, 0.34);
  const power = combineRatings(metricParts.power, levelPrior, 0.34);
  const vision = combineRatings(metricParts.vision, levelPrior, 0.34);
  const discipline = combineRatings(metricParts.discipline, levelPrior, 0.34);
  const speed = combineRatings(metricParts.speed, levelPrior, 0.65);
  const attempts = sb + cs;
  const stealing = attempts >= 1 ? blendRatings(speed, ratingFromZ(z(safeDiv(sb, attempts), 0.73, 0.13), levelPrior, sampleWeight(attempts, 22)), sampleWeight(attempts, 18) * 0.72) : speed;
  const baserunning = blendRatings(levelPrior, speed, 0.62);
  return { contact, power, vision, discipline, speed, stealing, baserunning, totalPa, rows: groups };
}

function splitHitterRating(player, data, context, hand, overallContact, overallPower) {
  const rows = statRows(data, player.id, "hitting");
  const groups = groupPlayerSeasonLevel(rows, (row) => isHandSplit(row, hand));
  const contactParts = [], powerParts = []; let sample = 0;
  for (const g of groups) {
    const line = inferBattingLine(g.values); sample += line.pa * recencyWeight(g.season);
    const pop = context.standard.hitting.get(`${g.level}:${g.season}`); if (!pop) continue;
    const rel = sampleWeight(line.pa, 160); const w = recencyWeight(g.season) * (0.20 + 0.80 * rel);
    const contactZ = z(line.ba, pop.ba.mean, pop.ba.sd) * 0.78 + z(line.kRate, pop.kRate.mean, pop.kRate.sd, -1) * 0.22;
    const powerZ = z(line.iso, pop.iso.mean, pop.iso.sd);
    contactParts.push({ rating: ratingFromZ(contactZ, baseRating(g.level), rel), weight: w });
    powerParts.push({ rating: ratingFromZ(powerZ, baseRating(g.level), rel), weight: w });
  }
  const splitContact = contactParts.length ? combineRatings(contactParts, overallContact, 0.85) : overallContact;
  const splitPower = powerParts.length ? combineRatings(powerParts, overallPower, 0.85) : overallPower;
  const trust = sampleWeight(sample, 220) * 0.72;
  const bats = String(player.bats ?? "R").toUpperCase();
  const platoon = hand === "L" ? (bats === "L" ? -1.8 : bats === "R" ? 1.0 : 0) : (bats === "R" ? -0.7 : bats === "L" ? 0.8 : 0);
  return {
    contact: clamp(blendRatings(overallContact, splitContact, trust) + platoon * (1 - trust) * 0.35, 20, 99),
    power: clamp(blendRatings(overallPower, splitPower, trust) + platoon * (1 - trust) * 0.25, 20, 99), sample: round(sample, 1)
  };
}

function fieldingEvidence(player, data, context) {
  const rows = statRows(data, player.id, "fielding");
  const groups = groupPlayerSeasonLevel(rows, isTotalRow);
  const parts = [], armAccParts = []; let chances = 0;
  for (const g of groups) {
    const c = num(g.values.chances, 0) ?? 0, e = num(g.values.errors, 0) ?? 0; chances += c * recencyWeight(g.season);
    const rel = sampleWeight(c, 180); const errRate = safeDiv(e, Math.max(1, c));
    const defZ = z(errRate, 0.018, 0.012, -1);
    parts.push({ rating: ratingFromZ(defZ, baseRating(g.level), rel * 0.50), weight: recencyWeight(g.season) * (0.25 + 0.75 * rel) });
    armAccParts.push({ rating: ratingFromZ(defZ, baseRating(g.level), rel * 0.58), weight: recencyWeight(g.season) * (0.25 + 0.75 * rel) });
  }
  let fielding = combineRatings(parts, baseRating(player.level), 0.65);
  let reaction = fielding;
  let armStrength = baseRating(player.level);
  let armAccuracy = combineRatings(armAccParts, baseRating(player.level), 0.75);
  const oaa = trackingMetricEvidence(data, context, player.id, "FIELDING", "outsAboveAverage");
  const arm = trackingMetricEvidence(data, context, player.id, "FIELDING", "armStrength");
  if (oaa) { fielding = blendRatings(fielding, oaa.rating, 0.48); reaction = blendRatings(reaction, oaa.rating, 0.68); }
  if (arm) armStrength = blendRatings(armStrength, arm.rating, 0.82);
  return { fielding, reaction, armStrength, armAccuracy, chances, oaa, arm };
}

function roleHistory(player, data) {
  const groups = groupPlayerSeasonLevel(statRows(data, player.id, "pitching"), isTotalRow);
  let starts = 0, games = 0, starterIp = 0, inningsTotal = 0, evidence = 0;
  for (const g of groups) {
    const line = inferPitchingLine(g.values); const w = recencyWeight(g.season);
    starts += line.gs * w; games += line.games * w; inningsTotal += line.ip * w; evidence += (line.bf || line.ip * 4.25) * w;
    starterIp += line.gs > 0 ? (line.ip / Math.max(1, line.games)) * line.gs * w : 0;
  }
  const share = safeDiv(starts, games, 0), ipPerGame = safeDiv(inningsTotal, games, 0);
  let role = share >= 0.46 || ipPerGame >= 3.2 ? "SP" : share <= 0.13 && ipPerGame <= 1.8 ? "RP" : "SWING";
  const designated = String(player.position ?? "").toUpperCase();
  if (evidence < 120 && designated === "SP") role = "SP";
  if (evidence < 120 && designated === "RP") role = "RP";
  return { role, startShare: share, ipPerGame, inningsTotal, evidence };
}

function standardPitcherEvidence(player, data, context) {
  const groups = groupPlayerSeasonLevel(statRows(data, player.id, "pitching"), isTotalRow);
  const parts = { stuff: [], control: [], command: [], movement: [], pitchability: [] };
  let totalBf = 0, totalIp = 0;
  for (const g of groups) {
    const line = inferPitchingLine(g.values); const sample = line.bf || line.ip * 4.25; totalBf += sample * recencyWeight(g.season); totalIp += line.ip * recencyWeight(g.season);
    const pop = context.standard.pitching.get(`${g.level}:${g.season}`); if (!pop) continue;
    const rel = sampleWeight(sample, 300), w = recencyWeight(g.season) * (0.25 + 0.75 * rel);
    const kZ = z(line.kRate, pop.kRate.mean, pop.kRate.sd), bbZ = z(line.bbRate, pop.bbRate.mean, pop.bbRate.sd, -1), hrZ = z(line.hrRate, pop.hrRate.mean, pop.hrRate.sd, -1);
    parts.stuff.push({ rating: ratingFromZ(kZ * 0.72 + hrZ * 0.28, baseRating(g.level), rel), weight: w });
    parts.control.push({ rating: ratingFromZ(bbZ, baseRating(g.level), rel), weight: w });
    parts.command.push({ rating: ratingFromZ(bbZ * 0.78 + hrZ * 0.22, baseRating(g.level), rel * 0.75), weight: w });
    parts.movement.push({ rating: ratingFromZ(hrZ * 0.68 + kZ * 0.32, baseRating(g.level), rel * 0.72), weight: w });
    parts.pitchability.push({ rating: ratingFromZ(bbZ * 0.48 + kZ * 0.32 + hrZ * 0.20, baseRating(g.level), rel * 0.70), weight: w });
  }
  const prior = baseRating(player.level);
  return {
    stuff: combineRatings(parts.stuff, prior, 0.36), control: combineRatings(parts.control, prior, 0.34),
    command: combineRatings(parts.command, prior, 0.55), movement: combineRatings(parts.movement, prior, 0.50),
    pitchability: combineRatings(parts.pitchability, prior, 0.62), totalBf, totalIp, rows: groups
  };
}

function derivePitchArsenal(player, data, context, role) {
  // Keep pitch-shape evidence isolated to the player's current competition
  // level. Cross-level pitch translation is intentionally not implicit.
  const rows = arsenalRows(data, player.id).filter((r) => Number(r.season) >= 2024 && r.level === player.level);
  if (!rows.length) return null;
  const bySeasonLevel = new Map();
  for (const row of rows) {
    const key = `${row.season}:${row.level}`;
    if (!bySeasonLevel.has(key)) bySeasonLevel.set(key, []);
    bySeasonLevel.get(key).push(row);
  }
  const groupEvidence = [];
  const objectAccumulator = new Map();
  let representativeVelocity = null, representativeVelocityWeight = 0;
  for (const [key, seasonRows] of bySeasonLevel) {
    const [seasonText, level] = key.split(":"); const season = Number(seasonText);
    const totalPitches = seasonRows.reduce((s, r) => s + Math.max(0, num(r.samples?.pitches, 0) ?? 0), 0);
    if (!totalPitches) continue;
    const pitchQualities = [];
    for (const row of seasonRows) {
      const pitches = Math.max(0, num(row.samples?.pitches, 0) ?? 0), swings = Math.max(0, num(row.samples?.swings, 0) ?? 0);
      if (!pitches) continue;
      const usage = pitches / totalPitches; // samples are authoritative; avoids percent/fraction bugs.
      const pop = context.arsenal.get(`${level}:${season}:${row.pitchType}`);
      const velo = num(row.velocity?.mean, null), hx = num(row.movement?.horizontal, null), vz = num(row.movement?.vertical, null), whiff = rate(row.whiff?.rate, null);
      const veloZ = velo != null && pop ? z(velo, pop.velo.mean, pop.velo.sd) : 0;
      const movementValue = pop ? movementEvidenceValue(row,pop.useComparable) : null;
      const moveZ = movementValue != null && pop ? z(movementValue,pop.move.mean,pop.move.sd) : 0;
      const whiffZ = whiff != null && pop ? z(whiff, pop.whiff.mean, pop.whiff.sd) : 0;
      const available = Number(velo != null) + Number(movementValue != null) + Number(whiff != null);
      const qualityZ = available ? (veloZ * 0.34 + moveZ * 0.24 + whiffZ * 0.42) / (0.34 * Number(velo != null) + 0.24 * Number(movementValue != null) + 0.42 * Number(whiff != null)) : 0;
      const rel = sampleWeight(pitches, 180) * (0.55 + 0.45 * sampleWeight(swings, 70));
      pitchQualities.push({ row, usage, qualityZ, moveZ, rel, pitches, swings, velo, hx, vz, whiff });
      const acc = objectAccumulator.get(row.pitchType) ?? { pitchType: row.pitchType, weight: 0, usage: 0, velocity: 0, horizontalMovement: 0, verticalMovement: 0, whiffQuality: 0, qualityZ: 0, samples: 0, seasons: new Set(), levels: new Set() };
      const ew = recencyWeight(season) * pitches;
      acc.weight += ew; acc.usage += usage * recencyWeight(season); acc.samples += pitches; acc.seasons.add(season); acc.levels.add(level);
      if (velo != null) acc.velocity += velo * ew;
      if (hx != null) acc.horizontalMovement += hx * ew;
      if (vz != null) acc.verticalMovement += vz * ew;
      if (whiff != null) acc.whiffQuality += whiff * recencyWeight(season) * Math.max(1, swings);
      acc.qualityZ += qualityZ * ew;
      acc.whiffWeight = (acc.whiffWeight ?? 0) + recencyWeight(season) * Math.max(1, swings);
      objectAccumulator.set(row.pitchType, acc);
      if (FASTBALL_FAMILY.has(row.pitchType) && velo != null) { representativeVelocity = (representativeVelocity ?? 0) + velo * ew; representativeVelocityWeight += ew; }
    }
    if (!pitchQualities.length) continue;
    const usable = pitchQualities.filter((p) => p.usage >= 0.05).sort((a, b) => b.qualityZ - a.qualityZ);
    let stuffZ = 0;
    if (role === "RP") {
      const top = usable.slice(0, 2);
      if (top.length === 1) stuffZ = top[0].qualityZ;
      else if (top.length >= 2) stuffZ = top[0].qualityZ * 0.62 + top[1].qualityZ * 0.38;
      else stuffZ = pitchQualities.reduce((s, p) => s + p.qualityZ * p.usage, 0);
    } else {
      stuffZ = pitchQualities.reduce((s, p) => s + p.qualityZ * p.usage, 0);
      const depth = pitchQualities.filter((p) => p.usage >= 0.08 && p.qualityZ > -0.65).length;
      stuffZ += clamp((depth - 2) * 0.10, -0.12, 0.30);
    }
    const movementZ = pitchQualities.reduce((s, p) => s + p.moveZ * p.usage, 0);
    const reliability = sampleWeight(totalPitches, role === "SP" ? 500 : 300);
    groupEvidence.push({ season, level, stuffRating: ratingFromZ(stuffZ, baseRating(level), reliability), movementRating: ratingFromZ(movementZ, baseRating(level), reliability), weight: recencyWeight(season) * (0.30 + 0.70 * reliability), pitches: totalPitches, stuffZ, movementZ });
  }
  if (!groupEvidence.length) return null;
  const currentLevel = player.level;
  const stuff = combineRatings(groupEvidence.map((g) => ({ rating: g.stuffRating, weight: g.weight })), baseRating(currentLevel), 0.20);
  const movement = combineRatings(groupEvidence.map((g) => ({ rating: g.movementRating, weight: g.weight })), baseRating(currentLevel), 0.24);
  const objects = [...objectAccumulator.values()].map((a) => ({
    type: a.pitchType,
    usage: round(a.usage / Math.max(1e-9, [...a.seasons].reduce((s, season) => s + recencyWeight(season), 0)), 4),
    velocity: a.weight ? round(a.velocity / a.weight, 2) : null,
    horizontalMovement: a.weight ? round(a.horizontalMovement / a.weight, 2) : null,
    verticalMovement: a.weight ? round(a.verticalMovement / a.weight, 2) : null,
    whiffQuality: a.whiffWeight ? round(a.whiffQuality / a.whiffWeight, 4) : null,
    qualityZ: a.weight ? round(a.qualityZ / a.weight, 4) : 0,
    samples: a.samples,
    seasonsUsed: [...a.seasons].sort((a, b) => b - a), levelsUsed: [...a.levels]
  })).sort((a, b) => b.usage - a.usage);
  const usageSum = objects.reduce((s, p) => s + p.usage, 0);
  if (usageSum > 0) for (const p of objects) p.usage = round(p.usage / usageSum, 4);
  return { stuff, movement, pitches: objects, groups: groupEvidence, pitchVelocityMph: representativeVelocityWeight ? round(representativeVelocity / representativeVelocityWeight, 1) : null };
}

function pitcherTrackingAdjustments(player, data, context, standard, role, arsenal) {
  const whiff = trackingMetricEvidence(data, context, player.id, "PITCHING_SWING", "whiffPercent");
  const chase = trackingMetricEvidence(data, context, player.id, "PITCHING_SWING", "chasePercent");
  const hard = trackingMetricEvidence(data, context, player.id, "PITCHING_BATTED_BALL", "hardHitAllowedPercent");
  const barrel = trackingMetricEvidence(data, context, player.id, "PITCHING_BATTED_BALL", "barrelAllowedPercent");
  const zone = trackingMetricEvidence(data, context, player.id, "PITCHING_LOCATION", "zonePercent");
  const firstStrike = trackingMetricEvidence(data, context, player.id, "PITCHING_LOCATION", "firstStrikePercent");
  const edge = trackingMetricEvidence(data, context, player.id, "PITCHING_LOCATION", "edgePercent");
  let stuff = standard.stuff, movement = standard.movement, control = standard.control, command = standard.command, pitchability = standard.pitchability;
  if (arsenal) { stuff = blendRatings(stuff, arsenal.stuff, 0.72); movement = blendRatings(movement, arsenal.movement, 0.68); }
  else if (whiff) stuff = blendRatings(stuff, whiff.rating, 0.48);
  if (hard || barrel) {
    const suppress = combineRatings([hard && { rating: hard.rating, weight: 0.50 }, barrel && { rating: barrel.rating, weight: 0.50 }].filter(Boolean), standard.movement, 0.20);
    movement = blendRatings(movement, suppress, arsenal ? 0.16 : 0.38);
  }
  const controlTracking = combineRatings([zone && { rating: zone.rating, weight: 0.52 }, firstStrike && { rating: firstStrike.rating, weight: 0.48 }].filter(Boolean), standard.control, 0.35);
  if (zone || firstStrike) control = blendRatings(control, controlTracking, 0.38);
  const commandParts = [edge && { rating: edge.rating, weight: 0.56 }, zone && { rating: zone.rating, weight: 0.18 }, firstStrike && { rating: firstStrike.rating, weight: 0.12 }, chase && { rating: chase.rating, weight: 0.14 }].filter(Boolean);
  if (commandParts.length) command = blendRatings(command, combineRatings(commandParts, standard.command, 0.65), edge ? 0.44 : 0.24);
  const pitchParts = [{ rating: command, weight: 0.42 }, { rating: control, weight: 0.32 }, chase && { rating: chase.rating, weight: 0.14 }, { rating: role === "SP" ? Math.max(45, stuff - 4) : 50, weight: 0.12 }].filter(Boolean);
  pitchability = blendRatings(pitchability, combineRatings(pitchParts, 50, 0.55), 0.42);
  return { stuff, movement, control, command, pitchability, evidence: { whiff, chase, hard, barrel, zone, firstStrike, edge } };
}

function staminaRating(player, data, role) {
  const groups = groupPlayerSeasonLevel(statRows(data, player.id, "pitching"), isTotalRow); const parts = [];
  for (const g of groups) {
    const line = inferPitchingLine(g.values); const rel = sampleWeight(line.ip, 70), w = recencyWeight(g.season) * (0.3 + 0.7 * rel);
    let valueZ;
    if (role === "SP") valueZ = z(line.ip / Math.max(1, line.gs || line.games), 5.1, 1.2);
    else if (role === "SWING") valueZ = z(line.ip / Math.max(1, line.games), 2.2, 1.0);
    else valueZ = z(line.ip / Math.max(1, line.games), 1.0, 0.45);
    parts.push({ rating: ratingFromZ(valueZ, baseRating(g.level), rel), weight: w });
  }
  return combineRatings(parts, baseRating(player.level), 0.45);
}

function inferHitter(player, data, context) {
  const std = standardHitterEvidence(player, data, context);
  const totalValues = groupPlayerSeasonLevel(statRows(data, player.id, "hitting"), isTotalRow)[0]?.values ?? {};
  let contact = std.contact, rawPower = std.power, powerUtil = std.power, vision = std.vision, discipline = std.discipline, speed = std.speed;
  const xba = trackingMetricEvidence(data, context, player.id, "HITTING_BATTED_BALL", "expectedBattingAverage");
  const barrel = trackingMetricEvidence(data, context, player.id, "HITTING_BATTED_BALL", "barrelPercent");
  const hard = trackingMetricEvidence(data, context, player.id, "HITTING_BATTED_BALL", "hardHitPercent");
  const maxEv = trackingMetricEvidence(data, context, player.id, "HITTING_BATTED_BALL", "maxExitVelocity");
  const whiff = trackingMetricEvidence(data, context, player.id, "HITTING_SWING", "whiffPercent");
  const chase = trackingMetricEvidence(data, context, player.id, "HITTING_SWING", "chasePercent");
  const sprint = trackingMetricEvidence(data, context, player.id, "RUNNING", "sprintSpeed");
  if (xba) contact = blendRatings(contact, xba.rating, 0.52);
  if (maxEv || hard) rawPower = blendRatings(rawPower, combineRatings([maxEv && { rating: maxEv.rating, weight: 0.74 }, hard && { rating: hard.rating, weight: 0.26 }].filter(Boolean), rawPower, 0.18), maxEv ? 0.66 : 0.32);
  if (barrel || hard) powerUtil = blendRatings(powerUtil, combineRatings([barrel && { rating: barrel.rating, weight: 0.72 }, hard && { rating: hard.rating, weight: 0.28 }].filter(Boolean), powerUtil, 0.20), barrel ? 0.58 : 0.28);
  if (whiff) vision = blendRatings(vision, whiff.rating, 0.56);
  if (chase) discipline = blendRatings(discipline, chase.rating, 0.54);
  if (sprint) speed = blendRatings(speed, sprint.rating, 0.82);

  // Legacy v46 fixtures can still carry public percentile evidence inside stat values.
  const legacyPower = legacyPercentileEvidence(totalValues, ["maxEVPercentile","maxEvPercentile","xISOPercentile","xisoPercentile"], player.level);
  const legacyBarrel = legacyPercentileEvidence(totalValues, ["barrelPercentile","barrelPctPercentile"], player.level);
  const legacyWhiff = legacyPercentileEvidence(totalValues, ["whiffPercentile","kPercentile"], player.level);
  const legacyChase = legacyPercentileEvidence(totalValues, ["chasePercentile","bbPercentile"], player.level);
  const legacySprint = legacyPercentileEvidence(totalValues, ["sprintSpeedPercentile"], player.level);
  if (!maxEv && legacyPower != null) rawPower = blendRatings(rawPower, legacyPower, 0.90);
  if (!barrel && legacyBarrel != null) powerUtil = blendRatings(powerUtil, legacyBarrel, 0.84);
  if (!whiff && legacyWhiff != null) vision = blendRatings(vision, legacyWhiff, 0.86);
  if (!chase && legacyChase != null) discipline = blendRatings(discipline, legacyChase, 0.82);
  if (!sprint && legacySprint != null) speed = blendRatings(speed, legacySprint, 0.82);

  const vsR = splitHitterRating(player, data, context, "R", contact, powerUtil);
  const vsL = splitHitterRating(player, data, context, "L", contact, powerUtil);
  const field = fieldingEvidence(player, data, context);
  const ratings = {
    contactR: round(vsR.contact,2), contactL: round(vsL.contact,2), rawPower,
    powerUtilizationR: round(vsR.power,2), powerUtilizationL: round(vsL.power,2), vision, discipline, clutch: 50,
    speed, stealing: blendRatings(std.stealing, speed, sprint ? 0.28 : 0.10), baserunning: blendRatings(std.baserunning, speed, sprint ? 0.34 : 0.16),
    fielding: field.fielding, reaction: field.reaction, armStrength: field.armStrength, armAccuracy: field.armAccuracy
  };
  const offense = ((ratings.contactR + ratings.contactL) / 2) * 0.24 + ratings.rawPower * 0.14 + ((ratings.powerUtilizationR + ratings.powerUtilizationL) / 2) * 0.10 + ratings.vision * 0.11 + ratings.discipline * 0.11;
  const defense = ratings.fielding * 0.08 + ratings.reaction * 0.07 + ratings.armStrength * 0.04 + ratings.armAccuracy * 0.03;
  const running = ratings.speed * 0.05 + ratings.baserunning * 0.03;
  const positionAdj = POSITION_VALUE[player.position] ?? 0;
  const ovr = round(clamp(offense + defense + running + positionAdj, 20, 99), 2);
  const age = num(player.age, LEVEL_AGE_REFERENCE[player.level] ?? 24) ?? 24;
  const futureInternal = clamp(ovr + Math.max(0,(LEVEL_AGE_REFERENCE[player.level] ?? age)-age) * 1.25 + (player.level === "MLB" ? 0 : 3.5),20,99);
  const publicFV = publicScoutingGrade(player.publicScouting?.futureValue);
  const adv = [xba,barrel,hard,maxEv,whiff,chase,sprint,field.oaa,field.arm].filter(Boolean).length;
  const seasonsUsed = [...new Set(std.rows.map((r) => r.season))].sort((a,b)=>b-a);
  return freeze({
    playerId:String(player.id),type:"HITTER",level:player.level,position:player.position,
    sample:{plateAppearances:round(std.totalPa,1),fieldingChances:round(field.chances,1),splitPaVsR:vsR.sample,splitPaVsL:vsL.sample},
    confidence:confidence(std.totalPa,adv),ratings,overall:ovr,
    futureValue:publicFV == null ? internalRatingTo2080(futureInternal) : clamp(Math.round(publicFV/5)*5,20,80),
    evidence:freeze({model:"CURRENT_ABILITY_V2",advancedMetricsUsed:adv,multiYear:true,seasonsUsed,levelTranslated:true,trackingApplied:adv>0,smallSampleShrunk:std.totalPa<450,
      trackingSources:[xba,barrel,hard,maxEv,whiff,chase,sprint].filter(Boolean).flatMap((e)=>e.parts.map((p)=>({season:p.season,level:p.level,sample:p.sample}))) }),
    positionFamiliarity: freeze((player.positions ?? []).map((p)=>({position:p.position,games:p.games??0,innings:p.innings??0,seasons:p.seasons??[]})))
  });
}

function inferPitcher(player, data, context) {
  const std = standardPitcherEvidence(player, data, context);
  const history = roleHistory(player, data); const role = history.role;
  const arsenal = derivePitchArsenal(player, data, context, role);
  const tracked = pitcherTrackingAdjustments(player, data, context, std, role, arsenal);
  const stamina = staminaRating(player, data, role);
  const totalValues = groupPlayerSeasonLevel(statRows(data, player.id, "pitching"), isTotalRow)[0]?.values ?? {};

  // Legacy public percentile fallback when staged tracking is absent.
  if (!trackingRows(data, player.id).length && !arsenalRows(data, player.id).length) {
    const whiff = legacyPercentileEvidence(totalValues,["whiffPercentile"],player.level);
    const chase = legacyPercentileEvidence(totalValues,["chasePercentile"],player.level);
    const hard = legacyPercentileEvidence(totalValues,["hardHitAllowedPercentile","hardHitPercentile"],player.level);
    const barrel = legacyPercentileEvidence(totalValues,["barrelAllowedPercentile","barrelPercentile"],player.level);
    if (whiff != null || chase != null || barrel != null) {
      const advStuff = combineRatings([whiff!=null&&{rating:whiff,weight:0.45},chase!=null&&{rating:chase,weight:0.25},barrel!=null&&{rating:barrel,weight:0.30}].filter(Boolean),tracked.stuff,0.2);
      tracked.stuff = blendRatings(tracked.stuff,advStuff,0.72);
    }
    if (hard != null || barrel != null) tracked.movement = blendRatings(tracked.movement,combineRatings([hard!=null&&{rating:hard,weight:0.55},barrel!=null&&{rating:barrel,weight:0.45}].filter(Boolean),tracked.movement,0.2),0.50);
    const zone = rate(first(totalValues,["zonePercent","zonePct"]),null), fs = rate(first(totalValues,["firstPitchStrikePercent","firstPitchStrikePct"]),null);
    if (zone != null || fs != null) {
      const location = ratingFromZ(((zone==null?0:z(zone,0.49,0.055))+(fs==null?0:z(fs,0.61,0.06)))/Math.max(1,Number(zone!=null)+Number(fs!=null)),baseRating(player.level),0.75);
      tracked.control=blendRatings(tracked.control,location,0.34); tracked.command=blendRatings(tracked.command,location,0.34);
    }
  }
  const legacyVelo = num(first(totalValues,["avgFastballVelocity","fastballVelocity","fbVelocity"]),null);
  const velo = arsenal?.pitchVelocityMph ?? legacyVelo;
  const ratings = { control:tracked.control, command:tracked.command, movement:tracked.movement, pitchability:tracked.pitchability, stamina, stuff:tracked.stuff, pitchVelocityMph:velo==null?null:round(velo,1) };
  const staminaWeight = role === "SP" ? 0.06 : role === "SWING" ? 0.04 : 0.02;
  const ovr = round(clamp(ratings.stuff*0.28+ratings.command*0.22+ratings.movement*0.18+ratings.control*0.14+ratings.pitchability*0.12+ratings.stamina*staminaWeight+(POSITION_VALUE[role]??0),20,99),2);
  const age = num(player.age, LEVEL_AGE_REFERENCE[player.level] ?? 24) ?? 24;
  const futureInternal = clamp(ovr + Math.max(0,(LEVEL_AGE_REFERENCE[player.level] ?? age)-age)*1.15 + (player.level === "MLB" ? 0 : 3),20,99);
  const advanced = Object.values(tracked.evidence).filter(Boolean).length + (arsenal ? 1 : 0);
  const publicFV = publicScoutingGrade(player.publicScouting?.futureValue);
  return freeze({
    playerId:String(player.id),type:"PITCHER",level:player.level,position:player.position,
    sample:{battersFaced:round(std.totalBf,1),inningsPitched:round(std.totalIp,1),arsenalPitches:arsenal?.pitches?.reduce((s,p)=>s+(p.samples??0),0)??0},
    confidence:confidence(std.totalBf,advanced),role,ratings,overall:ovr,
    futureValue:publicFV == null ? internalRatingTo2080(futureInternal) : clamp(Math.round(publicFV/5)*5,20,80),
    pitchArsenal:freeze(arsenal?.pitches ?? []),
    roleEvidence:freeze({startShare:round(history.startShare,4),ipPerGame:round(history.ipPerGame,3),weightedInnings:round(history.inningsTotal,1)}),
    evidence:freeze({model:"CURRENT_ABILITY_V2",advancedMetricsUsed:advanced,multiYear:true,seasonsUsed:[...new Set(std.rows.map((r)=>r.season))].sort((a,b)=>b-a),levelTranslated:true,trackingApplied:advanced>0,arsenalDerivedStuff:Boolean(arsenal),smallSampleShrunk:std.totalBf<450})
  });
}

function wallPoint(angleDegrees,distanceFt,heightFt){ return {angleDegrees,distanceFt:clamp(num(distanceFt,330)??330,250,500),heightFt:clamp(num(heightFt,8)??8,0,60)}; }
function buildEngineParkProfiles(parks = []) {
  const out = {};
  for (const park of parks ?? []) {
    const g = park.geometry ?? {}; const h = park.wallHeights ?? {}; const extra = num(park.carryDistanceFeet,0) ?? 0;
    out[String(park.venueId)] = freeze({id:`venue_${park.venueId}`,name:park.name ?? `Venue ${park.venueId}`,venueId:String(park.venueId),teamId:park.teamId==null?null:String(park.teamId),carryFactor:round(clamp(1+extra/400,0.85,1.15),5),wallProfile:[wallPoint(-45,g.lfLine,h.lfLine),wallPoint(-22.5,g.lfGap,h.lfGap),wallPoint(0,g.cf,h.cf),wallPoint(22.5,g.rfGap,h.rfGap),wallPoint(45,g.rfLine,h.rfLine)],empiricalFactors:park.empiricalFactors ?? null,calibrationOnly:true});
  }
  return freeze(out);
}

function buildIndexes(data) {
  const statsIndex = new Map(), trackingIndex = new Map(), arsenalIndex = new Map(), playerLevelById = new Map();
  for (const p of data.players ?? []) playerLevelById.set(String(p.id), p.assignedLevel ?? p.level);
  for (const row of data.stats ?? []) {
    if (row.gameType === "S") continue; const key = `${String(row.playerId)}:${row.group}`;
    if (!statsIndex.has(key)) statsIndex.set(key, []); statsIndex.get(key).push(row);
  }
  for (const row of data.tracking ?? []) {
    for (const key of [`${String(row.playerId)}:*`,`${String(row.playerId)}:${row.metricGroup}`]) { if (!trackingIndex.has(key)) trackingIndex.set(key, []); trackingIndex.get(key).push(row); }
  }
  for (const row of data.pitchArsenal ?? []) { const key=String(row.playerId); if(!arsenalIndex.has(key)) arsenalIndex.set(key,[]); arsenalIndex.get(key).push(row); }
  return { ...data, _statsIndex:statsIndex, _trackingIndex:trackingIndex, _arsenalIndex:arsenalIndex, _playerLevelById:playerLevelById };
}

function twoWayEvidence(player, data) {
  const hittingGroups =
    groupPlayerSeasonLevel(
      statRows(
        data,
        player.id,
        "hitting"
      ),
      isTotalRow
    ).filter(
      (row) =>
        Number(row.season) >= 2024
    );

  const pitchingGroups =
    groupPlayerSeasonLevel(
      statRows(
        data,
        player.id,
        "pitching"
      ),
      isTotalRow
    ).filter(
      (row) =>
        Number(row.season) >= 2024
    );

  let hittingPa = 0;
  let pitchingBf = 0;
  let pitchingIp = 0;
  let pitchingGames = 0;
  let pitchingStarts = 0;

  for (const group of hittingGroups) {
    const line =
      inferBattingLine(group.values);
    const weight =
      recencyWeight(group.season);
    hittingPa += line.pa * weight;
  }

  for (const group of pitchingGroups) {
    const line =
      inferPitchingLine(group.values);
    const weight =
      recencyWeight(group.season);
    pitchingBf += line.bf * weight;
    pitchingIp += line.ip * weight;
    pitchingGames +=
      line.games * weight;
    pitchingStarts +=
      line.gs * weight;
  }

  const designatedPitcher =
    ["P", "SP", "RP"].includes(
      String(
        player.position ?? ""
      ).toUpperCase()
    );

  const hitterThreshold =
    designatedPitcher ? 20 : 50;

  const pitchingEligible =
    designatedPitcher
      ? (
          pitchingIp >= 5 ||
          pitchingBf >= 20
        )
      : (
          pitchingIp >= 10 ||
          pitchingBf >= 40
        );

  const eligible =
    hittingPa >= hitterThreshold &&
    pitchingEligible;

  return freeze({
    eligible,
    designatedPitcher,
    hittingPa:
      round(hittingPa, 1),
    pitchingBf:
      round(pitchingBf, 1),
    pitchingIp:
      round(pitchingIp, 1),
    pitchingGames:
      round(pitchingGames, 1),
    pitchingStarts:
      round(pitchingStarts, 1),
    seasons: freeze(
      [
        ...new Set([
          ...hittingGroups.map(
            (row) => row.season
          ),
          ...pitchingGroups.map(
            (row) => row.season
          )
        ])
      ].sort(
        (a, b) => b - a
      )
    )
  });
}

function inferRealWorldUniverse(universe) {
  if (
    !universe ||
    universe.origin !== "MASTER_SNAPSHOT" ||
    !universe.data
  ) {
    return universe;
  }

  if (
    universe.inference?.schemaVersion ===
      REAL_WORLD_INFERENCE_SCHEMA_VERSION &&
    universe.inference?.sourceSnapshotHash ===
      universe.sourceSnapshot?.hash &&
    universe.inference?.modelId ===
      REAL_WORLD_INFERENCE_MODEL_ID
  ) {
    return universe;
  }

  const indexedData =
    buildIndexes(universe.data);
  const environments =
    inferLeagueEnvironments(indexedData);
  const context = {
    standard:
      buildStandardPopulation(
        indexedData
      ),
    tracking:
      buildTrackingPopulation(
        indexedData
      ),
    arsenal:
      buildArsenalPopulation(
        indexedData
      ),
    environments
  };

  const players = [];

  for (
    const player of
    universe.data.players ?? []
  ) {
    const position =
      String(
        player.position ?? ""
      ).toUpperCase();

    const pitching =
      statRows(
        indexedData,
        player.id,
        "pitching"
      );
    const hitting =
      statRows(
        indexedData,
        player.id,
        "hitting"
      );

    const dual =
      twoWayEvidence(
        player,
        indexedData
      );

    if (dual.eligible) {
      const hitter =
        inferHitter(
          player,
          indexedData,
          context
        );
      const pitcher =
        inferPitcher(
          player,
          indexedData,
          context
        );

      players.push(
        freeze({
          ...hitter,
          type: "TWO_WAY",
          overall:
            Math.max(
              Number(
                hitter.overall ?? 20
              ),
              Number(
                pitcher.overall ?? 20
              )
            ),
          role:
            pitcher.role,
          roleEvidence:
            pitcher.roleEvidence,
          pitchArsenal:
            pitcher.pitchArsenal,
          pitcherRatings:
            pitcher.ratings,
          hitterOverall:
            hitter.overall,
          pitcherOverall:
            pitcher.overall,
          twoWayEvidence:
            dual,
          hitterProfile:
            hitter,
          pitcherProfile:
            pitcher
        })
      );
      continue;
    }

    const hasPitching =
      ["P", "SP", "RP"].includes(
        position
      ) ||
      (
        pitching.length > 0 &&
        hitting.length === 0
      );

    players.push(
      hasPitching
        ? inferPitcher(
            player,
            indexedData,
            context
          )
        : inferHitter(
            player,
            indexedData,
            context
          )
    );
  }

  const inference = freeze({
    schemaVersion:
      REAL_WORLD_INFERENCE_SCHEMA_VERSION,
    modelId:
      REAL_WORLD_INFERENCE_MODEL_ID,
    sourceSnapshotHash:
      universe.sourceSnapshot?.hash ??
      null,
    referenceEnvironment:
      MLB_REFERENCE_ENVIRONMENT_2025,
    leagueEnvironments:
      environments,
    parks:
      buildEngineParkProfiles(
        universe.data.parks ?? []
      ),
    players,
    generatedFromPublicData: true,
    overallAndFutureValueAreDerivedOnly:
      true,
    trackingAndArsenalStaged:
      (
        universe.data.tracking?.length ??
        0
      ) > 0,
    twoWayDetection:
      "REAL_HITTING_AND_PITCHING_SAMPLE_V1"
  });

  return freeze({
    ...structuredClone(universe),
    inference
  });
}

function getInferredPlayer(universe, playerId) { return universe?.inference?.players?.find((row)=>String(row.playerId)===String(playerId)) ?? null; }

export { REAL_WORLD_INFERENCE_SCHEMA_VERSION, REAL_WORLD_INFERENCE_MODEL_ID, MLB_REFERENCE_ENVIRONMENT_2025, inferLeagueEnvironments, buildEngineParkProfiles, inferRealWorldUniverse, getInferredPlayer };
