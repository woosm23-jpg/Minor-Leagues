import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { applyPositionPlayerGame } from '../src/engine/season/playerSeasonState.js';
import { getUtilityCoverage, getUtilityPathwayView, UTILITY_FAMILIARITY_THRESHOLD } from '../src/engine/season/utilityUsage.js';
import {
  evaluateAaaMlbPromotion, evaluateMinorLevelPromotion,
  evaluateAaaMlbPitcherMovement, evaluateMinorLevelPitcherMovement,
  evaluateAaaMlbEmergencyInjuryPromotion, evaluateAaaMlbEmergencyInjuryPitcherMovement
} from '../src/engine/season/promotionAI.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REPORT=path.join(ROOT,'reports/phase3-scouting-position-audit-4q-v1.json');
const SNAP=path.join(ROOT,'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const clone=x=>structuredClone(x);
const full=(p,label)=>assert.equal(validateSeasonSavePayload(p,{mode:'FULL'}),true,label);
const hiddenKeys=['hiddenDevelopmentTrait','reachableProjection','ceilings','randomKey','hiddenDevelopmentPrior'];
function assertNoInternalFields(object,label){
  const raw=JSON.stringify(object);
  for(const key of hiddenKeys) assert.ok(!raw.includes(`"${key}"`),`${label} leaks ${key}`);
}
function assertRange(report,label){
  assert.ok(report,`${label} missing`);
  assert.ok(['LOW','FAIR','GOOD','HIGH'].includes(report.confidence),`${label} confidence invalid`);
  assert.ok(Number.isFinite(report.futureValue),`${label} FV invalid`);
  assert.ok(report.futureValueRange?.low<=report.futureValue && report.futureValue<=report.futureValueRange?.high,`${label} FV range excludes grade`);
  assertNoInternalFields(report,label);
}
function verifyPromotionIgnoresHiddenPotential(){
  const candidate={id:'AAA_H',fromLevel:'AAA',position:'SS',depthScore:87,
    seasonLine:{G:18,PA:77,AB:65,H:24,BB:9,OPS:0.980},roleState:{role:'STARTER',momentum:0.1},fatigue:7,injured:false};
  const incumbent={id:'MLB_H',position:'SS',depthScore:51,
    seasonLine:{G:18,PA:77,AB:65,H:12,BB:7,OPS:0.590},roleState:{role:'STARTER',momentum:0},fatigue:8,injured:false};
  const pc={id:'AAA_P',position:'SP',depthScore:85,
    seasonLine:{G:8,BF:177,outsRecorded:125,H:33,BB:12,SO:43,R:17},pitcherState:{fatigue:8},injured:false};
  const pi={id:'MLB_P',position:'SP',depthScore:58,
    seasonLine:{G:8,BF:177,outsRecorded:125,H:57,BB:26,SO:20,R:34},pitcherState:{fatigue:8},injured:false};
  const positionArgs={date:'2026-05-15',candidate,incumbent};
  const pitcherArgs={date:'2026-05-15',role:'SP',candidate:pc,incumbent:pi};
  const altered=(row)=>({...row,hiddenDevelopmentTrait:'BREAKOUT',
    hiddenPotential:{ceiling:99,reachableProjection:99},
    development:{ceilings:{contact:99,power:99},reachableProjection:{contact:99,power:99}}});
  const rows=[
    ['AAA_MLB_HITTER',()=>evaluateAaaMlbPromotion(positionArgs),()=>evaluateAaaMlbPromotion({...positionArgs,candidate:altered(candidate),incumbent:altered(incumbent)})],
    ['A_HIGH_A_HITTER',()=>evaluateMinorLevelPromotion({...positionArgs,fromLevel:'A',toLevel:'HIGH_A'}),()=>evaluateMinorLevelPromotion({...positionArgs,fromLevel:'A',toLevel:'HIGH_A',candidate:altered(candidate),incumbent:altered(incumbent)})],
    ['AAA_MLB_PITCHER',()=>evaluateAaaMlbPitcherMovement(pitcherArgs),()=>evaluateAaaMlbPitcherMovement({...pitcherArgs,candidate:altered(pc),incumbent:altered(pi)})],
    ['AA_AAA_PITCHER',()=>evaluateMinorLevelPitcherMovement({...pitcherArgs,fromLevel:'AA',toLevel:'AAA'}),()=>evaluateMinorLevelPitcherMovement({...pitcherArgs,fromLevel:'AA',toLevel:'AAA',candidate:altered(pc),incumbent:altered(pi)})],
    ['EMERGENCY_HITTER',()=>evaluateAaaMlbEmergencyInjuryPromotion({...positionArgs,incumbent:{...incumbent,injured:true}}),()=>evaluateAaaMlbEmergencyInjuryPromotion({...positionArgs,candidate:altered(candidate),incumbent:altered({...incumbent,injured:true})})],
    ['EMERGENCY_PITCHER',()=>evaluateAaaMlbEmergencyInjuryPitcherMovement({...pitcherArgs,incumbent:{...pi,injured:true}}),()=>evaluateAaaMlbEmergencyInjuryPitcherMovement({...pitcherArgs,candidate:altered(pc),incumbent:altered({...pi,injured:true})})]
  ];
  return rows.map(([kind,normal,mutated])=>{
    const expected=normal();
    assert.deepEqual(mutated(),expected,`${kind} evaluated hidden potential`);
    return {kind,decision:expected.decision,hiddenPotentialIgnored:true};
  });
}

function main(){
  const fourM=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-development-promotion-audit-4m-v1.json'),'utf8'));
  const fourP=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-automatic-injury-callup-4p-v1.json'),'utf8'));
  assert.equal(fourM.pass,true,'4M baseline missing');
  assert.equal(fourP.pass,true,'4P baseline missing');
  assert.equal(fourP.gates.automaticInjuryTrigger,true);
  assert.equal(fourP.gates.automaticReturn,true);
  assert.equal(fourM.snapshotHash,fourP.snapshotHash);
  const policies=verifyPromotionIgnoresHiddenPotential();
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8'));
  assert.equal(master.metadata.contentHash,fourP.snapshotHash);
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4Q QA',nationality:'대한민국',hometown:'구미',age:18,
    heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',
    primaryPosition:'SS',archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],
    organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let snapshot=seasonApi.createCareerSeason({seed:'phase3-4q-scouting-position',input,masterSnapshot:master});
  const seasonId=snapshot.seasonId;
  const opening=seasonApi.serializeSeason(seasonId);full(opening,'opening FULL save invalid');
  assert.equal(opening.fixture.worldMode,'PRODUCTION_REAL');
  assert.equal(opening.fixture.organization.userLevel,'A');
  const userId=opening.fixture.userPlayerId;
  const roster=opening.fixture.organization.levels.A.roster;
  const player=roster.players[userId];
  const original=opening.playerStates[userId];
  assert.ok(player && original?.development,'production user missing from A roster');
  const detail=seasonApi.getPlayerDetail(seasonId,userId);
  assertRange(detail.scouting,'production user scouting');
  assertNoInternalFields(detail,'production public player detail');
  assert.ok(!JSON.stringify(detail).includes('"adaptability"'),'hidden adaptability exposed');
  assert.ok(snapshot.organization.prospectRankings.length>0,'production prospect rankings missing');
  for(const row of snapshot.organization.prospectRankings){
    assertRange(row,`prospect ${row.id}`);
    assert.ok(['LOW','FAIR','GOOD','HIGH'].includes(row.futureConfidence),`prospect ${row.id} future confidence invalid`);
  }
  const prospectCount=snapshot.organization.prospectRankings.length;
  const position=original.primaryPosition;
  const secondary=['LF','RF','2B','3B','CF','SS','1B'].find(p=>p!==position && !(roster.bench??[]).find(x=>x.playerId===userId)?.coverage?.includes(p));
  assert.ok(secondary,'no distinct secondary position available for test');
  const near=UTILITY_FAMILIARITY_THRESHOLD-0.001;
  const testState={...original,positionFamiliarity:{...original.positionFamiliarity,[secondary]:near},
    positionReps:{...original.positionReps,[secondary]:0}};
  const beforeCoverage=getUtilityCoverage(roster,{...opening.playerStates,[userId]:testState},opening.roleStates,userId);
  assert.ok(!beforeCoverage.includes(secondary),'unplayed below-threshold position already eligible');
  const played=applyPositionPlayerGame(testState,player,{
    battingLine:{G:1,PA:4,AB:4,H:1,BB:0,HBP:0,SO:1,TB:1,HR:0},
    position:secondary,date:opening.fixture.startDate,appearanceType:'START',level:'A'
  });
  assert.equal(played.positionReps[secondary],1,'secondary position rep not credited');
  assert.ok(played.positionFamiliarity[secondary]>UTILITY_FAMILIARITY_THRESHOLD,'secondary familiarity did not cross threshold');
  const updatedStates={...opening.playerStates,[userId]:played};
  const afterCoverage=getUtilityCoverage(roster,updatedStates,opening.roleStates,userId);
  assert.ok(afterCoverage.includes(secondary),'secondary position not available after actual rep');
  const pathway=getUtilityPathwayView(roster,updatedStates,opening.roleStates,userId);
  assert.equal(pathway.positions.find(row=>row.position===secondary)?.status,'READY');
  const trained=clone(opening);trained.playerStates[userId]=played;
  full(trained,'trained FULL save invalid');
  snapshot=seasonApi.restoreSeason(clone(trained));
  const restored=seasonApi.serializeSeason(seasonId);full(restored,'trained restore invalid');
  assert.deepEqual(restored.playerStates[userId].positionReps,played.positionReps,'secondary reps lost on save/restore');
  assert.deepEqual(restored.playerStates[userId].positionFamiliarity,played.positionFamiliarity,'secondary familiarity lost on save/restore');
  assert.deepEqual(restored.fixture.organization,opening.fixture.organization,'position training changed team rosters');
  assert.equal(seasonApi.getPlayerDetail(seasonId,userId).utilityPathway.positions.find(row=>row.position===secondary)?.status,'READY');
  assertNoInternalFields(seasonApi.getPlayerDetail(seasonId,userId),'trained public player detail');

  // Compare full, real-organization review outputs after changing ONLY hidden
  // future ceilings/projections. The public scouting estimate may legitimately
  // change, but promotion and roster decisions must depend on current ability.
  seasonApi.restoreSeason(clone(opening));
  seasonApi.runOrganizationReview(seasonId,{force:true});
  const baseReview=seasonApi.serializeSeason(seasonId);
  const evaluations=baseReview.organizationState?.latestEvaluations??{};
  assert.ok(Object.keys(evaluations).length>0,'real organization review produced no evaluations');
  const altered=clone(opening);
  const u=altered.playerStates[userId];
  const ceilings={...u.development.ceilings,contact:99};
  const projection={...u.development.reachableProjection,contact:99};
  altered.playerStates[userId]={...u,development:{...u.development,
    ceilings,reachableProjection:projection,
    hiddenTrait:u.development.hiddenTrait==='LATE_BLOOMER'?'EARLY_DEVELOPER':'LATE_BLOOMER'}};
  full(altered,'hidden-potential counterfactual invalid');
  seasonApi.restoreSeason(altered);
  seasonApi.runOrganizationReview(seasonId,{force:true});
  const alteredReview=seasonApi.serializeSeason(seasonId);
  assert.deepEqual(alteredReview.organizationState.latestEvaluations,evaluations,
    'hidden future ceiling changed real-world promotion evaluation');
  assert.deepEqual(alteredReview.organizationState.transactions,baseReview.organizationState.transactions,
    'hidden future ceiling changed roster transactions');
  assert.equal(alteredReview.fixture.organization.userLevel,baseReview.fixture.organization.userLevel,
    'hidden future ceiling changed user assignment');
  const report={schema:'THE_CALL_UP_PHASE3_SCOUTING_POSITION_AUDIT_4Q_V1',pass:true,
    mode:'READ_ONLY_PRODUCTION_V3_PLUS_ENGINE_COUNTERFACTUAL',snapshotHash:fourP.snapshotHash,
    prerequisites:{developmentPromotion4M:true,automaticInjuryCallup4P:true},
    promotion:{hiddenPotentialInvariancePolicies:policies,realOrganizationEvaluationCount:Object.keys(evaluations).length,
      realReviewHiddenCeilingInvariant:true,realRosterTransactionsInvariant:true},
    scouting:{productionProspectCount:prospectCount,confidenceAndFvRangesValid:true,
      publicDetailNoHiddenInternalFields:true,prospectNoHiddenInternalFields:true},
    position:{playerId:userId,primaryPosition:position,trainedSecondaryPosition:secondary,
      threshold:UTILITY_FAMILIARITY_THRESHOLD,beforeFamiliarity:near,
      afterFamiliarity:played.positionFamiliarity[secondary],reps:played.positionReps[secondary],
      beforeEligible:false,afterEligible:true,saveRestoreSame:true},
    scope:{gameplaySourceUnchanged:true,scoutingMayRespondToPotentialEvidence:true,
      hiddenCeilingDoesNotControlPromotion:true,automaticInjuryRegressionCoveredByPrior4P:true}};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
