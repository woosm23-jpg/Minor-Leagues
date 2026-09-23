import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");
const SNAPSHOT_RELATIVE_TO_WORK =
  "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const SNAPSHOT_SOURCE = `work/${SNAPSHOT_RELATIVE_TO_WORK}`;
const IDENTITY_SEED = "post-audit-final-runtime-identity-v1";

function loadReleaseSnapshot() {
  const snapshotPath = path.resolve(WORK_ROOT, SNAPSHOT_RELATIVE_TO_WORK);
  return JSON.parse(
    zlib.gunzipSync(fs.readFileSync(snapshotPath)).toString("utf8")
  );
}

function careerInput(organizationId) {
  return {
    name: "Runtime Identity QA",
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

function buildFinalRuntimeIdentityReport() {
  const masterSnapshot = loadReleaseSnapshot();
  const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot });
  assert.equal(
    catalog.organizations.length,
    30,
    "Production organization count must be 30"
  );

  const created = seasonApi.createCareerSeason({
    seed: IDENTITY_SEED,
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot
  });

  const payload = seasonApi.serializeSeason(created.seasonId);
  validateSeasonSavePayload(payload, { mode: "FULL" });

  assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL");
  assert.equal(payload.dataUniverse.origin, "MASTER_SNAPSHOT");
  assert.equal(payload.dataUniverse.independent, true);

  const report = {
    schema: "THE_CALL_UP_FINAL_RUNTIME_IDENTITY_V1",
    pass: true,
    seed: IDENTITY_SEED,
    runtime: {
      gameVersion: payload.gameVersion,
      saveSchemaVersion: payload.schemaVersion,
      worldMode: payload.fixture.worldMode
    },
    snapshot: {
      source: SNAPSHOT_SOURCE,
      schemaVersion: masterSnapshot.schemaVersion,
      snapshotId: payload.dataUniverse.sourceSnapshot.id,
      contentHash: payload.dataUniverse.sourceSnapshot.hash,
      snapshotDate: payload.dataUniverse.snapshotDate,
      origin: payload.dataUniverse.origin
    },
    counts: {
      players: payload.dataUniverse.data.players.length,
      teams: payload.dataUniverse.data.teams.length,
      parks: payload.dataUniverse.data.parks.length,
      scheduleGames: payload.dataUniverse.data.schedule.length
    }
  };

  assert.equal(report.snapshot.snapshotId, masterSnapshot.metadata.snapshotId);
  assert.equal(report.snapshot.contentHash, masterSnapshot.metadata.contentHash);
  return report;
}

function verifyCurrentReleaseIdentity(report) {
  assert.equal(report.runtime.gameVersion, "complete_edition_v1_0");
  assert.equal(report.runtime.saveSchemaVersion, 2);
  assert.equal(report.runtime.worldMode, "PRODUCTION_REAL");
  assert.equal(report.snapshot.schemaVersion, 2);
  assert.equal(
    report.snapshot.snapshotId,
    "mlb-milb-2026-2026-09-20-v2-production"
  );
  assert.equal(report.snapshot.contentHash, "fnv1a32:21eb3434");
  assert.equal(report.snapshot.snapshotDate, "2026-09-20");
  assert.equal(report.snapshot.origin, "MASTER_SNAPSHOT");
  assert.equal(report.snapshot.source, SNAPSHOT_SOURCE);
  assert.deepEqual(report.counts, {
    players: 5429,
    teams: 150,
    parks: 30,
    scheduleGames: 10710
  });
  return true;
}

function outputPathFromArgs(args) {
  const arg = args.find((value) => value.startsWith("--output="));
  return arg
    ? path.resolve(process.cwd(), arg.slice("--output=".length))
    : null;
}

async function main() {
  const report = buildFinalRuntimeIdentityReport();
  if (process.argv.includes("--verify")) {
    verifyCurrentReleaseIdentity(report);
  }

  const json = JSON.stringify(report, null, 2) + "\n";
  const outputPath = outputPathFromArgs(process.argv.slice(2));
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
  }
  process.stdout.write(json);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  buildFinalRuntimeIdentityReport,
  verifyCurrentReleaseIdentity
};
