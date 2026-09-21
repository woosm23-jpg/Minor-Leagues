import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seeds = Number(seedArg?.slice(8) ?? 6);
const worker = fileURLToPath(new URL("./verify-season-pitcher-movement-v25.js", import.meta.url));
const rows = [];
const tempFiles = [];
for (let seed = 1; seed <= seeds; seed += 1) {
  const temp = `reports/.phase3-pitcher-movement-v25-seed-${seed}.json`;
  tempFiles.push(temp);
  const args = [worker, "--seeds=1", `--start=${seed}`, `--output=${temp}`, "--quiet"];
  if (verify) args.push("--verify");
  const child = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (child.status !== 0) process.exit(child.status ?? 1);
  const report = JSON.parse(fs.readFileSync(temp, "utf8"));
  rows.push(...report.rows);
  process.stderr.write(`v25 seed ${seed}/${seeds} PASS\n`);
}
for (const temp of tempFiles) fs.rmSync(temp, { force: true });
const report = { version: "v25", seeds, verified: verify, isolatedProcesses: true, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
