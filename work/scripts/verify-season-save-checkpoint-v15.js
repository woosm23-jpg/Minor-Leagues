import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";
import {
  createSeasonTransferService,
  computeTcuChecksum,
  validateTcuExportDocument
} from "../src/services/seasonTransferService.js";
import { validateSeasonSavePayload, seasonSaveFormat } from "../src/services/seasonSerialization.js";

const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1f-save-transfer-regression.json";
const LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function loadSnapshot(path) {
  const bytes = fs.readFileSync(path);
  const text = path.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(text);
}

function memoryRepository() {
  const store = new Map();
  let puts = 0;
  return {
    async put(record) {
      puts += 1;
      store.set(record.saveId, structuredClone(record));
      return structuredClone(record);
    },
    async get(saveId) {
      return store.has(saveId) ? structuredClone(store.get(saveId)) : null;
    },
    async getMeta(saveId) {
      const row = store.get(saveId);
      if (!row) return null;
      const { payload: _payload, ...meta } = row;
      return structuredClone(meta);
    },
    async list() {
      return [...store.values()]
        .map(({ payload: _payload, ...meta }) => structuredClone(meta))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.saveId).localeCompare(String(b.saveId)));
    },
    async delete(saveId) {
      return store.delete(saveId);
    },
    stats() {
      return { puts, size: store.size };
    }
  };
}

function assertFiveLevelProduction(payload, label) {
  assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL", `${label}: worldMode drift`);
  assert.deepEqual(payload.fixture.organization.levelOrder, LEVELS, `${label}: organization level order drift`);
  assert.deepEqual(
    Object.keys(payload.levelSeasons ?? {}).filter((level) => LEVELS.includes(level)).sort(),
    [...LEVELS].sort(),
    `${label}: serialized five-level season set drift`
  );
  assert.deepEqual(
    Object.keys(payload.fixture.levelLeagues ?? {}).filter((level) => LEVELS.includes(level)).sort(),
    [...LEVELS].sort(),
    `${label}: fixture five-level league set drift`
  );
  assert.ok(payload.fixture.organization.levels[payload.fixture.organization.userLevel].roster.players?.[payload.fixture.userPlayerId],
    `${label}: user missing from assigned organization level`);
}

function normalizeForContinuation(snapshot) {
  const cloned = structuredClone(snapshot);
  delete cloned.lastProgress;
  return cloned;
}

function resolveRunningIfNeeded(snapshot) {
  if (snapshot.activeGame?.userRunningDecision) {
    return seasonApi.resolveUserRunningDecision(snapshot.seasonId, "HOLD");
  }
  return snapshot;
}

function playDeterministicAction(seasonId, approach = "CONTACT") {
  let snapshot = seasonApi.getSeason(seasonId);
  snapshot = resolveRunningIfNeeded(snapshot);
  if (snapshot.status === "COMPLETE") return snapshot;
  return seasonApi.playUserPA(seasonId, approach);
}

const verify = process.argv.includes("--verify");
const outputPath = arg("output", DEFAULT_OUTPUT);

const snapshot = loadSnapshot(SNAPSHOT_PATH);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30, "Production organization catalog must contain 30 organizations");
const organization = catalog.organizations[0];

const input = {
  name: "v50.1f Save QA",
  nationality: "대한민국",
  hometown: "구미",
  age: 18,
  heightCm: 180,
  weightKg: 78,
  bodyType: "ATHLETIC",
  bats: "R",
  throws: "R",
  primaryPosition: "CF",
  archetype: "ATHLETIC",
  visibleTraits: ["QUICK_BAT", "BASE_STEALER"],
  organizationMode: "FAVORITE",
  favoriteOrganizationId: String(organization.id)
};

let season = seasonApi.createCareerSeason({
  seed: "v50-1f-production-save-transfer",
  input,
  masterSnapshot: snapshot
});
assert.equal(season.currentLevel, "A", "age-18 Production career should begin at A");

