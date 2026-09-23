import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.resolve(WORK_ROOT, relativePath), "utf8")
  );
}

function outputPathFromArgs() {
  const prefix = "--output=";
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit
    ? path.resolve(WORK_ROOT, hit.slice(prefix.length))
    : path.resolve(WORK_ROOT, "reports/post-audit-baseline-v1.json");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildPostAuditBaseline() {
  const identity = readJson("reports/final-runtime-identity-v1.json");
  const regression = readJson("reports/post-audit-regression-bridge-v1.json");
  const manifest = readJson(
    "data/the_call_up_snapshot_v2/production_manifest_v2.json"
  );
  const release = readJson("reports/complete-edition-release-checkpoint.json");

  assert.equal(identity.pass, true);
  assert.equal(regression.pass, true);
  assert.equal(release.pass, true);

  const core = {
    gameVersion: identity.runtime.gameVersion,
    saveSchemaVersion: identity.runtime.saveSchemaVersion,
    worldMode: identity.runtime.worldMode,
    snapshot: {
      source: identity.snapshot.source,
      schemaVersion: identity.snapshot.schemaVersion,
      snapshotId: identity.snapshot.snapshotId,
      contentHash: identity.snapshot.contentHash,
      snapshotDate: identity.snapshot.snapshotDate
    },
    production: {
      historySeasons: manifest.historySeasons,
      teams: manifest.coverage.teams,
      players: manifest.coverage.players,
      activePlayers: manifest.coverage.availability.ACTIVE,
      statsRows: manifest.coverage.statsRows,
      hitterSplitRows: manifest.coverage.hitterSplitRows,
      scheduleGames: manifest.coverage.scheduleGames,
      parks: manifest.coverage.parks,
      on40Man: manifest.coverage.on40Man,
      mlbActive: manifest.coverage.mlbActive
    },
    regression: {
      phase0Calibration: regression.gates.phase0Calibration,
      fastDetailedParity: regression.gates.fastDetailedParity,
      longRunV59: regression.gates.longRunV59,
      saveLifecycleV60: regression.gates.saveLifecycleV60,
      finalMobile: regression.gates.finalMobile
    },
    release: {
      release: release.release,
      standaloneFilename: release.standalone.filename,
      standaloneBytes: release.standalone.bytes,
      standaloneSha256: release.standalone.sha256
    }
  };

  const canonicalCore = JSON.stringify(core);

  return {
    schema: "THE_CALL_UP_POST_AUDIT_BASELINE_V1",
    pass: true,
    purpose:
      "Immutable comparison baseline for post-audit implementation and same-seed A/B regression checks.",
    baselineSeed: "post-audit-final-runtime-identity-v1",
    fingerprintSha256: sha256(canonicalCore),
    core
  };
}

function verifyBaseline(report) {
  assert.equal(report.pass, true);
  assert.equal(report.core.gameVersion, "complete_edition_v1_0");
  assert.equal(report.core.saveSchemaVersion, 2);
  assert.equal(report.core.worldMode, "PRODUCTION_REAL");

  assert.equal(
    report.core.snapshot.snapshotId,
    "mlb-milb-2026-2026-09-20-v2-production"
  );
  assert.equal(report.core.snapshot.contentHash, "fnv1a32:21eb3434");

  assert.deepEqual(report.core.production.historySeasons, [2024, 2025, 2026]);
  assert.equal(report.core.production.teams, 150);
  assert.equal(report.core.production.players, 5429);
  assert.equal(report.core.production.activePlayers, 4217);
  assert.equal(report.core.production.statsRows, 80606);
  assert.equal(report.core.production.hitterSplitRows, 18292);
  assert.equal(report.core.production.scheduleGames, 10710);
  assert.equal(report.core.production.parks, 30);
  assert.equal(report.core.production.on40Man, 1366);
  assert.equal(report.core.production.mlbActive, 840);

  assert.equal(report.core.regression.phase0Calibration.pass, true);
  assert.equal(report.core.regression.fastDetailedParity.pass, true);
  assert.equal(report.core.regression.longRunV59.pass, true);
  assert.equal(report.core.regression.saveLifecycleV60.pass, true);
  assert.equal(report.core.regression.finalMobile.pass, true);

  assert.equal(report.core.release.release, "Complete Edition 1.0");
  assert.equal(
    report.core.release.standaloneSha256,
    "34d60370670902a22c9c311ec1796d7d64ea1f7f8fd80608a0642c169aaf785f"
  );

  assert.match(report.fingerprintSha256, /^[0-9a-f]{64}$/);
  return true;
}

function main() {
  const report = buildPostAuditBaseline();
  verifyBaseline(report);

  const json = JSON.stringify(report, null, 2) + "\n";
  const output = outputPathFromArgs();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, json);
  process.stdout.write(json);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { buildPostAuditBaseline, verifyBaseline };
