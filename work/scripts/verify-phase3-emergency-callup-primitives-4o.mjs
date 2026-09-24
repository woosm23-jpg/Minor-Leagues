import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import {
  evaluateAaaMlbPromotion, evaluateAaaMlbEmergencyInjuryPromotion,
  evaluateAaaMlbPitcherMovement, evaluateAaaMlbEmergencyInjuryPitcherMovement
} from '../src/engine/season/promotionAI.js';
import {
  createRosterControlState, prepareAaaMlbRosterMove,
  prepareAaaMlbEmergencyInjuryMove, validateRosterControlState,
  getRosterControlPublicView
} from '../src/engine/career/rosterControlState.js';
import { executeAdjacentLevelSwap } from '../src/services/organizationRosterService.js';
import { maybeApplyInjury, advanceHealthState, healthAvailability } from '../src/engine/season/injuryState.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const REPORT=path.join(ROOT,'reports/phase3-emergency-callup-primitives-4o-v1.json');
const source=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-injury-emergency-audit-4n-v1.json'),'utf8'));
assert.equal(source.pass,true);
assert.equal(source.snapshotHash,'fnv1a32:f7b34713');
assert.equal(source.emergencyMlbCallupProbe.automaticInjuryCallupVerified,false);
const clone=x=>structuredClone(x);

function verifyDecisionPolicies(){
  const date='2026-05-15';
  const candidate={id:'AAA_H',fromLevel:'AAA',position:'SS',depthScore:90,
    seasonLine:{G:0,PA:0,OPS:0},roleState:{momentum:0,role:'STARTER'},fatigue:0,injured:false};
  const incumbent={id:'MLB_H',position:'SS',depthScore:98,
    seasonLine:{G:40,PA:160,OPS:1.100},roleState:{momentum:0,role:'STARTER'},fatigue:0,injured:true};
  const baseline=evaluateAaaMlbPromotion({date,candidate,incumbent});
  assert.equal(baseline.decision,'HOLD','ordinary injured-incumbent evaluation must stay unchanged');
  assert.equal(baseline.injuryBlocked,true);
  const emergency=evaluateAaaMlbEmergencyInjuryPromotion({date,candidate,incumbent});
  assert.equal(emergency.decision,'PROMOTE','healthy MLB-ready hitter was blocked by incumbent injury');
  assert.equal(emergency.incumbentDecision,'INJURED_LIST');
  assert.equal(emergency.sampleReady,false,'emergency case must not fabricate a normal AAA sample');
  assert.equal(emergency.emergencyReason,'EMERGENCY_MLB_INJURY_COVER');
  assert.equal(evaluateAaaMlbEmergencyInjuryPromotion({date,candidate:{...candidate,injured:true},incumbent}).decision,'HOLD');
  assert.equal(evaluateAaaMlbEmergencyInjuryPromotion({date,candidate:{...candidate,fatigue:80},incumbent}).decision,'HOLD');
  assert.equal(evaluateAaaMlbEmergencyInjuryPromotion({date,candidate:{...candidate,depthScore:0},incumbent}).decision,'HOLD');
  assert.equal(evaluateAaaMlbEmergencyInjuryPromotion({date,candidate,incumbent:{...incumbent,injured:false}}).decision,'HOLD');

  const pc={id:'AAA_P',position:'SP',depthScore:90,seasonLine:{BF:0,outsRecorded:0},pitcherState:{fatigue:0},injured:false};
  const pi={id:'MLB_P',position:'SP',depthScore:96,seasonLine:{BF:120,outsRecorded:90},pitcherState:{fatigue:0},injured:true};
  const ordinaryPitcher=evaluateAaaMlbPitcherMovement({date,role:'SP',candidate:pc,incumbent:pi});
  assert.equal(ordinaryPitcher.decision,'HOLD');
  const pitcher=evaluateAaaMlbEmergencyInjuryPitcherMovement({date,role:'SP',candidate:pc,incumbent:pi});
  assert.equal(pitcher.decision,'PROMOTE');
  assert.equal(pitcher.incumbentDecision,'INJURED_LIST');
  assert.equal(pitcher.sampleReady,false);
  assert.equal(evaluateAaaMlbEmergencyInjuryPitcherMovement({date,role:'SP',candidate:{...pc,injured:true},incumbent:pi}).decision,'HOLD');
  assert.equal(evaluateAaaMlbEmergencyInjuryPitcherMovement({date,role:'SP',candidate:{...pc,pitcherState:{fatigue:100}},incumbent:pi}).decision,'HOLD');
  assert.equal(evaluateAaaMlbEmergencyInjuryPitcherMovement({date,role:'SP',candidate:pc,incumbent:{...pi,injured:false}}).decision,'HOLD');
  return {ordinaryHitterStillBlocked:true,healthyEmergencyHitterAllowed:true,
    unreadyOrInjuredCandidatesRejected:true,emergencyPitcherAllowed:true,
    insufficientNormalSampleNotInvented:true};
}

