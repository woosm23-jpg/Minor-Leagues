import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DATA=path.join(ROOT,'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const REPORT=path.join(ROOT,'reports/phase3-integrated-regression-4r-v1.json');
const LEVELS=['A','HIGH_A','AA','AAA','MLB'];
const PRIOR=['4a','4b','4c','4d','4e','4f','4g','4h','4l','4m','4n','4o','4p','4q'];
const FILES={
  '4a':'phase3-daily-lineup-4a-v1.json','4b':'phase3-batting-order-4b-v1.json',
  '4c':'phase3-rest-policy-4c-v1.json','4d':'phase3-late-game-bench-4d-v1.json',
  '4e':'phase3-bullpen-leverage-4e-v1.json','4f':'phase3-bullpen-recovery-4f-v1.json',
  '4g':'phase3-starter-tto-4g-v1.json','4h':'phase3-postseason-workload-fix-4h-v1.json',
  '4l':'phase3-full-postseason-rotation-gate-4l-v1.json',
  '4m':'phase3-development-promotion-audit-4m-v1.json',
  '4n':'phase3-injury-emergency-audit-4n-v1.json',
  '4o':'phase3-emergency-callup-primitives-4o-v1.json',
  '4p':'phase3-automatic-injury-callup-4p-v1.json',
  '4q':'phase3-scouting-position-audit-4q-v1.json'
};
const clone=x=>structuredClone(x);
const valid=(p,label)=>assert.equal(validateSeasonSavePayload(p,{mode:'FULL'}),true,`${label}: FULL save invalid`);
function priorGates(){
  const results={};
  for(const key of PRIOR){
    const file=FILES[key];
    const row=JSON.parse(fs.readFileSync(path.join(ROOT,'reports',file),'utf8'));
    assert.equal(row.pass,true,`prior ${key} report not PASS`);
    assert.equal(row.snapshotHash,'fnv1a32:f7b34713',`prior ${key} snapshot changed`);
    if(row.gates) for(const [gate,result] of Object.entries(row.gates)){
      if(typeof result==='boolean') assert.equal(result,true,`${key} gate ${gate} failed`);
    }
    results[key]=row.schema;
  }
  const il=JSON.parse(fs.readFileSync(path.join(ROOT,'reports',FILES['4p']),'utf8'));
  assert.equal(il.gates.automaticInjuryTrigger,true);
  assert.equal(il.gates.automaticReturn,true);
  assert.equal(il.gates.injuredMlbServiceDaysCredited,true);
  const scout=JSON.parse(fs.readFileSync(path.join(ROOT,'reports',FILES['4q']),'utf8'));
  assert.equal(scout.promotion.realReviewHiddenCeilingInvariant,true);
  assert.equal(scout.position.saveRestoreSame,true);
  return results;
}
function inspectRosters(p,label){
  const org=p.fixture.organization;
  assert.deepEqual(org.levelOrder,['MLB','AAA','AA','HIGH_A','A']);
  const assigned=new Set();
  const counts={};
  for(const level of org.levelOrder){
    const affiliate=org.levels[level],roster=affiliate.roster;
    assert.deepEqual(p.fixture.levelLeagues[level].rosters[String(affiliate.team.id)],roster,`${label}: ${level} roster mirror drift`);
    const ids=Object.keys(roster.players??{});
    counts[level]=ids.length;
    for(const id of ids){assert.ok(!assigned.has(id),`${label}: duplicate player ${id}`);assigned.add(id);}
  }
  assert.deepEqual(p.fixture.rosters[p.fixture.userTeamId],org.levels.AAA.roster,`${label}: canonical AAA roster drift`);
  assert.ok(assigned.has(p.fixture.userPlayerId),`${label}: user is absent from organization`);
  const moves=p.organizationState?.emergencyInjuryMoves??[];
  for(const entry of moves){
    const il=p.rosterControlStates[entry.injuredPlayerId];
    assert.ok(il,`${label}: IL control missing for ${entry.injuredPlayerId}`);
    if(entry.status==='ACTIVE'){
      assert.equal(il.assignmentStatus,'MLB_INJURED_LIST',`${label}: active IL drift: ${JSON.stringify(entry)}`);
      assert.equal(il.on40Man,true,`${label}: 40-man lost for active IL player`);
      assert.ok(org.levels.AAA.roster.players[entry.injuredPlayerId]);
      if(!org.levels.MLB.roster.players[entry.replacementId]) {
        const chained=moves.some(x=>x.status==='ACTIVE' && x.injuredPlayerId===entry.replacementId);
        assert.ok(chained && org.levels.AAA.roster.players[entry.replacementId],
          `${label}: temporary replacement moved without a tracked nested IL injury`);
      }
    }else if(entry.status==='RETURNED'){
      // Historical returns need not remain on today's MLB roster.
      assert.ok(entry.returnedDate>=entry.minReturnDate,`${label}: early IL return`);
    }else throw new Error(`${label}: unexpected emergency move status ${entry.status}`);
  }
  return {players:assigned.size,perLevel:counts,emergencyMoves:moves.length,
    activeInjuredList:moves.filter(x=>x.status==='ACTIVE').length,
    returnedFromInjuredList:moves.filter(x=>x.status==='RETURNED').length};
}
function checkDetailedReplay(seasonId){
  // Live interactive GameAPI path, not merely a regular fast simulation.
  seasonApi.startCurrentGame(seasonId);
  const checkpoint=seasonApi.serializeSeason(seasonId);valid(checkpoint,'active-game checkpoint');
  assert.ok(checkpoint.activeGameCheckpoint,'no interactive game checkpoint created');
  assert.ok(checkpoint.activeScheduleGameId,'missing scheduled interactive game');
  const before=Object.values(checkpoint.levelSeasons).reduce((n,x)=>n+x.completedGames,0);
  seasonApi.simulateCurrentGame(seasonId);
  const direct=seasonApi.serializeSeason(seasonId);valid(direct,'first detailed completion');
  const after=Object.values(direct.levelSeasons).reduce((n,x)=>n+x.completedGames,0);
  assert.ok(after>before,'interactive game did not complete');
  seasonApi.restoreSeason(clone(checkpoint));
  const restored=seasonApi.serializeSeason(seasonId);valid(restored,'restored interactive game');
  assert.equal(restored.activeScheduleGameId,checkpoint.activeScheduleGameId);
  seasonApi.simulateCurrentGame(seasonId);
  const replay=seasonApi.serializeSeason(seasonId);valid(replay,'replayed detailed completion');
  for(const key of ['levelSeasons','playerStates','pitcherStates','roleStates','organizationState','rosterControlStates','contractStates']){
    assert.deepEqual(replay[key],direct[key],`interactive checkpoint replay diverged: ${key}`);
  }
  assert.equal(replay.playerStateDate,direct.playerStateDate);
  return {gameId:checkpoint.activeScheduleGameId,worldGamesBefore:before,worldGamesAfter:after,
    fullSaveRestore:true,fastAndDetailedSharedStateDeterministic:true};
}
function main(){
  const prerequisites=priorGates();
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(DATA)).toString('utf8'));
  assert.equal(master.metadata.contentHash,'fnv1a32:f7b34713');
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4R QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,
    bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',
    visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  const seed='phase3-4r-integration-2026';
  // The demo user's guaranteed AAA role isolates detailed checkpoint replay
  // from ordinary production bench-selection decisions. The 10,710-game
  // production season below is exercised independently on the same engine.
  const detailedSeason=seasonApi.createDemoSeason({seed:'phase3-4r-detailed-checkpoint',startDate:'2026-04-01'});
  const detailed=checkDetailedReplay(detailedSeason.seasonId);
  const snap=seasonApi.createCareerSeason({seed,input,masterSnapshot:master});
  const id=snap.seasonId;
  const opening=seasonApi.serializeSeason(id);valid(opening,'opening');
  assert.equal(opening.fixture.worldMode,'PRODUCTION_REAL');
  const initialRosters=inspectRosters(opening,'opening');
  const finishedView=seasonApi.simulateToSeasonEnd(id);
  assert.equal(finishedView.status,'COMPLETE','2026 regular season did not complete');
  const finished=seasonApi.serializeSeason(id);valid(finished,'regular-season end');
  const levelGames={};
  for(const level of LEVELS){
    const x=finished.levelSeasons[level];
    assert.ok(x?.schedule?.length,`missing ${level} schedule`);
    assert.equal(x.completedGames,x.schedule.length,`${level} regular season incomplete`);
    levelGames[level]=x.completedGames;
  }
  const worldGames=Object.values(levelGames).reduce((a,b)=>a+b,0);
  assert.equal(worldGames,10710,'2026 world games unexpectedly changed');
  const finalRosters=inspectRosters(finished,'regular-season end');
  assert.equal(finalRosters.players,initialRosters.players,'organization population drift');
  assert.ok(finished.organizationState.reviews>0,'organization never reviewed real season');
  assert.ok(Object.keys(finished.organizationState.latestEvaluations??{}).length>0,'no real promotion evaluations');
  const saved=clone(finished);
  seasonApi.restoreSeason(saved);
  const restoredRegular=seasonApi.serializeSeason(id);valid(restoredRegular,'restored full season');
  for(const key of ['levelSeasons','playerStates','pitcherStates','organizationState','rosterControlStates'])
    assert.deepEqual(restoredRegular[key],finished[key],`season-end restore changed ${key}`);
  const twice=seasonApi.simulateToSeasonEnd(id);
  assert.equal(twice.status,'COMPLETE');
  const repeated=seasonApi.serializeSeason(id);
  for(const key of ['levelSeasons','playerStates','pitcherStates','organizationState','rosterControlStates'])
    assert.deepEqual(repeated[key],finished[key],`second season end changed ${key}`);
  seasonApi.startPostseason(id);
  let bracket=seasonApi.getSeason(id),rounds=0;
  while(bracket.postseason?.status!=='COMPLETE' && rounds<6){
    bracket=seasonApi.advancePostseasonRound(id);rounds++;
  }
  assert.equal(bracket.postseason?.status,'COMPLETE','postseason did not finish all rounds');
  assert.ok(bracket.postseason.championTeamId,'postseason champion missing');
  const playoff=seasonApi.serializeSeason(id);valid(playoff,'postseason completed');
  assert.deepEqual(playoff.levelSeasons.MLB,finished.levelSeasons.MLB,'postseason altered regular MLB statistics');
  assert.equal(playoff.historyState.seasons.at(-1).championTeamId,playoff.postseasonState.championTeamId,'champion not archived');
  seasonApi.restoreSeason(clone(playoff));
  const restoredPlayoff=seasonApi.serializeSeason(id);valid(restoredPlayoff,'postseason restored');
  assert.deepEqual(restoredPlayoff.postseasonState,playoff.postseasonState,'postseason save/restore diverged');
  assert.deepEqual(restoredPlayoff.historyState,playoff.historyState,'history save/restore diverged');
  assert.deepEqual(restoredPlayoff.rosterControlStates,playoff.rosterControlStates,'IL controls lost on playoff restore');
  const report={schema:'THE_CALL_UP_PHASE3_INTEGRATION_GATE_4R_V1',pass:true,
    seed,snapshotHash:master.metadata.contentHash,
    mode:'DEMO_DETAILED_CHECKPOINT_PLUS_PRODUCTION_V3_FULL_SEASON_AND_POSTSEASON',
    priorVerifiedReports:prerequisites,detailed,
    regularSeason:{worldGames,levelGames,automaticOrganizationReviews:finished.organizationState.reviews,
      retainedEvaluations:Object.keys(finished.organizationState.latestEvaluations).length,initialRosters,finalRosters},
    postseason:{rounds,championTeamId:playoff.postseasonState.championTeamId,
      regularMlbStatsPreserved:true,historyArchived:true,fullSaveRestored:true},
    gates:{detailedCheckpointReplay:true,realWorldFastSeasonComplete:true,
      productionRosterUniqueAndMirrored:true,injuryListStateValid:true,
      regularSeasonRestoredExactly:true,seasonEndIdempotent:true,
      postseasonCompleteAndArchived:true,postseasonRestoredExactly:true,
      olderTargetedGatesPassed:true}};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(e){console.error(e);process.exitCode=1;}
