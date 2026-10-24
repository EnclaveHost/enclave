// Root production wiring; importing this file does not read any signing key.
import fs from 'node:fs';import {pathToFileURL} from 'node:url';import {LIMIT} from './reclaim.mjs';import {originalGuestHealth} from './guest-health.mjs';
const repo=new URL('../custody-recipient-restore-20261023/repo/',import.meta.url),load=p=>import(new URL(p,repo));
const {createPublicClient,http}=await load('node_modules/viem/_esm/index.js');
const {privateKeyToAccount}=await load('node_modules/viem/_esm/accounts/index.js');
const {parseDeploymentRecord,LEDGER_ABI}=await load('network/lease-gas-owner.mjs');
const {createLeaseClient,policy}=await load('client/lease-executor-client.mjs');
const {verifiedLeaseAuthority}=await load('client/lease-executor-authority.mjs');
const deployment=parseDeploymentRecord(fs.readFileSync('/home/steven/enclave-prod/lease-gas/deployment.json'),{expectedDigest:'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'});
const clients=['https://mainnet.base.org','https://base-rpc.publicnode.com','https://base-mainnet.public.blastapi.io'].map(url=>createPublicClient({transport:http(url,{timeout:12000,retryCount:0})}));
async function authority(){const a=await verifiedLeaseAuthority({clients,deployment,quorum:2});for(const k of ['reserve','executor','ledger'])if(a.pins[k].toLowerCase()!==LIMIT[k])throw Error('production authority differs');return a;}
export const deps={
 health:originalGuestHealth,
 async lease(id){const a=await authority(),r=await a.client.readContract({address:a.pins.ledger,abi:LEDGER_ABI,functionName:'get',args:[id]});return {active:r.active,owner:r.owner,runner:r.runner,runnerOperator:r.runnerOperator,leaseUntil:r.leaseUntil,blockTs:a.block.timestamp};},
 async policy(id){const a=await authority();return policy({client:a.client,reserve:a.pins.reserve,id,kind:'claim',enclaveId:LIMIT.runner,operator:LIMIT.operator});},
 async claim(id,onSigned){
  const cfg=JSON.parse(fs.readFileSync('/home/steven/Projects/enclave/metal/config.json','utf8')),account=privateKeyToAccount(cfg.registryKey);if(account.address.toLowerCase()!==LIMIT.operator)throw Error('operator mismatch');
  const c=createLeaseClient({clients,account,reserve:deployment.reserve,deployment,relays:cfg.leaseGas.relays,quorum:2,onSigned,log:()=>{}}),r=await c.claim(id,LIMIT.runner);
  return {hash:r.hash,chargedWei:String(r.verified.chargedWei),receiptVerified:true};
 }
};
