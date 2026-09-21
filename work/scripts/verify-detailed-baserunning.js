import fs from "node:fs";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import { createPitcherUsageManager } from "../src/engine/game/pitcherUsageAI.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const games = Number(arg("--games", "1200"));
const output = arg("--output", null);
const verify = process.argv.includes("--verify");
if (!Number.isInteger(games) || games <= 0) throw new RangeError("--games는 양의 정수여야 합니다.");

const targets = Object.freeze({
  source: "2025 MLB Baseball-Reference Baserunning/Misc league totals",
  firstThirdSingle: 2668 / 8275,
  firstHomeDouble: 955 / 2430,
  secondHomeSingle: 3063 / 5089,
  combinedExtraBaseSuccess: (2668 + 955 + 3063) / (8275 + 2430 + 5089),
  combinedOutOnAdvance: (96 + 73 + 184) / (8275 + 2430 + 5089),
  xbtPercentPublished: 0.42
});

function makeAlignment(prefix) {
  return { C: `${prefix}1`, "1B": `${prefix}2`, "2B": `${prefix}3`, "3B": `${prefix}4`, SS: `${prefix}5`, LF: `${prefix}6`, CF: `${prefix}7`, RF: `${prefix}8` };
}

function buildWorld({ speed = 50, baserunning = 50, arm = 50 } = {}) {
  const players = {};
  const away = [];
  const home = [];
  for (let i = 1; i <= 9; i += 1) {
    for (const prefix of ["A", "H"]) {
      const id = `${prefix}${i}`;
      players[id] = createPhase1Hitter({ id, speed, baserunning, armStrength: arm, armAccuracy: arm });
    }
    away.push(`A${i}`);
    home.push(`H${i}`);
  }

  const pitchingPlans = {};
  for (const [team, prefix] of [["away", "A"], ["home", "H"]]) {
    const starterId = `${prefix}SP`;
    players[starterId] = createPhase1Pitcher({ id: starterId, role: "SP", stamina: 50, pitchVelocityMph: 94, armStrength: arm, armAccuracy: arm });
    const bullpenIds = [];
    for (let i = 1; i <= 9; i += 1) {
      const id = `${prefix}RP${i}`;
      bullpenIds.push(id);
      players[id] = createPhase1Pitcher({ id, role: "RP", stamina: 50, pitchVelocityMph: 94, armStrength: arm, armAccuracy: arm });
    }
    pitchingPlans[team] = { starterId, bullpenIds };
  }

  return { players, away, home, pitchingPlans, awayDefense: makeAlignment("A"), homeDefense: makeAlignment("H") };
}

function blankCounter() {
  return { opportunities: 0, attempts: 0, successes: 0, outs: 0 };
}

function finalizeCounter(counter) {
  return {
    ...counter,
    attemptRate: counter.opportunities ? counter.attempts / counter.opportunities : 0,
    successPerOpportunity: counter.opportunities ? counter.successes / counter.opportunities : 0,
    outPerOpportunity: counter.opportunities ? counter.outs / counter.opportunities : 0,
    successIfAttempted: counter.attempts ? counter.successes / counter.attempts : 0
  };
}

function runScenario({ label, speed = 50, baserunning = 50, arm = 50, games: scenarioGames }) {
  const counters = {};
  let totalRuns = 0;
  let totalPA = 0;
  let baserunningOuts = 0;

  for (let g = 0; g < scenarioGames; g += 1) {
    const world = buildWorld({ speed, baserunning, arm });
    const contextResolver = createPlayerContextResolver({ players: world.players });
    const result = simulateGame({
      initialState: createGameState({
        gameId: `${label}-${g}`,
        awayLineup: world.away,
        homeLineup: world.home,
        awayPitcherId: world.pitchingPlans.away.starterId,
        homePitcherId: world.pitchingPlans.home.starterId,
        awayDefense: world.awayDefense,
        homeDefense: world.homeDefense
      }),
      contextResolver,
      pitcherManager: createPitcherUsageManager({ players: world.players, pitchingPlans: world.pitchingPlans }),
      rng: new SeededRng(`${label}-${g}`),
      keepLog: true
    });

    totalRuns += result.state.score.away + result.state.score.home;
    totalPA += result.plateAppearances;
    for (const row of result.log) {
      for (const event of row.after.lastPlay?.advancementEvents ?? []) {
        const counter = counters[event.kind] ??= blankCounter();
        counter.opportunities += 1;
        if (event.attempted) counter.attempts += 1;
        if (event.success) counter.successes += 1;
        if (event.out) {
          counter.outs += 1;
          if (!["GROUND_BALL_DOUBLE_PLAY"].includes(event.kind)) baserunningOuts += 1;
        }
      }
    }
  }

  return {
    label,
    games: scenarioGames,
    speed,
    baserunning,
    arm,
    runsPerTeamGame: totalRuns / (scenarioGames * 2),
    plateAppearancesPerGame: totalPA / scenarioGames,
    baserunningOutsPerTeamGame: baserunningOuts / (scenarioGames * 2),
    events: Object.fromEntries(Object.entries(counters).map(([kind, c]) => [kind, finalizeCounter(c)]))
  };
}

