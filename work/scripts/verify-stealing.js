import fs from "node:fs";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import { createPitcherUsageManager } from "../src/engine/game/pitcherUsageAI.js";
import { sumBattingTeam } from "../src/engine/game/boxScore.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const games = Number(arg("--games", "1200"));
const output = arg("--output", null);
const verify = process.argv.includes("--verify");
if (!Number.isInteger(games) || games <= 0) throw new RangeError("--games는 양의 정수여야 합니다.");

const targets = Object.freeze({
  source: "2025 MLB regular-season league totals (NL 1,727 SB/503 CS + AL 1,713 SB/486 CS)",
  stolenBases: 3440,
  caughtStealing: 989,
  attempts: 4429,
  teamGames: 4860,
  attemptsPerTeamGame: 4429 / 4860,
  sbPerTeamGame: 3440 / 4860,
  csPerTeamGame: 989 / 4860,
  successRate: 3440 / 4429
});

function alignment(prefix) {
  return { C: `${prefix}1`, "1B": `${prefix}2`, "2B": `${prefix}3`, "3B": `${prefix}4`, SS: `${prefix}5`, LF: `${prefix}6`, CF: `${prefix}7`, RF: `${prefix}8` };
}

function buildWorld({ speed = 50, stealing = 50, baserunning = 50, catcher = 50, holdRunner = 50 } = {}) {
  const players = {};
  const away = [];
  const home = [];
  for (let i = 1; i <= 9; i += 1) {
    for (const prefix of ["A", "H"]) {
      const id = `${prefix}${i}`;
      const isCatcher = i === 1;
      players[id] = createPhase1Hitter({
        id,
        speed,
        stealing,
        baserunning,
        reaction: isCatcher ? catcher : 50,
        armStrength: isCatcher ? catcher : 50,
        armAccuracy: isCatcher ? catcher : 50
      });
    }
    away.push(`A${i}`);
    home.push(`H${i}`);
  }

  const pitchingPlans = {};
  for (const [team, prefix] of [["away", "A"], ["home", "H"]]) {
    const starterId = `${prefix}SP`;
    players[starterId] = createPhase1Pitcher({ id: starterId, role: "SP", stamina: 50, pitchVelocityMph: 94, holdRunner });
    const bullpenIds = [];
    for (let i = 1; i <= 9; i += 1) {
      const id = `${prefix}RP${i}`;
      bullpenIds.push(id);
      players[id] = createPhase1Pitcher({ id, role: "RP", stamina: 50, pitchVelocityMph: 94, holdRunner });
    }
    pitchingPlans[team] = { starterId, bullpenIds };
  }
  return { players, away, home, pitchingPlans };
}

function runScenario({ label, games: scenarioGames, ...ratings }) {
  let sb = 0;
  let cs = 0;
  let pickoff = 0;
  let stealSecond = 0;
  let stealThird = 0;
  let runs = 0;
  let pa = 0;
  let boxSB = 0;
  let boxCS = 0;
  let boxPKO = 0;

  for (let g = 0; g < scenarioGames; g += 1) {
    const world = buildWorld(ratings);
    const contextResolver = createPlayerContextResolver({ players: world.players });
    const result = simulateGame({
      initialState: createGameState({
        gameId: `${label}-${g}`,
        awayLineup: world.away,
        homeLineup: world.home,
        awayPitcherId: world.pitchingPlans.away.starterId,
        homePitcherId: world.pitchingPlans.home.starterId,
        awayDefense: alignment("A"),
        homeDefense: alignment("H")
      }),
      contextResolver,
      pitcherManager: createPitcherUsageManager({ players: world.players, pitchingPlans: world.pitchingPlans }),
      rng: new SeededRng(`${label}-${g}`)
    });

    runs += result.state.score.away + result.state.score.home;
    pa += result.plateAppearances;
    for (const event of result.runningEvents) {
      if (event.kind === "SB") {
        sb += 1;
        if (event.targetBase === 2) stealSecond += 1;
        if (event.targetBase === 3) stealThird += 1;
      } else if (event.kind === "CS") cs += 1;
      else if (event.kind === "PICKOFF") pickoff += 1;
    }
    const a = sumBattingTeam(result.boxScore.teams.away);
    const h = sumBattingTeam(result.boxScore.teams.home);
    boxSB += a.SB + h.SB;
    boxCS += a.CS + h.CS;
    boxPKO += a.PKO + h.PKO;
  }

  const attempts = sb + cs;
  const teamGames = scenarioGames * 2;
  return {
    label,
    games: scenarioGames,
    ...ratings,
    SB: sb,
    CS: cs,
    pickoffs: pickoff,
    attempts,
    successRate: attempts ? sb / attempts : 0,
    attemptsPerTeamGame: attempts / teamGames,
    sbPerTeamGame: sb / teamGames,
    csPerTeamGame: cs / teamGames,
    pickoffsPerTeamGame: pickoff / teamGames,
    stealsOfSecond: stealSecond,
    stealsOfThird: stealThird,
    runsPerTeamGame: runs / teamGames,
    plateAppearancesPerGame: pa / scenarioGames,
    boxScoreReconciles: boxSB === sb && boxCS === cs && boxPKO === pickoff
  };
}

