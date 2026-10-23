import { LeaseReader } from './rpc-priority/repo/network/lease-reader.mjs';
import { writeFileSync,readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
const file=new URL('./rpc-priority/repo/network/lease-reader.mjs',import.meta.url);
const now=Date.now();
const verifier={request:async(m,p)=>{
  if(m==='eth_chainId')return '0x2105';
  if(m==='eth_blockNumber')return '0x64';
  if(m==='eth_getBlockByNumber')return {number:p[0],hash:'0x'+'11'.repeat(32),stateRoot:'0x'+'22'.repeat(32),timestamp:'0x'+Math.floor(now/1000).toString(16)};
  throw new Error('unexpected method');
}};
const reader=new LeaseReader({addressBook:'0x'+'33'.repeat(20),authority:'verifier',verifier,deadlineMs:100});
const start=performance.now();
const result=await Promise.race([
  reader.agreed(()=>new Promise(()=>{})).then(()=>({outcome:'resolved'}),e=>({outcome:'rejected',error:e.message})),
  new Promise(resolve=>setTimeout(()=>resolve({outcome:'still-pending-after-400ms'}),400))
]);
const out={at:new Date().toISOString(),sourceSha256:createHash('sha256').update(readFileSync(file)).digest('hex'),configuredDeadlineMs:100,observedMs:Math.round(performance.now()-start),...result,note:'Actual LeaseReader.agreed with synthetic valid chain transport; callback never settles. No network, no claim of production outage.'};
writeFileSync(new URL('./root-verifier-deadline-result.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(out));
