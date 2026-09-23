import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateMasterSnapshot } from "../src/data/masterSnapshot.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");
const SNAPSHOT_REL = "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";
const MANIFEST_REL = "data/the_call_up_snapshot_v3/production_manifest_v3.json";

function readGz(relativePath) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(WORK_ROOT, relativePath))).toString("utf8"));
}
function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(WORK_ROOT, relativePath), "utf8"));
}
function outputPath() {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith("--output="));
  return path.resolve(WORK_ROOT, hit ? hit.slice("--output=".length) : "reports/production-runtime-v3-wiring.json");
}
function careerInput(organizationId) {
  return {
    name: "Production v3 Wiring QA", nationality: "대한민국", hometown: "구미",
    age: 18, heightCm: 180, weightKg: 78, bodyType: "ATHLETIC",
    bats: "R", throws: "R", primaryPosition: "SS", archetype: "BALANCED",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"], organizationMode: "FAVORITE",
    favoriteOrganizationId: String(organizationId)
  };
}

function buildRuntimeReport() {
  const snapshot = readGz(SNAPSHOT_REL);
  const manifest = readJson(MANIFEST_REL);
  validateMasterSnapshot(snapshot, { requireProductionCoverage: true });
  assert.equal(snapshot.metadata.snapshotId, "mlb-milb-2026-2026-09-20-v3-production");
  assert.equal(snapshot.metadata.contentHash, "fnv1a32:f7b34713");
  assert.equal(manifest.contentHash, snapshot.metadata.contentHash);

  const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
  assert.equal(catalog.organizations.length, 30);
  const created = seasonApi.createCareerSeason({
    seed: "post-audit-production-v3-runtime",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);
  validateSeasonSavePayload(payload, { mode: "FULL" });
  assert.equal(payload.fixture.worldMode, "PRODUCTION_REAL");
  assert.equal(payload.dataUniverse.origin, "MASTER_SNAPSHOT");
  assert.equal(payload.dataUniverse.sourceSnapshot.id, snapshot.metadata.snapshotId);
  assert.equal(payload.dataUniverse.sourceSnapshot.hash, snapshot.metadata.contentHash);

  const data = payload.dataUniverse.data;
  const publicScoutingPlayers = data.players.filter((player) => player.publicScouting).length;
  assert.equal(data.players.length, 5429);
  assert.equal(data.teams.length, 150);
  assert.equal(data.parks.length, 30);
  assert.equal(data.schedule.length, 10710);
  assert.equal(data.tracking.length, 14988);
  assert.equal(data.pitchArsenal.length, 12023);
  assert.equal(publicScoutingPlayers, 1127);

  const trackingIds = new Set(data.tracking.map((row) => String(row.playerId)));
  const arsenalIds = new Set(data.pitchArsenal.map((row) => String(row.playerId)));
  assert.equal(trackingIds.size, 2149);
  assert.equal(arsenalIds.size, 1288);

  return {
    schema: "THE_CALL_UP_PRODUCTION_RUNTIME_V3_WIRING",
    pass: true,
    seed: "post-audit-production-v3-runtime",
    runtime: { gameVersion: payload.gameVersion, saveSchemaVersion: payload.schemaVersion, worldMode: payload.fixture.worldMode },
    snapshot: { source: `work/${SNAPSHOT_REL}`, id: snapshot.metadata.snapshotId, contentHash: snapshot.metadata.contentHash, schemaVersion: snapshot.schemaVersion },
    coverage: {
      organizations: catalog.organizations.length, teams: data.teams.length, players: data.players.length,
      parks: data.parks.length, scheduleGames: data.schedule.length, trackingRows: data.tracking.length,
      trackingPlayers: trackingIds.size, pitchArsenalRows: data.pitchArsenal.length,
      pitchArsenalPlayers: arsenalIds.size, publicScoutingPlayers
    },
    saveValidation: { full: true, sourceSnapshotPreserved: true }
  };
}

function main() {
  const report = buildRuntimeReport();
  const json = JSON.stringify(report, null, 2) + "\n";
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  process.stdout.write(json);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}

export { buildRuntimeReport };
