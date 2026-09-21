import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';

const seedArgs=process.argv.filter(a=>a.startsWith('--seed=')).map(a=>Number(a.slice(7)));
const seeds=seedArgs.length?seedArgs:[1,2,3,4,5,6];
const verify=process.argv.includes('--verify');
const quiet=process.argv.includes('--quiet');
const outputArg=process.argv.find(a=>a.startsWith('--output='));
const v38Golden=JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v38-world-golden.json',import.meta.url),'utf8'));
const legacyMap=new Map(v38Golden.rows.map(r=>[r.seedString,r.sha256]));
const createdPath=new URL('../tests/fixtures/v40-new-career-golden.json',import.meta.url);
const createdGolden=fs.existsSync(createdPath)?JSON.parse(fs.readFileSync(createdPath,'utf8')):{rows:[]};
const createdMap=new Map((createdGolden.rows??[]).map(r=>[r.seed,r.sha256]));
const levels=['A','HIGH_A','AA','AAA','MLB'];
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
function sha(v){return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');}
function stripV32Additions(value){if(Array.isArray(value))return value.map(stripV32Additions);if(value&&typeof value==='object'){const out={};for(const [key,val] of Object.entries(value)){if(['positioning','primaryPosition','positionFamiliarity','positionReps'].includes(key))continue;out[key]=stripV32Additions(val);}return out;}return value;}
function legacyCore(payload){
  const legacyLevels=['A','AA','AAA','MLB'], ids=new Set();
  for(const level of legacyLevels)for(const roster of Object.values(payload.fixture.levelLeagues[level].rosters))for(const id of Object.keys(roster.players))ids.add(id);
  const pick=obj=>Object.fromEntries([...ids].sort().filter(id=>obj[id]).map(id=>[id,obj[id]]));
  return stripV32Additions({
    levelSeasons:Object.fromEntries(legacyLevels.map(level=>[level,payload.levelSeasons[level]])),
    levelLeagues:Object.fromEntries(legacyLevels.map(level=>[level,payload.fixture.levelLeagues[level]])),
    organization:{userLevel:payload.fixture.organization.userLevel,levels:Object.fromEntries(legacyLevels.map(level=>[level,payload.fixture.organization.levels[level]]))},
    playerStates:pick(payload.playerStates),pitcherStates:pick(payload.pitcherStates),roleStates:pick(payload.roleStates??{})
  });
}
function inputFor(n){
  const positions=['SS','CF','2B','3B','LF','RF'];
  const archetypes=['HIT_FIRST','POWER_FIRST','POWER_SPEED','GLOVE_FIRST','ATHLETIC','DISCIPLINE_FIRST'];
  const bodies=['ATHLETIC','POWER_FRAME','LEAN','STURDY','AVERAGE','ATHLETIC'];
  const traits=[['QUICK_BAT','SOFT_HANDS'],['RAW_STRENGTH','STRONG_ARM'],['BASE_STEALER','QUICK_FIRST_STEP'],['SOFT_HANDS','STRONG_ARM'],['QUICK_BAT','BASE_STEALER'],['ADVANCED_APPROACH','QUICK_FIRST_STEP']];
  const favorites=['FOX','BEA','COM','WAV','OWL','JET'];
  const i=(n-1)%6;
  return {name:`테스트 선수 ${n}`,nationality:'대한민국',hometown:`테스트시 ${n}`,age:18+((n-1)%5),heightCm:176+i*2,weightKg:72+i*3,bodyType:bodies[i],bats:n%3===0?'S':(n%2===0?'L':'R'),throws:'R',primaryPosition:positions[i],archetype:archetypes[i],visibleTraits:traits[i],organizationMode:n%2===0?'FAVORITE':'RANDOM',favoriteOrganizationId:n%2===0?favorites[i]:null};
}
function runLegacy(n){
  const seed=`v29-stability-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const p=seasonApi.serializeSeason(s.seasonId);
  return {seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,worldTotal:s.progress.worldLeagueGamesTotal,userGames:s.userSeasonLine.G,restGames:s.userRole.restGames,gameVersion:p.gameVersion,legacyHash:sha(legacyCore(p)),expectedLegacyHash:legacyMap.get(seed),levels:Object.fromEntries(levels.map(level=>[level,s.userStatsByLevel[level].leagueGamesCompleted]))};
}
function runCreated(n){
  const seed=`v40-new-career-${n}`,input=inputFor(n);
  let s=seasonApi.createCareerSeason({seed,startDate:'2026-04-01',input});
  const initial={name:s.userPlayer.name,teamId:s.userTeam.id,position:s.userPlayer.primaryPosition,bats:s.userPlayer.bats,throws:s.userPlayer.throws};
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const p=seasonApi.serializeSeason(s.seasonId),digest=sha(p);
  const restored=seasonApi.restoreSeason(structuredClone(p));
  const rp=seasonApi.serializeSeason(restored.seasonId);
  const cp=p.fixture.careerProfile;
  return {seed,input,initial,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,worldTotal:s.progress.worldLeagueGamesTotal,finalLevel:s.currentLevel,levels:Object.fromEntries(levels.map(level=>[level,s.userStatsByLevel[level].leagueGamesCompleted])),gameVersion:p.gameVersion,schemaVersion:p.schemaVersion,teamId:cp.organizationChoice.teamId,organizationMode:cp.organizationChoice.mode,identity:cp.identity,visibleTraits:cp.visibleTraits,authoritativeHidden:Boolean(cp.startingProfile?.hiddenDevelopmentTrait),publicHiddenSafe:!JSON.stringify(restored.userPlayer.careerProfile??{}).includes('hiddenDevelopmentTrait')&&!JSON.stringify(restored.userPlayer.careerProfile??{}).includes('ceilings'),roundTripSame:sha(rp)===digest,sha256:digest,expectedSha256:createdMap.get(seed)??null};
}
const rows=[];
for(const n of seeds){
  const legacy=runLegacy(n),created=runCreated(n); rows.push({n,legacy,created});
  if(verify){
    assert.equal(legacy.status,'COMPLETE');assert.equal(legacy.worldGames,560);assert.equal(legacy.worldTotal,560);assert.equal(legacy.userGames,27);assert.equal(legacy.restGames,1);assert.equal(legacy.gameVersion,'phase3_new_career_v40');assert.equal(legacy.legacyHash,legacy.expectedLegacyHash,`seed ${n}: legacy v38 world changed`);for(const level of levels)assert.equal(legacy.levels[level],112);
    assert.equal(created.status,'COMPLETE');assert.equal(created.worldGames,560);assert.equal(created.worldTotal,560);for(const level of levels)assert.equal(created.levels[level],112);assert.equal(created.gameVersion,'phase3_new_career_v40');assert.equal(created.schemaVersion,2);assert.equal(created.initial.name,created.input.name);assert.equal(created.initial.position,created.input.primaryPosition);assert.equal(created.initial.bats,created.input.bats);assert.equal(created.initial.throws,created.input.throws);assert.equal(created.identity.name,created.input.name);assert.equal(created.identity.hometown,created.input.hometown);assert.equal(created.identity.bodyType,created.input.bodyType);assert.deepEqual(created.visibleTraits,created.input.visibleTraits);assert.equal(created.authoritativeHidden,true);assert.equal(created.publicHiddenSafe,true);assert.equal(created.roundTripSame,true);if(created.input.organizationMode==='FAVORITE')assert.equal(created.teamId,created.input.favoriteOrganizationId);else assert.equal(created.organizationMode,'RANDOM');if(created.expectedSha256)assert.equal(created.sha256,created.expectedSha256,`seed ${n}: v40 new-career golden changed`);
  }
}
const report={version:'v40',sourceGolden:v38Golden.sourceVersion,createdCareerGolden:createdGolden.sourceVersion??null,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice('--output='.length);if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');if(!quiet)console.log(JSON.stringify(report,null,2));