function verifyRosterConstraints(){
  const date='2026-04-15',organizationId='probe';
  const incumbent=createRosterControlState({playerId:'MLB',startDate:date,initialLevel:'MLB'});
  const injuredOutOfOptions={...incumbent,option:{...incumbent.option,yearsUsed:3,remaining:0}};
  validateRosterControlState(injuredOutOfOptions);
  const aaa=createRosterControlState({playerId:'AAA',startDate:date,initialLevel:'AAA'});
  const pair={states:{MLB:injuredOutOfOptions,AAA:aaa},candidateId:'AAA',incumbentId:'MLB',date,organizationId,organizationPlayerIds:['MLB','AAA']};
  const ordinary=prepareAaaMlbRosterMove(pair);
  assert.equal(ordinary.allowed,false,'out-of-options ordinary demotion must remain blocked');
  const emergency=prepareAaaMlbEmergencyInjuryMove(pair);
  assert.equal(emergency.allowed,true,'injured list must preserve the incumbent option year');
  assert.equal(emergency.states.MLB.on40Man,true);
  assert.equal(emergency.states.MLB.assignmentStatus,'MLB_INJURED_LIST');
  assert.equal(emergency.states.MLB.option.remaining,0);
  assert.equal(emergency.states.MLB.option.assignmentsThisSeason,0);
  assert.equal(emergency.states.AAA.assignmentStatus,'MLB_ACTIVE');
  validateRosterControlState(emergency.states.MLB);
  assert.equal(getRosterControlPublicView(emergency.states.MLB).assignmentStatus,'MLB_INJURED_LIST');
  assert.equal(pair.states.MLB.assignmentStatus,'MLB_ACTIVE','the input roster-control state was mutated');
  const withFullForty={...pair.states};
  const organizationPlayerIds=[];
  for(let i=0;i<39;i++){
    const id=`P_${i}`;
    withFullForty[id]=createRosterControlState({playerId:id,startDate:date,initialLevel:'MLB'});
    organizationPlayerIds.push(id);
  }
  organizationPlayerIds.push('MLB','AAA');
  const blocked=prepareAaaMlbEmergencyInjuryMove({...pair,states:withFullForty,organizationPlayerIds});
  assert.equal(blocked.allowed,false,'emergency coverage improperly created a 41st 40-man member');
  assert.equal(blocked.blockCode,'FORTY_MAN_FULL');
  assert.deepEqual(blocked.states,withFullForty);
  return {outOfOptionsInjuredIncumbentPreserved:true,fortyManLimitEnforced:true,
    injuredListStatusValidated:true,noInputMutation:true};
}

