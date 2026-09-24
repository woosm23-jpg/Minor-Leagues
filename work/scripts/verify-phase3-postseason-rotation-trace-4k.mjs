import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Read-only 4K audit. Temporarily instrument the 4I selector on this CI runner,
// restore its source in finally, and commit only the independent verifier/report.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SOURCE=path.join(ROOT,'src/engine/career/postseasonRotationPolicy.js');
const REPORT=path.join(ROOT,'reports/phase3-postseason-rotation-trace-4k-v1.json');
const SNAPSHOT=path.join(ROOT,'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz');
const BASE_4I=path.join(ROOT,'reports/phase3-postseason-short-rotation-4i-v1.json');
const BASE_4J=path.join(ROOT,'reports/phase3-postseason-rotation-audit-4j-v1.json');
const HOOK='__TCU_4K_ROTATION_AUDIT__';
const ANCHOR='    const v = view(id);\n    return Object.freeze({starterId: id, reason, rotationSize, rotationSlot: slot,';
const INSTRUMENT=`    const v = view(id);
    if (typeof globalThis.${HOOK} === 'function') {
      globalThis.${HOOK}({
        gameDate, gameIndex, rotationSize, starterId:id, reason,
        scheduledStarterId:scheduled,
        scheduledView:scheduled ? view(scheduled) : null,
        selectedView:v,
        roster:{starters:[...(roster.starters??[])],bullpen:[...(roster.bullpen??[])],pitchers:[...(roster.pitchers??[])]},
        pitcherStates:Object.fromEntries(
          [...new Set([...(roster.starters??[]),...(roster.bullpen??[])])].map(pid=>{
            const p=pitcherStates?.[pid];
            return [pid,p==null?null:{fatigue:p.fatigue??0,lastAppearanceDate:p.lastAppearanceDate??null,
              lastPitchCount:p.lastPitchCount??0,health:{activeInjury:p.health?.activeInjury??null}}];
          })
        )
      });
    }
    return Object.freeze({starterId: id, reason, rotationSize, rotationSlot: slot,`;
const day = date => {
  assert.match(date,/^\d{4}-\d{2}-\d{2}$/);
  const t=Date.parse(date+'T00:00:00Z');
  assert.ok(Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===date,'invalid game date '+date);
  return t/86400000;
};
const histogram = rows => rows.reduce((acc,x)=>{acc[x]=(acc[x]??0)+1;return acc;},{});
const clone=x=>structuredClone(x);

function diagnose(row, priorStarts) {
  const v=row.scheduledView;
  const scheduled=row.scheduledStarterId;
  const selected=row.starterId;
  const previous=scheduled?priorStarts.get(row.teamId+':'+scheduled)??null:null;
  const sameDayPrior=previous && v?.gap!=null && previous.date===row.gameDate;
  assert.ok(!sameDayPrior,'same-day pitcher starter repeat '+row.gameId);
  let cause;
  if(scheduled===selected) cause='SCHEDULED_USED';
  else if(!scheduled) cause='ROTATION_SLOT_EMPTY';
  else if(v.availability==='INJURED') cause='SCHEDULED_INJURED';
  else if(v.availability==='UNAVAILABLE') cause='SCHEDULED_UNAVAILABLE';
  else if(v.fatigue>=58) cause='SCHEDULED_FATIGUE_CAP';
  else if(v.gap!==null && v.gap<v.minGap) {
    if(previous && previous.date===row.scheduledLastAppearanceDate) {
      cause=previous.seriesId===row.seriesId?'EARLIER_SAME_SERIES_START_SHORT_REST':'EARLIER_POSTSEASON_START_SHORT_REST';
    } else if(row.round==='WILD_CARD' && row.gameIndex===0) cause='REGULAR_SEASON_SHORT_REST';
    else cause='OTHER_APPEARANCE_SHORT_REST';
  } else if(v.rested && v.availability==='LIMITED' && row.selectedView.availability==='READY')
    cause='READY_BACKUP_OVER_RESTED_LIMITED';
  else cause='UNEXPLAINED_SELECTION';
  assert.notEqual(cause,'UNEXPLAINED_SELECTION',`unexplained ${row.gameId}/${row.side}: ${JSON.stringify({scheduled,selected,v,reason:row.reason})}`);
  if(scheduled===selected) assert.ok(['ROTATION','ROTATION_LIMITED'].includes(row.reason));
  if(row.reason!=='EMERGENCY_SHORT_REST') assert.equal(row.selectedView.rested,true,`unrested non-emergency starter ${row.gameId}`);
  return {cause,previousScheduledPostseasonStart:previous};
}

