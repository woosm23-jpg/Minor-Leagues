import fs from "node:fs";
import process from "node:process";
import { seasonApi } from "../src/api/seasonApi.js";

const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seeds = Number(process.argv.find((arg) => arg.startsWith("--seeds="))?.split("=")[1] ?? 6);
const rows = [];

for (let i = 0; i < seeds; i += 1) {
  let season = seasonApi.createDemoSeason({ seed: `phase2-condition-v12-${i + 1}`, startDate: "2026-04-01" });
  let maxFatigue = 0;
  let minForm = 1;
  let maxForm = -1;
  while (season.status !== "COMPLETE") {
    season = seasonApi.simulateCurrentGame(season.seasonId);
    maxFatigue = Math.max(maxFatigue, season.userPlayer.status.fatigue);
    minForm = Math.min(minForm, season.userPlayer.status.form);
    maxForm = Math.max(maxForm, season.userPlayer.status.form);
  }
  rows.push({
    seed: i + 1,
    record: `${season.record.W}-${season.record.L}`,
    games: season.progress.gamesPlayed,
    maxFatigue,
    finalFatigue: season.userPlayer.status.fatigue,
    minForm,
    maxForm,
    finalForm: season.userPlayer.status.form,
    developmentGains: season.userPlayer.status.development.gains,
    developmentProgress: season.userPlayer.status.development.progress,
    batting: {
      AVG: season.userSeasonLine.AVG,
      OBP: season.userSeasonLine.OBP,
      SLG: season.userSeasonLine.SLG,
      HR: season.userSeasonLine.HR,
      PA: season.userSeasonLine.PA
    }
  });
}

const summary = {
  version: "phase2-season-condition-v12",
  seeds,
  rows,
  aggregate: {
    maxFatigue: Math.max(...rows.map((r) => r.maxFatigue)),
    minObservedForm: Math.min(...rows.map((r) => r.minForm)),
    maxObservedForm: Math.max(...rows.map((r) => r.maxForm)),
    maxTotalRatingGains: Math.max(...rows.map((r) => Object.values(r.developmentGains).reduce((a, b) => a + b, 0)))
  }
};

if (verify) {
  const failures = [];
  for (const row of rows) {
    if (row.games !== 28) failures.push(`seed ${row.seed}: season games ${row.games}`);
    if (row.maxFatigue > 80) failures.push(`seed ${row.seed}: max fatigue ${row.maxFatigue}`);
    if (row.minForm < -1 || row.maxForm > 1) failures.push(`seed ${row.seed}: form outside [-1,1]`);
    const totalGains = Object.values(row.developmentGains).reduce((a, b) => a + b, 0);
    if (totalGains > 4) failures.push(`seed ${row.seed}: excessive 28-game development gains ${totalGains}`);
  }
  summary.acceptance = { pass: failures.length === 0, failures };
  if (failures.length) process.exitCode = 1;
}

const json = JSON.stringify(summary, null, 2);
if (outputArg) {
  const path = outputArg.slice("--output=".length);
  fs.writeFileSync(path, `${json}\n`);
  console.log(path);
} else console.log(json);