const neutral = runScenario({ label: "phase1-br-neutral-v6", games, speed: 50, baserunning: 50, arm: 50 });
const stressGames = Math.max(250, Math.round(games / 4));
const smartFast = runScenario({ label: "phase1-br-fast-smart-v6", games: stressGames, speed: 80, baserunning: 80, arm: 50 });
const slowPoor = runScenario({ label: "phase1-br-slow-poor-v6", games: stressGames, speed: 30, baserunning: 30, arm: 50 });
const strongArm = runScenario({ label: "phase1-br-strong-arm-v6", games: stressGames, speed: 50, baserunning: 50, arm: 80 });
const weakArm = runScenario({ label: "phase1-br-weak-arm-v6", games: stressGames, speed: 50, baserunning: 50, arm: 30 });

const key = {
  FIRST_THIRD_SINGLE: targets.firstThirdSingle,
  FIRST_HOME_DOUBLE: targets.firstHomeDouble,
  SECOND_HOME_SINGLE: targets.secondHomeSingle
};
const neutralKey = Object.fromEntries(Object.entries(key).map(([kind, target]) => {
  const actual = neutral.events[kind]?.successPerOpportunity ?? 0;
  return [kind, { target, actual, error: actual - target }];
}));
const combinedKinds = Object.keys(key);
const combined = combinedKinds.reduce((acc, kind) => {
  const e = neutral.events[kind] ?? blankCounter();
  acc.opportunities += e.opportunities ?? 0;
  acc.successes += e.successes ?? 0;
  acc.outs += e.outs ?? 0;
  return acc;
}, { opportunities: 0, successes: 0, outs: 0 });
combined.successPerOpportunity = combined.successes / combined.opportunities;
combined.outPerOpportunity = combined.outs / combined.opportunities;

const neutralMaxError = Math.max(...Object.values(neutralKey).map((x) => Math.abs(x.error)));
const neutralAdvance = neutral.events.SECOND_HOME_SINGLE;
const strongAdvance = strongArm.events.SECOND_HOME_SINGLE;
const weakAdvance = weakArm.events.SECOND_HOME_SINGLE;
const smartAdvance = smartFast.events.SECOND_HOME_SINGLE;
const slowAdvance = slowPoor.events.SECOND_HOME_SINGLE;

const acceptance = {
  keyAdvancementRatesNear2025: neutralMaxError <= 0.055,
  combinedXbtNear2025: Math.abs(combined.successPerOpportunity - targets.combinedExtraBaseSuccess) <= 0.040,
  combinedOutRatePlausible: Math.abs(combined.outPerOpportunity - targets.combinedOutOnAdvance) <= 0.012,
  runEnvironmentNotCollapsed: neutral.runsPerTeamGame >= 3.85 && neutral.runsPerTeamGame <= 4.65,
  fasterSmarterRunnerExecutesBetter: smartAdvance.successIfAttempted > slowAdvance.successIfAttempted,
  strongArmDetersAttempts: strongAdvance.attemptRate < weakAdvance.attemptRate,
  strongArmReducesSuccess: strongAdvance.successIfAttempted < weakAdvance.successIfAttempted,
  neutralHasRealBaserunningOuts: neutral.baserunningOutsPerTeamGame > 0.04 && neutral.baserunningOutsPerTeamGame < 0.35
};

const report = {
  schemaVersion: 1,
  id: "phase1-detailed-baserunning-v6",
  targets,
  neutral,
  neutralKey,
  combinedKeyAdvancement: combined,
  stress: { smartFast, slowPoor, strongArm, weakArm },
  acceptance,
  pass: Object.values(acceptance).every(Boolean),
  limitations: [
    "Steal/CS/pickoff is intentionally deferred to the next Phase 1 baserunning step.",
    "Exact OF catch momentum, cutoff/relay throws, and per-play throw coordinates are not yet modeled.",
    "ROE/WP/PB/Balk remain absent, so run-environment acceptance is intentionally wider than final league calibration."
  ]
};

const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
else console.log(json);
if (verify && !report.pass) process.exitCode = 1;
