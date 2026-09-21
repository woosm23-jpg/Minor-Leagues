import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildPAContext } from '../src/engine/pa/context.js';
import { simulatePA } from '../src/engine/pa/paEngine.js';
import { simulateFastPA } from '../src/engine/pa/fastPAEngine.js';
import { SeededRng } from '../src/engine/rng.js';
import { createDemoSeasonFixture, createSeasonGameFixture } from '../src/services/demoSeasonFactory.js';
import { simulateSeasonFixtureGame } from '../src/services/seasonGameService.js';
import { sumBattingTeam, sumPitchingTeam } from '../src/engine/game/boxScore.js';
import { FAST_SIM_LOOKUP_V38 } from '../src/config/fastSimLookup.v38.js';

function parseArgs(argv) {
  const args = { paSamples: 40000, games: 240, output: 'reports/phase3-fast-sim-v38.json', verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pa-samples') args.paSamples = Number(argv[++i]);
    else if (argv[i] === '--games') args.games = Number(argv[++i]);
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--verify') args.verify = true;
  }
  if (!Number.isInteger(args.paSamples) || args.paSamples < 10000) throw new RangeError('--pa-samples는 10000 이상의 정수여야 합니다.');
  if (!Number.isInteger(args.games) || args.games < 100) throw new RangeError('--games는 100 이상의 정수여야 합니다.');
  return args;
}
const args = parseArgs(process.argv.slice(2));

function makeContext({ contact, power, movement, command, stuff }) {
  return buildPAContext({
    hitter: { bats:'R', contactR:contact, contactL:contact, rawPower:power, powerUtilizationR:power, powerUtilizationL:power, launchTendency:50, sprayPull:50, sprayCenter:50, sprayOppo:50, vision:50, discipline:50, speed:50 },
    pitcher: { throws:'R', control:50, command, movement, pitchability:50, stuff, pitchVelocityMph:93.5 }
  });
}
const profiles = Object.freeze({
  LOW_OFFENSE: makeContext({ contact:42, power:42, movement:58, command:56, stuff:58 }),
  NEUTRAL: makeContext({ contact:50, power:50, movement:50, command:50, stuff:50 }),
  HIGH_OFFENSE: makeContext({ contact:58, power:58, movement:42, command:44, stuff:42 })
});
const terminal = ['BB','HBP','K','OUT','ROE','1B','2B','3B','HR'];
function paRates(simulator, context, samples, seed) {
  const rng = new SeededRng(seed);
  const counts = Object.fromEntries(terminal.map((key) => [key, 0]));
  const bip = { GB:0, LD:0, FB:0, PU:0 };
  for (let i = 0; i < samples; i += 1) {
    const row = simulator(context, rng);
    counts[row.finalOutcome] += 1;
    if (row.launchAngle) bip[row.launchAngle.type] += 1;
  }
  return {
    terminal: Object.fromEntries(terminal.map((key) => [key, counts[key] / samples])),
    bip: Object.fromEntries(Object.entries(bip).map(([key, value]) => [key, value / samples]))
  };
}

const profileParity = {};
for (const [name, context] of Object.entries(profiles)) {
  const detailed = paRates(simulatePA, context, args.paSamples, `v38-pa-detailed:${name}`);
  const fast = paRates(simulateFastPA, context, args.paSamples, `v38-pa-fast:${name}`);
  const deltas = Object.fromEntries(terminal.map((key) => [key, fast.terminal[key] - detailed.terminal[key]]));
  const checks = ['BB','K','1B','2B','3B','HR','OUT'].map((key) => ({ name:key, detailed:detailed.terminal[key], fast:fast.terminal[key], delta:deltas[key], tolerance:0.006, pass:Math.abs(deltas[key]) <= 0.006 }));
  profileParity[name] = { detailed, fast, deltas, checks, pass: checks.every((row) => row.pass) };
}

