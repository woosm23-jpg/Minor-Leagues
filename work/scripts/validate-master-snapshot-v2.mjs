#!/usr/bin/env node
import fs from "node:fs/promises";
import process from "node:process";
import { createSaveUniverseFromMasterSnapshot, validateMasterSnapshot } from "../src/data/masterSnapshot.js";
import { inferRealWorldUniverse } from "../src/data/realWorldInference.js";
import { validateProductionRuntimeUniverse } from "../src/services/productionSeasonFactory.js";
import { isPlayerGameAvailable, playerAssignedLevel, playerAssignedTeamId } from "../src/data/rosterAvailability.js";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) { const key = String(keyFn(row)); out[key] = (out[key] ?? 0) + 1; }
  return out;
}
function fail(message) { throw new RangeError(message); }

const input = arg("input", "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json");
const raw = JSON.parse(await fs.readFile(input, "utf8"));
if (raw.schemaVersion !== 2) fail(`snapshot schema가 v2가 아닙니다: ${raw.schemaVersion}`);
validateMasterSnapshot(raw, { requireProductionCoverage: true });

const playerIds = raw.players.map((p) => String(p.id));
if (new Set(playerIds).size !== playerIds.length) fail("canonical player id 중복이 있습니다.");
const availability = countBy(raw.players, (p) => p.availability ?? "MISSING");
const activePlayers = raw.players.filter(isPlayerGameAvailable);
const ilPlayers = raw.players.filter((p) => String(p.availability ?? "").startsWith("INJURED_"));
const on40Man = raw.players.filter((p) => p.on40Man === true);
const mlbActive = raw.players.filter((p) => p.mlbActive === true);
const optioned = raw.players.filter((p) => p.on40Man === true && p.mlbActive === false && playerAssignedLevel(p) !== "MLB" && isPlayerGameAvailable(p));
if (mlbActive.length < 600) fail(`MLB active coverage가 비정상적으로 작습니다: ${mlbActive.length}`);
if (on40Man.length < mlbActive.length) fail(`40-man coverage가 MLB active보다 작습니다: ${on40Man.length}/${mlbActive.length}`);
if (ilPlayers.length === 0) fail("IL 선수가 0명입니다. rosterType/fullRoster 수집을 확인하십시오.");
if (optioned.length === 0) fail("40-man optioned active minor leaguer가 0명입니다. ownership/assignment 병합을 확인하십시오.");

const expectedSeasons = [2024, 2025, 2026];
const groups = ["hitting", "pitching", "fielding"];
const levels = ["MLB", "AAA", "AA", "HIGH_A", "A"];
for (const season of expectedSeasons) {
  if (!raw.stats.some((row) => Number(row.season) === season)) fail(`${season} stats가 비어 있습니다.`);
  for (const group of groups) if (!raw.stats.some((row) => Number(row.season) === season && row.group === group)) fail(`${season}/${group} stats가 비어 있습니다.`);
}
for (const level of levels) if (!activePlayers.some((p) => playerAssignedLevel(p) === level)) fail(`${level} game-available player가 없습니다.`);

// A global sport-wide season query collapses same-level trades. The v2 collector
// is required to preserve team segments, so at least one player across three
// seasons/five levels should have evidence from multiple teams at one level.
const segmentTeams = new Map();
for (const row of raw.stats) {
  if (row.teamId == null) fail(`team-segment stat에 teamId가 없습니다: ${row.playerId}/${row.season}/${row.level}/${row.group}`);
  const key = `${row.playerId}:${row.season}:${row.level}:${row.group}`;
  if (!segmentTeams.has(key)) segmentTeams.set(key, new Set());
  segmentTeams.get(key).add(String(row.teamId));
}
const sameLevelMultiTeamSegments = [...segmentTeams.values()].filter((teams) => teams.size > 1).length;
if (sameLevelMultiTeamSegments === 0) fail("same-level multi-team stat segment가 0개입니다. teamId-filtered 수집이 적용됐는지 확인하십시오.");

const teamIds = new Set(raw.teams.map((t) => String(t.id)));
for (const p of raw.players) {
  const teamId = playerAssignedTeamId(p);
  if (teamId != null && !teamIds.has(String(teamId))) fail(`assigned team이 snapshot teams에 없습니다: ${p.id}/${teamId}`);
  if (!Array.isArray(p.positions) || p.positions.length === 0) fail(`position evidence가 없습니다: ${p.id}`);
}

const universe = createSaveUniverseFromMasterSnapshot(raw, { copiedAtCareerStart: raw.metadata.snapshotDate, sourceVersion: "master-snapshot-v2-phase-a" });
const inferred = inferRealWorldUniverse(universe);
validateProductionRuntimeUniverse(inferred);

const report = {
  pass: true,
  input,
  snapshotId: raw.metadata.snapshotId,
  contentHash: raw.metadata.contentHash,
  players: raw.players.length,
  activePlayers: activePlayers.length,
  availability,
  on40Man: on40Man.length,
  mlbActive: mlbActive.length,
  optionedActiveMinor: optioned.length,
  statsRows: raw.stats.length,
  statsBySeason: countBy(raw.stats, (r) => r.season),
  statsByLevel: countBy(raw.stats, (r) => r.level),
  sameLevelMultiTeamSegments,
  positionEvidencePlayers: raw.players.filter((p) => Array.isArray(p.positions) && p.positions.some((x) => Number(x.games ?? 0) > 0 || Number(x.innings ?? 0) > 0)).length,
  runtimeGate: "PASS"
};
console.log(JSON.stringify(report, null, 2));
