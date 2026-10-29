import fs from 'node:fs';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
import {OWNER_ABI,LEDGER_ABI} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/network/lease-gas-owner.mjs';
const ids=JSON.parse(fs.readFileSync(new URL('./original-ids.json',import.meta.url)));
if(ids.length!==10||new Set(ids).size!==10||ids.some(x=>!/^0x[0-9a-f]{64}$/.test(x)))throw Error('scope refused');
const q=new QuorumChain({rpcs:['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'],quorum:2,timeoutMs:10000});
const ledger='0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B',reserve='0x12A3f873041Dec436DaA0085B766a399A6fA3639';
const snap=await q.snapshot(async(c,blockNumber)=>{
 const block=await c.getBlock({blockNumber});
 const ds=await c.multicall({blockNumber,allowFailure:false,contracts:ids.map(id=>({address:ledger,abi:LEDGER_ABI,functionName:'get',args:[id]}))});
 const rs=await c.multicall({blockNumber,allowFailure:false,contracts:ds.map(d=>({address:reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[d.id,d.owner]}))});
 return {blockHash:block.hash,chainTimestamp:block.timestamp,apps:ds.map((d,i)=>({id:d.id,active:d.active,runner:d.runner,runnerOperator:d.runnerOperator,leaseUntil:d.leaseUntil,leaseLive:d.active&&d.leaseUntil>block.timestamp,reserveWei:rs[i].balanceWei,reserveEnabled:rs[i].enabled,rate:d.rate,computeBalance6:d.balance6}))};
});
const out={capturedAt:new Date().toISOString(),readOnly:true,scope:'Original ten only. Canonical quorum observation is not finality or endpoint health, and does not identify payment origin.',...snap};
const text=JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2);fs.writeFileSync(new URL('./result.json',import.meta.url),text+'\n');console.log(text);
