import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { getContractRuleset } from "../src/engine/career/contractRules.js";
import { createContractState, addContractServiceDays } from "../src/engine/career/contractState.js";
import {
  createContractMarketState, superTwoCutoff, evaluateEligibility,
  prepareArbitrationCase, resolveArbitration, nonTender,
  projectFreeAgentMarket, generateFreeAgentOffers, counterFreeAgentOffer,
  acceptFreeAgentOffer, evaluateQualifyingOfferEligibility
} from "../src/engine/career/contractMarket.js";

const snapshot = JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const rules = getContractRuleset("ruleset_2026");

assert.equal(rules.arbitrationYears, 3);
assert.equal(rules.freeAgencyYears, 6);
assert.equal(rules.superTwoMinimumPriorSeasonDays, 86);
assert.equal(rules.superTwoPercent, 0.22);
assert.equal(rules.qualifyingOfferValue2026, 22025000);
assert.equal(rules.futureCbaStatus, "UNVERIFIED_PENDING_NEW_CBA");

const cohort = [500, 495, 490, 480, 470, 460, 450, 440, 430, 420];
assert.equal(superTwoCutoff(cohort, 0.22), 490);

let arbContract = createContractState({ playerId:"arb", startDate:"2026-03-25", initialLevel:"AAA", isUser:true });
arbContract = addContractServiceDays(arbContract, 515, { seasonYear:2026 });
assert.equal(evaluateEligibility(arbContract, { cohortServiceDays:cohort, priorSeasonServiceDays:120 }).arbitration, "SUPER_TWO");
arbContract = addContractServiceDays(arbContract, 1, { seasonYear:2026 });
assert.equal(evaluateEligibility(arbContract).arbitration, "STANDARD");

let arbMarket = createContractMarketState({ playerId:"arb", startDate:"2026-03-25" });
arbMarket = prepareArbitrationCase(arbMarket, arbContract, {
  date:"2026-11-20", performanceIndex:.72, trackRecordIndex:.64, roleValue:.70
});
assert.ok(arbMarket.arbitration.playerFigure > arbMarket.arbitration.teamFigure);
const hearing = resolveArbitration(arbMarket, arbContract, {
  date:"2027-02-10", mode:"HEARING", performanceIndex:.70
});
assert.equal(hearing.outcome, "PLAYER_FIGURE_SELECTED");
assert.equal(hearing.contractState.terms.aav, arbMarket.arbitration.playerFigure);

const nonTendered = nonTender(arbMarket, { date:"2026-11-20" });
assert.equal(nonTendered.status, "FREE_AGENT_ELIGIBLE");

let faContract = createContractState({ playerId:"fa", startDate:"2026-03-25", initialLevel:"MLB", isUser:true });
faContract = addContractServiceDays(faContract, 1032, { seasonYear:2026 });
assert.equal(evaluateEligibility(faContract).freeAgency, true);

const balanced = projectFreeAgentMarket({
  age:29, projectedValue:.78, durability:.72, trackRecord:.80, reputation:.70, positionDemand:.76, agentStrategy:"BALANCED"
});
const security = projectFreeAgentMarket({
  age:29, projectedValue:.78, durability:.72, trackRecord:.80, reputation:.70, positionDemand:.76, agentStrategy:"SECURITY"
});
const bet = projectFreeAgentMarket({
  age:29, projectedValue:.78, durability:.72, trackRecord:.80, reputation:.70, positionDemand:.76, agentStrategy:"BET_ON_MYSELF"
});
assert.ok(security.years >= balanced.years);
assert.ok(bet.aav >= balanced.aav);

