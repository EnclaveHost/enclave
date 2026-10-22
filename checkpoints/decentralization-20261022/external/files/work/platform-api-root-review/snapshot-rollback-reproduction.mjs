import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
async function run(label, rel) {
  const { ReplicaNode } = await import(rel);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-replica-rollback-')); const key=randomBytes(32);
  let now=0; const nodes=[], snapshots=new Map();
  try {
    for(let self=0;self<3;self++)nodes.push(new ReplicaNode({self,n:3,key,dir:path.join(root,String(self),'data'),metaFile:path.join(root,String(self),'meta'),now:()=>now,leaseMs:10000,random:()=>0,
      send:async(i,b)=>{snapshots.set(i,Buffer.from(b));return nodes[i].handle(b);}}));
    now=30000;if(!await nodes[0].campaign())throw new Error('election fixture failed');
    const captured=new Map(snapshots);
    fs.writeFileSync(path.join(root,'0/data/acknowledged-write.json'),'fixture data');
    if(!await nodes[0].commit())throw new Error('initial write fixture failed');
    const before=[1,2].filter(i=>fs.existsSync(path.join(root,String(i),'data/acknowledged-write.json'))).length;
    let rejected=0;for(const i of [1,2]){try{await nodes[i].handle(captured.get(i));}catch{rejected++;}}
    const after=[1,2].filter(i=>fs.existsSync(path.join(root,String(i),'data/acknowledged-write.json'))).length;
    const sha=createHash('sha256').update(fs.readFileSync(new URL(rel,import.meta.url))).digest('hex');
    console.log(JSON.stringify({label,sha,initialCommittedFollowerCopies:before,afterReplayingEarlierSnapshots:after,rejectedRequests:rejected,vulnerabilityReproduced:after<before}));
    return {before,after};
  }finally{for(const n of nodes)n.stop();fs.rmSync(root,{recursive:true,force:true});}
}
const old=await run('old candidate','./state-replica.mjs');
const fixed=await run('fixed candidate','./fixed/state-replica.mjs');
if(old.before!==2||old.after!==0||fixed.before!==2||fixed.after!==2)process.exitCode=2;
