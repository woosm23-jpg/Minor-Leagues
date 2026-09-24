import assert from "node:assert/strict";
import test from "node:test";
import { selectPostseasonRosterPlayerIds as choose } from "../src/engine/career/postseasonRosterSelection.js";

function roster({ hitterCount = 16, pitcherCount = 15, twoWay = true } = {}) {
  const hitters = Array.from({ length: hitterCount }, (_, i) => `H${i + 1}`);
  const pitchers = Array.from({ length: pitcherCount }, (_, i) => `P${i + 1}`);
  if (twoWay) pitchers.push("H1");
  return {
    team: { id: "121", name: "Two-way fixture" },
    lineup: hitters.slice(0, 9),
    bench: hitters.slice(9).map((id) => ({ playerId: id })),
    positionPlayers: hitters,
    starters: pitchers.slice(0, 5),
    bullpen: pitchers.slice(5),
    pitchers
  };
}

function validateRoster(ids, src, max = 26) {
  assert.ok(ids.length >= 20 && ids.length <= max);
  assert.equal(new Set(ids).size, ids.length, "player IDs must be unique");
  assert.ok(ids.filter((id) => src.pitchers.includes(id)).length <= 13, "two-way pitchers count once toward maxPitchers");
  for (const id of src.lineup) assert.ok(ids.includes(id), `starting lineup must retain ${id}`);
}

test("two-way player appears once on a full 26-man roster", () => {
  const src = roster();
  const original = structuredClone(src);
  const ids = choose(src);
  validateRoster(ids, src);
  assert.equal(ids.length, 26);
  assert.equal(ids.filter((id) => id === "H1").length, 1);
  assert.deepEqual(src, original, "selection cannot mutate the roster");
  assert.deepEqual(choose(src), ids, "same input is deterministic");
});

test("ordinary roster retains 13 hitters and 13 pitchers", () => {
  const src = roster({ twoWay: false });
  const ids = choose(src);
  validateRoster(ids, src);
  assert.equal(ids.length, 26);
  assert.equal(ids.filter((id) => src.pitchers.includes(id)).length, 13);
});

test("late user batter and pitcher are included without duplicate IDs", () => {
  const src = roster();
  for (const id of ["H16", "P15", "H1"]) {
    const ids = choose(src, { forceIncludeId: id });
    validateRoster(ids, src);
    assert.ok(ids.includes(id));
    assert.equal(ids.length, 26);
  }
});

test("excluded user stays excluded while full bench alternatives fill the roster", () => {
  const src = roster();
  const ids = choose(src, { excludeId: "H15" });
  validateRoster(ids, src);
  assert.ok(!ids.includes("H15"));
  assert.equal(ids.length, 26);
  assert.throws(() => choose(src, { excludeId: "H1", forceIncludeId: "H1" }), RangeError);
});

test("a 25-player source stays distinct instead of fabricating a 26th ID", () => {
  const src = roster({ hitterCount: 13, pitcherCount: 12, twoWay: true });
  const ids = choose(src);
  validateRoster(ids, src);
  assert.equal(ids.length, 25);
});

test("a 19-player source fails explicitly instead of accepting an invalid roster", () => {
  const src = roster({ hitterCount: 10, pitcherCount: 9, twoWay: false });
  assert.throws(() => choose(src), /중복 없는 선수가 부족합니다/);
});
