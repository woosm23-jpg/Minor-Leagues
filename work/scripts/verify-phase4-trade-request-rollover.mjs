import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { renderSeason } from "../src/ui/seasonRender.js";

const source = JSON.parse(gunzipSync(readFileSync(
  "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const org = seasonApi.getCareerCreationCatalog({ masterSnapshot: source }).organizations[0];
let view = seasonApi.createCareerSeason({ seed: "phase4-year-end-market-2026",
  input: { name: "Phase4 Annual QA", nationality: "대한민국", hometown: "구미",
    age: 21, heightCm: 180, weightKg: 78, bodyType: "ATHLETIC",
    bats: "R", throws: "R", primaryPosition: "CF", archetype: "HIT_FIRST",
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE", favoriteOrganizationId: String(org.id) },
  masterSnapshot: source });
const id = view.seasonId;
view = seasonApi.setAgentStrategy(id, "BET_ON_MYSELF");
view = seasonApi.requestTrade(id, { preferences: { preferPlayingTime: true } });
const initialPayload = seasonApi.serializeSeason(id);
const userId = initialPayload.fixture.userPlayerId;
assert.equal(view.userPlayer.trade.agentRequest.status, "REQUESTED");
assert.equal(initialPayload.tradeState.trades.length, 0);
assert.equal(view.userPlayer.contractMarket.agentStrategy, "BET_ON_MYSELF");
view = seasonApi.simulateToSeasonEnd(id);
assert.equal(view.status, "COMPLETE");
assert.equal(view.progress.worldLeagueGamesCompleted, 10710);
assert.equal(view.userPlayer.trade.agentRequest.status, "REQUESTED",
  "a request must not silently be marked as an actual transaction");
view = seasonApi.startOffseason(id);
assert.equal(view.status, "OFFSEASON");
let safety = 0;
while (view.offseason.currentPhase !== "FREE_AGENCY_TRADES") {
  view = seasonApi.advanceOffseasonPhase(id);
  if (++safety > 8) throw new Error("offseason market review was not reached");
}
const pending = seasonApi.serializeSeason(id);
assert.equal(pending.tradeState.agentRequest.status, "REQUESTED");
const first = seasonApi.advanceOffseasonPhase(id);
assert.equal(first.userPlayer.trade.agentRequest.status, "EXPIRED");
assert.equal(first.userPlayer.trade.agentRequest.resolutionReason, "NO_TRADE_AT_OFFSEASON_REVIEW");
assert.equal(first.userPlayer.trade.agentRequest.resolvedDate, "2027-01-15");
assert.equal(first.offseason.lastResult.unfilledUserRequest, true);
assert.equal(first.offseason.lastResult.userTradeRequest, "EXPIRED");
const finalized = seasonApi.serializeSeason(id);
assert.equal(finalized.tradeState.trades.length, 0);
assert.equal(finalized.tradeState.reviews, pending.tradeState.reviews + 1);
assert.deepEqual(finalized.rosterControlStates[userId], pending.rosterControlStates[userId],
  "unfulfilled request must not change the player's roster assignment");
assert.equal(validateSeasonSavePayload(finalized, { mode: "FULL" }), true);
const html = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
renderSeason(html, first, {}, "PLAYER", { playerSection: "CONTRACT" });
assert.match(html.innerHTML, /오프시즌 검토 종료/);
assert.match(html.innerHTML, /data-season-action="REQUEST_TRADE_PLAYING_TIME"/);
seasonApi.restoreSeason(structuredClone(pending));
const replay = seasonApi.advanceOffseasonPhase(id);
assert.deepEqual(replay.userPlayer.trade, first.userPlayer.trade);
assert.deepEqual(replay.offseason.lastResult, first.offseason.lastResult);
assert.equal(seasonApi.serializeSeason(id).tradeState.reviews, finalized.tradeState.reviews);
view = seasonApi.advanceToNextSeason(id);
assert.equal(view.seasonYear, 2027);
assert.equal(view.status, "REGULAR_SEASON");
assert.equal(view.userPlayer.trade.agentRequest.status, "EXPIRED");
assert.equal(view.userPlayer.contractMarket.agentStrategy, "BET_ON_MYSELF");
const year2027 = seasonApi.serializeSeason(id);
assert.equal(validateSeasonSavePayload(year2027, { mode: "FULL" }), true);
view = seasonApi.restoreSeason(structuredClone(year2027));
assert.equal(view.userPlayer.trade.agentRequest.status, "EXPIRED");
view = seasonApi.requestTrade(id, { preferences: { preferContender: true } });
assert.equal(view.userPlayer.trade.agentRequest.status, "REQUESTED");
assert.deepEqual(view.userPlayer.trade.agentRequest.preferences, { preferContender: true });
assert.equal(seasonApi.serializeSeason(id).tradeState.trades.length, 0);

const report = { schema: "THE_CALL_UP_PHASE4_MARKET_YEAR_END_BUNDLE_V1", pass: true,
  source: "2026 production v2 baseline; production v3 whole-world gate is separate",
  regularSeason2026WorldGames: 10710,
  unfulfilledRequestExplicitlyResolved: true, noForcedTradeOrRosterChange: true,
  offseasonMarketReviewIdempotent: true, contractStrategyPreservedAcross2027: true,
  requestCanBeRenewedIn2027: true, fullSaveAndUiVerified: true };
writeFileSync("reports/phase4-market-year-end-bundle.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
