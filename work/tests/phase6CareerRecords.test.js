import assert from "node:assert/strict";
import test from "node:test";
import { createRetirementHallState, recordMlbSeason, getRetirementHallPublicView }
  from "../src/engine/career/retirementHallOfFame.js";
import { getCareerRecordsPublicView } from "../src/engine/career/careerRecords.js";
import { seasonApi } from "../src/api/seasonApi.js";
import { renderSeason } from "../src/ui/seasonRender.js";

const hitter = (id, name, H, HR, teamId = "A") => ({
  playerId: id, name, teamId, position: "CF", isPitcher: false,
  batting: { G: 120, PA: 500, AB: 450, H, HR, RBI: HR * 2, SB: 10, BB: 40 }, pitching: {}
});
const pitcher = (id, SO, outs) => ({
  playerId: id, name: `Pitcher ${id}`, teamId: "B", position: "SP", isPitcher: true,
  batting: {}, pitching: { G: 30, BF: 700, SO, outsRecorded: outs, H: 120, BB: 30 }
});
const makeState = () => {
  let state = createRetirementHallState({ seed: "career-records-test", userPlayerId: "h1", startYear: 2026 });
  state = recordMlbSeason(state, { year: 2026, players: [
    hitter("h1", "User Hitter", 180, 30), hitter("h2", "<img onerror=1>", 170, 45),
    pitcher("p1", 220, 540)
  ] });
  return recordMlbSeason(state, { year: 2027, players: [
    hitter("h1", "User Hitter", 190, 32, "C"),
    hitter("h2", "<img onerror=1>", 170, 45), pitcher("p1", 230, 549)
  ] });
};

test("career leaderboard uses actual per-player accumulated MLB ledger and team changes do not duplicate a player", () => {
  const state = makeState();
  const model = getCareerRecordsPublicView(state);
  assert.equal(model.scope, "SIMULATED_MLB_IN_THIS_SAVE_ONLY");
  assert.deepEqual(model.includedSeasons, [2026, 2027]);
  assert.deepEqual(state.careerLedger.h1.teams, ["A", "C"]);
  assert.equal(model.categories.H.leaders[0].value, 370);
  assert.equal(model.categories.H.leaders[0].playerId, "h1");
  assert.equal(model.categories.H.userRank, 1);
  assert.equal(model.categories.H.totalEligible, 2);
  assert.equal(model.categories.HR.leaders[0].playerId, "h2");
  assert.equal(model.categories.SO.leaders[0].value, 450);
  assert.equal(model.categories.IP.leaders[0].display, "363.0");
  assert.equal(model.categories.SO.userRank, null);
  assert.equal(model.categories.HR.unit, "COUNT");
});

test("history read model caches immutable state, does not mutate save data, and excludes duplicate season processing", () => {
  const state = makeState();
  const before = JSON.stringify(state);
  const first = getRetirementHallPublicView(state).careerRecords;
  assert.strictEqual(first, getRetirementHallPublicView(state).careerRecords);
  assert.strictEqual(first, getCareerRecordsPublicView(state));
  assert.equal(JSON.stringify(state), before);
  assert.strictEqual(recordMlbSeason(state, { year: 2027, players: [hitter("h1", "User Hitter", 9999, 9999)] }), state);
  const restored = structuredClone(state);
  assert.deepEqual(getCareerRecordsPublicView(restored), first);
  assert.ok(Object.isFrozen(first.categories.H.leaders[0]));
  assert.equal(getCareerRecordsPublicView(null), null);
  assert.equal(getRetirementHallPublicView(null), null);
});

test("minor-only and zero-appearance players do not appear as MLB career leaders", () => {
  const base = createRetirementHallState({seed:"empty-world",userPlayerId:"minor",startYear:2026});
  assert.deepEqual(getCareerRecordsPublicView(base).categories.H.leaders, []);
  const updated = recordMlbSeason(base, {year:2026,players:[hitter("minor","Minor",0,0)]});
  assert.equal(updated.careerLedger.minor?.mlbSeasons, 1);
  assert.equal(getCareerRecordsPublicView(updated).categories.H.userRank, null);
  assert.deepEqual(getCareerRecordsPublicView(updated).categories.H.leaders, []);
});

test("history UI only displays recorded save-world stats and escapes game-provided names", () => {
  const state = makeState();
  const demo = seasonApi.createDemoSeason({seed:"phase6-history-ui",startDate:"2026-04-01"});
  const snapshot = {...demo, retirementHall:getRetirementHallPublicView(state)};
  const root = {innerHTML:"",querySelectorAll:()=>[],querySelector:()=>null};
  renderSeason(root,snapshot,{},"MORE",{moreSection:"HISTORY"});
  assert.match(root.innerHTML,/MLB 커리어 누적 기록/);
  assert.match(root.innerHTML,/User Hitter/);
  assert.match(root.innerHTML,/&lt;img onerror=1&gt;/);
  assert.doesNotMatch(root.innerHTML,/<img onerror=1>/);
  assert.match(root.innerHTML,/2026~2027/);
  assert.match(root.innerHTML,/이 세이브에서 시뮬레이션한 MLB/);
});
