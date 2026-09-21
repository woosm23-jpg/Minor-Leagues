import fs from 'node:fs'; import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';
const ROOT=new URL('../',import.meta.url);
const read=(p)=>JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(p,ROOT))).toString('utf8'));
const base=read('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const patch=read('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
const U=(d)=>({origin:'MASTER_SNAPSHOT',sourceSnapshot:{id:base.metadata.snapshotId,hash:base.metadata.contentHash,season:2026},snapshotDate:base.metadata.snapshotDate,copiedAtCareerStart:base.metadata.snapshotDate,sourceVersion:'audit',provenance:base.sources,data:d,independent:true});
const b=inferRealWorldUniverse(U({...base,tracking:[],pitchArsenal:[]}));
const c=inferRealWorldUniverse(U({...base,tracking:patch.tracking,pitchArsenal:patch.pitchArsenal}));
const bm=new Map(b.inference.players.map(x=>[String(x.playerId),x])),cm=new Map(c.inference.players.map(x=>[String(x.playerId),x]));
const targets=['Tim Hill','A.J. Ewing','Kevin Kelly','Brad Lord','Jacob Young','Hoby Milner','Yennier Cano','Clay Holmes','Pete Crow-Armstrong','Chandler Simpson','Dylan Cease','Bryce Harper','Alex Vesia','Salvador Perez','Kyle Manzardo','Alec Burleson','Paul Skenes','Tarik Skubal','Aaron Judge','Juan Soto'];
for(const name of targets){
 const p=base.players.find(x=>x.fullName===name); if(!p) continue; const id=String(p.id),B=bm.get(id),C=cm.get(id);
 console.log('\n###',name,id,p.level,B?.overall,'->',C?.overall,'delta',B&&C?(C.overall-B.overall).toFixed(2):'NA');
 console.log('B ratings',B?.ratings); console.log('C ratings',C?.ratings); if(C?.pitchArsenal?.length) console.log('C arsenal',C.pitchArsenal);
 const tr=patch.tracking.filter(r=>String(r.playerId)===id).sort((a,b)=>b.season-a.season||a.metricGroup.localeCompare(b.metricGroup));
 console.log('tracking',tr);
 const ar=patch.pitchArsenal.filter(r=>String(r.playerId)===id).sort((a,b)=>b.season-a.season||b.usage-a.usage);
 console.log('raw arsenal',ar.slice(0,24));
}
