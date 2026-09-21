import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { seasonApi } from '../src/api/seasonApi.js';

const LEVELS = ['MLB', 'AAA', 'AA', 'HIGH_A', 'A'];
const SNAPSHOT_PATH = 'data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz';
const REPORT_PATH = 'reports/v50-production-season-rollover.json';
const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAPSHOT_PATH)).toString('utf8'));
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30);

const input = {
  name: 'Rollover QA', nationality: '대한민국', hometown: '구미', age: 18,
  heightCm: 180, weightKg: 78, bodyType: 'ATHLETIC', bats: 'R', throws: 'R',
  primaryPosition: 'SS', archetype: 'HIT_FIRST', visibleTraits: ['QUICK_BAT', 'SOFT_HANDS'],
  organizationMode: 'FAVORITE', favoriteOrganizationId: String(catalog.organizations[0].id)
};

function levelRosterCounts(fixture) {
  return Object.fromEntries(LEVELS.map((level) => [
    level,
    Object.values(fixture.levelLeagues[level].rosters)
      .reduce((sum, roster) => sum + Object.keys(roster.players).length, 0)
  ]));
}

const startedAt = Date.now();
const created = seasonApi.createCareerSeason({ seed: 'v50-production-rollover-ci-v2', input, masterSnapshot: snapshot });
const before = seasonApi.serializeSeason(created.seasonId);
assert.equal(before.fixture.worldMode, 'PRODUCTION_REAL');
assert.equal(before.fixture.startDate, '2026-03-25');
const initialCounts = levelRosterCounts(before.fixture);

const completed = seasonApi.simulateToSeasonEnd(created.seasonId);
assert.equal(completed.status, 'COMPLETE');
assert.equal(completed.seasonYear, 2026);
assert.equal(completed.progress.worldLeagueGamesCompleted, completed.progress.worldLeagueGamesTotal);
for (const level of LEVELS) {
  assert.equal(completed.userStatsByLevel[level].leagueGamesCompleted, completed.userStatsByLevel[level].leagueGamesTotal, `${level} incomplete`);
}

const next = seasonApi.advanceToNextSeason(created.seasonId);
assert.equal(next.seasonYear, 2027);
assert.equal(next.status, 'REGULAR_SEASON');
assert.equal(next.startDate, '2027-03-25');
assert.equal(next.progress.worldLeagueGamesCompleted, 0);
assert.ok(next.progress.worldLeagueGamesTotal > 0);
assert.equal(next.leagueEcology?.year, 2027);
assert.ok(next.leagueEcology?.lastOffseason);
assert.equal(next.leagueEcology.lastOffseason.retired, next.leagueEcology.lastOffseason.generated);

const after = seasonApi.serializeSeason(created.seasonId);
assert.deepEqual(levelRosterCounts(after.fixture), initialCounts);
assert.ok(after.fixture.organization.levels[after.fixture.organization.userLevel].roster.players[after.fixture.userPlayerId]);

const saved = seasonApi.serializeSeason(created.seasonId);
const restored = seasonApi.restoreSeason(structuredClone(saved));
assert.equal(restored.seasonYear, 2027);
assert.equal(restored.status, 'REGULAR_SEASON');
const restoredPayload = seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(levelRosterCounts(restoredPayload.fixture), initialCounts);
assert.deepEqual(restoredPayload.leagueEcologyState, saved.leagueEcologyState);

const report = {
  schema: 'THE_CALL_UP_PRODUCTION_SEASON_ROLLOVER_V50_V2',
  pass: true,
  durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  completedSeason: {
    year: completed.seasonYear,
    worldGamesCompleted: completed.progress.worldLeagueGamesCompleted,
    worldGamesTotal: completed.progress.worldLeagueGamesTotal
  },
  nextSeason: {
    year: next.seasonYear,
    startDate: next.startDate,
    worldGamesCompleted: next.progress.worldLeagueGamesCompleted,
    worldGamesTotal: next.progress.worldLeagueGamesTotal
  },
  ecology: {
    retired: next.leagueEcology.lastOffseason.retired,
    generated: next.leagueEcology.lastOffseason.generated,
    totalRetired: next.leagueEcology.totalRetired,
    totalGenerated: next.leagueEcology.totalGenerated
  },
  levelRosterCounts: initialCounts,
  saveRoundTrip: true
};
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
