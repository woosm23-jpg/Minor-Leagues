import fs from 'node:fs';
import crypto from 'node:crypto';
import { seasonApi } from '../src/api/seasonApi.js';
import { executeAdjacentLevelSwap } from '../src/services/organizationRosterService.js';

const seedArgs = process.argv.filter((a) => a.startsWith('--seed=')).map((a) => Number(a.slice(7)));
const seeds = seedArgs.length ? seedArgs : [1,2,3,4,5,6];
const verify = process.argv.includes('--verify');
const quiet = process.argv.includes('--quiet');
const outputArg = process.argv.find((a) => a.startsWith('--output='));
const golden = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/v26-upper-core-golden.json', import.meta.url), 'utf8'));
const goldenMap = new Map(golden.rows.map((r) => [r.seed, r.sha256]));

function canonical(v){ if(Array.isArray(v)) return v.map(canonical); if(v&&typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map((k)=>[k,canonical(v[k])])); return v; }
function sha(v){ return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
function upperCore(payload){
  const ids=new Set();
  for(const level of ['AAA','MLB']) for(const roster of Object.values(payload.fixture.levelLeagues[level].rosters)) for(const id of Object.keys(roster.players)) ids.add(id);
  const pick=(obj)=>Object.fromEntries([...ids].sort().filter((id)=>obj[id]).map((id)=>[id,obj[id]]));
  return {levelSeasons:{AAA:payload.levelSeasons.AAA,MLB:payload.levelSeasons.MLB},levelLeagues:{AAA:payload.fixture.levelLeagues.AAA,MLB:payload.fixture.levelLeagues.MLB},organization:{userLevel:payload.fixture.organization.userLevel,AAA:payload.fixture.organization.levels.AAA,MLB:payload.fixture.organization.levels.MLB},playerStates:pick(payload.playerStates),pitcherStates:pick(payload.pitcherStates),roleStates:pick(payload.roleStates??{})};
}
function setTools(player,value){
  for(const key of ['contactR','contactL','rawPower','vision','discipline']) if(key in (player.hitting??{})) player.hitting[key]=value;
  for(const key of ['fielding','reaction','armStrength','armAccuracy']) if(key in (player.fielding??{})) player.fielding[key]=value;
  for(const key of ['speed','stealing','baserunning']) if(key in (player.running??{})) player.running[key]=value;
}
function setEveryCopy(payload,id,value){
  for(const roster of Object.values(payload.fixture.rosters??{})) if(roster.players?.[id]) setTools(roster.players[id],value);
  for(const league of Object.values(payload.fixture.levelLeagues??{})) for(const roster of Object.values(league.rosters??{})) if(roster.players?.[id]) setTools(roster.players[id],value);
  for(const affiliate of Object.values(payload.fixture.organization?.levels??{})) if(affiliate.roster?.players?.[id]) setTools(affiliate.roster.players[id],value);
}
function starterAt(fixture,level,position='CF'){ return fixture.organization.levels[level].roster.lineupSlots.find((r)=>r.position===position).starterId; }

function baseline(n){
  const seed=`v26-stability-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const payload=seasonApi.serializeSeason(s.seasonId);
  return {
    seed,status:s.status,worldGames:s.progress.worldLeagueGamesCompleted,userLevel:s.currentLevel,userGames:s.userSeasonLine.G,restGames:s.userRole.restGames,
    txCount:s.organization.recentTransactions.length,upperHash:sha(upperCore(payload)),expectedUpperHash:goldenMap.get(seed),gameVersion:payload.gameVersion,
    roundTrip:seasonApi.restoreSeason(structuredClone(payload)).progress.worldLeagueGamesCompleted===448
  };
}

function forcedLadder(n){
  const seed=`v27-ladder-${n}`;
  let s=seasonApi.createDemoSeason({seed,startDate:'2026-04-01'});
  let payload=structuredClone(seasonApi.serializeSeason(s.seasonId));
  let roles=payload.roleStates;
  let fixture=payload.fixture;
  // Setup only: place the user at A through two legal adjacent swaps.
  let aaCf=starterAt(fixture,'AA');
  let moved=executeAdjacentLevelSwap({fixture,roleStates:roles,fromLevel:'AA',toLevel:'AAA',promotePlayerId:aaCf,demotePlayerId:payload.fixture.userPlayerId,position:'CF',date:'2026-04-01',reasonCodes:['TEST_SETUP']});
  fixture=moved.fixture; roles=moved.roleStates;
  let aCf=starterAt(fixture,'A');
  moved=executeAdjacentLevelSwap({fixture,roleStates:roles,fromLevel:'A',toLevel:'AA',promotePlayerId:aCf,demotePlayerId:payload.fixture.userPlayerId,position:'CF',date:'2026-04-01',reasonCodes:['TEST_SETUP']});
  fixture=moved.fixture; roles=moved.roleStates;
  payload.fixture=structuredClone(fixture); payload.roleStates=structuredClone(roles);
  // Make the user clearly ready and the next-level CF starter clearly replaceable.
  setEveryCopy(payload,payload.fixture.userPlayerId,99);
  for(const level of ['AA','AAA','MLB']) setEveryCopy(payload,starterAt(payload.fixture,level),20);
  s=seasonApi.restoreSeason(payload);
  const levels=[s.currentLevel];
  let safety=0;
  while(s.status!=='COMPLETE' && safety<40){
    s=seasonApi.simulateCurrentGame(s.seasonId); safety++;
    if(levels.at(-1)!==s.currentLevel) levels.push(s.currentLevel);
  }
  if(s.status!=='COMPLETE') s=seasonApi.simulateToSeasonEnd(s.seasonId);
  const saved=seasonApi.serializeSeason(s.seasonId);
  const userPromotions=(saved.organizationState?.transactions??[]).filter((e)=>e.type==='PLAYER_PROMOTED'&&e.playerId===saved.fixture.userPlayerId).map((e)=>`${e.fromLevel}->${e.toLevel}`);
  const nonAdjacent=(saved.organizationState?.transactions??[]).some((e)=>{
    const order=['A','AA','AAA','MLB']; return Math.abs(order.indexOf(e.fromLevel)-order.indexOf(e.toLevel))!==1;
  });
  return {seed,status:s.status,levels,userPromotions,nonAdjacent,worldGames:s.progress.worldLeagueGamesCompleted,finalLevel:s.currentLevel,gameVersion:saved.gameVersion,roundTrip:seasonApi.restoreSeason(structuredClone(saved)).currentLevel===s.currentLevel};
}

const rows=[];
for(const n of seeds){
  const b=baseline(n), f=forcedLadder(n); rows.push({n,baseline:b,forced:f});
  if(verify){
    if(b.status!=='COMPLETE'||b.worldGames!==448||b.userLevel!=='AAA'||b.userGames!==27||b.restGames!==1||b.txCount!==0||!b.roundTrip) throw new Error(`seed ${n}: baseline regression`);
    if(b.upperHash!==b.expectedUpperHash) throw new Error(`seed ${n}: v26 AAA/MLB core changed`);
    if(b.gameVersion!=='phase3_career_timeline_v28') throw new Error(`seed ${n}: version regression`);
    const expected=['A->AA','AA->AAA','AAA->MLB'];
    if(f.status!=='COMPLETE'||f.worldGames!==448||f.finalLevel!=='MLB'||f.nonAdjacent||!f.roundTrip) throw new Error(`seed ${n}: ladder completion/atomicity regression`);
    for(const step of expected) if(!f.userPromotions.includes(step)) throw new Error(`seed ${n}: missing ladder step ${step}`);
  }
}
const report={version:'v27',sourceGolden:golden.sourceVersion,seeds:seeds.length,verified:verify,rows};
const output=outputArg?.slice(9); if(output) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(!quiet) console.log(JSON.stringify(report,null,2));
