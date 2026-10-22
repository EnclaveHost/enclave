import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {encodeFunctionData,parseAbi,decodeFunctionData} from 'viem';
import {staticPlan,assertAdminRetainedReplay} from '../plan2.mjs';
const snapshot=JSON.parse(fs.readFileSync(new URL('../snapshots/52842154.json',import.meta.url)));
const admin=snapshot.ledger.params.owner, stranger='0x'+'12'.repeat(20);
const abi=parseAbi(['function setOwner(address)','function transferOwnership(address)','function acceptOwnership()','function renounceOwnership()']);
const plan=()=>{const s=staticPlan({snap:snapshot,migrator:stranger,nonce:0});s.iTail.forEach(f=>f());s.g2.forEach(f=>f());return s;};
const report=()=>{const s=plan();return {result:'pass',governancePolicy:s.governancePolicy,addresses:s.addresses,executed:s.txs,checks:{adminRetained:{verified:true,ledgerOwner:admin,proverOwner:admin,ledgerPendingOwner:'0x'+'00'.repeat(20),proverPendingOwner:'0x'+'00'.repeat(20),operations:Object.fromEntries(['ledger.setLeaseSec','ledger.setPayout','ledger.retire (simulation only)','prover.setProofWindow'].map(k=>[k,{adminAccepted:true,outsiderRejected:true}]))}}};};
test('actual generated migration retains both administrations and contains no governance sink phase',()=>{
 const r=report();assert.doesNotThrow(()=>assertAdminRetainedReplay(r,admin));
 assert.ok(!r.executed.some(t=>t.phase==='X'||/GovernanceSeal/.test(t.label)));
 const handoffs=r.executed.flatMap(t=>{if(!t.to)return [];try{return [decodeFunctionData({abi,data:t.data})];}catch{return [];}});
 assert.equal(handoffs.filter(d=>d.functionName==='acceptOwnership').length,2);
 for(const d of handoffs.filter(d=>d.args))assert.equal(d.args[0].toLowerCase(),admin.toLowerCase());
});
test('legacy reports and incomplete or substituted ownership evidence cannot generate a new plan',()=>{
 for(const change of [r=>delete r.governancePolicy,r=>r.checks.adminRetained.ledgerOwner=stranger,r=>r.checks.adminRetained.proverPendingOwner=stranger,r=>delete r.checks.adminRetained.operations['ledger.retire (simulation only)'],r=>r.executed=r.executed.filter(t=>t.label!=='acceptOwnership')]){
  const r=report();change(r);assert.throws(()=>assertAdminRetainedReplay(r,admin));
 }
});
test('misleading labels cannot hide removal calldata or acceptance by a different owner',()=>{
 for(const fn of ['setOwner','transferOwnership','renounceOwnership']){
  const r=report();r.executed.push({phase:'G2',label:'routine upkeep',to:r.addresses.ledger17,data:encodeFunctionData({abi,functionName:fn,args:fn==='renounceOwnership'?[]:[stranger]}),signer:{address:admin}});
  assert.throws(()=>assertAdminRetainedReplay(r,admin),/forbidden|retain/);
 }
 const r=report();r.executed.find(t=>t.label==='acceptOwnership').signer.address=stranger;
 assert.throws(()=>assertAdminRetainedReplay(r,admin),/acceptance|admin wallet/);
});
