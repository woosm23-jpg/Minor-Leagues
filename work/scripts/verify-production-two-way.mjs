import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createSaveUniverseFromMasterSnapshot
} from "../src/data/masterSnapshot.js";
import {
  inferRealWorldUniverse,
  REAL_WORLD_INFERENCE_MODEL_ID
} from "../src/data/realWorldInference.js";
import { seasonApi } from "../src/api/seasonApi.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(path.resolve(ROOT, SNAP))
    ).toString("utf8")
  );
}

function careerInput(orgId) {
  return {
    name: "Two Way QA",
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

function main() {
  const snapshot = readSnapshot();
  assert.equal(
    snapshot.metadata.contentHash,
    "fnv1a32:f7b34713"
  );
  assert.ok(
    REAL_WORLD_INFERENCE_MODEL_ID.includes(
      "two_way_v2"
    )
  );

  const universe = inferRealWorldUniverse(
    createSaveUniverseFromMasterSnapshot(
      snapshot,
      {
        copiedAtCareerStart:
          snapshot.metadata.snapshotDate,
        sourceVersion: "TWO_WAY_QA_V2"
      }
    )
  );

  const twoWay =
    universe.inference.players.filter(
      (row) => row.type === "TWO_WAY"
    );

  assert.ok(twoWay.length > 0);

  const knownMopupIds = new Set([
    "623168",
    "624431",
    "500743",
    "666126",
    "691594",
    "663897",
    "624523"
  ]);

  for (const row of twoWay) {
    const evidence = row.twoWayEvidence;
    assert.ok(evidence?.eligible);
    assert.ok(
      Number(evidence.hittingPa) >= 20
    );

    if (!evidence.designatedPitcher) {
      assert.ok(
        Number(evidence.pitchingStarts) >= 1 ||
        Number(evidence.pitchingIp) >= 30 ||
        Number(evidence.pitchingBf) >= 120,
        `non-pitcher TWO_WAY lacks meaningful pitching evidence: ${row.playerId}`
      );
    }

    assert.ok(
      !knownMopupIds.has(
        String(row.playerId)
      ),
      `known mop-up pitcher leaked into TWO_WAY: ${row.playerId}`
    );
  }

  const catalog =
    seasonApi.getCareerCreationCatalog({
      masterSnapshot: snapshot
    });

  const created =
    seasonApi.createCareerSeason({
      seed: "post-audit-two-way-v2",
      input: careerInput(
        catalog.organizations[0].id
      ),
      masterSnapshot: snapshot
    });

  const payload =
    seasonApi.serializeSeason(
      created.seasonId
    );

  let runtimeTwoWay = 0;
  const runtimeIds = [];

  for (
    const level of
    ["MLB", "AAA", "AA", "HIGH_A", "A"]
  ) {
    const league =
      payload.fixture.levelLeagues[level];

    for (
      const roster of
      Object.values(league.rosters)
    ) {
      const positionSet =
        new Set(
          (roster.positionPlayers ?? [])
            .map(String)
        );
      const pitcherSet =
        new Set(
          (roster.pitchers ?? [])
            .map(String)
        );

      for (const playerId of positionSet) {
        if (!pitcherSet.has(playerId)) {
          continue;
        }

        const player =
          roster.players[playerId];

        if (
          player?.realWorld?.twoWay !== true
        ) {
          continue;
        }

        runtimeTwoWay += 1;
        runtimeIds.push(playerId);

        assert.ok(player.hitting);
        assert.ok(player.pitching);
        assert.ok(player.positioning);
        assert.ok(
          Array.isArray(player.pitchArsenal) &&
          player.pitchArsenal.length > 0
        );
        assert.ok(
          !knownMopupIds.has(playerId)
        );
      }
    }
  }

  assert.ok(runtimeTwoWay > 0);

  const report = {
    schema:
      "THE_CALL_UP_PRODUCTION_TWO_WAY_V2_STRICT",
    pass: true,
    snapshotHash:
      snapshot.metadata.contentHash,
    inferenceModel:
      REAL_WORLD_INFERENCE_MODEL_ID,
    policy: {
      designatedPitcher: {
        minHittingPa: 20,
        minPitching:
          "5 IP or 20 BF"
      },
      nonDesignatedPitcher: {
        minHittingPa: 50,
        minPitching:
          "1 GS or 30 IP or 120 BF"
      },
      mopUpExcluded: true,
      onePlayerId: true
    },
    source: {
      twoWayPlayers:
        twoWay.length,
      ids:
        twoWay.map(
          (row) => String(row.playerId)
        )
    },
    runtime: {
      twoWayPlayers:
        runtimeTwoWay,
      ids: runtimeIds
    }
  };

  const out = path.resolve(
    ROOT,
    "reports/production-two-way-v1.json"
  );
  fs.mkdirSync(
    path.dirname(out),
    { recursive: true }
  );
  fs.writeFileSync(
    out,
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
