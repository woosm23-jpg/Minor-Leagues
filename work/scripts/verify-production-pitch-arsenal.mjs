import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import { gameApi } from "../src/api/gameApi.js";
import {
  createSeasonGameFixture
} from "../src/services/demoSeasonFactory.js";
import {
  createSeasonGameContextResolver,
  simulateSeasonFixtureGame
} from "../src/services/seasonGameService.js";
import {
  GENERATED_SOURCE_ID,
  createGeneratedRandomArsenal,
  normalizeInferredPitchArsenal,
  selectPitchFromArsenal
} from "../src/services/productionPitchArsenal.js";
import {
  getCurrentBatterId,
  getCurrentPitcherId
} from "../src/engine/game/gameState.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";
const REAL_SOURCE = "real_world_inference_pitch_arsenal";

function readSnapshot() {
  return JSON.parse(
    zlib
      .gunzipSync(fs.readFileSync(path.resolve(ROOT, SNAP)))
      .toString("utf8")
  );
}

function careerInput(orgId) {
  return {
    name: "Arsenal QA",
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
    favoriteOrganizationId: String(orgId)
  };
}

function rosterPitchers(fixture, level) {
  const byId = new Map();
  for (const roster of Object.values(
    fixture.levelLeagues[level].rosters
  )) {
    for (const id of roster.pitchers ?? []) {
      const player = roster.players[id];
      if (player) byId.set(String(player.id), player);
    }
  }
  return [...byId.values()];
}

function findRuntimeGame(fixture) {
  for (const game of fixture.levelLeagues.MLB.schedule.slice(0, 500)) {
    const gf = createSeasonGameFixture({
      seasonFixture: fixture,
      scheduleGame: game,
      level: "MLB"
    });
    const pitcherId = getCurrentPitcherId(gf.initialState);
    const pitcher = gf.players[pitcherId];
    if (
      pitcher?.pitchArsenal?.some(
        (row) => Number.isFinite(Number(row.velocityMph))
      )
    ) {
      return gf;
    }
  }
  return null;
}

function outputPath() {
  const arg = process.argv.find(
    (value) => value.startsWith("--output=")
  );
  return path.resolve(
    ROOT,
    arg
      ? arg.slice("--output=".length)
      : "reports/production-pitch-arsenal-v1.json"
  );
}

