// Actual candidate schema2 ledger/controller/identity and generated r6 adapter on owned Anvil.
// Registry/catalog/closure contracts and authority labels are existing TEST doubles.
// No live Base authority, schema3 qualification, wallet or production transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,toBytes} from 'viem';
import {useAnvil,world,tx,S,HOST,LEDGER} from './fixtures/r5-world.mjs';
import {hostAdmissionPolicyHash} from '../network/host-admission-policy.mjs';
useAnvil();
function independent(w){
 const p=structuredClone(w.pins);p.profile='independent-r1';
 p.discovery={addressBook:p.contracts.addressBook.address};
 delete p.addressBook;delete p.bookKeys;delete p.contracts.addressBook;
 delete p.admins.addressBookOwner;delete p.admins.addressBookPendingOwner;
 return p;
}
async function policy(w,over){
 const doc={version:1,chainId:8453,ownershipContract:w.contracts.hostOwnership.toLowerCase(),hostId:HOST,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[],...over};
 const hash=hostAdmissionPolicyHash(doc);w.policyDocs.set(hash,doc);
 await tx(w.admin,w.contracts.hostOwnership,S.K.TestHostOwnership.abi,'set',[HOST,w.operator.address,2n,hash]);
}
test('actual independent adapter removes publisher/catalog veto but retains immutable content admission',async()=>{
 const w=await world({payout:'owner',isPublic:true,approval:2});
 assert.equal((await w.adapter().read(w.id)).enabled,false,'legacy default still applies the old policy');
 const a=w.adapter({pins:independent(w)});let s=await a.read(w.id);
 assert.equal(s.enabled,true);assert.equal(s.admitted,true);assert.equal(s.independence.complete,false);
 await tx(w.admin,w.contracts.catalog,S.K.TestCatalog.abi,'set',[w.app({active:false}),w.ver({yanked:true,approval:2})]);
 s=await a.read(w.id);assert.equal(s.enabled,true);assert.equal(s.admitted,true);
 assert.deepEqual([s.listing.delisted,s.listing.yanked],[true,true]);
 await tx(w.admin,w.contracts.catalog,S.K.TestCatalog.abi,'set',[w.app({}),w.ver({cid:''})]);
 s=await a.read(w.id);assert.equal(s.enabled,true);assert.equal(s.admitted,false);assert.match(s.host.ownerDenial,/content commitment/);
});
test('actual independent adapter retains owner-elected moderation and same-block resource/owner fields',async()=>{
 const w=await world({payout:'owner',isPublic:true,approval:0});const a=w.adapter({pins:independent(w)});
 let s=await a.read(w.id);assert.equal(s.admitted,true);assert.equal(s.resources.cpuShare,Number((await w.ledgerGet()).cpuMilli)/1000);
 assert.equal(s.content.cid,w.ver({}).cid);assert.equal(s.hostAuthority.owner,w.operator.address.toLowerCase());
 await policy(w,{requireCatalogApproval:true});s=await a.read(w.id);
 assert.equal(s.enabled,true);assert.equal(s.admitted,false);assert.match(s.host.ownerDenial,/approval|moderation/);
});
test('actual independent adapter ignores changed discovery book but rejects wrong recursive code',async()=>{
 const w=await world({payout:'owner'});const p=independent(w),a=w.adapter({pins:p});
 await tx(w.admin,w.contracts.addressBook,S.K.TestAddressBook.abi,'put',[keccak256(toBytes('extra-discovery-entry')),w.other.address]);
 await assert.rejects(w.adapter().read(w.id),/address book/);
 assert.equal((await a.read(w.id)).admitted,true);
 const wrong=structuredClone(p);wrong.contracts.connectivity.codeHash='0x'+'12'.repeat(32);
 await assert.rejects(w.adapter({pins:wrong}).read(w.id),/code|hash|pin/i);
});
test('actual schema2 retirement remains a disclosed contract blocker, never synthesized away',async()=>{
 const w=await world({payout:'owner'});const a=w.adapter({pins:independent(w)});
 assert.equal((await a.read(w.id)).admitted,true);
 await tx(w.admin,w.contracts.ledger,LEDGER.abi,'retire');const s=await a.read(w.id);
 assert.equal(s.ledgerState.retired,true);assert.equal(s.admitted,false);
 assert.ok(s.independence.blockers.some(x=>x.includes('retire()')));
});
test('independent profile rejects mixed discovery authority and unknown profile',async()=>{
 const w=await world({payout:'owner'});const p=independent(w);
 assert.throws(()=>w.adapter({pins:{...p,addressBook:w.pins.addressBook}}),/not authority/);
 assert.throws(()=>w.adapter({pins:{...p,profile:'unreviewed'}}),/not a reviewed profile/);
});
