import fs from 'node:fs';
import {QuorumChain,validateRpcOrigins} from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/cli/independent.mjs';
import {OWNER_ABI,LEDGER_ABI} from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/network/lease-gas-owner.mjs';
const id='0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33',ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
const rpcs=validateRpcOrigins(['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.drpc.org']);
const q=new QuorumChain({rpcs,quorum:2,timeoutMs:8000});
const result={capturedAt:new Date().toISOString(),readOnly:true,id,ledger,reserve,rpcs,signatures:false,submissions:false,finalityProven:false};
try { result.chain=await q.snapshot(async(c,blockNumber)=>{
 const [d,head,ledgerCode,reserveCode]=await Promise.all([c.readContract({address:ledger,abi:LEDGER_ABI,functionName:'get',args:[id],blockNumber}),c.getBlock({blockNumber}),c.getCode({address:ledger,blockNumber}),c.getCode({address:reserve,blockNumber})]);
 if(!ledgerCode||ledgerCode==='0x'||!reserveCode||reserveCode==='0x')throw Error('Contract code absent');
 const r=await c.readContract({address:reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[id,d.owner],blockNumber});
 return {timestamp:head.timestamp,deployment:{id:d.id,owner:d.owner,active:d.active,runner:d.runner,runnerOperator:d.runnerOperator,leaseUntil:d.leaseUntil,leaseLive:d.active&&d.leaseUntil>head.timestamp,rate:d.rate,computeBalance6:d.balance6,spent6:d.spent6},reserve:r,ledgerCodeBytes:(ledgerCode.length-2)/2,reserveCodeBytes:(reserveCode.length-2)/2};
 });}catch(e){result.chainError={message:e.message,failures:e.failures??[]};}
try {const response=await fetch('https://api.enclave.host/v1/deployments/'+id,{redirect:'error',signal:AbortSignal.timeout(8000)});let total=0;const chunks=[];for await(const chunk of response.body){total+=chunk.length;if(total>65536)throw Error('API body bound');chunks.push(chunk);}const row=JSON.parse(Buffer.concat(chunks).toString());result.api={status:response.status,deployment:{id:row.id,status:row.status,enclave:row.enclave,onchain:row.onchain,ledger:row.ledger}};}catch(e){result.apiError={message:e.message};}
const text=JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2);if(Buffer.byteLength(text)>32768)throw Error('Output bound');fs.writeFileSync(new URL('./RESULT.local.json',import.meta.url),text+'\n');console.log(JSON.stringify({chain:!!result.chain,chainError:result.chainError,apiStatus:result.api?.deployment?.status}));if(!result.chain)process.exitCode=1;
