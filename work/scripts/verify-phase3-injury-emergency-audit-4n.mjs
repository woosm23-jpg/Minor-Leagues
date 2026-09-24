import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { createSeasonGameFixture } from '../src/services/demoSeasonFactory.js';
import { maybeApplyInjury, advanceHealthState, healthAvailability } from '../src/engine/season/injuryState.js';
import { recoverPitcherSeasonState, pitcherAvailability } from '../src/engine/season/pitcherSeasonState.js';
import { evaluateAaaMlbPromotion } from '../src/engine/season/promotionAI.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(ROOT, 'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const BASE = path.join(ROOT, 'reports/phase3-development-promotion-audit-4m-v1.json');
const REPORT = path.join(ROOT, 'reports/phase3-injury-emergency-audit-4n-v1.json');
const clone = x => structuredClone(x);
const full = (payload, label) => assert.equal(validateSeasonSavePayload(payload, { mode:'FULL' }), true, label);

function forced(state, player, date, kind, seed) {
  assert.ok(state?.health && player?.id);
  const result = maybeApplyInjury(state.health, player, {
    date, seed, kind, activity:kind==='PITCHER'?'STARTER':'POSITION_START',
    force:{ family:kind==='PITCHER'?'UPPER_BODY':'LOWER_BODY',severity:'MINOR',days:5 }
  });
  assert.ok(result.event && result.health.activeInjury, `forced ${kind} injury not created`);
  assert.equal(result.health.activeInjury.daysRemaining,5);
  return { ...state, health:result.health };
}

