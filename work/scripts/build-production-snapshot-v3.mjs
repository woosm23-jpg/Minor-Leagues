import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createMasterSnapshotV2,
  validateMasterSnapshot
} from "../src/data/masterSnapshot.js";
import {
  applyPublicScoutingPatchToSnapshot
} from "../src/data/publicScoutingPatch.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");

const BASE_REL =
  "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const PHASE_C_REL =
  "data/the_call_up_phase_c/statcast-phase-c-2026.json.gz";
const PHASE_C_MANIFEST_REL =
  "data/the_call_up_phase_c/phase_c_manifest.json";
const PHASE_D_REL =
  "data/the_call_up_phase_d/public-scouting-2026.json.gz";
const PHASE_D_MANIFEST_REL =
  "data/the_call_up_phase_d/public_scouting_manifest.json";

const V3_REL =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";
const V3_MANIFEST_REL =
  "data/the_call_up_snapshot_v3/production_manifest_v3.json";

function abs(relativePath) {
  return path.resolve(WORK_ROOT, relativePath);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(abs(relativePath), "utf8"));
}

function readGzJson(relativePath) {
  return JSON.parse(
    zlib.gunzipSync(fs.readFileSync(abs(relativePath))).toString("utf8")
  );
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertUniqueIds(rows, label, getter) {
  const seen = new Set();
  for (const row of rows ?? []) {
    const id = String(getter(row) ?? "");
    assert.ok(id, `${label}: empty id`);
    assert.ok(!seen.has(id), `${label}: duplicate id ${id}`);
    seen.add(id);
  }
  return seen;
}

function assertEvidenceIdsExist(rows, playerIds, label) {
  const missing = [];
  for (const row of rows ?? []) {
    const id = String(row?.playerId ?? "");
    if (id && !playerIds.has(id)) missing.push(id);
  }
  assert.equal(
    missing.length,
    0,
    `${label}: player ids missing from base snapshot: ${missing.slice(0, 8).join(",")}`
  );
}

function addSourceOnce(sources, source) {
  return sources.some((row) => String(row.id) === String(source.id))
    ? sources
    : [...sources, source];
}

function summarizeTrackingPlayers(snapshot, count = 3) {
  const playerById = new Map(
    snapshot.players.map((player) => [String(player.id), player])
  );
  const byId = new Map();

  for (const row of snapshot.tracking ?? []) {
    const id = String(row.playerId);
    if (!byId.has(id)) {
      byId.set(id, { rows: 0, groups: new Set() });
    }
    const entry = byId.get(id);
    entry.rows += 1;
    entry.groups.add(String(row.metricGroup));
  }

  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, count)
    .map(([id, entry]) => ({
      playerId: id,
      name: playerById.get(id)?.fullName ?? null,
      rows: entry.rows,
      metricGroups: [...entry.groups].sort()
    }));
}

function summarizeArsenalPlayers(snapshot, count = 3) {
  const playerById = new Map(
    snapshot.players.map((player) => [String(player.id), player])
  );
  const byId = new Map();

  for (const row of snapshot.pitchArsenal ?? []) {
    const id = String(row.playerId);
    if (!byId.has(id)) {
      byId.set(id, { rows: 0, pitchTypes: new Set() });
    }
    const entry = byId.get(id);
    entry.rows += 1;
    entry.pitchTypes.add(String(row.pitchType));
  }

  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, count)
    .map(([id, entry]) => ({
      playerId: id,
      name: playerById.get(id)?.fullName ?? null,
      rows: entry.rows,
      pitchTypes: [...entry.pitchTypes].sort()
    }));
}

function summarizeScoutingPlayers(snapshot, count = 3) {
  return snapshot.players
    .filter((player) => player.publicScouting)
    .sort((a, b) =>
      String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
    )
    .slice(0, count)
    .map((player) => ({
      playerId: String(player.id),
      name: player.fullName,
      futureValue:
        player.publicScouting?.futureValue?.grade ??
        player.publicScouting?.futureValue ??
        null,
      risk: player.publicScouting?.risk ?? null
    }));
}

