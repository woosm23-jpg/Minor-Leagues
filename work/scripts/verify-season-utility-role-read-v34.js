import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';
import { executeAdjacentLevelSwap } from '../src/services/organizationRosterService.js';
import { createCareerEventState } from '../src/engine/career/careerEvents.js';

const seedArgs = process.argv.filter((a) => a.startsWith('--seed=')).map((a) => Number(a.slice(7)));
const seeds = seedArgs.length ? seedArgs : [1,2,3,4,5,6];
const verify = process.argv.includes('--verify');
const quiet = process.argv.includes('--quiet');
const outputArg = process.argv.find((a) => a.startsWith('--output='));
const golden = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v28-four-level-core-golden.json', import.meta.url), 'utf8'));
const goldenMap = new Map(golden.rows.map((r) => [r.seed, r.sha256]));
const v30Golden = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v30-career-moments-golden.json', import.meta.url), 'utf8'));
const v30MomentMap = new Map(v30Golden.rows.map((r) => [r.seed, r]));
const legacyLevels = ['A','AA','AAA','MLB'];
const ladderLevels = ['A','HIGH_A','AA','AAA','MLB'];

function canonical(v){ if(Array.isArray(v)) return v.map(canonical); if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map((k)=>[k,canonical(v[k])])); return v; }
function sha(v){ return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
function stripV32Additions(value){
  if(Array.isArray(value)) return value.map(stripV32Additions);
  if(value&&typeof value==='object'){
    const out={};
    for(const [key,val] of Object.entries(value)){
      if(['positioning','primaryPosition','positionFamiliarity','positionReps'].includes(key)) continue;
      out[key]=stripV32Additions(val);
    }
    return out;
  }
  return value;
}
function legacyCore(payload){
  const ids=new Set();
  for(const level of legacyLevels) for(const roster of Object.values(payload.fixture.levelLeagues[level].rosters)) for(const id of Object.keys(roster.players)) ids.add(id);
  const pick=(obj)=>Object.fromEntries([...ids].sort().filter((id)=>obj[id]).map((id)=>[id,obj[id]]));
  return stripV32Additions({
    levelSeasons:Object.fromEntries(legacyLevels.map(level=>[level,payload.levelSeasons[level]])),
    levelLeagues:Object.fromEntries(legacyLevels.map(level=>[level,payload.fixture.levelLeagues[level]])),
    organization:{userLevel:payload.fixture.organization.userLevel,levels:Object.fromEntries(legacyLevels.map(level=>[level,payload.fixture.organization.levels[level]]))},
    playerStates:pick(payload.playerStates),pitcherStates:pick(payload.pitcherStates),roleStates:pick(payload.roleStates??{})
  });
}
function setTools(player,value){
  for(const key of ['contactR','contactL','rawPower','vision','discipline']) if(key in (player.hitting??{})) player.hitting[key]=value;
  for(const key of ['fielding','reaction','armStrength','armAccuracy']) if(key in (player.fielding??{})) player.fielding[key]=value;
  for(const key of ['speed','stealing','baserunning']) if(key in (player.running??{})) player.running[key]=value;
}
function setEveryCopy(payload,id,value){
  for(const roster of Object.values(payload.fixture.rosters??{})) if(roster.players?.[id]) setTools(roster.players[id],value);
  for(const league of Object.values(payload.fixture.levelLeagues??{})) for(const roster of Object.values(league.rosters??{})) if(roster.players?.[id]) setTools(roster.players[id],value);
  for(const affiliate of Object.values(payload.fixture.organization?.levels??{})) if(affiliate.roster?.players?.[id]) setTools(affiliate.roster.players[id],value);
}
function starterAt(fixture,level,position='CF'){ return fixture.organization.levels[level].roster.lineupSlots.find((r)=>r.position===position).starterId; }
function careerSequenceValid(state,userId){ return state?.schemaVersion===1 && state.nextSequence===state.events.length+1 && state.events.every((event,index)=>event.sequence===index+1 && event.eventId===`career_event_${String(index+1).padStart(6,'0')}` && event.playerId===userId); }
function contextBaseValid(c){ return c?.basesBefore && typeof c.basesBefore.first==='boolean' && typeof c.basesBefore.second==='boolean' && typeof c.basesBefore.third==='boolean'; }
function contextScoreValid(c){ return c?.scoreBefore && Number.isInteger(c.scoreBefore.away) && Number.isInteger(c.scoreBefore.home) && c.scoreBefore.away>=0 && c.scoreBefore.home>=0; }
function momentContextValid(event){
  const c=event?.gameContext; if(!c) return false;
  if(!Number.isInteger(c.inning)||c.inning<1||!['TOP','BOTTOM'].includes(c.half)||!Number.isInteger(c.paNumber)||c.paNumber<1) return false;
  if(![0,1,2].includes(c.outsBefore)||!contextBaseValid(c)||!contextScoreValid(c)||!['away','home'].includes(c.userSide)||!c.opponentTeamName) return false;
  if(['PRO_DEBUT','MLB_DEBUT'].includes(event.type)) return c.kind==='PA';
  if(event.type==='FIRST_MLB_HIT') return c.kind==='PA'&&['1B','2B','3B','HR'].includes(c.outcome);
  if(event.type==='FIRST_MLB_HR') return c.kind==='PA'&&c.outcome==='HR';
  if(event.type==='FIRST_MLB_RBI') return c.kind==='PA'&&Number(c.rbi)>0;
  if(event.type==='FIRST_MLB_SB') return c.kind==='RUNNING'&&c.phase==='PRE_PA'&&c.runningKind==='SB';
  return true;
}

function baseline(n){
  const seed=`v29-stability-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const payload=seasonApi.serializeSeason(s.seasonId);
  const restored=seasonApi.restoreSeason(structuredClone(payload));
  return {
    seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,worldTotal:s.progress.worldLeagueGamesTotal,userLevel:s.currentLevel,userGames:s.userSeasonLine.G,restGames:s.userRole.restGames,
    txCount:s.organization.recentTransactions.length,legacyHash:sha(legacyCore(payload)),expectedLegacyHash:goldenMap.get(seed),gameVersion:payload.gameVersion,
    levelGames:Object.fromEntries(ladderLevels.map(level=>[level,s.userStatsByLevel[level].leagueGamesCompleted])),
    careerValid:careerSequenceValid(payload.careerEventState,payload.fixture.userPlayerId),
    proDebutCount:payload.careerEventState.events.filter((e)=>e.type==='PRO_DEBUT').length,
    mlbMomentCount:payload.careerEventState.events.filter((e)=>['MLB_DEBUT','FIRST_MLB_HIT','FIRST_MLB_HR','FIRST_MLB_RBI','FIRST_MLB_SB'].includes(e.type)).length,
    completedMomentKeys:[...(payload.careerEventState.completedMomentKeys??[])],
    proDebutContextValid:momentContextValid(payload.careerEventState.events.find((e)=>e.type==='PRO_DEBUT')),
    roundTrip:seasonApi.serializeSeason(restored.seasonId).levelSeasons.HIGH_A.completedGames===112,
    positionFamiliarity:{...(s.userPlayer.status?.positionFamiliarity??{})},
    positionReps:{...(s.userPlayer.status?.positionReps??{})},
    hiddenSafe:!JSON.stringify(s.userPlayer).includes('adaptability'),
    playingTime:s.userPlayer.playingTime
  };
}

function forcedLadder(n){
  const seed=`v30-ladder-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  let payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  let roles=payload.roleStates, fixture=payload.fixture;
  // Setup user at A using legal adjacent demotions only.
  for(const [fromLevel,toLevel] of [['AA','AAA'],['HIGH_A','AA'],['A','HIGH_A']]){
    const lowerStarter=starterAt(fixture,fromLevel);
    const moved=executeAdjacentLevelSwap({fixture,roleStates:roles,fromLevel,toLevel,promotePlayerId:lowerStarter,demotePlayerId:payload.fixture.userPlayerId,position:'CF',date:'2026-04-01',reasonCodes:['TEST_SETUP']});
    fixture=moved.fixture; roles=moved.roleStates;
  }
  payload.fixture=structuredClone(fixture); payload.roleStates=structuredClone(roles);
  payload.careerEventState=structuredClone(createCareerEventState({userPlayerId:payload.fixture.userPlayerId,startDate:'2026-04-01',initialLevel:'A'}));
  setEveryCopy(payload,payload.fixture.userPlayerId,99);
  for(const level of ['HIGH_A','AA','AAA','MLB']) setEveryCopy(payload,starterAt(payload.fixture,level),20);
  s=seasonApi.restoreSeason(payload);
  const visited=[s.currentLevel];
  let safety=0;
  while(s.status!=='COMPLETE' && safety<50){
    s=seasonApi.simulateCurrentGame(s.seasonId); safety++;
    if(visited.at(-1)!==s.currentLevel) visited.push(s.currentLevel);
  }
  if(s.status!=='COMPLETE') s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const saved=seasonApi.serializeSeason(s.seasonId);
  const userPromotions=(saved.organizationState?.transactions??[]).filter((e)=>e.type==='PLAYER_PROMOTED'&&e.playerId===saved.fixture.userPlayerId).map((e)=>`${e.fromLevel}->${e.toLevel}`);
  const timelinePromotions=saved.careerEventState.events.filter((e)=>e.type==='PLAYER_PROMOTED').map((e)=>`${e.fromLevel}->${e.toLevel}`);
  const nonAdjacent=(saved.organizationState?.transactions??[]).some((e)=>Math.abs(ladderLevels.indexOf(e.fromLevel)-ladderLevels.indexOf(e.toLevel))!==1);
  const momentEvents=saved.careerEventState.events.filter((e)=>e.momentKey);
  const momentTypes=momentEvents.map((e)=>e.type);
  const mlbLine=s.userStatsByLevel.MLB.userSeasonLine;
  const expectedMomentTypes=['PRO_DEBUT'];
  if(mlbLine.G>0) expectedMomentTypes.push('MLB_DEBUT');
  if(mlbLine.H>0) expectedMomentTypes.push('FIRST_MLB_HIT');
  if(mlbLine.HR>0) expectedMomentTypes.push('FIRST_MLB_HR');
  if(mlbLine.RBI>0) expectedMomentTypes.push('FIRST_MLB_RBI');
  if(mlbLine.SB>0) expectedMomentTypes.push('FIRST_MLB_SB');
  const firstMlbDate=momentEvents.find((e)=>e.type==='MLB_DEBUT')?.date??null;
  const datesValid=momentEvents.every((e)=>!e.type.startsWith('FIRST_MLB_')||!firstMlbDate||e.date>=firstMlbDate);
  const contextValid=momentEvents.every(momentContextValid);
  const contextByType=Object.fromEntries(momentEvents.map((e)=>[e.type,e.gameContext]));
  const previous=v30MomentMap.get(n);
  return {seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,finalLevel:s.currentLevel,visited,userPromotions,timelinePromotions,nonAdjacent,gameVersion:saved.gameVersion,careerValid:careerSequenceValid(saved.careerEventState,saved.fixture.userPlayerId),roundTrip:seasonApi.restoreSeason(structuredClone(saved)).currentLevel===s.currentLevel,momentTypes,expectedMomentTypes,completedMomentKeys:[...(saved.careerEventState.completedMomentKeys??[])],datesValid,contextValid,contextByType,previousMomentTypes:previous?.momentTypes??null,previousMlbLine:previous?.mlbLine??null,mlbLine};
}

function legacyBackfill(n){
  const seed=`v32-legacy-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  for(let i=0;i<6;i++) s=seasonApi.simulateCurrentGame(s.seasonId);
  const payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  const before=Object.fromEntries(legacyLevels.map(level=>[level,structuredClone(payload.levelSeasons[level])]));
  delete payload.levelSeasons.HIGH_A; delete payload.fixture.levelLeagues.HIGH_A; delete payload.fixture.organization.levels.HIGH_A;
  payload.fixture.organization.levelOrder=['MLB','AAA','AA','A']; payload.gameVersion='phase3_career_timeline_v28';
  const legacyEvents=(payload.careerEventState?.events??[]).filter((e)=>!e.momentKey && !['PRO_DEBUT','MLB_DEBUT','FIRST_MLB_HIT','FIRST_MLB_HR','FIRST_MLB_RBI','FIRST_MLB_SB'].includes(e.type)).map((e,index)=>({...e,sequence:index+1,eventId:`career_event_${String(index+1).padStart(6,'0')}`}));
  payload.careerEventState={schemaVersion:1,nextSequence:legacyEvents.length+1,events:legacyEvents};
  const restored=seasonApi.restoreSeason(payload); const upgraded=seasonApi.serializeSeason(restored.seasonId);
  const noBackfilledMoments=!(upgraded.careerEventState?.events??[]).some((e)=>['PRO_DEBUT','MLB_DEBUT','FIRST_MLB_HIT','FIRST_MLB_HR','FIRST_MLB_RBI','FIRST_MLB_SB'].includes(e.type));
  const inferredPro=(upgraded.careerEventState?.completedMomentKeys??[]).includes('PRO_DEBUT');
  return {seed,highAGames:upgraded.levelSeasons.HIGH_A.completedGames,preserved:legacyLevels.every(level=>JSON.stringify(upgraded.levelSeasons[level])===JSON.stringify(before[level])),gameVersion:upgraded.gameVersion,levels:Object.keys(upgraded.levelSeasons).sort(),noBackfilledMoments,inferredPro};
}

function forcedUtility(n){
  const seed=`v34-utility-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  const payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  const userId=payload.fixture.userPlayerId;
  const teamId=payload.fixture.levelLeagues.AAA.userTeamId;
  const mutateRoster=(roster)=>{
    if(!roster) return;
    const bo=roster.bench.find((row)=>row.playerId.endsWith('_bo'))?.playerId;
    const bi=roster.bench.find((row)=>row.playerId.endsWith('_bi'))?.playerId;
    roster.bench=roster.bench.filter((row)=>row.playerId!==bo);
    for(const row of roster.bench){
      row.coverage=row.playerId===bi?['CF']:row.coverage.filter((position)=>position!=='LF');
    }
  };
  mutateRoster(payload.fixture.levelLeagues.AAA.rosters[teamId]);
  mutateRoster(payload.fixture.organization.levels.AAA.roster);
  mutateRoster(payload.fixture.rosters[payload.fixture.userTeamId]);
  const lfId=payload.fixture.organization.levels.AAA.roster.lineupSlots.find((row)=>row.position==='LF').starterId;
  payload.playerStates[lfId]={...payload.playerStates[lfId],fatigue:48};
  payload.playerStates[userId]={...payload.playerStates[userId],fatigue:0};
  payload.roleStates[userId]={...payload.roleStates[userId],role:'UTILITY'};
  s=seasonApi.restoreSeason(payload);
  s=seasonApi.simulateCurrentGame(s.seasonId);
  const detail=seasonApi.getPlayerDetail(s.seasonId,userId);
  const saved=seasonApi.serializeSeason(s.seasonId);
  const restored=seasonApi.restoreSeason(structuredClone(saved));
  const restoredDetail=seasonApi.getPlayerDetail(restored.seasonId,userId);
  const lfRow=detail.utilityPathway?.positions?.find((row)=>row.position==='LF')??null;
  return {
    seed,level:s.currentLevel,userGames:s.userSeasonLine.G,lfReps:detail.status?.positionReps?.LF??0,lfFamiliarity:detail.status?.positionFamiliarity?.LF??0,
    utilityStatus:lfRow?.status??null,role:detail.roleState?.role??null,gameVersion:saved.gameVersion,
    roundTripLfReps:restoredDetail.status?.positionReps?.LF??0,hiddenSafe:!JSON.stringify(detail).includes('adaptability'),
    playingTime:detail.playingTime,roundTripPlayingTime:restoredDetail.playingTime
  };
}

const rows=[];
for(const n of seeds){
  const b=baseline(n), f=forcedLadder(n), l=legacyBackfill(n), u=forcedUtility(n); rows.push({n,baseline:b,forced:f,legacy:l,utility:u});
  if(verify){
    assert.equal(b.status,'COMPLETE',`seed ${n}: baseline status`); assert.equal(b.worldGames,560,`seed ${n}: world games`); assert.equal(b.worldTotal,560,`seed ${n}: world total`);
    assert.equal(b.userLevel,'AAA',`seed ${n}: user level`); assert.equal(b.userGames,27,`seed ${n}: user games`); assert.equal(b.restGames,1,`seed ${n}: rest`); assert.equal(b.txCount,0,`seed ${n}: unexpected tx`);
    assert.equal(b.legacyHash,b.expectedLegacyHash,`seed ${n}: v28 A/AA/AAA/MLB core changed`); assert.equal(b.gameVersion,'phase3_position_assignment_v36',`seed ${n}: version`); assert.ok(b.careerValid&&b.roundTrip,`seed ${n}: persistence`);
    assert.equal(b.positionFamiliarity.CF,1,`seed ${n}: primary familiarity`); assert.equal(b.positionFamiliarity.LF,0.72,`seed ${n}: LF secondary`); assert.equal(b.positionFamiliarity.RF,0.72,`seed ${n}: RF secondary`); assert.equal(b.positionReps.CF,b.userGames,`seed ${n}: CF reps`); assert.equal(b.positionReps.LF??0,0,`seed ${n}: unexpected LF reps`); assert.equal(b.hiddenSafe,true,`seed ${n}: adaptability leaked`);
    assert.equal(b.proDebutCount,1,`seed ${n}: pro debut careerOnce`); assert.equal(b.proDebutContextValid,true,`seed ${n}: pro debut context missing/invalid`); assert.equal(b.mlbMomentCount,0,`seed ${n}: baseline false MLB moment`); assert.deepEqual(b.completedMomentKeys,['PRO_DEBUT'],`seed ${n}: baseline moment completion`);
    for(const level of ladderLevels) assert.equal(b.levelGames[level],112,`seed ${n}: ${level} completion`);
    const expected=['A->HIGH_A','HIGH_A->AA','AA->AAA','AAA->MLB'];
    assert.equal(f.status,'COMPLETE',`seed ${n}: ladder status`); assert.equal(f.worldGames,560,`seed ${n}: ladder world games`); assert.equal(f.finalLevel,'MLB',`seed ${n}: ladder final`); assert.equal(f.nonAdjacent,false,`seed ${n}: non-adjacent`);
    assert.deepEqual(f.userPromotions,expected,`seed ${n}: org ladder`); assert.deepEqual(f.timelinePromotions,expected,`seed ${n}: timeline ladder`); assert.ok(f.careerValid&&f.roundTrip,`seed ${n}: ladder persistence`);
    assert.deepEqual(f.momentTypes,f.expectedMomentTypes,`seed ${n}: official firsts mismatch`); assert.deepEqual(f.momentTypes,f.previousMomentTypes,`seed ${n}: v30 career moment types changed`); assert.deepEqual(f.mlbLine,f.previousMlbLine,`seed ${n}: v30 MLB line changed`); assert.equal(f.contextValid,true,`seed ${n}: authoritative moment context invalid`); assert.deepEqual(f.completedMomentKeys,f.expectedMomentTypes,`seed ${n}: moment key mismatch`); assert.equal(f.datesValid,true,`seed ${n}: MLB first date precedes debut`);
    assert.ok(l.highAGames>0,`seed ${n}: High-A backfill`); assert.equal(l.preserved,true,`seed ${n}: legacy level state changed`); assert.equal(l.gameVersion,'phase3_position_assignment_v36',`seed ${n}: legacy version`); assert.deepEqual(l.levels,['A','AA','AAA','HIGH_A','MLB'],`seed ${n}: legacy levels`); assert.equal(l.noBackfilledMoments,true,`seed ${n}: legacy exact-date moments invented`); assert.equal(l.inferredPro,true,`seed ${n}: legacy completed pro debut not inferred`);
    assert.equal(u.level,'AAA',`seed ${n}: utility level`); assert.equal(u.userGames,1,`seed ${n}: utility game not played`); assert.equal(u.lfReps,1,`seed ${n}: utility LF rep missing`); assert.ok(u.lfFamiliarity>0.72,`seed ${n}: utility familiarity did not grow`); assert.equal(u.utilityStatus,'READY',`seed ${n}: utility pathway not ready`); assert.equal(u.role,'UTILITY',`seed ${n}: utility role changed unexpectedly`); assert.equal(u.gameVersion,'phase3_position_assignment_v36',`seed ${n}: utility version`); assert.equal(u.roundTripLfReps,1,`seed ${n}: utility rep lost on save/load`); assert.equal(u.hiddenSafe,true,`seed ${n}: utility hidden state leaked`);
  }
}
const report={version:'v34',sourceGolden:golden.sourceVersion,careerMomentGolden:v30Golden.sourceVersion,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice(9); if(output) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(!quiet) console.log(JSON.stringify(report,null,2));