async function verify() {
  // Dynamic import happens only after the selector was instrumented.
  const [{seasonApi},{selectPostseasonStarter,requiredRestDays},{validateSeasonSavePayload}]=await Promise.all([
    import('../src/api/seasonApi.js'),import('../src/engine/career/postseasonRotationPolicy.js'),
    import('../src/services/seasonSerialization.js')
  ]);
  const baseline=JSON.parse(fs.readFileSync(BASE_4I,'utf8'));
  const openingAudit=JSON.parse(fs.readFileSync(BASE_4J,'utf8'));
  assert.equal(baseline.pass,true);assert.equal(openingAudit.pass,true);
  assert.equal(baseline.snapshotHash,'fnv1a32:f7b34713');
  assert.equal(openingAudit.snapshotHash,baseline.snapshotHash);
  const master=JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT)).toString('utf8'));
  assert.equal(master.metadata.contentHash,baseline.snapshotHash);
  const org=seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input={name:'4K QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,
    bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',
    visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let session=seasonApi.createCareerSeason({seed:baseline.seed,input,masterSnapshot:master});
  session=seasonApi.simulateToSeasonEnd(session.seasonId);
  assert.equal(session.status,'COMPLETE');
  session=seasonApi.startPostseason(session.seasonId);
  const opening=seasonApi.serializeSeason(session.seasonId);
  assert.equal(validateSeasonSavePayload(opening,{mode:'FULL'}),true);
  const priorStarts=new Map();
  const results={};let wcSave=null,dsSave=null;
  let allMatched=0,unrestedNonEmergency=0;

  for(const [round,expectedSize,expectedSeries] of [['WILD_CARD',3,4],['DIVISION_SERIES',4,4]]) {
    const captured=[];
    globalThis[HOOK]=e=>captured.push(e);
    const before=seasonApi.serializeSeason(session.seasonId);
    session=seasonApi.advancePostseasonRound(session.seasonId);
    globalThis[HOOK]=null; // Prevent replay calls from generating trace entries.
    const after=seasonApi.serializeSeason(session.seasonId);
    assert.equal(validateSeasonSavePayload(after,{mode:'FULL'}),true);
    assert.deepEqual(after.levelSeasons.MLB,opening.levelSeasons.MLB,'regular MLB stats changed');
    const groups=after.postseasonState.rounds[round];
    assert.equal(groups.length,expectedSeries);
    const entries=groups.flatMap(group=>group.games.flatMap((game,index)=>[
      {group,game,index,side:'away'},{group,game,index,side:'home'}
    ]));
    assert.equal(captured.length,entries.length,`missing or extra ${round} pregame selection traces`);
    const rows=[];
    for(const [idx,entry] of entries.entries()) {
      const {group,game,index,side}=entry,t=captured[idx];
      const teamId=String(game[side+'TeamId']);
      assert.equal(t.gameDate,game.date);assert.equal(t.gameIndex,index);
      assert.equal(t.rotationSize,expectedSize);
      assert.equal(t.starterId,game[side+'StarterId']);
      assert.equal(t.reason,game[side+'StarterReason']);
      assert.ok(after.postseasonState.rosters[teamId].includes(t.starterId),'starter outside playoff roster');
      // Re-run the real selector with its actual, per-game pregame snapshots.
      const replay=selectPostseasonStarter(t.roster,t.pitcherStates,
        {gameDate:t.gameDate,gameIndex:t.gameIndex,rotationSize:t.rotationSize});
      assert.equal(replay.starterId,t.starterId,`replay starter mismatch ${game.gameId}/${side}`);
      assert.equal(replay.reason,t.reason,`replay reason mismatch ${game.gameId}/${side}`);
      assert.equal(replay.daysSinceLastAppearance,t.selectedView.gap);
      assert.equal(replay.pregameFatigue,t.selectedView.fatigue);
      allMatched++;
      const sv=t.scheduledView;
      const observed={round,seriesId:group.seriesId,seriesGame:index+1,gameId:game.gameId,
        gameDate:game.date,teamId,side,gameIndex:index,rotationSize:expectedSize,
        scheduledStarterId:t.scheduledStarterId,starterId:t.starterId,reason:t.reason,
        scheduledLastAppearanceDate:t.scheduledStarterId?t.pitcherStates[t.scheduledStarterId]?.lastAppearanceDate??null:null,
        scheduledView:sv?{availability:sv.availability,fatigue:Number(sv.fatigue.toFixed(2)),
          gap:sv.gap,pitchCount:sv.pitchCount,minGap:requiredRestDays(sv.pitchCount),rested:sv.rested}:null,
        selectedView:{availability:t.selectedView.availability,fatigue:Number(t.selectedView.fatigue.toFixed(2)),
          gap:t.selectedView.gap,pitchCount:t.selectedView.pitchCount,rested:t.selectedView.rested}};
      const detail=diagnose({...observed,scheduledView:sv,selectedView:t.selectedView},priorStarts);
      if(t.reason!=='EMERGENCY_SHORT_REST'&&!t.selectedView.rested)unrestedNonEmergency++;
      observed.cause=detail.cause;
      if(detail.previousScheduledPostseasonStart) observed.previousScheduledPostseasonStart={
        gameId:detail.previousScheduledPostseasonStart.gameId,
        date:detail.previousScheduledPostseasonStart.date,
        seriesId:detail.previousScheduledPostseasonStart.seriesId};
      rows.push(observed);
      priorStarts.set(teamId+':'+t.starterId,{date:game.date,gameId:game.gameId,seriesId:group.seriesId});
    }
    const expected=baseline[round==='WILD_CARD'?'wildCard':'divisionSeries'];
    assert.equal(entries.length,expected.starterAssignments);
    assert.deepEqual(histogram(rows.map(r=>r.reason)),expected.reasonCounts,
      `4I ${round} starting pitcher reasons regressed`);
    assert.deepEqual(after.postseasonState.rosters,before.postseasonState.rosters,'postseason roster changed');
    results[round]={seriesCount:groups.length,gameCount:entries.length/2,starterAssignments:entries.length,
      reasonCounts:histogram(rows.map(r=>r.reason)),causeCounts:histogram(rows.map(r=>r.cause)),
      // Preserve every decision to distinguish first-game rest from within-series cascades.
      decisions:rows};
    if(round==='WILD_CARD') wcSave=after;
    else dsSave=after;
  }
  assert.equal(results.WILD_CARD.gameCount,openingAudit.wildCard.gameCount);
  assert.equal(results.WILD_CARD.starterAssignments,openingAudit.wildCard.starterAssignments);
  const opener=results.WILD_CARD.decisions.filter(x=>x.seriesGame===1);
  assert.equal(opener.length,8);
  assert.deepEqual(histogram(opener.map(r=>r.cause)),
    {REGULAR_SEASON_SHORT_REST:7,SCHEDULED_USED:1},'4J opening audit changed');
  assert.equal(unrestedNonEmergency,0);
  assert.equal(allMatched,results.WILD_CARD.starterAssignments+results.DIVISION_SERIES.starterAssignments);

  // The diagnostic hook must not change game outcomes, workload, or save data.
  session=seasonApi.restoreSeason(clone(opening));
  session=seasonApi.advancePostseasonRound(session.seasonId);
  const plainWC=seasonApi.serializeSeason(session.seasonId);
  assert.deepEqual(plainWC.postseasonState.rounds.WILD_CARD,wcSave.postseasonState.rounds.WILD_CARD);
  assert.deepEqual(plainWC.postseasonState.stats,wcSave.postseasonState.stats);
  assert.deepEqual(plainWC.pitcherStates,wcSave.pitcherStates);
  session=seasonApi.advancePostseasonRound(session.seasonId);
  const plainDS=seasonApi.serializeSeason(session.seasonId);
  assert.deepEqual(plainDS.postseasonState.rounds.DIVISION_SERIES,dsSave.postseasonState.rounds.DIVISION_SERIES);
  assert.deepEqual(plainDS.postseasonState.stats,dsSave.postseasonState.stats);
  assert.deepEqual(plainDS.pitcherStates,dsSave.pitcherStates);
  const report={schema:'THE_CALL_UP_PHASE3_POSTSEASON_ROTATION_TRACE_4K_V1',pass:true,
    mode:'TEMPORARY_DIAGNOSTIC_HOOK_READ_ONLY',snapshotHash:baseline.snapshotHash,seed:baseline.seed,
    wildCard:results.WILD_CARD,divisionSeries:results.DIVISION_SERIES,
    gates:{allPregameSelectionsReplayed:allMatched,prior4iReasonCountsUnchanged:true,
      prior4jOpeningCausesUnchanged:true,nonEmergencyUnrestedStarts:unrestedNonEmergency,
      regularSeasonStatsUnchanged:true,fullSaveValid:true,
      diagnosticHookDoesNotChangeOutcomesOrPitcherWorkload:true},
    note:'Every playoff pregame starter selection was replayed against its own captured pregame pitcher states. No game rules or save schema were changed.'};
  fs.mkdirSync(path.dirname(REPORT),{recursive:true});
  fs.writeFileSync(REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({schema:report.schema,pass:report.pass,
    wildCard:{gameCount:report.wildCard.gameCount,reasonCounts:report.wildCard.reasonCounts,causeCounts:report.wildCard.causeCounts,
      afterOpeningCauseCounts:histogram(report.wildCard.decisions.filter(x=>x.seriesGame>1).map(x=>x.cause))},
    divisionSeries:{gameCount:report.divisionSeries.gameCount,causeCounts:report.divisionSeries.causeCounts},gates:report.gates},null,2));
}

async function main(){
  const original=fs.readFileSync(SOURCE,'utf8');
  assert.equal(original.split(ANCHOR).length-1,1,'4I starter selector changed; refusing unsafe instrumentation');
  fs.writeFileSync(SOURCE,original.replace(ANCHOR,INSTRUMENT),'utf8');
  try {await verify();}
  finally {
    delete globalThis[HOOK];
    fs.writeFileSync(SOURCE,original,'utf8');
    assert.equal(fs.readFileSync(SOURCE,'utf8'),original,'policy source not restored');
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
