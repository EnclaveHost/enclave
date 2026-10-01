import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPlacement, placementMessage } from '../relay/placement.mjs';
import { placementMessage as browserMessage } from '../site/js/core/placement-options.js';
import { claimCheapest } from '../relay/cheapest-claim.mjs';
const ID='0x'+'11'.repeat(32), HOST='0x'+'22'.repeat(32), OTHER='0x'+'33'.repeat(32), ZERO='0x'+'00'.repeat(32);
const LEDGER='0x'+'44'.repeat(20);
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'placement-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const owner=privateKeyToAccount(generatePrivateKey());
 let clock=1800000000000, sequence=0;
 const row={id:ID,owner:owner.address,active:true,runner:ZERO,leaseUntil:0};
 const fleet=[{id:HOST,name:'nucbox',availability:{apps:{isolation:'hyperv-partition-per-app'}}}];
 const deps={file:join(dir,'placement.json'),ledgerAddress:()=>LEDGER,read:async()=>row,fleet:()=>fleet,now:()=>clock};
 const service=createPlacement(deps);
 const signed=async(hostId=HOST,signer=owner)=>{
  const expiry=clock/1000+300,nonce=(++sequence).toString(16).padStart(32,'0');
  const message=placementMessage(LEDGER,ID,hostId,expiry,nonce);
  assert.equal(browserMessage(LEDGER,ID,hostId,expiry,nonce),message);
  return {hostId,expiry,nonce,signature:await signer.signMessage({message})};
 };
 return {owner,row,fleet,deps,service,signed,advance:()=>{clock+=31000}};
}
test('owner-signed preference and explicit Auto survive relay restart and fallback placement',async t=>{
 const f=fixture(t);
 assert.deepEqual(await f.service.get(ID),{configured:false});
 await f.service.put(ID,await f.signed(),{headers:{}});
 f.row.runner=OTHER;f.row.leaseUntil=1800000100;
 const restored=createPlacement(f.deps);
 assert.equal((await restored.get(ID)).hostId,HOST);
 await restored.put(ID,await f.signed(''),{headers:{}});
 assert.deepEqual(await createPlacement(f.deps).get(ID),{configured:true,hostId:'',name:'',allowFallback:true,isolation:'',updatedAt:1800000000000});
});
test('wrong owner, changed host, expired signature and signature replay cannot change preference',async t=>{
 const f=fixture(t),other=privateKeyToAccount(generatePrivateKey());
 await assert.rejects(f.service.put(ID,await f.signed(HOST,other),{headers:{}}),/Only the deployment owner/);
 const body=await f.signed();
 await assert.rejects(f.service.put(ID,{...body,hostId:''},{headers:{}}),/Only the deployment owner|signature is invalid/);
 await assert.rejects(f.service.put(ID,{...body,expiry:1},{headers:{}}),/fresh placement/);
 await f.service.put(ID,body,{headers:{}});
 await assert.rejects(f.service.put(ID,body,{headers:{}}),/already used/);
 f.row.owner=other.address;
 assert.deepEqual(await f.service.get(ID),{configured:false});
});
test('a vault session must resolve to this deployment owner',async t=>{
 const f=fixture(t);
 const denied=createPlacement({...f.deps,accountOwner:async()=> '0x'+'55'.repeat(20)});
 await assert.rejects(denied.put(ID,{hostId:HOST},{headers:{}}),/fresh placement/);
 const allowed=createPlacement({...f.deps,accountOwner:async()=>f.owner.address.toLowerCase()});
 await allowed.put(ID,{hostId:HOST},{headers:{}});
 assert.equal((await allowed.get(ID)).hostId,HOST);
});
test('queued placement retries preferences but never interrupts live leases, stopped apps or new owners',async t=>{
 const f=fixture(t);await f.service.put(ID,await f.signed(),{headers:{}});
 const calls=[];const claim=async(id,host)=>calls.push([id,host]);
 await f.service.sweep([f.row],claim);
 await f.service.sweep([f.row],claim);
 assert.deepEqual(calls,[[ID,HOST]]);
 f.advance();f.row.runner=OTHER;f.row.leaseUntil=1800001000;
 await f.service.sweep([f.row],claim);assert.equal(calls.length,1);
 f.row.runner=ZERO;f.row.active=false;
 await f.service.sweep([f.row],claim);assert.equal(calls.length,1);
 f.row.active=true;f.row.owner='0x'+'66'.repeat(20);
 await f.service.sweep([f.row],claim);assert.equal(calls.length,1);
});
test('preferred host is tried before cheaper hosts, with fallback on decline or unavailability',async()=>{
 const preferred={id:HOST,name:'nucbox',rate:30,claimable:true};
 const cheap={id:OTHER,name:'metal0',rate:1,claimable:true,selfHosted:true};
 for(const reason of ['accept','decline','offline','above-cap']) {
  const calls=[];
  const result=await claimCheapest({preferred:HOST,pool:reason==='offline'?[cheap]:[cheap,{...preferred,claimable:reason!=='above-cap'}],quote:async h=>h,
   hint:async h=>{calls.push(h.name);return {accepted:h.id!==HOST||reason==='accept'};}});
  assert.equal(result.accepted,true);
  assert.deepEqual(calls,reason==='accept'?['nucbox']:reason==='decline'?['nucbox','metal0']:['metal0']);
 }
});

test('fallback policy is signed, persistent and backed by the ledger for a strict pin',async t=>{
 const f=fixture(t);
 const sign=async allowFallback=>{
  const body=await f.signed(); body.allowFallback=allowFallback;
  body.signature=await f.owner.signMessage({message:placementMessage(LEDGER,ID,body.hostId,body.expiry,body.nonce,allowFallback)});
  return body;
 };
 const strict=await sign(false);
 await assert.rejects(f.service.put(ID,{...strict,allowFallback:true},{headers:{}}),/owner|signature/);
 await assert.rejects(f.service.put(ID,strict,{headers:{}}),/ledger/);
 f.row.configCid=JSON.stringify({placement:{hostId:HOST}});
 await f.service.put(ID,strict,{headers:{}});
 const saved=await createPlacement(f.deps).get(ID);
 assert.equal(saved.hostId,HOST);assert.equal(saved.allowFallback,false);
 await assert.rejects(f.service.put(ID,await sign(true),{headers:{}}),/ledger/);
 f.row.configCid='';await f.service.put(ID,await sign(true),{headers:{}});
 assert.equal((await createPlacement(f.deps).get(ID)).allowFallback,true);
});
test('strict pins never quote or hint another host, including offline, over-cap and declined pins',async()=>{
 for (const state of ['offline','over-cap','declined']) {
  const calls=[];
  const result=await claimCheapest({preferred:HOST,allowFallback:false,
   pool:state==='offline'?[{id:OTHER}]:[{id:OTHER},{id:HOST}],
   quote:async h=>{assert.equal(h.id,HOST);return {rate:1,claimable:state!=='over-cap'}},
   hint:async h=>{calls.push(h.id);return {accepted:false}}});
  assert.equal(result.accepted,false);assert.deepEqual(calls,state==='declined'?[HOST]:[]);
 }
});
