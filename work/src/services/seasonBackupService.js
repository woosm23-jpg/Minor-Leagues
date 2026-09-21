import { seasonApi } from "../api/seasonApi.js";
import { seasonBackupRepository } from "../db/seasonBackupRepository.js";
import { seasonSaveRepository } from "../db/seasonSaveRepository.js";
import { migrateSeasonSavePayload, validateSeasonSavePayload } from "./seasonSerialization.js";
import { buildSeasonSaveMetadata } from "./seasonSaveMetadata.js";

const SEASON_BACKUP_MILESTONES = Object.freeze(["OPENING_DAY", "OFFSEASON_START", "SEASON_END"]);
const SEASON_BACKUP_RETENTION = 6;

function assertMilestone(milestone) {
  if (!SEASON_BACKUP_MILESTONES.includes(milestone)) throw new RangeError(`지원하지 않는 backup milestone입니다: ${milestone}`);
}

function safePart(value) {
  return encodeURIComponent(String(value ?? "save")).replaceAll("%", "_").slice(0, 120);
}

function backupIdFor(saveId, milestone, currentDate) {
  return `backup_${safePart(saveId)}_${milestone}_${currentDate}`;
}

function compactTimestamp(iso) {
  return String(iso).replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function uniqueRecoverySaveId(saveRepository, sourceSaveId, backupId, nowIso) {
  const base = `recovery_${safePart(sourceSaveId)}_${compactTimestamp(nowIso)}_${safePart(backupId).slice(-28)}`;
  let candidate = base;
  for (let index = 1; index <= 100; index += 1) {
    if (!(await saveRepository.get(candidate))) return candidate;
    candidate = `${base}_${index + 1}`;
  }
  throw new RangeError("백업 복구용 새 saveId를 만들 수 없습니다.");
}

function defaultLabel(milestone) {
  return ({
    OPENING_DAY: "오프닝 데이",
    OFFSEASON_START: "오프시즌 시작",
    SEASON_END: "시즌 종료"
  })[milestone] ?? milestone;
}

function createSeasonBackupService({
  api = seasonApi,
  backupRepository = seasonBackupRepository,
  saveRepository = seasonSaveRepository,
  now = () => new Date().toISOString(),
  retention = SEASON_BACKUP_RETENTION
} = {}) {
  if (!Number.isInteger(retention) || retention < 1) throw new RangeError("backup retention은 1 이상의 정수여야 합니다.");

  return Object.freeze({
    async createMilestoneBackup(seasonId, { saveId = seasonId, milestone, label = null } = {}) {
      assertMilestone(milestone);
      const payload = api.serializeSeason(seasonId);
      validateSeasonSavePayload(payload, { mode: "FULL" });
      const createdAt = now();
      const currentDate = payload.season.currentDate;
      const record = {
        backupId: backupIdFor(saveId, milestone, currentDate),
        saveId,
        seasonId: payload.seasonId,
        milestone,
        label: label ?? defaultLabel(milestone),
        createdAt,
        currentDate,
        schemaVersion: payload.schemaVersion,
        gameVersion: payload.gameVersion,
        status: payload.season.status,
        hasActiveGame: Boolean(payload.activeGameCheckpoint),
        payload
      };
      await backupRepository.put(record);

      const rows = await backupRepository.listBySaveId(saveId);
      for (const stale of rows.slice(retention)) await backupRepository.delete(stale.backupId);
      return { ...record, payload: undefined };
    },

    async listBackups(saveId) {
      return backupRepository.listBySaveId(saveId);
    },

    async deleteBackupsForSave(saveId) {
      if (typeof backupRepository.deleteBySaveId === "function") return backupRepository.deleteBySaveId(saveId);
      const rows = await backupRepository.listBySaveId(saveId);
      for (const row of rows) await backupRepository.delete(row.backupId);
      return rows.length;
    },

    async restoreBackupAsCopy(backupId, { label = null } = {}) {
      const backup = await backupRepository.get(backupId);
      if (!backup) return null;
      const migrated = migrateSeasonSavePayload(backup.payload);
      validateSeasonSavePayload(migrated, { mode: "FULL" });
      const restoredAt = now();
      const saveId = await uniqueRecoverySaveId(saveRepository, backup.saveId, backup.backupId, restoredAt);
      const recoveredFrom = {
        backupId: backup.backupId,
        sourceSaveId: backup.saveId,
        milestone: backup.milestone,
        createdAt: backup.createdAt
      };
      const record = {
        ...buildSeasonSaveMetadata(migrated, {
          saveId,
          label: label ?? `${backup.label ?? "마일스톤"} 복구본`,
          updatedAt: restoredAt,
          extra: { recoveredFrom, createdAt: restoredAt }
        }),
        payload: migrated
      };
      await saveRepository.put(record);
      return { meta: { ...record, payload: undefined }, snapshot: api.restoreSeason(migrated) };
    }
  });
}

const seasonBackupService = createSeasonBackupService();

export { SEASON_BACKUP_MILESTONES, SEASON_BACKUP_RETENTION, createSeasonBackupService, seasonBackupService };
