import fs from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { createSeasonSaveService } from "../src/services/seasonSaveService.js";

function memoryRepository() {
  const store = new Map();
  return {
    async put(record) { store.set(record.saveId, structuredClone(record)); return structuredClone(record); },
    async get(id) { return store.has(id) ? structuredClone(store.get(id)) : null; },
    async getMeta(id) { const row=store.get(id); if(!row) return null; const {payload:_p,...meta}=row; return structuredClone(meta); },
    async list() { return [...store.values()].map(({payload:_p,...meta})=>structuredClone(meta)); },
    async delete(id) { return store.delete(id); }
  };
}

const seedArg = process.argv.find((arg) => arg.startsWith("--seeds="));
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const verify = process.argv.includes("--verify");
const seedCount = Number(seedArg?.slice(8) ?? 6);
const rows = [];

for (let i = 0; i < seedCount; i += 1) {
  const seed = `v22-promotion-ai-${i + 1}`;
  let season = seasonApi.createDemoSeason({ seed, startDate: "2026-04-01" });
  while (season.status !== "COMPLETE") season = seasonApi.simulateCurrentGame(season.seasonId);

  const evalView = season.organization.userEvaluation;
  const payload = seasonApi.serializeSeason(season.seasonId);
  const rawOrg = payload.organizationState;
  const publicSafe = evalView && !("internal" in evalView) && !("candidateScore" in evalView) && !("incumbentScore" in evalView);

  const repo = memoryRepository();
  const saveService = createSeasonSaveService({ repository: repo, now: () => `2026-09-19T12:${String(i).padStart(2,"0")}:00.000Z` });
  const saveId = `v22-promo-${i+1}`;
  await saveService.saveSeason(season.seasonId, { saveId, label: `V22 Promo ${i+1}` });
  const restored = await saveService.loadSeason(saveId);

  const legacy = structuredClone(payload);
  delete legacy.organizationState;
  legacy.gameVersion = "phase2_role_momentum_v21";
  const legacyRestored = seasonApi.restoreSeason(legacy);

  const row = {
    seed: i + 1,
    status: season.status,
    teamGames: season.progress.gamesPlayed,
    userAppearances: season.userSeasonLine.G,
    restGames: season.userRole.restGames,
    leagueGames: season.progress.leagueGamesCompleted,
    userLevel: season.organization.userLevel,
    orgReviews: season.organization.review?.reviews ?? 0,
    rawOrgReviews: rawOrg?.reviews ?? 0,
    transactionCount: season.organization.review?.transactions?.length ?? 0,
    readiness: evalView?.readiness ?? null,
    path: evalView?.path ?? null,
    decision: evalView?.decision ?? null,
    reasons: evalView?.reasonCodes ?? [],
    publicSafe,
    roundTrip: restored.organization.userLevel === season.organization.userLevel && restored.organization.review?.reviews === season.organization.review?.reviews && restored.organization.userEvaluation?.path === evalView?.path,
    legacyRebuild: legacyRestored.organization.review?.reviews === 0 && legacyRestored.organization.review?.lastReviewDate === "2026-04-01",
    nextGameVersion: seasonApi.serializeSeason(legacyRestored.seasonId).gameVersion
  };
  rows.push(row);
  if (verify) {
    if (row.status !== "COMPLETE" || row.teamGames !== 28 || row.leagueGames !== 112 || row.userAppearances !== 27 || row.restGames !== 1) throw new Error(`seed ${i+1}: season regression`);
    if (row.userLevel !== "AAA" || row.transactionCount !== 0) throw new Error(`seed ${i+1}: baseline should remain blocked in AAA`);
    if (row.orgReviews !== 4 || row.rawOrgReviews !== 4) throw new Error(`seed ${i+1}: review cadence broken`);
    if (row.readiness !== "MLB_READY" || row.path !== "BLOCKED" || row.decision !== "HOLD") throw new Error(`seed ${i+1}: readiness/path split broken`);
    if (!row.reasons.includes("BLOCKED_BY_ESTABLISHED_STARTER") || !row.publicSafe) throw new Error(`seed ${i+1}: WHY/public safety broken`);
    if (!row.roundTrip || !row.legacyRebuild || row.nextGameVersion !== "phase3_pitcher_movement_v25") throw new Error(`seed ${i+1}: save compatibility broken`);
  }
}

const report = { version: "v22", seeds: seedCount, verified: verify, rows };
const output = outputArg?.slice("--output=".length);
if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
