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
const golden = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v26-upper-core-golden.json', import.meta.url), 'utf8'));
const goldenMap = new Map(golden.rows.map((r) => [r.seed, r.sha256]));

function canonical(v){ if(Array.isArray(v)) return v.map(canonical); if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map((k)=>[k,canonical(v[k])])); return v; }
function sha(v){ return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
function upperCore(payload){
  const ids=new Set();
  for(const level of ['AAA','MLB']) for(const roster of Object.values(payload.fixture.levelLeagues[level].rosters)) for(const id of Object.keys(roster.players)) ids.add(id);
  const pick=(obj)=>Object.fromEntries([...ids].sort().filter((id)=>obj[id]).map((id)=>[id,obj[id]]));
  return {levelSeasons:{AAA:payload.levelSeasons.AAA,MLB:payload.levelSeasons.MLB},levelLeagues:{AAA:payload.fixture.levelLeagues.AAA,MLB:payload.fixture.levelLeagues.MLB},organization:{userLevel:payload.fixture.organization.userLevel,AAA:payload.fixture.organization.levels.AAA,MLB:payload.fixture.organization.levels.MLB},playerStates:pick(payload.playerStates),pitcherStates:pick(payload.pitcherStates),roleStates:pick(payload.roleStates??{})};
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
function careerSequenceValid(state,userId){
  return state?.schemaVersion===1 && state.nextSequence===state.events.length+1 && state.events.every((event,index)=>event.sequence===index+1 && event.eventId===`career_event_${String(index+1).padStart(6,'0')}` && event.playerId===userId);
}

function baseline(n){
  const seed=`v26-stability-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const payload=seasonApi.serializeSeason(s.seasonId);
  const restored=seasonApi.restoreSeason(structuredClone(payload));
  return {
    seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,userLevel:s.currentLevel,userGames:s.userSeasonLine.G,restGames:s.userRole.restGames,
    txCount:s.organization.recentTransactions.length,upperHash:sha(upperCore(payload)),expectedUpperHash:goldenMap.get(seed),gameVersion:payload.gameVersion,
    careerEvents:payload.careerEventState.events.length,careerValid:careerSequenceValid(payload.careerEventState,payload.fixture.userPlayerId),
    startsCorrectly:payload.careerEventState.events[0]?.type==='CAREER_STARTED'&&payload.careerEventState.events[1]?.type==='LEVEL_ASSIGNED',
    roundTrip:JSON.stringify(seasonApi.serializeSeason(restored.seasonId).careerEventState)===JSON.stringify(payload.careerEventState)
  };
}

function forcedLadder(n){
  const seed=`v28-timeline-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  let payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  let roles=payload.roleStates;
  let fixture=payload.fixture;
  let aaCf=starterAt(fixture,'AA');
  let moved=executeAdjacentLevelSwap({fixture,roleStates:roles,fromLevel:'AA',toLevel:'AAA',promotePlayerId:aaCf,demotePlayerId:payload.fixture.userPlayerId,position:'CF',date:'2026-04-01',reasonCodes:['TEST_SETUP']});
  fixture=moved.fixture; roles=moved.roleStates;
  let aCf=starterAt(fixture,'A');
  moved=executeAdjacentLevelSwap({fixture,roleStates:roles,fromLevel:'A',toLevel:'AA',promotePlayerId:aCf,demotePlayerId:payload.fixture.userPlayerId,position:'CF',date:'2026-04-01',reasonCodes:['TEST_SETUP']});
  fixture=moved.fixture; roles=moved.roleStates;
  payload.fixture=structuredClone(fixture); payload.roleStates=structuredClone(roles);
  payload.careerEventState=structuredClone(createCareerEventState({userPlayerId:payload.fixture.userPlayerId,startDate:'2026-04-01',initialLevel:'A'}));
  setEveryCopy(payload,payload.fixture.userPlayerId,99);
  for(const level of ['AA','AAA','MLB']) setEveryCopy(payload,starterAt(payload.fixture,level),20);
  s=seasonApi.restoreSeason(payload);
  let safety=0;
  while(s.status!=='COMPLETE' && safety<40){ s=seasonApi.simulateCurrentGame(s.seasonId); safety++; }
  if(s.status!=='COMPLETE') s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const saved=seasonApi.serializeSeason(s.seasonId);
  const userPromotions=(saved.organizationState?.transactions??[]).filter((e)=>e.type==='PLAYER_PROMOTED'&&e.playerId===saved.fixture.userPlayerId).map((e)=>`${e.fromLevel}->${e.toLevel}`);
  const timelinePromotions=saved.careerEventState.events.filter((e)=>e.type==='PLAYER_PROMOTED').map((e)=>`${e.fromLevel}->${e.toLevel}`);
  const nonAdjacent=(saved.organizationState?.transactions??[]).some((e)=>{ const order=['A','AA','AAA','MLB']; return Math.abs(order.indexOf(e.fromLevel)-order.indexOf(e.toLevel))!==1; });
  const legacy=structuredClone(saved); delete legacy.careerEventState; legacy.gameVersion='phase3_full_ladder_v27';
  const legacyRestored=seasonApi.restoreSeason(legacy);
  const legacyCareer=seasonApi.serializeSeason(legacyRestored.seasonId).careerEventState;
  return {
    seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,finalLevel:s.currentLevel,userPromotions,timelinePromotions,nonAdjacent,
    careerValid:careerSequenceValid(saved.careerEventState,saved.fixture.userPlayerId),gameVersion:saved.gameVersion,
    roundTrip:JSON.stringify(seasonApi.serializeSeason(seasonApi.restoreSeason(structuredClone(saved)).seasonId).careerEventState)===JSON.stringify(saved.careerEventState),
    legacyPromotions:legacyCareer.events.filter((e)=>e.type==='PLAYER_PROMOTED').map((e)=>`${e.fromLevel}->${e.toLevel}`),
    legacyInventedRole:legacyCareer.events.some((e)=>e.type==='ROLE_CHANGED')
  };
}

const rows=[];
for(const n of seeds){
  const b=baseline(n), f=forcedLadder(n); rows.push({n,baseline:b,forced:f});
  if(verify){
    assert.equal(b.status,'COMPLETE',`seed ${n}: baseline status`); assert.equal(b.worldGames,448,`seed ${n}: baseline world games`);
    assert.equal(b.userLevel,'AAA',`seed ${n}: baseline user level`); assert.equal(b.userGames,27,`seed ${n}: baseline user games`); assert.equal(b.restGames,1,`seed ${n}: baseline rest`);
    assert.equal(b.txCount,0,`seed ${n}: baseline tx`); assert.equal(b.upperHash,b.expectedUpperHash,`seed ${n}: upper core changed`);
    assert.equal(b.gameVersion,'phase3_career_timeline_v28',`seed ${n}: version`); assert.ok(b.careerValid&&b.startsCorrectly&&b.roundTrip,`seed ${n}: baseline career event persistence`);
    const expected=['A->AA','AA->AAA','AAA->MLB'];
    assert.equal(f.status,'COMPLETE',`seed ${n}: ladder status`); assert.equal(f.worldGames,448,`seed ${n}: ladder world games`); assert.equal(f.finalLevel,'MLB',`seed ${n}: ladder final level`);
    assert.equal(f.nonAdjacent,false,`seed ${n}: non adjacent`); assert.deepEqual(f.userPromotions,expected,`seed ${n}: org ladder`); assert.deepEqual(f.timelinePromotions,expected,`seed ${n}: career timeline ladder`);
    assert.ok(f.careerValid&&f.roundTrip,`seed ${n}: career timeline persistence`); assert.deepEqual(f.legacyPromotions,expected,`seed ${n}: legacy transaction reconstruction`); assert.equal(f.legacyInventedRole,false,`seed ${n}: legacy role invention`);
  }
}
const report={version:'v28',sourceGolden:golden.sourceVersion,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice(9); if(output) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(!quiet) console.log(JSON.stringify(report,null,2));