function buildSnapshotV3() {
  const base = readGzJson(BASE_REL);
  const phaseC = readGzJson(PHASE_C_REL);
  const phaseCManifest = readJson(PHASE_C_MANIFEST_REL);
  const phaseD = readGzJson(PHASE_D_REL);
  const phaseDManifest = readJson(PHASE_D_MANIFEST_REL);

  assert.equal(base.metadata.contentHash, "fnv1a32:21eb3434");
  assert.equal(phaseC.baseSnapshotHash, base.metadata.contentHash);
  assert.equal(phaseD.baseSnapshotHash, base.metadata.contentHash);
  assert.equal(phaseCManifest.baseSnapshotHash, base.metadata.contentHash);
  assert.equal(phaseDManifest.baseSnapshotHash, base.metadata.contentHash);

  const basePlayerIds = assertUniqueIds(
    base.players,
    "base players",
    (row) => row.id
  );
  assertEvidenceIdsExist(phaseC.tracking, basePlayerIds, "Phase C tracking");
  assertEvidenceIdsExist(
    phaseC.pitchArsenal,
    basePlayerIds,
    "Phase C pitch arsenal"
  );

  const phaseDRecordIds = assertUniqueIds(
    phaseD.records,
    "Phase D public scouting",
    (row) => row.playerId
  );
  for (const id of phaseDRecordIds) {
    assert.ok(basePlayerIds.has(id), `Phase D player missing from base: ${id}`);
  }

  assert.equal(
    phaseC.tracking.length,
    phaseCManifest.coverage.trackingRows
  );
  assert.equal(
    phaseC.pitchArsenal.length,
    phaseCManifest.coverage.pitchArsenalRows
  );
  assert.equal(
    phaseD.records.length,
    phaseDManifest.coverage.matchedPlayers
  );

  const baseWithScouting = applyPublicScoutingPatchToSnapshot(
    base,
    phaseD,
    { requireBaseHash: true }
  );

  let sources = [...base.sources];
  sources = addSourceOnce(sources, {
    id: "phase_c_statcast_2026",
    name: "THE CALL-UP Phase C public Statcast and pitch arsenal evidence",
    url: "repository://work/data/the_call_up_phase_c/statcast-phase-c-2026.json.gz",
    retrievedAt: phaseCManifest.createdAt,
    notes:
      `sha256=${phaseCManifest.sha256}; baseSnapshotHash=${phaseCManifest.baseSnapshotHash}`
  });
  sources = addSourceOnce(sources, {
    id: "phase_d_public_scouting_2026",
    name: "THE CALL-UP Phase D public scouting evidence",
    url: "repository://work/data/the_call_up_phase_d/public-scouting-2026.json.gz",
    retrievedAt: phaseDManifest.createdAt,
    notes:
      `sha256=${phaseDManifest.sha256}; baseSnapshotHash=${phaseDManifest.baseSnapshotHash}`
  });

  const snapshot = createMasterSnapshotV2({
    metadata: {
      snapshotId: "mlb-milb-2026-2026-09-20-v3-production",
      snapshotDate: base.metadata.snapshotDate,
      season: base.metadata.season,
      createdAt: phaseDManifest.createdAt,
      kind: "REAL_WORLD",
      productionReady: true,
      notes:
        "Authoritative Production Snapshot v3: base v2 + Phase C tracking/pitch arsenal + Phase D public scouting."
    },
    sources,
    teams: base.teams,
    players: baseWithScouting.players,
    affiliations: base.affiliations,
    stats: base.stats,
    schedule: base.schedule,
    parks: base.parks,
    tracking: phaseC.tracking,
    pitchArsenal: phaseC.pitchArsenal,
    availabilityEvents: base.availabilityEvents ?? []
  });

  validateMasterSnapshot(snapshot, { requireProductionCoverage: true });

  const publicScoutingPlayers = snapshot.players.filter(
    (player) => player.publicScouting
  ).length;
  assert.equal(
    publicScoutingPlayers,
    phaseDManifest.coverage.matchedPlayers
  );

  assert.equal(snapshot.players.length, base.players.length);
  assert.equal(snapshot.teams.length, base.teams.length);
  assert.equal(snapshot.stats.length, base.stats.length);
  assert.equal(snapshot.schedule.length, base.schedule.length);
  assert.equal(snapshot.parks.length, base.parks.length);
  assert.equal(snapshot.tracking.length, phaseC.tracking.length);
  assert.equal(
    snapshot.pitchArsenal.length,
    phaseC.pitchArsenal.length
  );

  return {
    snapshot,
    manifest: {
      schema: "THE_CALL_UP_PRODUCTION_MANIFEST_V3",
      pass: true,
      snapshotSchema: snapshot.schemaVersion,
      snapshotId: snapshot.metadata.snapshotId,
      snapshotDate: snapshot.metadata.snapshotDate,
      season: snapshot.metadata.season,
      contentHash: snapshot.metadata.contentHash,
      builtFrom: {
        baseV2: {
          snapshotId: base.metadata.snapshotId,
          contentHash: base.metadata.contentHash,
          path: `work/${BASE_REL}`
        },
        phaseC: {
          schema: phaseCManifest.schema,
          sha256: phaseCManifest.sha256,
          baseSnapshotHash: phaseCManifest.baseSnapshotHash,
          path: `work/${PHASE_C_REL}`
        },
        phaseD: {
          schema: phaseDManifest.schema,
          sha256: phaseDManifest.sha256,
          baseSnapshotHash: phaseDManifest.baseSnapshotHash,
          path: `work/${PHASE_D_REL}`
        }
      },
      coverage: {
        teams: snapshot.teams.length,
        players: snapshot.players.length,
        statsRows: snapshot.stats.length,
        scheduleGames: snapshot.schedule.length,
        parks: snapshot.parks.length,
        trackingRows: snapshot.tracking.length,
        trackingPlayers: new Set(
          snapshot.tracking.map((row) => String(row.playerId))
        ).size,
        pitchArsenalRows: snapshot.pitchArsenal.length,
        pitchArsenalPlayers: new Set(
          snapshot.pitchArsenal.map((row) => String(row.playerId))
        ).size,
        publicScoutingPlayers
      },
      duplicateChecks: {
        basePlayerIdsUnique: true,
        phaseDPlayerIdsUnique: true,
        phaseCTrackingIdsKnown: true,
        phaseCArsenalIdsKnown: true,
        phaseDIdsKnown: true
      },
      evidenceSpotChecks: {
        trackingPlayers: summarizeTrackingPlayers(snapshot),
        pitchArsenalPlayers: summarizeArsenalPlayers(snapshot),
        publicScoutingPlayers: summarizeScoutingPlayers(snapshot)
      }
    }
  };
}

function writeOutputs() {
  const { snapshot, manifest } = buildSnapshotV3();

  const json = JSON.stringify(snapshot);
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"), {
    level: 9,
    mtime: 0
  });

  const manifestWithFile = {
    ...manifest,
    file: {
      path: `work/${V3_REL}`,
      bytes: gz.length,
      sha256: sha256(gz)
    }
  };

  fs.mkdirSync(path.dirname(abs(V3_REL)), { recursive: true });
  fs.writeFileSync(abs(V3_REL), gz);
  fs.writeFileSync(
    abs(V3_MANIFEST_REL),
    JSON.stringify(manifestWithFile, null, 2) + "\n"
  );

  process.stdout.write(
    JSON.stringify(manifestWithFile, null, 2) + "\n"
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    writeOutputs();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { buildSnapshotV3 };
