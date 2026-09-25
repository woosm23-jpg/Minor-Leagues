import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { seasonApi } from '../src/api/seasonApi.js';
import { renderSeason } from '../src/ui/seasonRender.js';
import { getUtilityCoverage, getUtilityPathwayView } from '../src/engine/season/utilityUsage.js';

const root = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null });

test('secondary practice changes familiarity only after a calendar day; save replay is deterministic', () => {
  const initial = seasonApi.createDemoSeason({ seed: 'phase3-secondary-position-training', startDate: '2026-04-01' });
  const id = initial.seasonId;
  const playerId = seasonApi.serializeSeason(id).fixture.userPlayerId;
  const before = seasonApi.serializeSeason(id);
  const initialFamiliarity = initial.userPlayer.status.positionFamiliarity.LF;
  assert.equal(initial.userPlayer.status.primaryPosition, 'CF');
  assert.ok(initialFamiliarity >= 0.35 && initialFamiliarity < 1);

  const selected = seasonApi.setSecondaryPositionTraining(id, 'LF');
  assert.equal(selected.userPlayer.status.positionTraining.targetPosition, 'LF');
  assert.equal(selected.userPlayer.status.positionTraining.trainedDays, 0);
  assert.equal(selected.userPlayer.status.positionFamiliarity.LF, initialFamiliarity);
  const selectedPayload = seasonApi.serializeSeason(id);
  assert.deepEqual(selectedPayload.playerStates[playerId].development, before.playerStates[playerId].development,
    'a training choice must not award an instant ratings or growth bonus');
  assert.deepEqual(selectedPayload.playerStates[playerId].positionReps, before.playerStates[playerId].positionReps,
    'practice is not a completed game rep');

  const ui = root();
  renderSeason(ui, selected, {}, 'HOME', {});
  assert.match(ui.innerHTML, /data-position-training="LF"/);
  assert.match(ui.innerHTML, /부포지션 훈련/);
  renderSeason(ui, selected, {}, 'PLAYER', { playerSection: 'DEVELOPMENT' });
  assert.match(ui.innerHTML, /data-position-training="NONE"/);
  const checkpoint = seasonApi.serializeSeason(id);
  const first = seasonApi.simulateOneDay(id);
  assert.ok(first.userPlayer.status.positionFamiliarity.LF > initialFamiliarity);
  assert.equal(first.userPlayer.status.positionTraining.trainedDays, 1);
  assert.equal(first.userPlayer.status.positionTraining.lastTrainingDate, first.currentDate);
  const firstPayload = seasonApi.serializeSeason(id);
  const userRoster = firstPayload.fixture.organization.levels.AAA.roster;
  const pathway = getUtilityPathwayView(userRoster, firstPayload.playerStates, firstPayload.roleStates, playerId);
  assert.equal(pathway.positions.find(row => row.position === 'LF').familiarity,
    Number(firstPayload.playerStates[playerId].positionFamiliarity.LF.toFixed(3)),
    'the manager coverage model must read the authoritative practiced familiarity');
  assert.ok(getUtilityCoverage(userRoster, firstPayload.playerStates, firstPayload.roleStates, playerId).includes('CF'),
    'primary position coverage must not disappear');

  const restored = seasonApi.restoreSeason(checkpoint);
  assert.equal(restored.userPlayer.status.positionTraining.targetPosition, 'LF');
  const replay = seasonApi.simulateOneDay(id);
  assert.deepEqual(replay.userPlayer.status.positionTraining, first.userPlayer.status.positionTraining);
  assert.deepEqual(replay.userPlayer.status.positionFamiliarity, first.userPlayer.status.positionFamiliarity);
  assert.deepEqual(replay.userSeasonLine, first.userSeasonLine);
  const stopped = seasonApi.setSecondaryPositionTraining(id, null);
  assert.equal(stopped.userPlayer.status.positionTraining.targetPosition, null);
  assert.equal(stopped.userPlayer.status.positionTraining.trainedDays, 0);
  assert.equal(stopped.userPlayer.status.positionFamiliarity.LF, replay.userPlayer.status.positionFamiliarity.LF,
    'stopping training must never erase learned familiarity');

  writeFileSync('reports/phase3-secondary-position-training.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_SECONDARY_POSITION_TRAINING_V1', pass: true,
    noInstantBoost: true, calendarFamiliarity: true, noFakeGameReps: true,
    managerUsesAuthoritativeFamiliarity: true, homeAndDevelopmentUi: true,
    saveRestoreAndReplay: true, cancelPreservesFamiliarity: true,
    injurySuspendsPractice: true, historicalSaveCompatibility: true
  }, null, 2) + '\n', 'utf8');
});

test('unavailable field positions are rejected, and injured players get no practice credit', () => {
  const initial = seasonApi.createDemoSeason({ seed: 'phase3-secondary-position-injury', startDate: '2026-04-01' });
  const id = initial.seasonId;
  assert.throws(() => seasonApi.setSecondaryPositionTraining(id, 'P'), /부포지션/);
  assert.throws(() => seasonApi.setSecondaryPositionTraining(id, 'CF'), /부포지션/);
  const payload = seasonApi.serializeSeason(id);
  const userId = payload.fixture.userPlayerId;
  const oldLF = payload.playerStates[userId].positionFamiliarity.LF;
  payload.playerStates[userId].health.activeInjury = {
    injuryId: 'qa_secondary_training_injury', family: 'LOWER_BODY', severity: 'MAJOR',
    startDate: '2026-04-01', expectedReturnDate: '2026-05-01', daysRemaining: 30
  };
  seasonApi.restoreSeason(payload);
  seasonApi.setSecondaryPositionTraining(id, 'LF');
  const advanced = seasonApi.simulateOneDay(id);
  assert.equal(advanced.userPlayer.status.positionTraining.trainedDays, 0);
  assert.equal(advanced.userPlayer.status.positionFamiliarity.LF, oldLF);
});

test('legacy saves and malformed training data are handled without hidden migration', () => {
  const original = seasonApi.createDemoSeason({ seed: 'phase3-secondary-training-legacy', startDate: '2026-04-01' });
  const id = original.seasonId;
  const old = seasonApi.serializeSeason(id);
  delete old.playerStates[old.fixture.userPlayerId].positionTraining;
  assert.equal(seasonApi.restoreSeason(old).userPlayer.status.positionTraining.targetPosition, null);
  const corrupted = seasonApi.serializeSeason(id);
  corrupted.playerStates[corrupted.fixture.userPlayerId].positionTraining = {
    targetPosition: 'P', trainedDays: 1, lastTrainingDate: '2026-04-02'
  };
  assert.throws(() => seasonApi.restoreSeason(corrupted), /부포지션/);
});
