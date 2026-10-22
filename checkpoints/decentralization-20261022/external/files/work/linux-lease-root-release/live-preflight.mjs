import fs from 'node:fs';
import { createPublicClient, http } from '../enclave/node_modules/viem/_esm/index.js';
import { verifiedLeaseAuthority } from '../enclave/client/lease-executor-authority.mjs';
import { parseDeploymentRecord, LEDGER_ABI, OWNER_ABI, REGISTRY_ABI } from '../enclave/network/lease-gas-owner.mjs';
import { STATUS, KIND } from '../enclave/client/lease-executor-client.mjs';
const output='outputs/decentralization-audit/linux-conduit-funding-preflight.json';
const deployment=parseDeploymentRecord(fs.readFileSync('outputs/app-lease-gas-review/lease-gas-deployment.json'),{expectedDigest:'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'});
const urls=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base-mainnet.public.blastapi.io'];
const clients=urls.map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
const a=await verifiedLeaseAuthority({clients,deployment,quorum:2});
const ids=[...new Set(JSON.parse(fs.readFileSync('outputs/app-lease-gas-review/complete-bootstrap-funding-proposal.json')).operations.slice(0,4).map(o=>o.app))];
const rows=[];
for(const id of ids){
 const dep=await a.client.readContract({address:a.pins.ledger,abi:LEDGER_ABI,functionName:'get',args:[id]});
 const [reserve,renew,host]=await Promise.all([
 a.client.readContract({address:a.pins.reserve,abi:OWNER_ABI,functionName:'reserveOf',args:[id,dep.owner]}),
 a.client.readContract({address:a.pins.reserve,abi:OWNER_ABI,functionName:'statusOf',args:[id,KIND.renew,dep.runner,dep.runnerOperator]}),
 a.client.readContract({address:a.pins.registry,abi:REGISTRY_ABI,functionName:'get',args:[dep.runner]})]);
 rows.push({id,owner:dep.owner,active:dep.active,runner:dep.runner,runnerOperator:dep.runnerOperator,leaseUntil:dep.leaseUntil,leaseRemainingSeconds:dep.leaseUntil-a.block.timestamp,reserve,renewStatus:STATUS[Number(renew[0])],renewBudget:{availableWei:renew[1],epochLeftWei:renew[2],maxPerOpWei:renew[3]},hostActive:host.active,hostOperator:host.operator});
}
const data={at:new Date().toISOString(),readOnly:true,quorum:a.quorum,agreeing:a.agreeing,block:a.block,rows};
fs.writeFileSync(output,JSON.stringify(data,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({at:data.at,block:String(a.block.number),agreeing:a.agreeing,rows:rows.map(r=>({id:r.id,leaseRemainingSeconds:String(r.leaseRemainingSeconds),enabled:r.reserve.enabled,balanceWei:String(r.reserve.balanceWei),renewStatus:r.renewStatus,hostActive:r.hostActive}))}));
