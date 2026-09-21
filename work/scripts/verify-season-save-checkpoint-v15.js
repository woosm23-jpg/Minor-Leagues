import fs from "node:fs";
import process from "node:process";
import { seasonApi } from "../src/api/seasonApi.js";
import { migrateSeasonSavePayload, validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const focuses = ["CONTACT", "POWER", "PLATE_DISCIPLINE", "DEFENSE", "SPEED", "CONTACT"];
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  let season = seasonApi.createDemoSeason({ seed: `v15-long-${i + 1}`, startDate: "2026-04-01" });
  const focus = focuses[i % focuses.length];
  season = seasonApi.setTrainingFocus(season.seasonId, focus);

  season = seasonApi.startCurrentGame(season.seasonId);
  if (!season.activeGame) throw new Error(`seed ${i + 1}: interactive appearance를 시작하지 못했습니다.`);
  season = seasonApi.playUserPA(season.seasonId, "AGGRESSIVE");
  const checkpointPayload = seasonApi.serializeSeason(season.seasonId);
  const checkpointed = Boolean(checkpointPayload.activeGameCheckpoint);
  const checkpointCounter = checkpointPayload.activeGameCheckpoint?.rng?.counter ?? null;

  const expectedContinuation = seasonApi.playUserPA(season.seasonId, "CONTACT");
  seasonApi.restoreSeason(checkpointPayload);
  const actualContinuation = seasonApi.playUserPA(checkpointPayload.seasonId, "CONTACT");
  const deterministicContinuation = JSON.stringify(expectedContinuation) === JSON.stringify(actualContinuation);

  const currentPayload = seasonApi.serializeSeason(checkpointPayload.seasonId);
  const legacy = structuredClone(currentPayload);
  legacy.schemaVersion = 1;
  legacy.gameVersion = "phase2_training_save_v14";
  legacy.activeGame = null;
  delete legacy.activeGameCheckpoint;
  delete legacy.activeScheduleGameId;
  const migrated = migrateSeasonSavePayload(legacy);
  const migrationPass = migrated.schemaVersion === 2 && validateSeasonSavePayload(legacy, { mode: "FULL" });

  season = seasonApi.simulateToSeasonEnd(checkpointPayload.seasonId);
  const dev = season.userPlayer.status.development;
  const maxGain = Math.max(...Object.values(dev.gains));
  const allPitchersUnavailable = season.pitchingStaff.every((p) => p.availability === "UNAVAILABLE");
  const maxPitcherFatigue = Math.max(...season.pitchingStaff.map((p) => p.fatigue));
  const row = {
    seed: i + 1,
    focus,
    checkpointed,
    checkpointCounter,
    deterministicContinuation,
    migrationPass,
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
    if (!checkpointed || !Number.isSafeInteger(checkpointCounter) || checkpointCounter <= 0) throw new Error(`seed ${i + 1}: checkpoint RNG state missing`);
    if (!deterministicContinuation) throw new Error(`seed ${i + 1}: checkpoint continuation mismatch`);
    if (!migrationPass) throw new Error(`seed ${i + 1}: v14 migration failed`);
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

const report = { version: "v15", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
