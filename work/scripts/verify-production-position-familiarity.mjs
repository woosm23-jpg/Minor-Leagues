import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import {
  createSaveUniverseFromMasterSnapshot
} from "../src/data/masterSnapshot.js";
import {
  inferRealWorldUniverse
} from "../src/data/realWorldInference.js";
import {
  resolveProductionPositionProfile
} from "../src/services/productionSeasonFactory.js";

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
    name: "Position QA",
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
  const arg = process.argv.find(
    (value) => value.startsWith("--output=")
  );
  return path.resolve(
    ROOT,
    arg
      ? arg.slice("--output=".length)
      : "reports/production-position-familiarity-v1.json"
  );
}

function main() {
  const snapshot = readSnapshot();
  assert.equal(snapshot.metadata.contentHash, "fnv1a32:f7b34713");

  const universe = inferRealWorldUniverse(
    createSaveUniverseFromMasterSnapshot(snapshot, {
      copiedAtCareerStart: snapshot.metadata.snapshotDate,
      sourceVersion: "POSITION_QA"
    })
  );

  const inferenceById = new Map(
    universe.inference.players.map(
      (row) => [String(row.playerId), row]
    )
  );
  const playerById = new Map(
    universe.data.players.map(
      (row) => [String(row.id), row]
    )
  );

  const profiles = universe.inference.players
    .filter((row) => row.type === "HITTER")
    .map((inference) => {
      const player =
        playerById.get(String(inference.playerId));
      if (!player) return null;
      return {
        player,
        inference,
        profile: resolveProductionPositionProfile(
          player,
          inference
        )
      };
    })
    .filter(Boolean);

  const realProfiles = profiles.filter(
    (row) =>
      row.profile.source.startsWith(
        "REAL_POSITION_EVIDENCE"
      )
  );
  const inferredCoverageProfiles =
    realProfiles.filter(
      (row) =>
        row.profile.inferredPositions?.length > 0
    );

  assert.ok(realProfiles.length > 100);
  assert.ok(inferredCoverageProfiles.length > 20);

  const catalog =
    seasonApi.getCareerCreationCatalog({
      masterSnapshot: snapshot
    });
  const created = seasonApi.createCareerSeason({
    seed: "post-audit-position-familiarity-v2",
    input: careerInput(
      catalog.organizations[0].id
    ),
    masterSnapshot: snapshot
  });
  const payload =
    seasonApi.serializeSeason(created.seasonId);

  let checkedPlayers = 0;
  let checkedDefensiveSlots = 0;
  let inferredStarterSlots = 0;
  let exactStarterSlots = 0;
  let checkedBenchRows = 0;

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
      for (
        const playerId of
        roster.positionPlayers ?? []
      ) {
        if (
          String(playerId) ===
          String(payload.fixture.userPlayerId)
        ) {
          continue;
        }

        const runtime =
          roster.players[playerId];
        const source =
          playerById.get(String(playerId));
        const inference =
          inferenceById.get(String(playerId));

        assert.ok(runtime);
        assert.ok(source);
        assert.ok(inference);

        const expected =
          resolveProductionPositionProfile(
            source,
            inference
          );

        assert.deepEqual(
          runtime.positioning.familiarity,
          expected.familiarity
        );
        assert.equal(
          runtime.positioning.primaryPosition,
          expected.primaryPosition
        );
        checkedPlayers += 1;
      }

      for (
        const slot of
        roster.lineupSlots ?? []
      ) {
        if (slot.position === "DH") continue;

        const runtime =
          roster.players[slot.starterId];
        assert.ok(runtime);

        const familiarity = Number(
          runtime.positioning?.familiarity?.[
            slot.position
          ] ?? 0
        );
        assert.ok(
          familiarity > 0,
          `${level} ${slot.starterId} cannot cover ${slot.position}`
        );

        if (familiarity < 0.5) {
          inferredStarterSlots += 1;
        } else {
          exactStarterSlots += 1;
        }
        checkedDefensiveSlots += 1;
      }

      for (
        const row of
        roster.bench ?? []
      ) {
        const runtime =
          roster.players[row.playerId];
        assert.ok(runtime);

        for (
          const position of
          row.coverage ?? []
        ) {
          assert.ok(
            Number(
              runtime.positioning
                ?.familiarity?.[position] ?? 0
            ) > 0
          );
        }
        checkedBenchRows += 1;
      }
    }
  }

  assert.ok(checkedPlayers > 1000);
  assert.ok(checkedDefensiveSlots > 500);
  assert.ok(exactStarterSlots > inferredStarterSlots);
  assert.ok(checkedBenchRows > 500);

  const sample = inferredCoverageProfiles[0];
  const report = {
    schema:
      "THE_CALL_UP_PRODUCTION_POSITION_FAMILIARITY_V2",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    policy: {
      realEvidenceFirst: true,
      deterministicAdjacentInference: true,
      randomPositions: false,
      legacyHeuristicOnlyWithoutEvidence: true
    },
    sourceCoverage: {
      hitterProfiles: profiles.length,
      realEvidenceProfiles: realProfiles.length,
      inferredCoverageProfiles:
        inferredCoverageProfiles.length
    },
    runtimeCoverage: {
      checkedPlayers,
      checkedDefensiveSlots,
      exactStarterSlots,
      inferredStarterSlots,
      checkedBenchRows
    },
    sample: {
      playerId: String(sample.player.id),
      sourcePosition: sample.player.position,
      rawEvidence:
        sample.inference.positionFamiliarity,
      resolved: sample.profile
    }
  };

  const out = outputPath();
  fs.mkdirSync(path.dirname(out), {
    recursive: true
  });
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
