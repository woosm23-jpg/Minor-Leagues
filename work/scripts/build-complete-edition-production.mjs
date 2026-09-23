import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");
const MASTER_SNAPSHOT = "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";
const DEFAULT_OUTPUT = "dist/THE_CALL_UP_COMPLETE_EDITION.html";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function buildCompleteEditionProduction({ output = DEFAULT_OUTPUT } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(WORK_ROOT, "scripts/build-standalone.mjs"),
      `--master-snapshot=${MASTER_SNAPSHOT}`,
      `--output=${output}`
    ],
    { cwd: WORK_ROOT, encoding: "utf8", stdio: "pipe" }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Complete Edition Production build failed: exit ${result.status}`);
  return { masterSnapshot: MASTER_SNAPSHOT, output };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    buildCompleteEditionProduction({ output: argValue("output", DEFAULT_OUTPUT) });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { MASTER_SNAPSHOT, DEFAULT_OUTPUT, buildCompleteEditionProduction };
