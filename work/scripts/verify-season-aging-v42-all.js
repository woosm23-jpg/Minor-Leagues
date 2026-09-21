import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const seedArg=process.argv.find(a=>a.startsWith('--seeds='));
const jobsArg=process.argv.find(a=>a.startsWith('--jobs='));
const outputArg=process.argv.find(a=>a.startsWith('--output='));
const verify=process.argv.includes('--verify');
const recordGolden=process.argv.includes('--record-golden');
const seeds=Number(seedArg?.slice(8)??6);
const jobs=Math.max(1,Math.min(seeds,Number(jobsArg?.slice(7)??3)));
const worker=fileURLToPath(new URL('./verify-season-aging-v42.js',import.meta.url));
const bySeed=new Map();
let nextSeed=1;

async function runSeed(seed){
  const temp=`reports/.phase3-aging-v42-seed-${seed}.json`;
  const args=[worker,`--seed=${seed}`,`--output=${temp}`,'--quiet'];
  if(verify)args.push('--verify');
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{stdio:'inherit'});
    child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(new Error(`v42 seed ${seed} failed: ${code}`)));
  });
  const result=JSON.parse(fs.readFileSync(temp,'utf8'));
  fs.rmSync(temp,{force:true});
  bySeed.set(seed,result.rows[0]);
  process.stderr.write(`v42 seed ${seed}/${seeds} PASS\n`);
}

async function workerLoop(){
  while(true){
    const seed=nextSeed++;
    if(seed>seeds)return;
    await runSeed(seed);
  }
}

await Promise.all(Array.from({length:jobs},()=>workerLoop()));
const rows=[...bySeed.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row);
if(recordGolden){
  const golden={sourceVersion:'phase3_aging_position_migration_v42',rows:rows.map(({n,demo,created})=>({n,demoSha256:demo.sha256,createdSha256:created.sha256,demoMigrations:demo.migrations,createdMigrations:created.migrations}))};
  fs.writeFileSync(new URL('../tests/fixtures/v42-aging-world-golden.json',import.meta.url),JSON.stringify(golden,null,2)+'\n');
}
const report={version:'v42',sourceGolden:'phase3_aging_position_migration_v42',seeds,verified:verify,recordedGolden:recordGolden,isolatedProcesses:true,parallelJobs:jobs,rows};
const out=outputArg?.slice('--output='.length);
if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
