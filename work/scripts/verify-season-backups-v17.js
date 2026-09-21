import fs from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonBackupService } from "../src/services/seasonBackupService.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

function memoryRepository(keyField) {
  const store = new Map();
  return {
    async put(record) { store.set(record[keyField], structuredClone(record)); return record; },
    async get(key) { return store.has(key) ? structuredClone(store.get(key)) : null; },
    async list() { return [...store.values()].map(({ payload: _payload, ...meta }) => structuredClone(meta)); },
    async listBySaveId(saveId) {
      return [...store.values()].filter((row) => row.saveId === saveId)
        .map(({ payload: _payload, ...meta }) => structuredClone(meta))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.backupId).localeCompare(String(a.backupId)));
    },
    async delete(key) { return store.delete(key); },
    size() { return store.size; }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const focuses = ["CONTACT", "POWER", "PLATE_DISCIPLINE", "DEFENSE", "SPEED", "CONTACT"];
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const saveRepository = memoryRepository("saveId");
  const backupRepository = memoryRepository("backupId");
  let tick = 0;
  const now = () => `2026-09-19T07:${String(i).padStart(2, "0")}:${String(tick++).padStart(2, "0")}.000Z`;
  const saveService = createSeasonSaveService({ repository: saveRepository, now });
  const backupService = createSeasonBackupService({ backupRepository, saveRepository, now });
  const sourceSaveId = `v17-source-${i + 1}`;

  let season = seasonApi.createDemoSeason({ seed: `v17-long-${i + 1}`, startDate: "2026-04-01" });
  season = seasonApi.setTrainingFocus(season.seasonId, focuses[i % focuses.length]);
  await saveService.saveSeason(season.seasonId, { saveId: sourceSaveId, label: `Seed ${i + 1}` });
  const opening = await backupService.createMilestoneBackup(season.seasonId, { saveId: sourceSaveId, milestone: "OPENING_DAY" });

  season = seasonApi.startCurrentGame(season.seasonId);
  season = seasonApi.playUserPA(season.seasonId, "PATIENT");
  await saveService.autosaveSeason(season.seasonId, { saveId: sourceSaveId });
  const checkpointPresent = Boolean((await saveRepository.get(sourceSaveId))?.payload?.activeGameCheckpoint);

  season = seasonApi.simulateToSeasonEnd(season.seasonId);
  await saveService.autosaveSeason(season.seasonId, { saveId: sourceSaveId });
  const seasonEnd = await backupService.createMilestoneBackup(season.seasonId, { saveId: sourceSaveId, milestone: "SEASON_END" });
  const backups = await backupService.listBackups(sourceSaveId);
  const openingRecord = await backupRepository.get(opening.backupId);
  const endRecord = await backupRepository.get(seasonEnd.backupId);
  const sourceBeforeRecovery = await saveRepository.get(sourceSaveId);

  const recovered = await backupService.restoreBackupAsCopy(opening.backupId);
  const sourceAfterRecovery = await saveRepository.get(sourceSaveId);
  const sourceUntouched = JSON.stringify(sourceBeforeRecovery) === JSON.stringify(sourceAfterRecovery);
  const recoveryStartsOpeningDay = recovered.snapshot.progress.gamesPlayed === 0 && recovered.snapshot.record.W + recovered.snapshot.record.L === 0;
  let recoveredSeason = seasonApi.simulateToSeasonEnd(recovered.snapshot.seasonId);
  await saveService.autosaveSeason(recoveredSeason.seasonId, { saveId: recovered.meta.saveId });

  const dev = recoveredSeason.userPlayer.status.development;
  const maxGain = Math.max(...Object.values(dev.gains));
  const allPitchersUnavailable = recoveredSeason.pitchingStaff.every((p) => p.availability === "UNAVAILABLE");
  const row = {
    seed: i + 1,
    sourceSaveId,
    openingBackupId: opening.backupId,
    seasonEndBackupId: seasonEnd.backupId,
    backupCount: backups.length,
    backupMilestones: backups.map((backup) => backup.milestone).sort(),
    checkpointPresent,
    openingFullValid: validateSeasonSavePayload(openingRecord.payload, { mode: "FULL" }),
    seasonEndFullValid: validateSeasonSavePayload(endRecord.payload, { mode: "FULL" }),
    seasonEndStatus: endRecord.payload.season.status,
    seasonEndLeagueGames: endRecord.payload.season.completedGames,
    recoverySaveId: recovered.meta.saveId,
    recoveryStartsOpeningDay,
    sourceUntouched,
    recoveredStatus: recoveredSeason.status,
    recoveredUserGames: recoveredSeason.progress.gamesPlayed,
    recoveredLeagueGames: recoveredSeason.progress.leagueGamesCompleted,
    restGames: recoveredSeason.userRole.restGames,
    userFatigue: recoveredSeason.userPlayer.status.fatigue,
    maxGain,
    allPitchersUnavailable,
    leaderCounts: Object.fromEntries(["AVG", "OPS", "HR", "RBI", "SB"].map((key) => [key, recoveredSeason.leaders[key].length]))
  };
  rows.push(row);

  if (verify) {
    if (!checkpointPresent) throw new Error(`seed ${i + 1}: main autosave lost active checkpoint`);
    if (backups.length !== 2 || !backups.some((b) => b.milestone === "OPENING_DAY") || !backups.some((b) => b.milestone === "SEASON_END")) throw new Error(`seed ${i + 1}: milestone backup set broken`);
    if (!row.openingFullValid || !row.seasonEndFullValid) throw new Error(`seed ${i + 1}: backup Full Validation failed`);
    if (row.seasonEndStatus !== "COMPLETE" || row.seasonEndLeagueGames !== 112) throw new Error(`seed ${i + 1}: season-end backup incomplete`);
    if (!recoveryStartsOpeningDay || !sourceUntouched || recovered.meta.saveId === sourceSaveId) throw new Error(`seed ${i + 1}: recovery copy safety failed`);
    if (recoveredSeason.status !== "COMPLETE" || recoveredSeason.progress.gamesPlayed !== 28 || recoveredSeason.progress.leagueGamesCompleted !== 112) throw new Error(`seed ${i + 1}: recovered season incomplete`);
    if (recoveredSeason.userSeasonLine.G < 24 || recoveredSeason.userSeasonLine.G > 28) throw new Error(`seed ${i + 1}: rest-day range broken`);
    if (recoveredSeason.userPlayer.status.fatigue >= 100) throw new Error(`seed ${i + 1}: user fatigue stuck at 100`);
    if (allPitchersUnavailable) throw new Error(`seed ${i + 1}: pitcher readiness stuck unavailable`);
    if (maxGain > 3) throw new Error(`seed ${i + 1}: development gain exploded (${maxGain})`);
    for (const key of ["HR", "OPS"]) if (recoveredSeason.leaders[key].length === 0) throw new Error(`seed ${i + 1}: leaderboard ${key} empty`);
  }
}

const report = { version: "v17", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
