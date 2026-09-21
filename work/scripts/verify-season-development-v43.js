import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';

const seedArg=process.argv.find(a=>a.startsWith('--seed='));
const seed=Number(seedArg?.slice(7)??1);
const verify=process.argv.includes('--verify');
const quiet=process.argv.includes('--quiet');
const outputArg=process.argv.find(a=>a.startsWith('--output='));
const goldenPath=new URL('../tests/fixtures/v43-development-world-golden.json',import.meta.url);
const golden=fs.existsSync(goldenPath)?JSON.parse(fs.readFileSync(goldenPath,'utf8')):{sourceVersion:'phase3_development_core_v43',rows:[]};
const expected=(golden.rows??[]).find(row=>row.n===seed)??null;
const levels=['A','HIGH_A','AA','AAA','MLB'];
const trajectories=['NORMAL','BREAKOUT','BUST','STAGNATION'];
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
function sha(v){return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');}
function inputFor(n){
  const positions=['SS','CF','2B','3B','LF','RF']; const archetypes=['HIT_FIRST','POWER_FIRST','POWER_SPEED','GLOVE_FIRST','ATHLETIC','DISCIPLINE_FIRST'];
  const bodies=['ATHLETIC','POWER_FRAME','LEAN','STURDY','AVERAGE','ATHLETIC']; const traits=[['QUICK_BAT','SOFT_HANDS'],['RAW_STRENGTH','STRONG_ARM'],['BASE_STEALER','QUICK_FIRST_STEP'],['SOFT_HANDS','STRONG_ARM'],['QUICK_BAT','BASE_STEALER'],['ADVANCED_APPROACH','QUICK_FIRST_STEP']];
  const favorites=['FOX','BEA','COM','WAV','OWL','JET']; const i=(n-1)%6;
  return {name:`테스트 선수 ${n}`,nationality:'대한민국',hometown:`테스트시 ${n}`,age:18+((n-1)%5),heightCm:176+i*2,weightKg:72+i*3,bodyType:bodies[i],bats:n%3===0?'S':(n%2===0?'L':'R'),throws:'R',primaryPosition:positions[i],archetype:archetypes[i],visibleTraits:traits[i],organizationMode:n%2===0?'FAVORITE':'RANDOM',favoriteOrganizationId:n%2===0?favorites[i]:null};
}
function countTrajectories(states){
  const counts=Object.fromEntries(trajectories.map(type=>[type,0]));
  for(const state of states){ const type=state.development?.lastOffseason?.type; if(type in counts) counts[type]+=1; }
  return counts;
}
function progressedCount(states){
  return states.filter(state => {
    const gains = Object.values(state.development?.gains ?? {}).some(value => Math.abs(Number(value) || 0) > 1e-9);
    const progress = Object.values(state.development?.progress ?? {}).some(value => Math.abs(Number(value) || 0) > 1e-9);
    return gains || progress;
  }).length;
}
function summary(payload,snapshot){
  const hitters=Object.values(payload.playerStates??{}),pitchers=Object.values(payload.pitcherStates??{});
  const migrations=hitters.filter(state=>state.aging?.lastMigration?.seasonKey).map(state=>({playerId:state.playerId,from:state.aging.lastMigration.fromPosition,to:state.aging.lastMigration.toPosition,seasonKey:state.aging.lastMigration.seasonKey})).sort((a,b)=>a.playerId.localeCompare(b.playerId));
  const hitterAgingProcessed=hitters.filter(state=>state.aging?.processedSeasons?.length===1).length;
  const pitcherAgingProcessed=pitchers.filter(state=>state.aging?.processedSeasons?.length===1).length;
  const hitterDevelopmentProcessed=hitters.filter(state=>state.development?.processedOffseasons?.length===1).length;
  const pitcherDevelopmentProcessed=pitchers.filter(state=>state.development?.processedOffseasons?.length===1).length;
  const levelGames=Object.fromEntries(levels.map(level=>[level,snapshot.userStatsByLevel[level].leagueGamesCompleted]));
  return {
    status:snapshot.status,worldGames:snapshot.progress.worldLeagueGamesCompleted,worldTotal:snapshot.progress.worldLeagueGamesTotal,levelGames,
    hitterAgingProcessed,pitcherAgingProcessed,hitterDevelopmentProcessed,pitcherDevelopmentProcessed,
    hitterProgressed:progressedCount(hitters),pitcherProgressed:progressedCount(pitchers),
    hitterTrajectories:countTrajectories(hitters),pitcherTrajectories:countTrajectories(pitchers),
    migrationCount:migrations.length,migrations
  };
}
function run(kind){
  const seedText=`v43-development-${kind}-${seed}`;
  let s=kind==='demo'?seasonApi.createDemoSeason({seed:seedText,startDate:'2026-04-01'}):seasonApi.createCareerSeason({seed:seedText,startDate:'2026-04-01',input:inputFor(seed)});
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const payload=seasonApi.serializeSeason(s.seasonId); const digest=sha(payload);
  const restored=seasonApi.restoreSeason(structuredClone(payload)); const roundTrip=seasonApi.serializeSeason(restored.seasonId);
  const second=seasonApi.simulateToSeasonEnd(restored.seasonId); const secondPayload=seasonApi.serializeSeason(second.seasonId);
  return {kind,gameVersion:payload.gameVersion,schemaVersion:payload.schemaVersion,roundTripSame:sha(roundTrip)===digest,idempotentSame:sha(secondPayload)===digest,sha256:digest,...summary(payload,s)};
}
const row={n:seed,demo:run('demo'),created:run('created')};
if(verify){
  for(const r of [row.demo,row.created]){
    assert.equal(r.status,'COMPLETE'); assert.equal(r.worldGames,560); assert.equal(r.worldTotal,560); assert.equal(r.gameVersion,'phase3_development_core_v43'); assert.equal(r.schemaVersion,2);
    assert.equal(r.hitterAgingProcessed,520); assert.equal(r.pitcherAgingProcessed,280); assert.equal(r.hitterDevelopmentProcessed,520); assert.equal(r.pitcherDevelopmentProcessed,280);
    assert.equal(r.roundTripSame,true); assert.equal(r.idempotentSame,true); assert.ok(r.hitterProgressed>0); assert.ok(r.pitcherProgressed>0); for(const level of levels) assert.equal(r.levelGames[level],112);
    assert.equal(Object.values(r.hitterTrajectories).reduce((a,b)=>a+b,0),520); assert.equal(Object.values(r.pitcherTrajectories).reduce((a,b)=>a+b,0),280);
  }
  if(!expected) throw new Error(`seed ${seed}: v43 golden missing`);
  assert.equal(row.demo.sha256,expected.demoSha256,`seed ${seed}: demo golden changed`); assert.equal(row.created.sha256,expected.createdSha256,`seed ${seed}: created golden changed`);
  assert.deepEqual(row.demo.migrations,expected.demoMigrations,`seed ${seed}: demo migration set changed`); assert.deepEqual(row.created.migrations,expected.createdMigrations,`seed ${seed}: created migration set changed`);
  assert.deepEqual(row.demo.hitterTrajectories,expected.demoHitterTrajectories,`seed ${seed}: demo hitter trajectory counts changed`); assert.deepEqual(row.demo.pitcherTrajectories,expected.demoPitcherTrajectories,`seed ${seed}: demo pitcher trajectory counts changed`);
  assert.deepEqual(row.created.hitterTrajectories,expected.createdHitterTrajectories,`seed ${seed}: created hitter trajectory counts changed`); assert.deepEqual(row.created.pitcherTrajectories,expected.createdPitcherTrajectories,`seed ${seed}: created pitcher trajectory counts changed`);
}
const output=outputArg?.slice('--output='.length); if(output)fs.writeFileSync(output,JSON.stringify({version:'v43',rows:[row]},null,2)+'\n'); if(!quiet)console.log(JSON.stringify(row,null,2));