const neutral = runScenario({ label: "phase1-steal-neutral-v7", games, speed: 50, stealing: 50, baserunning: 50, catcher: 50, holdRunner: 50 });
const stressGames = Math.max(250, Math.round(games / 4));
const eliteRunner = runScenario({ label: "phase1-steal-elite-runner-v7", games: stressGames, speed: 80, stealing: 80, baserunning: 75, catcher: 50, holdRunner: 50 });
const weakRunner = runScenario({ label: "phase1-steal-weak-runner-v7", games: stressGames, speed: 30, stealing: 30, baserunning: 35, catcher: 50, holdRunner: 50 });
const strongBattery = runScenario({ label: "phase1-steal-strong-battery-v7", games: stressGames, speed: 50, stealing: 50, baserunning: 50, catcher: 80, holdRunner: 80 });
const weakBattery = runScenario({ label: "phase1-steal-weak-battery-v7", games: stressGames, speed: 50, stealing: 50, baserunning: 50, catcher: 30, holdRunner: 30 });

const acceptance = {
  attemptsNear2025: Math.abs(neutral.attemptsPerTeamGame - targets.attemptsPerTeamGame) <= 0.12,
  successNear2025: Math.abs(neutral.successRate - targets.successRate) <= 0.035,
  sbNear2025: Math.abs(neutral.sbPerTeamGame - targets.sbPerTeamGame) <= 0.10,
  csNear2025: Math.abs(neutral.csPerTeamGame - targets.csPerTeamGame) <= 0.05,
  pickoffsRemainRare: neutral.pickoffsPerTeamGame >= 0.005 && neutral.pickoffsPerTeamGame <= 0.08,
  eliteRunnerAttemptsMore: eliteRunner.attemptsPerTeamGame > weakRunner.attemptsPerTeamGame,
  eliteRunnerSucceedsMore: eliteRunner.successRate > weakRunner.successRate,
  strongBatteryDetersAttempts: strongBattery.attemptsPerTeamGame < weakBattery.attemptsPerTeamGame,
  strongBatteryReducesSuccess: strongBattery.successRate < weakBattery.successRate,
  strongHoldCreatesMorePickoffs: strongBattery.pickoffsPerTeamGame > weakBattery.pickoffsPerTeamGame,
  boxScoreReconciles: neutral.boxScoreReconciles && eliteRunner.boxScoreReconciles && weakRunner.boxScoreReconciles,
  runEnvironmentPlausible: neutral.runsPerTeamGame >= 3.80 && neutral.runsPerTeamGame <= 4.65
};

const report = {
  schemaVersion: 1,
  id: "phase1-stealing-v7",
  targets,
  neutral,
  stress: { eliteRunner, weakRunner, strongBattery, weakBattery },
  acceptance,
  pass: Object.values(acceptance).every(Boolean),
  limitations: [
    "Phase 1 models steals of 2B and clean steals of 3B; double steals and steal of home are deferred.",
    "Pickoff-out probability is a rare-event sanity model; exact disengagement/pickoff-attempt counts are not yet calibrated.",
    "Catcher pop time/exchange is approximated by Reaction + Arm Strength + Arm Accuracy.",
    "Pitcher Hold Runner is a new secondary rating and does not alter pitcher Stuff/Control/Command."
  ]
};

const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
else console.log(json);
if (verify && !report.pass) process.exitCode = 1;
