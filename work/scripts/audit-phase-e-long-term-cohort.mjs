import fs from 'node:fs';
import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';
import { inferRealPlayerPotentialProfile } from '../src/data/realWorldPotential.js';
import { applyPublicScoutingPatchToSnapshot } from '../src/data/publicScoutingPatch.js';
import { createPhase1Hitter, createPhase1Pitcher } from '../src/engine/player/playerFixtures.js';
import {
  createPositionPlayerSeasonState,
  applyPositionPlayerGame,
  applyAnnualPositionPlayerDevelopment,
  getSeasonDevelopedPlayer
} from '../src/engine/season/playerSeasonState.js';
import {
  createPitcherSeasonState,
  applyPitcherSeasonGame,
  applyAnnualPitcherSeasonDevelopment,
  getSeasonDevelopedPitcher
} from '../src/engine/season/pitcherSeasonState.js';
import { applyAnnualPositionPlayerAging, applyAnnualPitcherAging } from '../src/engine/season/agingState.js';

const ROOT = new URL('../', import.meta.url);
const outArg = process.argv.find((x)=>x.startsWith('--output='));
const OUTPUT = outArg ? outArg.slice(9) : 'reports/v50-phase-e-long-term-cohort.json';
const maxYearsArg = process.argv.find((x)=>x.startsWith('--years='));
const MAX_YEARS = maxYearsArg ? Math.max(1, Number(maxYearsArg.slice(8))) : 20;
const HORIZONS = [1,5,10,20].filter((x)=>x<=MAX_YEARS);
const sampleArg=process.argv.find((x)=>x.startsWith('--sample-per-group='));
const SAMPLE_PER_GROUP=sampleArg?Math.max(1,Number(sampleArg.slice(19))):null;
const readGz=(rel)=>JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(rel,ROOT))).toString('utf8'));
let base=readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const dPath=new URL('data/the_call_up_phase_d/public-scouting-2026.json.gz',ROOT);
if(fs.existsSync(dPath)) base=applyPublicScoutingPatchToSnapshot(base,readGz('data/the_call_up_phase_d/public-scouting-2026.json.gz'));
const c=readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
const universe=inferRealWorldUniverse({schemaVersion:1,origin:'MASTER_SNAPSHOT',sourceSnapshot:{id:base.metadata?.snapshotId??'v2',hash:base.metadata.contentHash,season:2026},data:{...base,tracking:c.tracking,pitchArsenal:c.pitchArsenal}});
const infBy=new Map(universe.inference.players.map((r)=>[String(r.playerId),r]));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const cr=(v,f=50)=>clamp(Math.round(Number.isFinite(Number(v))?Number(v):f),20,99);
function engine(source,inf){const r=inf.ratings??{};if(inf.type==='PITCHER')return createPhase1Pitcher({id:String(source.id),ovr:cr(inf.overall),role:inf.role??'RP',control:cr(r.control),command:cr(r.command),movement:cr(r.movement),pitchability:cr(r.pitchability),stamina:cr(r.stamina),stuff:cr(r.stuff),pitchVelocityMph:r.pitchVelocityMph==null?null:Number(r.pitchVelocityMph)});return createPhase1Hitter({id:String(source.id),ovr:cr(inf.overall),contactR:cr(r.contactR),contactL:cr(r.contactL),rawPower:cr(r.rawPower),vision:cr(r.vision),discipline:cr(r.discipline),powerUtilizationR:cr(r.powerUtilizationR),powerUtilizationL:cr(r.powerUtilizationL),speed:cr(r.speed),fielding:cr(r.fielding),reaction:cr(r.reaction)});}
function scorePosition(p){const vals=[p.hitting.contactR,p.hitting.contactL,p.hitting.rawPower,p.hitting.vision,p.hitting.discipline,p.tendencies.powerUtilizationR,p.tendencies.powerUtilizationL,p.fielding.fielding,p.fielding.reaction,p.running.speed].map(Number);return vals.reduce((a,b)=>a+b,0)/vals.length;}
function scorePitcher(p){const vals=[p.pitching.control,p.pitching.command,p.pitching.movement,p.pitching.pitchability,p.pitching.stamina,p.derived.stuff].map(Number);return vals.reduce((a,b)=>a+b,0)/vals.length;}
function q(a,p){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.max(0,Math.min(s.length-1,Math.round((s.length-1)*p)))];}
function sum(a){if(!a.length)return {n:0,mean:null,p10:null,median:null,p90:null};return {n:a.length,mean:+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2),p10:+q(a,.1).toFixed(2),median:+q(a,.5).toFixed(2),p90:+q(a,.9).toFixed(2)};}
function ageBand(age){if(age<=22)return 'LE22';if(age<=25)return '23_25';if(age<=28)return '26_28';if(age<=32)return '29_32';if(age<=36)return '33_36';return '37P';}
function syntheticBatLine(){return {PA:30,H:7,doubles:1.4,triples:.15,HR:.8,BB:2.5,SO:6.5,SB:.25,HBP:.3};}
function syntheticPitchLine(role){const bf=role==='SP'?28:18;return {BF:bf,Pitches:bf*3.9,SO:bf*.235,BB:bf*.082,H:bf*.205,HR:bf*.028,HBP:bf*.011};}
const cohort=[];
let sourceRows=base.players;
if(SAMPLE_PER_GROUP){ const buckets=new Map(); for(const source of base.players){ const inf=infBy.get(String(source.id)); if(!inf) continue; const key=`${source.level}|${inf.type}`; if(!buckets.has(key)) buckets.set(key,[]); buckets.get(key).push(source); } sourceRows=[...buckets.values()].flatMap(rows=>rows.sort((a,b)=>String(a.id).localeCompare(String(b.id))).slice(0,SAMPLE_PER_GROUP)); }
for(const source of sourceRows){const inf=infBy.get(String(source.id));if(!inf)continue;const p=engine(source,inf);const profile=inferRealPlayerPotentialProfile({player:p,sourcePlayer:source,inference:inf,seed:'phase-e-long-term'});const devOpts={seed:'phase-e-long-term',startingProfile:profile};const state=inf.type==='PITCHER'?createPitcherSeasonState(p,devOpts):createPositionPlayerSeasonState(p,null,devOpts);cohort.push({source,inf,player:p,state});}
function annualExposure(row,year){let s=row.state;const level=row.source.level??'AAA';if(row.inf.type==='PITCHER'){const chunks=row.inf.role==='SP'?14:18;for(let i=0;i<chunks;i++)s=applyPitcherSeasonGame(s,row.player,{pitchCount:Math.round(syntheticPitchLine(row.inf.role).Pitches),pitchingLine:syntheticPitchLine(row.inf.role),date:`${2026+year}-07-01`,level});s=applyAnnualPitcherSeasonDevelopment(s,row.player,{seasonKey:String(2026+year)}).state;s=applyAnnualPitcherAging(s,row.player,{seasonKey:String(2026+year)}).state;}else{const chunks=16;const pos=row.player.positioning?.primaryPosition??'DH';for(let i=0;i<chunks;i++)s=applyPositionPlayerGame(s,row.player,{battingLine:syntheticBatLine(),position:pos,appearanceType:'START',date:`${2026+year}-07-01`,level});s=applyAnnualPositionPlayerDevelopment(s,row.player,{seasonKey:String(2026+year)}).state;s=applyAnnualPositionPlayerAging(s,row.player,{seasonKey:String(2026+year)}).state;}row.state=s;}
function snapshot(year){const rows=cohort.map((r)=>{const developed=r.inf.type==='PITCHER'?getSeasonDevelopedPitcher(r.player,r.state):getSeasonDevelopedPlayer(r.player,r.state);const age=Number(r.state.health?.age??r.source.age)+0;const score=r.inf.type==='PITCHER'?scorePitcher(developed):scorePosition(developed);return {id:String(r.source.id),age,level:r.source.level,type:r.inf.type,score,base:Number(r.inf.overall??50)};});const byAge={};for(const band of ['LE22','23_25','26_28','29_32','33_36','37P'])byAge[band]=sum(rows.filter(r=>ageBand(r.age)===band).map(r=>r.score));const byLevel={};for(const level of ['A','HIGH_A','AA','AAA','MLB'])byLevel[level]=sum(rows.filter(r=>r.level===level).map(r=>r.score));return {year,players:rows.length,age:sum(rows.map(r=>r.age)),talent:sum(rows.map(r=>r.score)),ageBands:byAge,levels:byLevel,age37Plus:rows.filter(r=>r.age>=37).length,age40Plus:rows.filter(r=>r.age>=40).length,age45Plus:rows.filter(r=>r.age>=45).length,under25:rows.filter(r=>r.age<25).length};}
const checkpoints={0:snapshot(0)};for(let y=1;y<=MAX_YEARS;y++){for(const row of cohort)annualExposure(row,y);if(HORIZONS.includes(y))checkpoints[y]=snapshot(y);}
const sourceTree=fs.readdirSync(new URL('../src/',import.meta.url),{recursive:true}).map(String);
const hasRetirement=sourceTree.some(x=>/retire|retirement/i.test(x));
const hasDraftGeneration=sourceTree.some(x=>/draft|international|generated.*player|amateurClass/i.test(x));
const gates={finite:Object.values(checkpoints).every(cp=>Number.isFinite(cp.talent.mean)&&Number.isFinite(cp.age.mean)),oneYearStable:checkpoints[1]?Math.abs(checkpoints[1].talent.median-checkpoints[0].talent.median)<=4:true,fiveYearFinite:checkpoints[5]?checkpoints[5].players===checkpoints[0].players:true,longTermWorldSystemsPresent:hasRetirement&&hasDraftGeneration,twentyYearAgeEcology:checkpoints[20]?checkpoints[20].age40Plus/checkpoints[20].players<0.35:true};
const result={schema:'THE_CALL_UP_PHASE_E_LONG_TERM_COHORT_AUDIT_V1',baseSnapshotHash:base.metadata.contentHash,players:cohort.length,maxYears:MAX_YEARS,checkpoints,capabilities:{hasRetirement,hasDraftGeneration},gates,passShort:Object.entries(gates).filter(([k])=>!['longTermWorldSystemsPresent','twentyYearAgeEcology'].includes(k)).every(([,v])=>v),passFull:Object.values(gates).every(Boolean)};
fs.mkdirSync(new URL('reports/',ROOT),{recursive:true});fs.writeFileSync(new URL(OUTPUT,ROOT),JSON.stringify(result,null,2));
for(const y of [0,...HORIZONS]){const cp=checkpoints[y];console.log(`YEAR ${y} PLAYERS ${cp.players} AGE_MED ${cp.age.median} TALENT_MED ${cp.talent.median} AGE40+ ${cp.age40Plus} UNDER25 ${cp.under25}`);}
console.log(`CAPABILITIES retirement=${hasRetirement} draftGeneration=${hasDraftGeneration}`);console.log(result.passShort?'PHASE_E_LONG_TERM_SHORT_PASS':'PHASE_E_LONG_TERM_SHORT_FAIL');console.log(result.passFull?'PHASE_E_LONG_TERM_FULL_PASS':'PHASE_E_LONG_TERM_FULL_FAIL');
