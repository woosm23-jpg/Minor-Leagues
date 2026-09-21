import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';

const seedArgs=process.argv.filter(a=>a.startsWith('--seed=')).map(a=>Number(a.slice(7)));
const seeds=seedArgs.length?seedArgs:[1,2,3,4,5,6];
const verify=process.argv.includes('--verify');
const recordGolden=process.argv.includes('--record-golden');
const quiet=process.argv.includes('--quiet');
const outputArg=process.argv.find(a=>a.startsWith('--output='));
const goldenPath=new URL('../tests/fixtures/v41-injury-world-golden.json',import.meta.url);
const golden=fs.existsSync(goldenPath)?JSON.parse(fs.readFileSync(goldenPath,'utf8')):{sourceVersion:'phase3_injury_state_v41',rows:[]};
const goldenMap=new Map((golden.rows??[]).map(r=>[r.n,r]));
const levels=['A','HIGH_A','AA','AAA','MLB'];

function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
function sha(v){return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');}
function inputFor(n){
  const positions=['SS','CF','2B','3B','LF','RF'];
  const archetypes=['HIT_FIRST','POWER_FIRST','POWER_SPEED','GLOVE_FIRST','ATHLETIC','DISCIPLINE_FIRST'];
  const bodies=['ATHLETIC','POWER_FRAME','LEAN','STURDY','AVERAGE','ATHLETIC'];
  const traits=[['QUICK_BAT','SOFT_HANDS'],['RAW_STRENGTH','STRONG_ARM'],['BASE_STEALER','QUICK_FIRST_STEP'],['SOFT_HANDS','STRONG_ARM'],['QUICK_BAT','BASE_STEALER'],['ADVANCED_APPROACH','QUICK_FIRST_STEP']];
  const favorites=['FOX','BEA','COM','WAV','OWL','JET']; const i=(n-1)%6;
  return {name:`테스트 선수 ${n}`,nationality:'대한민국',hometown:`테스트시 ${n}`,age:18+((n-1)%5),heightCm:176+i*2,weightKg:72+i*3,bodyType:bodies[i],bats:n%3===0?'S':(n%2===0?'L':'R'),throws:'R',primaryPosition:positions[i],archetype:archetypes[i],visibleTraits:traits[i],organizationMode:n%2===0?'FAVORITE':'RANDOM',favoriteOrganizationId:n%2===0?favorites[i]:null};
}
function healthSummary(payload){
  let total=0,major=0,active=0,position=0,pitcher=0; const severity={DAY_TO_DAY:0,MINOR:0,MODERATE:0,MAJOR:0,SEASON_ENDING:0}; const families={};
  const scan=(states,kind)=>{for(const state of Object.values(states??{})){const h=state.health;if(!h)continue;const c=Number(h.history?.total??0);total+=c;if(kind==='POSITION')position+=c;else pitcher+=c;major+=Number(h.history?.major??0);if(h.activeInjury){active++;assert.ok(Number(h.activeInjury.daysRemaining)>0);assert.match(h.activeInjury.startDate,/^\d{4}-\d{2}-\d{2}$/);assert.match(h.activeInjury.expectedReturnDate,/^\d{4}-\d{2}-\d{2}$/);}for(const row of h.history?.recent??[]){if(Object.hasOwn(severity,row.severity))severity[row.severity]++;families[row.family]=(families[row.family]??0)+1;}}};
  scan(payload.playerStates,'POSITION');scan(payload.pitcherStates,'PITCHER');
  return {total,major,active,position,pitcher,severity,families};
}
function levelGames(snapshot){return Object.fromEntries(levels.map(level=>[level,snapshot.userStatsByLevel[level].leagueGamesCompleted]));}
function runDemo(n){
  const seed=`v41-injury-demo-${n}`; let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'}); s=seasonApi.simulateToSeasonEnd(s.seasonId); const p=seasonApi.serializeSeason(s.seasonId); const digest=sha(p); const restored=seasonApi.restoreSeason(structuredClone(p)); const rp=seasonApi.serializeSeason(restored.seasonId);
  return {seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,worldTotal:s.progress.worldLeagueGamesTotal,userGames:s.userSeasonLine.G,restGames:s.userRole.restGames,levels:levelGames(s),gameVersion:p.gameVersion,schemaVersion:p.schemaVersion,health:healthSummary(p),userHealth:s.userPlayer.status?.health,roundTripSame:sha(rp)===digest,sha256:digest};
}
function runCreated(n){
  const seed=`v41-new-career-${n}`,input=inputFor(n); let s=seasonApi.createCareerSeason({seed,startDate:'2026-04-01',input}); const initial={name:s.userPlayer.name,position:s.userPlayer.primaryPosition,bats:s.userPlayer.bats,throws:s.userPlayer.throws}; s=seasonApi.simulateToSeasonEnd(s.seasonId); const p=seasonApi.serializeSeason(s.seasonId); const digest=sha(p); const restored=seasonApi.restoreSeason(structuredClone(p)); const rp=seasonApi.serializeSeason(restored.seasonId); const userState=p.playerStates[p.fixture.userPlayerId];
  return {seed,input,initial,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,worldTotal:s.progress.worldLeagueGamesTotal,userGames:s.userSeasonLine.G,levels:levelGames(s),gameVersion:p.gameVersion,schemaVersion:p.schemaVersion,health:healthSummary(p),userHealth:s.userPlayer.status?.health,userInternalAge:userState?.health?.age,publicHiddenSafe:!Object.hasOwn(s.userPlayer.status?.health??{},'age'),roundTripSame:sha(rp)===digest,sha256:digest};
}
const rows=[];
for(const n of seeds){
  const demo=runDemo(n),created=runCreated(n),expected=goldenMap.get(n)??null; rows.push({n,demo,created});
  if(verify){
    for(const row of [demo,created]){assert.equal(row.status,'COMPLETE');assert.equal(row.worldGames,560);assert.equal(row.worldTotal,560);assert.equal(row.gameVersion,'phase3_injury_state_v41');assert.equal(row.schemaVersion,2);assert.equal(row.roundTripSame,true);for(const level of levels)assert.equal(row.levels[level],112);assert.ok(row.health.total>0 && row.health.total<100,`seed ${n}: injury total sanity`);}
    assert.equal(created.initial.name,created.input.name);assert.equal(created.initial.position,created.input.primaryPosition);assert.equal(created.initial.bats,created.input.bats);assert.equal(created.initial.throws,created.input.throws);assert.equal(created.userInternalAge,created.input.age);assert.equal(created.publicHiddenSafe,true);
    if(expected){assert.equal(demo.sha256,expected.demoSha256,`seed ${n}: demo golden changed`);assert.equal(created.sha256,expected.createdSha256,`seed ${n}: created golden changed`);assert.deepEqual(demo.health,expected.demoHealth,`seed ${n}: demo injury history changed`);assert.deepEqual(created.health,expected.createdHealth,`seed ${n}: created injury history changed`);} else if(!recordGolden){throw new Error(`seed ${n}: v41 golden missing`);}
  }
}
if(recordGolden){
  const out={sourceVersion:'phase3_injury_state_v41',rows:rows.map(({n,demo,created})=>({n,demoSha256:demo.sha256,createdSha256:created.sha256,demoHealth:demo.health,createdHealth:created.health}))};
  fs.writeFileSync(goldenPath,JSON.stringify(out,null,2)+'\n');
}
const report={version:'v41',sourceGolden:golden.sourceVersion??null,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice('--output='.length);if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');if(!quiet)console.log(JSON.stringify(report,null,2));
