import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";

const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
const org = catalog.organizations[0];

const created = seasonApi.createCareerSeason({
  seed: "v51-contract-rollover",
  input: {
    name: "v51 Rollover QA",
    nationality: "대한민국",
    hometown: "구미",
    age: 18,
    heightCm: 180,
    weightKg: 78,
    bodyType: "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition: "SS",
    archetype: "HIT_FIRST",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE",
    favoriteOrganizationId: String(org.id)
  },
  masterSnapshot: snapshot
});

const before = seasonApi.serializeSeason(created.seasonId);
const userId = String(before.fixture.userPlayerId);
assert.equal(before.contractStates[userId].simulatedServiceDays, 0);

const completed = seasonApi.simulateToSeasonEnd(created.seasonId);
assert.equal(completed.status, "COMPLETE");
assert.equal(completed.progress.worldLeagueGamesCompleted, 10710);

const completedPayload = seasonApi.serializeSeason(created.seasonId);
const by2026 = Object.values(completedPayload.contractStates)
  .map((state) => Number(state.serviceBySeason?.["2026"] ?? 0));
assert.ok(Math.max(...by2026) >= 172, "full-season MLB service evidence too small");
assert.ok(Math.max(...by2026) <= 187, "service exceeded 187-day regular-season calendar");
assert.ok(by2026.some((days) => days === 0), "minor-league players should have zero MLB service");

const next = seasonApi.advanceToNextSeason(created.seasonId);
assert.equal(next.seasonYear, 2027);
assert.equal(next.startDate, "2027-03-25");

const after = seasonApi.serializeSeason(created.seasonId);
const currentMlbIds = Object.values(after.fixture.levelLeagues.MLB.rosters)
  .flatMap((roster) => Object.keys(roster.players ?? {}));
assert.ok(currentMlbIds.length >= 800);
const current2027 = currentMlbIds
  .map((id) => Number(after.contractStates?.[id]?.serviceBySeason?.["2027"] ?? 0));
assert.ok(current2027.some((days) => days === 1), "Opening Day 2027 service credit missing");
assert.ok(current2027.every((days) => days <= 1), "offseason days were incorrectly credited as 2027 service");

const saved = seasonApi.serializeSeason(created.seasonId);
const restored = seasonApi.restoreSeason(structuredClone(saved));
const roundTrip = seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(roundTrip.contractStates, saved.contractStates, "rollover contract states changed across save restore");

const report = {
  schema: "THE_CALL_UP_V51_CONTRACT_ROLLOVER_GATE",
  pass: true,
  source: "Production Snapshot v2",
  completed2026: {
    worldGames: completed.progress.worldLeagueGamesCompleted,
    maxServiceDays: Math.max(...by2026),
    zeroServicePlayers: by2026.filter((days) => days === 0).length
  },
  next2027: {
    startDate: next.startDate,
    currentMlbPlayers: currentMlbIds.length,
    openingDayCreditedPlayers: current2027.filter((days) => days === 1).length,
    max2027ServiceDays: Math.max(...current2027)
  },
  saveRoundTrip: true
};
fs.writeFileSync("reports/v51-contract-rollover-gate.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
