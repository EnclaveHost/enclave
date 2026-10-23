// Offline availability probe; deliberately NOT a substitute for cryptographic proof verification.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url));const source=path.join(root,'rpc-priority/repo/network/witness-gateway.mjs');
const sha=()=>fs.readFile(source).then(b=>createHash('sha256').update(b).digest('hex'));const before=await sha();
const {createWitnessGateway,dirWitnessCache,witnessKey}=await import(pathToFileURL(source));
const out=path.join(root,'root-witness-cache-probe');await fs.mkdir(out,{recursive:true});const dir=await fs.mkdtemp(path.join(out,'cache-'));
try {
 const req={jsonrpc:'2.0',id:1,method:'eth_getProof',params:['0x'+'11'.repeat(20),[],{blockHash:'0x'+'22'.repeat(32)}]};
 const w=witnessKey(req.method,req.params);assert.ok(w);
 const malformed={accountProof:'not-an-array'};const replacement={accountProof:[],note:'replacement sentinel, not a claimed valid proof'};
 const calls=[];const g=createWitnessGateway({upstreams:['https://first.invalid','https://second.invalid'],fetch:async url=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result:malformed})};}});
 const result=await g.handle(req);assert.deepEqual(result.result,malformed);assert.deepEqual(calls,['https://first.invalid']);
 const cache=dirWitnessCache(dir);await cache.put(w,malformed);await cache.put(w,replacement);assert.deepEqual(await cache.get(w),malformed);
 assert.equal(await sha(),before);
 const receipt={at:new Date().toISOString(),sourceSha256:before,malformedProofReturnedByGateway:true,secondUpstreamContacted:false,firstCachedMalformedResultSurvivesReplacement:true,scope:'Gateway/cache transport behavior only. Helios is expected to reject the malformed proof; this demonstrates an availability and persistent cache-poisoning risk, NOT acceptance of false chain state.'};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await fs.rm(dir,{recursive:true,force:true});}
