import fs from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";

function memoryRepository() {
  const store = new Map();
  return {
    async put(record) { store.set(record.saveId, structuredClone(record)); return structuredClone(record); },
    async get(id) { return store.has(id) ? structuredClone(store.get(id)) : null; },
    async getMeta(id) {
      const row = store.get(id); if (!row) return null;
      const { payload: _payload, ...meta } = row;
      return structuredClone(meta);
    },
    async list() { return [...store.values()].map(({ payload: _payload, ...meta }) => structuredClone(meta)); },
    async delete(id) { return store.delete(id); }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice("--seeds=".length) ?? 6);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const seed = `v20-organization-${i + 1}`;
  let season = seasonApi.createDemoSeason({ seed, startDate: "2026-04-01" });
  const initialOrganization = season.organization;
  const initialCf = initialOrganization.depthCharts.CF;
  const initialAaa = initialCf.find((group) => group.level === "AAA");
  const initialMlb = initialCf.find((group) => group.level === "MLB");
  const initialUser = initialAaa.entries.find((entry) => entry.id === season.userPlayer.id);
  const initialBlocker = initialMlb.entries[0];

  season = seasonApi.simulateToSeasonEnd(season.seasonId);
  const finalCf = season.organization.depthCharts.CF;
  const finalUser = finalCf.find((group) => group.level === "AAA").entries.find((entry) => entry.id === season.userPlayer.id);
  const finalBlocker = finalCf.find((group) => group.level === "MLB").entries[0];

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T10:${String(i).padStart(2, "0")}:00.000Z` });
  const saveId = `v20-org-slot-${i + 1}`;
  await saveService.saveSeason(season.seasonId, { saveId, label: `V20 Org ${i + 1}` });
  const restored = await saveService.loadSeason(saveId);
  const restoredCf = restored.organization.depthCharts.CF;

  const legacyPayload = structuredClone(seasonApi.serializeSeason(restored.seasonId));
  delete legacyPayload.fixture.organization;
  legacyPayload.gameVersion = "phase2_player_leaders_v19";
  const legacyRestored = seasonApi.restoreSeason(legacyPayload);

  const row = {
    seed: i + 1,
    status: season.status,
    userGames: season.progress.gamesPlayed,
    leagueGames: season.progress.leagueGamesCompleted,
    levels: initialOrganization.levelOrder,
    userLevel: initialOrganization.userLevel,
    positionCount: initialOrganization.positionOptions.length,
    initialUserDepthScore: initialUser.depthScore,
    initialMlbCfDepthScore: initialBlocker.depthScore,
    finalUserDepthScore: finalUser.depthScore,
    finalMlbCfDepthScore: finalBlocker.depthScore,
    blockedPathway: initialBlocker.depthScore > initialUser.depthScore && finalBlocker.depthScore > finalUser.depthScore,
    userMarked: initialUser.isUser === true,
    hiddenSafe: !("powerUtilizationR" in initialUser.ratings) && !("ceilings" in initialUser.ratings) && !("rate" in initialUser.ratings),
    leaderCategoryCount: season.leaders.categoryOrder.length,
    roundTrip: JSON.stringify(restoredCf.map((group) => group.entries.map((entry) => entry.id))) === JSON.stringify(finalCf.map((group) => group.entries.map((entry) => entry.id))),
    legacyRebuild: legacyRestored.organization?.userLevel === "AAA" && legacyRestored.organization?.levelOrder?.length === 4,
    nextGameVersion: seasonApi.serializeSeason(legacyRestored.seasonId).gameVersion
  };
  rows.push(row);

  if (verify) {
    if (row.status !== "COMPLETE" || row.userGames !== 28 || row.leagueGames !== 112) throw new Error(`seed ${i + 1}: season completion broken`);
    if (JSON.stringify(row.levels) !== JSON.stringify(["MLB", "AAA", "AA", "A"]) || row.userLevel !== "AAA") throw new Error(`seed ${i + 1}: organization levels broken`);
    if (row.positionCount !== 11 || !row.userMarked || !row.blockedPathway) throw new Error(`seed ${i + 1}: depth chart/pathway broken`);
    if (!row.hiddenSafe || row.leaderCategoryCount !== 9) throw new Error(`seed ${i + 1}: hidden state or v19 leader regression`);
    if (!row.roundTrip || !row.legacyRebuild || row.nextGameVersion !== "phase3_pitcher_movement_v25") throw new Error(`seed ${i + 1}: persistence/legacy compatibility broken`);
  }
}

const report = { version: "v20", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
