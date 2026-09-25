import { seasonApi } from "../api/seasonApi.js";
import { seasonSaveRepository } from "../db/seasonSaveRepository.js";
import { buildSeasonSaveMetadata } from "./seasonSaveMetadata.js";
import { validateSeasonSavePayload } from "./seasonSerialization.js";

async function existingMeta(repository, saveId) {
  if (typeof repository.getMeta === "function") return repository.getMeta(saveId);
  const row = await repository.get(saveId);
  if (!row) return null;
  const { payload: _payload, ...meta } = row;
  return meta;
}

function createSeasonSaveService({ repository = seasonSaveRepository, now = () => new Date().toISOString() } = {}) {
  async function persistPayload(payload, { saveId = payload.seasonId, label = null, extraMetadata = null } = {}) {
    const previous = await existingMeta(repository, saveId);
    const finalLabel = label ?? previous?.label ?? `${payload.fixture.rosters?.[payload.fixture.userTeamId]?.names?.[payload.fixture.userPlayerId] ?? "THE CALL-UP"} 커리어`;
    const preservedExtra = {};
    for (const key of ["importedFrom", "recoveredFrom", "createdAt"]) {
      if (previous?.[key] !== undefined) preservedExtra[key] = previous[key];
    }
    const record = {
      ...buildSeasonSaveMetadata(payload, {
        saveId,
        label: finalLabel,
        updatedAt: now(),
        extra: { ...preservedExtra, ...(extraMetadata ?? {}) }
      }),
      payload
    };
    await repository.put(record);
    return { ...record, payload: undefined };
  }
  return Object.freeze({
    async saveSeason(seasonId, { saveId = seasonId, label = null, extraMetadata = null } = {}) {
      return persistPayload(seasonApi.serializeSeason(seasonId), { saveId, label, extraMetadata });
    },
    async saveSeasonPayload(payload, { saveId = payload?.seasonId, label = null, extraMetadata = null } = {}) {
      // Milestone payloads are captured at the exact action boundary, not on a later idle callback.
      validateSeasonSavePayload(payload, { mode: "FULL" });
      return persistPayload(payload, { saveId, label, extraMetadata });
    },
    async loadSeason(saveId) {
      const record = await repository.get(saveId);
      if (!record) return null;
      return seasonApi.restoreSeason(record.payload);
    },
    async autosaveSeason(seasonId, { saveId = seasonId } = {}) {
      return this.saveSeason(seasonId, { saveId });
    },
    async listSaves() { return repository.list(); },
    async deleteSave(saveId) { return repository.delete(saveId); }
  });
}
const seasonSaveService = createSeasonSaveService();
export { createSeasonSaveService, seasonSaveService };