// Put the career in a real in-progress game and advance one user PA.
season = seasonApi.startCurrentGame(season.seasonId);
assert.ok(season.activeGame, "interactive Production game did not start");
season = seasonApi.playUserPA(season.seasonId, "AGGRESSIVE");
season = resolveRunningIfNeeded(season);

const checkpointPayload = seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(checkpointPayload, { mode: "FULL" }), true, "FULL save validation failed");
assert.equal(checkpointPayload.format, seasonSaveFormat.format, "save format drift");
assert.equal(checkpointPayload.schemaVersion, seasonSaveFormat.schemaVersion, "save schema drift");
assertFiveLevelProduction(checkpointPayload, "checkpoint");

const checkpoint = checkpointPayload.activeGameCheckpoint;
assert.ok(checkpoint, "active game checkpoint missing");
assert.ok(Number.isSafeInteger(checkpoint.rng?.counter) && checkpoint.rng.counter > 0, "checkpoint RNG counter missing");
assert.equal(checkpoint.gameId, checkpointPayload.activeScheduleGameId, "active checkpoint/schedule game mismatch");

// Same checkpoint + same action must produce the same continuation.
const expectedContinuation = playDeterministicAction(season.seasonId, "CONTACT");
seasonApi.restoreSeason(structuredClone(checkpointPayload));
const actualContinuation = playDeterministicAction(checkpointPayload.seasonId, "CONTACT");
assert.deepEqual(
  normalizeForContinuation(actualContinuation),
  normalizeForContinuation(expectedContinuation),
  "checkpoint continuation is not deterministic"
);

// Restore the checkpoint again before exercising persistence services.
season = seasonApi.restoreSeason(structuredClone(checkpointPayload));
const repository = memoryRepository();
let clock = 0;
const now = () => `2026-09-21T10:10:${String(clock++).padStart(2, "0")}.000Z`;
const saveService = createSeasonSaveService({ repository, now });
const transfer = createSeasonTransferService({ repository, now });
const sourceSaveId = "v50-1f-production-source";

// Main save/load must preserve active checkpoint and Production five-level state.
const savedMeta = await saveService.saveSeason(season.seasonId, {
  saveId: sourceSaveId,
  label: "v50.1f Production Save"
});
assert.equal(savedMeta.saveId, sourceSaveId);
assert.equal(savedMeta.currentLevel, season.currentLevel, "save metadata current level drift");
assert.equal(savedMeta.hasActiveGame, true, "save metadata lost active game flag");

const saveList = await saveService.listSaves();
assert.equal(saveList.length, 1, "save list count drift");
assert.equal(saveList[0].saveId, sourceSaveId);
assert.equal(saveList[0].hasActiveGame, true);

const stored = await repository.get(sourceSaveId);
assert.ok(stored?.payload?.activeGameCheckpoint, "repository save lost checkpoint");
assert.equal(validateSeasonSavePayload(stored.payload, { mode: "FULL" }), true);
assertFiveLevelProduction(stored.payload, "stored");

const loaded = await saveService.loadSeason(sourceSaveId);
assert.ok(loaded, "saved Production career did not load");
assert.equal(loaded.currentLevel, season.currentLevel, "loaded current level drift");
assert.equal(loaded.currentDate, season.currentDate, "loaded current date drift");
const loadedPayload = seasonApi.serializeSeason(loaded.seasonId);
assert.ok(loadedPayload.activeGameCheckpoint, "load lost active checkpoint");
assert.equal(loadedPayload.activeGameCheckpoint.rng.counter, checkpoint.rng.counter, "load changed checkpoint RNG");
assertFiveLevelProduction(loadedPayload, "loaded");

