import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(WORK_ROOT, filePath), "utf8"));
}

function allTrue(object) {
  return Object.values(object).every((value) => value === true);
}

function buildRegressionBridgeReport({
  phase0Path = "reports/phase0-final-acceptance-v8.json",
  fastPath = "reports/phase3-fast-sim-v38.json"
} = {}) {
  const identity = readJson("reports/final-runtime-identity-v1.json");
  const phase0 = readJson(phase0Path);
  const fast = readJson(fastPath);
  const v59 = readJson("reports/v59-long-run-stress-checkpoint.json");
  const v60 = readJson("reports/v60-complete-edition-rc-checkpoint.json");
  const mobile = readJson("reports/complete-edition-final-browser.json");
  const release = readJson("reports/complete-edition-release-checkpoint.json");

  assert.equal(identity.pass, true);
  assert.equal(identity.runtime.gameVersion, "complete_edition_v1_0");
  assert.equal(identity.snapshot.contentHash, "fnv1a32:21eb3434");

  assert.equal(phase0.passed, true);
  assert.equal(phase0.sampleSize, 1_000_000);
  assert.ok(Array.isArray(phase0.checks) && phase0.checks.length > 0);
  assert.ok(phase0.checks.every((check) => check.pass === true));

  assert.equal(fast.pass, true);
  assert.ok(Object.values(fast.profileParity).every((row) => row.pass === true));
  assert.ok(fast.miniLeague.checks.every((row) => row.pass === true));
  assert.equal(fast.miniLeague.speedCheck.pass, true);

  assert.equal(v59.pass, true);
  assert.equal(v59.stress.completedSeasons, 20);
  assert.equal(v59.stress.lastCompletedYear, 2045);
  assert.equal(v59.stress.simulatedWorldGames, 214200);
  assert.equal(allTrue(v59.stress.invariants), true);

  assert.equal(v60.pass, true);
  assert.equal(v60.evidence.v59LongRun20Seasons, true);
  assert.equal(v60.saveValidation.fullValidationEveryStage, true);
  assert.equal(v60.saveValidation.repeatedRestoreStable, true);
  assert.equal(v60.saveValidation.midseasonDeterministicContinuation, true);

  assert.equal(mobile.pass, true);
  const viewportKeys = mobile.results.map(
    (row) => `${row.viewport.width}x${row.viewport.height}`
  );
  assert.ok(viewportKeys.includes("390x844"));
  assert.ok(viewportKeys.includes("412x915"));
  assert.ok(
    mobile.results.every(
      (row) =>
        row.pass === true &&
        row.checks.pageErrors === 0 &&
        row.checks.consoleErrors === 0 &&
        row.checks.noHorizontalOverflow === true
    )
  );

  assert.equal(release.pass, true);
  assert.equal(release.gameVersion, "complete_edition_v1_0");
  assert.equal(release.save.pass, true);

  return {
    schema: "THE_CALL_UP_POST_AUDIT_REGRESSION_BRIDGE_V1",
    pass: true,
    baseline: {
      gameVersion: identity.runtime.gameVersion,
      snapshotHash: identity.snapshot.contentHash,
      players: identity.counts.players,
      teams: identity.counts.teams
    },
    gates: {
      finalRuntimeIdentity: true,
      phase0Calibration: {
        pass: true,
        sampleSize: phase0.sampleSize,
        checks: phase0.checks.length
      },
      fastDetailedParity: {
        pass: true,
        profiles: Object.keys(fast.profileParity).length,
        gamesPerEngine: fast.miniLeague.gamesPerEngine
      },
      longRunV59: {
        pass: true,
        completedSeasons: v59.stress.completedSeasons,
        simulatedWorldGames: v59.stress.simulatedWorldGames,
        invariants: Object.keys(v59.stress.invariants).length
      },
      saveLifecycleV60: {
        pass: true,
        fullValidationEveryStage: true,
        repeatedRestoreStable: true,
        midseasonDeterministicContinuation: true
      },
      finalMobile: {
        pass: true,
        viewports: viewportKeys
      },
      completeEditionRelease: {
        pass: true,
        release: release.release,
        standaloneSha256: release.standalone.sha256
      }
    }
  };
}

function verifyReport(report) {
  assert.equal(report.pass, true);
  assert.equal(report.gates.finalRuntimeIdentity, true);
  assert.equal(report.gates.phase0Calibration.pass, true);
  assert.equal(report.gates.fastDetailedParity.pass, true);
  assert.equal(report.gates.longRunV59.pass, true);
  assert.equal(report.gates.saveLifecycleV60.pass, true);
  assert.equal(report.gates.finalMobile.pass, true);
  assert.equal(report.gates.completeEditionRelease.pass, true);
  return true;
}

function writeReport(report, outputPath) {
  const absolute = path.resolve(WORK_ROOT, outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(report, null, 2) + "\n");
}

function main() {
  const phase0Path = argValue("phase0", "reports/phase0-final-acceptance-v8.json");
  const fastPath = argValue("fast", "reports/phase3-fast-sim-v38.json");
  const outputPath = argValue(
    "output",
    "reports/post-audit-regression-bridge-v1.json"
  );

  const report = buildRegressionBridgeReport({ phase0Path, fastPath });
  verifyReport(report);
  writeReport(report, outputPath);
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

export { buildRegressionBridgeReport, verifyReport };