let faMarket = createContractMarketState({ playerId:"fa", startDate:"2026-10-31", agentStrategy:"BALANCED" });
faMarket.status = "FREE_AGENT_ELIGIBLE";
const teams = Array.from({length:30}, (_,i)=>({
  organizationId:String(100+i),
  organizationName:`Org ${i+1}`,
  needScore:((i*7)%10)/10,
  budgetScore:((i*3+5)%10)/10,
  competitiveScore:((i*5+2)%10)/10,
  playingTimeScore:((i*9+1)%10)/10
}));
faMarket = generateFreeAgentOffers(faMarket, {
  date:"2026-11-06",
  player:{age:29,projectedValue:.78,durability:.72,trackRecord:.80,reputation:.70,positionDemand:.76},
  teamProfiles:teams,
  maxOffers:8,
  seed:"v53-fa"
});
assert.ok(faMarket.freeAgency.offers.length >= 3);
assert.ok(faMarket.freeAgency.offers.length <= 8);
const best = faMarket.freeAgency.offers[0];
const counter = counterFreeAgentOffer(faMarket, { offerId:best.offerId, date:"2026-11-07", request:"AAV" });
assert.equal(typeof counter.accepted, "boolean");
const accepted = acceptFreeAgentOffer(counter.marketState, faContract, { offerId:best.offerId, date:"2026-11-08" });
assert.equal(accepted.marketState.status, "SIGNED");
assert.equal(accepted.contractState.terms.kind, "MLB_GUARANTEED");
assert.equal(accepted.contractState.terms.signingOrganizationId, best.organizationId);
assert.ok(accepted.contractState.terms.totalGuarantee > 0);

const qo2026 = evaluateQualifyingOfferEligibility(faContract, {
  marketYear:2026, previouslyReceived:false, fullSeasonSameOrganization:true
});
assert.equal(qo2026.eligible, true);
assert.equal(qo2026.value, 22025000);
const futureQo = evaluateQualifyingOfferEligibility(faContract, {
  marketYear:2027, previouslyReceived:false, fullSeasonSameOrganization:true
});
assert.equal(futureQo.status, "FUTURE_CBA_UNVERIFIED");

const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot});
const organization=catalog.organizations[0];
const season=seasonApi.createCareerSeason({
  seed:"v53-market-production",
  input:{
    name:"v53 Market QA",nationality:"대한민국",hometown:"구미",age:21,
    heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",
    primaryPosition:"CF",archetype:"HIT_FIRST",visibleTraits:["QUICK_BAT","SOFT_HANDS"],
    organizationMode:"FAVORITE",favoriteOrganizationId:String(organization.id)
  },
  masterSnapshot:snapshot
});
assert.equal(season.userPlayer.contractMarket.status,"CONTROLLED");
assert.equal(season.userPlayer.contractMarket.agentStrategy,"BALANCED");
assert.equal(season.userPlayer.contract.arbitration.detailedEvaluation,"ACTIVE_V53");

const payload=seasonApi.serializeSeason(season.seasonId);
const userId=String(payload.fixture.userPlayerId);
assert.ok(payload.contractMarketStates?.[userId]);
assert.ok(Object.keys(payload.contractMarketStates).length >= 4000);
assert.equal(validateSeasonSavePayload(payload,{mode:"FULL"}),true);

const realId=payload.fixture.organization.levels.MLB.roster.positionPlayers.find((id)=>String(id)!==userId);
const realDetail=seasonApi.getPlayerDetail(season.seasonId,String(realId));
assert.equal(realDetail.contractMarket.status,"UNKNOWN_BASELINE");

const restored=seasonApi.restoreSeason(structuredClone(payload));
const round=seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(round.contractMarketStates,payload.contractMarketStates);
assert.deepEqual(restored.userPlayer.contractMarket,season.userPlayer.contractMarket);

const report={
  schema:"THE_CALL_UP_V53_ARBITRATION_FREE_AGENCY_GATE",
  pass:true,
  source:"Production Snapshot v2",
  ruleset:{
    id:rules.id,
    arbitrationYears:rules.arbitrationYears,
    freeAgencyYears:rules.freeAgencyYears,
    superTwoPercent:rules.superTwoPercent,
    superTwoMinimumPriorSeasonDays:rules.superTwoMinimumPriorSeasonDays,
    qualifyingOfferValue2026:rules.qualifyingOfferValue2026,
    futureCbaStatus:rules.futureCbaStatus
  },
  arbitration:{
    superTwoCutoffDays:superTwoCutoff(cohort,.22),
    finalOfferHearing:true,
    playerFigure:arbMarket.arbitration.playerFigure,
    teamFigure:arbMarket.arbitration.teamFigure
  },
  freeAgency:{
    balanced,
    security,
    betOnMyself:bet,
    offerCount:faMarket.freeAgency.offers.length,
    counterRound:true,
    signing:true
  },
  production:{
    marketStates:Object.keys(payload.contractMarketStates).length,
    userStatus:season.userPlayer.contractMarket.status,
    realBaselineUnknownSafe:true,
    saveRestore:true
  }
};
fs.writeFileSync("reports/v53-arbitration-free-agency-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
