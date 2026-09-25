import assert from "node:assert/strict";
import test from "node:test";
import { SPRING_CHOICES, validateSpringRolePreference, setSpringRolePreference,
  buildSpringCampOutlook, validateSpringCampOutlook }
  from "../src/engine/career/springCamp.js";

const player = Object.freeze({ id: "user", positioning: { primaryPosition:"CF" } });
const mlbPlayer = Object.freeze({ id:"other", positioning:{primaryPosition:"CF"} });
const organization = () => ({userLevel:"AAA",levels:{
  AAA:{roster:{players:{user:player},positionPlayers:["user"]}},
  MLB:{roster:{players:{other:mlbPlayer},positionPlayers:["other"]}}
}});
const state = () => ({playerId:"user",primaryPosition:"CF",health:{activeInjury:null}});
const args = () => ({organization:organization(),playerId:"user",playerState:state(),
  roleState:{role:"AAA_STARTER",gamesTracked:14},rosterControl:{on40Man:true},
  targetYear:2027,date:"2027-02-20"});

test("spring outlook is source-grounded and not a fictional spring result", () => {
  const a=args(); const original=structuredClone(a);
  const first=buildSpringCampOutlook(a);
  assert.equal(first.rosterSecurity,"BUBBLE");
  assert.equal(first.directMlbCompetition,1);
  assert.equal(first.springGamesPlayed,0);
  assert.equal(first.springStats,null);
  assert.equal(first.rosterDecisionMade,false);
  assert.equal(first.regularSeasonStatsAffected,false);
  assert.equal(validateSpringCampOutlook(first),true);
  assert.deepEqual(a,original,"read model cannot modify authoritative player or roster data");
  a.playerState.health.activeInjury={daysRemaining:9};
  assert.equal(buildSpringCampOutlook(a).rosterSecurity,"LONG_SHOT");
  a.playerState.health.activeInjury=null;
  a.organization.userLevel="MLB";
  a.organization.levels.MLB.roster.players.user=player;
  a.organization.levels.MLB.roster.positionPlayers.push("user");
  a.roleState.role="STARTER";
  a.roleState.gamesTracked=30;
  assert.equal(buildSpringCampOutlook(a).rosterSecurity,"LIKELY");
  a.organization.levels.MLB.roster.positionPlayers=["user"];
  assert.equal(buildSpringCampOutlook(a).rosterSecurity,"LOCKED");
});

test("camp choice remains advisory; malformed saves are rejected, old saves default OPEN", () => {
  const a=args();
  assert.equal(validateSpringRolePreference(null),true);
  assert.deepEqual(SPRING_CHOICES,["OPEN","MLB_BENCH","AAA_EVERYDAY"]);
  const selected=setSpringRolePreference(a.playerState,"AAA_EVERYDAY","2027-02-20");
  assert.equal(selected.springRolePreference.mode,"AAA_EVERYDAY");
  assert.equal(a.playerState.springRolePreference,undefined);
  assert.equal(buildSpringCampOutlook({...a,playerState:selected}).preference,"AAA_EVERYDAY");
  assert.strictEqual(setSpringRolePreference(selected,"AAA_EVERYDAY","2027-02-20"),selected);
  assert.throws(()=>setSpringRolePreference(selected,"GUARANTEED_MLB","2027-02-20"),/스프링/);
  assert.throws(()=>validateSpringRolePreference({mode:"GUARANTEED_MLB",requestedDate:"2027-02-20"}),/스프링/);
  const corrupted={...buildSpringCampOutlook(a),springGamesPlayed:7};
  assert.throws(()=>validateSpringCampOutlook(corrupted),/스프링/);
});
