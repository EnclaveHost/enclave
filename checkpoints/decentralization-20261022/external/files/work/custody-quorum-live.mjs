import fs from 'node:fs';
import {createChainReaderV2} from './enclave/custody/v2/chain.mjs';
const rpcs=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base.drpc.org','https://base.public.blockpi.network/v1/rpc/public'];
const vault='0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5',committeeId='0x47742ae8c544ff66a4ad91cfbf5cecdd389013da362813ba3b55c4e247b0f7a3';
const base=createChainReaderV2({rpcs,vault,chainId:8453,minAgree:3,confirmations:2});
const checks=[];
for(let omit=-1;omit<rpcs.length;omit++) {
 const clients=base.clients.map((c,i)=>i===omit?{getChainId:async()=>{throw Error('deliberate peer refusal');}}:c);
 const r=createChainReaderV2({clients,vault,chainId:8453,minAgree:3,confirmations:2});
 try {
  const s=await r.readCommittee({committeeId});
  const check={omitted:omit<0?null:rpcs[omit],ok:true,block:String(s.blockNumber),hash:s.blockHash,timestamp:s.blockTimestamp,epoch:s.committee?.epoch,machines:s.committee?.machines.length};
  checks.push(check);console.log(JSON.stringify(check));
 }catch(e){const check={omitted:omit<0?null:rpcs[omit],ok:false,code:e.code,message:e.message};checks.push(check);console.log(JSON.stringify(check));}
}
fs.writeFileSync('outputs/custody-quorum-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),initialAttempt:JSON.parse(fs.readFileSync('work/custody-quorum-initial.json','utf8')),replacementReason:'1RPC returned -32001: usage limit reached; BlockPI independently passed a hash-pinned committee read.',productionActivated:false,chainId:8453,vault,committeeId,minAgree:3,confirmations:2,checks,scope:'Read-only public RPC tests against the existing one-seat production vault; no new runtime, vault or secret bundle activated.'},null,2)+'\n');
if(checks.some(c=>!c.ok))process.exitCode=1;
