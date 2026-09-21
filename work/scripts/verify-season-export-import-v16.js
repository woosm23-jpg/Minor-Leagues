import fs from "node:fs";
import process from "node:process";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonTransferService, computeTcuChecksum, validateTcuExportDocument } from "../src/services/seasonTransferService.js";

function memoryRepository() {
  const store = new Map();
  let puts = 0;
  return {
    async put(record) { puts += 1; store.set(record.saveId, structuredClone(record)); return record; },
    async get(saveId) { return store.has(saveId) ? structuredClone(store.get(saveId)) : null; },
    async list() { return [...store.values()].map(({ payload: _payload, ...meta }) => structuredClone(meta)); },
    async delete(saveId) { return store.delete(saveId); },
    stats() { return { puts, size: store.size }; }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const focuses = ["CONTACT", "POWER", "PLATE_DISCIPLINE", "DEFENSE", "SPEED", "CONTACT"];
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const repository = memoryRepository();
  let nowCounter = 0;
  const transfer = createSeasonTransferService({
    repository,
    now: () => `2026-09-19T04:${String(i).padStart(2, "0")}:${String(nowCounter++).padStart(2, "0")}.000Z`
  });
  const sourceSaveId = `v16-source-${i + 1}`;
  let season = seasonApi.createDemoSeason({ seed: `v16-long-${i + 1}`, startDate: "2026-04-01" });
  const focus = focuses[i % focuses.length];
  season = seasonApi.setTrainingFocus(season.seasonId, focus);
  season = seasonApi.startCurrentGame(season.seasonId);
  season = seasonApi.playUserPA(season.seasonId, "AGGRESSIVE");

  const exported = transfer.exportSeason(season.seasonId, { saveId: sourceSaveId, label: `Seed ${i + 1}` });
  const exportDocument = JSON.parse(exported.text);
  const checksumPass = validateTcuExportDocument(exportDocument) && exported.checksum === computeTcuChecksum(exportDocument);
  const checkpointCounter = exportDocument.career.activeGameCheckpoint?.rng?.counter ?? null;

  const expectedContinuation = seasonApi.playUserPA(season.seasonId, "CONTACT");
  const imported = await transfer.importAndLoadSeason(exported.text);
  const copyPass = imported.meta.saveId !== sourceSaveId && imported.meta.importedFrom?.sourceSaveId === sourceSaveId;
  const actualContinuation = seasonApi.playUserPA(imported.snapshot.seasonId, "CONTACT");
  const deterministicContinuation = JSON.stringify(expectedContinuation) === JSON.stringify(actualContinuation);

  const putsBeforeCorrupt = repository.stats().puts;
  const corrupt = structuredClone(exportDocument);
  corrupt.career.playerStateDate = "2026-04-02";
  let corruptRejected = false;
  try {
    await transfer.importSeasonText(JSON.stringify(corrupt));
  } catch (error) {
    corruptRejected = /checksum/.test(String(error?.message ?? error));
  }
  const corruptNoWrite = repository.stats().puts === putsBeforeCorrupt;

  season = seasonApi.simulateToSeasonEnd(imported.snapshot.seasonId);
  const dev = season.userPlayer.status.development;
  const maxGain = Math.max(...Object.values(dev.gains));
  const allPitchersUnavailable = season.pitchingStaff.every((p) => p.availability === "UNAVAILABLE");
  const maxPitcherFatigue = Math.max(...season.pitchingStaff.map((p) => p.fatigue));
  const row = {
    seed: i + 1,
    focus,
    filename: exported.filename,
    checksum: exported.checksum,
    checksumPass,
    checkpointCounter,
    copySaveId: imported.meta.saveId,
    copyPass,
    deterministicContinuation,
    corruptRejected,
    corruptNoWrite,
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
    if (!checksumPass) throw new Error(`seed ${i + 1}: export checksum validation failed`);
    if (!Number.isSafeInteger(checkpointCounter) || checkpointCounter <= 0) throw new Error(`seed ${i + 1}: exported checkpoint RNG missing`);
    if (!copyPass) throw new Error(`seed ${i + 1}: import-as-copy failed`);
    if (!deterministicContinuation) throw new Error(`seed ${i + 1}: imported checkpoint continuation mismatch`);
    if (!corruptRejected || !corruptNoWrite) throw new Error(`seed ${i + 1}: corrupt import guard failed`);
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

const report = { version: "v16", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
