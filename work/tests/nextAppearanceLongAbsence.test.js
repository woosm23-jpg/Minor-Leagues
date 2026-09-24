import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { seasonApi } from '../src/api/seasonApi.js';

test('Next Appearance survives more than 24 consecutive injury absences and save/restore', () => {
  const initial = seasonApi.createDemoSeason({
    seed: 'phase3-next-appearance-long-absence', startDate: '2026-04-01'
  });
  const payload = seasonApi.serializeSeason(initial.seasonId);
  const userId = payload.fixture.userPlayerId;
  assert.ok(payload.playerStates[userId], 'user player state must exist');
  // Force one long absence in a reproducible demo season; this is a QA
  // injection, not evidence of the naturally occurring injury distribution.
  payload.playerStates[userId].health.activeInjury = {
    injuryId: 'qa_long_absence', family: 'LOWER_BODY', severity: 'MAJOR',
    startDate: '2026-04-01', expectedReturnDate: '2027-01-01', daysRemaining: 275
  };
  seasonApi.restoreSeason(payload);
  const before = seasonApi.getSeason(initial.seasonId);
  const after = seasonApi.startCurrentGame(initial.seasonId);
  assert.ok(after.progress.gamesPlayed > 24,
    `long-absence regression must pass 24 team games; observed ${after.progress.gamesPlayed}`);
  assert.equal(after.activeGame, null, 'injured user must not be forced into a game');
  assert.equal(after.nextGame, null, 'the demo team schedule must be consumed');
  const checkpoint = seasonApi.serializeSeason(initial.seasonId);
  const recovered = seasonApi.restoreSeason(checkpoint);
  assert.equal(recovered.progress.gamesPlayed, after.progress.gamesPlayed);
  assert.equal(recovered.userSeasonLine.G, after.userSeasonLine.G);
  assert.equal(recovered.activeGame, null);
  assert.equal(checkpoint.playerStates[userId].health.activeInjury?.daysRemaining > 0, true);
  writeFileSync('reports/phase3-next-appearance-long-absence.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_NEXT_APPEARANCE_LONG_ABSENCE_V1',
    pass: true,
    fixture: 'DEMO_FORCED_LONG_INJURY',
    userTeamGamesBefore: before.progress.gamesPlayed,
    userTeamGamesAfter: after.progress.gamesPlayed,
    skippedUserTeamGames: after.progress.gamesPlayed - before.progress.gamesPlayed,
    noForcedAppearance: after.activeGame === null,
    saveRestore: recovered.progress.gamesPlayed === after.progress.gamesPlayed
  }, null, 2) + '\n', 'utf8');
});
