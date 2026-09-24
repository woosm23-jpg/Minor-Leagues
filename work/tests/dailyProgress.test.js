import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { seasonApi } from '../src/api/seasonApi.js';

const fields = (snap) => ({
  currentDate: snap.currentDate,
  status: snap.status,
  userSeasonLine: snap.userSeasonLine,
  record: snap.record,
  worldGames: snap.progress.worldLeagueGamesCompleted,
  playerGames: snap.progress.gamesPlayed,
  events: snap.careerTimeline.events
});

test('One Day progresses the shared world once and resumes deterministically after restore', () => {
  const initial = seasonApi.createDemoSeason({
    seed: 'phase3-one-day-daily-progression', startDate: '2026-04-01'
  });
  const seasonId = initial.seasonId;
  const before = seasonApi.serializeSeason(seasonId);
  const day1 = seasonApi.simulateOneDay(seasonId);
  assert.equal(day1.lastProgress.command, 'ONE_DAY');
  assert.equal(day1.lastProgress.startedDate, '2026-04-01');
  assert.equal(day1.lastProgress.targetDate, '2026-04-02');
  assert.equal(day1.currentDate, '2026-04-02');
  assert.equal(day1.lastProgress.daysAdvanced, 1);
  assert.ok(day1.progress.worldLeagueGamesCompleted > initial.progress.worldLeagueGamesCompleted);
  const saveDay1 = seasonApi.serializeSeason(seasonId);
  const restoreDay1 = seasonApi.restoreSeason(saveDay1);
  assert.deepEqual(fields(restoreDay1), fields(day1));

  const day2 = seasonApi.simulateOneDay(seasonId);
  assert.equal(day2.lastProgress.command, 'ONE_DAY');
  assert.equal(day2.currentDate, '2026-04-03');
  assert.ok(day2.progress.worldLeagueGamesCompleted >= day1.progress.worldLeagueGamesCompleted);
  const saveDay2 = seasonApi.serializeSeason(seasonId);

  seasonApi.restoreSeason(saveDay1);
  const day2Replay = seasonApi.simulateOneDay(seasonId);
  const saveDay2Replay = seasonApi.serializeSeason(seasonId);
  assert.deepEqual(fields(day2Replay), fields(day2));
  assert.deepEqual(saveDay2Replay.levelSeasons, saveDay2.levelSeasons);
  assert.deepEqual(saveDay2Replay.playerStates, saveDay2.playerStates);
  assert.deepEqual(saveDay2Replay.roleStates, saveDay2.roleStates);
  assert.deepEqual(saveDay2Replay.organizationState, saveDay2.organizationState);

  seasonApi.restoreSeason(before);
  const day1Replay = seasonApi.simulateOneDay(seasonId);
  assert.deepEqual(fields(day1Replay), fields(day1));

  writeFileSync('reports/phase3-one-day-progression.json', JSON.stringify({
    schema: 'THE_CALL_UP_PHASE3_ONE_DAY_PROGRESSION_V1',
    pass: true,
    firstDate: day1.currentDate,
    secondDate: day2.currentDate,
    firstDayWorldGames: day1.lastProgress.worldGamesSimulated,
    userAndAiSharedCalendar: day1.progress.worldLeagueGamesCompleted > 0,
    saveRestore: true,
    replayDeterministic: true
  }, null, 2) + '\n', 'utf8');
});