// Export current active checkpoint.
const exported = transfer.exportSeason(loaded.seasonId, {
  saveId: sourceSaveId,
  label: "v50.1f Production Export"
});
const document = JSON.parse(exported.text);
assert.equal(validateTcuExportDocument(document), true, "TCU export validation failed");
assert.equal(exported.checksum, computeTcuChecksum(document), "TCU checksum drift");
assert.equal(document.metadata.hasActiveGame, true, "TCU metadata lost active game");
assert.equal(document.career.activeGameCheckpoint.rng.counter, checkpoint.rng.counter, "TCU checkpoint RNG drift");
assertFiveLevelProduction(document.career, "exported");

// Imported copy must be independent in save identity and deterministic in game continuation.
seasonApi.restoreSeason(structuredClone(document.career));
const expectedImportedContinuation = playDeterministicAction(document.career.seasonId, "CONTACT");

const imported = await transfer.importAndLoadSeason(exported.text, { label: "v50.1f Imported Copy" });
assert.notEqual(imported.meta.saveId, sourceSaveId, "import overwrote source save identity");
assert.equal(imported.meta.importedFrom?.sourceSaveId, sourceSaveId, "import provenance missing");
assert.equal(imported.meta.hasActiveGame, true, "import metadata lost active game");
const importedRecord = await repository.get(imported.meta.saveId);
assert.ok(importedRecord?.payload, "imported copy was not written");
assertFiveLevelProduction(importedRecord.payload, "imported-record");

const actualImportedContinuation = playDeterministicAction(imported.snapshot.seasonId, "CONTACT");
assert.deepEqual(
  normalizeForContinuation(actualImportedContinuation),
  normalizeForContinuation(expectedImportedContinuation),
  "imported checkpoint continuation mismatch"
);

// Corruption must fail before any repository write.
const putsBeforeCorrupt = repository.stats().puts;
const corrupt = structuredClone(document);
corrupt.career.playerStateDate = "2099-01-01";
let corruptRejected = false;
let corruptMessage = "";
try {
  await transfer.importSeasonText(JSON.stringify(corrupt));
} catch (error) {
  corruptMessage = String(error?.message ?? error);
  corruptRejected = /checksum/i.test(corruptMessage);
}
assert.equal(corruptRejected, true, `corrupt TCU was not rejected by checksum: ${corruptMessage}`);
assert.equal(repository.stats().puts, putsBeforeCorrupt, "corrupt import wrote to repository");

// Source save must remain intact after import-as-copy and corrupt-import attempt.
const sourceAfterImports = await repository.get(sourceSaveId);
assert.equal(sourceAfterImports.saveId, sourceSaveId);
assert.ok(sourceAfterImports.payload.activeGameCheckpoint, "source save checkpoint was mutated/lost");
assert.equal(sourceAfterImports.payload.activeGameCheckpoint.rng.counter, checkpoint.rng.counter, "source checkpoint RNG was mutated");

const report = {
  schema: "THE_CALL_UP_V50_1F_SAVE_TRANSFER_REGRESSION",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  organization: {
    id: String(organization.id),
    name: organization.name
  },
  checkpoint: {
    seasonId: checkpointPayload.seasonId,
    currentDate: checkpointPayload.season.currentDate,
    userLevel: checkpointPayload.fixture.organization.userLevel,
    gameId: checkpoint.gameId,
    rngCounter: checkpoint.rng.counter,
    deterministicContinuation: true,
    fullValidation: true,
    fiveLevelProduction: true
  },
  saveLoad: {
    sourceSaveId,
    listed: saveList.length,
    hasActiveGame: savedMeta.hasActiveGame,
    loadedCheckpoint: true,
    currentLevel: loaded.currentLevel,
    currentDate: loaded.currentDate
  },
  transfer: {
    filename: exported.filename,
    checksum: exported.checksum,
    checksumPass: true,
    importedSaveId: imported.meta.saveId,
    importAsCopy: imported.meta.saveId !== sourceSaveId,
    provenancePass: imported.meta.importedFrom?.sourceSaveId === sourceSaveId,
    deterministicContinuation: true,
    corruptRejected,
    corruptNoWrite: repository.stats().puts === putsBeforeCorrupt,
    sourceUntouched: true
  }
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
