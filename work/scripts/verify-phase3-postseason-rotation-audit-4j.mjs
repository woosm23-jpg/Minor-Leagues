import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { seasonApi } from '../src/api/seasonApi.js';
import { selectPostseasonStarter, requiredRestDays } from '../src/engine/career/postseasonRotationPolicy.js';
import { createPitcherSeasonState, pitcherAvailability, recoverPitcherSeasonState } from '../src/engine/season/pitcherSeasonState.js';
import { validateSeasonSavePayload } from '../src/services/seasonSerialization.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = 'reports/phase3-postseason-rotation-audit-4j-v1.json';
const SNAPSHOT = 'data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz';
const AUDITED_ROUND = 'WILD_CARD';
const DAY_MS = 86400000;
const day = iso => {
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/, 'invalid YYYY-MM-DD');
  const value = Date.parse(`${iso}T00:00:00Z`);
  assert.ok(Number.isFinite(value) && new Date(value).toISOString().slice(0,10) === iso, `invalid date: ${iso}`);
  return value / DAY_MS;
};
const between = (from, to) => {
  const gap = day(to) - day(from);
  assert.ok(Number.isInteger(gap) && gap >= 0, `calendar moved backward: ${from} -> ${to}`);
  return gap;
};

function replayOpeningDecision({ opening, game, side }) {
  const teamId = String(game[`${side}TeamId`]);
  const original = opening.fixture.levelLeagues.MLB.rosters[teamId];
  const eligible = new Set((opening.postseasonState.rosters[teamId] ?? []).map(String));
  assert.ok(original && eligible.size >= 20, `missing postseason team: ${teamId}`);
  const filtered = {
    ...original,
    pitchers: (original.pitchers ?? []).filter(id => eligible.has(String(id))),
    starters: (original.starters ?? []).filter(id => eligible.has(String(id))),
    bullpen: (original.bullpen ?? []).filter(id => eligible.has(String(id)))
  };
  const sinceOpening = between(opening.playerStateDate, game.date);
  const pregame = { ...opening.pitcherStates };
  for (const id of filtered.pitchers) {
    const player = original.players?.[id];
    assert.ok(player?.pitching, `missing pitching profile for ${teamId}/${id}`);
    const current = opening.pitcherStates[id] ?? createPitcherSeasonState(player);
    pregame[id] = sinceOpening > 0 ? recoverPitcherSeasonState(current, player, sinceOpening) : current;
  }
  const picked = selectPostseasonStarter(filtered, pregame, {gameDate:game.date, gameIndex:0, rotationSize:3});
  const actualStarterId = game[`${side}StarterId`];
  const actualReason = game[`${side}StarterReason`];
  assert.equal(picked.starterId, actualStarterId, `opening starter replay differs: ${game.gameId}/${side}`);
  assert.equal(picked.reason, actualReason, `opening starter reason replay differs: ${game.gameId}/${side}`);

  const scheduledId = filtered.starters[0] ?? null;
  const scheduled = scheduledId ? pregame[scheduledId] : null;
  const availability = pitcherAvailability(scheduled);
  const fatigue = Number(scheduled?.fatigue ?? 0);
  const lastPitchCount = Number(scheduled?.lastPitchCount ?? 0);
  const lastAppearanceDate = scheduled?.lastAppearanceDate ?? null;
  const daysSinceLastAppearance = lastAppearanceDate ? between(lastAppearanceDate, game.date) : null;
  const minimumRestGap = requiredRestDays(lastPitchCount);
  const scheduledRested = availability !== 'INJURED' && availability !== 'UNAVAILABLE' && fatigue < 58 &&
    (daysSinceLastAppearance == null || daysSinceLastAppearance >= minimumRestGap);
  let reasonForFallback = 'SCHEDULED_USED';
  if (actualStarterId !== scheduledId) {
    if (!scheduledId) reasonForFallback = 'SCHEDULED_NOT_ON_ROSTER';
    else if (availability === 'INJURED') reasonForFallback = 'SCHEDULED_INJURED';
    else if (availability === 'UNAVAILABLE') reasonForFallback = 'SCHEDULED_UNAVAILABLE';
    else if (fatigue >= 58) reasonForFallback = 'SCHEDULED_FATIGUE_ABOVE_START_CAP';
    else if (daysSinceLastAppearance !== null && daysSinceLastAppearance < minimumRestGap) reasonForFallback = 'SCHEDULED_SHORT_REST';
    else if (scheduledRested && availability === 'LIMITED') reasonForFallback = 'READY_BACKUP_CHOSEN_OVER_RESTED_LIMITED_STARTER';
    else reasonForFallback = 'UNEXPLAINED_POLICY_DECISION';
  }
  assert.notEqual(reasonForFallback, 'UNEXPLAINED_POLICY_DECISION', `${game.gameId}/${side}: unexplained first-game fallback`);
  return {
    gameId:game.gameId, date:game.date, seriesId:game.seriesId ?? null, teamId, side,
    scheduledStarterId:scheduledId, actualStarterId, actualReason, replayMatched:true,
    scheduled:{availability, fatigue:Number(fatigue.toFixed(3)), lastAppearanceDate, lastPitchCount,
      daysSinceLastAppearance, minimumRestGap, rested:scheduledRested},
    selected:{daysSinceLastAppearance:picked.daysSinceLastAppearance,lastPitchCount:picked.lastPitchCount,
      pregameFatigue:picked.pregameFatigue}, reasonForFallback
  };
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT,'reports/phase3-postseason-short-rotation-4i-v1.json'),'utf8'));
  assert.equal(baseline.pass,true);
  assert.equal(baseline.snapshotHash,'fnv1a32:f7b34713');
  assert.equal(baseline.wildCard.starterAssignments,20);
  const master = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT,SNAPSHOT))).toString('utf8'));
  assert.equal(master.metadata.contentHash,baseline.snapshotHash);
  const org = seasonApi.getCareerCreationCatalog({masterSnapshot:master}).organizations[0];
  const input = {name:'4J QA',nationality:'대한민국',hometown:'구미',age:18,heightCm:180,weightKg:78,
    bodyType:'ATHLETIC',bats:'R',throws:'R',primaryPosition:'SS',archetype:'BALANCED',
    visibleTraits:['QUICK_BAT','SOFT_HANDS'],organizationMode:'FAVORITE',favoriteOrganizationId:String(org.id)};
  let session = seasonApi.createCareerSeason({seed:baseline.seed,input,masterSnapshot:master});
  session = seasonApi.simulateToSeasonEnd(session.seasonId);
  assert.equal(session.status,'COMPLETE');
  session = seasonApi.startPostseason(session.seasonId);
  const opening = seasonApi.serializeSeason(session.seasonId);
  assert.equal(validateSeasonSavePayload(opening,{mode:'FULL'}),true);
  session = seasonApi.advancePostseasonRound(session.seasonId);
  const after = seasonApi.serializeSeason(session.seasonId);
  assert.equal(validateSeasonSavePayload(after,{mode:'FULL'}),true);
  assert.deepEqual(after.levelSeasons.MLB,opening.levelSeasons.MLB,'regular season MLB standings or stats changed');
  const series = after.postseasonState.rounds[AUDITED_ROUND];
  assert.equal(series.length,4);
  const fullReasons = {};
  for (const group of series) for (const game of group.games) {
    for (const side of ['away','home']) {
      const reason = game[`${side}StarterReason`];
      fullReasons[reason] = (fullReasons[reason] ?? 0) + 1;
    }
  }
  assert.equal(series.reduce((n,group)=>n+group.games.length,0),baseline.wildCard.gameCount);
  assert.deepEqual(fullReasons,baseline.wildCard.reasonCounts,'previously verified 4I reason counts changed');
  const openingDecisions = [];
  for (const group of series) {
    assert.ok(group.games.length > 0);
    for (const side of ['away','home']) openingDecisions.push(replayOpeningDecision({opening,game:group.games[0],side}));
  }
  assert.equal(openingDecisions.length,8);
  assert.equal(new Set(openingDecisions.map(x=>x.teamId)).size,8,'first-game teams must not overlap');
  const openingReasons = {};
  for (const row of openingDecisions) openingReasons[row.reasonForFallback] = (openingReasons[row.reasonForFallback]??0)+1;
  const report = {schema:'THE_CALL_UP_PHASE3_POSTSEASON_ROTATION_AUDIT_4J_V1',pass:true,
    mode:'READ_ONLY_BASELINE',snapshotHash:baseline.snapshotHash,seed:baseline.seed,startingStateDate:opening.playerStateDate,
    wildCard:{seriesCount:series.length,gameCount:baseline.wildCard.gameCount,starterAssignments:baseline.wildCard.starterAssignments,
      allGameReasonCounts:fullReasons,openingGameTeamCount:openingDecisions.length,openingFallbackReasonCounts:openingReasons,
      openingDecisions},
    gates:{replayedOpeningSelections:openingDecisions.length,allOpeningSelectionsMatch:true,
      prior4iReasonCountsUnchanged:true,regularSeasonStatsUnchanged:true,fullSaveValid:true},
    interpretation:'Opening-game diagnosis is precise for all eight distinct Wild Card teams. Later-game pregame states are not claimed without per-game snapshots.'};
  fs.mkdirSync(path.join(ROOT,'reports'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,REPORT),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({schema:report.schema,pass:report.pass,wildCard:{gameCount:report.wildCard.gameCount,allGameReasonCounts:fullReasons,openingFallbackReasonCounts:openingReasons,openingDecisions:openingDecisions.map(r=>({teamId:r.teamId,scheduledStarterId:r.scheduledStarterId,actualStarterId:r.actualStarterId,reasonForFallback:r.reasonForFallback,scheduled:r.scheduled}))},gates:report.gates},null,2));
}
try { main(); } catch(error) { console.error(error); process.exitCode = 1; }
