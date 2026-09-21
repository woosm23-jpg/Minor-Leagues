import { SeededRng } from "../engine/rng.js";
import { simulateGame } from "../engine/game/gameEngine.js";
import { simulateFastPA } from "../engine/pa/fastPAEngine.js";
import { simulatePA } from "../engine/pa/paEngine.js";
import { createPlayerContextResolver } from "../engine/player/playerContextResolver.js";
import { createPitcherUsageManager } from "../engine/game/pitcherUsageAI.js";
import { createLateGameBenchManager } from "../engine/game/benchUsageAI.js";

const SEASON_SIM_MODES = Object.freeze(["AUTO", "DETAILED", "FAST"]);

function resolveMode(fixture, requested) {
  if (!SEASON_SIM_MODES.includes(requested)) throw new RangeError(`지원하지 않는 season sim mode입니다: ${requested}`);
  if (requested !== "AUTO") return requested;
  // User-containing games remain Detailed. Pure AI games use the v38 surrogate.
  return fixture.userPlayerId ? "DETAILED" : "FAST";
}

function simulateSeasonFixtureGame(fixture, { seed = fixture.seed, mode = "AUTO" } = {}) {
  const simulationMode = resolveMode(fixture, mode);
  const rng = new SeededRng(seed);
  const resolver = createPlayerContextResolver({
    players: fixture.players,
    resolveApproach: () => "BALANCED"
  });
  const pitcherManager = createPitcherUsageManager({ players: fixture.players, pitchingPlans: fixture.pitchingPlans });
  const benchManager = createLateGameBenchManager({ players: fixture.players, benchPlans: fixture.benchPlans ?? {} });
  const keepUserLog = simulationMode === "DETAILED" && Boolean(fixture.userPlayerId);
  const result = simulateGame({
    initialState: fixture.initialState,
    contextResolver: resolver,
    rng,
    pitcherManager,
    benchManager,
    runnerProfileResolver: resolver.runnerProfileResolver,
    runningGameResolver: resolver.runningGameResolver,
    paSimulator: simulationMode === "FAST" ? simulateFastPA : simulatePA,
    maxPlateAppearances: 500,
    keepLog: keepUserLog
  });
  return Object.freeze({
    gameId: fixture.initialState.gameId,
    simulationMode,
    awayRuns: result.state.score.away,
    homeRuns: result.state.score.home,
    winnerSide: result.state.result.winner,
    boxScore: result.boxScore,
    state: result.state,
    log: keepUserLog ? result.log : Object.freeze([])
  });
}

export { SEASON_SIM_MODES, simulateSeasonFixtureGame };
