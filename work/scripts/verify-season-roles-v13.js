import fs from "node:fs";
import process from "node:process";
import { seasonApi } from "../src/api/seasonApi.js";

const seedsArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = seedsArg ? Number(seedsArg.split("=")[1]) : 6;
const results = [];

for (let i = 1; i <= seedCount; i += 1) {
  let season = seasonApi.createDemoSeason({ seed: `phase2-v13-${i}`, startDate: "2026-04-01" });
  let limitedObservations = 0, unavailableObservations = 0, maxPitcherFatigue = 0, steps = 0;
  while (season.status !== "COMPLETE") {
    season = seasonApi.simulateCurrentGame(season.seasonId);
    for (const pitcher of season.pitchingStaff) {
      maxPitcherFatigue = Math.max(maxPitcherFatigue, pitcher.fatigue);
      if (pitcher.availability === "LIMITED") limitedObservations += 1;
      if (pitcher.availability === "UNAVAILABLE") unavailableObservations += 1;
    }
    if (++steps > 40) throw new RangeError("v13 시즌 완주가 안전 한도를 초과했습니다.");
  }
  results.push({
    seed: i,
    userGames: season.userSeasonLine.G,
    restGames: season.userRole.restGames,
    record: { W: season.record.W, L: season.record.L },
    limitedObservations,
    unavailableObservations,
    maxPitcherFatigue,
    leaderCounts: Object.fromEntries(["AVG","OPS","HR","RBI","SB"].map((key) => [key, season.leaders[key].length])),
    qualificationPA: season.leaders.qualificationPA,
    topHR: season.leaders.HR[0]?.value ?? 0,
    topOPS: season.leaders.OPS[0]?.value ?? 0
  });
}

const acceptance = {
  allSeasonsComplete: results.every((r) => r.userGames + r.restGames === 28),
  restAIActiveButLimited: results.every((r) => r.restGames >= 1 && r.restGames <= 4),
  bullpenCarryOverObserved: results.every((r) => r.limitedObservations > 0),
  bullpenNotPermanentlyLocked: results.every((r) => r.unavailableObservations < 14),
  pitcherFatigueBounded: results.every((r) => r.maxPitcherFatigue <= 100),
  leadersPopulated: results.every((r) => Object.values(r.leaderCounts).every((count) => count >= 3))
};
const report = { version: "phase2-v13", seedCount, acceptance, pass: Object.values(acceptance).every(Boolean), results };
const output = outputArg ? outputArg.split("=")[1] : null;
if (output) { fs.mkdirSync(new URL("../reports/", import.meta.url), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
if (verify && !report.pass) process.exitCode = 1;
