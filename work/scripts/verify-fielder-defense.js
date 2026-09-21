import fs from "node:fs";
import { SeededRng } from "../src/engine/rng.js";
import { buildPAContext } from "../src/engine/pa/context.js";
import { simulatePA } from "../src/engine/pa/paEngine.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import { createPitcherUsageManager } from "../src/engine/game/pitcherUsageAI.js";
import { sumBattingTeam } from "../src/engine/game/boxScore.js";
import { calibrationConfig } from "../src/config/calibration.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const neutralGames = Number(arg("--neutral-games", "1000"));
const stressGames = Number(arg("--stress-games", "300"));
const output = arg("--output", null);
const verify = process.argv.includes("--verify");
if (!Number.isInteger(neutralGames) || neutralGames <= 0) throw new RangeError("--neutral-games는 양의 정수여야 합니다.");
if (!Number.isInteger(stressGames) || stressGames <= 0) throw new RangeError("--stress-games는 양의 정수여야 합니다.");

const POSITIONS = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];

function directDefensePackage(rating = 50) {
  return {
    mode: "FIELDERS",
    fielders: Object.fromEntries(POSITIONS.map((position) => [position, {
      id: `N_${position}`,
      position,
      reaction: rating,
      speed: rating,
      fielding: rating,
      armStrength: rating,
      armAccuracy: rating,
      familiarity: 1
    }]))
  };
}

function directContext(rating = 50) {
  return buildPAContext({
    hitter: {
      bats: "R", contactR: 50, contactL: 50, rawPower: 50, vision: 50, discipline: 50,
      speed: 50, powerUtilizationR: 50, powerUtilizationL: 50, launchTendency: 50,
      sprayPull: 50, sprayCenter: 50, sprayOppo: 50
    },
    pitcher: { throws: "R", control: 50, command: 50, movement: 50, pitchability: 50, stuff: 50 },
    defense: directDefensePackage(rating)
  });
}

function runDirectNeutralPA(samples = 100_000) {
  const rng = new SeededRng("phase1-fielder-defense-v5-direct");
  const ctx = directContext(50);
  const counts = { OUT: 0, ROE: 0, "1B": 0, "2B": 0, "3B": 0, HR: 0 };
  const opportunities = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  const failures = { REACH: 0, FIELD: 0, THROW_RACE: 0, ERROR_FIELD: 0, ERROR_THROW: 0 };
  let bbe = 0;

  for (let i = 0; i < samples; i += 1) {
    const result = simulatePA(ctx, rng);
    if (result.outcome !== "BIP") continue;
    bbe += 1;
    counts[result.finalOutcome] += 1;
    const d = result.battedBallResult.defense;
    if (d.responsiblePosition) opportunities[d.responsiblePosition] += 1;
    if (d.failureStage) failures[d.failureStage] += 1;
  }

  return {
    plateAppearances: samples,
    battedBalls: bbe,
    finalOutcomeRates: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / bbe])),
    responsibleFielderShare: Object.fromEntries(Object.entries(opportunities).map(([k, v]) => [k, v / bbe])),
    defensiveFailureShare: Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v / bbe]))
  };
}

function makeAlignment(prefix) {
  return { C: `${prefix}1`, "1B": `${prefix}2`, "2B": `${prefix}3`, "3B": `${prefix}4`, SS: `${prefix}5`, LF: `${prefix}6`, CF: `${prefix}7`, RF: `${prefix}8` };
}

function buildWorld(defenseRating) {
  const players = {};
  const away = [];
  const home = [];
  for (let i = 1; i <= 9; i += 1) {
    for (const prefix of ["A", "H"]) {
      const id = `${prefix}${i}`;
      players[id] = createPhase1Hitter({
        id,
        reaction: defenseRating,
        speed: defenseRating,
        fielding: defenseRating,
        armStrength: defenseRating,
        armAccuracy: defenseRating
      });
    }
    away.push(`A${i}`);
    home.push(`H${i}`);
  }

  const pitchingPlans = {};
  for (const [team, prefix] of [["away", "A"], ["home", "H"]]) {
    const starterId = `${prefix}SP`;
    players[starterId] = createPhase1Pitcher({
      id: starterId,
      role: "SP",
      stamina: 50,
      pitchVelocityMph: 94,
      reaction: defenseRating,
      fielding: defenseRating,
      armStrength: defenseRating,
      armAccuracy: defenseRating
    });
    const bullpenIds = [];
    for (let i = 1; i <= 9; i += 1) {
      const id = `${prefix}RP${i}`;
      bullpenIds.push(id);
      players[id] = createPhase1Pitcher({
        id,
        role: "RP",
        stamina: 50,
        pitchVelocityMph: 94,
        reaction: defenseRating,
        fielding: defenseRating,
        armStrength: defenseRating,
        armAccuracy: defenseRating
      });
    }
    pitchingPlans[team] = { starterId, bullpenIds };
  }

  return {
    players,
    away,
    home,
    pitchingPlans,
    awayDefense: makeAlignment("A"),
    homeDefense: makeAlignment("H")
  };
}

