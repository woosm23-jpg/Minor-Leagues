import fs from 'node:fs';
import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';
import { REAL_WORLD_POTENTIAL_MODEL_ID, inferRealPlayerPotentialProfile } from '../src/data/realWorldPotential.js';
import { createPhase1Hitter, createPhase1Pitcher } from '../src/engine/player/playerFixtures.js';
import { applyPublicScoutingPatchToSnapshot } from '../src/data/publicScoutingPatch.js';

const ROOT = new URL('../', import.meta.url);
const outArg = process.argv.find((x) => x.startsWith('--output='));
const OUTPUT = outArg ? outArg.slice('--output='.length) : 'reports/v50-phase-d-potential-audit.json';
const VERIFY = process.argv.includes('--verify');
const readGz = (rel) => JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(rel, ROOT))).toString('utf8'));
let base = readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const phaseDPath = new URL('data/the_call_up_phase_d/public-scouting-2026.json.gz', ROOT);
if (fs.existsSync(phaseDPath)) base = applyPublicScoutingPatchToSnapshot(base, readGz('data/the_call_up_phase_d/public-scouting-2026.json.gz'));
const patch = readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
if (patch.baseSnapshotHash !== base.metadata.contentHash) throw new Error(`Phase C base hash mismatch: ${patch.baseSnapshotHash} != ${base.metadata.contentHash}`);

const universe = inferRealWorldUniverse({
  schemaVersion: 1,
  origin: 'MASTER_SNAPSHOT',
  sourceSnapshot: { id: base.metadata?.snapshotId ?? 'v2', hash: base.metadata.contentHash, season: base.metadata?.season ?? 2026 },
  data: { ...base, tracking: patch.tracking, pitchArsenal: patch.pitchArsenal }
});
const inferenceById = new Map(universe.inference.players.map((row) => [String(row.playerId), row]));

function clampRating(v, fallback = 50) { const n = Number(v); return Math.max(20, Math.min(99, Math.round(Number.isFinite(n) ? n : fallback))); }
function enginePlayer(source, inference) {
  const r = inference.ratings ?? {};
  if (inference.type === 'PITCHER') return createPhase1Pitcher({
    id: String(source.id), ovr: clampRating(inference.overall), role: inference.role ?? 'RP',
    control: clampRating(r.control), command: clampRating(r.command), movement: clampRating(r.movement),
    pitchability: clampRating(r.pitchability), stamina: clampRating(r.stamina), stuff: clampRating(r.stuff),
    pitchVelocityMph: r.pitchVelocityMph == null ? null : Number(r.pitchVelocityMph)
  });
  return createPhase1Hitter({
    id: String(source.id), ovr: clampRating(inference.overall),
    contactR: clampRating(r.contactR), contactL: clampRating(r.contactL), rawPower: clampRating(r.rawPower),
    vision: clampRating(r.vision), discipline: clampRating(r.discipline),
    powerUtilizationR: clampRating(r.powerUtilizationR), powerUtilizationL: clampRating(r.powerUtilizationL),
    speed: clampRating(r.speed), fielding: clampRating(r.fielding), reaction: clampRating(r.reaction)
  });
}
function currentTools(player, inference) {
  if (inference.type === 'PITCHER') return {
    control: player.pitching.control, command: player.pitching.command, movement: player.pitching.movement,
    pitchability: player.pitching.pitchability, stamina: player.pitching.stamina, stuff: player.derived.stuff,
    velocityMph: player.pitching.pitchVelocityMph == null ? 92 : Number(player.pitching.pitchVelocityMph)
  };
  return {
    contact: Math.max(player.hitting.contactR, player.hitting.contactL),
    power: Math.max(player.hitting.rawPower, player.tendencies.powerUtilizationR, player.tendencies.powerUtilizationL),
    vision: player.hitting.vision, discipline: player.hitting.discipline,
    defense: Math.max(player.fielding.fielding, player.fielding.reaction), speed: player.running.speed
  };
}
function quantile(values, p) { const a = [...values].sort((x,y)=>x-y); return a[Math.max(0, Math.min(a.length - 1, Math.round((a.length - 1) * p)))]; }
function summary(values) {
  if (!values.length) return { n: 0, mean: null, p10: null, median: null, p90: null, min: null, max: null };
  return { n: values.length, mean: Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(3)), p10: Number(quantile(values,.1).toFixed(3)), median: Number(quantile(values,.5).toFixed(3)), p90: Number(quantile(values,.9).toFixed(3)), min: Number(quantile(values,0).toFixed(3)), max: Number(quantile(values,1).toFixed(3)) };
}

