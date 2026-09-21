import fs from "node:fs";
import path from "node:path";
import { buildPAContext } from "../src/engine/pa/context.js";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { gameplayCalibration } from "../src/config/gameplayCalibration.js";

function parseArgs(argv) {
  const args = { games: 10_000, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--games") args.games = Number(argv[++i]);
    else if (argv[i] === "--output") args.output = argv[++i];
  }
  if (!Number.isInteger(args.games) || args.games <= 0) {
    throw new RangeError("--games는 양의 정수여야 합니다.");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const away = Array.from({ length: 9 }, (_, i) => `A${i + 1}`);
const home = Array.from({ length: 9 }, (_, i) => `H${i + 1}`);
const hitter = {
  bats: "R",
  contactR: 50,
  contactL: 50,
  rawPower: 50,
  powerUtilizationR: 50,
  powerUtilizationL: 50,
  launchTendency: 50,
  sprayPull: 50,
  sprayCenter: 50,
  sprayOppo: 50,
  vision: 50,
  discipline: 50
};
const pitcher = {
  throws: "R",
  control: 50,
  command: 50,
  movement: 50,
  pitchability: 50,
  stuff: 50
};
const context = buildPAContext({ hitter, pitcher, approach: "BALANCED" });

const counters = {
  totalRuns: 0,
  totalPA: 0,
  homeWins: 0,
  extraInningGames: 0,
  oneRunGames: 0,
  shutoutGames: 0,
  blowoutGames: 0,
  doublePlays: 0,
  outRuns: 0,
  maxPA: 0,
  maxInning: 0
};

for (let i = 0; i < args.games; i += 1) {
  const initialState = createGameState({
    gameId: `phase1_calibration_${i}`,
    awayLineup: away,
    homeLineup: home,
    awayPitcherId: "AP",
    homePitcherId: "HP"
  });
  const result = simulateGame({
    initialState,
    contextResolver: () => context,
    rng: new SeededRng(`phase1-game-calibration-${i}`),
    keepLog: true,
    maxPlateAppearances: 500
  });
  const state = result.state;
  counters.totalRuns += state.score.away + state.score.home;
  counters.totalPA += state.plateAppearances;
  counters.maxPA = Math.max(counters.maxPA, state.plateAppearances);
  counters.maxInning = Math.max(counters.maxInning, state.inning);
  if (state.result.winner === "home") counters.homeWins += 1;
  if (state.inning > 9) counters.extraInningGames += 1;
  if (Math.abs(state.score.away - state.score.home) === 1) counters.oneRunGames += 1;
  if (state.score.away === 0 || state.score.home === 0) counters.shutoutGames += 1;
  if (Math.abs(state.score.away - state.score.home) >= 5) counters.blowoutGames += 1;

  for (const entry of result.log) {
    if (entry.after.lastPlay?.outsRecorded === 2) counters.doublePlays += 1;
    if (entry.paResult.finalOutcome === "OUT") {
      counters.outRuns += entry.after.lastPlay?.runsScored ?? 0;
    }
  }
}

const targets = {
  runsPerTeamGame: 4.45,
  paPerGame: 37.64 * 2,
  groundDoublePlaysPerTeamGame: 3122 / 4860
};
const observed = {
  runsPerTeamGame: counters.totalRuns / (args.games * 2),
  paPerGame: counters.totalPA / args.games,
  groundDoublePlaysPerTeamGame: counters.doublePlays / (args.games * 2),
  outRunsPerTeamGame: counters.outRuns / (args.games * 2),
  homeWinRate: counters.homeWins / args.games,
  extraInningRate: counters.extraInningGames / args.games,
  oneRunGameRate: counters.oneRunGames / args.games,
  shutoutGameRate: counters.shutoutGames / args.games,
  blowoutRate: counters.blowoutGames / args.games,
  maxPA: counters.maxPA,
  maxInning: counters.maxInning
};
const checks = [
  {
    name: "2025 MLB R/G baseline",
    pass: Math.abs(observed.runsPerTeamGame - targets.runsPerTeamGame) <= targets.runsPerTeamGame * 0.02,
    observed: observed.runsPerTeamGame,
    target: targets.runsPerTeamGame,
    tolerance: targets.runsPerTeamGame * 0.02
  },
  {
    name: "2025 MLB PA/game baseline",
    pass: Math.abs(observed.paPerGame - targets.paPerGame) <= targets.paPerGame * 0.02,
    observed: observed.paPerGame,
    target: targets.paPerGame,
    tolerance: targets.paPerGame * 0.02
  },
  {
    name: "2025 MLB GDP/team-game baseline",
    pass: Math.abs(observed.groundDoublePlaysPerTeamGame - targets.groundDoublePlaysPerTeamGame) <= 0.08,
    observed: observed.groundDoublePlaysPerTeamGame,
    target: targets.groundDoublePlaysPerTeamGame,
    tolerance: 0.08
  },
  {
    name: "all games terminate",
    pass: counters.maxPA < 500 && counters.maxInning < 30,
    observed: { maxPA: counters.maxPA, maxInning: counters.maxInning }
  }
];

const report = {
  reportVersion: 1,
  phase: "Phase 1 - GameState baseline",
  calibrationId: gameplayCalibration.id,
  sampleGames: args.games,
  reference: {
    season: 2025,
    source: "Baseball-Reference MLB league batting totals/averages",
    note: "R/G=4.45, PA/team-game=37.64, GDP=3122 over 4860 team-games"
  },
  targets,
  observed,
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
