import fs from 'node:fs';
import {createRequire} from 'node:module';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {fundingSessionVaultAbi} from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/relay-quarantine-prep-r1/generated/relay/funding-abi.mjs';
const {decodeEventLog}=createRequire('/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs')('viem');
const hash='0x9d58496d32380bcefa54082e079ad01c9e342e86b740106d297c95a47a982dfa';
const vault='0x86960ed815ca5500e6cfcdbbb32b221c2acf055a';
const id='0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238';
const q=new QuorumChain({rpcs:['https://base-rpc.publicnode.com','https://api.enclave.host/rpc/base','https://base.drpc.org'],quorum:2,timeoutMs:10000});
const out={readOnly:true,capturedAt:new Date().toISOString(),scope:'One known successful funding receipt, exact vault event attribution and current session counters. No signing, submissions or provider retries.'};
try{out.snapshot=await q.snapshot(async(c,blockNumber)=>{
 const r=await c.getTransactionReceipt({hash});
 if(r.status!=='success'||r.blockNumber>blockNumber||(await c.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash)throw Error('receipt not canonical confirmed success');
 const events=[];
 for(const l of r.logs){
  if(l.address.toLowerCase()!==vault)continue;
  try{const e=decodeEventLog({abi:fundingSessionVaultAbi,data:l.data,topics:l.topics});if(['GasFunded','SessionOp'].includes(e.eventName))events.push({name:e.eventName,args:e.args});}catch{}
 }
 const fund=events.find(e=>e.name==='GasFunded'&&e.args.deployment?.toLowerCase()===id);
 if(!fund)throw Error('matching GasFunded event absent');
 const op=events.find(e=>e.name==='SessionOp'&&e.args.sid===fund.args.sid);
 if(!op)throw Error('matching SessionOp absent');
 const sid=fund.args.sid,lane=BigInt(op.args.nonce)>>64n;
 const [s,seq]=await Promise.all([c.readContract({address:vault,abi:fundingSessionVaultAbi,functionName:'sessionOf',args:[sid],blockNumber}),c.readContract({address:vault,abi:fundingSessionVaultAbi,functionName:'seqOf',args:[sid,lane],blockNumber})]);
 return {receipt:{hash,status:r.status,blockNumber:r.blockNumber,blockHash:r.blockHash},vault,events,session:{sid,live:s[1],balance6:s[0].balance6,spent6:s[0].spent6,periodSpent6:s[0].periodSpent6,periodOps:s[0].periodOps,actions:s[0].actions,expiresAt:s[0].expiresAt,lane,sequence:seq},thisDebit6:BigInt(fund.args.usdcSpent6)+BigInt(fund.args.fee6)};
 });}catch(e){out.error={message:e.message,failures:e.failures??null};}
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2);fs.writeFileSync(new URL('./result.json',import.meta.url),text+'\n');console.log(text);
