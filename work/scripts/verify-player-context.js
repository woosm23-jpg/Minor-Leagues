import fs from "node:fs";
import path from "node:path";
import { SeededRng } from "../src/engine/rng.js";
import { createGameState } from "../src/engine/game/gameState.js";
import { simulateGame } from "../src/engine/game/gameEngine.js";
import { deriveBattingRates } from "../src/engine/game/boxScore.js";
import { createPlayerContextResolver } from "../src/engine/player/playerContextResolver.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";

function parseArgs(argv) {
  const args = { hitterGames: 1200, pitcherGames: 800, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--hitter-games") args.hitterGames = Number(argv[++i]);
    else if (argv[i] === "--pitcher-games") args.pitcherGames = Number(argv[++i]);
    else if (argv[i] === "--output") args.output = argv[++i];
  }
  for (const key of ["hitterGames", "pitcherGames"]) {
    if (!Number.isInteger(args[key]) || args[key] <= 0) throw new RangeError(`${key}는 양의 정수여야 합니다.`);
  }
  return args;
}

const PROFILE_DEFS = Object.freeze([
  ["CONTACT", { contactR: 80, contactL: 80, rawPower: 42, vision: 72, discipline: 50, powerUtilizationR: 48, powerUtilizationL: 48 }],
  ["POWER", { contactR: 52, contactL: 52, rawPower: 85, vision: 44, discipline: 48, powerUtilizationR: 78, powerUtilizationL: 78, launchTendency: 68 }],
  ["DISCIPLINE", { contactR: 50, contactL: 50, rawPower: 48, vision: 52, discipline: 85 }],
  ["VISION", { contactR: 54, contactL: 54, rawPower: 45, vision: 85, discipline: 50 }],
  ["BALANCED_PLUS", { contactR: 65, contactL: 65, rawPower: 65, vision: 65, discipline: 65, powerUtilizationR: 65, powerUtilizationL: 65 }],
  ["PULL_POWER", { contactR: 50, contactL: 50, rawPower: 75, vision: 48, discipline: 45, powerUtilizationR: 70, powerUtilizationL: 70, launchTendency: 65, sprayPull: 80, sprayCenter: 40, sprayOppo: 35 }],
  ["PLATOON", { bats: "S", contactR: 78, contactL: 32, rawPower: 55, vision: 50, discipline: 50, powerUtilizationR: 75, powerUtilizationL: 35 }],
  ["BALANCED", {}],
  ["LOW_BAT", { contactR: 30, contactL: 30, rawPower: 30, vision: 30, discipline: 30, powerUtilizationR: 30, powerUtilizationL: 30 }]
]);

function zeroLine() {
  return { PA: 0, AB: 0, R: 0, H: 0, doubles: 0, triples: 0, HR: 0, RBI: 0, BB: 0, HBP: 0, SO: 0, SF: 0, GDP: 0, TB: 0 };
}
function addLine(target, line) {
  for (const key of Object.keys(target)) target[key] += line[key] ?? 0;
}
function lineSummary(line) {
  const rates = deriveBattingRates(line);
  return {
    ...line,
    AVG: rates.AVG,
    OBP: rates.OBP,
    SLG: rates.SLG,
    OPS: rates.OPS,
    BBRate: line.PA ? line.BB / line.PA : 0,
    KRate: line.PA ? line.SO / line.PA : 0,
    HRRate: line.PA ? line.HR / line.PA : 0
  };
}

function buildHitterWorld() {
  const players = {};
  const awayLineup = [];
  const homeLineup = [];
  const slotToProfile = {};
  PROFILE_DEFS.forEach(([profile, overrides], index) => {
    const awayId = `A_${profile}`;
    const homeId = `H_${profile}`;
    players[awayId] = createPhase1Hitter({ id: awayId, ...overrides });
    players[homeId] = createPhase1Hitter({ id: homeId, ...overrides });
    awayLineup.push(awayId);
    homeLineup.push(homeId);
    slotToProfile[index] = profile;
  });
  players.AP = createPhase1Pitcher({ id: "AP", throws: "R" });
  players.HP = createPhase1Pitcher({ id: "HP", throws: "R" });
  return { players, awayLineup, homeLineup, slotToProfile };
}

