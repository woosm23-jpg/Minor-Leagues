import fs from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonBackupService } from "../src/services/seasonBackupService.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

function saveRepository() {
  const store = new Map();
  return {
    async put(record) { store.set(record.saveId, structuredClone(record)); return record; },
    async get(id) { return store.has(id) ? structuredClone(store.get(id)) : null; },
    async getMeta(id) {
      const row = store.get(id); if (!row) return null;
      const { payload: _payload, ...meta } = row; return structuredClone(meta);
    },
    async list() {
      return [...store.values()].map(({ payload: _payload, ...meta }) => structuredClone(meta))
        .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    async delete(id) { return store.delete(id); }
  };
}

function backupRepository() {
  const store = new Map();
  return {
    async put(record) { store.set(record.backupId, structuredClone(record)); return record; },
    async get(id) { return store.has(id) ? structuredClone(store.get(id)) : null; },
    async listBySaveId(saveId) { return [...store.values()].filter((r)=>r.saveId===saveId).map(({payload:_p,...m})=>structuredClone(m)); },
    async delete(id) { return store.delete(id); },
    async deleteBySaveId(saveId) { let n=0; for (const [id,row] of [...store]) if(row.saveId===saveId){store.delete(id);n++;} return n; }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const savesRepo = saveRepository();
  const backupsRepo = backupRepository();
  let tick = 0;
  const now = () => `2026-09-19T08:${String(i).padStart(2,"0")}:${String(tick++).padStart(2,"0")}.000Z`;
  const saveService = createSeasonSaveService({ repository: savesRepo, now });
  const backupService = createSeasonBackupService({ backupRepository: backupsRepo, saveRepository: savesRepo, now });

  let a = seasonApi.createDemoSeason({ seed: `v18-a-${i+1}`, startDate: "2026-04-01" });
  let b = seasonApi.createDemoSeason({ seed: `v18-b-${i+1}`, startDate: "2026-04-01" });
  const slotA = `career-a-${i+1}`, slotB = `career-b-${i+1}`;
  await saveService.saveSeason(a.seasonId, { saveId: slotA, label: `A ${i+1}`, extraMetadata: { createdAt: now() } });
  await saveService.saveSeason(b.seasonId, { saveId: slotB, label: `B ${i+1}`, extraMetadata: { createdAt: now() } });
  await backupService.createMilestoneBackup(a.seasonId, { saveId: slotA, milestone: "OPENING_DAY" });
  await backupService.createMilestoneBackup(b.seasonId, { saveId: slotB, milestone: "OPENING_DAY" });

  a = seasonApi.simulateCurrentGame(a.seasonId);
  await saveService.autosaveSeason(a.seasonId, { saveId: slotA });

  b = seasonApi.startCurrentGame(b.seasonId);
  b = seasonApi.playUserPA(b.seasonId, "PATIENT");
  await saveService.autosaveSeason(b.seasonId, { saveId: slotB });
  const bPayload = (await savesRepo.get(slotB)).payload;
  const expectedB = seasonApi.playUserPA(b.seasonId, "CONTACT");
  const reloadedB = await saveService.loadSeason(slotB);
  const actualB = seasonApi.playUserPA(reloadedB.seasonId, "CONTACT");
  const checkpointDeterministic = JSON.stringify(actualB) === JSON.stringify(expectedB);

  const listed = await saveService.listSaves();
  const lightweight = listed.every((meta) => !("payload" in meta));
  const labelsStable = listed.some((m)=>m.saveId===slotA && m.label===`A ${i+1}`) && listed.some((m)=>m.saveId===slotB && m.label===`B ${i+1}`);
  const independentBefore = listed.find((m)=>m.saveId===slotA)?.gamesPlayed === 1 && listed.find((m)=>m.saveId===slotB)?.gamesPlayed === 0;

  const loadedA = await saveService.loadSeason(slotA);
  a = seasonApi.simulateToSeasonEnd(loadedA.seasonId);
  await saveService.autosaveSeason(a.seasonId, { saveId: slotA });
  const endBackup = await backupService.createMilestoneBackup(a.seasonId, { saveId: slotA, milestone: "SEASON_END" });
  const endRecord = await backupsRepo.get(endBackup.backupId);
  const finalMeta = (await saveService.listSaves()).find((m)=>m.saveId===slotA);

  const deletedBackups = await backupService.deleteBackupsForSave(slotB);
  await saveService.deleteSave(slotB);
  const afterDelete = await saveService.listSaves();

  const row = {
    seed: i+1,
    metadataCountBeforeDelete: listed.length,
    lightweight,
    labelsStable,
    independentBefore,
    checkpointPresent: Boolean(bPayload.activeGameCheckpoint),
    checkpointDeterministic,
    finalStatus: a.status,
    finalGames: a.progress.gamesPlayed,
    finalLeagueGames: a.progress.leagueGamesCompleted,
    finalMetaGames: finalMeta?.gamesPlayed ?? null,
    finalMetaRecord: `${finalMeta?.wins ?? 0}-${finalMeta?.losses ?? 0}`,
    seasonEndFullValid: validateSeasonSavePayload(endRecord.payload, { mode: "FULL" }),
    deletedBackups,
    slotsAfterDelete: afterDelete.map((m)=>m.saveId)
  };
  rows.push(row);

  if (verify) {
    if (listed.length !== 2 || !lightweight || !labelsStable || !independentBefore) throw new Error(`seed ${i+1}: multi-career metadata broken`);
    if (!row.checkpointPresent || !checkpointDeterministic) throw new Error(`seed ${i+1}: active checkpoint continuation broken`);
    if (a.status !== "COMPLETE" || a.progress.gamesPlayed !== 28 || a.progress.leagueGamesCompleted !== 112) throw new Error(`seed ${i+1}: season completion broken`);
    if (finalMeta?.gamesPlayed !== 28 || !row.seasonEndFullValid) throw new Error(`seed ${i+1}: final metadata/backup broken`);
    if (deletedBackups < 1 || afterDelete.length !== 1 || afterDelete[0].saveId !== slotA) throw new Error(`seed ${i+1}: career deletion isolation broken`);
  }
}

const report = { version: "v18", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
