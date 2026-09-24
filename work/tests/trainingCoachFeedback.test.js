import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { getTrainingCoachFeedback } from '../src/engine/season/coachingFeedback.js';
import { seasonApi } from '../src/api/seasonApi.js';
import { renderSeason } from '../src/ui/seasonRender.js';

test('coach advice uses public sample and current role, never true potential', () => {
  assert.equal(getTrainingCoachFeedback({ seasonLine: { PA: 100, SO: 31, BB: 9 } }).recommendedFocus, 'CONTACT');
  assert.equal(getTrainingCoachFeedback({ seasonLine: { PA: 100, SO: 12, BB: 3 } }).recommendedFocus, 'PLATE_DISCIPLINE');
  assert.equal(getTrainingCoachFeedback({ seasonLine: { PA: 15, SO: 10, BB: 0 } }).recommendedFocus, 'BALANCED');
  const hidden = { get() { throw Error('hidden potential must not be accessed'); } };
  const line = { PA: 12, SO: 1, BB: 2 };
  const role = { role: 'UTILITY' };
  const usage = { secondaryGames: 3 };
  for (const obj of [line, role, usage]) Object.defineProperty(obj, 'trueCeiling', hidden);
  const utility = getTrainingCoachFeedback({
    seasonLine: line, roleState: role, playingTime: usage, currentFocus: 'SPEED'
  });
  assert.equal(utility.recommendedFocus, 'DEFENSE');
  assert.equal(utility.aligned, false);
  assert.equal(utility.effect, 'DEVELOPMENT_ALLOCATION_ONLY');
});

test('player choice, live coach view, balanced control, and save/replay remain consistent', () => {
  const initial = seasonApi.createDemoSeason({ seed: 'phase3-training-coach-feedback', startDate: '2026-04-01' });
  const id = initial.seasonId;
  assert.equal(initial.userPlayer.coaching.recommendedFocus, 'BALANCED');
  assert.equal(initial.userPlayer.coaching.aligned, true);
  const before = seasonApi.serializeSeason(id);
  const changed = seasonApi.setTrainingFocus(id, 'POWER');
  assert.equal(changed.userPlayer.status.development.focus, 'POWER');
  assert.equal(changed.userPlayer.coaching.selectedFocus, 'POWER');
  assert.equal(changed.userPlayer.coaching.aligned, false);
  assert.deepEqual(seasonApi.serializeSeason(id).playerStates[before.fixture.userPlayerId].development.progress,
    before.playerStates[before.fixture.userPlayerId].development.progress,
    'coach recommendation must not award instant progress or ratings');

  const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  renderSeason(root, changed, {}, 'HOME', {});
  assert.match(root.innerHTML, /data-training-focus="BALANCED"/);
  assert.match(root.innerHTML, /코치 제안/);
  assert.match(root.innerHTML, /내 선택/);
  renderSeason(root, changed, {}, 'PLAYER', { playerSection: 'DEVELOPMENT' });
  assert.match(root.innerHTML, /코치 제안/);

  const checkpoint = seasonApi.serializeSeason(id);
  const restored = seasonApi.restoreSeason(checkpoint);
  assert.deepEqual(restored.userPlayer.coaching, changed.userPlayer.coaching);
  assert.equal(restored.userPlayer.status.development.focus, 'POWER');

  const afterDay = seasonApi.simulateOneDay(id);
  const dayPayload = seasonApi.serializeSeason(id);
  const replay = seasonApi.restoreSeason(dayPayload);
  assert.deepEqual(replay.userPlayer.coaching, afterDay.userPlayer.coaching);
  assert.equal(replay.userPlayer.status.development.focus, 'POWER');

  const reset = seasonApi.setTrainingFocus(id, 'BALANCED');
  assert.equal(reset.userPlayer.coaching.selectedFocus, 'BALANCED');
  assert.equal(reset.userPlayer.coaching.aligned, reset.userPlayer.coaching.recommendedFocus === 'BALANCED');

  writeFileSync('reports/phase3-training-coach-feedback.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_TRAINING_COACH_FEEDBACK_V1',
    pass: true,
    playerFocusChangesPersist: true,
    adviceUsesOnlyPublicInputs: true,
    noInstantProgressBonus: true,
    balancedChoiceAvailable: true,
    homeAndDevelopmentUi: true,
    saveRestoreAndOneDayReplay: true
  }, null, 2) + '\n', 'utf8');
});
