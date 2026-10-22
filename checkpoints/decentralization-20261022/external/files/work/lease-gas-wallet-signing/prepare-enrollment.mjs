// Read-only production simulation of a minimal bootstrap proposal. Never signs or broadcasts.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {encodeFunctionData,parseAbi,keccak256,toHex} from '../enclave/node_modules/viem/_esm/index.js';
import {verifiedArtifacts} from './artifacts.mjs';
import {PRODUCTION} from './trust.mjs';
import {clientsFor} from './rpc-clients.mjs';
const root='/home/steven/Documents/Codex/2026-10-18/wo';
const read=p=>JSON.parse(fs.readFileSync(root+'/'+p));
const journal=read('work/lease-gas-wallet/reserve-handoff-state.json');assert.equal(journal.status,'confirmed');
const reserve=journal.verification.address,from=PRODUCTION.admin;
const art=verifiedArtifacts({trust:PRODUCTION});
const rows=[...read('work/app-lease-gas/plans/ten-app-cli-plan.json').cli.apps,...read('work/app-lease-gas/plans/dns-deployment-cli-plan.json').plan.apps];
assert.equal(rows.length,11);assert.equal(new Set(rows.map(x=>x.id)).size,11);
const perAppWei=100000000000000n;
const vaultAbi=parseAbi(['function ownerCall(address to,bytes data) payable returns(bytes)']);
const operations=[];
for(const row of rows){
 const policy={...row.policy};
 assert.equal(policy.claimPolicy,row.owner.toLowerCase()===from.toLowerCase()?1:2);
 assert.equal(policy.maxGasPrice,'50000000');
 const encode=(functionName,args)=>encodeFunctionData({abi:art.EnclaveLeaseGasReserve.abi,functionName,args});
 operations.push({app:row.id,action:'deposit',from,to:reserve,value:toHex(perAppWei),data:encode('deposit',[row.id]),gas:'0x493e0'});
 const addOwner=(action,data)=>operations.push({app:row.id,action,from,to:row.owner.toLowerCase()===from.toLowerCase()?reserve:row.owner,value:'0x0',data:row.owner.toLowerCase()===from.toLowerCase()?data:encodeFunctionData({abi:vaultAbi,functionName:'ownerCall',args:[reserve,data]}),gas:'0x61a80'});
 if(policy.claimPolicy===2){assert.equal(row.owner.toLowerCase(),'0xb794c4dd0e1c5e6b72281799f282bfdE7654345D'.toLowerCase());addOwner('allow existing DNS operator',encode('setClaimant',[row.id,'0x1A01194c34Fe3577C6d0a54feB78af6253e494e0',true]));}
 addOwner('configure lease sponsorship',encode('configure',[row.id,policy]));
}
const clients=clientsFor(PRODUCTION.rpcs);
const heads=await Promise.all(clients.map(c=>c.getBlockNumber()));const block=heads.reduce((a,b)=>a<b?a:b)-2n;
const results=await Promise.all(clients.map(async c=>{
 assert.equal(await c.getChainId(),8453);
 const anchor=await c.getBlock({blockNumber:block});
 assert.equal(keccak256(await c.getCode({address:reserve,blockNumber:block})),journal.request.expectedRuntimeHash);
 const balance=await c.getBalance({address:from,blockNumber:block});assert.ok(balance>11n*perAppWei+100000000000000n,'Insufficient administrator balance including setup margin');
 const calls=operations.map(({app,action,...tx})=>tx);
 const result=await c.request({method:'eth_simulateV1',params:[{blockStateCalls:[{calls}],validation:false,traceTransfers:false},toHex(block)]});
 assert.equal(result[0].calls.length,operations.length);
 result[0].calls.forEach((x,i)=>assert.equal(x.status,'0x1',`${operations[i].action} ${operations[i].app}: ${JSON.stringify(x.error)}`));
 assert.equal((await c.getBlock({blockNumber:block})).hash,anchor.hash);
 return {blockHash:anchor.hash,balanceWei:String(balance),gas:result[0].calls.map(x=>String(BigInt(x.gasUsed)))};
}));
assert.deepEqual(results[0],results[1]);
const out={status:'PROPOSAL ONLY; owner approval and fresh per-transaction checks required',reserve,chainId:8453,from,createdAt:new Date().toISOString(),block:String(block),blockHash:results[0].blockHash,providers:PRODUCTION.rpcs,perAppWei:String(perAppWei),totalWei:String(perAppWei*11n),totalEth:'0.0011',apps:rows.map(x=>({id:x.id,owner:x.owner,policy:x.policy})),operations,simulatedGasUsed:results[0].gas,note:'11 app deposits of 0.0001 ETH; separate from existing compute balances. Variable fees determine runway. Existing self-hosting policy retained, DNS restricted to its existing operator. No wallet delegation or platform ownership changes.'};
fs.writeFileSync(root+'/outputs/app-lease-gas-review/enrollment-bootstrap-proposal.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({operations:operations.length,totalEth:out.totalEth,block:out.block,status:out.status}));