function runHitterDifferentiation(games) {
  const world = buildHitterWorld();
  const resolver = createPlayerContextResolver({ players: world.players });
  const aggregates = Object.fromEntries(PROFILE_DEFS.map(([profile]) => [profile, zeroLine()]));

  for (let i = 0; i < games; i += 1) {
    const initialState = createGameState({
      gameId: `player_hitter_${i}`,
      awayLineup: world.awayLineup,
      homeLineup: world.homeLineup,
      awayPitcherId: "AP",
      homePitcherId: "HP"
    });
    const result = simulateGame({
      initialState,
      contextResolver: resolver,
      rng: new SeededRng(`player-hitter-${i}`)
    });
    for (const team of ["away", "home"]) {
      result.boxScore.teams[team].battingOrder.forEach((playerId, slot) => {
        addLine(aggregates[world.slotToProfile[slot]], result.boxScore.teams[team].batting[playerId]);
      });
    }
  }

  const summaries = Object.fromEntries(Object.entries(aggregates).map(([profile, line]) => [profile, lineSummary(line)]));
  return {
    games,
    totalPA: Object.values(aggregates).reduce((sum, line) => sum + line.PA, 0),
    profiles: summaries,
    checks: [
      { name: "CONTACT AVG > LOW_BAT AVG", pass: summaries.CONTACT.AVG > summaries.LOW_BAT.AVG + 0.05, observed: [summaries.CONTACT.AVG, summaries.LOW_BAT.AVG] },
      { name: "VISION K% < LOW_BAT K%", pass: summaries.VISION.KRate < summaries.LOW_BAT.KRate - 0.08, observed: [summaries.VISION.KRate, summaries.LOW_BAT.KRate] },
      { name: "DISCIPLINE BB% > LOW_BAT BB%", pass: summaries.DISCIPLINE.BBRate > summaries.LOW_BAT.BBRate + 0.05, observed: [summaries.DISCIPLINE.BBRate, summaries.LOW_BAT.BBRate] },
      { name: "POWER HR% > LOW_BAT HR%", pass: summaries.POWER.HRRate > summaries.LOW_BAT.HRRate + 0.02, observed: [summaries.POWER.HRRate, summaries.LOW_BAT.HRRate] },
      { name: "BALANCED_PLUS OPS > LOW_BAT OPS", pass: summaries.BALANCED_PLUS.OPS > summaries.LOW_BAT.OPS + 0.20, observed: [summaries.BALANCED_PLUS.OPS, summaries.LOW_BAT.OPS] },
      { name: "1번 profile PA > 9번 profile PA", pass: summaries.CONTACT.PA > summaries.LOW_BAT.PA, observed: [summaries.CONTACT.PA, summaries.LOW_BAT.PA] }
    ]
  };
}

function buildNeutralLineup(prefix, players) {
  const lineup = [];
  for (let i = 1; i <= 9; i += 1) {
    const id = `${prefix}${i}`;
    players[id] = createPhase1Hitter({ id });
    lineup.push(id);
  }
  return lineup;
}

function runPitcherDifferentiation(games) {
  const counters = {
    strong: { BF: 0, H: 0, HR: 0, BB: 0, SO: 0, R: 0 },
    weak: { BF: 0, H: 0, HR: 0, BB: 0, SO: 0, R: 0 }
  };
  const players = {};
  const awayLineup = buildNeutralLineup("A", players);
  const homeLineup = buildNeutralLineup("H", players);
  players.STRONG = createPhase1Pitcher({ id: "STRONG", control: 75, command: 72, movement: 75, pitchability: 70, stuff: 78, pitchVelocityMph: 96 });
  players.WEAK = createPhase1Pitcher({ id: "WEAK", control: 32, command: 35, movement: 32, pitchability: 38, stuff: 30, pitchVelocityMph: 91 });
  const resolver = createPlayerContextResolver({ players });

  for (let i = 0; i < games; i += 1) {
    // Alternate home/away assignment to avoid home-field and walk-off exposure bias.
    const strongAway = i % 2 === 0;
    const awayPitcherId = strongAway ? "STRONG" : "WEAK";
    const homePitcherId = strongAway ? "WEAK" : "STRONG";
    const result = simulateGame({
      initialState: createGameState({
        gameId: `player_pitcher_${i}`,
        awayLineup,
        homeLineup,
        awayPitcherId,
        homePitcherId
      }),
      contextResolver: resolver,
      rng: new SeededRng(`player-pitcher-${i}`)
    });
    for (const team of ["away", "home"]) {
      for (const [pitcherId, line] of Object.entries(result.boxScore.teams[team].pitching)) {
        const key = pitcherId === "STRONG" ? "strong" : "weak";
        for (const field of Object.keys(counters[key])) counters[key][field] += line[field] ?? 0;
      }
    }
  }
  const summarize = (line) => ({
    ...line,
    KRate: line.BF ? line.SO / line.BF : 0,
    BBRate: line.BF ? line.BB / line.BF : 0,
    HRRate: line.BF ? line.HR / line.BF : 0,
    HRate: line.BF ? line.H / line.BF : 0,
    runsPerGame: line.R / games
  });
  const strong = summarize(counters.strong);
  const weak = summarize(counters.weak);
  return {
    games,
    strong,
    weak,
    checks: [
      { name: "strong K% > weak K%", pass: strong.KRate > weak.KRate + 0.08, observed: [strong.KRate, weak.KRate] },
      { name: "strong BB% < weak BB%", pass: strong.BBRate < weak.BBRate - 0.04, observed: [strong.BBRate, weak.BBRate] },
      { name: "strong H/BF < weak H/BF", pass: strong.HRate < weak.HRate - 0.04, observed: [strong.HRate, weak.HRate] },
      { name: "strong R/G < weak R/G", pass: strong.runsPerGame < weak.runsPerGame - 1.0, observed: [strong.runsPerGame, weak.runsPerGame] }
    ]
  };
}

const args = parseArgs(process.argv.slice(2));
const hitterDifferentiation = runHitterDifferentiation(args.hitterGames);
const pitcherDifferentiation = runPitcherDifferentiation(args.pitcherGames);
const checks = [...hitterDifferentiation.checks, ...pitcherDifferentiation.checks];
const report = {
  schemaVersion: 1,
  id: "phase1-player-context-v3",
  generatedAt: new Date().toISOString(),
  hitterDifferentiation,
  pitcherDifferentiation,
  checks,
  pass: checks.every((check) => check.pass)
};

if (args.output) {
  const target = path.resolve(args.output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
