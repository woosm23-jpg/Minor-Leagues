import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {seasonApi} from '../src/api/seasonApi.js';
import {validateSeasonSavePayload} from '../src/services/seasonSerialization.js';
import {createTcuExportDocument,parseTcuExportText} from '../src/services/seasonTransferService.js';

const dataPath='data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz';
const source=readFileSync(dataPath);
const master=JSON.parse(zlib.gunzipSync(source).toString('utf8'));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
assert.equal(catalog.organizations.length,30,'Production v3 must include 30 organizations');
const input={name:'Phase 8 장기 저장 검증',nationality:'대한민국',hometown:'서울',age:18,heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(catalog.organizations[0].id)};
let snap=seasonApi.createCareerSeason({seed:'phase8-current-v3-two-year',input,masterSnapshot:master});
const seasonId=snap.seasonId;
const levels=['MLB','AAA','AA','HIGH_A','A'];
const started=performance.now();
const results=[];
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
function validateWorld(payload,year,expectComplete){
  assert.equal(validateSeasonSavePayload(payload,{mode:'FULL'}),true);
  const rows=[];
  let worldGames=0;
  for(const level of levels){
    const league=payload.fixture.levelLeagues?.[level];
    const state=payload.levelSeasons?.[level];
    assert.ok(league&&state,`${year} missing ${level}`);
    worldGames+=state.schedule.length;
    if(expectComplete)assert.equal(state.completedGames,state.schedule.length,`${year} ${level} incomplete`);
    for(const roster of Object.values(league.rosters??{}))rows.push(...Object.keys(roster.players??{}));
  }
  assert.equal(worldGames,10710,`${year} schedule changed`);
  assert.equal(new Set(rows).size,rows.length,`${year} duplicate active ID`);
  const retired=payload.retirementHallState?.retiredPlayers??{};
  const retiredRows=Array.isArray(retired)?retired:Object.values(retired);
  for(const r of retiredRows){const id=String(r?.playerId??r?.id??'');if(id)assert.ok(!rows.includes(id),`${year} retired player is active`);}
  return {worldGames,activePlayers:rows.length,saveBytes:Buffer.byteLength(JSON.stringify(payload)),historySeasons:payload.historyState?.seasons?.length??0};
}
function replayCore(payload){return {
  season:payload.season,levelSeasons:payload.levelSeasons,
  playerStates:payload.playerStates,pitcherStates:payload.pitcherStates,
  contractStates:payload.contractStates,contractMarketStates:payload.contractMarketStates,
  rosterControlStates:payload.rosterControlStates,tradeState:payload.tradeState,
  amateurAcquisitionState:payload.amateurAcquisitionState,retirementHallState:payload.retirementHallState,
  leagueEcologyState:payload.leagueEcologyState,historyState:payload.historyState,
  fixture:payload.fixture,playerStateDate:payload.playerStateDate
};}
function firstDifference(a,b,path='',depth=0){
  if(isDeepStrictEqual(a,b))return null;
  if(depth>=7||!a||!b||typeof a!=='object'||typeof b!=='object')return path||'(root)';
  const all=new Set([...Object.keys(a),...Object.keys(b)]);
  for(const key of all){
    const next=path?`${path}.${key}`:key;
    if(!Object.hasOwn(a,key))return `${next} (missing after restore)`;
    if(!Object.hasOwn(b,key))return `${next} (added after restore)`;
    if(!isDeepStrictEqual(a[key],b[key]))return firstDifference(a[key],b[key],next,depth+1)??next;
  }
  return path||'(root)';
}
function assertCoreStable(actual,expected,label){
  const a=replayCore(actual),b=replayCore(expected);
  if(!isDeepStrictEqual(a,b))throw new Error(`${label}: first mismatch ${firstDifference(a,b)}`);
}
function validateActiveStateMaps(payload,year){
  const hitters=new Set(),pitchers=new Set();
  for(const level of levels)for(const roster of Object.values(payload.fixture.levelLeagues[level].rosters??{})){
    for(const id of roster.positionPlayers??[])hitters.add(id);
    for(const id of roster.pitchers??[])pitchers.add(id);
  }
  for(const id of hitters)assert.ok(Object.hasOwn(payload.playerStates??{},id),`${year}: active hitter has no state ${id}`);
  for(const id of pitchers)assert.ok(Object.hasOwn(payload.pitcherStates??{},id),`${year}: active pitcher has no state ${id}`);
  for(const id of Object.keys(payload.playerStates??{}))assert.ok(hitters.has(id),`${year}: stale out-of-roster hitter state ${id}`);
  for(const id of Object.keys(payload.pitcherStates??{}))assert.ok(pitchers.has(id),`${year}: stale out-of-roster pitcher state ${id}`);
}
let before=seasonApi.serializeSeason(seasonId);
const initial=validateWorld(before,2026,false);
assert.equal(snap.seasonYear,2026);
assert.equal(snap.status,'REGULAR_SEASON');
const known=Object.entries(before.contractStates??{}).filter(([,c])=>c.baseline?.status==='KNOWN_ZERO');
assert.ok(known.length>0);
for(const [id,c] of known){
  assert.equal(before.contractMarketStates?.[id]?.eligibility?.serviceDays,
    Number(c.baseline.historicalServiceDays??0)+Number(c.simulatedServiceDays??0),
    `opening-day market clock mismatch for ${id}`);
}
for(const year of [2026,2027]){
  snap=seasonApi.getSeason(seasonId);
  assert.equal(snap.seasonYear,year);
  assert.equal(snap.status,'REGULAR_SEASON');
  if(year===2027){
    // Replay a real scheduled week from a saved 2027 opening-day checkpoint.
    const checkpoint=seasonApi.serializeSeason(seasonId);
    assert.equal(validateSeasonSavePayload(checkpoint,{mode:'FULL'}),true);
    const first=seasonApi.simulateSevenDays(seasonId);
    const progressed=seasonApi.serializeSeason(seasonId);
    assert.ok(first.currentDate>=checkpoint.season.currentDate);
    seasonApi.restoreSeason(structuredClone(checkpoint));
    const second=seasonApi.simulateSevenDays(seasonId);
    const replayed=seasonApi.serializeSeason(seasonId);
    assert.equal(second.currentDate,first.currentDate,'checkpoint replay date drift');
    assertCoreStable(replayed,progressed,'checkpoint replay changed the world');
  }
  const t0=performance.now();
  snap=seasonApi.simulateToSeasonEnd(seasonId);
  assert.equal(snap.status,'COMPLETE',`${year}: regular season did not complete`);
  const completed=seasonApi.serializeSeason(seasonId);
  const completeMeta=validateWorld(completed,year,true);
  snap=seasonApi.startPostseason(seasonId);
  for(let i=0;i<10&&snap.postseason?.status!=='COMPLETE';i++)snap=seasonApi.advancePostseasonRound(seasonId);
  assert.equal(snap.postseason?.status,'COMPLETE',`${year}: postseason incomplete`);
  assert.ok(snap.postseason?.championTeamId,`${year}: no champion`);
  const championTeamId=snap.postseason.championTeamId;
  snap=seasonApi.startOffseason(seasonId);
  for(let i=0;i<20&&snap.offseason?.status==='ACTIVE';i++)snap=seasonApi.advanceOffseasonPhase(seasonId);
  assert.equal(snap.offseason?.status,'COMPLETE',`${year}: offseason incomplete`);
  assert.equal(snap.seasonYear,year+1,`${year}: rollover failed`);
  assert.equal(snap.status,'REGULAR_SEASON',`${year}: opening day missing`);
  const rollover=seasonApi.serializeSeason(seasonId);
  const rolloverMeta=validateWorld(rollover,year+1,false);
  validateActiveStateMaps(rollover,year+1);
  // A rollover must publish current MLB service credit to the agent market
  // BEFORE serialization. Restoration may validate, but must not fix this value.
  for(const [id,contract] of Object.entries(rollover.contractStates??{})){
    if(contract?.baseline?.status!=="KNOWN_ZERO")continue;
    const market=rollover.contractMarketStates?.[id];
    if(!market)continue;
    const expected=Number(contract.baseline.historicalServiceDays??0)+Number(contract.simulatedServiceDays??0);
    assert.equal(market.eligibility?.serviceDays,expected,`${year+1}: market clock missing opening-day credit for ${id}`);
  }
  assert.equal(rolloverMeta.historySeasons,year-2025,`${year}: history missing/duplicated`);
  // Two consecutive restores test that current schema, records and team rosters stay stable.
  seasonApi.restoreSeason(structuredClone(rollover));
  const restored=seasonApi.serializeSeason(seasonId);
  assertCoreStable(restored,rollover,`${year}: restore mutated authoritative save`);
  seasonApi.restoreSeason(structuredClone(restored));
  assertCoreStable(seasonApi.serializeSeason(seasonId),rollover,`${year}: repeat restore drift`);
  // Export checksum is validated before any import writes; corruption must be rejected.
  const doc=createTcuExportDocument({payload:rollover,sourceSaveId:`phase8-${year}`,label:`${year} season`});
  assert.equal(parseTcuExportText(JSON.stringify(doc)).metadata.sourceSeasonId,seasonId);
  const tampered=structuredClone(doc);tampered.career.season.currentDate='2099-01-01';
  assert.throws(()=>parseTcuExportText(JSON.stringify(tampered)),/checksum/i);
  results.push({completedYear:year,worldGames:completeMeta.worldGames,postseasonChampion:championTeamId,
    activePlayers:rolloverMeta.activePlayers,historySeasons:rolloverMeta.historySeasons,
    completedSaveBytes:completeMeta.saveBytes,openingDaySaveBytes:rolloverMeta.saveBytes,
    simulationMs:Math.round(performance.now()-t0),repeatedRestoreStable:true,checksumRejectsCorruption:true});
  console.log(`Phase 8 v3 ${year}: complete world=${completeMeta.worldGames} / opening ${year+1}, restore PASS`);
}
const report={schema:'THE_CALL_UP_PHASE8_FRESH_V3_TWO_YEAR_V1',pass:true,
  source:'fresh Production v3 current main, not historical 20-year v59 baseline',
  sourceDataSha256:crypto.createHash('sha256').update(source).digest('hex'),
  seed:'phase8-current-v3-two-year',completedSeasons:2,worldGames:results.reduce((n,x)=>n+x.worldGames,0),
  initialSaveBytes:initial.saveBytes,finalSaveBytes:results.at(-1).openingDaySaveBytes,
  saveGrowthRatio:Number((results.at(-1).openingDaySaveBytes/initial.saveBytes).toFixed(3)),
  totalRuntimeMs:Math.round(performance.now()-started),replay2027:true,
  fullValidationEachBoundary:true,checksumCorruptionRejected:true,results};
mkdirSync('reports',{recursive:true});
writeFileSync('reports/phase8-fresh-v3-two-year.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:report.pass,completedSeasons:report.completedSeasons,worldGames:report.worldGames,saveGrowthRatio:report.saveGrowthRatio,runtimeMs:report.totalRuntimeMs}));
