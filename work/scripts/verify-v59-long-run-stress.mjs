import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { seasonApi } from '../src/api/seasonApi.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const LEVELS=['MLB','AAA','AA','HIGH_A','A'];
const START_YEAR=2026;
const COMPLETED_SEASONS=20; // 2026-2045, then roll to 2046 Opening Day.
const END_YEAR=START_YEAR+COMPLETED_SEASONS-1;
const master=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz')).toString('utf8'));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
assert.equal(catalog.organizations.length,30,'production organization count');
const input={name:'v59 Long Run QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(catalog.organizations[0].id)};
let snap=seasonApi.createCareerSeason({seed:'v59-long-run-stress-20y',input,masterSnapshot:master});
const seasonId=snap.seasonId;
let payload=seasonApi.serializeSeason(seasonId);
validateSeasonSavePayload(payload,{mode:'FULL'});

function leagueRows(fixture){
  const rows=[];
  for(const level of LEVELS){
    const league=fixture.levelLeagues?.[level];
    assert.ok(league,`missing level ${level}`);
    const teamRows=Array.isArray(league.teams)?league.teams:Object.values(league.teams ?? {});
    const teamIds=new Set(teamRows.map(t=>String(t.id)));
    for(const [teamId,roster] of Object.entries(league.rosters ?? {})){
      if(teamIds.size) assert.ok(teamIds.has(String(teamId)),`${level}: roster team missing from league teams ${teamId}`);
      for(const [id,player] of Object.entries(roster.players ?? {})){
        if(player?.id!=null) assert.equal(String(player.id),String(id),`${level}:${teamId}: roster key/player id mismatch`);
        rows.push({id:String(id),level,teamId:String(teamId),player});
      }
    }
  }
  return rows;
}
function levelCounts(fixture){
  const rows=leagueRows(fixture);
  return Object.fromEntries(LEVELS.map(level=>[level,rows.filter(r=>r.level===level).length]));
}
function scheduleCounts(levelSeasons){
  return Object.fromEntries(LEVELS.map(level=>[level,(levelSeasons?.[level]?.schedule ?? []).length]));
}
function sumMap(map,keys){
  const out=Object.fromEntries(keys.map(k=>[k,0]));
  for(const line of Object.values(map ?? {})) for(const k of keys) out[k]+=Number(line?.[k] ?? 0);
  return out;
}
function mlbRates(levelSeasons){
  const s=levelSeasons.MLB;
  assert.ok(s,'MLB season state missing');
  assert.equal(s.completedGames,s.schedule.length,'MLB incomplete');
  const b=sumMap(s.playerBatting,['PA','AB','H','BB','HBP','SF','TB','HR','SO']);
  const p=sumMap(s.playerPitching,['BF','outsRecorded','H','BB','HBP','HR','SO','R']);
  const div=(a,b)=>b>0?a/b:0;
  const rates={
    AVG:div(b.H,b.AB),
    OBP:div(b.H+b.BB+b.HBP,b.AB+b.BB+b.HBP+b.SF),
    SLG:div(b.TB,b.AB),
    HRperPA:div(b.HR,b.PA),
    KperPA:div(b.SO,b.PA),
    BBperPA:div(b.BB,b.PA),
    RA9:p.outsRecorded>0?p.R*27/p.outsRecorded:0,
    FIPLike:p.outsRecorded>0?((13*p.HR+3*(p.BB+p.HBP)-2*p.SO)/(p.outsRecorded/3)+3.10):0
  };
  assert.ok(rates.AVG>0.150&&rates.AVG<0.350,`MLB AVG out of sanity range ${rates.AVG}`);
  assert.ok(rates.OBP>0.220&&rates.OBP<0.450,`MLB OBP out of sanity range ${rates.OBP}`);
  assert.ok(rates.SLG>0.250&&rates.SLG<0.650,`MLB SLG out of sanity range ${rates.SLG}`);
  assert.ok(rates.KperPA>0.05&&rates.KperPA<0.42,`MLB K/PA out of sanity range ${rates.KperPA}`);
  assert.ok(rates.BBperPA>0.02&&rates.BBperPA<0.22,`MLB BB/PA out of sanity range ${rates.BBperPA}`);
  assert.ok(rates.RA9>1.5&&rates.RA9<9.0,`MLB RA9 out of sanity range ${rates.RA9}`);
  return {rates,battingTotals:b,pitchingTotals:p,games:s.schedule.length};
}
function ageSummary(payload,rows){
  const ages=[];
  for(const row of rows){
    const st=payload.playerStates?.[row.id] ?? payload.pitcherStates?.[row.id];
    const age=Number(st?.health?.age ?? row.player?.physical?.age ?? NaN);
    if(Number.isFinite(age)) ages.push(age);
  }
  ages.sort((a,b)=>a-b);
  assert.ok(ages.length>3000,'too few player ages');
  assert.ok(ages[0]>=15 && ages.at(-1)<=55,`age bounds ${ages[0]}-${ages.at(-1)}`);
  const mean=ages.reduce((a,b)=>a+b,0)/ages.length;
  return {count:ages.length,min:ages[0],max:ages.at(-1),mean:Number(mean.toFixed(3)),median:ages[Math.floor(ages.length/2)]};
}
function retirementArchive(payload){
  const s=payload.retirementHallState ?? {};
  if(s.retiredPlayers && typeof s.retiredPlayers==='object' && !Array.isArray(s.retiredPlayers)) return Object.values(s.retiredPlayers);
  if(Array.isArray(s.retiredPlayers)) return s.retiredPlayers;
  if(Array.isArray(s.archive)) return s.archive;
  if(Array.isArray(s.retiredArchive)) return s.retiredArchive;
  return [];
}
function hofInductees(payload){return payload.retirementHallState?.hall?.inductees ?? [];}
function hofBallots(payload){return payload.retirementHallState?.hall?.ballots ?? [];}
function fingerprint(payload){
  const rows=leagueRows(payload.fixture);
  const obj={
    year:String(payload.fixture.startDate).slice(0,4),
    active:rows.map(r=>r.id).sort(),
    counts:levelCounts(payload.fixture),
    ecology:{year:payload.leagueEcologyState?.year,totalRetired:payload.leagueEcologyState?.totalRetired,totalGenerated:payload.leagueEcologyState?.totalGenerated},
    history:(payload.historyState?.seasons ?? []).map(r=>r.seasonYear),
    retired:retirementArchive(payload).map(r=>String(r.playerId ?? r.id)).sort(),
    inductees:hofInductees(payload).map(r=>String(r.playerId)).sort(),
    ballots:hofBallots(payload).map(r=>Number(r.electionYear)),
    amateur:{year:payload.amateurAcquisitionState?.currentYear,reserve:(payload.amateurAcquisitionState?.reserve ?? []).map(r=>String(r.player?.id)).sort(),drafted:payload.amateurAcquisitionState?.totalDrafted,international:payload.amateurAcquisitionState?.totalInternationalSigned,activated:payload.amateurAcquisitionState?.totalActivated}
  };
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}
function validateWorld(payload,{initialPopulation,initialLevelCounts,initialSchedules}){
  validateSeasonSavePayload(payload,{mode:'FULL'});
  const rows=leagueRows(payload.fixture),ids=rows.map(r=>r.id),set=new Set(ids);
  assert.equal(ids.length,initialPopulation,'active population drift');
  assert.equal(set.size,ids.length,'duplicate active player IDs');
  assert.deepEqual(levelCounts(payload.fixture),initialLevelCounts,'level population drift');
  assert.deepEqual(scheduleCounts(payload.levelSeasons),initialSchedules,'future schedule size drift');
  const retired=retirementArchive(payload).map(r=>String(r.playerId ?? r.id));
  for(const id of retired) assert.ok(!set.has(id),`retired player still active ${id}`);
  assert.equal(new Set(retired).size,retired.length,'duplicate retirement archive player');
  const inductees=hofInductees(payload).map(r=>String(r.playerId));
  assert.equal(new Set(inductees).size,inductees.length,'duplicate HOF inductee');
  const reserve=(payload.amateurAcquisitionState?.reserve ?? []).map(r=>String(r.player?.id));
  assert.equal(new Set(reserve).size,reserve.length,'duplicate amateur reserve player');
  for(const id of reserve) assert.ok(!set.has(id),`amateur reserve leaked into active roster without consumption ${id}`);
  assert.equal(payload.leagueEcologyState?.totalRetired,payload.leagueEcologyState?.totalGenerated,'retirement/replacement cumulative mismatch');
  return {rows,retiredCount:retired.length,inducteeCount:inductees.length,ballotCount:hofBallots(payload).length,reserveCount:reserve.length};
}
function mean(arr,key){return arr.reduce((s,x)=>s+Number(x.rates[key]),0)/arr.length;}

const initialRows=leagueRows(payload.fixture);
const initialPopulation=initialRows.length;
const initialLevelCounts=levelCounts(payload.fixture);
const initialSchedules=scheduleCounts(payload.levelSeasons);
const initialScheduleTotal=Object.values(initialSchedules).reduce((a,b)=>a+b,0);
assert.equal(initialScheduleTotal,10710,'production schedule baseline total changed');
const initialSaveBytes=Buffer.byteLength(JSON.stringify(payload));
const checkpoints=[];
const fullRunStart=performance.now();

for(let i=0;i<COMPLETED_SEASONS;i++){
  const year=START_YEAR+i;
  snap=seasonApi.getSeason(seasonId);
  assert.equal(snap.seasonYear,year,`unexpected season year at loop ${i}`);
  assert.equal(snap.status,'REGULAR_SEASON',`${year}: expected regular season`);

  const t0=performance.now();
  snap=seasonApi.simulateToSeasonEnd(seasonId);
  const simulateMs=performance.now()-t0;
  assert.equal(snap.status,'COMPLETE',`${year}: regular season did not complete`);
  const completedPayload=seasonApi.serializeSeason(seasonId);
  const mlb=mlbRates(completedPayload.levelSeasons);
  for(const level of LEVELS){
    const s=completedPayload.levelSeasons[level];
    assert.equal(s.completedGames,s.schedule.length,`${year}:${level} incomplete schedule`);
  }

  snap=seasonApi.startPostseason(seasonId);
  let guard=0;
  while(snap.postseason?.status!=='COMPLETE' && guard<10){snap=seasonApi.advancePostseasonRound(seasonId);guard++;}
  assert.equal(snap.postseason?.status,'COMPLETE',`${year}: postseason did not complete`);
  assert.ok(snap.postseason?.championTeamId,`${year}: missing champion`);

  snap=seasonApi.startOffseason(seasonId);
  guard=0;
  while(snap.offseason?.status==='ACTIVE' && guard<20){snap=seasonApi.advanceOffseasonPhase(seasonId);guard++;}
  assert.equal(snap.offseason?.status,'COMPLETE',`${year}: offseason did not complete`);

  assert.equal(snap.seasonYear,year+1,`${year}: rollover failed`);
  assert.equal(snap.status,'REGULAR_SEASON',`${year}: next season not regular season`);
  payload=seasonApi.serializeSeason(seasonId);
  const world=validateWorld(payload,{initialPopulation,initialLevelCounts,initialSchedules});
  assert.equal(payload.historyState?.seasons?.length,i+1,`${year}: annual history growth mismatch`);

  if((i+1)%5===0){
    const fp1=fingerprint(payload);
    seasonApi.restoreSeason(structuredClone(payload));
    const p2=seasonApi.serializeSeason(seasonId); validateSeasonSavePayload(p2,{mode:'FULL'}); const fp2=fingerprint(p2);
    seasonApi.restoreSeason(structuredClone(p2));
    const p3=seasonApi.serializeSeason(seasonId); validateSeasonSavePayload(p3,{mode:'FULL'}); const fp3=fingerprint(p3);
    assert.equal(fp2,fp1,`${year}: first restore logical drift`);
    assert.equal(fp3,fp2,`${year}: repeated restore logical drift`);
    payload=p3; snap=seasonApi.getSeason(seasonId);
  }

  const rows=leagueRows(payload.fixture);
  const generated=rows.filter(r=>r.player?.generated===true);
  const age=ageSummary(payload,rows);
  const saveBytes=Buffer.byteLength(JSON.stringify(payload));
  assert.equal(typeof global.gc,'function','v59 stress requires --expose-gc for leak-safe heap measurement');
  global.gc();
  global.gc();
  const memory=process.memoryUsage();
  const heapMb=memory.heapUsed/1024/1024;
  const rssMb=memory.rss/1024/1024;
  const classStrength=Number(payload.leagueEcologyState?.classStrength ?? NaN);
  assert.ok(Number.isFinite(classStrength),'invalid ecology class strength');
  assert.ok(simulateMs<600000,`${year}: season simulation exceeded 10 minutes`);
  assert.ok(heapMb<2048,`${year}: post-GC heap exceeds 2GB (${heapMb.toFixed(1)} MB, RSS ${rssMb.toFixed(1)} MB)`);
  checkpoints.push({
    completedYear:year,nextYear:year+1,simulateMs:Number(simulateMs.toFixed(1)),saveBytes,heapMb:Number(heapMb.toFixed(1)),rssMb:Number(rssMb.toFixed(1)),
    activePopulation:rows.length,generatedActive:generated.length,generatedShare:Number((generated.length/rows.length).toFixed(4)),age,
    totalRetired:payload.leagueEcologyState?.totalRetired,totalGenerated:payload.leagueEcologyState?.totalGenerated,lastOffseason:payload.leagueEcologyState?.lastOffseason,
    classStrength,historySeasons:payload.historyState?.seasons?.length ?? 0,retirementArchive:world.retiredCount,hofBallots:world.ballotCount,hofInductees:world.inducteeCount,
    amateurReserve:world.reserveCount,amateurTotals:{drafted:payload.amateurAcquisitionState?.totalDrafted ?? 0,internationalSigned:payload.amateurAcquisitionState?.totalInternationalSigned ?? 0,activated:payload.amateurAcquisitionState?.totalActivated ?? 0,undraftedFallback:payload.amateurAcquisitionState?.totalUndraftedFallback ?? 0},
    mlb
  });
  console.log(`v59 ${year} PASS ${simulateMs.toFixed(0)}ms generated=${generated.length} retired=${payload.leagueEcologyState?.totalRetired} saveMB=${(saveBytes/1024/1024).toFixed(1)}`);
}

const totalMs=performance.now()-fullRunStart;
const first3=checkpoints.slice(0,3).map(x=>x.mlb), last3=checkpoints.slice(-3).map(x=>x.mlb);
const drift={};
for(const key of ['AVG','OBP','SLG','KperPA','BBperPA','RA9']) drift[key]=Number((mean(last3,key)-mean(first3,key)).toFixed(5));
assert.ok(Math.abs(drift.AVG)<0.08,`AVG drift ${drift.AVG}`);
assert.ok(Math.abs(drift.OBP)<0.10,`OBP drift ${drift.OBP}`);
assert.ok(Math.abs(drift.SLG)<0.15,`SLG drift ${drift.SLG}`);
assert.ok(Math.abs(drift.KperPA)<0.12,`K rate drift ${drift.KperPA}`);
assert.ok(Math.abs(drift.BBperPA)<0.08,`BB rate drift ${drift.BBperPA}`);
assert.ok(Math.abs(drift.RA9)<2.0,`RA9 drift ${drift.RA9}`);

const final=checkpoints.at(-1);
assert.ok(final.generatedActive>0,'generated player share never developed');
assert.ok(final.totalRetired>0,'no AI retirements across 20 seasons');
assert.ok(final.retirementArchive>0,'retirement archive did not grow');
assert.equal(final.historySeasons,COMPLETED_SEASONS,'history did not retain all completed seasons');
assert.ok(final.amateurTotals.drafted>0 && final.amateurTotals.internationalSigned>0,'amateur pipelines did not operate');
assert.ok(final.amateurTotals.activated>0,'amateur reserve never activated');
assert.ok(final.saveBytes<initialSaveBytes*4,`save payload grew over 4x: ${initialSaveBytes} -> ${final.saveBytes}`);
assert.ok(totalMs<14400000,`20-season stress exceeded 4 hours: ${totalMs}`);

const report={
  schema:'THE_CALL_UP_V59_LONG_RUN_STRESS_V1',pass:true,seed:'v59-long-run-stress-20y',startYear:START_YEAR,lastCompletedYear:END_YEAR,openingDayYear:END_YEAR+1,
  completedSeasons:COMPLETED_SEASONS,simulatedWorldGames:initialScheduleTotal*COMPLETED_SEASONS,initialPopulation,initialLevelCounts,initialSchedules,
  initialSaveBytes,finalSaveBytes:final.saveBytes,saveGrowthRatio:Number((final.saveBytes/initialSaveBytes).toFixed(3)),totalRuntimeMs:Number(totalMs.toFixed(1)),
  statDriftFirst3VsLast3:drift,
  invariants:{populationStable:true,levelPopulationStable:true,noDuplicateActiveIds:true,noRetiredActiveLeak:true,noDuplicateHofInductees:true,noAmateurReserveLeak:true,retirementReplacementBalanced:true,annualHistoryGrowth:true,repeatedSaveRestoreStable:true,futureScheduleStable:true,postseasonCycle:true,offseasonCycle:true,draftInternationalActive:true},
  final:{generatedActive:final.generatedActive,generatedShare:final.generatedShare,totalRetired:final.totalRetired,totalGenerated:final.totalGenerated,retirementArchive:final.retirementArchive,hofBallots:final.hofBallots,hofInductees:final.hofInductees,historySeasons:final.historySeasons,amateurReserve:final.amateurReserve,amateurTotals:final.amateurTotals,age:final.age,classStrength:final.classStrength},
  checkpoints,
  next:'v60 Complete Edition RC'
};
fs.mkdirSync('reports',{recursive:true});
fs.writeFileSync('reports/v59-long-run-stress.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
