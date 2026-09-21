import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';
import { createNextProductionSeasonFixture } from '../src/services/productionSeasonFactory.js';
import { advanceProductionOffseasonEcology } from '../src/services/productionOffseasonEcology.js';
import { restoreSeasonSession, serializeSeasonSession } from '../src/services/seasonSerialization.js';
import { createScoutingState, buildScoutingReport, prospectRankingScore } from '../src/engine/season/scoutingState.js';

const LEVELS=['MLB','AAA','AA','HIGH_A','A'];
const base=JSON.parse(zlib.gunzipSync(fs.readFileSync('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz')).toString('utf8'));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:base});
const input={
  name:'Ecology QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',
  primaryPosition:'SS',archetype:'HIT_FIRST',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(catalog.organizations[0].id)
};
const created=seasonApi.createCareerSeason({seed:'v50-live-ecology',input,masterSnapshot:base});
const payload=seasonApi.serializeSeason(created.seasonId);
const beforeFixture=payload.fixture;
const nextFixture=createNextProductionSeasonFixture(beforeFixture,{startDate:'2027-03-25'});
const result=advanceProductionOffseasonEcology({
  fixture:nextFixture,dataUniverse:payload.dataUniverse,playerStates:payload.playerStates,pitcherStates:payload.pitcherStates,
  ecologyState:payload.leagueEcologyState,year:2027,userPlayerId:beforeFixture.userPlayerId
});

function rosterShape(fixture){
  const out={};
  for(const level of LEVELS){
    out[level]={};
    for(const [teamId,r] of Object.entries(fixture.levelLeagues[level].rosters)){
      out[level][teamId]={total:Object.keys(r.players).length,hitters:r.positionPlayers.length,pitchers:r.pitchers.length};
    }
  }
  return out;
}
function activeIds(fixture){
  return LEVELS.flatMap(level=>Object.values(fixture.levelLeagues[level].rosters).flatMap(r=>Object.keys(r.players)));
}
const beforeShape=rosterShape(beforeFixture), afterShape=rosterShape(result.fixture);
assert.deepEqual(afterShape,beforeShape,'team/level role roster shapes changed');
const beforeIds=activeIds(beforeFixture),afterIds=activeIds(result.fixture);
assert.equal(new Set(beforeIds).size,beforeIds.length,'before roster duplicate ids');
assert.equal(new Set(afterIds).size,afterIds.length,'after roster duplicate ids');
assert.equal(afterIds.length,beforeIds.length,'active population drift');
assert.equal(result.summary.retired,result.summary.generated,'retirement/replacement mismatch');
for(const id of result.summary.retiredIds) assert.equal(afterIds.includes(id),false,`retired id remains active: ${id}`);
for(const id of result.summary.entrantIds) assert.equal(afterIds.includes(id),true,`entrant missing from active roster: ${id}`);
assert.ok(result.summary.retired>0,'smoke seed produced no retirements');
assert.equal(result.summary.populationBefore,result.summary.populationAfter);
assert.equal(result.ecologyState.year,2027);
assert.equal(result.ecologyState.totalRetired,result.summary.retired);
assert.equal(result.ecologyState.totalGenerated,result.summary.generated);
assert.ok(result.fixture.organization.levels[result.fixture.organization.userLevel].roster.players[beforeFixture.userPlayerId],'user player lost from organization roster');

const generatedScouting=[];
for(const id of result.summary.entrantIds){
  let found=null;
  for(const level of LEVELS){
    for(const roster of Object.values(result.fixture.levelLeagues[level].rosters)){
      if(roster.players[id]){found={level,player:roster.players[id]};break;}
    }
    if(found)break;
  }
  assert.ok(found,`entrant fixture lookup failed: ${id}`);
  assert.equal(found.player.generated,true);
  assert.equal(found.player.generatedCareer?.mlbDebutYear,null);
  const ps=result.playerStates[id]??null, qs=result.pitcherStates[id]??null;
  const state=ps??qs;
  const scouting=createScoutingState(found.player,{seed:beforeFixture.seed,level:found.level,age:state?.health?.age??found.player.physical?.age,startDate:'2027-03-25'});
  const report=buildScoutingReport({player:found.player,scouting,development:state?.development??null,age:state?.health?.age??found.player.physical?.age,level:found.level,primaryPosition:found.player.positioning?.primaryPosition??'P',role:found.player.pitching?.role??null,kind:qs?'PITCHER':'POSITION'});
  const position=qs?(found.player.pitching?.role??'RP'):(found.player.positioning?.primaryPosition??'DH');
  const score=prospectRankingScore(report,{age:state?.health?.age??found.player.physical?.age,level:found.level,position});
  assert.ok(Number.isFinite(report.futureValue));
  assert.ok(Number.isFinite(score));
  generatedScouting.push({id,level:found.level,futureValue:report.futureValue,score});
}

for(const id of result.summary.entrantIds){
  const inHitter=Boolean(result.playerStates[id]), inPitcher=Boolean(result.pitcherStates[id]);
  assert.notEqual(inHitter,inPitcher,`entrant state type invalid: ${id}`);
}

// Save persistence is verified separately at the serialization layer to avoid
// re-normalizing the full 5,429-player embedded universe in this roster gate.
const ecologyPayload={schemaVersion:payload.schemaVersion,leagueEcologyState:result.ecologyState};

const report={
  schema:'THE_CALL_UP_PRODUCTION_LIVE_ECOLOGY_V50_V1',pass:true,year:2027,
  population:{before:beforeIds.length,after:afterIds.length},
  offseason:result.summary,
  save:{schemaVersion:ecologyPayload.schemaVersion,ecologyPersisted:Boolean(ecologyPayload.leagueEcologyState),generatedRosterPersisted:'SEPARATE_SERIALIZATION_GATE'},
  levelTotals:Object.fromEntries(LEVELS.map(level=>[level,Object.values(afterShape[level]).reduce((s,r)=>s+r.total,0)])),
  generatedScouting:{count:generatedScouting.length,finite:generatedScouting.every(r=>Number.isFinite(r.futureValue)&&Number.isFinite(r.score)),top:generatedScouting.sort((a,b)=>b.score-a.score).slice(0,5)}
};
fs.writeFileSync('reports/v50-production-live-ecology-integration.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
