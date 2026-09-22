import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { generateAmateurClass } from "../src/engine/career/generatedTalent.js";
import { DRAFT_RULESET_2026, INTERNATIONAL_RULESET_2026, validateAmateurAcquisitionState, processDraftIfDue } from "../src/engine/career/amateurAcquisition.js";

const master=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master});
const org=catalog.organizations[0];
let season=seasonApi.createCareerSeason({
  seed:"v57-draft-international",
  input:{name:"v57 Amateur QA",nationality:"대한민국",hometown:"구미",age:21,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},
  masterSnapshot:master
});
assert.equal(season.seasonYear,2026);
assert.equal(season.amateur.currentYear,2026);
assert.equal(season.amateur.snapshotCoveredThroughYear,2026);
assert.equal(season.amateur.draft,null);
assert.equal(season.amateur.international,null);
assert.equal(season.amateur.reserve.count,0);
let payload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateAmateurAcquisitionState(payload.amateurAcquisitionState),true);
assert.equal(validateSeasonSavePayload(payload,{mode:"FULL"}),true);

season=seasonApi.simulateToSeasonEnd(season.seasonId);
assert.equal(season.status,"COMPLETE");
assert.equal(season.progress.worldLeagueGamesCompleted,10710);
assert.equal(season.amateur.draft,null,"2026 real snapshot cohort must not be duplicated by generated 2026 draft class");
const end2026=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(end2026,{mode:"FULL"}),true);

season=seasonApi.advanceToNextSeason(season.seasonId);
assert.equal(season.status,"REGULAR_SEASON");
assert.equal(season.seasonYear,2027);
assert.equal(season.history.totalSeasons,1);
assert.equal(season.amateur.currentYear,2027);
assert.equal(season.amateur.draft.status,"UPCOMING");
assert.equal(season.amateur.draft.board.length,20);
assert.equal(season.amateur.international.status,"ACTIVE_SIGNINGS_COMPLETE");
assert.ok(season.amateur.international.signingCount>0);
assert.ok(season.amateur.reserve.count>=0);
assert.equal(season.leagueEcology.lastOffseason.populationBefore,season.leagueEcology.lastOffseason.populationAfter);
assert.equal(season.leagueEcology.lastOffseason.generated,season.leagueEcology.lastOffseason.retired);

const nextPayload=seasonApi.serializeSeason(season.seasonId);
assert.equal(validateSeasonSavePayload(nextPayload,{mode:"FULL"}),true);
assert.equal(validateAmateurAcquisitionState(nextPayload.amateurAcquisitionState),true);
const activeIds=new Set();
for(const league of Object.values(nextPayload.fixture.levelLeagues)) for(const roster of Object.values(league.rosters)) for(const id of Object.keys(roster.players)){
  assert.ok(!activeIds.has(id),`duplicate active player ${id}`); activeIds.add(id);
}
for(const row of nextPayload.amateurAcquisitionState.reserve) assert.ok(!activeIds.has(String(row.player.id)),`reserve player leaked into active roster: ${row.player.id}`);

// Directly resolve the already-prepared 2027 class at the official-style calendar date.
const teamRows=master.teams.filter((team)=>team.level==="MLB" && team.active!==false);
const drafted=processDraftIfDue(nextPayload.amateurAcquisitionState,{date:"2027-07-11",teamRows});
assert.equal(drafted.current.draft.processed,true);
assert.equal(drafted.current.draft.picks.length,DRAFT_RULESET_2026.rounds*DRAFT_RULESET_2026.regularPicksPerRound);
assert.ok(drafted.current.draft.signed>450);
assert.ok(drafted.reserve.length<=INTERNATIONAL_RULESET_2026.reserveRetentionPerOrganization*30);
const signedRetained=drafted.current.draft.picks.find((pick)=>pick.signed && drafted.reserve.some((r)=>String(r.player.id)===String(pick.playerId)));
assert.ok(signedRetained,"retained signed draft pick required");
const desc=drafted.current.draft.descriptor;
const regenerated=generateAmateurClass({seed:desc.seed,year:desc.year,size:desc.size,classType:desc.classType,previousClassStrength:0,entryPath:desc.entryPath,idOffset:desc.idOffset});
const original=regenerated.players.find((p)=>String(p.id)===String(signedRetained.playerId));
const retained=drafted.reserve.find((r)=>String(r.player.id)===String(signedRetained.playerId)).player;
assert.deepEqual(retained,original,"draft slot/signing must not change player ratings");
assert.equal(validateAmateurAcquisitionState(drafted),true);

const report={
  schema:"THE_CALL_UP_V57_DRAFT_INTERNATIONAL_GATE",
  pass:true,
  rules:{
    draft:{id:DRAFT_RULESET_2026.id,rounds:DRAFT_RULESET_2026.rounds,lotterySelections:DRAFT_RULESET_2026.lotterySelections,officialFormatVerified:DRAFT_RULESET_2026.officialFormatVerified,supplementalPicks:DRAFT_RULESET_2026.supplementalPicks},
    international:{id:INTERNATIONAL_RULESET_2026.id,windowStart:INTERNATIONAL_RULESET_2026.signingWindowStartMonthDay,windowEnd:INTERNATIONAL_RULESET_2026.signingWindowEndMonthDay,officialFormatVerified:INTERNATIONAL_RULESET_2026.officialFormatVerified}
  },
  snapshotProtection:{season2026GeneratedClassSuppressed:true,reason:"REAL_SNAPSHOT_ALREADY_CONTAINS_CURRENT_COHORT"},
  openingDay2027:{populationStable:true,retired:season.leagueEcology.lastOffseason.retired,activatedFromReserve:season.leagueEcology.lastOffseason.activatedFromAmateurReserve,undraftedFallback:season.leagueEcology.lastOffseason.undraftedFallback,reserveRemaining:season.amateur.reserve.count,nextClassPrepared:true,internationalProcessed:true},
  draft2027:{picks:drafted.current.draft.picks.length,signed:drafted.current.draft.signed,reserveBounded:true,draftSlotRatingsInvariant:true},
  next:"v58 Retirement / Hall of Fame"
};
fs.writeFileSync("reports/v57-draft-international-gate.json",JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
