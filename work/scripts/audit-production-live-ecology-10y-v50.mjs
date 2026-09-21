import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';
import { createNextProductionSeasonFixture } from '../src/services/productionSeasonFactory.js';
import { advanceProductionOffseasonEcology } from '../src/services/productionOffseasonEcology.js';

const LEVELS=['MLB','AAA','AA','HIGH_A','A'];
const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz')).toString('utf8'));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot});
const input={name:'Ecology 10Y QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'HIT_FIRST',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(catalog.organizations[0].id)};
const created=seasonApi.createCareerSeason({seed:'v50-live-ecology-10y',input,masterSnapshot:snapshot});
const payload=seasonApi.serializeSeason(created.seasonId);
let fixture=payload.fixture;
let playerStates=payload.playerStates;
let pitcherStates=payload.pitcherStates;
let ecologyState=payload.leagueEcologyState;
const userPlayerId=fixture.userPlayerId;
const initialCounts=levelCounts(fixture);
const initialPopulation=activeIds(fixture).length;
const checkpoints=[];

function activeIds(f){return LEVELS.flatMap(level=>Object.values(f.levelLeagues[level].rosters).flatMap(r=>Object.keys(r.players)));}
function levelCounts(f){return Object.fromEntries(LEVELS.map(level=>[level,Object.values(f.levelLeagues[level].rosters).reduce((n,r)=>n+Object.keys(r.players).length,0)]));}
function ageStates(states){return Object.fromEntries(Object.entries(states).map(([id,state])=>[id,{...state,health:state.health?{...state.health,age:Math.min(55,Number(state.health.age??24)+1)}:state.health}]));}
function generatedSummary(f){
  const rows=[];
  for(const level of LEVELS)for(const roster of Object.values(f.levelLeagues[level].rosters))for(const player of Object.values(roster.players))if(player.generated===true&&String(player.id)!==String(userPlayerId))rows.push({level,player});
  return {active:rows.length,mlb:rows.filter(r=>r.level==='MLB').length,everDebuted:rows.filter(r=>r.player.generatedCareer?.mlbDebutYear!=null).length};
}

for(let year=2027;year<=2036;year++){
  playerStates=ageStates(playerStates);
  pitcherStates=ageStates(pitcherStates);
  const scheduled=createNextProductionSeasonFixture(fixture,{startDate:`${year}-03-25`});
  const r=advanceProductionOffseasonEcology({fixture:scheduled,dataUniverse:payload.dataUniverse,playerStates,pitcherStates,ecologyState,year,userPlayerId});
  fixture=r.fixture;playerStates=r.playerStates;pitcherStates=r.pitcherStates;ecologyState=r.ecologyState;
  const ids=activeIds(fixture), counts=levelCounts(fixture), generated=generatedSummary(fixture);
  assert.equal(ids.length,initialPopulation,`${year}: population drift`);
  assert.equal(new Set(ids).size,ids.length,`${year}: duplicate player ids`);
  assert.deepEqual(counts,initialCounts,`${year}: level population drift`);
  assert.equal(r.summary.retired,r.summary.generated,`${year}: retirement/replacement mismatch`);
  assert.ok(fixture.organization.levels[fixture.organization.userLevel].roster.players[userPlayerId],`${year}: user player lost`);
  checkpoints.push({year,retired:r.summary.retired,generated:r.summary.generated,activeGenerated:generated.active,generatedMlb:generated.mlb,generatedEverDebuted:generated.everDebuted,classStrength:ecologyState.classStrength});
}
const final=checkpoints.at(-1);
assert.ok(final.activeGenerated>0,'generated population did not accumulate');
assert.ok(ecologyState.totalRetired===ecologyState.totalGenerated,'cumulative retirement/replacement mismatch');
const report={schema:'THE_CALL_UP_PRODUCTION_LIVE_ECOLOGY_10Y_V50_V1',pass:true,startYear:2026,endYear:2036,initialPopulation,levelCounts:initialCounts,totalRetired:ecologyState.totalRetired,totalGenerated:ecologyState.totalGenerated,checkpoints};
fs.writeFileSync('reports/v50-production-live-ecology-10y.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
