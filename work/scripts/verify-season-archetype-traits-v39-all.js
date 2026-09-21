import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const seedArg = process.argv.find((arg) => arg.startsWith('--seeds='));
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
const verify = process.argv.includes('--verify');
const seeds = Number(seedArg?.slice(8) ?? 6);
const concurrency = Math.max(1, Math.min(seeds, Number(concurrencyArg?.slice(14) ?? 3)));
const worker = fileURLToPath(new URL('./verify-season-archetype-traits-v39.js', import.meta.url));
const rowsBySeed = new Map();
const tempFiles = [];
let nextSeed = 1;
let failed = null;

function runSeed(seed) {
  return new Promise((resolve, reject) => {
    const temp = `reports/.phase3-archetype-traits-v39-seed-${seed}.json`;
    tempFiles.push(temp);
    const args = [worker, `--seed=${seed}`, `--output=${temp}`, '--quiet'];
    if (verify) args.push('--verify');
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`v39 seed ${seed} worker failed: ${code}`));
      const report = JSON.parse(fs.readFileSync(temp, 'utf8'));
      rowsBySeed.set(seed, report.rows);
      process.stderr.write(`v39 seed ${seed}/${seeds} PASS\n`);
      resolve();
    });
  });
}

async function runner() {
  while (!failed) {
    const seed = nextSeed++;
    if (seed > seeds) return;
    try { await runSeed(seed); }
    catch (error) { failed = error; return; }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => runner()));
for (const temp of tempFiles) fs.rmSync(temp, { force: true });
if (failed) throw failed;
const rows = [];
for (let seed = 1; seed <= seeds; seed += 1) rows.push(...(rowsBySeed.get(seed) ?? []));
const aggregateBench = rows.reduce((acc, row) => {
  const reasons = row?.bench?.reasons ?? {};
  acc.PINCH_HIT += reasons.PINCH_HIT ?? 0;
  acc.PINCH_RUN += reasons.PINCH_RUN ?? 0;
  acc.DEFENSIVE_REPLACEMENT += reasons.DEFENSIVE_REPLACEMENT ?? 0;
  return acc;
}, { PINCH_HIT:0, PINCH_RUN:0, DEFENSIVE_REPLACEMENT:0 });
if (verify && aggregateBench.PINCH_HIT <= 0) throw new Error('v39 six-seed natural sample has no pinch-hit events');
if (verify && aggregateBench.PINCH_RUN <= 0) throw new Error('v39 six-seed natural sample has no pinch-run events');
const report = {
  version: 'v39',
  sourceGolden: 'phase3_fast_sim_v38',
  careerMomentGolden: 'phase3_career_moments_v30',
  seeds,
  verified: verify,
  isolatedProcesses: true,
  concurrency,
  aggregateBench,
  rows
};
const output = outputArg?.slice('--output='.length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