const season = createDemoSeasonFixture({ seed:'V38_FAST_SIM_MINI_LEAGUE', startDate:'2026-04-01' });
const schedule = season.levelLeagues.AA.schedule;
function runLeague(mode, games, prefix) {
  const agg = { games:0, runs:0, PA:0, BB:0, K:0, HR:0, H:0, pitches:0, BF:0, pitchersUsed:0 };
  const start = performance.now();
  for (let i = 0; i < games; i += 1) {
    const scheduled = schedule[i % schedule.length];
    const fixture = createSeasonGameFixture({ seasonFixture:season, scheduleGame:scheduled, level:'AA' });
    const result = simulateSeasonFixtureGame(fixture, { seed:`${prefix}:${i}`, mode });
    for (const side of ['away','home']) {
      const batting = sumBattingTeam(result.boxScore.teams[side]);
      const pitching = sumPitchingTeam(result.boxScore.teams[side]);
      agg.PA += batting.PA; agg.BB += batting.BB; agg.K += batting.SO; agg.HR += batting.HR; agg.H += batting.H;
      agg.pitches += pitching.Pitches; agg.BF += pitching.BF;
      agg.pitchersUsed += Object.values(result.boxScore.teams[side].pitching).filter((line) => line.BF > 0).length;
    }
    agg.runs += result.awayRuns + result.homeRuns;
    agg.games += 1;
  }
  const elapsedMs = performance.now() - start;
  return {
    ...agg, elapsedMs, msPerGame: elapsedMs / agg.games,
    rates: {
      runsPerTeamGame: agg.runs / (agg.games * 2),
      BBPerPA: agg.BB / agg.PA,
      KPerPA: agg.K / agg.PA,
      HRPerPA: agg.HR / agg.PA,
      HPerPA: agg.H / agg.PA,
      pitchesPerBF: agg.pitches / agg.BF,
      pitchersPerTeamGame: agg.pitchersUsed / (agg.games * 2)
    }
  };
}
// Warm JIT before timing acceptance samples.
runLeague('DETAILED', 12, 'warm-d');
runLeague('FAST', 12, 'warm-f');
const detailedLeague = runLeague('DETAILED', args.games, 'v38-parity');
const fastLeague = runLeague('FAST', args.games, 'v38-parity');
const leagueTolerances = {
  runsPerTeamGame:0.35, BBPerPA:0.012, KPerPA:0.012, HRPerPA:0.008,
  HPerPA:0.012, pitchesPerBF:0.12, pitchersPerTeamGame:0.30
};
const leagueChecks = Object.entries(leagueTolerances).map(([key,tolerance]) => ({
  name:key, detailed:detailedLeague.rates[key], fast:fastLeague.rates[key], delta:fastLeague.rates[key]-detailedLeague.rates[key], tolerance,
  pass:Math.abs(fastLeague.rates[key]-detailedLeague.rates[key]) <= tolerance
}));
const speedup = detailedLeague.msPerGame / fastLeague.msPerGame;
const speedCheck = { name:'Fast/Detailed throughput', detailedMsPerGame:detailedLeague.msPerGame, fastMsPerGame:fastLeague.msPerGame, speedup, minimum:1.20, pass:speedup >= 1.20 };

const report = {
  reportVersion:1,
  version:'v38',
  feature:'Fast Simulation Engine foundation + parity harness',
  lookup:{ id:FAST_SIM_LOOKUP_V38.id, totalDetailedBips:FAST_SIM_LOOKUP_V38.totalDetailedBips, samplesPerProfile:FAST_SIM_LOOKUP_V38.samplesPerProfile },
  paSamplesPerProfile:args.paSamples,
  profileParity,
  miniLeague:{ gamesPerEngine:args.games, detailed:detailedLeague, fast:fastLeague, checks:leagueChecks, speedCheck },
  pass:Object.values(profileParity).every((row)=>row.pass) && leagueChecks.every((row)=>row.pass) && speedCheck.pass
};
const output=path.resolve(args.output); fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ pass:report.pass, output, lookup:report.lookup, speedup, detailedMsPerGame:detailedLeague.msPerGame, fastMsPerGame:fastLeague.msPerGame, leagueChecks, profilePass:Object.fromEntries(Object.entries(profileParity).map(([k,v])=>[k,v.pass])) },null,2));
if (args.verify && !report.pass) process.exitCode=1;
