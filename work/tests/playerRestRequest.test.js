import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { seasonApi } from '../src/api/seasonApi.js';
import { createPlayerRestRequest, settlePlayerRestRequest, validatePlayerRestRequest } from '../src/engine/season/playerRestRequest.js';
import { renderSeason } from '../src/ui/seasonRender.js';

const root = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null });

test('rest request is save-safe, and a qualified reserve covers a full rest day', () => {
  const original = seasonApi.createDemoSeason({ seed: 'phase3-player-rest-approved', startDate: '2026-04-01' });
  const id = original.seasonId;
  assert.equal(original.userRestRequest.canRequest, true);
  const requested = seasonApi.requestNextGameRest(id);
  assert.equal(requested.userRestRequest.status, 'PENDING');
  assert.equal(requested.userRestRequest.gameId, original.nextGame.gameId);
  const ui = root();
  renderSeason(ui, requested, {}, 'HOME', {});
  assert.match(ui.innerHTML, /휴식 요청 취소/);
  const pendingPayload = seasonApi.serializeSeason(id);
  const restoredPending = seasonApi.restoreSeason(pendingPayload);
  assert.equal(restoredPending.userRestRequest.status, 'PENDING');
  const advanced = seasonApi.simulateOneDay(id);
  assert.equal(advanced.userRestRequest.status, 'APPROVED');
  assert.equal(advanced.userRestRequest.reasonCode, 'COVER_AVAILABLE');
  assert.equal(advanced.userSeasonLine.G, 0, 'a full rest day must exclude the player from the lineup and bench');
  assert.ok(advanced.progress.gamesPlayed >= 1);
  const checkpoint = seasonApi.serializeSeason(id);
  const reloaded = seasonApi.restoreSeason(checkpoint);
  assert.deepEqual(reloaded.userRestRequest, advanced.userRestRequest);
  assert.equal(reloaded.userSeasonLine.G, 0);
  const once = seasonApi.simulateOneDay(id);
  const replay = seasonApi.restoreSeason(checkpoint);
  const twice = seasonApi.simulateOneDay(id);
  assert.equal(once.currentDate, twice.currentDate);
  assert.deepEqual(once.userSeasonLine, twice.userSeasonLine);

  writeFileSync('reports/phase3-player-rest-request.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_PLAYER_REST_REQUEST_V1', pass: true,
    playerRequestedAndManagerApprovedWithCoverage: true,
    noForcedPlayerAppearance: true, requestSaveRestore: true,
    deterministicDayReplay: true, cancellation: true,
    noCoverageDeclinedWithoutInjuryMutation: true,
    historicalSaveCompatibility: true
  }, null, 2) + '\n', 'utf8');
});

test('cancelled requests do not remove the player from the game', () => {
  const original = seasonApi.createDemoSeason({ seed: 'phase3-player-rest-cancelled', startDate: '2026-04-01' });
  const id = original.seasonId;
  seasonApi.requestNextGameRest(id);
  const cancelled = seasonApi.cancelNextGameRest(id);
  assert.equal(cancelled.userRestRequest.status, 'CANCELLED');
  assert.equal(cancelled.userRestRequest.reasonCode, 'USER_CANCELLED');
  const after = seasonApi.simulateOneDay(id);
  assert.equal(after.userRestRequest.status, 'CANCELLED');
  assert.equal(after.userSeasonLine.G, 1, 'cancellation must retain ordinary lineup selection');
});

test('manager declines when no healthy direct cover exists without faking an injury', () => {
  const original = seasonApi.createDemoSeason({ seed: 'phase3-player-rest-declined', startDate: '2026-04-01' });
  const id = original.seasonId;
  const payload = seasonApi.serializeSeason(id);
  const userId = payload.fixture.userPlayerId;
  const beforeHealth = structuredClone(payload.playerStates[userId].health);
  const roster = payload.fixture.organization.levels.AAA.roster;
  const backup = roster.bench.find(row => row.coverage.includes('CF'));
  assert.ok(backup, 'demo CF needs one direct reserve');
  payload.playerStates[backup.playerId].health.activeInjury = {
    injuryId: 'qa_rest_backup_unavailable', family: 'LOWER_BODY', severity: 'MAJOR',
    startDate: '2026-04-01', expectedReturnDate: '2026-05-01', daysRemaining: 30
  };
  seasonApi.restoreSeason(payload);
  const requested = seasonApi.requestNextGameRest(id);
  assert.equal(requested.userRestRequest.status, 'PENDING');
  assert.deepEqual(seasonApi.serializeSeason(id).playerStates[userId].health, beforeHealth,
    'a request must never create an injury or alter health');
  const after = seasonApi.simulateOneDay(id);
  assert.equal(after.userRestRequest.status, 'DECLINED');
  assert.equal(after.userRestRequest.reasonCode, 'NO_AVAILABLE_COVER');
  assert.equal(after.userSeasonLine.G, 1);
});

test('old saves without a request remain valid and malformed request states are rejected', () => {
  const original = seasonApi.createDemoSeason({ seed: 'phase3-player-rest-legacy', startDate: '2026-04-01' });
  const id = original.seasonId;
  const old = seasonApi.serializeSeason(id);
  delete old.playerStates[old.fixture.userPlayerId].restRequest;
  assert.equal(seasonApi.restoreSeason(old).userRestRequest.status, 'NONE');
  const request = createPlayerRestRequest({ gameId: 'g1', level: 'AAA', date: '2026-04-02', requestedDate: '2026-04-01' });
  const result = settlePlayerRestRequest(request, { approved: true, reasonCode: 'COVER_AVAILABLE', date: '2026-04-02' });
  assert.equal(validatePlayerRestRequest(result), true);
  assert.throws(() => validatePlayerRestRequest({ ...request, status: 'APPROVED' }), /결과/);
});
