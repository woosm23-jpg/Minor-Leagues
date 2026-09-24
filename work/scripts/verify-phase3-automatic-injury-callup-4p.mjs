import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { maybeApplyInjury, healthAvailability } from '../src/engine/season/injuryState.js';
import {
  createRosterControlState, prepareAaaMlbEmergencyInjuryReturn, validateRosterControlState
} from '../src/engine/career/rosterControlState.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ROOTREPORT=path.join(ROOT,'reports/phase3-automatic-injury-callup-4p-v1.json');
const V3=path.join(ROOT,'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const clone=x=>structuredClone(x);
const valid=(payload,label)=>assert.equal(validateSeasonSavePayload(payload,{mode:'FULL'}),true,label);
const activeEntries=p=>(p.organizationState?.emergencyInjuryMoves ?? []).filter(x=>x.status==='ACTIVE');
const getEntry=(p,id)=>(p.organizationState?.emergencyInjuryMoves ?? []).find(x=>x.injuredPlayerId===id);
const nextDate=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};

function assertRosters(payload,entry,phase) {
  const org=payload.fixture.organization,mlb=org.levels.MLB,aaa=org.levels.AAA;
  const injured=entry.injuredPlayerId,repl=entry.replacementId;
  const active=phase==='ACTIVE';
  assert.equal(Boolean((active?aaa:mlb).roster.players[injured]),true,'injured player placement invalid');
  assert.equal(Boolean((active?mlb:aaa).roster.players[repl]),true,'replacement placement invalid');
  assert.equal(Boolean((active?mlb:aaa).roster.players[injured]),false,'injured player duplicated across levels');
  assert.equal(Boolean((active?aaa:mlb).roster.players[repl]),false,'replacement duplicated across levels');
  assert.deepEqual(payload.fixture.levelLeagues.MLB.rosters[String(mlb.team.id)],mlb.roster,'MLB org/league mirror drift');
  assert.deepEqual(payload.fixture.levelLeagues.AAA.rosters[String(aaa.team.id)],aaa.roster,'AAA org/league mirror drift');
  assert.deepEqual(payload.fixture.rosters[payload.fixture.userTeamId],aaa.roster,'AAA canonical mirror drift');
  const ids=org.levelOrder.flatMap(l=>Object.keys(org.levels[l].roster.players));
  assert.equal(new Set(ids).size,ids.length,'player duplicated in organization');
}
function assertReturnLegality(){
  const date='2026-05-15',organizationId='test';
  const returning=createRosterControlState({playerId:'returning',startDate:date,initialLevel:'MLB'});
  const replacement=createRosterControlState({playerId:'replacement',startDate:date,initialLevel:'MLB'});
  const il={...returning,assignmentStatus:'MLB_INJURED_LIST',option:{...returning.option,remaining:0,yearsUsed:3}};
  validateRosterControlState(il);
  const pair={states:{returning:il,replacement},returningId:'returning',replacementId:'replacement',date,organizationId};
  const okay=prepareAaaMlbEmergencyInjuryReturn(pair);
  assert.equal(okay.allowed,true,'legal injured-list return blocked');
  assert.equal(okay.states.returning.assignmentStatus,'MLB_ACTIVE');
  assert.equal(okay.states.returning.option.remaining,0,'return consumed injured player option');
  assert.equal(okay.states.replacement.assignmentStatus,'OPTIONED');
  assert.equal(okay.states.replacement.option.assignmentsThisSeason,1);
  assert.equal(pair.states.returning.assignmentStatus,'MLB_INJURED_LIST','return mutated input');
  const blocked=prepareAaaMlbEmergencyInjuryReturn({...pair,states:{returning:il,
    replacement:{...replacement,option:{...replacement.option,remaining:0,yearsUsed:3}}}});
  assert.equal(blocked.allowed,false,'illegal out-of-options return silently optioned replacement');
  assert.equal(blocked.blockCode,'OUT_OF_OPTIONS_WAIVERS_REQUIRED');
  return true;
}

