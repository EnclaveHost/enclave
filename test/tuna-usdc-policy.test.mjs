import test from 'node:test';import assert from 'node:assert/strict';
import {keccak256,stringToHex} from 'viem';
import {tunaPolicyFromLease,tunaInventoryForLease,validateTunaPolicy} from '../network/tuna-policy.mjs';
import {selectCircuitProviders,providerAllowedForPolicy} from '../network/circuit-policy.mjs';
const now=100000,owner='0x'+'ab'.repeat(20);
function fixture(){
 const nodes=Array.from({length:4},(_,i)=>({identity:String(i+1).repeat(64),registryId:'0x'+String(i+1).repeat(64),address:`8.8.${i+1}.1`,beneficiary:'NKN-'+i,price:'0',currency:'USDC',pricePerGiB6:'1000',asn:i+1,expiresAt:200000,services:['reverse','socksproxy']}));
 const lease={id:'0x'+'aa'.repeat(32),owner,active:true,leaseUntil:200000,validUntil:190000,bandwidthBackingRequired6:'0',connectivity:{address:'0x'+'bb'.repeat(20),owner,viaTuna:true,nonce:1,expires:200,maxPricePerGiB6:4000,budget6:100000,providers:nodes.map((n,i)=>({id:n.registryId,operator:'0x'+String(i+1).repeat(40),qualified:true,active:true,qualifiedUntil:200,pricePerGiB6:'1000',addressHash:keccak256(stringToHex(n.address))}))}};
 return {nodes,lease,policy:tunaPolicyFromLease(lease)};
}
test('USDC policy selects two independent circuits from only the exact qualified owner-authorized registry identities',()=>{
 const {nodes,lease,policy}=fixture(),available=tunaInventoryForLease(nodes,lease,policy,now);
 const selected=selectCircuitProviders(policy,available,{now});assert.equal(selected.ready,true);assert.equal(selected.circuits.length,2);
 for(const circuit of selected.circuits)for(const p of Object.values(circuit)){assert.ok(policy.providerIds.includes(p.registryId));assert.equal(p.beneficiary,lease.connectivity.providers.find(x=>x.id===p.registryId).operator);}
 assert.equal(selectCircuitProviders(policy,nodes,{now}).ready,false,'unverified advertisements cannot be used');
 assert.equal(providerAllowedForPolicy({...available[0],currency:'NKN'},policy,'guard',now),false);
 assert.equal(validateTunaPolicy(policy).routes,2);
});
test('changed IP, price, qualification, backing or owner policy withdraws USDC inventory',()=>{
 for(const alter of [x=>x.nodes[0].address='9.9.9.9',x=>x.nodes[0].pricePerGiB6='999',x=>x.lease.connectivity.providers[0].qualified=false,x=>x.lease.connectivity.providers[0].active=false,x=>x.lease.connectivity.providers[0].qualifiedUntil=99]){
  const x=fixture();alter(x);assert.equal(tunaInventoryForLease(x.nodes,x.lease,x.policy,now).length,3);
 }
 for(const alter of [x=>x.lease.connectivity.nonce++,x=>x.lease.bandwidthBackingRequired6='1',x=>x.lease.validUntil=now,x=>x.lease.connectivity.providers[0].pricePerGiB6='2000']){
  const x=fixture();alter(x);assert.deepEqual(tunaInventoryForLease(x.nodes,x.lease,x.policy,now),[]);
 }
});
test('separate addresses on separate networks are insufficient when the USDC beneficiaries are identical',()=>{
 const x=fixture();for(const p of x.lease.connectivity.providers)p.operator=owner;
 assert.equal(selectCircuitProviders(x.policy,tunaInventoryForLease(x.nodes,x.lease,x.policy,now),{now}).ready,false);
});
