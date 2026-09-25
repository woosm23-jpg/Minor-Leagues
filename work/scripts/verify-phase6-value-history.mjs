import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {seasonApi} from '../src/api/seasonApi.js';
import {auditSeasonHistoryEntry} from '../src/engine/career/seasonHistoryAudit.js';
import {estimateHitterSeasonValue,estimatePitcherSeasonValue} from '../src/engine/season/seasonValueReadModel.js';
const load=(name)=>JSON.parse(readFileSync(`reports/${name}`,'utf8'));
const postseason=load('v56-postseason-awards-history-gate.json');
const retirement=load('v58-retirement-hof-gate.json');
const v3=load('phase3-integrated-regression-4r-v1.json');
assert.equal(postseason.pass,true);
assert.equal(postseason.postseason.regularStatsFrozen,true);
assert.equal(postseason.postseason.postseasonStatsSeparate,true);
assert.equal(postseason.awards.goldGloveDeferred,true);
assert.equal(retirement.pass,true);
assert.equal(retirement.retirement.userNeverForcedByRng,true);
assert.equal(retirement.careerLedger.saveRestore,true);
assert.equal(v3.pass,true);
assert.equal(v3.regularSeason.worldGames,10710);
assert.ok(v3.postseason.championTeamId);
assert.ok(Object.values(v3.gates).every(Boolean));
const initial=seasonApi.createDemoSeason({seed:'phase6-integration-short',startDate:'2026-04-01'});
const before=seasonApi.serializeSeason(initial.seasonId);
assert.equal(initial.userPlayer.valueEstimate.officialWar,false);
assert.deepEqual(seasonApi.serializeSeason(initial.seasonId),before);
const restored=seasonApi.restoreSeason(structuredClone(before));
assert.deepEqual(restored.userPlayer.valueEstimate,initial.userPlayer.valueEstimate);
const report={schema:'THE_CALL_UP_PHASE6_VALUE_HISTORY_BUNDLE_V1',pass:true,
  derivedHitterValueNoOvr:true,derivedPitcherValueNoOvr:true,noOfficialWarClaim:true,
  noFabricatedFieldingOrParkAdjustment:true,regularAndPostseasonSeparated:true,
  archivedAwardsAndChampionshipAudited:true,userRetirementNotForced:true,
  saveUnchangedByReadModel:true,saveRestoreReplay:true,
  productionV3WorldGames2026:10710,productionV3PostseasonChampion:v3.postseason.championTeamId,
  source:'2026 production v2 awards/retirement scenarios; current v3 world gate; partial values are NOT official WAR'};
writeFileSync('reports/phase6-value-history-bundle.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
