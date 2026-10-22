import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ReplicaNode } from './state-replica.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-replica-replay-'));
const key = randomBytes(32);
let now = 0, replayOnly = false;
const captured = new Map(), nodes = [];
try {
  for(let self = 0; self < 3; self++) nodes.push(new ReplicaNode({self, n:3, key, dir:path.join(root,String(self),'data'), metaFile:path.join(root,String(self),'meta'), now:()=>now, leaseMs:10000, random:()=>0,
    send:async(i,bytes)=> {
      if(replayOnly) return captured.get(i);
      const response = await nodes[i].handle(bytes);
      captured.set(i, Buffer.from(response));
      return response;
    }}));
  now = 30000;
  const elected = await nodes[0].campaign();
  if(!elected) throw new Error('fixture did not establish original primary');
  replayOnly = true;
  fs.writeFileSync(path.join(root,'0/data/acknowledged-write.json'), JSON.stringify({fixture:'new state absent on followers'}));
  const committed = await nodes[0].commit();
  const followerCopies = [1,2].filter(i=>fs.existsSync(path.join(root,String(i),'data/acknowledged-write.json'))).length;
  const evidence = {candidateSha256:createHash('sha256').update(fs.readFileSync(new URL('./state-replica.mjs',import.meta.url))).digest('hex'), elected, networkMode:'All new requests dropped; only earlier captured encrypted snapshot acknowledgments replayed, no key access by replay transport', committed, followerCopies, majority:2, actualCopies:1+followerCopies, vulnerabilityReproduced:committed && followerCopies===0};
  console.log(JSON.stringify(evidence,null,2));
  if(evidence.vulnerabilityReproduced || committed || followerCopies !== 0) process.exitCode=2;
} finally { for(const n of nodes)n.stop(); fs.rmSync(root,{recursive:true,force:true}); }
