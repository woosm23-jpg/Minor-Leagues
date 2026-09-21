import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const DEFAULT_OUTPUT = "reports/v50-1g-current-mvp-gate.json";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const verify = process.argv.includes("--verify");
const outputPath = arg("output", DEFAULT_OUTPUT);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcu-v50-1g-"));

const components = [
  {
    id: "v50.1a",
    title: "organization depth",
    script: "scripts/verify-season-organization-v20.js",
    schema: "THE_CALL_UP_V50_1A_ORGANIZATION_DEPTH",
    args: ["--seeds=1"]
  },
  {
    id: "v50.1b",
    title: "promotion and adjacent movement",
    script: "scripts/verify-season-promotion-ai-v22.js",
    schema: "THE_CALL_UP_V50_1B_PROMOTION_GATE",
    args: []
  },
  {
    id: "v50.1c",
    title: "five-level ladder",
    script: "scripts/verify-season-multi-level-v23.js",
    schema: "THE_CALL_UP_V50_1C_FULL_LADDER_GATE",
    args: ["--seeds=1", "--start=1", "--quiet"]
  },
  {
    id: "v50.1d",
    title: "MLB call-up and replacement",
    script: "scripts/verify-season-mlb-replacement-v24.js",
    schema: "THE_CALL_UP_V50_1D_MLB_CALLUP_REPLACEMENT",
    args: []
  },
  {
    id: "v50.1e",
    title: "injury fatigue form",
    script: "scripts/verify-season-condition.js",
    schema: "THE_CALL_UP_V50_1E_CONDITION_REGRESSION",
    args: []
  },
  {
    id: "v50.1f",
    title: "save checkpoint transfer",
    script: "scripts/verify-season-save-checkpoint-v15.js",
    schema: "THE_CALL_UP_V50_1F_SAVE_TRANSFER_REGRESSION",
    args: []
  }
];

function runComponent(component) {
  const out = path.join(tempDir, `${component.id.replace(".", "-")}.json`);
  const result = spawnSync(
    process.execPath,
    [component.script, "--verify", ...component.args, `--output=${out}`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }
  );

  if (result.status !== 0) {
    const stdout = String(result.stdout ?? "").slice(-12000);
    const stderr = String(result.stderr ?? "").slice(-12000);
    throw new Error(
      `${component.id} ${component.title} gate failed (exit ${result.status})\n` +
      `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
    );
  }

  assert.ok(fs.existsSync(out), `${component.id}: report missing`);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.schema, component.schema, `${component.id}: report schema drift`);
  assert.equal(report.pass, true, `${component.id}: pass flag missing`);
  assert.equal(report.verified, true, `${component.id}: verify flag missing`);
  assert.equal(report.source, "Production Snapshot v2", `${component.id}: source drift`);

  return {
    id: component.id,
    title: component.title,
    script: component.script,
    schema: report.schema,
    pass: report.pass,
    verified: report.verified,
    source: report.source
  };
}

let results;
try {
  results = components.map(runComponent);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.equal(results.length, 6);
assert.ok(results.every((row) => row.pass && row.verified));

const report = {
  schema: "THE_CALL_UP_V50_1G_CURRENT_MVP_GATE",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  componentCount: results.length,
  components: results,
  invariants: {
    allFocusedGatesPassed: true,
    productionSnapshotV2: true,
    fiveLevelOrganization: true,
    promotionAndCallupRegression: true,
    injuryFatigueFormRegression: true,
    saveCheckpointTransferRegression: true
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
