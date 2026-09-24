import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = 'reports/phase3-postseason-workload-fix-4h-v1.json';
const SNAPSHOT = 'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz';
const SEED = 'phase3-4h-postseason-workload-baseline';
const gap = (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);
const snap = () => fs.readFileSync(path.join(ROOT,SNAPSHOT));
const clone = value => structuredClone(value);

function assertRound(before, after, round, expectedSeries) {
  assert.equal(validateSeasonSavePayload(after,{mode:'FULL'}),true);
  assert.equal(JSON.stringify(after.levelSeasons.MLB),JSON.stringify(before.levelSeasons.MLB), 'regular-season MLB stats changed');
  const series=after.postseasonState.rounds[round];
  assert.equal(series.length,expectedSeries);
  assert.ok(series.every(s=>s.games.length>=2),'a postseason series has too few games');
  const dates=series.flatMap(s=>s.games.map(g=>g.date)).sort();
  assert.ok(dates.length>=expectedSeries*2);
  assert.equal(after.playerStateDate,dates.at(-1),'global recovery date must equal final game date of the round');
  assert.ok(gap(before.playerStateDate,after.playerStateDate)>0,'round calendar failed to advance');
  const pitching=after.postseasonState.stats.pitching;
  let appearanceCount=0,usedPitchers=0;
  for (const [id,line] of Object.entries(pitching)) {
    if (Number(line.Pitches??0)<=0) continue;
    const previous=Number(before.pitcherStates[id]?.appearances??0);
    const current=Number(after.pitcherStates[id]?.appearances??0);
    const prevPost=Number(before.postseasonState.stats.pitching[id]?.G??0);
    const newPost=Number(line.G??0);
    const added=newPost-prevPost;
    assert.equal(current-previous,added,`pitcher ${id}: duplicate or missing postseason appearance`);
    if (added===0) continue; // Earlier-round pitchers need not pitch again.
    assert.ok(after.pitcherStates[id]?.lastAppearanceDate>=dates[0],`pitcher ${id} did not receive postseason date`);
    assert.ok(after.pitcherStates[id]?.lastAppearanceDate<=dates.at(-1),`pitcher ${id} has a future appearance date`);
    assert.ok(Number(after.pitcherStates[id]?.lastPitchCount??0)>0);
    assert.ok(Number(after.pitcherStates[id]?.fatigue??0)>=0 && Number(after.pitcherStates[id]?.fatigue??0)<=100);
    usedPitchers++;
    appearanceCount+=added;
  }
  assert.ok(usedPitchers>15,'too few pitchers observed');
  assert.ok(appearanceCount>30,'no postseason pitcher workload credited');
  assert.ok(Object.values(after.postseasonState.rosters).every(ids=>new Set(ids).size===ids.length),'roster duplicate returned');
  return {round,seriesCount:series.length,gameCount:dates.length,fromDate:before.playerStateDate,toDate:after.playerStateDate,usedPitchers,appearanceCount};
}

function main(){
  const master=JSON.parse(zlib.gunzipSync(snap()).toString('utf8'));
  assert.equal(master.metadata.contentHash,'fnv1a32:f7b34713');
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'Postseason Workload QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let season=seasonApi.createCareerSeason({seed:SEED,input,masterSnapshot:master});
  season=seasonApi.simulateToSeasonEnd(season.seasonId);
  assert.equal(season.status,'COMPLETE');
  season=seasonApi.startPostseason(season.seasonId);
  const opening=seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(opening,{mode:'FULL'}),true);
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const wc=seasonApi.serializeSeason(season.seasonId);
  const wildCard=assertRound(opening,wc,'WILD_CARD',4);
  assert.equal(wc.postseasonState.currentRound,'DIVISION_SERIES');
  // Replay from the exact same opening save, not a fresh career or a new seed.
  season=seasonApi.restoreSeason(clone(opening));
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const repeat=seasonApi.serializeSeason(season.seasonId);
  assert.deepEqual(repeat.postseasonState.rounds.WILD_CARD,wc.postseasonState.rounds.WILD_CARD,'same-seed series differ');
  assert.deepEqual(repeat.postseasonState.stats,wc.postseasonState.stats,'same-seed postseason stats differ');
  assert.deepEqual(repeat.pitcherStates,wc.pitcherStates,'same-seed pitcher states differ');
  assert.equal(repeat.playerStateDate,wc.playerStateDate);
  // At a round boundary a FULL save must restore workload without double-counting.
  season=seasonApi.restoreSeason(clone(wc));
  const restored=seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(restored,{mode:'FULL'}),true);
  assert.deepEqual(restored.pitcherStates,wc.pitcherStates,'saved pitcher workload lost');
  assert.deepEqual(restored.postseasonState.stats,wc.postseasonState.stats,'saved postseason totals changed');
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const ds=seasonApi.serializeSeason(season.seasonId);
  const divisionSeries=assertRound(wc,ds,'DIVISION_SERIES',4);
  const report={schema:'THE_CALL_UP_PHASE3_POSTSEASON_WORKLOAD_FIX_4H_V1',pass:true,seed:SEED,snapshotHash:master.metadata.contentHash,
    rules:{saveSchemaUnchanged:true,regularSeasonStatsUnchanged:true,sharedPitcherGameApplication:true,perTeamOverlappingCalendar:true,roundEndRecovery:true},
    wildCard,divisionSeries,determinism:{sameSeed:true,roundResultsEqual:true,statsEqual:true,pitcherStatesEqual:true},saveRestore:{full:true,workloadPreserved:true,statsPreserved:true},
    baselineReference:'reports/phase3-postseason-workload-baseline-4h-v1.json',shortRotation:'DEFERRED_TO_SEPARATE_POLICY_GATE'};
  fs.mkdirSync(path.join(ROOT,'reports'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,REPORT),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