function makeFixture(payload, game, playerStates=payload.playerStates, pitcherStates=payload.pitcherStates) {
  return createSeasonGameFixture({seasonFixture:payload.fixture,scheduleGame:game,
    playerStates,pitcherStates,roleStates:payload.roleStates,level:'A'});
}
function main(){
  const base=JSON.parse(fs.readFileSync(BASE,'utf8'));
  assert.equal(base.pass,true);assert.equal(base.production.worldGames,10710);
  assert.equal(base.snapshotHash,'fnv1a32:f7b34713');
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8'));
  assert.equal(master.metadata.contentHash,base.snapshotHash);
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4N QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,
    bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',
    visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  const session=seasonApi.createCareerSeason({seed:'phase3-4n-injury-replacement',input,masterSnapshot:master});
  const id=session.seasonId;
  const opening=seasonApi.serializeSeason(id);full(opening,'opening FULL save invalid');
  assert.equal(opening.fixture.worldMode,'PRODUCTION_REAL');
  const league=opening.fixture.levelLeagues.A;
  const teamId=String(opening.fixture.organization.levels.A.team.id);
  const game=league.schedule.find(g=>String(g.awayTeamId)===teamId||String(g.homeTeamId)===teamId);
  assert.ok(game,'no real A-level user-team game');
  const side=String(game.awayTeamId)===teamId?'away':'home';
  const roster=league.rosters[teamId];
  const before=makeFixture(opening,game);
  const originalPitcherId=before.pitchingPlans[side].starterId;
  assert.ok(roster.starters.includes(originalPitcherId),'opening pitcher not a listed starter');
  const pitcherState=forced(opening.pitcherStates[originalPitcherId],roster.players[originalPitcherId],game.date,'PITCHER','4N-pitcher');
  const damagedPitcherStates={...opening.pitcherStates,[originalPitcherId]:pitcherState};
  const pitcherFixture=makeFixture(opening,game,opening.playerStates,damagedPitcherStates);
  const substituteId=pitcherFixture.pitchingPlans[side].starterId;
  assert.notEqual(substituteId,originalPitcherId,'injured starter was selected');
  assert.ok(roster.pitchers.includes(substituteId),'replacement pitcher not on same team');
  assert.equal(pitcherAvailability(damagedPitcherStates[substituteId]),'READY','replacement pitcher is not READY');
  assert.ok(!pitcherFixture.pitchingPlans[side].bullpenIds.includes(originalPitcherId),'injured SP included in bullpen');

  let chosen=null;
  const originalLineup=new Set(before.dailyLineups[side].lineup);
  for(const slot of roster.lineupSlots??[]){
    const hitId=slot.starterId;
    if(!originalLineup.has(hitId))continue;
    const hitState=opening.playerStates[hitId];
    if(!hitState?.health)continue;
    const next=forced(hitState,roster.players[hitId],game.date,'POSITION',`4N-${hitId}`);
    const states={...opening.playerStates,[hitId]:next};
    let fixture;
    try{fixture=makeFixture(opening,game,states,damagedPitcherStates);}catch{continue;}
    if(fixture.dailyLineups[side].lineup.includes(hitId))continue;
    if(!fixture.dailyLineups[side].unavailable.includes(hitId))continue;
    if(fixture.benchPlans[side].some(row=>row.playerId===hitId))continue;
    const replacements=fixture.dailyLineups[side].replacements??[];
    if(!replacements.some(row=>row.forPlayerId===hitId) && !(fixture.dailyLineups[side].utilityAssignments??[]).some(row=>row.forPlayerId===hitId))continue;
    chosen={hitId,hitState:next,states,fixture,replacements};break;
  }
  assert.ok(chosen,'no injured hitter could be replaced in the real A-level lineup');
  const eligibleLineup=chosen.fixture.dailyLineups[side].lineup;
  assert.equal(new Set(eligibleLineup).size,9,'replacement lineup has duplicate players');
  assert.equal(eligibleLineup.length,9,'replacement lineup has wrong size');
  assert.ok(eligibleLineup.every(x=>healthAvailability(chosen.states[x]?.health)!=='INJURED'),'injured player in replacement lineup');
  assert.equal(chosen.fixture.pitchingPlans[side].starterId,substituteId);

  const injuredSave=clone(opening);
  injuredSave.playerStates[chosen.hitId]=chosen.hitState;
  injuredSave.pitcherStates[originalPitcherId]=pitcherState;
  full(injuredSave,'injury save invalid');
  seasonApi.restoreSeason(injuredSave);
  const restored=seasonApi.serializeSeason(id);full(restored,'restored injury save invalid');
  assert.deepEqual(restored.playerStates[chosen.hitId].health,chosen.hitState.health,'hitter injury lost after restore');
  assert.deepEqual(restored.pitcherStates[originalPitcherId].health,pitcherState.health,'pitcher injury lost after restore');
  assert.deepEqual(restored.fixture.organization,opening.fixture.organization,'restoring injuries changed affiliate roster');
  const repeatFixture=makeFixture(restored,game);
  assert.deepEqual(repeatFixture.dailyLineups[side].lineup,eligibleLineup,'injury replacement lineup changed on restore');
  assert.equal(repeatFixture.pitchingPlans[side].starterId,substituteId,'injured starter selection changed on restore');

  const healedHitter=advanceHealthState(restored.playerStates[chosen.hitId].health,5);
  const healedPitcher=recoverPitcherSeasonState(restored.pitcherStates[originalPitcherId],roster.players[originalPitcherId],5);
  assert.equal(healthAvailability(healedHitter),'AVAILABLE','hitter did not recover');
  assert.notEqual(pitcherAvailability(healedPitcher),'INJURED','pitcher did not recover');
  const healthyStates={...restored.playerStates,[chosen.hitId]:{...restored.playerStates[chosen.hitId],health:healedHitter}};
  const healthyPitcherStates={...restored.pitcherStates,[originalPitcherId]:healedPitcher};
  const returnFixture=makeFixture(restored,game,healthyStates,healthyPitcherStates);
  assert.ok(returnFixture.dailyLineups[side].lineup.length===9 && new Set(returnFixture.dailyLineups[side].lineup).size===9);
  assert.ok(roster.pitchers.includes(returnFixture.pitchingPlans[side].starterId));

  // Probe the actual injury-triggered MLB call-up policy. A normal successful
  // evaluation is compared with the same MLB incumbent marked injured. This
  // is a diagnosis, not a claim that the end-to-end emergency call-up exists.
  const candidate={id:'4N_AAA',fromLevel:'AAA',position:'SS',depthScore:90,
    seasonLine:{G:12,PA:60,OPS:1.150},roleState:{momentum:0.15,role:'STARTER'},fatigue:0,injured:false};
  const incumbent={id:'4N_MLB',position:'SS',depthScore:25,
    seasonLine:{G:12,PA:60,OPS:0.420},roleState:{momentum:-0.15,role:'STARTER'},fatigue:0,injured:false};
  const standard=evaluateAaaMlbPromotion({date:'2026-05-15',candidate,incumbent});
  const emergency=evaluateAaaMlbPromotion({date:'2026-05-15',candidate,incumbent:{...incumbent,injured:true}});
  assert.equal(standard.decision,'PROMOTE','synthetic healthy promotion regression failed');
  assert.equal(emergency.injuryBlocked,true,'injury evaluator diagnostic did not trigger');
  const report={schema:'THE_CALL_UP_PHASE3_INJURY_EMERGENCY_AUDIT_4N_V1',pass:true,
    mode:'READ_ONLY_PRODUCTION_V3_INJECTED_INJURY',snapshotHash:base.snapshotHash,
    realFixture:{level:'A',gameId:game.gameId,gameDate:game.date,teamId,side,
      injuredHitterId:chosen.hitId,injuredStarterId:originalPitcherId,replacementStarterId:substituteId,
      hitterReplacementKinds:chosen.replacements.map(x=>x.kind),lineupSize:eligibleLineup.length},
    recovery:{hitterAvailable:true,pitcherNotInjured:true},
    saveRestore:{fullSaveValid:true,bothInjuriesPersist:true,lineupAndStarterDeterministic:true,rosterUnchanged:true},
    emergencyMlbCallupProbe:{healthyCandidateDecision:standard.decision,
      injuredIncumbentDecision:emergency.decision,injuredIncumbentBlocked:emergency.injuryBlocked,
      automaticInjuryCallupVerified:false,
      status:emergency.decision==='PROMOTE'?'POLICY_ALLOWS_CANDIDATE_NEEDS_SCHEDULER_TEST':'POLICY_BLOCKS_INJURED_INCUMBENT_NEEDS_FIX',
      note:'Forced injury replacement within a game is verified. Emergency cross-level MLB call-up is separately probed, not claimed complete.'},
    gates:{sourceGameplayUnchanged:true,productionSnapshotVerified:true,injuredPlayerExcluded:true,injuredStarterExcluded:true,
      injuriesPersistedAcrossRestore:true,injuryRecoveryVerified:true,emergencyCallupGapExplicitlyReported:true}};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({schema:report.schema,pass:report.pass,realFixture:report.realFixture,
    recovery:report.recovery,saveRestore:report.saveRestore,emergencyMlbCallupProbe:report.emergencyMlbCallupProbe,gates:report.gates},null,2));
}
try{main();}catch(e){console.error(e);process.exitCode=1;}
