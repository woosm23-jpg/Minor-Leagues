import fs from 'node:fs';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';
import { createFutureProductionSchedules } from '../src/services/productionSeasonFactory.js';

const snapshot=JSON.parse(fs.readFileSync('data/master-snapshots/mlb-milb-2026-production.json','utf8'));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot});
assert.equal(catalog.organizations.length,30);
const input={
  name:'Production QA', nationality:'대한민국', hometown:'테스트', age:18,
  heightCm:180, weightKg:78, bodyType:'ATHLETIC', bats:'R', throws:'R',
  primaryPosition:'SS', archetype:'HIT_FIRST', visibleTraits:['QUICK_BAT','SOFT_HANDS'],
  organizationMode:'FAVORITE', favoriteOrganizationId:String(catalog.organizations[0].id)
};
const created=seasonApi.createCareerSeason({seed:'v47-real-production-runtime',input,masterSnapshot:snapshot});
const payload=seasonApi.serializeSeason(created.seasonId);
assert.equal(payload.fixture.worldMode,'PRODUCTION_REAL');
assert.equal(payload.dataUniverse.origin,'MASTER_SNAPSHOT');
assert.equal(payload.dataUniverse.sourceSnapshot.hash,'fnv1a32:5d641237');
assert.equal(payload.dataUniverse.data.teams.length,150);
assert.equal(payload.dataUniverse.data.players.length,5201);
assert.equal(payload.dataUniverse.data.parks.length,30);
const levels=['MLB','AAA','AA','HIGH_A','A'];
const levelSummary={};
for(const level of levels){
  const league=payload.fixture.levelLeagues[level];
  assert.ok(league);
  assert.equal(league.teams.length,30);
  const rosters=Object.values(league.rosters);
  assert.equal(rosters.length,30);
  const pos=rosters.map(r=>r.positionPlayers.length);
  const pits=rosters.map(r=>r.pitchers.length);
  const bench=rosters.map(r=>r.bench.length);
  for(const r of rosters){assert.equal(r.lineup.length,9);assert.equal(r.starters.length,5);assert.ok(r.bullpen.length>=3);}
  levelSummary[level]={teams:30,schedule:league.schedule.length,minPositionPlayers:Math.min(...pos),minPitchers:Math.min(...pits),minBench:Math.min(...bench)};
}
const future=createFutureProductionSchedules(payload.fixture,{startDate:'2027-03-25'});
const futureSummary={};
for(const level of levels){
  const games=future[level];
  assert.equal(games.length,2430);
  const c={};
  for(const t of payload.fixture.levelLeagues[level].teams)c[t.id]={games:0,home:0,away:0};
  for(const g of games){c[g.homeTeamId].games++;c[g.homeTeamId].home++;c[g.awayTeamId].games++;c[g.awayTeamId].away++;}
  const vals=Object.values(c);
  assert.ok(vals.every(x=>x.games===162&&x.home===81&&x.away===81));
  futureSummary[level]={games:games.length,minGames:Math.min(...vals.map(x=>x.games)),maxGames:Math.max(...vals.map(x=>x.games)),home:[Math.min(...vals.map(x=>x.home)),Math.max(...vals.map(x=>x.home))],away:[Math.min(...vals.map(x=>x.away)),Math.max(...vals.map(x=>x.away))]};
}
const report={pass:true,snapshotId:snapshot.metadata.snapshotId,contentHash:snapshot.metadata.contentHash,organizations:catalog.organizations.length,players:payload.dataUniverse.data.players.length,teams:payload.dataUniverse.data.teams.length,parks:payload.dataUniverse.data.parks.length,selectedOrganization:payload.fixture.organization.name,userLevel:payload.fixture.organization.userLevel,levels:levelSummary,future:futureSummary};
fs.writeFileSync('reports/phase4-real-production-fixture-v47.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
