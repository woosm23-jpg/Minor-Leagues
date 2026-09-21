import fs from 'node:fs';
import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';

const ROOT = new URL('../', import.meta.url);
const outArg = process.argv.find((x) => x.startsWith('--output='));
const OUTPUT = outArg ? outArg.slice('--output='.length) : 'reports/v50-phase-e-preflight.json';
const VERIFY = process.argv.includes('--verify');

const readGz = (rel) => JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(rel, ROOT))).toString('utf8'));
const base = readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const phaseC = readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
if (phaseC.baseSnapshotHash !== base.metadata.contentHash) {
  throw new Error(`Phase C base hash mismatch: ${phaseC.baseSnapshotHash} != ${base.metadata.contentHash}`);
}

const data = { ...base, tracking: phaseC.tracking, pitchArsenal: phaseC.pitchArsenal };
const phaseDPath = new URL('data/the_call_up_phase_d/public-scouting-2026.json.gz', ROOT);
let publicScoutingRecords = [];
if (fs.existsSync(phaseDPath)) {
  const phaseD = JSON.parse(zlib.gunzipSync(fs.readFileSync(phaseDPath)).toString('utf8'));
  if (phaseD.baseSnapshotHash && phaseD.baseSnapshotHash !== base.metadata.contentHash) {
    throw new Error(`Phase D base hash mismatch: ${phaseD.baseSnapshotHash} != ${base.metadata.contentHash}`);
  }
  publicScoutingRecords = phaseD.records ?? [];
  const scoutingById = new Map(publicScoutingRecords.map((r) => [String(r.playerId), r.publicScouting]));
  data.players = base.players.map((p) => scoutingById.has(String(p.id)) ? { ...p, publicScouting: scoutingById.get(String(p.id)) } : p);
}

const universe = inferRealWorldUniverse({
  schemaVersion: 1,
  origin: 'MASTER_SNAPSHOT',
  sourceSnapshot: { id: base.metadata.snapshotId, hash: base.metadata.contentHash, season: 2026 },
  data
});
const inferred = universe.inference.players;
const sourceById = new Map(data.players.map((p) => [String(p.id), p]));
const statsByPlayer = new Map();
for (const row of base.stats ?? []) {
  const id = String(row.playerId);
  if (!statsByPlayer.has(id)) statsByPlayer.set(id, []);
  statsByPlayer.get(id).push(row);
}
const trackingByPlayer = new Map();
for (const row of phaseC.tracking ?? []) {
  const id = String(row.playerId);
  if (!trackingByPlayer.has(id)) trackingByPlayer.set(id, []);
  trackingByPlayer.get(id).push(row);
}

function q(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.max(0, Math.min(a.length - 1, Math.round((a.length - 1) * p)))];
}
function summary(values) {
  const a = values.filter(Number.isFinite);
  if (!a.length) return { n: 0, mean: null, p10: null, median: null, p90: null, min: null, max: null };
  return {
    n: a.length,
    mean: Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)),
    p10: Number(q(a, .1).toFixed(3)), median: Number(q(a, .5).toFixed(3)), p90: Number(q(a, .9).toFixed(3)),
    min: Number(q(a, 0).toFixed(3)), max: Number(q(a, 1).toFixed(3))
  };
}
function totalPa(rows, season = null, level = null) {
  return rows.filter((r) => r.group === 'hitting' && (!season || r.season === season) && (!level || r.level === level) && (r.splitContext?.type ?? 'TOTAL') === 'TOTAL')
    .reduce((s, r) => s + Number(r.values?.plateAppearances ?? r.sample?.plateAppearances ?? 0), 0);
}
function totalBf(rows, season = null, level = null) {
  return rows.filter((r) => r.group === 'pitching' && (!season || r.season === season) && (!level || r.level === level) && (r.splitContext?.type ?? 'TOTAL') === 'TOTAL')
    .reduce((s, r) => s + Number(r.values?.battersFaced ?? r.sample?.battersFaced ?? 0), 0);
}
function seasons(rows) { return [...new Set(rows.map((r) => Number(r.season)).filter(Boolean))].sort(); }
function levels(rows) { return [...new Set(rows.map((r) => r.level).filter(Boolean))]; }
function sameLevelTeamSegments(rows) {
  const keys = new Map();
  for (const r of rows.filter((x) => (x.splitContext?.type ?? 'TOTAL') === 'TOTAL')) {
    const key = `${r.season}:${r.level}:${r.group}`;
    if (!keys.has(key)) keys.set(key, new Set());
    if (r.teamId) keys.get(key).add(String(r.teamId));
  }
  return [...keys.values()].some((s) => s.size >= 2);
}
function isTwoWay(rows) {
  const h = rows.filter((r) => r.group === 'hitting').reduce((s, r) => s + Number(r.values?.plateAppearances ?? 0), 0);
  const p = rows.filter((r) => r.group === 'pitching').reduce((s, r) => s + Number(r.values?.battersFaced ?? 0), 0);
  return h >= 20 && p >= 20;
}
function largePlatoon(rows) {
  const splits = rows.filter((r) => r.group === 'hitting' && ['PLATOON_R','PLATOON_L','VS_R','VS_L'].includes(String(r.splitContext?.type ?? '').toUpperCase()));
  if (!splits.length) return false;
  const vals = splits.map((r) => Number(r.values?.ops ?? r.values?.avg ?? NaN)).filter(Number.isFinite);
  return vals.length >= 2 && Math.max(...vals) - Math.min(...vals) >= 0.18;
}
function tinyTracking(id) {
  const rows = trackingByPlayer.get(id) ?? [];
  const samples = rows.flatMap((r) => Object.values(r.denominators ?? {}).map(Number).filter(Number.isFinite));
  return samples.some((n) => n > 0 && n <= 10);
}

