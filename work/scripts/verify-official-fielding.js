import fs from "node:fs";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import { createPitcherUsageManager } from "../src/engine/game/pitcherUsageAI.js";
import { sumBattingTeam, sumPitchingTeam, sumFieldingTeam } from "../src/engine/game/boxScore.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const games = Number(arg("--games", "1200"));
const output = arg("--output", null);
const verify = process.argv.includes("--verify");
if (!Number.isInteger(games) || games <= 0) throw new RangeError("--games는 양의 정수여야 합니다.");

const targets = Object.freeze({
  source: "2025 MLB Baseball-Reference league fielding totals (AL + NL)",
  teamGames: 4860,
  errors: 1265 + 1186,
  putouts: 64693 + 64532,
  assists: 20202 + 20786,
  errorsPerTeamGame: (1265 + 1186) / 4860,
  putoutsPerTeamGame: (64693 + 64532) / 4860,
  assistsPerTeamGame: (20202 + 20786) / 4860,
  fieldingPercentage: (64693 + 64532 + 20202 + 20786) / (64693 + 64532 + 20202 + 20786 + 1265 + 1186),
  runsPerTeamGame: 4.45
});

function alignment(prefix) {
  return { C: `${prefix}1`, "1B": `${prefix}2`, "2B": `${prefix}3`, "3B": `${prefix}4`, SS: `${prefix}5`, LF: `${prefix}6`, CF: `${prefix}7`, RF: `${prefix}8` };
}

function buildWorld(defenseRating = 50) {
  const players = {};
  const away = [];
  const home = [];
  for (let i = 1; i <= 9; i += 1) {
    for (const prefix of ["A", "H"]) {
      const id = `${prefix}${i}`;
      players[id] = createPhase1Hitter({
        id,
        reaction: defenseRating,
        fielding: defenseRating,
        armStrength: defenseRating,
        armAccuracy: defenseRating,
        speed: 50,
        stealing: 50,
        baserunning: 50
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
  return { players, away, home, pitchingPlans };
}

function runScenario(label, defenseRating, scenarioGames) {
  let runs = 0;
  let pa = 0;
  let H = 0, AB = 0, SO = 0, HR = 0, SF = 0, ROE = 0;
  let PO = 0, A = 0, E = 0, DP = 0;
  let pitchingOuts = 0;
  let poReconcileFailures = 0;
  let errorReconcileFailures = 0;

  for (let g = 0; g < scenarioGames; g += 1) {
    const world = buildWorld(defenseRating);
    const resolver = createPlayerContextResolver({ players: world.players });
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
      contextResolver: resolver,
      pitcherManager: createPitcherUsageManager({ players: world.players, pitchingPlans: world.pitchingPlans }),
      rng: new SeededRng(`${label}-${g}`)
    });

    runs += result.state.score.away + result.state.score.home;
    pa += result.plateAppearances;
    for (const team of ["away", "home"]) {
      const bat = sumBattingTeam(result.boxScore.teams[team]);
      const pit = sumPitchingTeam(result.boxScore.teams[team]);
      const fld = sumFieldingTeam(result.boxScore.teams[team]);
      H += bat.H; AB += bat.AB; SO += bat.SO; HR += bat.HR; SF += bat.SF; ROE += bat.ROE;
      PO += fld.PO; A += fld.A; E += fld.E; DP += fld.DP;
      pitchingOuts += pit.outsRecorded;
      if (fld.PO !== pit.outsRecorded) poReconcileFailures += 1;
    }
    const totalE = sumFieldingTeam(result.boxScore.teams.away).E + sumFieldingTeam(result.boxScore.teams.home).E;
    const totalROE = sumBattingTeam(result.boxScore.teams.away).ROE + sumBattingTeam(result.boxScore.teams.home).ROE;
    if (totalE !== totalROE) errorReconcileFailures += 1;
  }

  const teamGames = scenarioGames * 2;
  const chances = PO + A + E;
  return {
    label,
    defenseRating,
    games: scenarioGames,
    runsPerTeamGame: runs / teamGames,
    plateAppearancesPerGame: pa / scenarioGames,
    AVG: H / AB,
    BABIP: (H - HR) / (AB - SO - HR + SF),
    ROE,
    errorsPerTeamGame: E / teamGames,
    putoutsPerTeamGame: PO / teamGames,
    assistsPerTeamGame: A / teamGames,
    fieldingPercentage: chances > 0 ? (PO + A) / chances : 0,
    playerDoublePlayCreditsPerTeamGame: DP / teamGames,
    poReconcileFailures,
    errorReconcileFailures,
    totalPutouts: PO,
    totalPitchingOuts: pitchingOuts
  };
}

const neutral = runScenario("phase1-official-fielding-neutral-v8", 50, games);
const stressGames = Math.max(200, Math.round(games / 4));
const poor = runScenario("phase1-official-fielding-poor-v8", 30, stressGames);
const elite = runScenario("phase1-official-fielding-elite-v8", 80, stressGames);

const acceptance = {
  errorsNear2025: Math.abs(neutral.errorsPerTeamGame - targets.errorsPerTeamGame) <= 0.08,
  putoutsNear2025: Math.abs(neutral.putoutsPerTeamGame - targets.putoutsPerTeamGame) <= 0.45,
  assistsPlausible: Math.abs(neutral.assistsPerTeamGame - targets.assistsPerTeamGame) <= 1.10,
  fieldingPercentagePlausible: Math.abs(neutral.fieldingPercentage - targets.fieldingPercentage) <= 0.0035,
  allOutsHavePutout: neutral.poReconcileFailures === 0 && neutral.totalPutouts === neutral.totalPitchingOuts,
  errorsReconcileWithROE: neutral.errorReconcileFailures === 0,
  betterFieldersMakeFewerErrors: poor.errorsPerTeamGame > neutral.errorsPerTeamGame && neutral.errorsPerTeamGame > elite.errorsPerTeamGame,
  runEnvironmentPlausible: neutral.runsPerTeamGame >= 4.05 && neutral.runsPerTeamGame <= 4.70,
  avgPlausible: neutral.AVG >= 0.238 && neutral.AVG <= 0.252
};

const report = {
  schemaVersion: 1,
  id: "phase1-official-fielding-v8",
  targets,
  neutral,
  stress: { poor, elite },
  acceptance,
  pass: Object.values(acceptance).every(Boolean),
  limitations: [
    "Phase 1 ROE assigns one error to the primary responsible fielder; multiple-error plays are deferred.",
    "Earned runs are not yet reconstructed; pitcher R is tracked but ER waits for inning-without-errors scoring logic.",
    "Fielding assists use compact receiver rules rather than exact relay/cutoff chains.",
    "RBI-on-error scorer judgment and extra bases on throwing errors are deferred."
  ]
};

const json = JSON.stringify(report, null, 2);
if (output) fs.writeFileSync(output, `${json}\n`);
else console.log(json);
if (verify && !report.pass) process.exitCode = 1;
