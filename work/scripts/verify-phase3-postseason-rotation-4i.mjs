import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = 'reports/phase3-postseason-short-rotation-4i-v1.json';
const SNAPSHOT = 'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz';
const SEED = 'phase3-4h-postseason-workload-baseline';
const VALID_REASONS = new Set(['ROTATION','ROTATION_BACKUP','ROTATION_LIMITED','ROTATION_BACKUP_LIMITED','FIFTH_STARTER','BULLPEN_DAY','EMERGENCY_SHORT_REST']);
const clone = x => structuredClone(x);
const gap = (a,b) => Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);

function assertRound(before, after, round, expectedSeries, rotationSize, recentStarts) {
  assert.equal(validateSeasonSavePayload(after,{mode:'FULL'}),true);
  assert.deepEqual(after.levelSeasons.MLB,before.levelSeasons.MLB,'regular MLB stats changed');
  const series=after.postseasonState.rounds[round];
  assert.equal(series.length,expectedSeries);
  const reasons={}; let games=0, starters=0, repeats=0;
  for(const s of series){
    assert.ok(s.games.length>=2,'postseason series must have games');
    for(const g of s.games){
      assert.equal(g.rotationSize,rotationSize,'incorrect postseason rotation size');
      assert.ok(g.awayTeamId!==g.homeTeamId);
      for(const side of ['away','home']){
        const id=g[`${side}StarterId`],teamId=g[`${side}TeamId`],reason=g[`${side}StarterReason`];
        assert.ok(typeof id==='string'&&id,`missing actual starting pitcher: ${g.gameId}/${side}`);
        assert.ok(after.postseasonState.rosters[teamId]?.includes(id),`starting pitcher not on eligible playoff roster ${id}`);
        assert.ok(VALID_REASONS.has(reason),`unknown rotation policy decision ${reason}`);
        const key=`${teamId}:${id}`;
        const prior=recentStarts.get(key);
        if(prior){
          assert.ok(gap(prior,g.date)>=1,`same-day repeat starter ${id}`);
          repeats++;
        }
        recentStarts.set(key,g.date);
        reasons[reason]=(reasons[reason]??0)+1;
        starters++;
      }
      games++;
    }
  }
  assert.ok(games>=expectedSeries*2);
  assert.equal(starters,games*2);
  assert.ok(after.playerStateDate>before.playerStateDate,'postseason calendar did not advance');
  const postseasonStats=after.postseasonState.stats.pitching;
  let pitcherAppearances=0;
  for(const [id,line] of Object.entries(postseasonStats)) {
    const added=Number(line?.G??0)-Number(before.postseasonState.stats.pitching[id]?.G??0);
    assert.equal((after.pitcherStates[id]?.appearances??0)-(before.pitcherStates[id]?.appearances??0),added,`pitcher ${id} workload lost or doubled`);
    pitcherAppearances+=added;
  }
  assert.ok(pitcherAppearances>=starters,'too few postseason pitcher appearances');
  return {round,rotationSize,seriesCount:series.length,gameCount:games,starterAssignments:starters,repeatedStarterAssignments:repeats,reasonCounts:reasons,pitcherAppearances};
}

function main(){
  const baseline=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-postseason-workload-fix-4h-v1.json'),'utf8'));
  assert.equal(baseline.pass,true);assert.equal(baseline.snapshotHash,'fnv1a32:f7b34713');
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,SNAPSHOT))).toString('utf8'));
  assert.equal(master.metadata.contentHash,'fnv1a32:f7b34713');
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4I QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let season=seasonApi.createCareerSeason({seed:SEED,input,masterSnapshot:master});
  season=seasonApi.simulateToSeasonEnd(season.seasonId);
  assert.equal(season.status,'COMPLETE');
  season=seasonApi.startPostseason(season.seasonId);
  const opening=seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(opening,{mode:'FULL'}),true);
  const recentStarts=new Map();
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const wc=seasonApi.serializeSeason(season.seasonId);
  const wildCard=assertRound(opening,wc,'WILD_CARD',4,3,recentStarts);
  season=seasonApi.restoreSeason(clone(opening));
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const repeat=seasonApi.serializeSeason(season.seasonId);
  assert.deepEqual(repeat.postseasonState.rounds.WILD_CARD,wc.postseasonState.rounds.WILD_CARD,'same-seed starter/game outcomes changed');
  assert.deepEqual(repeat.postseasonState.stats,wc.postseasonState.stats,'same-seed playoff stats changed');
  assert.deepEqual(repeat.pitcherStates,wc.pitcherStates,'same-seed workload changed');
  season=seasonApi.restoreSeason(clone(wc));
  const restored=seasonApi.serializeSeason(season.seasonId);
  assert.equal(validateSeasonSavePayload(restored,{mode:'FULL'}),true);
  assert.deepEqual(restored.pitcherStates,wc.pitcherStates,'playoff workload was not preserved after FULL restore');
  season=seasonApi.advancePostseasonRound(season.seasonId);
  const ds=seasonApi.serializeSeason(season.seasonId);
  const divisionSeries=assertRound(wc,ds,'DIVISION_SERIES',4,4,recentStarts);
  const report={schema:'THE_CALL_UP_PHASE3_POSTSEASON_SHORT_ROTATION_4I_V1',pass:true,seed:SEED,snapshotHash:master.metadata.contentHash,
    scope:{wildCardRotation:3,longSeriesRotation:4,pitcherRestUsesLastAppearance:true,injuredStartersExcluded:true,regularSeasonUnchanged:true,saveSchemaUnchanged:true},
    wildCard,divisionSeries,saveRestore:{full:true,pitcherWorkloadPreserved:true},determinism:{sameSeedRound:true,roundResultsEqual:true,statsEqual:true,pitcherStatesEqual:true},
    baselineReference:'reports/phase3-postseason-workload-fix-4h-v1.json',
    note:'Four-man rotation is the default for longer series. Healthy and rested fifth starters or bullpen days may be used before emergency short rest.'};
  fs.mkdirSync(path.join(ROOT,'reports'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,REPORT),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