function verifyRealProductionMovement(){
  const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz'))).toString('utf8'));
  assert.equal(snapshot.metadata.contentHash,source.snapshotHash);
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot}).organizations[0];
  const input={name:'4O QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,
    bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',
    visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  const start=seasonApi.createCareerSeason({seed:'phase3-4o-emergency-coverage',input,masterSnapshot:snapshot});
  const sessionId=start.seasonId,opening=seasonApi.serializeSeason(sessionId);
  assert.equal(validateSeasonSavePayload(opening,{mode:'FULL'}),true);
  const levels=opening.fixture.organization.levels;
  const date=opening.fixture.startDate;
  let chosen=null;
  for(const position of ['SS','CF','2B','3B','LF','RF','1B','C','DH']){
    const candidateId=levels.AAA.roster.lineupSlots.find(x=>x.position===position)?.starterId;
    const incumbentId=levels.MLB.roster.lineupSlots.find(x=>x.position===position)?.starterId;
    if(!candidateId||!incumbentId||candidateId===incumbentId)continue;
    if(!opening.playerStates[incumbentId]?.health)continue;
    const check=prepareAaaMlbEmergencyInjuryMove({states:opening.rosterControlStates,
      candidateId,incumbentId,date,organizationId:String(opening.fixture.organization.id),
      organizationPlayerIds:opening.fixture.organization.levelOrder.flatMap(l=>Object.keys(levels[l].roster.players))});
    if(check.allowed){chosen={position,candidateId,incumbentId,prep:check};break;}
  }
  assert.ok(chosen,'no legally eligible real AAA/MLB pair for an emergency replacement');
  const {position,candidateId,incumbentId,prep}=chosen;
  const injuredPlayer=levels.MLB.roster.players[incumbentId];
  const forced=maybeApplyInjury(opening.playerStates[incumbentId].health,injuredPlayer,{
    seed:'phase3-4o-forced',date,kind:'POSITION',activity:'POSITION_START',
    force:{family:'LOWER_BODY',severity:'MODERATE',days:21}
  });
  assert.ok(forced.event);
  const moved=executeAdjacentLevelSwap({fixture:opening.fixture,roleStates:opening.roleStates,
    fromLevel:'AAA',toLevel:'MLB',position,promotePlayerId:candidateId,demotePlayerId:incumbentId,date,
    promoteReasonCodes:['EMERGENCY_MLB_INJURY_COVER',...prep.candidateReasonCodes],
    demoteReasonCodes:['MLB_INJURED_LIST',...prep.incumbentReasonCodes]});
  assert.equal(moved.fixture.organization.levels.MLB.roster.players[candidateId]?.id,candidateId);
  assert.equal(moved.fixture.organization.levels.AAA.roster.players[incumbentId]?.id,incumbentId);
  assert.equal(Boolean(moved.fixture.organization.levels.MLB.roster.players[incumbentId]),false);
  assert.equal(Boolean(moved.fixture.organization.levels.AAA.roster.players[candidateId]),false);
  assert.equal(moved.events.length,2);
  assert.equal(moved.events[0].type,'PLAYER_PROMOTED');
  const affected=clone(opening);
  affected.fixture=moved.fixture;
  affected.roleStates=moved.roleStates;
  affected.rosterControlStates=prep.states;
  affected.playerStates={...opening.playerStates,
    [incumbentId]:{...opening.playerStates[incumbentId],health:forced.health}};
  assert.equal(validateSeasonSavePayload(affected,{mode:'FULL'}),true,'real injured reserve + replacement save invalid');
  seasonApi.restoreSeason(affected);
  const restored=seasonApi.serializeSeason(sessionId);
  assert.equal(validateSeasonSavePayload(restored,{mode:'FULL'}),true);
  assert.equal(restored.rosterControlStates[incumbentId].assignmentStatus,'MLB_INJURED_LIST');
  assert.equal(restored.rosterControlStates[incumbentId].option.assignmentsThisSeason,opening.rosterControlStates[incumbentId].option.assignmentsThisSeason);
  assert.equal(restored.fixture.organization.levels.MLB.roster.players[candidateId]?.id,candidateId);
  assert.equal(restored.fixture.organization.levels.AAA.roster.players[incumbentId]?.id,incumbentId);
  assert.deepEqual(restored.playerStates[incumbentId].health,forced.health);
  assert.equal(healthAvailability(advanceHealthState(restored.playerStates[incumbentId].health,21)),'AVAILABLE');
  return {position,candidateId,injuredIncumbentId:incumbentId,
    injuredStatus:restored.rosterControlStates[incumbentId].assignmentStatus,
    replacementStatus:restored.rosterControlStates[candidateId].assignmentStatus,
    fullSaveRestore:true,injuredIncumbentRetainedOn40Man:true,injuredIncumbentOptionsUnchanged:true,
    affiliateAndMlbRostersAtomic:true,autoReturnImplemented:false};
}

function main(){
  const policy=verifyDecisionPolicies();
  const constraints=verifyRosterConstraints();
  const production=verifyRealProductionMovement();
  const report={schema:'THE_CALL_UP_PHASE3_EMERGENCY_CALLOUT_PRIMITIVES_4O_V1',pass:true,
    mode:'EXPLICIT_EMERGENCY_POLICY_AND_IN_MEMORY_ROSTER_TRANSACTION',snapshotHash:source.snapshotHash,
    policy,constraints,production,
    gates:{prior4nAuditPass:true,normalPromotionBehaviorUnchanged:true,emergencyHitterAndPitcherReady:true,
      injuredListPreservesFortyManAndOptions:true,realProductionAffiliateSwapAndFullRestore:true},
    pending:{automaticInjuryTrigger:false,automaticReturnFromInjuredList:false,
      injuryListMlbServiceClock:false,normalSeasonGameplayUsesNewPath:false},
    note:'4O adds opt-in emergency decision and legal injured-list roster transaction primitives. It does not yet turn on automatic MLB call-ups, IL returns or IL-service credit; those require the 4P scheduler/return gate.'};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({schema:report.schema,pass:report.pass,policy,constraints,production,gates:report.gates,pending:report.pending},null,2));
}
try{main();}catch(e){console.error(e);process.exitCode=1;}