function runGames(defenseRating, games, seedPrefix) {
  let totalRuns = 0;
  let totalPA = 0;
  let H = 0, HR = 0, AB = 0, SO = 0, SF = 0;

  for (let g = 0; g < games; g += 1) {
    const world = buildWorld(defenseRating);
    const result = simulateGame({
      initialState: createGameState({
        gameId: `${seedPrefix}-${g}`,
        awayLineup: world.away,
        homeLineup: world.home,
        awayPitcherId: world.pitchingPlans.away.starterId,
        homePitcherId: world.pitchingPlans.home.starterId,
        awayDefense: world.awayDefense,
        homeDefense: world.homeDefense
      }),
      contextResolver: createPlayerContextResolver({ players: world.players }),
      pitcherManager: createPitcherUsageManager({ players: world.players, pitchingPlans: world.pitchingPlans }),
      rng: new SeededRng(`${seedPrefix}-${g}`)
    });

    totalRuns += result.state.score.away + result.state.score.home;
    totalPA += result.state.plateAppearances;
    for (const team of ["away", "home"]) {
      const batting = sumBattingTeam(result.boxScore.teams[team]);
      H += batting.H;
      HR += batting.HR;
      AB += batting.AB;
      SO += batting.SO;
      SF += batting.SF;
    }
  }

  return {
    defenseRating,
    games,
    runsPerTeamGame: totalRuns / (games * 2),
    plateAppearancesPerGame: totalPA / games,
    AVG: H / AB,
    BABIP: (H - HR) / (AB - SO - HR + SF),
    homeRunsPerTeamGame: HR / (games * 2)
  };
}

const direct = runDirectNeutralPA();
const neutral = runGames(50, neutralGames, "phase1-defense-neutral-v5");
const poor = runGames(30, stressGames, "phase1-defense-poor-v5");
const elite = runGames(80, stressGames, "phase1-defense-elite-v5");

const target = calibrationConfig.neutral.battedBallResult;
const directErrors = {
  OUT_PLUS_ROE: direct.finalOutcomeRates.OUT + direct.finalOutcomeRates.ROE - target.OUT,
  "1B": direct.finalOutcomeRates["1B"] - target["1B"],
  "2B": direct.finalOutcomeRates["2B"] - target["2B"],
  "3B": direct.finalOutcomeRates["3B"] - target["3B"],
  HR: direct.finalOutcomeRates.HR - target.HR
};
const maxDirectAbsError = Math.max(...Object.values(directErrors).map(Math.abs));
const babipStressSpan = poor.BABIP - elite.BABIP;

const acceptance = {
  neutralContactBranchParity: maxDirectAbsError <= 0.009,
  allPositionsReceiveOpportunities: POSITIONS.every((position) => direct.responsibleFielderShare[position] > 0),
  neutralRunsPerTeamGame: Math.abs(neutral.runsPerTeamGame - 4.45) <= 0.22,
  neutralBabipPlausible: neutral.BABIP >= 0.280 && neutral.BABIP <= 0.305,
  defenseMonotonicBabip: poor.BABIP > neutral.BABIP && neutral.BABIP > elite.BABIP,
  defenseMonotonicRuns: poor.runsPerTeamGame > elite.runsPerTeamGame,
  defenseStressNotExplosive: babipStressSpan >= 0.015 && babipStressSpan <= 0.060
};

const report = {
  schemaVersion: 1,
  id: "phase1-fielder-specific-defense-v5",
  directNeutralPA: direct,
  directTarget: target,
  directErrors,
  maxDirectAbsError,
  gameScenarios: { poor, neutral, elite },
  babipStressSpan,
  limitations: [
    "Exact fielder starting coordinates/wall routes are deferred; Phase 1 uses compact angle/depth assignment.",
    "Official ROE/error attribution is now separated; OAA-like opportunity value remains deferred.",
    "Outfield throws currently feed opportunity metadata; runner advancement vs OF Arm is implemented in the detailed baserunning step."
  ],
  acceptance,
  pass: Object.values(acceptance).every(Boolean)
};

const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
else console.log(json);
if (verify && !report.pass) process.exitCode = 1;
