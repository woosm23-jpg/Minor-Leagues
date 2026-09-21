import fs from "node:fs";
import path from "node:path";
import { buildPAContext } from "../src/engine/pa/context.js";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { deriveBattingRates, sumBattingTeam, sumPitchingTeam } from "../src/engine/game/boxScore.js";

function parseArgs(argv) {
  const args = { games: 5000, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--games") args.games = Number(argv[++i]);
    else if (argv[i] === "--output") args.output = argv[++i];
  }
  if (!Number.isInteger(args.games) || args.games <= 0) throw new RangeError("--games는 양의 정수여야 합니다.");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const away = Array.from({ length: 9 }, (_, i) => `A${i + 1}`);
const home = Array.from({ length: 9 }, (_, i) => `H${i + 1}`);
const hitter = {
  bats: "R", contactR: 50, contactL: 50, rawPower: 50,
  powerUtilizationR: 50, powerUtilizationL: 50, launchTendency: 50,
  sprayPull: 50, sprayCenter: 50, sprayOppo: 50, vision: 50, discipline: 50
};
const pitcher = { throws: "R", control: 50, command: 50, movement: 50, pitchability: 50, stuff: 50 };
const context = buildPAContext({ hitter, pitcher, approach: "BALANCED" });

let reconciliationFailures = 0;
let totalPA = 0;
let totalRuns = 0;
const aggregate = {
  PA: 0, AB: 0, R: 0, H: 0, doubles: 0, triples: 0, HR: 0, RBI: 0,
  BB: 0, HBP: 0, SO: 0, SF: 0, GDP: 0, TB: 0
};

function addLine(target, line) {
  for (const key of Object.keys(target)) target[key] += line[key] ?? 0;
}

for (let i = 0; i < args.games; i += 1) {
  const initialState = createGameState({
    gameId: `phase1_stats_${i}`,
    awayLineup: away,
    homeLineup: home,
    awayPitcherId: "AP",
    homePitcherId: "HP"
  });
  const result = simulateGame({
    initialState,
    contextResolver: () => context,
    rng: new SeededRng(`phase1-stats-${i}`),
    maxPlateAppearances: 500
  });

  const awayBat = sumBattingTeam(result.boxScore.teams.away);
  const homeBat = sumBattingTeam(result.boxScore.teams.home);
  const awayPit = sumPitchingTeam(result.boxScore.teams.away);
  const homePit = sumPitchingTeam(result.boxScore.teams.home);

  const checks = [
    awayBat.R === result.state.score.away,
    homeBat.R === result.state.score.home,
    awayBat.PA + homeBat.PA === result.state.plateAppearances,
    result.statEvents.length === result.state.plateAppearances,
    awayBat.H === homePit.H,
    homeBat.H === awayPit.H,
    awayBat.BB === homePit.BB,
    homeBat.BB === awayPit.BB,
    awayBat.HBP === homePit.HBP,
    homeBat.HBP === awayPit.HBP,
    awayBat.SO === homePit.SO,
    homeBat.SO === awayPit.SO,
    awayBat.R === homePit.R,
    homeBat.R === awayPit.R
  ];
  if (checks.some((value) => !value)) reconciliationFailures += 1;

  totalPA += result.state.plateAppearances;
  totalRuns += result.state.score.away + result.state.score.home;
  addLine(aggregate, awayBat);
  addLine(aggregate, homeBat);
}

const rates = deriveBattingRates(aggregate);
const checks = [
  {
    name: "all box scores reconcile with authoritative GameState",
    pass: reconciliationFailures === 0,
    observed: reconciliationFailures,
    target: 0
  },
  {
    name: "aggregate raw stat identities are valid",
    pass:
      aggregate.H >= aggregate.doubles + aggregate.triples + aggregate.HR &&
      aggregate.TB ===
        (aggregate.H - aggregate.doubles - aggregate.triples - aggregate.HR) +
        2 * aggregate.doubles + 3 * aggregate.triples + 4 * aggregate.HR,
    observed: {
      H: aggregate.H,
      doubles: aggregate.doubles,
      triples: aggregate.triples,
      HR: aggregate.HR,
      TB: aggregate.TB
    }
  },
  {
    name: "derived batting rates are finite and baseball-plausible",
    pass:
      Object.values(rates).every(Number.isFinite) &&
      rates.AVG > 0.20 && rates.AVG < 0.30 &&
      rates.OBP > 0.28 && rates.OBP < 0.36 &&
      rates.SLG > 0.34 && rates.SLG < 0.46,
    observed: rates
  }
];

const report = {
  reportVersion: 1,
  phase: "Phase 1 - Stat Event Processor + Box Score",
  sampleGames: args.games,
  totalPA,
  totalRuns,
  aggregateBatting: aggregate,
  derivedRates: rates,
  reconciliationFailures,
  checks,
  pass: checks.every((check) => check.pass)
};

const json = JSON.stringify(report, null, 2) + "\n";
if (args.output) {
  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, json);
} else {
  process.stdout.write(json);
}
if (!report.pass) process.exitCode = 1;
