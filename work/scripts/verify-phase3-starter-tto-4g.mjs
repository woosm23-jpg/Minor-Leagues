import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import {
  shouldTtoHook,createPitcherUsageManager
} from "../src/engine/game/pitcherUsageAI.js";
import { pitchingCalibration } from "../src/config/pitchingCalibration.js";
import { createSeasonGameFixture } from "../src/services/demoSeasonFactory.js";
import { simulateSeasonFixtureGame } from "../src/services/seasonGameService.js";
import { seasonApi } from "../src/api/seasonApi.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const SNAP="data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function pitcher(id,role,stuff,stamina=45){
  return createPhase1Pitcher({ id,role,stuff,stamina,control:65,command:68,movement:67,pitchability:66,pitchVelocityMph:94 });
}
function synthetic(){
  const players={sp:pitcher("sp","SP",60,70),cl:pitcher("cl","CL",87),su:pitcher("su","RP",78),lr:pitcher("lr","RP",60,75)};
  const ready={availability:"READY",recoveryStatus:"READY",pregameFatigue:5};
  const pitchingPlan=(status="READY")=>({
    starterId:"sp",bullpenIds:["lr","su","cl"],
    bullpenMeta:{lr:{...ready,recoveryStatus:status},su:{...ready,recoveryStatus:status},cl:{...ready,recoveryStatus:status}}
  });
  const buildState=({inning=6,facings=20,pitches=80,runs=3,outs=16,away=3,home=4}={})=>({
    inning,half:"TOP",score:{away,home},
    currentPitcherId:{away:"away_sp",home:"sp"},
    pitcherUsage:{away:{},home:{sp:{pitcherId:"sp",entryInning:1,pitchCount:pitches,battersFaced:facings,outsRecorded:outs,runsAllowed:runs}}}
  });
  const choose=(state,recovery="READY")=>{
    const plan=pitchingPlan(recovery);
    return createPitcherUsageManager({players,pitchingPlans:{away:plan,home:plan}})({state,fieldingTeam:"home"});
  };
  const ttoState=buildState();
  const tto=shouldTtoHook({state:ttoState,fieldingTeam:"home",player:players.sp,usage:ttoState.pitcherUsage.home.sp,config:pitchingCalibration});
  assert.equal(tto,true);
  const healthyChoice=choose(ttoState);
  assert.ok(["lr","su","cl"].includes(healthyChoice));
  assert.equal(choose(ttoState),healthyChoice);
  assert.equal(choose(buildState({facings:17})),null);
  assert.equal(choose(buildState({pitches:72})),null);
  assert.equal(choose(buildState({runs:1})),null);
  assert.equal(choose(buildState({inning:5})),null);
  assert.equal(choose(buildState({outs:21})),null);
  assert.equal(choose(buildState({home:10,away:1})),null);
  assert.equal(choose(ttoState,"REST"),null);
  assert.ok(choose(buildState({pitches:120}),"REST"));
  return {ttoFacingThreshold:18,minTtoPitches:78,positiveChoice:healthyChoice,guardCases:8,emergencyBaseHook:true};
}
function careerInput(orgId){return {
  name:"TTO QA",nationality:"대한민국",hometown:"구미",age:18,heightCm:180,weightKg:78,bodyType:"ATHLETIC",bats:"R",throws:"R",primaryPosition:"SS",archetype:"BALANCED",visibleTraits:["QUICK_BAT","SOFT_HANDS"],organizationMode:"FAVORITE",favoriteOrganizationId:String(orgId)
};}
function main(){
  const syntheticResult=synthetic();
  const snapshot=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(ROOT,SNAP))).toString("utf8"));
  const catalog=seasonApi.getCareerCreationCatalog({masterSnapshot:snapshot});
  const created=seasonApi.createCareerSeason({seed:"phase3-4g-tto",input:careerInput(catalog.organizations[0].id),masterSnapshot:snapshot});
  const payload=seasonApi.serializeSeason(created.seasonId);
  let checkedGames=0,pitcherChanges=0,determinismChecks=0;
  for(const level of ["MLB","AAA"]){
    const league=payload.fixture.levelLeagues[level];
    for(const game of league.schedule.slice(0,12)){
      const fixture=createSeasonGameFixture({seasonFixture:payload.fixture,scheduleGame:game,playerStates:payload.playerStates??{},pitcherStates:payload.pitcherStates??{},roleStates:payload.roleStates??{},level});
      const seed=`${fixture.seed}:4G`;
      const result=simulateSeasonFixtureGame(fixture,{seed,mode:"FAST"});
      for(const side of ["away","home"]){
        const used=Object.keys(result.state.pitcherUsage[side]??{});
        pitcherChanges+=Math.max(0,used.length-1);
      }
      if(determinismChecks<2){
        const repeated=simulateSeasonFixtureGame(fixture,{seed,mode:"FAST"});
        assert.deepEqual(repeated.state.score,result.state.score);
        assert.deepEqual(repeated.state.pitcherUsage,result.state.pitcherUsage);
        determinismChecks+=1;
      }
      checkedGames+=1;
    }
  }
  assert.equal(checkedGames,24);
  assert.equal(determinismChecks,2);
  assert.ok(pitcherChanges>0);
  const report={schema:"THE_CALL_UP_PHASE3_STARTER_TTO_4G_V1",pass:true,snapshotHash:snapshot.metadata.contentHash,
    policy:{saveSchemaUnchanged:true,baseHookPreserved:true,starterThirdTimeThroughMinBattersFaced:18,minPitchCount:78,minInning:6,maxInning:8,closeGameMaxRunDifference:3,maxOutsBeforeTtoHook:20,freshRelieverRequired:true},
    synthetic:syntheticResult,productionSmoke:{checkedGames,pitcherChanges,determinismChecks}};
  const dest=path.resolve(ROOT,"reports/phase3-starter-tto-4g-v1.json");
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,JSON.stringify(report,null,2)+"\n");
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
}
try{main();}catch(error){console.error(error);process.exitCode=1;}
