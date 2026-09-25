import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { seasonApi } from '../src/api/seasonApi.js';
import { renderSeason } from '../src/ui/seasonRender.js';
import { rolePreferenceLineupBonus, getRolePreferenceView,
  validatePlayerRolePreference } from '../src/engine/season/rolePreference.js';

const uiRoot = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null });

test('preference only gives a capped nudge after manager role and coverage qualify', () => {
  const everyday = { mode: 'EVERYDAY', requestedDate: '2026-04-01' };
  const versatile = { mode: 'VERSATILE', requestedDate: '2026-04-01' };
  assert.equal(rolePreferenceLineupBonus({ preference: everyday,
    role: 'AAA_STARTER', baselineStarter: true }), 0.35);
  assert.equal(rolePreferenceLineupBonus({ preference: everyday,
    role: 'BENCH', baselineStarter: true }), 0);
  assert.equal(rolePreferenceLineupBonus({ preference: everyday,
    role: 'AAA_STARTER', baselineStarter: false }), 0);
  assert.equal(rolePreferenceLineupBonus({ preference: versatile,
    role: 'UTILITY', baselineStarter: false, position: 'LF',
    primaryPosition: 'CF', coverageEligible: true }), 0.35);
  assert.equal(rolePreferenceLineupBonus({ preference: versatile,
    role: 'UTILITY', baselineStarter: false, position: 'LF',
    primaryPosition: 'CF', coverageEligible: false }), 0);
  assert.equal(rolePreferenceLineupBonus({ preference: versatile,
    role: 'AAA_STARTER', baselineStarter: false, position: 'LF',
    primaryPosition: 'CF', coverageEligible: true }), 0);
  assert.equal(getRolePreferenceView({ rolePreference: versatile },
    { role: 'UTILITY' }, { gamesPlayed: 8, secondaryGames: 3 }).fitBand, 'ALIGNED');
  assert.equal(getRolePreferenceView({ rolePreference: versatile },
    { role: 'BENCH' }, { gamesPlayed: 8, secondaryGames: 0 }).fitBand, 'NOT_YET');
  assert.equal(validatePlayerRolePreference(null), true);
});

test('player role preference UI, state, autosave source and day replay', () => {
  const first = seasonApi.createDemoSeason({ seed: 'phase3-role-preference', startDate: '2026-04-01' });
  const id = first.seasonId;
  const before = seasonApi.serializeSeason(id);
  const playerId = before.fixture.userPlayerId;
  assert.equal(first.userRole.preference.mode, 'OPEN');
  const chosen = seasonApi.setRolePreference(id, 'EVERYDAY');
  assert.equal(chosen.userRole.preference.mode, 'EVERYDAY');
  assert.equal(chosen.userRole.preference.requestedDate, chosen.currentDate);
  const saved = seasonApi.serializeSeason(id);
  assert.deepEqual(saved.playerStates[playerId].development, before.playerStates[playerId].development,
    'request must not award ratings or development progress');
  assert.deepEqual(saved.playerStates[playerId].health, before.playerStates[playerId].health,
    'request must not modify fatigue or injury');
  assert.deepEqual(saved.roleStates, before.roleStates,
    'manager-assigned roles cannot be rewritten by a request');
  const ui = uiRoot();
  renderSeason(ui, chosen, {}, 'HOME', {});
  assert.match(ui.innerHTML, /data-role-preference="EVERYDAY"/);
  assert.match(ui.innerHTML, /역할 선호/);
  assert.match(ui.innerHTML, /구단 판단/);
  const checkpoint = seasonApi.serializeSeason(id);
  const afterDay = seasonApi.simulateOneDay(id);
  seasonApi.restoreSeason(checkpoint);
  const replay = seasonApi.simulateOneDay(id);
  assert.deepEqual(replay.userRole.preference, afterDay.userRole.preference);
  assert.deepEqual(replay.userSeasonLine, afterDay.userSeasonLine);
  assert.equal(replay.currentDate, afterDay.currentDate);
  const flexible = seasonApi.setRolePreference(id, 'VERSATILE');
  assert.equal(flexible.userRole.preference.mode, 'VERSATILE');
  const reset = seasonApi.setRolePreference(id, 'OPEN');
  assert.equal(reset.userRole.preference.mode, 'OPEN');
  assert.equal(reset.userRole.preference.fitBand, 'OPEN');
});

test('historical saves load and invalid role requests fail in the normal restore path', () => {
  const initial = seasonApi.createDemoSeason({ seed: 'phase3-role-preference-legacy', startDate: '2026-04-01' });
  const id = initial.seasonId;
  const legacy = seasonApi.serializeSeason(id);
  delete legacy.playerStates[legacy.fixture.userPlayerId].rolePreference;
  assert.equal(seasonApi.restoreSeason(legacy).userRole.preference.mode, 'OPEN');
  const invalid = seasonApi.serializeSeason(id);
  invalid.playerStates[invalid.fixture.userPlayerId].rolePreference =
    { mode: 'GUARANTEED_STARTER', requestedDate: '2026-04-01' };
  assert.throws(() => seasonApi.restoreSeason(invalid), /역할 선호/);
  assert.throws(() => seasonApi.setRolePreference(id, 'GUARANTEED_STARTER'), /역할 선호/);
  writeFileSync('reports/phase3-role-preference.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_ROLE_PREFERENCE_V1', pass: true,
    cappedManagerConsideration: true, noGuaranteedRole: true,
    noHiddenRatingsOrFatigueBoost: true, homeUi: true,
    saveRestoreAndReplay: true, historicalSaveCompatibility: true,
    strictInvalidSaveRejection: true
  }, null, 2) + '\n', 'utf8');
});
