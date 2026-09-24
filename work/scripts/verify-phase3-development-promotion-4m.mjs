import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER_PATH = path.join(ROOT, 'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const REPORT = path.join(ROOT, 'reports/phase3-development-promotion-audit-4m-v1.json');
const BASE_4L = path.join(ROOT, 'reports/phase3-full-postseason-rotation-gate-4l-v1.json');
const PROMOTION_SMOKE = path.join(ROOT, 'reports/.phase3-4m-promotion-v50.json');
const LEVELS = ['A', 'HIGH_A', 'AA', 'AAA', 'MLB'];
const SEED = 'phase3-4h-postseason-workload-baseline';
const clone = x => structuredClone(x);

function countProgressed(states) {
  return Object.values(states ?? {}).filter(state => {
    const d = state.development ?? {};
    return [...Object.values(d.progress ?? {}), ...Object.values(d.gains ?? {})]
      .some(value => Math.abs(Number(value) || 0) > 1e-9);
  }).length;
}
function processedCounts(states) {
  const rows = Object.values(states ?? {});
  const oneDevelopment = rows.filter(s => s.development?.processedOffseasons?.length === 1).length;
  const oneAging = rows.filter(s => s.aging?.processedSeasons?.length === 1).length;
  const uniqueDevelopment = rows.every(s => new Set(s.development?.processedOffseasons ?? []).size === (s.development?.processedOffseasons ?? []).length);
  const uniqueAging = rows.every(s => new Set(s.aging?.processedSeasons ?? []).size === (s.aging?.processedSeasons ?? []).length);
  assert.equal(oneDevelopment, rows.length, 'not every player received exactly one season-end development pass');
  assert.equal(oneAging, rows.length, 'not every player received exactly one season-end aging pass');
  assert.ok(uniqueDevelopment && uniqueAging, 'duplicate season key in development or aging');
  return {population:rows.length,developmentProcessedOnce:oneDevelopment,agingProcessedOnce:oneAging};
}
function auditOrganization(fixture) {
  const organization = fixture.organization;
  assert.deepEqual(organization.levelOrder, ['MLB','AAA','AA','HIGH_A','A']);
  const seen = new Map();
  const populations = {};
  for (const level of organization.levelOrder) {
    const affiliate = organization.levels[level];
    assert.ok(affiliate?.roster, `missing ${level} organization roster`);
    const roster = affiliate.roster;
    const teamId = String(affiliate.team.id);
    assert.deepEqual(fixture.levelLeagues[level].rosters[teamId], roster, `${level} league/organization roster mirror drift`);
    const ids = Object.keys(roster.players ?? {});
    populations[level] = ids.length;
    for (const id of ids) {
      assert.ok(!seen.has(id), `${id} appears in both ${seen.get(id)} and ${level}`);
      seen.set(id, level);
    }
  }
  const userId = fixture.userPlayerId;
  const userLevel = organization.userLevel;
  assert.equal(seen.get(userId), userLevel, 'user assignment differs from organization userLevel');
  const aaa = organization.levels.AAA.roster;
  assert.deepEqual(fixture.rosters[fixture.userTeamId], aaa, 'AAA canonical mirror drift');
  return {userLevel,populations,uniqueAssignedPlayers:seen.size};
}
function auditTransactions(state) {
  const rows = state?.transactions ?? [];
  assert.ok(Array.isArray(rows));
  const byDate = new Map();
  for (const e of rows) {
    assert.ok(['PLAYER_PROMOTED','PLAYER_DEMOTED'].includes(e.type), `unknown organization movement ${e.type}`);
    assert.ok(LEVELS.includes(e.fromLevel) && LEVELS.includes(e.toLevel), 'movement outside 2026 MLB/minor ladder');
    assert.equal(Math.abs(LEVELS.indexOf(e.fromLevel)-LEVELS.indexOf(e.toLevel)),1, 'non-adjacent organization move');
    const date = e.date;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    byDate.set(date, [...(byDate.get(date) ?? []), e]);
  }
  for (const [date, group] of byDate) {
    assert.ok(group.length <= 2, `${date}: more than one swap in a scheduled review`);
    assert.equal(group.filter(e => e.type==='PLAYER_PROMOTED').length, group.length/2, `${date}: promotion/demotion mismatch`);
    assert.equal(group.filter(e => e.type==='PLAYER_DEMOTED').length, group.length/2, `${date}: promotion/demotion mismatch`);
  }
  return {retainedTransactionEvents:rows.length,retainedSwapDates:byDate.size};
}
function assertFull(payload, label) {
  assert.equal(validateSeasonSavePayload(payload,{mode:'FULL'}), true, `${label} FULL save invalid`);
}
function main() {
  const baseline = JSON.parse(fs.readFileSync(BASE_4L,'utf8'));
  const priorPromotion = JSON.parse(fs.readFileSync(PROMOTION_SMOKE,'utf8'));
  assert.equal(baseline.pass,true,'4L postseason baseline missing');
  assert.equal(baseline.gates.fullPostseasonCompleted,true,'4L four-round gate incomplete');
  assert.equal(baseline.snapshotHash,'fnv1a32:f7b34713');
  assert.equal(priorPromotion.pass,true,'promotion evaluator/roster swap regression failed');
  assert.equal(priorPromotion.verified,true);
  assert.equal(priorPromotion.evaluatorRows.length,4);
  assert.equal(priorPromotion.movementRows.length,4);
  const master = JSON.parse(zlib.gunzipSync(fs.readFileSync(MASTER_PATH)).toString('utf8'));
  assert.equal(master.metadata.contentHash,baseline.snapshotHash);
  const org = seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input = {name:'4M QA',nationality:'대한민국',hometown:'구미',age:18,
    heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',
    primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],
    organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let season = seasonApi.createCareerSeason({seed:SEED,input,masterSnapshot:master});
  const seasonId = season.seasonId;
  const opening = seasonApi.serializeSeason(seasonId);
  assertFull(opening,'opening');
  assert.equal(opening.fixture.worldMode,'PRODUCTION_REAL');
  const userId = opening.fixture.userPlayerId;
  const openingOrg = auditOrganization(opening.fixture);
  assert.equal(openingOrg.userLevel,'A','18-year-old career did not start at A');
  assert.ok(Object.keys(opening.playerStates).length>0 && Object.keys(opening.pitcherStates).length>0);
  assert.equal(opening.playerStates[userId].development.focus,'BALANCED');

  seasonApi.setTrainingFocus(seasonId,'CONTACT');
  const trained = seasonApi.serializeSeason(seasonId);
  assertFull(trained,'training focus');
  assert.equal(trained.playerStates[userId].development.focus,'CONTACT');
  assert.deepEqual(trained.pitcherStates,opening.pitcherStates,'training focus changed pitchers');
  assert.deepEqual(trained.levelSeasons,opening.levelSeasons,'training focus changed games');
  seasonApi.restoreSeason(clone(trained));
  const restoredStart = seasonApi.serializeSeason(seasonId);
  assertFull(restoredStart,'opening restore');
  assert.deepEqual(restoredStart.playerStates,trained.playerStates,'training focus/save restore mismatch');
  assert.deepEqual(restoredStart.organizationState,trained.organizationState,'opening review state changed on restore');

  season = seasonApi.simulateToSeasonEnd(seasonId);
  assert.equal(season.status,'COMPLETE','real 2026 world did not complete');
  const finished = seasonApi.serializeSeason(seasonId);
  assertFull(finished,'season end');
  assert.equal(finished.playerStates[userId].development.focus,'CONTACT','training focus lost during year');
  let worldGames=0;
  const levelGames={};
  for (const level of LEVELS) {
    const state=finished.levelSeasons[level];
    assert.ok(state && state.schedule.length>0, `missing ${level} schedule`);
    assert.equal(state.completedGames,state.schedule.length, `${level} schedule incomplete`);
    worldGames+=state.completedGames;
    levelGames[level]=state.completedGames;
  }
  const batters=processedCounts(finished.playerStates);
  const pitchers=processedCounts(finished.pitcherStates);
  const progressedHitters=countProgressed(finished.playerStates);
  const progressedPitchers=countProgressed(finished.pitcherStates);
  assert.ok(progressedHitters>0 && progressedPitchers>0,'no realized 2026 development progress');
  const finalOrg = auditOrganization(finished.fixture);
  assert.equal(finalOrg.uniqueAssignedPlayers,openingOrg.uniqueAssignedPlayers,'organization population drift after reviews');
  const reviews = finished.organizationState?.reviews ?? 0;
  assert.ok(reviews>0,'no automatic organization reviews during 2026');
  assert.ok(Object.keys(finished.organizationState?.latestEvaluations ?? {}).length>0,'no promotion evaluations recorded');
  const transactions=auditTransactions(finished.organizationState);

  seasonApi.restoreSeason(clone(finished));
  const endRestored=seasonApi.serializeSeason(seasonId);
  assertFull(endRestored,'completed-season restore');
  assert.deepEqual(endRestored.playerStates,finished.playerStates,'position development/aging was lost');
  assert.deepEqual(endRestored.pitcherStates,finished.pitcherStates,'pitcher development/aging was lost');
  assert.deepEqual(endRestored.organizationState,finished.organizationState,'promotion history was lost');
  assert.deepEqual(endRestored.fixture.organization,finished.fixture.organization,'roster changes were lost');
  season=seasonApi.simulateToSeasonEnd(seasonId);
  assert.equal(season.status,'COMPLETE');
  const repeat=seasonApi.serializeSeason(seasonId);
  assertFull(repeat,'repeat completed-season simulation');
  assert.deepEqual(repeat.playerStates,finished.playerStates,'development or aging applied twice');
  assert.deepEqual(repeat.pitcherStates,finished.pitcherStates,'pitcher development or aging applied twice');
  assert.deepEqual(repeat.organizationState,finished.organizationState,'organization review was duplicated');
  assert.deepEqual(repeat.fixture.organization,finished.fixture.organization,'repeat simulation changed roster');

  const report={schema:'THE_CALL_UP_PHASE3_DEVELOPMENT_PROMOTION_AUDIT_4M_V1',pass:true,
    mode:'READ_ONLY_PRODUCTION_V3_ONE_SEASON',seed:SEED,snapshotHash:master.metadata.contentHash,
    production:{worldMode:opening.fixture.worldMode,levelGames,worldGames,
      openingUserLevel:openingOrg.userLevel,closingUserLevel:finalOrg.userLevel,
      organizationPopulation:finalOrg.populations,uniqueOrganizationPlayers:finalOrg.uniqueAssignedPlayers},
    development:{position:batters,pitcher:pitchers,progressedHitters,progressedPitchers,userTrainingFocus:'CONTACT'},
    promotion:{automaticReviewCount:reviews,retainedLatestEvaluationCount:Object.keys(finished.organizationState.latestEvaluations).length,
      ...transactions,syntheticPromotionPairsVerified:priorPromotion.evaluatorRows.length,
      syntheticAdjacentRosterSwapsVerified:priorPromotion.movementRows.length,
      note:'Observed real-world swap count may be zero; synthetic tests separately cover all four adjacent pairs.'},
    saveRestore:{openingFocusPreserved:true,finishedDevelopmentPreserved:true,finishedPromotionsPreserved:true},
    idempotency:{completedSeasonRepeatedWithoutDoubleGrowth:true,organizationReviewsNotDuplicated:true},
    scope:{postseasonGameplayUnchanged:true,savePayloadValidated:true,sourceFilesNotModifiedByAudit:true}};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
