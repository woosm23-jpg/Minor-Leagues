import assert from "node:assert/strict";
import test from "node:test";
import { createTradeState, requestTradeState, cancelTradeRequestState,
  expireTradeRequestState, recordTrade, validateTradeState }
  from "../src/engine/career/tradeState.js";
import { createContractState } from "../src/engine/career/contractState.js";
import { createContractMarketState, generateFreeAgentOffers,
  counterFreeAgentOffer, acceptFreeAgentOffer }
  from "../src/engine/career/contractMarket.js";

const tradeBase = () => createTradeState({ startDate: "2026-04-01", userPlayerId: "user" });
const fakeOfferInput = { date: "2026-11-06", player: { age: 29,
  projectedValue: .72, durability: .74, trackRecord: .7,
  reputation: .6, positionDemand: .75 },
  teamProfiles: [{ organizationId: "109", organizationName: "A",
    needScore: .9, budgetScore: .8, competitiveScore: .7, playingTimeScore: .8 }],
  seed: "phase4-year-end-gate" };

test("unfulfilled player trade request resolves once at offseason review, never fabricates a trade", () => {
  const base = tradeBase();
  const pending = requestTradeState(base, { date: "2026-07-15",
    preferences: { preferPlayingTime: true } });
  const done = expireTradeRequestState(pending, { date: "2027-01-15" });
  assert.equal(done.agentRequest.status, "EXPIRED");
  assert.equal(done.agentRequest.resolvedDate, "2027-01-15");
  assert.equal(done.agentRequest.resolutionReason, "NO_TRADE_AT_OFFSEASON_REVIEW");
  assert.equal(done.reviews, pending.reviews + 1);
  assert.deepEqual(done.trades, base.trades);
  assert.deepEqual(done.rumors, base.rumors);
  assert.strictEqual(expireTradeRequestState(done, { date: "2027-01-15" }), done);
  assert.throws(() => cancelTradeRequestState(done, { date: "2027-01-15" }), /요청/);
  assert.equal(requestTradeState(done, { date: "2027-04-02",
    preferences: { preferContender: true } }).agentRequest.status, "REQUESTED");
  assert.equal(validateTradeState(done), true);
  assert.throws(() => expireTradeRequestState(pending, { date: "2026-07-14" }), /이전/);
  const invalid = structuredClone(done);
  invalid.agentRequest.resolvedDate = "2026-07-14";
  assert.throws(() => validateTradeState(invalid), /종료일|검토일/);
  const malformed = structuredClone(done);
  malformed.agentRequest.resolutionReason = "INSTANT_PROMOTION";
  assert.throws(() => validateTradeState(malformed), /결과/);
});

test("cancelled or satisfied requests are never re-expired by offseason processing", () => {
  const pending = requestTradeState(tradeBase(), { date: "2026-07-15" });
  const cancelled = cancelTradeRequestState(pending, { date: "2026-07-16" });
  assert.strictEqual(expireTradeRequestState(cancelled, { date: "2027-01-15" }), cancelled);
  const satisfied = recordTrade(pending, { proposal: {
    tradeId: "test-trade", date: "2026-07-20", buyerOrganizationId: "110",
    sellerOrganizationId: "109", buyerAssets: [], sellerAssets: [], userInvolved: true
  } });
  assert.equal(satisfied.agentRequest.status, "SATISFIED");
  assert.strictEqual(expireTradeRequestState(satisfied, { date: "2027-01-15" }), satisfied);
  assert.equal(satisfied.trades.length, 1);
  assert.equal(validateTradeState(createTradeState({ startDate: "2026-04-01", userPlayerId: "legacy" })), true);
});

test("FA offers require eligibility and a matching player; a signed offer cannot be signed twice", () => {
  const market = createContractMarketState({ playerId: "fa", startDate: "2026-10-01" });
  assert.throws(() => generateFreeAgentOffers(market, fakeOfferInput), /자유계약|자격/);
  market.status = "FREE_AGENT_ELIGIBLE";
  const offered = generateFreeAgentOffers(market, fakeOfferInput);
  assert.equal(offered.status, "FREE_AGENT_OPEN");
  assert.equal(offered.freeAgency.offers.length, 1);
  const offerId = offered.freeAgency.offers[0].offerId;
  const other = createContractState({ playerId: "other", startDate: "2026-03-25", initialLevel: "MLB", isUser: true });
  assert.throws(() => acceptFreeAgentOffer(offered, other,
    { offerId, date: "2026-11-08" }), /선수/);
  const contract = createContractState({ playerId: "fa", startDate: "2026-03-25", initialLevel: "MLB", isUser: true });
  const negotiation = counterFreeAgentOffer(offered, { offerId, date: "2026-11-07", request: "AAV" });
  const signed = acceptFreeAgentOffer(negotiation.marketState, contract,
    { offerId, date: "2026-11-08" });
  assert.equal(signed.marketState.status, "SIGNED");
  assert.equal(signed.contractState.terms.kind, "MLB_GUARANTEED");
  assert.throws(() => acceptFreeAgentOffer(signed.marketState, signed.contractState,
    { offerId, date: "2026-11-08" }), /시장|이미/);
  const closed = structuredClone(offered);
  closed.freeAgency.offers[0].status = "CLOSED";
  assert.throws(() => acceptFreeAgentOffer(closed, contract,
    { offerId, date: "2026-11-08" }), /제안/);
});
