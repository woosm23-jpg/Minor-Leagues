import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import {
  createHealthState
} from "../src/engine/season/injuryState.js";
import {
  createGeneratedDurability
} from "../src/services/productionStyleFallback.js";

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
    name: "Durability Role QA",
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
      : "reports/production-durability-role-v1.json"
  );
}

function main() {
  const snapshot = readSnapshot();
  assert.equal(
    snapshot.metadata.contentHash,
    "fnv1a32:f7b34713"
  );

  const sameA = createGeneratedDurability({
    seed: "DURABILITY_QA",
    playerId: "1001",
    kind: "HITTER"
  });
  const sameB = createGeneratedDurability({
    seed: "DURABILITY_QA",
    playerId: "1001",
    kind: "HITTER"
  });
  assert.deepEqual(sameA, sameB);
  assert.ok(
    sameA.rating >= 48 &&
    sameA.rating <= 78
  );

  const catalog =
    seasonApi.getCareerCreationCatalog({
      masterSnapshot: snapshot
    });

  const created = seasonApi.createCareerSeason({
    seed: "post-audit-durability-role-v1",
    input: careerInput(
      catalog.organizations[0].id
    ),
    masterSnapshot: snapshot
  });

  const payload =
    seasonApi.serializeSeason(created.seasonId);

  const roles = {
    SP: 0,
    SWING: 0,
    RP: 0
  };
  const durabilityValues = new Set();
  let hitterCount = 0;
  let pitcherCount = 0;
  let healthMatches = 0;
  let roleEvidenceCount = 0;
  let starterRoleViolations = 0;

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

        const player =
          roster.players[playerId];
        assert.ok(player);

        const durability =
          Number(player.physical?.durability);
        assert.ok(
          Number.isFinite(durability)
        );
        assert.ok(
          durability >= 48 &&
          durability <= 78
        );
        assert.equal(
          player.realWorld?.durabilitySource,
          "GENERATED_RANDOM_FALLBACK"
        );

        const health =
          createHealthState(
            player,
            { kind: "POSITION" }
          );
        assert.equal(
          health.durability,
          durability
        );

        durabilityValues.add(durability);
        hitterCount += 1;
        healthMatches += 1;
      }

      const starterIds =
        new Set(roster.starters ?? []);

      for (
        const playerId of
        roster.pitchers ?? []
      ) {
        const player =
          roster.players[playerId];
        assert.ok(player);

        const durability =
          Number(player.physical?.durability);
        assert.ok(
          Number.isFinite(durability)
        );
        assert.ok(
          durability >= 48 &&
          durability <= 78
        );
        assert.equal(
          player.realWorld?.durabilitySource,
          "GENERATED_RANDOM_FALLBACK"
        );

        const role =
          player.pitching?.role;
        assert.ok(
          ["SP", "SWING", "RP"].includes(role)
        );
        roles[role] += 1;

        const roleEvidence =
          player.realWorld?.pitcherRoleEvidence;
        assert.ok(roleEvidence);
        assert.ok(
          Number.isFinite(
            Number(roleEvidence.startShare)
          )
        );
        assert.ok(
          Number.isFinite(
            Number(roleEvidence.ipPerGame)
          )
        );
        roleEvidenceCount += 1;

        const health =
          createHealthState(
            player,
            { kind: "PITCHER" }
          );
        assert.equal(
          health.durability,
          durability
        );

        if (
          starterIds.has(String(playerId)) &&
          role === "RP"
        ) {
          const spOrSwingCount =
            (roster.pitchers ?? [])
              .map(
                (id) =>
                  roster.players[id]
                    ?.pitching?.role
              )
              .filter(
                (candidateRole) =>
                  candidateRole === "SP" ||
                  candidateRole === "SWING"
              )
              .length;

          if (spOrSwingCount >= 5) {
            starterRoleViolations += 1;
          }
        }

        durabilityValues.add(durability);
        pitcherCount += 1;
        healthMatches += 1;
      }
    }
  }

  assert.ok(hitterCount > 1000);
  assert.ok(pitcherCount > 700);
  assert.ok(durabilityValues.size > 20);
  assert.ok(roles.SP > 0);
  assert.ok(roles.SWING > 0);
  assert.ok(roles.RP > 0);
  assert.equal(
    roleEvidenceCount,
    pitcherCount
  );
  assert.equal(
    starterRoleViolations,
    0
  );

  const report = {
    schema:
      "THE_CALL_UP_PRODUCTION_DURABILITY_ROLE_V1",
    pass: true,
    snapshotHash:
      snapshot.metadata.contentHash,
    policy: {
      durability:
        "DETERMINISTIC_RANDOM_FALLBACK_WHEN_REAL_DATA_ABSENT",
      durabilityRange: [48, 78],
      initialRealWorldInjuries:
        "NOT_RANDOMIZED",
      pitcherRole:
        "REAL_GAMES_STARTS_INNINGS_EVIDENCE",
      starterPreference:
        ["SP", "SWING", "RP"]
    },
    runtime: {
      hitters: hitterCount,
      pitchers: pitcherCount,
      healthMatches,
      distinctDurabilityValues:
        durabilityValues.size,
      roles,
      roleEvidenceCount,
      starterRoleViolations
    },
    deterministicSample: sameA
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
