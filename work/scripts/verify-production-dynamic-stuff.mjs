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
  GENERATED_SOURCE_ID,
  arsenalAverageQualityZ,
  createGeneratedRandomArsenal,
  pitchQualityZ,
  resolveDynamicPitchStuff
} from "../src/services/productionPitchArsenal.js";
import { getPAOutcomeProbabilities } from "../src/engine/pa/outcomeModel.js";
import {
  getCurrentBatterId,
  getCurrentPitcherId
} from "../src/engine/game/gameState.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib
      .gunzipSync(fs.readFileSync(path.resolve(ROOT, SNAP)))
      .toString("utf8")
  );
}

function careerInput(orgId) {
  return {
    name: "Dynamic Stuff QA",
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

function outputPath() {
  const arg = process.argv.find((value) => value.startsWith("--output="));
  return path.resolve(
    ROOT,
    arg
      ? arg.slice("--output=".length)
      : "reports/production-dynamic-stuff-v1.json"
  );
}

function findGame(fixture) {
  for (const game of fixture.levelLeagues.MLB.schedule.slice(0, 700)) {
    const gf = createSeasonGameFixture({
      seasonFixture: fixture,
      scheduleGame: game,
      level: "MLB"
    });
    const pitcherId = getCurrentPitcherId(gf.initialState);
    const pitcher = gf.players[pitcherId];
    const arsenal = pitcher?.pitchArsenal ?? [];
    const qualities = arsenal.map(pitchQualityZ);
    const spread = qualities.length
      ? Math.max(...qualities) - Math.min(...qualities)
      : 0;

    if (
      arsenal.length >= 2 &&
      spread >= 0.12 &&
      arsenal.some(
        (row) =>
          row.sourceId === "real_world_inference_pitch_arsenal"
      )
    ) {
      return gf;
    }
  }
  return null;
}

function main() {
  const snapshot = readSnapshot();
  assert.equal(snapshot.metadata.contentHash, "fnv1a32:f7b34713");

  const catalog = seasonApi.getCareerCreationCatalog({
    masterSnapshot: snapshot
  });
  const created = seasonApi.createCareerSeason({
    seed: "post-audit-dynamic-stuff-v1",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  const gameFixture = findGame(payload.fixture);
  assert.ok(
    gameFixture,
    "Dynamic Stuff 검증용 REAL multi-pitch 선발을 찾지 못했습니다."
  );

  const pitcherId = getCurrentPitcherId(gameFixture.initialState);
  const batterId = getCurrentBatterId(gameFixture.initialState);
  const pitcher = gameFixture.players[pitcherId];
  const arsenal = pitcher.pitchArsenal;
  const baseStuff = pitcher.derived.stuff;
  const averageQuality = arsenalAverageQualityZ(arsenal);

  const pitchStuff = arsenal.map((pitch) => ({
    pitchType: pitch.pitchType,
    usage: pitch.usage,
    qualityZ: pitchQualityZ(pitch),
    velocityMph: pitch.velocityMph,
    whiff: pitch.whiff,
    stuff: resolveDynamicPitchStuff({
      baseStuff,
      selectedPitch: pitch,
      arsenal
    })
  }));

  assert.ok(new Set(pitchStuff.map((row) => row.stuff)).size >= 2);
  assert.ok(
    pitchStuff.every(
      (row) =>
        Number.isFinite(row.stuff) &&
        row.stuff >= 20 &&
        row.stuff <= 99
    )
  );

  const usageTotal = pitchStuff.reduce(
    (sum, row) => sum + Number(row.usage),
    0
  );
  const weightedStuff =
    pitchStuff.reduce(
      (sum, row) =>
        sum + row.stuff * Number(row.usage),
      0
    ) / usageTotal;

  assert.ok(
    Math.abs(weightedStuff - baseStuff) <= 2.5,
    `Dynamic Stuff 평균이 base에서 너무 멉니다: ${weightedStuff} vs ${baseStuff}`
  );

  const resolver = createSeasonGameContextResolver(gameFixture);
  const liveSelections = new Map();

  for (let pa = 0; pa < 300; pa += 1) {
    const state = Object.freeze({
      ...gameFixture.initialState,
      plateAppearances: pa
    });
    const context = resolver({
      state,
      batterId,
      pitcherId
    });

    assert.ok(context.pitcher.pitchType);
    assert.ok(Number.isFinite(context.pitcher.stuff));
    assert.ok(context.pitcher.stuff >= 20 && context.pitcher.stuff <= 99);

    if (!liveSelections.has(context.pitcher.pitchType)) {
      liveSelections.set(
        context.pitcher.pitchType,
        {
          stuff: context.pitcher.stuff,
          velocityMph: context.pitcher.pitchVelocityMph,
          strikeoutProbability:
            getPAOutcomeProbabilities(context).K
        }
      );
    }
  }

  assert.ok(
    liveSelections.size >= 2,
    "실제 PA 선택에서 2개 이상의 구종이 필요합니다."
  );

  const distinctStuff = new Set(
    [...liveSelections.values()].map((row) => row.stuff)
  );
  assert.ok(
    distinctStuff.size >= 2,
    "선택 구종에 따라 Stuff가 달라져야 합니다."
  );

  const liveRows = [...liveSelections.entries()].map(
    ([pitchType, row]) => ({ pitchType, ...row })
  );
  const minStuff = liveRows.reduce(
    (a, b) => (a.stuff <= b.stuff ? a : b)
  );
  const maxStuff = liveRows.reduce(
    (a, b) => (a.stuff >= b.stuff ? a : b)
  );
  assert.notEqual(minStuff.stuff, maxStuff.stuff);
  assert.notEqual(
    minStuff.strikeoutProbability,
    maxStuff.strikeoutProbability
  );

  const generated = createGeneratedRandomArsenal({
    playerId: "DYNAMIC_STUFF_GENERATED",
    seed: "dynamic-generated",
    level: "AA",
    season: 2026
  });
  assert.ok(
    generated.every(
      (row) => row.sourceId === GENERATED_SOURCE_ID
    )
  );
  const generatedStuff = generated.map((pitch) =>
    resolveDynamicPitchStuff({
      baseStuff: 50,
      selectedPitch: pitch,
      arsenal: generated
    })
  );
  assert.ok(
    generatedStuff.every(
      (value) =>
        Number.isFinite(value) &&
        value >= 20 &&
        value <= 99
    )
  );

  const fast = simulateSeasonFixtureGame(gameFixture, {
    seed: "dynamic-stuff-fast",
    mode: "FAST"
  });
  const detailed = simulateSeasonFixtureGame(gameFixture, {
    seed: "dynamic-stuff-detailed",
    mode: "DETAILED"
  });
  assert.equal(fast.state.status, "FINAL");
  assert.equal(detailed.state.status, "FINAL");

  const interactiveFixture = Object.freeze({
    ...gameFixture,
    userPlayerId: gameFixture.initialState.lineups.away[0],
    userTeam: "away"
  });
  const view = gameApi.createGameFromFixture({
    fixture: interactiveFixture,
    seed: "dynamic-stuff-interactive"
  });
  const played = gameApi.playUserPA(view.gameId, "BALANCED");
  const result = played.lastUserPA?.paResult ?? null;
  gameApi.closeGame(view.gameId);

  assert.ok(result);
  assert.ok(result.selectedPitchType);
  assert.ok(Number.isFinite(result.selectedPitchVelocityMph));

  const report = {
    schema: "THE_CALL_UP_PRODUCTION_DYNAMIC_STUFF_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    pitcherId,
    baseStuff,
    arsenalAverageQualityZ: averageQuality,
    pitchStuff,
    weightedStuff,
    liveSelections: Object.fromEntries(liveSelections),
    generatedFallback: {
      pitchCount: generated.length,
      stuffRatings: generatedStuff
    },
    fastPass: true,
    detailedPass: true,
    interactive: {
      pitchType: result.selectedPitchType,
      velocityMph: result.selectedPitchVelocityMph
    }
  };

  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
