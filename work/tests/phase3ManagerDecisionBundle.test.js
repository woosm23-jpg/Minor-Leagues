import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { seasonApi } from "../src/api/seasonApi.js";
import { renderSeason } from "../src/ui/seasonRender.js";
import { completedUserManagerDecision, validateUserManagerDecision } from
  "../src/engine/season/managerDecisionReadModel.js";

const fixture = (plan, voluntaryRest = null) => ({
  players: { user: { id: "user" } },
  teams: { away: { id: "my-team" }, home: { id: "opponent" } },
  dailyLineups: { away: plan }, voluntaryRest
});
const common = { game: { gameId: "g1", date: "2026-04-02" }, level: "AAA",
  userTeamId: "my-team", userPlayerId: "user" };

// A manager explanation is a record of real lineup evidence, not a guessed
// trust score or a player-only lineup modifier.
test("manager explanations distinguish real starts, competition and requested rest", () => {
  const selected = completedUserManagerDecision({ ...common,
    fixture: fixture({ lineup: ["user"], bench: [], rested: [], unavailable: [], replacements: [] }) });
  assert.equal(selected.appearance, "STARTED");
  assert.equal(selected.reasonCode, "STARTING_LINEUP");
  const competition = completedUserManagerDecision({ ...common,
    fixture: fixture({ lineup: ["backup"], bench: [{ playerId: "user" }],
      replacements: [{ kind: "COMPETITION_DIRECT", forPlayerId: "user", playerId: "backup" }] }) });
  assert.equal(competition.reasonCode, "COMPETITION_DIRECT");
  assert.equal(competition.replacementPlayerId, "backup");
  const requested = completedUserManagerDecision({ ...common,
    fixture: fixture({ lineup: ["backup"], bench: [],
      replacements: [{ kind: "PLAYER_REST_REQUEST", forPlayerId: "user", playerId: "backup" }],
      voluntaryRest: { approved: true } }, { approved: true }) });
  assert.equal(requested.reasonCode, "PLAYER_REQUEST_APPROVED");
  assert.equal(validateUserManagerDecision(null), true);
  assert.throws(() => validateUserManagerDecision({ ...requested, reasonCode: "GUARANTEED_PROMOTION" }), /기용 판단/);
});

test("batting focus, secondary practice, role preference and rest share one save-safe calendar", () => {
  const initial = seasonApi.createDemoSeason({ seed: "phase3-consolidated-final-choices", startDate: "2026-04-01" });
  const id = initial.seasonId;
  seasonApi.setTrainingFocus(id, "CONTACT");
  seasonApi.setSecondaryPositionTraining(id, "LF");
  seasonApi.setRolePreference(id, "EVERYDAY");
  const chosen = seasonApi.requestNextGameRest(id);
  assert.equal(chosen.userRestRequest.status, "PENDING");
  const checkpoint = seasonApi.serializeSeason(id);
  const first = seasonApi.simulateOneDay(id);
  assert.equal(first.userRestRequest.status, "APPROVED");
  assert.equal(first.userManagerDecision?.reasonCode, "PLAYER_REQUEST_APPROVED");
  assert.equal(first.userManagerDecision?.appearance, "NOT_STARTED");
  assert.equal(first.userSeasonLine.G, 0);
  assert.equal(first.userPlayer.status.development.focus, "CONTACT");
  assert.equal(first.userPlayer.status.positionTraining.targetPosition, "LF");
  assert.equal(first.userRole.preference.mode, "EVERYDAY");
  const ui = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  renderSeason(ui, first, {}, "HOME", {});
  assert.match(ui.innerHTML, /지난 경기 기용/);
  assert.match(ui.innerHTML, /휴식 요청/);
  const restored = seasonApi.restoreSeason(checkpoint);
  assert.equal(restored.userManagerDecision, null);
  const replay = seasonApi.simulateOneDay(id);
  assert.deepEqual(replay.userManagerDecision, first.userManagerDecision);
  assert.deepEqual(replay.userSeasonLine, first.userSeasonLine);
  assert.deepEqual(replay.userRole.preference, first.userRole.preference);
  assert.deepEqual(replay.userPlayer.status.positionTraining, first.userPlayer.status.positionTraining);
  const saved = seasonApi.serializeSeason(id);
  assert.deepEqual(seasonApi.restoreSeason(saved).userManagerDecision, first.userManagerDecision);
});

test("old saves load and malformed manager decisions fail on normal restore", () => {
  const initial = seasonApi.createDemoSeason({ seed: "phase3-consolidated-save-compat", startDate: "2026-04-01" });
  const id = initial.seasonId;
  const old = seasonApi.serializeSeason(id);
  delete old.playerStates[old.fixture.userPlayerId].lastManagerDecision;
  assert.equal(seasonApi.restoreSeason(old).userManagerDecision, null);
  const invalid = seasonApi.serializeSeason(id);
  invalid.playerStates[invalid.fixture.userPlayerId].lastManagerDecision = {
    version: 1, date: "2026-04-02", gameId: "g1", level: "AAA",
    appearance: "STARTED", reasonCode: "NOT_A_REAL_REASON", replacementPlayerId: null
  };
  assert.throws(() => seasonApi.restoreSeason(invalid), /기용 판단/);
  writeFileSync("reports/phase3-consolidated-player-decisions.json", JSON.stringify({
    schema: "THE_CALL_UP_PHASE3_CONSOLIDATED_PLAYER_DECISIONS_V1", pass: true,
    authoritativeManagerExplanation: true, organizationReasonsOnHome: true,
    trainingRestRoleAndSecondaryReplay: true, legacySaveCompatibility: true,
    rejectsInvalidSave: true
  }, null, 2) + "\n", "utf8");
});
