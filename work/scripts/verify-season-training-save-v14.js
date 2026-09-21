import fs from "node:fs";
import process from "node:process";
import { seasonApi } from "../src/api/seasonApi.js";

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const focuses = ["CONTACT", "POWER", "PLATE_DISCIPLINE", "DEFENSE", "SPEED", "CONTACT"];
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  let season = seasonApi.createDemoSeason({ seed: `v14-long-${i + 1}`, startDate: "2026-04-01" });
  const focus = focuses[i % focuses.length];
  season = seasonApi.setTrainingFocus(season.seasonId, focus);
  season = seasonApi.simulateToSeasonEnd(season.seasonId);
  const dev = season.userPlayer.status.development;
  const maxGain = Math.max(...Object.values(dev.gains));
  const allPitchersUnavailable = season.pitchingStaff.every((p) => p.availability === "UNAVAILABLE");
  const maxPitcherFatigue = Math.max(...season.pitchingStaff.map((p) => p.fatigue));
  const row = {
    seed: i + 1,
    focus,
    status: season.status,
    record: `${season.record.W}-${season.record.L}`,
    userGames: season.userSeasonLine.G,
    restGames: season.userRole.restGames,
    leagueGames: season.progress.leagueGamesCompleted,
    userFatigue: season.userPlayer.status.fatigue,
    userForm: season.userPlayer.status.form,
    maxGain,
    maxPitcherFatigue,
    allPitchersUnavailable,
    leaderCounts: Object.fromEntries(["AVG", "OPS", "HR", "RBI", "SB"].map((key) => [key, season.leaders[key].length]))
  };
  rows.push(row);

  if (verify) {
    if (season.status !== "COMPLETE") throw new Error(`seed ${i + 1}: season incomplete`);
    if (season.progress.gamesPlayed !== 28 || season.progress.leagueGamesCompleted !== 112) throw new Error(`seed ${i + 1}: schedule incomplete`);
    if (season.userSeasonLine.G < 24 || season.userSeasonLine.G > 28) throw new Error(`seed ${i + 1}: rest-day range broken`);
    if (season.userPlayer.status.fatigue >= 100) throw new Error(`seed ${i + 1}: user fatigue stuck at 100`);
    if (Math.abs(season.userPlayer.status.form) > 1) throw new Error(`seed ${i + 1}: form out of bounds`);
    if (allPitchersUnavailable) throw new Error(`seed ${i + 1}: pitcher readiness stuck unavailable`);
    if (maxGain > 3) throw new Error(`seed ${i + 1}: development gain exploded (${maxGain})`);
    for (const key of ["HR", "OPS"]) if (season.leaders[key].length === 0) throw new Error(`seed ${i + 1}: leaderboard ${key} empty`);
  }
}

const report = { version: "v14", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
