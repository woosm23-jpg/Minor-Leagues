import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";

const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot});
const org=catalog.organizations[0];
const created=seasonApi.createCareerSeason({
  seed:"v53-market-rollover",
  input:{
    name:"v53 Rollover QA",nationality:"대한민국",hometown:"구미",age:18,
    heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",
    primaryPosition:"SS",archetype:"HIT_FIRST",visibleTraits:["QUICK_BAT","SOFT_HANDS"],
    organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)
  },
  masterSnapshot:snapshot
});
const before=seasonApi.serializeSeason(created.seasonId);
const userId=String(before.fixture.userPlayerId);
assert.equal(before.contractMarketStates[userId].status,"CONTROLLED");

const completed=seasonApi.simulateToSeasonEnd(created.seasonId);
assert.equal(completed.status,"COMPLETE");
assert.equal(completed.progress.worldLeagueGamesCompleted,10710);

const next=seasonApi.advanceToNextSeason(created.seasonId);
assert.equal(next.seasonYear,2027);
assert.equal(next.startDate,"2027-03-25");
assert.ok(next.userPlayer.contractMarket);
assert.equal(next.userPlayer.contractMarket.status,"CONTROLLED");

const after=seasonApi.serializeSeason(created.seasonId);
assert.ok(Object.keys(after.contractMarketStates).length >= 4000);
assert.equal(after.contractMarketStates[userId].agentStrategy,"BALANCED");
const restored=seasonApi.restoreSeason(structuredClone(after));
const round=seasonApi.serializeSeason(restored.seasonId);
assert.deepEqual(round.contractMarketStates,after.contractMarketStates);

const report={
  schema:"THE_CALL_UP_V53_CONTRACT_MARKET_ROLLOVER_GATE",
  pass:true,
  source:"Production Snapshot v2",
  completed2026:{worldGames:completed.progress.worldLeagueGamesCompleted},
  next2027:{startDate:next.startDate,userMarketStatus:next.userPlayer.contractMarket.status},
  marketStates:Object.keys(after.contractMarketStates).length,
  futureCbaPolicy:"FROZEN_RULESET_2026_UNTIL_VERSIONED_REPLACEMENT",
  saveRoundTrip:true
};
fs.writeFileSync("reports/v53-contract-market-rollover-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
