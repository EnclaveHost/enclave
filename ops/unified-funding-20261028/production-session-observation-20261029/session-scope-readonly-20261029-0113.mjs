import fs from 'node:fs';
import {QuorumChain} from '/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle/cli/independent.mjs';
const abi=JSON.parse(fs.readFileSync(new URL('./session-r1/out/SessionVault.sol/SessionVault.json',import.meta.url))).abi;
const q=new QuorumChain({rpcs:['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'],quorum:2,timeoutMs:15000});
const snap=await q.snapshot(async(c,blockNumber)=>{
const [s,live,apps]=await c.readContract({blockNumber,address:'0xB794C4DD0e1C5E6B72281799F282BfdE7654345D',abi,functionName:'sessionOf',args:['0x3aaf56fd65c168ba3e99e204ede06e2f2e8f1ff544ecd28f9ef8a4a011312227']});
const ownerNonce=await c.getTransactionCount({blockNumber,address:'0x0b2d009c0c9Af05b12100D77F3c815fea822eE61'});
const code=await c.getBytecode({blockNumber,address:'0x8229D0bf25328D6317D9B670c982A8ca4Dc537DB'});
return {live,anyApp:s.anyApp,apps,actions:s.actions,envs:s.envs,balance6:s.balance6,spent6:s.spent6,expiresAt:s.expiresAt,ownerNonce,firstDeploymentHasCode:!!code&&code!=='0x'};
});
const data=JSON.stringify(snap,(_,v)=>typeof v==='bigint'?v.toString():v,2);
fs.writeFileSync(new URL('./session-scope-readonly-20261029-0113.json',import.meta.url),data);console.log(data);