function main(){
  const previous=JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-emergency-callup-primitives-4o-v1.json'),'utf8'));
  assert.equal(previous.pass,true);assert.equal(previous.snapshotHash,'fnv1a32:f7b34713');
  assert.equal(previous.pending.automaticInjuryTrigger,false);
  assertReturnLegality();
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(V3)).toString('utf8'));
  assert.equal(master.metadata.contentHash,previous.snapshotHash);
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4P QA',nationality:'대한민국',hometown:'구미',age:18,
    heightCm:180,weightKg:78,bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',
    archetype:'BALANCED',visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',
    favoriteOrganizationId:String(org.id)};
  const season=seasonApi.createCareerSeason({seed:'phase3-4p-auto-injury-qa',input,masterSnapshot:master});
  const id=season.seasonId,opening=seasonApi.serializeSeason(id);valid(opening,'4P opening');
  const mlb=opening.fixture.organization.levels.MLB.roster;
  const targets=[...(mlb.lineupSlots??[]).map(s=>({id:s.starterId,position:s.position,pitcher:false})),
    ...(mlb.starters??[]).map(id=>({id,position:'SP',pitcher:true})),
    ...(mlb.bullpen??[]).map(id=>({id,position:'RP',pitcher:true}))];
  let entry=null,injuredStart=null,attempted=0;
  for(const target of targets){
    const player=mlb.players[target.id];
    const state=target.pitcher?opening.pitcherStates[target.id]:opening.playerStates[target.id];
    if(!player||!state?.health||opening.rosterControlStates[target.id]?.assignmentStatus!=='MLB_ACTIVE')continue;
    const injected=maybeApplyInjury(state.health,player,{date:opening.fixture.startDate,
      seed:`phase3-4p-force-${target.id}`,kind:target.pitcher?'PITCHER':'POSITION',
      activity:target.pitcher?'PITCHER_START':'POSITION_START',
      force:{family:target.pitcher?'UPPER_BODY':'LOWER_BODY',severity:'MINOR',days:5}});
    assert.ok(injected.event,'forced 4P injury missing');
    const save=clone(opening);
    if(target.pitcher)save.pitcherStates[target.id]={...state,health:injected.health};
    else save.playerStates[target.id]={...state,health:injected.health};
    valid(save,`4P injected ${target.id}`);
    seasonApi.restoreSeason(save);
    seasonApi.runOrganizationReview(id,{force:false});
    attempted++;
    const result=seasonApi.serializeSeason(id);
    valid(result,`4P post-review ${target.id}`);
    entry=activeEntries(result).find(x=>x.injuredPlayerId===target.id) ?? null;
    if(entry){injuredStart={id:target.id,position:target.position,pitcher:target.pitcher,
      date:opening.fixture.startDate};break;}
    if(attempted<=2){
      const minor=result.fixture.organization.levels.AAA.roster;
      const candidates=target.position==='SP'?[...minor.starters]:target.position==='RP'?[...minor.bullpen]
        :[minor.lineupSlots?.find(s=>s.position===target.position)?.starterId,
          ...(minor.bench??[]).filter(s=>s.coverage?.includes(target.position)).map(s=>s.playerId)].filter(Boolean);
      console.error('4P RECOVERY QA DIAGNOSTIC',JSON.stringify({target:target.id,position:target.position,
        currentDate:result.season?.currentDate,injured:target.pitcher?result.pitcherStates[target.id]?.health?.activeInjury?.daysRemaining:
          result.playerStates[target.id]?.health?.activeInjury?.daysRemaining,
        control:result.rosterControlStates[target.id]?.assignmentStatus,
        candidates:candidates.map(x=>({id:x,on40Man:result.rosterControlStates[x]?.on40Man,
          hasPlayer:Boolean(minor.players?.[x])})),review:result.organizationState?.reviews}));
    }
  }
  assert.ok(entry,'no real injured MLB hitter or pitcher received a legal AAA emergency call-up (see 4P recovery diagnostics)');
  let current=seasonApi.serializeSeason(id), control=current.rosterControlStates[entry.injuredPlayerId];
  assertRosters(current,entry,'ACTIVE');
  assert.equal(control.assignmentStatus,'MLB_INJURED_LIST');
  assert.equal(control.on40Man,true);
  assert.equal(control.option.assignmentsThisSeason,opening.rosterControlStates[entry.injuredPlayerId].option.assignmentsThisSeason);
  assert.equal(current.rosterControlStates[entry.replacementId].assignmentStatus,'MLB_ACTIVE');
  const ilMinimum=injuredStart.pitcher?15:10;
  assert.equal(entry.minReturnDate,nextDate(injuredStart.date,ilMinimum));
  assert.equal(entry.status,'ACTIVE');
  assert.equal(entry.injuryId,(injuredStart.pitcher?current.pitcherStates:current.playerStates)[entry.injuredPlayerId].health.activeInjury.injuryId);
  const originalEvents=current.organizationState.transactions.length;
  seasonApi.runOrganizationReview(id,{force:false});
  current=seasonApi.serializeSeason(id);
  assert.equal(activeEntries(current).filter(x=>x.injuredPlayerId===entry.injuredPlayerId).length,1,'same-day emergency replacement duplicated');
  assert.equal(current.organizationState.transactions.length,originalEvents,'same-day extra roster events');

  seasonApi.restoreSeason(clone(current));
  const persisted=seasonApi.serializeSeason(id);valid(persisted,'4P active IL restore');
  assert.deepEqual(persisted.organizationState.emergencyInjuryMoves,current.organizationState.emergencyInjuryMoves,'IL transaction tracker lost after restore');
  assertRosters(persisted,entry,'ACTIVE');
  const startingService=opening.contractStates[entry.injuredPlayerId].simulatedServiceDays;
  const snapshots=[];
  let returned=null;
  for(let i=0;i<9;i++){
    const before=seasonApi.serializeSeason(id);
    seasonApi.simulateSevenDays(id);
    current=seasonApi.serializeSeason(id);valid(current,`4P calendar step ${i}`);
    const row=getEntry(current,entry.injuredPlayerId);
    assert.ok(row,'IL tracker disappeared during calendar progression');
    snapshots.push({date:current.playerStateDate,status:row.status,
      simulatedServiceDays:current.contractStates[entry.injuredPlayerId].simulatedServiceDays});
    if(row.status==='RETURNED'){returned=row;break;}
    assert.equal(row.status,'ACTIVE','unexpected IL status');
    if(i>0 && before.playerStateDate===current.playerStateDate && before.state?.currentDate===current.state?.currentDate)
      throw new Error('calendar failed to advance while awaiting IL return');
  }
  assert.ok(returned,`eligible injured player never returned: ${JSON.stringify(snapshots)}`);
  assert.ok(returned.returnedDate>=entry.minReturnDate,'returned before minimum IL duration');
  const final=seasonApi.serializeSeason(id);valid(final,'4P return final');
  assertRosters(final,entry,'RETURNED');
  assert.equal(final.rosterControlStates[entry.injuredPlayerId].assignmentStatus,'MLB_ACTIVE');
  assert.ok(['OPTIONED','OPTIONED_UNKNOWN'].includes(final.rosterControlStates[entry.replacementId].assignmentStatus),
    'replacement was not legally returned to minors');
  assert.equal(final.rosterControlStates[entry.injuredPlayerId].option.assignmentsThisSeason,
    opening.rosterControlStates[entry.injuredPlayerId].option.assignmentsThisSeason,
    'injured player lost an option on IL return');
  assert.equal(healthAvailability((injuredStart.pitcher?final.pitcherStates:final.playerStates)[entry.injuredPlayerId].health),'AVAILABLE');
  const serviceEnd=final.contractStates[entry.injuredPlayerId].simulatedServiceDays;
  assert.ok(serviceEnd>startingService,'injured-list MLB service time stopped');
  seasonApi.restoreSeason(clone(final));
  const repeated=seasonApi.serializeSeason(id);valid(repeated,'4P returned restore');
  assert.deepEqual(repeated.organizationState.emergencyInjuryMoves,final.organizationState.emergencyInjuryMoves);
  assert.equal(getEntry(repeated,entry.injuredPlayerId).status,'RETURNED');
  assertRosters(repeated,entry,'RETURNED');

  const report={schema:'THE_CALL_UP_PHASE3_AUTOMATIC_INJURY_CALLOUT_4P_V1',pass:true,
    snapshotHash:previous.snapshotHash,mode:'REAL_PRODUCTION_INJECTED_INJURY_LIVE_CALENDAR',
    target:{...injuredStart,attemptedTargets:attempted,injuredPlayerId:entry.injuredPlayerId,
      replacementId:entry.replacementId,selectionMode:entry.selectionMode,minReturnDate:entry.minReturnDate,returnedDate:returned.returnedDate},
    gates:{prerequisite4oPass:true,automaticInjuryTrigger:true,legalAaaMlbEmergencySwap:true,
      noDuplicateEmergencyMoves:true,mandatoryInjuredListDaysRespected:true,
      automaticReturn:true,fortyManAndOptionRulesPreserved:true,
      illegalOutOfOptionsReturnBlocked:true,injuredMlbServiceDaysCredited:true,
      fullSaveRestoreBeforeAndAfterReturn:true,rosterMirrorsAndUniquePlayers:true},
    service:{before:startingService,after:serviceEnd},calendar:snapshots,
    note:'Production v3 injured MLB starter is replaced by legal AAA call-up, restored after healthy minimum IL stay, and credited MLB IL service; no hidden waiver or 60-day spot is inferred.'};
  fs.mkdirSync(path.dirname(ROOTREPORT),{recursive:true});
  fs.writeFileSync(ROOTREPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
try{main();}catch(e){console.error(e);process.exitCode=1;}
