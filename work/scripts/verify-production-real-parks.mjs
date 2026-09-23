import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import { gameApi } from "../src/api/gameApi.js";
import { createSeasonGameFixture } from "../src/services/demoSeasonFactory.js";
import {
  createSeasonGameContextResolver,
  simulateSeasonFixtureGame
} from "../src/services/seasonGameService.js";
import {
  getCurrentBatterId,
  getCurrentPitcherId
} from "../src/engine/game/gameState.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");
const SNAPSHOT_REL =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function loadSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.resolve(WORK_ROOT, SNAPSHOT_REL))).toString("utf8")
  );
}

function careerInput(organizationId) {
  return {
    name: "Real Park QA",
    nationality: "대한민국",
    hometown: "구미",
    age: 18,
    heightCm: 180,
    weightKg: 78,
    bodyType: "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition: "SS",
    archetype: "BALANCED",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE",
    favoriteOrganizationId: String(organizationId)
  };
}

function wallDistances(park) {
  return park.wallProfile.map((row) => Number(row.distanceFt));
}

function sourceForGame(sourceParks, game) {
  return (
    sourceParks.find(
      (park) =>
        game.venueId != null &&
        String(park.venueId) === String(game.venueId)
    ) ??
    sourceParks.find(
      (park) => String(park.teamId) === String(game.homeTeamId)
    ) ??
    null
  );
}

function outputPath() {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith("--output="));
  return path.resolve(
    WORK_ROOT,
    hit ? hit.slice("--output=".length) : "reports/production-real-parks-v1.json"
  );
}

function buildReport() {
  const snapshot = loadSnapshot();
  const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
  const created = seasonApi.createCareerSeason({
    seed: "post-audit-real-parks-v1",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL");
  assert.equal(payload.fixture.parks.length, 30);

  const mlb = payload.fixture.levelLeagues.MLB;
  const sourceParks = payload.fixture.parks;
  const games = mlb.schedule.filter((game) => sourceForGame(sourceParks, game));
  assert.ok(games.length > 0);

  const firstGame = games[0];
  const firstSource = sourceForGame(sourceParks, firstGame);
  const firstFixture = createSeasonGameFixture({
    seasonFixture: payload.fixture,
    scheduleGame: firstGame,
    level: "MLB"
  });

  assert.ok(firstSource);
  assert.ok(firstFixture.park);
  assert.equal(firstFixture.park.source, "PRODUCTION_SNAPSHOT");
  assert.notEqual(firstFixture.park.id, "NEUTRAL");
  assert.equal(firstFixture.park.wallProfile.length, 5);
  assert.deepEqual(wallDistances(firstFixture.park), [
    Number(firstSource.geometry.lfLine),
    Number(firstSource.geometry.lfGap),
    Number(firstSource.geometry.cf),
    Number(firstSource.geometry.rfGap),
    Number(firstSource.geometry.rfLine)
  ]);

  const resolver = createSeasonGameContextResolver(firstFixture);
  const context = resolver({
    state: firstFixture.initialState,
    batterId: getCurrentBatterId(firstFixture.initialState),
    pitcherId: getCurrentPitcherId(firstFixture.initialState)
  });
  assert.equal(context.park.id, firstFixture.park.id);

  assert.equal(
    simulateSeasonFixtureGame(firstFixture, { seed: "real-park-fast", mode: "FAST" }).state.status,
    "FINAL"
  );
  assert.equal(
    simulateSeasonFixtureGame(firstFixture, { seed: "real-park-detailed", mode: "DETAILED" }).state.status,
    "FINAL"
  );

  const probeFixture = Object.freeze({
    ...firstFixture,
    userPlayerId: firstFixture.initialState.lineups.away[0],
    userTeam: "away"
  });

  let interactiveParkId = null;
  for (let attempt = 0; attempt < 40 && interactiveParkId == null; attempt += 1) {
    const view = gameApi.createGameFromFixture({
      fixture: probeFixture,
      seed: `real-park-interactive-${attempt}`
    });
    const played = gameApi.playUserPA(view.gameId, "BALANCED");
    const wall = played.lastUserPA?.paResult?.battedBallResult?.wallClearance ?? null;
    if (wall) interactiveParkId = wall.parkId;
    gameApi.closeGame(view.gameId);
  }
  assert.equal(interactiveParkId, firstFixture.park.id);

  const firstDistances = JSON.stringify(wallDistances(firstFixture.park));
  const secondGame = games.find((game) => {
    if (String(game.homeTeamId) === String(firstGame.homeTeamId)) return false;
    const source = sourceForGame(sourceParks, game);
    if (!source) return false;
    return JSON.stringify([
      Number(source.geometry.lfLine),
      Number(source.geometry.lfGap),
      Number(source.geometry.cf),
      Number(source.geometry.rfGap),
      Number(source.geometry.rfLine)
    ]) !== firstDistances;
  });
  assert.ok(secondGame);

  const secondFixture = createSeasonGameFixture({
    seasonFixture: payload.fixture,
    scheduleGame: secondGame,
    level: "MLB"
  });
  assert.ok(secondFixture.park);
  assert.notDeepEqual(
    wallDistances(secondFixture.park),
    wallDistances(firstFixture.park)
  );

  const aaaFixture = createSeasonGameFixture({
    seasonFixture: payload.fixture,
    scheduleGame: payload.fixture.levelLeagues.AAA.schedule[0],
    level: "AAA"
  });
  assert.equal(aaaFixture.park, null);

  return {
    schema: "THE_CALL_UP_PRODUCTION_REAL_PARKS_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    parkSourceRows: sourceParks.length,
    firstPark: {
      id: firstFixture.park.id,
      name: firstFixture.park.name,
      venueId: firstFixture.park.sourceVenueId,
      carryFactor: firstFixture.park.carryFactor,
      wallDistancesFt: wallDistances(firstFixture.park)
    },
    secondPark: {
      id: secondFixture.park.id,
      name: secondFixture.park.name,
      venueId: secondFixture.park.sourceVenueId,
      carryFactor: secondFixture.park.carryFactor,
      wallDistancesFt: wallDistances(secondFixture.park)
    },
    runtime: {
      detailedGame: true,
      fastGame: true,
      interactivePA: true,
      interactiveParkId,
      nonMlbNeutralFallback: true
    }
  };
}

function main() {
  const report = buildReport();
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { buildReport };
