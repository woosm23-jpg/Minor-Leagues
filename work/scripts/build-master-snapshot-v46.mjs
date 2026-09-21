#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createMasterSnapshot } from "../src/data/masterSnapshot.js";
import {
  MLB_STATS_BASE_URL, MLB_STATS_SPORT_IDS, masterSnapshotSourceCatalog, mergeSavantParkFactors,
  normalizeAffiliatesResponse, normalizeAffiliationsFromTeams, normalizeRosterResponse,
  normalizeScheduleResponse, normalizeStatsResponse, normalizeTeamsResponse, normalizeVenueResponse
} from "../src/data/mlbStatsApiAdapter.js";
import { mergeStatcastPercentilesIntoStats } from "../src/data/statcastAdapter.js";

function arg(name, fallback = null) {
  const prefix = `--${name}=`; const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
async function getJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "THE-CALL-UP-v46-master-snapshot-builder" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
async function optionalJson(file) { if (!file) return null; return JSON.parse(await fs.readFile(file,"utf8")); }
function uniqBy(rows,keyFn){const seen=new Set();return rows.filter((row)=>{const key=keyFn(row);if(seen.has(key))return false;seen.add(key);return true;});}

const season=Number(arg("season","2026"));
const snapshotDate=arg("snapshot-date",new Date().toISOString().slice(0,10));
const output=arg("output",`data/master-snapshots/mlb-milb-${season}-${snapshotDate}-v46.json`);
const productionReady=arg("production-ready","true")!=="false";
const parkFactorsFile=arg("park-factors-json",null);
const statcastFile=arg("statcast-percentiles-json",null);
const createdAt=new Date().toISOString();

const teams=[];
for(const sportId of MLB_STATS_SPORT_IDS){
  const raw=await getJson(`${MLB_STATS_BASE_URL}/teams?sportId=${sportId}&season=${season}&hydrate=parentOrg`);
  teams.push(...normalizeTeamsResponse(raw,{sportId}));
}
const players=[];
for(const team of teams){
  const sportId=Number(Object.entries({1:"MLB",11:"AAA",12:"AA",13:"HIGH_A",14:"A"}).find(([,level])=>level===team.level)?.[0]);
  const raw=await getJson(`${MLB_STATS_BASE_URL}/teams/${team.id}/roster?rosterType=active&season=${season}&hydrate=person`);
  players.push(...normalizeRosterResponse(raw,{team,sportId}));
}
let affiliations=normalizeAffiliationsFromTeams(teams,{season});
const coveredOrgs=new Set(affiliations.map((row)=>row.organizationId));
for(const mlbTeam of teams.filter((team)=>team.level==="MLB"&&!coveredOrgs.has(team.id))){
  const raw=await getJson(`${MLB_STATS_BASE_URL}/teams/affiliates?teamIds=${mlbTeam.id}&season=${season}`);
  affiliations.push(...normalizeAffiliatesResponse(raw,{organizationId:mlbTeam.id,season}));
}
affiliations=uniqBy(affiliations,(row)=>`${row.organizationId}:${row.level}:${row.teamId}`);
let stats=[];
for(const sportId of MLB_STATS_SPORT_IDS) for(const group of ["hitting","pitching","fielding"]){
  const raw=await getJson(`${MLB_STATS_BASE_URL}/stats?stats=season&group=${group}&season=${season}&sportIds=${sportId}&playerPool=ALL&limit=5000&hydrate=team`);
  stats.push(...normalizeStatsResponse(raw,{sportId,group,season}));
}
const statcast=await optionalJson(statcastFile);
if(statcast) stats=mergeStatcastPercentilesIntoStats(stats,Array.isArray(statcast)?statcast:(statcast.rows??statcast.data??[]),{season});
const schedule=[];
for(const sportId of MLB_STATS_SPORT_IDS){
  const raw=await getJson(`${MLB_STATS_BASE_URL}/schedule?sportId=${sportId}&season=${season}&gameTypes=R`);
  schedule.push(...normalizeScheduleResponse(raw,{sportId}));
}
let parks=[];
for(const team of teams.filter((team)=>team.level==="MLB"&&team.venueId)){
  const raw=await getJson(`${MLB_STATS_BASE_URL}/venues/${team.venueId}`);
  const park=normalizeVenueResponse(raw,{team}); if(park) parks.push(park);
}
const parkFactors=await optionalJson(parkFactorsFile);
if(parkFactors) parks=mergeSavantParkFactors(parks,Array.isArray(parkFactors)?parkFactors:(parkFactors.rows??parkFactors.data??[]));

const sources=[...masterSnapshotSourceCatalog({season,retrievedAt:createdAt})];
if(parkFactorsFile) sources.push({id:"baseball_savant_park_factors",name:"Baseball Savant — Statcast Park Factors",url:"https://baseballsavant.mlb.com/leaderboard/statcast-park-factors",retrievedAt:createdAt,notes:`local export=${parkFactorsFile}`});
if(statcastFile) sources.push({id:"baseball_savant_percentiles",name:"Baseball Savant — Statcast Percentile Rankings",url:"https://baseballsavant.mlb.com/leaderboard/percentile-rankings",retrievedAt:createdAt,notes:`local export=${statcastFile}`});

const snapshot=createMasterSnapshot({
  metadata:{snapshotId:`mlb-milb-${season}-${snapshotDate}-v46`,snapshotDate,season,createdAt,kind:"REAL_WORLD",productionReady,notes:"v46 public-data snapshot with MLB venue geometry; optional Savant percentile and park-factor exports remain public evidence, not ratings."},
  sources,teams,players:uniqBy(players,(row)=>row.id),affiliations,
  stats:uniqBy(stats,(row)=>`${row.playerId}:${row.teamId}:${row.level}:${row.group}:${row.gameType}:${row.position??""}`),
  schedule:uniqBy(schedule,(row)=>row.gamePk),parks:uniqBy(parks,(row)=>row.venueId)
});
await fs.mkdir(path.dirname(output),{recursive:true});
await fs.writeFile(output,JSON.stringify(snapshot,null,2)+"\n","utf8");
console.log(JSON.stringify({output,snapshotId:snapshot.metadata.snapshotId,hash:snapshot.metadata.contentHash,teams:snapshot.teams.length,players:snapshot.players.length,affiliations:snapshot.affiliations.length,stats:snapshot.stats.length,games:snapshot.schedule.length,parks:snapshot.parks.length},null,2));
