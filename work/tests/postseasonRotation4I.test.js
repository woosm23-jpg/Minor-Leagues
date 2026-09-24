import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPostseasonStarter as choose, requiredRestDays } from '../src/engine/career/postseasonRotationPolicy.js';

function roster() {
  return {team:{id:'121'},starters:['S1','S2','S3','S4','S5'],
    bullpen:['B1','B2','B3'],pitchers:['S1','S2','S3','S4','S5','B1','B2','B3']};
}
const pitched = (date, count=90, fatigue=10) => ({lastAppearanceDate:date,lastPitchCount:count,fatigue});

test('three-man Wild Card and four-man long-series rotation use distinct starters',()=>{
  const r=roster();
  assert.deepEqual([0,1,2].map((gameIndex)=>choose(r,{}, {gameDate:['2026-09-29','2026-09-30','2026-10-01'][gameIndex],gameIndex,rotationSize:3}).starterId),['S1','S2','S3']);
  assert.deepEqual([0,1,2,3].map(gameIndex=>choose(r,{}, {gameDate:`2026-10-0${3+gameIndex}`,gameIndex,rotationSize:4}).starterId),['S1','S2','S3','S4']);
});

test('heavy last start prevents short-rest ace despite low numerical fatigue',()=>{
  const r=roster(); const states={S1:pitched('2026-09-27',88,0)};
  const picked=choose(r,states,{gameDate:'2026-09-29',gameIndex:0,rotationSize:3});
  assert.equal(picked.starterId,'S2');assert.equal(picked.reason,'ROTATION_BACKUP');
  assert.deepEqual(states,{S1:pitched('2026-09-27',88,0)});
});

test('four calendar days of recovery permit first starter again on game five',()=>{
  const states={S1:pitched('2026-10-03',94,17)};
  const result=choose(roster(),states,{gameDate:'2026-10-07',gameIndex:4,rotationSize:4});
  assert.equal(result.starterId,'S1');assert.equal(result.daysSinceLastAppearance,4);
  assert.equal(requiredRestDays(94),4);
});

test('injured rotation member is excluded and a healthy alternate takes over',()=>{
  const state={S1:{fatigue:0,health:{activeInjury:{daysRemaining:12}}}};
  const result=choose(roster(),state,{gameDate:'2026-10-03',gameIndex:0});
  assert.notEqual(result.starterId,'S1');
});

test('fifth starter is preferred to a one-day heavy-rest rotation and bullpen',()=>{
  const r=roster();const states=Object.fromEntries(r.starters.slice(0,4).map(id=>[id,pitched('2026-10-03',90,30)]));
  const p=choose(r,states,{gameDate:'2026-10-04',gameIndex:1,rotationSize:4});
  assert.equal(p.starterId,'S5');assert.equal(p.reason,'FIFTH_STARTER');
});

test('a rested bullpen arm can provide a bullpen day instead of short-rest starter',()=>{
  const r=roster();const states=Object.fromEntries(r.starters.map(id=>[id,pitched('2026-10-03',90,30)]));
  const p=choose(r,states,{gameDate:'2026-10-04',gameIndex:1});
  assert.equal(p.starterId,'B1');assert.equal(p.reason,'BULLPEN_DAY');
});

test('a heavy-workload bullpen pitcher cannot begin a bullpen day next day',()=>{
  const r=roster();const states=Object.fromEntries(r.starters.map(id=>[id,pitched('2026-10-03',90,30)]));
  states.B1=pitched('2026-10-03',45,0);
  const p=choose(r,states,{gameDate:'2026-10-04',gameIndex:1});
  assert.equal(p.starterId,'B2');
});

test('same saved pregame state produces identical policy selection and never mutates inputs',()=>{
  const r=roster(), states={S1:pitched('2026-10-03',95,45),S2:pitched('2026-09-29',85,15)};
  const before=structuredClone({r,states});
  const a=choose(r,states,{gameDate:'2026-10-05',gameIndex:0});
  const b=choose(structuredClone(r),structuredClone(states),{gameDate:'2026-10-05',gameIndex:0});
  assert.deepEqual(a,b);assert.deepEqual({r,states},before);
});

test('invalid dates, unsupported rotation sizes, and fully injured rosters fail visibly',()=>{
  assert.throws(()=>choose(roster(),{}, {gameDate:'2026-02-30'}),RangeError);
  assert.throws(()=>choose(roster(),{}, {gameDate:'2026-10-03',rotationSize:5}),RangeError);
  const noPitchers={starters:[],bullpen:[],pitchers:[]};
  assert.throws(()=>choose(noPitchers,{}, {gameDate:'2026-10-03'}),RangeError);
  const allInjured=Object.fromEntries(roster().pitchers.map(id=>[id,{health:{activeInjury:{daysRemaining:5}},fatigue:0}]));
  assert.throws(()=>choose(roster(),allInjured,{gameDate:'2026-10-03'}),/건강한 투수/);
});
