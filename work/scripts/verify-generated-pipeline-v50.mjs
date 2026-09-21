import fs from 'node:fs';
import {
  createGeneratedLeagueLifecycle,
  advanceGeneratedLeagueLifecycle,
  snapshotGeneratedLeague
} from '../src/engine/career/generatedLeagueLifecycle.js';

const ORGANIZATIONS = Array.from({ length: 30 }, (_, i) => `org_${String(i + 1).padStart(2, '0')}`);
const SEED = 'generated-pipeline-v50';
const START_YEAR = 2027;
const END_YEAR = 2046;
const ANNUAL_SAMPLE = 60;
const REAL_2026_LEVEL_SHARES = Object.freeze({ A:1183/5429, HIGH_A:1055/5429, AA:1021/5429, AAA:1100/5429, MLB:1070/5429 });

function round(v, n = 4) { return v == null ? null : Number(v.toFixed(n)); }
function publicSnapshot(state, label) {
  const s = snapshotGeneratedLeague(state);
  return {
    year: s.year,
    label,
    active: s.active,
    levels: s.levels,
    levelShares: Object.fromEntries(Object.entries(s.levelShares).map(([k, v]) => [k, round(v)])),
    meanOvr: round(s.meanOvr, 3),
    mlbMeanOvr: round(s.mlbMeanOvr, 3),
    meanAge: round(s.meanAge, 3),
    under25: s.under25,
    age35plus: s.age35plus,
    debuts: s.debutCount,
    meanDebutAge: round(s.meanDebutAge, 3),
    released: s.releasedCount,
    retired: s.retiredCount
  };
}

let state = createGeneratedLeagueLifecycle({
  seed: SEED,
  startYear: START_YEAR,
  annualEntrants: ANNUAL_SAMPLE,
  organizationIds: ORGANIZATIONS,
  targetMlbShare: 0.197,
  minMlbOvr: 44
});
const checkpoints = [publicSnapshot(state, 'START')];
for (const year of [2031, 2036, 2041, 2046]) {
  state = advanceGeneratedLeagueLifecycle(state, { year });
  checkpoints.push(publicSnapshot(state, `${year - START_YEAR}Y`));
}

const final = checkpoints.at(-1);
const ids = state.records.map((r) => String(r.player.id));
const finiteErrors = state.records
  .filter((r) => !Number.isFinite(Number(r.lastReview?.ovr ?? r.player?.ovr ?? 0)))
  .map((r) => r.player.id);
const debutRate = state.debutAges.length / Math.max(1, state.generatedCount);
const levelShareError = Object.fromEntries(Object.entries(REAL_2026_LEVEL_SHARES).map(([level, target]) => [level, round(final.levelShares[level] - target)]));
const maxLevelShareError = Math.max(...Object.values(levelShareError).map(Math.abs));
const gates = {
  uniqueIds: new Set(ids).size === ids.length,
  finite: finiteErrors.length === 0,
  activePoolStable: final.active >= ANNUAL_SAMPLE * 8 && final.active <= ANNUAL_SAMPLE * 14,
  mlbShare: final.levelShares.MLB >= 0.14 && final.levelShares.MLB <= 0.23,
  aaaBacklog: final.levelShares.AAA <= 0.31,
  mlbTalentLevel: final.mlbMeanOvr >= 48.5 && final.mlbMeanOvr <= 52.0,
  selectiveDebuts: debutRate >= 0.08 && debutRate <= 0.24,
  debutAge: final.meanDebutAge >= 23 && final.meanDebutAge <= 28,
  ageMix: final.meanAge >= 23 && final.meanAge <= 29 && final.under25 > 0,
  levelShapeVs2026: maxLevelShareError <= 0.04,
  classMeanReversion: Math.abs(state.classStrength) <= 0.75
};
const pass = Object.values(gates).every(Boolean);
const report = {
  schema: 'THE_CALL_UP_GENERATED_PIPELINE_V50_V2',
  simulation: {
    startYear: START_YEAR,
    endYear: END_YEAR,
    annualSample: ANNUAL_SAMPLE,
    scaleNote: 'Calibration sample; evaluate rates/shares, not raw league counts.',
    lifecycleVersion: state.version
  },
  generatedCount: state.generatedCount,
  activeCount: state.records.length,
  debutCount: state.debutAges.length,
  debutRate: round(debutRate),
  releasedCount: state.releasedCount,
  retiredCount: state.retiredCount,
  classStrength: round(state.classStrength),
  finiteErrors,
  levelShareTarget2026: REAL_2026_LEVEL_SHARES,
  levelShareError,
  maxLevelShareError: round(maxLevelShareError),
  checkpoints,
  gates,
  pass
};
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/v50-generated-pipeline-20y.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!pass) process.exitCode = 1;
