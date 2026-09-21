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
    roundTrip:seasonApi.serializeSeason(restored.seasonId).levelSeasons.HIGH_A.completedGames===112
  };
}

function forcedLadder(n){
  const seed=`v29-ladder-${n}`;
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
  return {seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,finalLevel:s.currentLevel,visited,userPromotions,timelinePromotions,nonAdjacent,gameVersion:saved.gameVersion,careerValid:careerSequenceValid(saved.careerEventState,saved.fixture.userPlayerId),roundTrip:seasonApi.restoreSeason(structuredClone(saved)).currentLevel===s.currentLevel};
}

function legacyBackfill(n){
  const seed=`v29-legacy-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  for(let i=0;i<6;i++) s=seasonApi.simulateCurrentGame(s.seasonId);
  const payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  const before=Object.fromEntries(legacyLevels.map(level=>[level,structuredClone(payload.levelSeasons[level])]));
  delete payload.levelSeasons.HIGH_A; delete payload.fixture.levelLeagues.HIGH_A; delete payload.fixture.organization.levels.HIGH_A;
  payload.fixture.organization.levelOrder=['MLB','AAA','AA','A']; payload.gameVersion='phase3_career_timeline_v28';
  const restored=seasonApi.restoreSeason(payload); const upgraded=seasonApi.serializeSeason(restored.seasonId);
  return {seed,highAGames:upgraded.levelSeasons.HIGH_A.completedGames,preserved:legacyLevels.every(level=>JSON.stringify(upgraded.levelSeasons[level])===JSON.stringify(before[level])),gameVersion:upgraded.gameVersion,levels:Object.keys(upgraded.levelSeasons).sort()};
}

const rows=[];
for(const n of seeds){
  const b=baseline(n), f=forcedLadder(n), l=legacyBackfill(n); rows.push({n,baseline:b,forced:f,legacy:l});
  if(verify){
    assert.equal(b.status,'COMPLETE',`seed ${n}: baseline status`); assert.equal(b.worldGames,560,`seed ${n}: world games`); assert.equal(b.worldTotal,560,`seed ${n}: world total`);
    assert.equal(b.userLevel,'AAA',`seed ${n}: user level`); assert.equal(b.userGames,27,`seed ${n}: user games`); assert.equal(b.restGames,1,`seed ${n}: rest`); assert.equal(b.txCount,0,`seed ${n}: unexpected tx`);
    assert.equal(b.legacyHash,b.expectedLegacyHash,`seed ${n}: v28 A/AA/AAA/MLB core changed`); assert.equal(b.gameVersion,'phase3_position_assignment_v36',`seed ${n}: version`); assert.ok(b.careerValid&&b.roundTrip,`seed ${n}: persistence`);
    for(const level of ladderLevels) assert.equal(b.levelGames[level],112,`seed ${n}: ${level} completion`);
    const expected=['A->HIGH_A','HIGH_A->AA','AA->AAA','AAA->MLB'];
    assert.equal(f.status,'COMPLETE',`seed ${n}: ladder status`); assert.equal(f.worldGames,560,`seed ${n}: ladder world games`); assert.equal(f.finalLevel,'MLB',`seed ${n}: ladder final`); assert.equal(f.nonAdjacent,false,`seed ${n}: non-adjacent`);
    assert.deepEqual(f.userPromotions,expected,`seed ${n}: org ladder`); assert.deepEqual(f.timelinePromotions,expected,`seed ${n}: timeline ladder`); assert.ok(f.careerValid&&f.roundTrip,`seed ${n}: ladder persistence`);
    assert.ok(l.highAGames>0,`seed ${n}: High-A backfill`); assert.equal(l.preserved,true,`seed ${n}: legacy level state changed`); assert.equal(l.gameVersion,'phase3_position_assignment_v36',`seed ${n}: legacy version`); assert.deepEqual(l.levels,['A','AA','AAA','HIGH_A','MLB'],`seed ${n}: legacy levels`);
  }
}
const report={version:'v29',sourceGolden:golden.sourceVersion,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice(9); if(output) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(!quiet) console.log(JSON.stringify(report,null,2));
