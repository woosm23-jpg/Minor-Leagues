import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { seasonApi } from "../src/api/seasonApi.js";
import {
  createGeneratedHitterStyle,
  createGeneratedPitcherStyle
} from "../src/services/productionStyleFallback.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = path.resolve(SCRIPT_DIR, "..");
const SNAPSHOT_REL =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(path.resolve(WORK_ROOT, SNAPSHOT_REL))
    ).toString("utf8")
  );
}

function careerInput(organizationId) {
  return {
    name: "Style Fallback QA",
    nationality: "대한민국",
    hometown: "구미",
    age: 18,
    heightCm: 180,
    weightKg: 78,
    bodyType: "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition: "SS",
    archetype: "BALANCED",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE",
    favoriteOrganizationId: String(organizationId)
  };
}

function uniquePlayers(fixture, level, kind) {
  const league = fixture.levelLeagues[level];
  const byId = new Map();
  for (const roster of Object.values(league.rosters)) {
    const ids =
      kind === "PITCHER"
        ? roster.pitchers ?? []
        : roster.positionPlayers ?? [];
    for (const id of ids) {
      const player = roster.players[id];
      if (player) byId.set(String(player.id), player);
    }
  }
  return [...byId.values()];
}

function outputPath() {
  const hit = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--output="));
  return path.resolve(
    WORK_ROOT,
    hit
      ? hit.slice("--output=".length)
      : "reports/production-style-fallback-v1.json"
  );
}

function distinct(players, getter) {
  return new Set(players.map(getter)).size;
}

function buildReport() {
  const snapshot = readSnapshot();
  const catalog = seasonApi.getCareerCreationCatalog({
    masterSnapshot: snapshot
  });
  const seed = "post-audit-style-fallback-v1";
  const created = seasonApi.createCareerSeason({
    seed,
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  const hitters = uniquePlayers(
    payload.fixture,
    "MLB",
    "HITTER"
  );
  const pitchers = uniquePlayers(
    payload.fixture,
    "MLB",
    "PITCHER"
  );

  assert.ok(hitters.length > 100);
  assert.ok(pitchers.length > 100);

  const hitterA = createGeneratedHitterStyle({
    seed: "determinism",
    playerId: "H_STYLE"
  });
  const hitterB = createGeneratedHitterStyle({
    seed: "determinism",
    playerId: "H_STYLE"
  });
  const pitcherA = createGeneratedPitcherStyle({
    seed: "determinism",
    playerId: "P_STYLE"
  });
  const pitcherB = createGeneratedPitcherStyle({
    seed: "determinism",
    playerId: "P_STYLE"
  });
  assert.deepEqual(hitterA, hitterB);
  assert.deepEqual(pitcherA, pitcherB);

  const hitterDistinct = {
    launchTendency: distinct(
      hitters,
      (p) => p.tendencies.launchTendency
    ),
    sprayPull: distinct(
      hitters,
      (p) => p.tendencies.sprayPull
    ),
    sprayCenter: distinct(
      hitters,
      (p) => p.tendencies.sprayCenter
    ),
    sprayOppo: distinct(
      hitters,
      (p) => p.tendencies.sprayOppo
    )
  };

  const pitcherDistinct = {
    holdRunner: distinct(
      pitchers,
      (p) => p.pitching.holdRunner
    ),
    fielding: distinct(
      pitchers,
      (p) => p.fielding.fielding
    ),
    reaction: distinct(
      pitchers,
      (p) => p.fielding.reaction
    ),
    armStrength: distinct(
      pitchers,
      (p) => p.fielding.armStrength
    ),
    armAccuracy: distinct(
      pitchers,
      (p) => p.fielding.armAccuracy
    )
  };

  for (const value of Object.values(hitterDistinct)) {
    assert.ok(value > 10);
  }
  for (const value of Object.values(pitcherDistinct)) {
    assert.ok(value > 10);
  }

  return {
    schema: "THE_CALL_UP_PRODUCTION_STYLE_FALLBACK_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    policy: {
      realDataPreserved: true,
      randomizeMissingHitterStyle: true,
      randomizeMissingPitcherStyle: true,
      minorLeagueParksRemainNeutral: true,
      contractsServiceAndInjuryTruthNotRandomized: true
    },
    runtime: {
      mlbHitters: hitters.length,
      mlbPitchers: pitchers.length,
      hitterDistinct,
      pitcherDistinct
    },
    deterministicSamples: {
      hitter: hitterA,
      pitcher: pitcherA
    }
  };
}

function main() {
  const report = buildReport();
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(report, null, 2) + "\n"
  );
  process.stdout.write(
    JSON.stringify(report, null, 2) + "\n"
  );
}

if (
  path.resolve(process.argv[1] ?? "") ===
  fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

export { buildReport };
