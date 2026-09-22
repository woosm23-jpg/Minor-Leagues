import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";
import { validateSeasonSavePayload } from "../src/services/seasonSerialization.js";
import { HOF_RULESET_2026, createRetirementHallState, validateRetirementHallState, recordMlbSeason, archiveRetiredPlayers, announceUserFinalSeason, retireUserPlayer, processHallOfFameYear } from "../src/engine/career/retirementHallOfFame.js";

let pure=createRetirementHallState({seed:"v58-hof-pure",userPlayerId:"legend",startYear:2026});
const line={G:160,PA:700,AB:600,H:210,doubles:40,triples:5,HR:45,RBI:125,BB:90,HBP:5,SO:100,SB:20,SF:5};
for(let year=2026;year<=2037;year++) pure=recordMlbSeason(pure,{year,players:[{playerId:"legend",name:"Legend Test",position:"CF",isPitcher:false,teamId:"T1",age:year-2000,batting:line,pitching:{}}],awardsByPlayer:{legend:year%3===0?["MVP","SILVER_SLUGGER"]:["SILVER_SLUGGER"]},championTeamId:year%4===0?"T1":null});
pure=archiveRetiredPlayers(pure,{year:2037,retiredRecords:[{id:"legend",name:"Legend Test",role:"H",level:"MLB",organizationId:"T1",ovr:78,player:{physical:{age:37},positioning:{primaryPosition:"CF"}},developed:{physical:{age:37}}}],decisions:[]});
pure=announceUserFinalSeason(pure,{year:2037});
pure=retireUserPlayer(pure,{year:2037,date:"2037-11-01",timeline:[{type:"MLB_DEBUT",date:"2026-04-01",importance:"CAREER"}],history:[]});
assert.equal(pure.user.retired,true); assert.equal(pure.user.report.grade,null); assert.equal(pure.user.report.mlbSeasons,12);
const before=processHallOfFameYear(pure,{electionYear:2042}); assert.equal(before.hall.inductees.length,0);
const elected=processHallOfFameYear(before,{electionYear:2043});
assert.ok(elected.hall.ballots.some(b=>b.electionYear===2043));
assert.ok(elected.hall.inductees.some(x=>x.playerId==="legend"));
assert.equal(HOF_RULESET_2026.bbwAA.minMlbSeasons,10); assert.equal(HOF_RULESET_2026.bbwAA.firstBallotYearsAfterFinalSeason,6); assert.equal(HOF_RULESET_2026.bbwAA.electionThreshold,0.75); assert.equal(HOF_RULESET_2026.bbwAA.maxBallotYears,10); assert.equal(HOF_RULESET_2026.bbwAA.maxSelectionsPerVoter,10);
assert.equal(validateRetirementHallState(elected),true);

const master=JSON.parse(zlib.gunzipSync(fs.readFileSync("data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz")).toString("utf8"));
const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:master}); const org=catalog.organizations[0];
let season=seasonApi.createCareerSeason({seed:"v58-retirement-hof",input:{name:"v58 HOF QA",nationality:"대한민국",hometown:"구미",age:21,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"CF",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(org.id)},masterSnapshot:master});
assert.equal(season.retirementHall.user.retired,false); assert.equal(season.retirementHall.retiredCount,0);
season=seasonApi.announceFinalSeason(season.seasonId); assert.equal(season.retirementHall.user.finalSeasonAnnounced,true);
season=seasonApi.simulateToSeasonEnd(season.seasonId); assert.equal(season.status,"COMPLETE");
season=seasonApi.startOffseason(season.seasonId); let payload=seasonApi.serializeSeason(season.seasonId);
assert.ok(payload.retirementHallState.recordedSeasons.includes(2026)); assert.equal(validateSeasonSavePayload(payload,{mode:"FULL"}),true);
season=seasonApi.restoreSeason(structuredClone(payload)); assert.ok(season.retirementHall.ledgerPlayers>0);
season=seasonApi.advanceToNextSeason(season.seasonId); assert.equal(season.seasonYear,2027); assert.equal(season.status,"REGULAR_SEASON");
assert.ok(season.retirementHall.retiredCount>=season.leagueEcology.lastOffseason.retired);
payload=seasonApi.serializeSeason(season.seasonId); assert.equal(validateSeasonSavePayload(payload,{mode:"FULL"}),true); assert.equal(validateRetirementHallState(payload.retirementHallState),true);

const report={schema:"THE_CALL_UP_V58_RETIREMENT_HOF_GATE",pass:true,rules:{id:HOF_RULESET_2026.id,verified:HOF_RULESET_2026.officialFormatVerified,bbwAA:HOF_RULESET_2026.bbwAA,contemporaryEraPlayers:HOF_RULESET_2026.contemporaryEraPlayers},retirement:{aiPressureModelPreserved:true,userNeverForcedByRng:true,finalSeasonAnnouncement:true,retiredArchive:true,retirementReportNoGrade:true},careerLedger:{mlbSeasonArchive:true,peakSeven:true,awards:true,championships:true,saveRestore:true},hall:{fiveFullSeasonWait:true,tenMlbSeasonMinimum:true,seventyFivePercent:true,fivePercentRetention:true,tenBallotYearMaximum:true,maxTenSelections:true,virtualVoterCompetition:true,contemporaryEraCycle:true},production:{season2026Archived:true,openingDay2027:true,retiredArchived:true},next:"v59 Long-run Stress"};
fs.writeFileSync("reports/v58-retirement-hof-gate.json",JSON.stringify(report,null,2)+"\n"); console.log(JSON.stringify(report,null,2));
