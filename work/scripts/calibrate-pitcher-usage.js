import fs from "node:fs";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import { createPitcherUsageManager } from "../src/engine/game/pitcherUsageAI.js";
import { pitchingCalibration } from "../src/config/pitchingCalibration.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const games = Number(arg("--games", "2000"));
const output = arg("--output", null);
const verify = process.argv.includes("--verify");
if (!Number.isInteger(games) || games <= 0) throw new RangeError("--games는 양의 정수여야 합니다.");

function alignment(prefix) {
  return { C: `${prefix}1`, "1B": `${prefix}2`, "2B": `${prefix}3`, "3B": `${prefix}4`, SS: `${prefix}5`, LF: `${prefix}6`, CF: `${prefix}7`, RF: `${prefix}8` };
}

function buildWorld() {
  const players = {};
  const away = [];
  const home = [];
  for (let i = 1; i <= 9; i += 1) {
    const aid = `A${i}`;
    const hid = `H${i}`;
    players[aid] = createPhase1Hitter({ id: aid });
    players[hid] = createPhase1Hitter({ id: hid });
    away.push(aid); home.push(hid);
  }
  const plans = {};
  for (const [teamKey, prefix] of [["away", "A"], ["home", "H"]]) {
    const starterId = `${prefix}SP`;
    players[starterId] = createPhase1Pitcher({
      id: starterId, role: "SP", stamina: 50, pitchVelocityMph: 94,
      control: 50, command: 50, movement: 50, pitchability: 50, stuff: 50
    });
    const bullpenIds = [];
    for (let i = 1; i <= 9; i += 1) {
      const id = `${prefix}RP${i}`;
      bullpenIds.push(id);
      players[id] = createPhase1Pitcher({
        id, role: "RP", stamina: 50, pitchVelocityMph: 94,
        control: 50, command: 50, movement: 50, pitchability: 50, stuff: 50
      });
    }
    plans[teamKey] = { starterId, bullpenIds };
  }
  return { players, away, home, plans };
}

let totalPA = 0;
let totalPitches = 0;
let totalRuns = 0;
let totalStarterPitches = 0;
let totalStarterOuts = 0;
let totalPitchersUsed = 0;
let totalRelieverAppearances = 0;
let totalRelieverPitches = 0;
let maxPitchersUsed = 0;
let maxStarterPitches = 0;
let completeGames = 0;

for (let g = 0; g < games; g += 1) {
  const { players, away, home, plans } = buildWorld();
  const result = simulateGame({
    initialState: createGameState({
      gameId: `pitch-cal-${g}`,
      awayLineup: away,
      homeLineup: home,
      awayPitcherId: plans.away.starterId,
      homePitcherId: plans.home.starterId,
      awayDefense: alignment("A"),
      homeDefense: alignment("H")
    }),
    contextResolver: createPlayerContextResolver({ players }),
    pitcherManager: createPitcherUsageManager({ players, pitchingPlans: plans }),
    rng: new SeededRng(`phase1-pitching-v4-${g}`)
  });

  totalPA += result.state.plateAppearances;
  totalRuns += result.state.score.away + result.state.score.home;
  for (const team of ["away", "home"]) {
    const usage = result.state.pitcherUsage[team];
    const used = Object.values(usage);
    totalPitchersUsed += used.length;
    maxPitchersUsed = Math.max(maxPitchersUsed, used.length);
    totalPitches += used.reduce((sum, u) => sum + u.pitchCount, 0);
    const starter = usage[plans[team].starterId];
    totalStarterPitches += starter.pitchCount;
    totalStarterOuts += starter.outsRecorded;
    maxStarterPitches = Math.max(maxStarterPitches, starter.pitchCount);
    if (starter.outsRecorded >= 27) completeGames += 1;
    for (const id of plans[team].bullpenIds) {
      if (!usage[id]) continue;
      totalRelieverAppearances += 1;
      totalRelieverPitches += usage[id].pitchCount;
    }
  }
}

const teamGames = games * 2;
const report = {
  schemaVersion: 1,
  id: "phase1-pitcher-usage-v4",
  sampleGames: games,
  targets: {
    pitchesPerPA: pitchingCalibration.targetPitchesPerPA,
    starterPitchesPerGame: pitchingCalibration.targetStarterPitchesPerGame,
    starterInningsPerGame: pitchingCalibration.targetStarterInningsPerGame,
    pitchersUsedPerTeamGame: pitchingCalibration.targetPitchersUsedPerTeamGame,
    completeGameRate: pitchingCalibration.targetCompleteGameRate
  },
  actual: {
    pitchesPerPA: totalPitches / totalPA,
    runsPerTeamGame: totalRuns / teamGames,
    starterPitchesPerGame: totalStarterPitches / teamGames,
    starterInningsPerGame: totalStarterOuts / 3 / teamGames,
    pitchersUsedPerTeamGame: totalPitchersUsed / teamGames,
    relieversUsedPerTeamGame: totalRelieverAppearances / teamGames,
    relieverPitchesPerAppearance: totalRelieverAppearances ? totalRelieverPitches / totalRelieverAppearances : 0,
    maxPitchersUsed,
    maxStarterPitches,
    completeGameRate: completeGames / teamGames,
    plateAppearancesPerGame: totalPA / games
  }
};

const acceptance = {
  pitchesPerPA: Math.abs(report.actual.pitchesPerPA - report.targets.pitchesPerPA) <= 0.05,
  starterPitchesPerGame: Math.abs(report.actual.starterPitchesPerGame - report.targets.starterPitchesPerGame) <= 3,
  starterInningsPerGame: Math.abs(report.actual.starterInningsPerGame - report.targets.starterInningsPerGame) <= 0.15,
  pitchersUsedPerTeamGame: Math.abs(report.actual.pitchersUsedPerTeamGame - report.targets.pitchersUsedPerTeamGame) <= 0.15,
  completeGameRate: report.actual.completeGameRate >= 0.001 && report.actual.completeGameRate <= 0.015,
  runsPerTeamGame: Math.abs(report.actual.runsPerTeamGame - 4.45) <= 0.20
};
report.acceptance = acceptance;
report.pass = Object.values(acceptance).every(Boolean);

const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
else console.log(json);
if (verify && !report.pass) process.exitCode = 1;