function main() {
  const snapshot = readSnapshot();
  assert.equal(
    snapshot.metadata.contentHash,
    "fnv1a32:f7b34713"
  );
  assert.equal(snapshot.pitchArsenal.length, 12023);

  const mockReal = normalizeInferredPitchArsenal(
    {
      pitchArsenal: [
        {
          type: "FF",
          usage: 0.6,
          velocity: 96.2,
          horizontalMovement: -7.1,
          verticalMovement: 15.3,
          whiffQuality: 0.24,
          samples: 500,
          seasonsUsed: [2026],
          levelsUsed: ["MLB"]
        },
        {
          type: "SL",
          usage: 0.4,
          velocity: 86.7,
          horizontalMovement: 5.2,
          verticalMovement: 2.1,
          whiffQuality: 0.34,
          samples: 320,
          seasonsUsed: [2026],
          levelsUsed: ["MLB"]
        }
      ]
    },
    { level: "MLB", season: 2026 }
  );
  assert.equal(mockReal.length, 2);
  assert.ok(
    mockReal.every(
      (row) =>
        row.sourceId === REAL_SOURCE &&
        row.generated === false
    )
  );

  const generatedA = createGeneratedRandomArsenal({
    playerId: "NO_REAL_DATA_TEST",
    seed: "generated-fallback-test",
    level: "AA",
    season: 2026
  });
  const generatedB = createGeneratedRandomArsenal({
    playerId: "NO_REAL_DATA_TEST",
    seed: "generated-fallback-test",
    level: "AA",
    season: 2026
  });
  assert.deepEqual(generatedA, generatedB);
  assert.ok(generatedA.length >= 3 && generatedA.length <= 5);
  assert.ok(
    generatedA.every(
      (row) =>
        row.sourceId === GENERATED_SOURCE_ID &&
        row.generated === true
    )
  );

  const catalog = seasonApi.getCareerCreationCatalog({
    masterSnapshot: snapshot
  });
  const created = seasonApi.createCareerSeason({
    seed: "post-audit-direct-inference-arsenal-v1",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  const mlb = rosterPitchers(payload.fixture, "MLB");
  const aaa = rosterPitchers(payload.fixture, "AAA");
  const current = [...mlb, ...aaa];

  assert.ok(mlb.length > 100);
  assert.ok(aaa.length > 100);
  assert.ok(
    current.every(
      (player) =>
        Array.isArray(player.pitchArsenal) &&
        player.pitchArsenal.length > 0
    )
  );

  const realCurrent = current.filter(
    (player) =>
      player.pitchArsenal.some(
        (row) => row.sourceId === REAL_SOURCE
      )
  );
  const generatedCurrent = current.filter(
    (player) =>
      player.pitchArsenal.some(
        (row) => row.sourceId === GENERATED_SOURCE_ID
      )
  );

  assert.ok(
    realCurrent.length > 0,
    "Actual current rosters must exercise REAL inference arsenal"
  );
  assert.ok(
    generatedCurrent.length > 0,
    "Actual current rosters must exercise generated fallback"
  );
  assert.equal(
    realCurrent.length + generatedCurrent.length,
    current.length
  );

  const realProbe = realCurrent.find(
    (player) =>
      player.pitchArsenal.filter(
        (row) => Number.isFinite(Number(row.velocityMph))
      ).length >= 2
  );
  assert.ok(realProbe);

  const usageSum = realProbe.pitchArsenal.reduce(
    (sum, row) => sum + Number(row.usage ?? 0),
    0
  );
  assert.ok(Math.abs(usageSum - 1) < 1e-9);

  for (let pa = 0; pa < 200; pa += 1) {
    const selected = selectPitchFromArsenal({
      arsenal: realProbe.pitchArsenal,
      seed: "selection-test",
      state: {
        gameId: "ARSENAL_QA",
        plateAppearances: pa
      },
      pitcherId: realProbe.id,
      batterId: `B${pa % 9}`
    });
    assert.ok(selected);
    assert.ok(
      realProbe.pitchArsenal.some(
        (row) =>
          row.pitchType === selected.pitchType &&
          Number(row.velocityMph) ===
            Number(selected.velocityMph)
      )
    );
  }

  const gameFixture = findRuntimeGame(payload.fixture);
  assert.ok(gameFixture);

  const pitcherId =
    getCurrentPitcherId(gameFixture.initialState);
  const pitcher = gameFixture.players[pitcherId];
  const resolver =
    createSeasonGameContextResolver(gameFixture);
  const context = resolver({
    state: gameFixture.initialState,
    batterId:
      getCurrentBatterId(gameFixture.initialState),
    pitcherId
  });

  assert.ok(context.pitcher.pitchType);
  assert.ok(
    Number.isFinite(context.pitcher.pitchVelocityMph)
  );
  assert.ok(
    pitcher.pitchArsenal.some(
      (row) =>
        row.pitchType === context.pitcher.pitchType &&
        Number(row.velocityMph) ===
          Number(context.pitcher.pitchVelocityMph)
    )
  );

  const fast = simulateSeasonFixtureGame(
    gameFixture,
    {
      seed: "arsenal-fast",
      mode: "FAST"
    }
  );
  const detailed = simulateSeasonFixtureGame(
    gameFixture,
    {
      seed: "arsenal-detailed",
      mode: "DETAILED"
    }
  );
  assert.equal(fast.state.status, "FINAL");
  assert.equal(detailed.state.status, "FINAL");

  const interactiveFixture = Object.freeze({
    ...gameFixture,
    userPlayerId:
      gameFixture.initialState.lineups.away[0],
    userTeam: "away"
  });
  const view = gameApi.createGameFromFixture({
    fixture: interactiveFixture,
    seed: "arsenal-interactive"
  });
  const played = gameApi.playUserPA(
    view.gameId,
    "BALANCED"
  );
  const interactiveType =
    played.lastUserPA?.paResult?.selectedPitchType ??
    null;
  const interactiveVelocity =
    played.lastUserPA?.paResult
      ?.selectedPitchVelocityMph ?? null;
  gameApi.closeGame(view.gameId);

  assert.ok(interactiveType);
  assert.ok(Number.isFinite(interactiveVelocity));

  const report = {
    schema:
      "THE_CALL_UP_PRODUCTION_PITCH_ARSENAL_V2_DIRECT_INFERENCE",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    sourceCoverage: {
      rows: snapshot.pitchArsenal.length,
      players: new Set(
        snapshot.pitchArsenal.map(
          (row) => String(row.playerId)
        )
      ).size
    },
    runtimeCoverage: {
      mlbPitchers: mlb.length,
      aaaPitchers: aaa.length,
      realInferenceArsenal: realCurrent.length,
      generatedRandomArsenal: generatedCurrent.length
    },
    realProbe: {
      playerId: realProbe.id,
      arsenal: realProbe.pitchArsenal
    },
    generatedProbe: generatedA,
    liveContext: {
      pitcherId,
      pitchType: context.pitcher.pitchType,
      velocityMph:
        context.pitcher.pitchVelocityMph
    },
    interactive: {
      pitchType: interactiveType,
      velocityMph: interactiveVelocity
    },
    fastPass: true,
    detailedPass: true
  };

  const output = outputPath();
  fs.mkdirSync(path.dirname(output), {
    recursive: true
  });
  fs.writeFileSync(
    output,
    JSON.stringify(report, null, 2) + "\n"
  );
  process.stdout.write(
    JSON.stringify(report, null, 2) + "\n"
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
