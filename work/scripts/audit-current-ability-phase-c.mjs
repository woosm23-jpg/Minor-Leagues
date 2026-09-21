import fs from 'node:fs';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';

const ROOT = new URL('../', import.meta.url);
function readGz(rel){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(rel, ROOT))).toString('utf8')); }
function universe(data, hash){ return { schemaVersion:1, origin:'MASTER_SNAPSHOT', sourceSnapshot:{id:data.metadata?.snapshotId??'v2',hash,season:data.metadata?.season??2026}, copiedAtCareerStart:data.metadata?.snapshotDate??'2026-09-20', sourceVersion:'v50-current-ability-audit', snapshotDate:data.metadata?.snapshotDate??'2026-09-20', provenance:data.sources??[], data, independent:true }; }
function q(arr,p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); return a[Math.max(0,Math.min(a.length-1,Math.round((a.length-1)*p)))]; }
function summary(arr){ return {n:arr.length,mean:arr.length?Number((arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(3)):null,p10:q(arr,.1),median:q(arr,.5),p90:q(arr,.9),min:q(arr,0),max:q(arr,1)}; }
function finiteAudit(obj,path='root',bad=[]){ if(typeof obj==='number'&&!Number.isFinite(obj)) bad.push(path); else if(Array.isArray(obj)) obj.forEach((v,i)=>finiteAudit(v,`${path}[${i}]`,bad)); else if(obj&&typeof obj==='object') for(const [k,v] of Object.entries(obj)) finiteAudit(v,`${path}.${k}`,bad); return bad; }

const base=readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const patch=readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
if(patch.baseSnapshotHash!==base.metadata.contentHash) throw new Error(`base hash mismatch ${patch.baseSnapshotHash} != ${base.metadata.contentHash}`);
const phaseBData={...base,tracking:[],pitchArsenal:[]};
const phaseCData={...base,tracking:patch.tracking,pitchArsenal:patch.pitchArsenal};

let t=performance.now();
const phaseB=inferRealWorldUniverse(universe(phaseBData,base.metadata.contentHash));
const phaseBMs=performance.now()-t;
t=performance.now();
const phaseC=inferRealWorldUniverse(universe(phaseCData,base.metadata.contentHash));
const phaseCMs=performance.now()-t;
const names=new Map(base.players.map(p=>[String(p.id),p]));
const bBy=new Map(phaseB.inference.players.map(p=>[String(p.playerId),p]));
const cBy=new Map(phaseC.inference.players.map(p=>[String(p.playerId),p]));
const deltas=[];
for(const [id,c] of cBy){ const b=bBy.get(id); if(!b) continue; const pl=names.get(id); deltas.push({id,name:pl?.fullName??id,level:pl?.level??c.level,type:c.type,role:c.role??null,b:Number(b.overall),c:Number(c.overall),delta:Number((c.overall-b.overall).toFixed(2)),confidence:c.confidence,tracking:c.evidence?.trackingApplied??false,arsenal:c.evidence?.arsenalDerivedStuff??false}); }
const abs=deltas.map(x=>Math.abs(x.delta));
const byLevel={}; for(const level of ['MLB','AAA','AA','HIGH_A','A']) byLevel[level]=summary(deltas.filter(x=>x.level===level).map(x=>x.c));
const deltaByLevel={}; for(const level of ['MLB','AAA','AA','HIGH_A','A']) deltaByLevel[level]=summary(deltas.filter(x=>x.level===level).map(x=>x.delta));
const deltaTracked=summary(deltas.filter(x=>x.tracking||x.arsenal).map(x=>x.delta));
const deltaUntracked=summary(deltas.filter(x=>!x.tracking&&!x.arsenal).map(x=>x.delta));
const topUp=[...deltas].sort((a,b)=>b.delta-a.delta).slice(0,30);
const topDown=[...deltas].sort((a,b)=>a.delta-b.delta).slice(0,30);
const thresholds=Object.fromEntries([3,5,8,10,12,15].map(v=>[String(v),deltas.filter(x=>Math.abs(x.delta)>=v).length]));

const named=['Aaron Judge','Juan Soto','Bobby Witt Jr.','Yordan Alvarez','Shohei Ohtani','Gunnar Henderson','Paul Skenes','Tarik Skubal','Jacob deGrom','Garrett Crochet','Zack Wheeler','Hunter Greene','Jihwan Bae','Christian Bethancourt','Kenley Jansen','Tim Hill'];
const namedRows=[];
for(const name of named){ const pl=base.players.find(p=>p.fullName===name); if(!pl) continue; const b=bBy.get(String(pl.id)), c=cBy.get(String(pl.id)); namedRows.push({name,id:pl.id,level:pl.level,type:c?.type,role:c?.role,b:b?.overall,c:c?.overall,delta:b&&c?Number((c.overall-b.overall).toFixed(2)):null,ratings:c?.ratings,pitchArsenal:c?.pitchArsenal?.slice(0,6)}); }

const trackingPitcherIds=new Set(patch.tracking.filter(r=>r.level==='MLB'&&r.metricGroup.startsWith('PITCHING_')).map(r=>String(r.playerId)));
const arsenalMlbIds=new Set(patch.pitchArsenal.filter(r=>r.level==='MLB').map(r=>String(r.playerId)));
let arsenalMissing=0,usageBad=0,stuffMissing=0;
for(const id of arsenalMlbIds){ const c=cBy.get(id); if(!c||c.type!=='PITCHER') continue; if(!c.pitchArsenal?.length) arsenalMissing++; const usage=(c.pitchArsenal??[]).reduce((s,p)=>s+Number(p.usage||0),0); if(c.pitchArsenal?.length && (usage<0.98||usage>1.02)) usageBad++; if(!Number.isFinite(c.ratings?.stuff)) stuffMissing++; }
const result={
  baseHash:base.metadata.contentHash,patchHash:patch.baseSnapshotHash,players:base.players.length,trackingRows:patch.tracking.length,pitchArsenalRows:patch.pitchArsenal.length,
  runtimeMs:{phaseB:Number(phaseBMs.toFixed(1)),phaseC:Number(phaseCMs.toFixed(1))},
  finiteErrors:{phaseB:finiteAudit(phaseB.inference).slice(0,20),phaseC:finiteAudit(phaseC.inference).slice(0,20)},
  overallByLevel:byLevel,deltaByLevel,deltaTracked,deltaUntracked,deltaAbs:summary(abs),thresholds,topUp,topDown,named:namedRows,
  arsenalGate:{mlbTrackingPitchers:trackingPitcherIds.size,mlbArsenalPitchers:arsenalMlbIds.size,arsenalMissing,usageBad,stuffMissing},
  modelId:phaseC.inference.modelId
};
fs.mkdirSync(new URL('reports/',ROOT),{recursive:true});
fs.writeFileSync(new URL('reports/v50-phase-c-fix4-current-ability-audit.json',ROOT),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
