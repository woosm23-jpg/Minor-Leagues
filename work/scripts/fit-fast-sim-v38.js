import fs from 'node:fs';
import path from 'node:path';
import { buildPAContext } from '../src/engine/pa/context.js';
import { sampleContactQuality, getContactQualityMean } from '../src/engine/pa/contactQuality.js';
import { sampleExitVelocity } from '../src/engine/pa/exitVelocity.js';
import { sampleLaunchAngle } from '../src/engine/pa/launchAngle.js';
import { sampleSprayDirection } from '../src/engine/pa/sprayDirection.js';
import { resolveBattedBall } from '../src/engine/pa/battedBallResolution.js';
import { createNeutralPark } from '../src/engine/pa/parkGeometry.js';
import { SeededRng } from '../src/engine/rng.js';
import { ratingToLatent } from '../src/engine/ratings/latentRating.js';

function parseArgs(argv) {
  const args = { samplesPerProfile: 30000, output: 'src/config/fastSimLookup.v38.js', report: 'reports/phase3-fast-sim-fit-v38.json' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--samples-per-profile') args.samplesPerProfile = Number(argv[++i]);
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--report') args.report = argv[++i];
  }
  if (!Number.isInteger(args.samplesPerProfile) || args.samplesPerProfile < 5000) throw new RangeError('--samples-per-profile은 5000 이상의 정수여야 합니다.');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const qualityDefs = Object.freeze({
  LOW: Object.freeze({ contact: 42, movement: 58, command: 56 }),
  MID: Object.freeze({ contact: 50, movement: 50, command: 50 }),
  HIGH: Object.freeze({ contact: 58, movement: 42, command: 44 })
});
const powerDefs = Object.freeze({
  LOW: Object.freeze({ rawPower: 42, utilization: 42 }),
  MID: Object.freeze({ rawPower: 50, utilization: 50 }),
  HIGH: Object.freeze({ rawPower: 58, utilization: 58 })
});
const basePark = createNeutralPark();
function parkVariant(key) {
  const spec = key === 'PITCHER' ? { carry: 0.98, wallDelta: 15 } : key === 'HITTER' ? { carry: 1.02, wallDelta: -15 } : { carry: 1, wallDelta: 0 };
  return Object.freeze({
    ...basePark,
    id: `fast_fit_${key.toLowerCase()}`,
    name: `Fast Fit ${key}`,
    carryFactor: basePark.carryFactor * spec.carry,
    wallProfile: Object.freeze(basePark.wallProfile.map((p) => Object.freeze({ ...p, distanceFt: p.distanceFt + spec.wallDelta })))
  });
}
const parkDefs = Object.freeze({ PITCHER: parkVariant('PITCHER'), NEUTRAL: parkVariant('NEUTRAL'), HITTER: parkVariant('HITTER') });

function contextFor(q, p, park) {
  const qd = qualityDefs[q];
  const pd = powerDefs[p];
  const hitter = {
    bats: 'R', contactR: qd.contact, contactL: qd.contact,
    rawPower: pd.rawPower, powerUtilizationR: pd.utilization, powerUtilizationL: pd.utilization,
    launchTendency: 50, sprayPull: 50, sprayCenter: 50, sprayOppo: 50,
    vision: 50, discipline: 50, speed: 50
  };
  const pitcher = {
    throws: 'R', control: 50, command: qd.command, movement: qd.movement,
    pitchability: 50, stuff: 50, pitchVelocityMph: 93.5, fatigue: 0
  };
  return buildPAContext({ hitter, pitcher, park: parkDefs[park], approach: 'BALANCED' });
}

function cell() {
  return { n: 0, outcomes: { OUT: 0, ROE: 0, '1B': 0, '2B': 0, '3B': 0, HR: 0 }, distanceSum: 0, distanceByOutcome: { OUT: [0,0], ROE:[0,0], '1B':[0,0], '2B':[0,0], '3B':[0,0], HR:[0,0] } };
}
function finalizeCell(c) {
  const n = Math.max(1, c.n);
  const probabilities = Object.fromEntries(Object.entries(c.outcomes).map(([k,v]) => [k, v / n]));
  const avgDistance = c.distanceSum / n;
  const distanceByOutcome = Object.fromEntries(Object.entries(c.distanceByOutcome).map(([k,[sum,count]]) => [k, count ? sum / count : avgDistance]));
  return { n: c.n, probabilities, avgDistanceFt: avgDistance, distanceByOutcomeFt: distanceByOutcome };
}

const lookup = {};
const profileMeta = {};
let totalSamples = 0;
for (const q of Object.keys(qualityDefs)) {
  lookup[q] = {};
  profileMeta[q] = {};
  for (const p of Object.keys(powerDefs)) {
    lookup[q][p] = {};
    profileMeta[q][p] = {};
    for (const park of Object.keys(parkDefs)) {
      const context = contextFor(q, p, park);
      const rng = new SeededRng(`fast-sim-fit-v38:${q}:${p}:${park}`);
      const cells = {};
      for (const type of ['GB','LD','FB','PU']) {
        cells[type] = {};
        for (const zone of ['PULL','CENTER','OPPO']) cells[type][zone] = cell();
      }
      for (let i = 0; i < args.samplesPerProfile; i += 1) {
        const cq = sampleContactQuality(context, rng);
        const ev = sampleExitVelocity(context, cq, rng);
        const la = sampleLaunchAngle(context, cq, rng);
        const spray = sampleSprayDirection(context, la, rng);
        const result = resolveBattedBall(context, ev, la, spray, rng);
        const c = cells[la.type][spray.zone];
        c.n += 1;
        c.outcomes[result.outcome] = (c.outcomes[result.outcome] ?? 0) + 1;
        const distance = result.wallClearance?.projectedDistanceFt ?? 220;
        c.distanceSum += distance;
        const bucket = c.distanceByOutcome[result.outcome] ?? [0,0];
        bucket[0] += distance; bucket[1] += 1; c.distanceByOutcome[result.outcome] = bucket;
      }
      totalSamples += args.samplesPerProfile;
      lookup[q][p][park] = Object.fromEntries(Object.entries(cells).map(([type,zones]) => [type, Object.fromEntries(Object.entries(zones).map(([zone,c]) => [zone, finalizeCell(c)]))]));
      profileMeta[q][p][park] = {
        contactQualityMean: getContactQualityMean(context),
        powerLatent: 0.65 * ratingToLatent(context.hitter.rawPower) + 0.35 * ratingToLatent(context.hitter.powerUtilization),
        parkCarryFactor: context.park.carryFactor,
        parkAverageWallFt: context.park.wallProfile.reduce((s,row) => s + row.distanceFt, 0) / context.park.wallProfile.length
      };
    }
  }
}

const payload = {
  id: 'fast_sim_lookup_v38_detailed_fit_1',
  sourceEngine: 'Detailed PA Engine phase0_baseline_v8',
  fitMethod: 'Monte Carlo BIP lookup by quality tier, power tier, park bucket, BIP class and spray zone',
  samplesPerProfile: args.samplesPerProfile,
  totalDetailedBips: totalSamples,
  qualityDefs,
  powerDefs,
  parkMeta: Object.fromEntries(Object.entries(parkDefs).map(([k,park]) => [k, { carryFactor: park.carryFactor, averageWallFt: park.wallProfile.reduce((s,row)=>s+row.distanceFt,0)/park.wallProfile.length }])),
  profileMeta,
  lookup
};

const outPath = path.resolve(args.output);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const moduleText = `// Auto-generated by scripts/fit-fast-sim-v38.js.\n// Do not hand-edit lookup probabilities; refit from the Detailed Engine.\nexport const FAST_SIM_LOOKUP_V38 = Object.freeze(${JSON.stringify(payload, null, 2)});\n`;
fs.writeFileSync(outPath, moduleText);
const reportPath = path.resolve(args.report);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify({ id: payload.id, samplesPerProfile: args.samplesPerProfile, totalDetailedBips: totalSamples, output: path.relative(process.cwd(), outPath), profileMeta }, null, 2) + '\n');
console.log(JSON.stringify({ output: outPath, report: reportPath, totalDetailedBips: totalSamples }, null, 2));
