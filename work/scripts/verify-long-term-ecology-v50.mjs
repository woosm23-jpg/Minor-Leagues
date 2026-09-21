import fs from 'node:fs';
import zlib from 'node:zlib';
import { inferRealWorldUniverse } from '../src/data/realWorldInference.js';
import { nextAnnualEcology } from '../src/engine/career/leagueEcology.js';

function readGz(p){return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));}
function mean(xs){return xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);}
function round(x,n=2){return Number(x.toFixed(n));}

const base=readGz('data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz');
const phaseC=readGz('data/the_call_up_phase_c/statcast-phase-c-2026.json.gz');
const data={...base,tracking:phaseC.tracking,pitchArsenal:phaseC.pitchArsenal};
const universe={schemaVersion:1,origin:'MASTER_SNAPSHOT',sourceSnapshot:{id:'v2',hash:base.metadata.contentHash,season:2026},data};
const inferred=inferRealWorldUniverse(universe);
const by=new Map(inferred.inference.players.map(x=>[String(x.playerId),x]));
let players=base.players.map(p=>({
  id:String(p.id),
  fullName:p.fullName,
  ovr:Number(by.get(String(p.id))?.overall ?? 40),
  physical:{age:Number(p.age ?? 24),durability:50},
  realWorld:{sourceLevel:p.level,organizationId:p.organizationId ?? null}
}));
const target=players.length;
let strength=0;
let totalEntrants=0,totalRetired=0,totalReleased=0;
const checkpoints=[];
function snap(year,label){
  const ages=players.map(p=>Number(p.physical?.age ?? 0));
  const generated=players.filter(p=>p.generated).length;
  checkpoints.push({
    label,year,population:players.length,meanAge:round(mean(ages)),under25:ages.filter(a=>a<25).length,
    age35plus:ages.filter(a=>a>=35).length,age40plus:ages.filter(a=>a>=40).length,
    generated,generatedShare:round(generated/players.length,4),meanOvr:round(mean(players.map(p=>Number(p.ovr??0))))
  });
}
snap(2026,'START');
for(let year=2027;year<=2046;year++){
  const r=nextAnnualEcology({players,year,seed:'production-ecology-v50',targetPopulation:target,previousClassStrength:strength});
  players=r.players;strength=r.classStrength;totalEntrants+=r.entrants.length;totalRetired+=r.retiredIds.length;totalReleased+=r.releasedIds.length;
  const elapsed=year-2026;
  if([1,5,10,20].includes(elapsed)) snap(year,`${elapsed}Y`);
}
const final=checkpoints.at(-1);
const pass = final.population===target && final.under25>=Math.round(target*0.12) && final.age40plus<=Math.round(target*0.12) && final.meanAge>=23 && final.meanAge<=31.5;
const report={schema:'TCU_LONG_TERM_ECOLOGY_V50_V1',targetPopulation:target,totalEntrants,totalRetired,totalReleased,classStrength:strength,checkpoints,pass};
fs.writeFileSync('reports/v50-long-term-ecology.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!pass) process.exitCode=1;
