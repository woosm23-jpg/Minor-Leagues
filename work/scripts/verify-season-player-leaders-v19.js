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
    async list() {
      return [...store.values()].map(({ payload: _payload, ...meta }) => structuredClone(meta));
    },
    async delete(id) { return store.delete(id); }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice("--seeds=".length) ?? 6);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const seed = `v19-player-leaders-${i + 1}`;
  let season = seasonApi.createDemoSeason({ seed, startDate: "2026-04-01" });
  season = seasonApi.simulateToSeasonEnd(season.seasonId);

  const categoryOrder = season.leaders.categoryOrder ?? [];
  const leaderChecks = categoryOrder.map((key) => {
    const category = season.leaders.categories[key];
    const userInTop = category.top.some((row) => row.id === season.userPlayer.id);
    const userInNeighborhood = category.neighborhood.some((row) => row.id === season.userPlayer.id);
    const neighborhoodValid = category.userRank === null
      ? category.neighborhood.length === 0
      : category.userRank <= 10
        ? category.neighborhood.length === 0 && userInTop
        : category.neighborhood.length >= 3 && category.neighborhood.length <= 5 && userInNeighborhood;
    return {
      key,
      topCount: category.top.length,
      userRank: category.userRank,
      neighborhoodRanks: category.neighborhood.map((row) => row.rank),
      neighborhoodValid
    };
  });

  const userDetail = seasonApi.getPlayerDetail(season.seasonId, season.userPlayer.id);
  const topOpsId = season.leaders.categories.OPS.top[0]?.id ?? null;
  const competitorDetail = topOpsId ? seasonApi.getPlayerDetail(season.seasonId, topOpsId) : null;
  const hiddenSafe = userDetail.status
    && !("rate" in userDetail.status.development)
    && !("ceilings" in userDetail.status.development)
    && !("powerUtilizationR" in userDetail.ratings.current)
    && !("powerUtilizationL" in userDetail.ratings.current);

  const repo = memoryRepository();
  let tick = 0;
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T09:${String(i).padStart(2, "0")}:${String(tick++).padStart(2, "0")}.000Z` });
  const saveId = `v19-slot-${i + 1}`;
  await saveService.saveSeason(season.seasonId, { saveId, label: `V19 ${i + 1}` });
  const restored = await saveService.loadSeason(saveId);
  const rankRoundTrip = JSON.stringify(restored.leaders.categories) === JSON.stringify(season.leaders.categories);
  const ratingsRoundTrip = JSON.stringify(restored.userPlayer.ratings.current) === JSON.stringify(season.userPlayer.ratings.current);

  const row = {
    seed: i + 1,
    status: season.status,
    userGames: season.progress.gamesPlayed,
    leagueGames: season.progress.leagueGamesCompleted,
    categoryCount: categoryOrder.length,
    allTopListsPopulated: leaderChecks.every((item) => item.topCount === 10),
    localRankPolicy: leaderChecks.every((item) => item.neighborhoodValid),
    localRankCategories: leaderChecks.filter((item) => item.userRank > 10).map((item) => ({ key: item.key, rank: item.userRank, neighborhood: item.neighborhoodRanks })),
    hiddenSafe,
    userPosition: userDetail.primaryPosition,
    competitorDetailSafe: Boolean(competitorDetail?.ratings?.current) && !("powerUtilizationR" in competitorDetail.ratings.current),
    rankRoundTrip,
    ratingsRoundTrip
  };
  rows.push(row);

  if (verify) {
    if (row.status !== "COMPLETE" || row.userGames !== 28 || row.leagueGames !== 112) throw new Error(`seed ${i + 1}: season completion broken`);
    if (row.categoryCount !== 9 || !row.allTopListsPopulated) throw new Error(`seed ${i + 1}: leader category/top list broken`);
    if (!row.localRankPolicy) throw new Error(`seed ${i + 1}: local rank neighborhood policy broken`);
    if (!row.hiddenSafe || !row.competitorDetailSafe) throw new Error(`seed ${i + 1}: hidden player state leaked`);
    if (row.userPosition !== "CF") throw new Error(`seed ${i + 1}: player identity/position broken`);
    if (!row.rankRoundTrip || !row.ratingsRoundTrip) throw new Error(`seed ${i + 1}: save/load Player/Leaders view changed`);
  }
}

const report = { version: "v19", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
