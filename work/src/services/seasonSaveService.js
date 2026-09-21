import { seasonApi } from "../api/seasonApi.js";
import { seasonSaveRepository } from "../db/seasonSaveRepository.js";
import { buildSeasonSaveMetadata } from "./seasonSaveMetadata.js";

async function existingMeta(repository, saveId) {
  if (typeof repository.getMeta === "function") return repository.getMeta(saveId);
  const row = await repository.get(saveId);
  if (!row) return null;
  const { payload: _payload, ...meta } = row;
  return meta;
}

function createSeasonSaveService({ repository = seasonSaveRepository, now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    async saveSeason(seasonId, { saveId = seasonId, label = null, extraMetadata = null } = {}) {
      const payload = seasonApi.serializeSeason(seasonId);
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
    },

    async loadSeason(saveId) {
      const record = await repository.get(saveId);
      if (!record) return null;
      return seasonApi.restoreSeason(record.payload);
    },

    async autosaveSeason(seasonId, { saveId = seasonId } = {}) {
      return this.saveSeason(seasonId, { saveId });
    },

    async listSaves() {
      return repository.list();
    },

    async deleteSave(saveId) {
      return repository.delete(saveId);
    }
  });
}

const seasonSaveService = createSeasonSaveService();

export { createSeasonSaveService, seasonSaveService };