const rows = [];
const finiteErrors = [];
let orderingErrors = 0;
let publicScoutingPlayers = 0;
for (const source of base.players) {
  const inference = inferenceById.get(String(source.id));
  if (!inference) continue;
  if (source.publicScouting) publicScoutingPlayers += 1;
  const player = enginePlayer(source, inference);
  const current = currentTools(player, inference);
  const profile = inferRealPlayerPotentialProfile({ player, sourcePlayer: source, inference, seed: 'phase-d-audit' });
  const rooms = [], ceilingRooms = [];
  for (const [tool, cur] of Object.entries(current)) {
    const reach = Number(profile.reachableProjection[tool]);
    const ceil = Number(profile.ceilings[tool]);
    if (![cur, reach, ceil].every(Number.isFinite)) finiteErrors.push(`${source.id}:${tool}`);
    if (reach + 1e-9 < cur || ceil + 1e-9 < reach) orderingErrors += 1;
    rooms.push(reach - cur); ceilingRooms.push(ceil - cur);
  }
  rows.push({
    id: String(source.id), name: source.fullName, age: Number(source.age), level: source.level,
    type: inference.type, role: inference.role ?? null, overall: inference.overall,
    reachableRoom: rooms.reduce((a,b)=>a+b,0)/rooms.length,
    ceilingRoom: ceilingRooms.reduce((a,b)=>a+b,0)/ceilingRooms.length,
    maxReachableRoom: Math.max(...rooms), confidence: profile.potentialConfidence,
    hiddenTrait: profile.hiddenDevelopmentTrait
  });
}

const groups = {
  youngA: rows.filter((r)=>r.level==='A' && r.age<=21),
  youngHighA: rows.filter((r)=>r.level==='HIGH_A' && r.age<=22),
  youngAA: rows.filter((r)=>r.level==='AA' && r.age<=23),
  youngAAA: rows.filter((r)=>r.level==='AAA' && r.age<=25),
  youngMLB: rows.filter((r)=>r.level==='MLB' && r.age<=24),
  primeMLB: rows.filter((r)=>r.level==='MLB' && r.age>=25 && r.age<=28),
  veteranMLB: rows.filter((r)=>r.level==='MLB' && r.age>=29 && r.age<=32),
  oldMLB: rows.filter((r)=>r.level==='MLB' && r.age>=33)
};
const groupSummary = Object.fromEntries(Object.entries(groups).map(([k,v]) => [k, { reachable: summary(v.map((r)=>r.reachableRoom)), ceiling: summary(v.map((r)=>r.ceilingRoom)) }]));
const topReachable = [...rows].sort((a,b)=>b.reachableRoom-a.reachableRoom).slice(0,25);
const veteranOutliers = rows.filter((r)=>r.age>=31).sort((a,b)=>b.reachableRoom-a.reachableRoom).slice(0,25);
const traitCounts = Object.fromEntries([...new Set(rows.map((r)=>r.hiddenTrait))].sort().map((trait)=>[trait,rows.filter((r)=>r.hiddenTrait===trait).length]));
const confidenceCounts = Object.fromEntries([...new Set(rows.map((r)=>r.confidence))].sort().map((confidence)=>[confidence,rows.filter((r)=>r.confidence===confidence).length]));

const gates = {
  playerCount: rows.length === base.players.length,
  finite: finiteErrors.length === 0,
  ordering: orderingErrors === 0,
  youngAHasRoom: groupSummary.youngA.reachable.median >= 6,
  ladderTapers: groupSummary.youngA.reachable.median > groupSummary.youngHighA.reachable.median && groupSummary.youngHighA.reachable.median > groupSummary.youngAA.reachable.median && groupSummary.youngAA.reachable.median > groupSummary.youngAAA.reachable.median,
  youngMlbModerate: groupSummary.youngMLB.reachable.median >= 1.5 && groupSummary.youngMLB.reachable.median <= 5,
  primeMlbNarrow: groupSummary.primeMLB.reachable.median <= 2.5,
  veteranMlbNearCurrent: groupSummary.veteranMLB.reachable.p90 <= 0.75,
  oldMlbNoAutoGrowth: groupSummary.oldMLB.reachable.p90 <= 0.25
};
const result = {
  schema: 'THE_CALL_UP_REAL_POTENTIAL_PHASE_D_AUDIT_V1', modelId: rows.length ? REAL_WORLD_POTENTIAL_MODEL_ID : null,
  baseSnapshotHash: base.metadata.contentHash, players: rows.length, publicScoutingPlayers,
  finiteErrors: finiteErrors.slice(0,25), orderingErrors, groupSummary, traitCounts, confidenceCounts,
  overallReachableRoom: summary(rows.map((r)=>r.reachableRoom)), overallCeilingRoom: summary(rows.map((r)=>r.ceilingRoom)),
  topReachable, veteranOutliers, gates, pass: Object.values(gates).every(Boolean)
};
fs.mkdirSync(new URL('reports/', ROOT), { recursive: true });
fs.writeFileSync(new URL(OUTPUT, ROOT), JSON.stringify(result, null, 2));
console.log(`PLAYERS ${result.players} PUBLIC_SCOUTING ${publicScoutingPlayers} ORDERING_ERRORS ${orderingErrors} FINITE_ERRORS ${finiteErrors.length}`);
for (const [name, row] of Object.entries(groupSummary)) console.log(`${name} REACH_MEDIAN ${row.reachable.median} REACH_P90 ${row.reachable.p90}`);
console.log(result.pass ? 'PHASE_D_POTENTIAL_AUDIT_PASS' : 'PHASE_D_POTENTIAL_AUDIT_FAIL');
if (VERIFY && !result.pass) process.exitCode = 1;
