import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateHitterSeasonValue, estimatePitcherSeasonValue, leagueBattingEnvironment } from '../src/engine/season/seasonValueReadModel.js';
import { auditSeasonHistoryEntry } from '../src/engine/career/seasonHistoryAudit.js';
import { seasonApi } from '../src/api/seasonApi.js';
import { renderSeason } from '../src/ui/seasonRender.js';

const bat=(o={})=>({ PA: 600, AB: 520, H: 150, doubles: 25, triples: 4, HR: 18,
  BB: 60, HBP: 8, SF: 8, SB: 15, CS: 4, ...o });
const league=()=>Object.fromEntries(Array.from({length:25},(_,i)=>[`h${i}`,bat({ H:130, HR:14 })]));

test('value estimation uses recorded batting/running stats, positional context and league environment, never OVR',()=>{
  const lines=league();
  const good=estimateHitterSeasonValue({line:bat(),leagueLines:lines,position:'SS',level:'AAA'});
  const poor=estimateHitterSeasonValue({line:bat({H:98,HR:4,SB:2,CS:9}),leagueLines:lines,position:'SS',level:'AAA'});
  assert.equal(good.status,'READY');
  assert.equal(good.officialWar,false);
  assert.equal(good.fieldingIncluded,false);
  assert.equal(good.parkAdjusted,false);
  assert.ok(good.partialWins>poor.partialWins);
  const ovr=estimateHitterSeasonValue({line:{...bat(),ovr:99,potential:99},leagueLines:lines,position:'SS',level:'AAA'});
  assert.deepEqual(ovr,good);
  const dh=estimateHitterSeasonValue({line:bat(),leagueLines:lines,position:'DH',level:'AAA'});
  assert.ok(good.positionalRuns>dh.positionalRuns);
  const highRunEnv=Object.fromEntries(Object.entries(lines).map(([id,row])=>[id,{...row,H:190,HR:35}]));
  assert.ok(estimateHitterSeasonValue({line:bat(),leagueLines:highRunEnv,position:'SS'}).battingRuns<good.battingRuns);
  assert.equal(estimateHitterSeasonValue({line:bat({PA:0,AB:0,H:0,doubles:0,triples:0,HR:0,BB:0,HBP:0,SF:0}),leagueLines:lines}).status,'INSUFFICIENT_SAMPLE');
  assert.equal(leagueBattingEnvironment(lines).PA,15000);
  assert.throws(()=>estimateHitterSeasonValue({line:bat({H:3,HR:7}),leagueLines:lines}),/안타/);
});

test('pitcher contribution remains defensive-support-aware and does not invent official WAR',()=>{
  const rows=Object.fromEntries(Array.from({length:15},(_,i)=>[`p${i}`,{outsRecorded:450,R:75}]));
  const good=estimatePitcherSeasonValue({line:{outsRecorded:540,R:55,ovr:24},leagueLines:rows});
  const bad=estimatePitcherSeasonValue({line:{outsRecorded:540,R:110,ovr:99},leagueLines:rows});
  assert.equal(good.status,'READY');
  assert.equal(good.officialWar,false);
  assert.equal(good.defenseIndependent,false);
  assert.ok(good.partialWins>bad.partialWins);
  assert.equal(estimatePitcherSeasonValue({line:{outsRecorded:0,R:0},leagueLines:rows}).status,'INSUFFICIENT_SAMPLE');
});

test('archive auditing rejects fabricated awards, duplicate position winners and unearned ring status',()=>{
  const award=(playerId,teamId='champ')=>({playerId,teamId});
  const archive={seasonYear:2026,championTeamId:'champ',awards:{methodology:{goldGlove:'DEFERRED_FIELDING_EVENT_TOTALS_REQUIRED'},leagues:{AL:{mvp:award('a'),cyYoung:award('p'),silverSlugger:[{...award('b'),position:'SS'}]}},worldSeriesMvp:award('ws')},user:{regularSeason:{PA:400},postseason:{PA:30},postseasonRoster:true,postseasonAppearances:3,championshipStatus:'ROSTER_CHAMPION',awards:[]}};
  assert.equal(auditSeasonHistoryEntry(archive).pass,true);
  const bad=structuredClone(archive);bad.awards.leagues.AL.silverSlugger.push({...award('c'),position:'SS'});
  assert.throws(()=>auditSeasonHistoryEntry(bad),/중복/);
  const fake=structuredClone(archive);fake.user.postseasonAppearances=0;
  assert.throws(()=>auditSeasonHistoryEntry(fake),/참가/);
  const fakeGG=structuredClone(archive);fakeGG.awards.leagues.AL.goldGlove=[award('a')];
  assert.throws(()=>auditSeasonHistoryEntry(fakeGG),/골드글러브/);
  const fakeWs=structuredClone(archive);fakeWs.awards.worldSeriesMvp.teamId='loser';
  assert.throws(()=>auditSeasonHistoryEntry(fakeWs),/우승팀/);
});

test('current season exposes a read-only Korean value panel without mutating season saves',()=>{
  const first=seasonApi.createDemoSeason({seed:'phase6-value-ui',startDate:'2026-04-01'});
  const id=first.seasonId;
  const before=seasonApi.serializeSeason(id);
  assert.equal(first.userPlayer.valueEstimate.officialWar,false);
  const root={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
  renderSeason(root,first,{},'PLAYER',{playerSection:'STATS'});
  assert.match(root.innerHTML,/공격·주루 가치 추정/);
  assert.match(root.innerHTML,/공식 WAR 아님/);
  assert.deepEqual(seasonApi.serializeSeason(id),before,'reading a derived value must not alter authoritative world');
  const restore=seasonApi.restoreSeason(structuredClone(before));
  assert.deepEqual(restore.userPlayer.valueEstimate,first.userPlayer.valueEstimate);
});
