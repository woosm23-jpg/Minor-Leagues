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
  const seed = `v21-role-momentum-${i + 1}`;
  let season = seasonApi.createDemoSeason({ seed, startDate: "2026-04-01" });
  const roleHistory = [season.userRole.assignment.role];
  const bandHistory = [season.userRole.assignment.momentumBand];
  let previousRole = season.userRole.assignment.role;
  let roleChanges = 0;
  while (season.status !== "COMPLETE") {
    season = seasonApi.simulateCurrentGame(season.seasonId);
    const role = season.userRole.assignment.role;
    roleHistory.push(role);
    bandHistory.push(season.userRole.assignment.momentumBand);
    if (role !== previousRole) roleChanges += 1;
    previousRole = role;
  }

  const payload = seasonApi.serializeSeason(season.seasonId);
  const rawRoleState = payload.roleStates?.[season.userPlayer.id] ?? null;
  const publicRole = season.userRole.assignment;

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T11:${String(i).padStart(2, "0")}:00.000Z` });
  const saveId = `v21-role-${i + 1}`;
  await saveService.saveSeason(season.seasonId, { saveId, label: `V21 Role ${i + 1}` });
  const restored = await saveService.loadSeason(saveId);

  const legacyPayload = structuredClone(payload);
  delete legacyPayload.roleStates;
  legacyPayload.gameVersion = "phase2_organization_depth_v20";
  const legacyRestored = seasonApi.restoreSeason(legacyPayload);

  const row = {
    seed: i + 1,
    status: season.status,
    userGames: season.progress.gamesPlayed,
    userAppearances: season.userSeasonLine.G,
    leagueGames: season.progress.leagueGamesCompleted,
    initialRole: roleHistory[0],
    finalRole: publicRole.role,
    roleChanges,
    reviews: publicRole.reviews,
    momentumBands: [...new Set(bandHistory)],
    restGames: season.userRole.restGames,
    publicHiddenSafe: !("momentum" in publicRole) && !("recentFeedback" in publicRole),
    rawMomentumValid: rawRoleState && rawRoleState.momentum >= -1 && rawRoleState.momentum <= 1,
    roundTripRole: restored.userRole.assignment.role === publicRole.role && restored.userRole.assignment.momentumBand === publicRole.momentumBand,
    legacyRoleRebuild: legacyRestored.userRole.assignment.role === "AAA_STARTER" && legacyRestored.userRole.assignment.level === "AAA",
    nextGameVersion: seasonApi.serializeSeason(legacyRestored.seasonId).gameVersion,
    organizationLevels: season.organization.levelOrder,
    leaderCategories: season.leaders.categoryOrder.length
  };
  rows.push(row);

  if (verify) {
    if (row.status !== "COMPLETE" || row.userGames !== 28 || row.userAppearances !== 27 || row.restGames !== 1 || row.leagueGames !== 112) throw new Error(`seed ${i + 1}: season completion broken`);
    if (row.initialRole !== "AAA_STARTER" || row.roleChanges > 4 || row.reviews < 1) throw new Error(`seed ${i + 1}: role persistence/review broken`);
    if (!row.publicHiddenSafe || !row.rawMomentumValid || !row.roundTripRole) throw new Error(`seed ${i + 1}: role persistence/public view broken`);
    if (!row.legacyRoleRebuild || row.nextGameVersion !== "phase3_pitcher_movement_v25") throw new Error(`seed ${i + 1}: legacy rebuild/game version broken`);
    if (JSON.stringify(row.organizationLevels) !== JSON.stringify(["MLB", "AAA", "AA", "A"]) || row.leaderCategories !== 9) throw new Error(`seed ${i + 1}: v20/v19 regression`);
  }
}

const report = { version: "v21", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
