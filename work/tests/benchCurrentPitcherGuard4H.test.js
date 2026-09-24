import assert from 'node:assert/strict';
import test from 'node:test';
import { createLateGameBenchManager } from '../src/engine/game/benchUsageAI.js';

const hitter = (rating) => ({
  bats: 'R', throws: 'R',
  hitting: { contactR: rating, contactL: rating, rawPower: rating, vision: rating, discipline: rating },
  tendencies: { powerUtilizationR: rating, powerUtilizationL: rating },
  running: { speed: 50, baserunning: 50 }
});
const players = {
  BATTER: hitter(20), TW_PITCHER: hitter(95), SAFE_BATTER: hitter(70),
  OPP_PITCHER: { throws: 'R' }, OTHER_PITCHER: { throws: 'R' }
};
const row = (playerId) => ({ playerId, coverage: ['DH'], role: 'PLATOON', fatigue: 0 });
const state = (currentPitcherId) => ({
  status: 'IN_PROGRESS', inning: 9, half: 'TOP', plateAppearances: 35,
  score: { away: 1, home: 2 },
  lineups: { away: ['BATTER'], home: ['HOME_BATTER'] },
  battingOrderIndex: { away: 0, home: 0 },
  defensiveAlignment: { away: {}, home: {} },
  currentPitcherId: { away: currentPitcherId, home: 'OPP_PITCHER' },
  bases: { first: null, second: null, third: null }, substitutions: []
});
const act = (currentPitcherId, awayBench) => createLateGameBenchManager({
  players, benchPlans: { away: awayBench.map(row), home: [] }
})({ state: state(currentPitcherId), battingTeam: 'away', fieldingTeam: 'home' });

test('active two-way pitcher cannot enter the batting order through bench AI', () => {
  assert.equal(act('TW_PITCHER', ['TW_PITCHER']), null);
});
test('bench AI selects an eligible alternative rather than the active pitcher', () => {
  const action = act('TW_PITCHER', ['TW_PITCHER', 'SAFE_BATTER']);
  assert.ok(action, 'healthy substitute must be available');
  assert.equal(action.reason, 'PINCH_HIT');
  assert.equal(action.inPlayerId, 'SAFE_BATTER');
});
test('two-way hitter remains eligible when they are not the current pitcher', () => {
  const action = act('OTHER_PITCHER', ['TW_PITCHER']);
  assert.ok(action);
  assert.equal(action.inPlayerId, 'TW_PITCHER');
});
