import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { seasonApi } from "../src/api/seasonApi.js";
import { renderSeason } from "../src/ui/seasonRender.js";
import { createTradeState, requestTradeState, cancelTradeRequestState,
  validateTradeState } from "../src/engine/career/tradeState.js";
import { createContractMarketState, setAgentStrategy, projectFreeAgentMarket }
  from "../src/engine/career/contractMarket.js";

const root = () => ({ innerHTML: "", querySelectorAll: () => [], querySelector: () => null });

test("trade requests have one active request, reversible cancellation and no forced destination", () => {
  const base = createTradeState({ startDate: "2026-04-01", userPlayerId: "u" });
  const pending = requestTradeState(base, { date: "2026-04-02", preferences: { preferContender: true } });
  assert.equal(pending.agentRequest.status, "REQUESTED");
  assert.equal(requestTradeState(pending, { date: "2026-04-02", preferences: { preferContender: true } }), pending);
  assert.throws(() => requestTradeState(pending, { date: "2026-04-03", preferences: { preferPlayingTime: true } }), /이미|진행/);
  assert.throws(() => requestTradeState(base, { date: "2026-04-02", preferences: { destinationOrganizationId: "109" } }), /선호/);
  const cancelled = cancelTradeRequestState(pending, { date: "2026-04-02" });
  assert.equal(cancelled.agentRequest.status, "CANCELLED");
  assert.equal(cancelled.agentRequest.cancelledDate, "2026-04-02");
  assert.equal(validateTradeState(cancelled), true);
  assert.deepEqual(cancelled.trades, base.trades);
  assert.deepEqual(cancelled.rumors, base.rumors);
  assert.throws(() => cancelTradeRequestState(cancelled, { date: "2026-04-02" }), /요청/);
  const again = requestTradeState(cancelled, { date: "2026-04-03", preferences: { preferPlayingTime: true } });
  assert.equal(again.agentRequest.status, "REQUESTED");
  assert.equal(again.agentRequest.preferences.preferPlayingTime, true);
});

test("agent strategy is a market choice, not an instant contract or ratings change", () => {
  const before = createContractMarketState({ playerId: "u", startDate: "2026-04-01" });
  const after = setAgentStrategy(before, "SECURITY");
  assert.equal(before.agentStrategy, "BALANCED");
  assert.equal(after.agentStrategy, "SECURITY");
  assert.deepEqual(after.freeAgency, before.freeAgency);
  assert.equal(after.status, before.status);
  assert.throws(() => setAgentStrategy(after, "GUARANTEED_BONUS"), /agent strategy/);
  const input = { age: 27, projectedValue: 0.78, durability: 0.72,
    trackRecord: 0.62, reputation: 0.52, positionDemand: 0.67 };
  const security = projectFreeAgentMarket({ ...input, agentStrategy: "SECURITY" });
  const short = projectFreeAgentMarket({ ...input, agentStrategy: "BET_ON_MYSELF" });
  assert.ok(security.years > short.years);
  assert.ok(security.aav < short.aav);
});

test("2026 production market controls, trade cancellation, saves and date replay share one world", () => {
  const master = JSON.parse(gunzipSync(readFileSync(
    "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
  const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: master });
  const org = catalog.organizations[0];
  const initial = seasonApi.createCareerSeason({ seed: "phase4-market-agent-batch",
    input: { name: "Phase4 Market QA", nationality: "대한민국", hometown: "구미", age: 21,
      heightCm: 180, weightKg: 78, bodyType: "ATHLETIC", bats: "R", throws: "R",
      primaryPosition: "CF", archetype: "HIT_FIRST", visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
      organizationMode: "FAVORITE", favoriteOrganizationId: String(org.id) },
    masterSnapshot: master });
  const id = initial.seasonId;
  const original = seasonApi.serializeSeason(id);
  const userId = String(original.fixture.userPlayerId);
  assert.equal(initial.userPlayer.marketActionsAvailable, true);
  const strategy = seasonApi.setAgentStrategy(id, "SECURITY");
  assert.equal(strategy.userPlayer.contractMarket.agentStrategy, "SECURITY");
  const requested = seasonApi.requestTrade(id, { preferences: { preferContender: true } });
  assert.equal(requested.userPlayer.trade.agentRequest.status, "REQUESTED");
  const view = root();
  renderSeason(view, requested, {}, "PLAYER", { playerSection: "CONTRACT" });
  assert.match(view.innerHTML, /data-agent-strategy="SECURITY"/);
  assert.match(view.innerHTML, /data-season-action="CANCEL_TRADE_REQUEST"/);
  assert.match(view.innerHTML, /트레이드 요청 철회/);
  const requestedPayload = seasonApi.serializeSeason(id);
  assert.deepEqual(requestedPayload.contractStates[userId], original.contractStates[userId],
    "changing agent or requesting trade must not award an instant new contract");
  assert.deepEqual(requestedPayload.rosterControlStates[userId], original.rosterControlStates[userId],
    "trade request must not silently change the active roster");
  const restoredPending = seasonApi.restoreSeason(structuredClone(requestedPayload));
  assert.equal(restoredPending.userPlayer.trade.agentRequest.status, "REQUESTED");
  assert.equal(restoredPending.userPlayer.contractMarket.agentStrategy, "SECURITY");
  const cancelled = seasonApi.cancelTradeRequest(id);
  assert.equal(cancelled.userPlayer.trade.agentRequest.status, "CANCELLED");
  assert.equal(seasonApi.serializeSeason(id).tradeState.trades.length, 0);
  const requestedAgain = seasonApi.requestTrade(id, { preferences: { preferPlayingTime: true } });
  assert.equal(requestedAgain.userPlayer.trade.agentRequest.preferences.preferPlayingTime, true);
  const checkpoint = seasonApi.serializeSeason(id);
  const first = seasonApi.simulateOneDay(id);
  const restored = seasonApi.restoreSeason(structuredClone(checkpoint));
  assert.equal(restored.userPlayer.trade.agentRequest.status, "REQUESTED");
  const replay = seasonApi.simulateOneDay(id);
  assert.deepEqual(replay.userPlayer.trade, first.userPlayer.trade);
  assert.deepEqual(replay.userPlayer.contractMarket, first.userPlayer.contractMarket);
  assert.equal(replay.currentDate, first.currentDate);
  const badTrade = seasonApi.serializeSeason(id);
  badTrade.tradeState.agentRequest.status = "INSTANT_TRADE";
  assert.throws(() => seasonApi.restoreSeason(badTrade), /trade request status/);
  const badMarket = seasonApi.serializeSeason(id);
  badMarket.contractMarketStates[userId].agentStrategy = "INFINITE_SALARY";
  assert.throws(() => seasonApi.restoreSeason(badMarket), /agentStrategy/);

  writeFileSync("reports/phase4-market-player-actions.json", JSON.stringify({
    schema: "THE_CALL_UP_PHASE4_MARKET_PLAYER_ACTIONS_V1", pass: true,
    productionMarketUi: true, strategyInfluencesFutureOfferModel: true,
    noInstantContractOrRosterGrant: true, cancellableTradeRequest: true,
    duplicateRequestGuard: true, noPlayerChosenDestination: true,
    saveRestoreReplay: true, malformedSaveRejected: true,
    source: "2026 production snapshot v2 baseline; v3 world gate separately required"
  }, null, 2) + "\n", "utf8");
});