const finiteErrors = [];
const coreRatings = [];
const strata = {};
for (const inf of inferred) {
  const src = sourceById.get(String(inf.playerId));
  const key = `${src?.level ?? inf.level}:${inf.type}`;
  strata[key] ??= [];
  strata[key].push(inf.overall);
  if (!Number.isFinite(Number(inf.overall))) finiteErrors.push(`${inf.playerId}:overall`);
  for (const [name, value] of Object.entries(inf.ratings ?? {})) {
    if (value == null) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) finiteErrors.push(`${inf.playerId}:${name}`);
    if (!['clutch','armStrength'].includes(name) && Number.isFinite(n)) coreRatings.push(n);
  }
}

const edge = {
  healthyMlbVeteranLargeSample: [], mlbIlStarNo2026: [], mlbTiny2026PriorFull: [], aaaMlbShuttle: [], rehabMlbPlayer: [], aaToAaaPromotion: [], sameLevelTrade: [],
  publicScoutingProspect: [], noScoutingLowMinors: [], largePlatoonSplit: [], utilityPlayer: [], catcher: [], roleTransitionCandidate: [], twoWay: [], longInjuryVeteran: [], recordlessRookie: [], tinyStatcast: []
};
for (const p of data.players) {
  const id = String(p.id), rows = statsByPlayer.get(id) ?? [];
  const lvl = p.assignedLevel ?? p.level;
  const age = Number(p.age ?? 0);
  const pa26 = totalPa(rows, 2026, 'MLB'), pa25 = totalPa(rows, 2025, 'MLB');
  const bf26 = totalBf(rows, 2026, 'MLB'), bf25 = totalBf(rows, 2025, 'MLB');
  const allSeasons = seasons(rows), allLevels = levels(rows);
  const mlbSample = totalPa(rows, null, 'MLB') + totalBf(rows, null, 'MLB');
  if (lvl === 'MLB' && age >= 29 && p.availability === 'ACTIVE' && mlbSample >= 800 && allSeasons.length >= 3) edge.healthyMlbVeteranLargeSample.push(id);
  if (lvl === 'MLB' && p.availability !== 'ACTIVE' && (pa26 + bf26) === 0 && (pa25 + bf25) >= 250) edge.mlbIlStarNo2026.push(id);
  if (lvl === 'MLB' && (pa26 + bf26) > 0 && (pa26 + bf26) <= 50 && (pa25 + bf25) >= 400) edge.mlbTiny2026PriorFull.push(id);
  if (allLevels.includes('AAA') && allLevels.includes('MLB')) edge.aaaMlbShuttle.push(id);
  if (p.availability === 'REHAB' || (p.rosterEvidence ?? []).some((x) => String(x.availability) === 'REHAB')) edge.rehabMlbPlayer.push(id);
  if (allLevels.includes('AA') && allLevels.includes('AAA')) edge.aaToAaaPromotion.push(id);
  if (sameLevelTeamSegments(rows)) edge.sameLevelTrade.push(id);
  if (p.publicScouting && Number(p.publicScouting.futureValue?.grade ?? p.publicScouting.futureValue ?? 0) >= 50) edge.publicScoutingProspect.push(id);
  if (['A','HIGH_A','AA'].includes(lvl) && !p.publicScouting) edge.noScoutingLowMinors.push(id);
  if (largePlatoon(rows)) edge.largePlatoonSplit.push(id);
  if ((p.positions ?? []).filter((x) => Number(x.games ?? 0) >= 10).length >= 3) edge.utilityPlayer.push(id);
  if (p.position === 'C' || (p.positions ?? []).some((x) => x.position === 'C' && Number(x.games ?? 0) >= 20)) edge.catcher.push(id);
  if (rows.some((r) => r.group === 'pitching') && allSeasons.length >= 2) {
    // Generic role-transition coverage: multiple seasons with pitching evidence and current inferred SP/RP role.
    edge.roleTransitionCandidate.push(id);
  }
  if (isTwoWay(rows)) edge.twoWay.push(id);
  if (age >= 30 && ['INJURED_60','INJURED_FULL_SEASON'].includes(p.availability)) edge.longInjuryVeteran.push(id);
  if (p.rookieEligibility && rows.length === 0) edge.recordlessRookie.push(id);
  if (tinyTracking(id)) edge.tinyStatcast.push(id);
}

