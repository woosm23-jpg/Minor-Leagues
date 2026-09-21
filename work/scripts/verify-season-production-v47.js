import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';

const seedArg=process.argv.find(a=>a.startsWith('--seed='));
const seed=Number(seedArg?.slice(7)??1);
const verify=process.argv.includes('--verify');
const quiet=process.argv.includes('--quiet');
const outputArg=process.argv.find(a=>a.startsWith('--output='));
const baselineGoldenPath=new URL('../tests/fixtures/v44-scouting-world-golden.json',import.meta.url);
const baselineGolden=JSON.parse(fs.readFileSync(baselineGoldenPath,'utf8'));
const baselineExpected=(baselineGolden.rows??[]).find(row=>row.n===seed)??null;
const goldenPath=new URL('../tests/fixtures/v47-production-world-golden.json',import.meta.url);
const golden=fs.existsSync(goldenPath)?JSON.parse(fs.readFileSync(goldenPath,'utf8')):{sourceVersion:'phase4_production_world_activation_v47',rows:[]};
const expected=(golden.rows??[]).find(row=>row.n===seed)??null;
const levels=['A','HIGH_A','AA','AAA','MLB'];
const trajectories=['NORMAL','BREAKOUT','BUST','STAGNATION'];
const confidenceBands=['LOW','FAIR','GOOD','HIGH'];
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
function confidenceFromExposure(exposure){ if(exposure>=0.82)return 'HIGH'; if(exposure>=0.62)return 'GOOD'; if(exposure>=0.40)return 'FAIR'; return 'LOW'; }
function scoutingSummary(payload,snapshot,seasonId){
  const states=Object.values(payload.scoutingStates??{});
  const confidence=Object.fromEntries(confidenceBands.map(b=>[b,0]));
  const observations=[];
  for(const state of states){ confidence[confidenceFromExposure(Number(state.exposure)||0)]++; observations.push(Number(state.observations)||0); }
  const prospects=(snapshot.organization?.prospectRankings??[]).map(row=>({rank:row.rank,id:row.id,level:row.level,position:row.position,age:row.age,futureValue:row.futureValue,futureValueRange:row.futureValueRange,confidence:row.confidence,risk:row.risk,eta:row.eta,pathway:row.pathway,isUser:row.isUser}));
  const userReport=seasonApi.getPlayerDetail(seasonId,snapshot.userPlayer.id).scouting;
  const publicText=JSON.stringify({prospects,userReport});
  const hiddenKeys=['randomKey','exposure','ceilings','ceiling','workEthic','trajectory','development.rate','truePotential'];
  return {
    stateCount:states.length,
    reviewedCount:states.filter(s=>(s.processedReviews??[]).length>0).length,
    confidence,
    observationMin:observations.length?Math.min(...observations):0,
    observationMax:observations.length?Math.max(...observations):0,
    observationPositive:observations.filter(v=>v>0).length,
    prospectCount:prospects.length,
    prospects,
    userReport,
    hiddenSafe:!hiddenKeys.some(key=>publicText.includes(`\"${key}\"`))
  };
}
function summary(payload,snapshot,seasonId){
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
    migrationCount:migrations.length,migrations,
    scouting:scoutingSummary(payload,snapshot,seasonId)
  };
}
function dataUniverseSummary(universe){
  return {schemaVersion:universe?.schemaVersion,origin:universe?.origin,sourceSnapshot:universe?.sourceSnapshot??null,copiedAtCareerStart:universe?.copiedAtCareerStart,sourceVersion:universe?.sourceVersion,snapshotDate:universe?.snapshotDate??null,provenanceCount:(universe?.provenance??[]).length,hasEmbeddedData:Boolean(universe?.data),independent:universe?.independent};
}
function run(kind){
  // Preserve the v44 seed namespace to prove v46's inference layer does not alter baseball outcomes.
  const seedText=`v44-scouting-${kind}-${seed}`;
  let s=kind==='demo'?seasonApi.createDemoSeason({seed:seedText,startDate:'2026-04-01'}):seasonApi.createCareerSeason({seed:seedText,startDate:'2026-04-01',input:inputFor(seed)});
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const payload=seasonApi.serializeSeason(s.seasonId); const digest=sha(payload);
  const mainSummary=summary(payload,s,s.seasonId);
  const restored=seasonApi.restoreSeason(structuredClone(payload)); const roundTrip=seasonApi.serializeSeason(restored.seasonId);
  const restoredSnapshot=seasonApi.getSeason(restored.seasonId);
  const restoredProspects=restoredSnapshot.organization.prospectRankings;
  const second=seasonApi.simulateToSeasonEnd(restored.seasonId); const secondPayload=seasonApi.serializeSeason(second.seasonId);
  return {kind,gameVersion:payload.gameVersion,schemaVersion:payload.schemaVersion,dataUniverse:dataUniverseSummary(payload.dataUniverse),roundTripSame:sha(roundTrip)===digest,idempotentSame:sha(secondPayload)===digest,prospectsRoundTripSame:sha(restoredProspects)===sha(s.organization.prospectRankings),sha256:digest,...mainSummary};
}
const row={n:seed,demo:run('demo'),created:run('created')};
if(verify){
  for(const r of [row.demo,row.created]){
    assert.equal(r.status,'COMPLETE'); assert.equal(r.worldGames,560); assert.equal(r.worldTotal,560); assert.equal(r.gameVersion,'phase4_production_world_activation_v47'); assert.equal(r.schemaVersion,2);
    assert.equal(r.dataUniverse.schemaVersion,1); assert.equal(r.dataUniverse.origin,'SYNTHETIC_DEV'); assert.equal(r.dataUniverse.sourceSnapshot,null); assert.equal(r.dataUniverse.sourceVersion,'phase4_production_world_activation_v47'); assert.equal(r.dataUniverse.hasEmbeddedData,false); assert.equal(r.dataUniverse.independent,true);
    assert.equal(r.hitterAgingProcessed,520); assert.equal(r.pitcherAgingProcessed,280); assert.equal(r.hitterDevelopmentProcessed,520); assert.equal(r.pitcherDevelopmentProcessed,280);
    assert.equal(r.roundTripSame,true); assert.equal(r.idempotentSame,true); assert.equal(r.prospectsRoundTripSame,true); assert.ok(r.hitterProgressed>0); assert.ok(r.pitcherProgressed>0); for(const level of levels) assert.equal(r.levelGames[level],112);
    assert.equal(Object.values(r.hitterTrajectories).reduce((a,b)=>a+b,0),520); assert.equal(Object.values(r.pitcherTrajectories).reduce((a,b)=>a+b,0),280);
    assert.equal(r.scouting.stateCount,800); assert.equal(r.scouting.reviewedCount,800); assert.equal(Object.values(r.scouting.confidence).reduce((a,b)=>a+b,0),800); assert.equal(r.scouting.observationPositive,800); assert.ok(r.scouting.observationMax>=r.scouting.observationMin); assert.equal(r.scouting.prospectCount,20); assert.equal(r.scouting.hiddenSafe,true);
    assert.ok([20,25,30,35,40,45,50,55,60,65,70,75,80].includes(r.scouting.userReport.futureValue));
    assert.ok(confidenceBands.includes(r.scouting.userReport.confidence));
  }
  if(!baselineExpected) throw new Error(`seed ${seed}: v44 baseline golden missing`);
  assert.deepEqual(row.demo.migrations,baselineExpected.demoMigrations,`seed ${seed}: demo migrations changed vs v44`); assert.deepEqual(row.created.migrations,baselineExpected.createdMigrations,`seed ${seed}: created migrations changed vs v44`);
  assert.deepEqual(row.demo.hitterTrajectories,baselineExpected.demoHitterTrajectories,`seed ${seed}: demo hitter trajectories changed vs v44`); assert.deepEqual(row.demo.pitcherTrajectories,baselineExpected.demoPitcherTrajectories,`seed ${seed}: demo pitcher trajectories changed vs v44`);
  assert.deepEqual(row.created.hitterTrajectories,baselineExpected.createdHitterTrajectories,`seed ${seed}: created hitter trajectories changed vs v44`); assert.deepEqual(row.created.pitcherTrajectories,baselineExpected.createdPitcherTrajectories,`seed ${seed}: created pitcher trajectories changed vs v44`);
  assert.deepEqual(row.demo.scouting.prospects,baselineExpected.demoProspects,`seed ${seed}: demo prospects changed vs v44`); assert.deepEqual(row.created.scouting.prospects,baselineExpected.createdProspects,`seed ${seed}: created prospects changed vs v44`);
  assert.deepEqual(row.demo.scouting.confidence,baselineExpected.demoConfidence,`seed ${seed}: demo confidence changed vs v44`); assert.deepEqual(row.created.scouting.confidence,baselineExpected.createdConfidence,`seed ${seed}: created confidence changed vs v44`);
  if(!expected) throw new Error(`seed ${seed}: v46 golden missing`);
  assert.equal(row.demo.sha256,expected.demoSha256,`seed ${seed}: demo v47 golden changed`); assert.equal(row.created.sha256,expected.createdSha256,`seed ${seed}: created v47 golden changed`);
  assert.deepEqual(row.demo.migrations,expected.demoMigrations,`seed ${seed}: demo migration set changed`); assert.deepEqual(row.created.migrations,expected.createdMigrations,`seed ${seed}: created migration set changed`);
  assert.deepEqual(row.demo.hitterTrajectories,expected.demoHitterTrajectories,`seed ${seed}: demo hitter trajectory counts changed`); assert.deepEqual(row.demo.pitcherTrajectories,expected.demoPitcherTrajectories,`seed ${seed}: demo pitcher trajectory counts changed`);
  assert.deepEqual(row.created.hitterTrajectories,expected.createdHitterTrajectories,`seed ${seed}: created hitter trajectory counts changed`); assert.deepEqual(row.created.pitcherTrajectories,expected.createdPitcherTrajectories,`seed ${seed}: created pitcher trajectory counts changed`);
  assert.deepEqual(row.demo.scouting.prospects,expected.demoProspects,`seed ${seed}: demo prospect ranking changed`); assert.deepEqual(row.created.scouting.prospects,expected.createdProspects,`seed ${seed}: created prospect ranking changed`);
  assert.deepEqual(row.demo.scouting.confidence,expected.demoConfidence,`seed ${seed}: demo confidence distribution changed`); assert.deepEqual(row.created.scouting.confidence,expected.createdConfidence,`seed ${seed}: created confidence distribution changed`);
}
const output=outputArg?.slice('--output='.length); if(output)fs.writeFileSync(output,JSON.stringify({version:'v47',rows:[row]},null,2)+'\n'); if(!quiet)console.log(JSON.stringify(row,null,2));
if (quiet) process.exit(0);
