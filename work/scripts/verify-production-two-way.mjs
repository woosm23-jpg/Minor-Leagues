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

function outputPath() {
  const arg = process.argv.find(
    (value) => value.startsWith("--output=")
  );
  return path.resolve(
    ROOT,
    arg
      ? arg.slice("--output=".length)
      : "reports/production-two-way-v1.json"
  );
}

function main() {
  const snapshot = readSnapshot();
  assert.equal(
    snapshot.metadata.contentHash,
    "fnv1a32:f7b34713"
  );

  const universe = inferRealWorldUniverse(
    createSaveUniverseFromMasterSnapshot(
      snapshot,
      {
        copiedAtCareerStart:
          snapshot.metadata.snapshotDate,
        sourceVersion: "TWO_WAY_QA"
      }
    )
  );

  const sourceTwoWay =
    universe.inference.players.filter(
      (row) => row.type === "TWO_WAY"
    );

  assert.ok(
    sourceTwoWay.length > 0,
    "실제 양방향 표본을 가진 TWO_WAY 선수가 없습니다."
  );

  for (const row of sourceTwoWay) {
    assert.ok(row.hitterProfile);
    assert.ok(row.pitcherProfile);
    assert.ok(row.twoWayEvidence?.eligible);
    assert.ok(
      Number(row.twoWayEvidence.hittingPa) >= 20
    );
    assert.ok(
      Number(row.twoWayEvidence.pitchingIp) >= 5 ||
      Number(row.twoWayEvidence.pitchingBf) >= 20
    );
    assert.ok(
      ["SP", "SWING", "RP"].includes(row.role)
    );
    assert.ok(Array.isArray(row.pitchArsenal));
  }

  const catalog =
    seasonApi.getCareerCreationCatalog({
      masterSnapshot: snapshot
    });

  const created =
    seasonApi.createCareerSeason({
      seed: "post-audit-two-way-v1",
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
  let dualRosterMembership = 0;
  let dualSkillShape = 0;
  let roleEvidence = 0;
  const samples = [];

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
        dualRosterMembership += 1;

        assert.ok(player.hitting);
        assert.ok(player.pitching);
        assert.ok(player.derived);
        assert.ok(
          Array.isArray(player.pitchArsenal) &&
          player.pitchArsenal.length > 0
        );
        assert.ok(
          Number.isFinite(
            Number(player.hitting.contactR)
          )
        );
        assert.ok(
          Number.isFinite(
            Number(player.pitching.control)
          )
        );
        assert.ok(
          player.positioning?.primaryPosition
        );
        dualSkillShape += 1;

        assert.ok(
          player.realWorld
            ?.pitcherRoleEvidence
        );
        roleEvidence += 1;

        if (samples.length < 8) {
          samples.push({
            level,
            playerId,
            name:
              roster.names?.[playerId] ??
              playerId,
            primaryPosition:
              player.positioning
                ?.primaryPosition,
            pitcherRole:
              player.pitching?.role,
            hittingOverall:
              player.realWorld
                ?.twoWayHitterOverall,
            pitcherOverall:
              player.realWorld
                ?.twoWayPitcherOverall,
            evidence:
              player.realWorld
                ?.twoWayEvidence
          });
        }
      }
    }
  }

  assert.ok(
    runtimeTwoWay > 0,
    "Production runtime에 TWO_WAY 선수가 하나도 연결되지 않았습니다."
  );
  assert.equal(
    runtimeTwoWay,
    dualRosterMembership
  );
  assert.equal(
    runtimeTwoWay,
    dualSkillShape
  );
  assert.equal(
    runtimeTwoWay,
    roleEvidence
  );

  const report = {
    schema:
      "THE_CALL_UP_PRODUCTION_TWO_WAY_V1",
    pass: true,
    snapshotHash:
      snapshot.metadata.contentHash,
    policy: {
      onePlayerId: true,
      duplicatePlayerObjects: false,
      requiresRealHittingAndPitchingEvidence: true,
      positionPlayerMopUpPitchingExcluded:
        "BY_SAMPLE_THRESHOLDS",
      rosterMembership:
        "POSITION_AND_PITCHER_BOTH"
    },
    source: {
      twoWayPlayers:
        sourceTwoWay.length,
      ids:
        sourceTwoWay.map(
          (row) => String(row.playerId)
        )
    },
    runtime: {
      twoWayPlayers:
        runtimeTwoWay,
      dualRosterMembership,
      dualSkillShape,
      roleEvidence
    },
    samples
  };

  const out = outputPath();
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
