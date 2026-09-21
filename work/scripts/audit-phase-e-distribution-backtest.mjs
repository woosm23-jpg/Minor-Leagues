import fs from 'node:fs';
import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';
import { applyPublicScoutingPatchToSnapshot } from '../src/data/publicScoutingPatch.js';
import { createPhase1Hitter, createPhase1Pitcher } from '../src/engine/player/playerFixtures.js';
import { buildPAContext } from '../src/engine/pa/context.js';
import { simulatePA } from '../src/engine/pa/paEngine.js';
import { sampleContactQuality } from '../src/engine/pa/contactQuality.js';
import { sampleExitVelocity } from '../src/engine/pa/exitVelocity.js';
import { sampleLaunchAngle } from '../src/engine/pa/launchAngle.js';
import { sampleSprayDirection } from '../src/engine/pa/sprayDirection.js';
import { resolveWallClearance } from '../src/engine/pa/parkGeometry.js';
import { SeededRng } from '../src/engine/rng.js';

const ROOT = new URL('../', import.meta.url);
const VERIFY = process.argv.includes('--verify');
const outArg = process.argv.find((x) => x.startsWith('--output='));
const OUTPUT = outArg ? outArg.slice(9) : 'reports/v50-phase-e-distribution-backtest.json';
const repsArg = process.argv.find((x)=>x.startsWith('--reps='));
const REPS = repsArg ? Math.max(80, Number(repsArg.slice(7))||240) : 240;
const bipRepsArg = process.argv.find((x)=>x.startsWith('--bip-reps='));
const BIP_REPS = bipRepsArg ? Math.max(300, Number(bipRepsArg.slice(11))||800) : 800;
const readGz=(rel)=>JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(rel,ROOT))).toString('utf8'));
let base=readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const dPath=new URL('data/the_call_up_phase_d/public-scouting-2026.json.gz',ROOT);
if(fs.existsSync(dPath)) base=applyPublicScoutingPatchToSnapshot(base,readGz('data/the_call_up_phase_d/public-scouting-2026.json.gz'));
const phaseC=readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
if(phaseC.baseSnapshotHash!==base.metadata.contentHash) throw new Error('phase C hash mismatch');
const universe=inferRealWorldUniverse({schemaVersion:1,origin:'MASTER_SNAPSHOT',sourceSnapshot:{id:base.metadata.snapshotId,hash:base.metadata.contentHash,season:2026},data:{...base,tracking:phaseC.tracking,pitchArsenal:phaseC.pitchArsenal}});
const infById=new Map(universe.inference.players.map(x=>[String(x.playerId),x]));
const srcById=new Map(base.players.map(x=>[String(x.id),x]));
function clamp(v,f=50){const n=Number(v);return Math.max(20,Math.min(99,Math.round(Number.isFinite(n)?n:f)));}
function hitterEngine(src,inf){const r=inf.ratings??{};return createPhase1Hitter({id:String(src.id),bats:src.bats??'R',throws:src.throws??'R',contactR:clamp(r.contactR),contactL:clamp(r.contactL),rawPower:clamp(r.rawPower),vision:clamp(r.vision),discipline:clamp(r.discipline),powerUtilizationR:clamp(r.powerUtilizationR),powerUtilizationL:clamp(r.powerUtilizationL),speed:clamp(r.speed),fielding:clamp(r.fielding),reaction:clamp(r.reaction)});}
function pitcherEngine(src,inf){const r=inf.ratings??{};return createPhase1Pitcher({id:String(src.id),throws:src.throws??'R',control:clamp(r.control),command:clamp(r.command),movement:clamp(r.movement),pitchability:clamp(r.pitchability),stuff:clamp(r.stuff),pitchVelocityMph:null,stamina:clamp(r.stamina),role:inf.role??'RP'});}
const neutralH=createPhase1Hitter({id:'neutral-h',bats:'S'});
const neutralP=createPhase1Pitcher({id:'neutral-p',throws:'R',role:'SP'});
function conditionalHrbip(ctx, seed){
  const rng=new SeededRng(seed);let HR=0;
  for(let i=0;i<BIP_REPS;i++){
    const cq=sampleContactQuality(ctx,rng);
    const ev=sampleExitVelocity(ctx,cq,rng);
    const la=sampleLaunchAngle(ctx,cq,rng);
    const spray=sampleSprayDirection(ctx,la,rng);
    if(resolveWallClearance(ev,la,spray,ctx.park).homeRun) HR++;
  }
  return HR/BIP_REPS;
}
function simHitter(src,inf){
  const h=hitterEngine(src,inf), rng=new SeededRng('e-backtest:h:common-random-numbers');let K=0,BB=0;
  const ctx=buildPAContext({hitter:{...h.hitting,...h.tendencies,...h.running,bats:h.bats},pitcher:{...neutralP.pitching,stuff:neutralP.derived.stuff,throws:neutralP.throws}});
  for(let i=0;i<REPS;i++){const r=simulatePA(ctx,rng);if(r.outcome==='K')K++;if(r.outcome==='BB')BB++;}
  return{k:K/REPS,bb:BB/REPS,hrbip:conditionalHrbip(ctx,'e-backtest:h:bip-common')};
}
function simPitcher(src,inf){
  const p=pitcherEngine(src,inf), rng=new SeededRng('e-backtest:p:common-random-numbers');let K=0,BB=0;
  const ctxR=buildPAContext({hitter:{...neutralH.hitting,...neutralH.tendencies,...neutralH.running,bats:'R'},pitcher:{...p.pitching,stuff:p.derived.stuff,throws:p.throws}});
  const ctxL=buildPAContext({hitter:{...neutralH.hitting,...neutralH.tendencies,...neutralH.running,bats:'L'},pitcher:{...p.pitching,stuff:p.derived.stuff,throws:p.throws}});
  for(let i=0;i<REPS;i++){const ctx=i%2===0?ctxR:ctxL;const r=simulatePA(ctx,rng);if(r.outcome==='K')K++;if(r.outcome==='BB')BB++;}
  const hrbip=(conditionalHrbip(ctxR,'e-backtest:p:bip-common:R')+conditionalHrbip(ctxL,'e-backtest:p:bip-common:L'))/2;
  return{k:K/REPS,bb:BB/REPS,hrbip};
}
function observedRows(group){const m=new Map();for(const r of base.stats??[]){if(r.group!==group||!['MLB','AAA'].includes(r.level)||(r.splitContext?.type??'TOTAL')!=='TOTAL')continue;const id=String(r.playerId);const key=`${id}:${r.level}`;let x=m.get(key);if(!x){x={id,level:r.level,pa:0,bf:0,k:0,bb:0,hr:0,bip:0};m.set(key,x);}const v=r.values??{};if(group==='hitting'){const pa=Number(v.plateAppearances??0),ab=Number(v.atBats??0),so=Number(v.strikeOuts??0),bb=Number(v.baseOnBalls??0),hr=Number(v.homeRuns??0),sf=Number(v.sacFlies??0),sh=Number(v.sacBunts??0);x.pa+=pa;x.k+=so;x.bb+=bb;x.hr+=hr;x.bip+=Math.max(0,ab-so+sf+sh);}else{const bf=Number(v.battersFaced??0),ab=Number(v.atBats??0),so=Number(v.strikeOuts??0),bb=Number(v.baseOnBalls??0),hr=Number(v.homeRuns??0),sf=Number(v.sacFlies??0),sh=Number(v.sacBunts??0);x.bf+=bf;x.k+=so;x.bb+=bb;x.hr+=hr;x.bip+=Math.max(0,ab-so+sf+sh);}}return [...m.values()];}
function currentLevel(id){const p=srcById.get(id);return p?.assignedLevel??p?.level;}
function pearson(pairs,a,b){const xs=pairs.map(x=>x[a]),ys=pairs.map(x=>x[b]);const mx=xs.reduce((s,x)=>s+x,0)/xs.length,my=ys.reduce((s,x)=>s+x,0)/ys.length;let n=0,dx=0,dy=0;for(let i=0;i<xs.length;i++){const x=xs[i]-mx,y=ys[i]-my;n+=x*y;dx+=x*x;dy+=y*y;}return dx&&dy?n/Math.sqrt(dx*dy):0;}
function rank(vals){const s=vals.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]);const out=Array(vals.length);for(let i=0;i<s.length;){let j=i+1;while(j<s.length&&s[j][0]===s[i][0])j++;const r=(i+j-1)/2+1;for(let k=i;k<j;k++)out[s[k][1]]=r;i=j;}return out;}
function spearman(pairs,a,b){const ra=rank(pairs.map(x=>x[a])),rb=rank(pairs.map(x=>x[b]));return pearson(ra.map((x,i)=>({x,y:rb[i]})),'x','y');}
function testGroup(group){const rows=observedRows(group).filter(x=>currentLevel(x.id)===x.level && (group==='hitting'?x.pa>=250:x.bf>=250));const out=[];for(const x of rows){const inf=infById.get(x.id),src=srcById.get(x.id);if(!inf||!src||inf.type!==(group==='hitting'?'HITTER':'PITCHER'))continue;const pred=group==='hitting'?simHitter(src,inf):simPitcher(src,inf);const den=group==='hitting'?x.pa:x.bf;out.push({id:x.id,level:x.level,obsK:x.k/den,obsBB:x.bb/den,obsHRBIP:x.bip?x.hr/x.bip:0,predK:pred.k,predBB:pred.bb,predHRBIP:pred.hrbip});}return out;}
const hitters=testGroup('hitting'),pitchers=testGroup('pitching');
function metrics(rows){return{n:rows.length,kPearson:+pearson(rows,'obsK','predK').toFixed(3),kSpearman:+spearman(rows,'obsK','predK').toFixed(3),bbPearson:+pearson(rows,'obsBB','predBB').toFixed(3),bbSpearman:+spearman(rows,'obsBB','predBB').toFixed(3),hrBipPearson:+pearson(rows,'obsHRBIP','predHRBIP').toFixed(3),hrBipSpearman:+spearman(rows,'obsHRBIP','predHRBIP').toFixed(3)};}
const hm=metrics(hitters),pm=metrics(pitchers);
const byLevel={hitters:{MLB:metrics(hitters.filter(x=>x.level==='MLB')),AAA:metrics(hitters.filter(x=>x.level==='AAA'))},pitchers:{MLB:metrics(pitchers.filter(x=>x.level==='MLB')),AAA:metrics(pitchers.filter(x=>x.level==='AAA'))}};
const gates={hitterSample:hm.n>=500,pitcherSample:pm.n>=500,hitterK:Math.min(byLevel.hitters.MLB.kSpearman,byLevel.hitters.AAA.kSpearman)>=0.30,hitterBB:Math.min(byLevel.hitters.MLB.bbSpearman,byLevel.hitters.AAA.bbSpearman)>=0.25,hitterHRBIP:Math.min(byLevel.hitters.MLB.hrBipSpearman,byLevel.hitters.AAA.hrBipSpearman)>=0.20,pitcherK:Math.min(byLevel.pitchers.MLB.kSpearman,byLevel.pitchers.AAA.kSpearman)>=0.30,pitcherBB:Math.min(byLevel.pitchers.MLB.bbSpearman,byLevel.pitchers.AAA.bbSpearman)>=0.25,pitcherHRBIP:Math.min(byLevel.pitchers.MLB.hrBipSpearman,byLevel.pitchers.AAA.hrBipSpearman)>=0.08};
const result={schema:'THE_CALL_UP_PHASE_E_DISTRIBUTION_BACKTEST_V2',repsPerPlayer:REPS,bipRepsPerPlayer:BIP_REPS,hitters:hm,pitchers:pm,byLevel,gates,pass:Object.values(gates).every(Boolean)};
fs.mkdirSync(new URL('reports/',ROOT),{recursive:true});fs.writeFileSync(new URL(OUTPUT,ROOT),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));console.log(result.pass?'PHASE_E_DISTRIBUTION_BACKTEST_PASS':'PHASE_E_DISTRIBUTION_BACKTEST_FAIL');if(VERIFY&&!result.pass)process.exitCode=1;