const overall = inferred.map((x) => Number(x.overall));
const rounded50 = overall.filter((x) => Math.round(x) === 50).length;
const rounded55 = overall.filter((x) => Math.round(x) === 55).length;
const exactFallbackCore = coreRatings.filter((x) => x === 50 || x === 55).length;
const strataSummary = Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, summary(v)]));
const edgeCounts = Object.fromEntries(Object.entries(edge).map(([k, v]) => [k, v.length]));

const gates = {
  playerCount: inferred.length === base.players.length && inferred.length === 5429,
  finiteRatings: finiteErrors.length === 0,
  allLevelsRepresented: ['MLB','AAA','AA','HIGH_A','A'].every((lvl) => inferred.some((x) => (sourceById.get(String(x.playerId))?.level ?? x.level) === lvl)),
  bothTypesRepresented: inferred.some((x) => x.type === 'HITTER') && inferred.some((x) => x.type === 'PITCHER'),
  noOvrFallbackCluster: rounded50 / inferred.length < 0.08 && rounded55 / inferred.length < 0.08,
  noCoreFallbackCluster: exactFallbackCore / Math.max(1, coreRatings.length) < 0.18,
  multiYearEdgeCoverage: edge.healthyMlbVeteranLargeSample.length > 0,
  shuttleCoverage: edge.aaaMlbShuttle.length > 0,
  transactionCoverage: edge.sameLevelTrade.length > 0,
  lowMinorsCoverage: edge.noScoutingLowMinors.length > 0,
  catcherCoverage: edge.catcher.length > 0,
  tinyTrackingCoverage: edge.tinyStatcast.length > 0
};

const result = {
  schema: 'THE_CALL_UP_PHASE_E_PREFLIGHT_V1',
  baseSnapshotHash: base.metadata.contentHash,
  phaseCSha256: phaseC.sha256 ?? null,
  publicScoutingRecords: publicScoutingRecords.length,
  players: inferred.length,
  overall: summary(overall),
  strata: strataSummary,
  fallbackCluster: { rounded50, rounded55, exactFallbackCore, coreRatingCount: coreRatings.length },
  edgeCaseCounts: edgeCounts,
  finiteErrors: finiteErrors.slice(0, 50),
  gates,
  pass: Object.values(gates).every(Boolean)
};
fs.mkdirSync(new URL('reports/', ROOT), { recursive: true });
fs.writeFileSync(new URL(OUTPUT, ROOT), JSON.stringify(result, null, 2));
console.log(`PLAYERS ${result.players} PUBLIC_SCOUTING ${result.publicScoutingRecords}`);
console.log(`OVR ${JSON.stringify(result.overall)}`);
console.log(`FALLBACK ${JSON.stringify(result.fallbackCluster)}`);
console.log(`EDGE_COUNTS ${JSON.stringify(result.edgeCaseCounts)}`);
console.log(result.pass ? 'PHASE_E_PREFLIGHT_PASS' : 'PHASE_E_PREFLIGHT_FAIL');
if (VERIFY && !result.pass) process.exitCode = 1;
