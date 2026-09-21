#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createMasterSnapshot } from "../src/data/masterSnapshot.js";
import {
  MLB_STATS_BASE_URL, MLB_STATS_SPORT_IDS, masterSnapshotSourceCatalog, normalizeAffiliatesResponse,
  normalizeAffiliationsFromTeams, normalizeRosterResponse, normalizeScheduleResponse, normalizeStatsResponse, normalizeTeamsResponse
} from "../src/data/mlbStatsApiAdapter.js";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "THE-CALL-UP-v45-master-snapshot-builder" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
function uniqBy(rows, keyFn) { const seen = new Set(); return rows.filter((row) => { const key = keyFn(row); if (seen.has(key)) return false; seen.add(key); return true; }); }

const season = Number(arg("season", "2026"));
const snapshotDate = arg("snapshot-date", new Date().toISOString().slice(0, 10));
const output = arg("output", `data/master-snapshots/mlb-milb-${season}-${snapshotDate}.json`);
const productionReady = arg("production-ready", "true") !== "false";
const createdAt = new Date().toISOString();

const teams = [];
for (const sportId of MLB_STATS_SPORT_IDS) {
  const raw = await getJson(`${MLB_STATS_BASE_URL}/teams?sportId=${sportId}&season=${season}&hydrate=parentOrg`);
  teams.push(...normalizeTeamsResponse(raw, { sportId }));
}

const players = [];
for (const team of teams) {
  const sportId = Number(Object.entries({1:"MLB",11:"AAA",12:"AA",13:"HIGH_A",14:"A"}).find(([, level]) => level === team.level)?.[0]);
  const raw = await getJson(`${MLB_STATS_BASE_URL}/teams/${team.id}/roster?rosterType=active&season=${season}&hydrate=person`);
  players.push(...normalizeRosterResponse(raw, { team, sportId }));
}

let affiliations = normalizeAffiliationsFromTeams(teams, { season });
const coveredOrgs = new Set(affiliations.map((row) => row.organizationId));
for (const mlbTeam of teams.filter((team) => team.level === "MLB" && !coveredOrgs.has(team.id))) {
  const raw = await getJson(`${MLB_STATS_BASE_URL}/teams/affiliates?teamIds=${mlbTeam.id}&season=${season}`);
  affiliations.push(...normalizeAffiliatesResponse(raw, { organizationId: mlbTeam.id, season }));
}
affiliations = uniqBy(affiliations, (row) => `${row.organizationId}:${row.level}:${row.teamId}`);

const stats = [];
for (const sportId of MLB_STATS_SPORT_IDS) {
  for (const group of ["hitting", "pitching", "fielding"]) {
    const raw = await getJson(`${MLB_STATS_BASE_URL}/stats?stats=season&group=${group}&season=${season}&sportIds=${sportId}&playerPool=ALL&limit=5000&hydrate=team`);
    stats.push(...normalizeStatsResponse(raw, { sportId, group, season }));
  }
}

const schedule = [];
for (const sportId of MLB_STATS_SPORT_IDS) {
  const raw = await getJson(`${MLB_STATS_BASE_URL}/schedule?sportId=${sportId}&season=${season}&gameTypes=R`);
  schedule.push(...normalizeScheduleResponse(raw, { sportId }));
}

const snapshot = createMasterSnapshot({
  metadata: {
    snapshotId: `mlb-milb-${season}-${snapshotDate}`, snapshotDate, season, createdAt, kind: "REAL_WORLD",
    productionReady, notes: "Normalized MLB Stats API snapshot. v45 stores raw/public source facts only; rating inference is v46."
  },
  sources: masterSnapshotSourceCatalog({ season, retrievedAt: createdAt }), teams, players: uniqBy(players, (row) => row.id), affiliations,
  stats: uniqBy(stats, (row) => `${row.playerId}:${row.teamId}:${row.level}:${row.group}:${row.gameType}:${row.position ?? ""}`),
  schedule: uniqBy(schedule, (row) => row.gamePk)
});

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output, snapshotId: snapshot.metadata.snapshotId, hash: snapshot.metadata.contentHash, teams: snapshot.teams.length, players: snapshot.players.length, affiliations: snapshot.affiliations.length, stats: snapshot.stats.length, games: snapshot.schedule.length }, null, 2));
