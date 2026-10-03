import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,stringToHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {PROVIDER_CHECKS,qualifyProvider,verifyQualification} from '../network/provider-qualification.mjs';
import {hostConnectivity,directTerms,validateDirectPolicy} from '../network/connectivity-policy.mjs';
import {directDestination} from '../network/direct-egress.mjs';
const hostId='0x'+'ab'.repeat(32),id='0x'+'cd'.repeat(32),operator=privateKeyToAccount('0x'+'01'.repeat(32)),
  checker=privateKeyToAccount('0x'+'02'.repeat(32)),owner=privateKeyToAccount('0x'+'03'.repeat(32));
const now=100000,address='8.1.2.3';
const policy={version:3,deploymentId:id,mode:'direct',routes:1,directFallback:false,maxPricePerGiB6:'1000',budget6:'10000',nonce:'1',connectivity:'0x'+'ab'.repeat(20),expiresAt:now+30000};
const context={hostId,operator:operator.address,address,probeSigners:[checker.address],now};
const qualify=extra=>qualifyProvider({hostId,operator:operator.address,address,probe:Object.fromEntries(PROVIDER_CHECKS.map(n=>[n,async()=>true])),signer:checker,now:()=>now,...extra});
test('direct and TUNA capabilities use exactly the same qualified host evidence',async()=>{
  const qualification=await qualify();
  for(const [direct,tunaProvider] of [[true,false],[true,true],[false,true],[false,false]]){
    const result=await hostConnectivity({config:{version:1,direct,tunaProvider,pricePerGiB6:'1000'},qualification,...context});
    assert.equal(result.direct,direct);assert.equal(result.tunaProvider,tunaProvider);
  }
  for(const check of PROVIDER_CHECKS){
    const bad=structuredClone(qualification);bad.report.checks[check]=false;
    const result=await hostConnectivity({config:{version:1,direct:true,tunaProvider:true,pricePerGiB6:'1000'},qualification:bad,...context});
    assert.equal(result.direct,false,check);assert.equal(result.tunaProvider,false,check);assert.equal(result.compute,true);
  }
});
test('qualification cannot be self-issued, replayed for another host, or extended',async()=>{
  const qualification=await qualify();
  await assert.rejects(verifyQualification(qualification,{...context,now:now+60000}),/stale/);
  await assert.rejects(verifyQualification(qualification,{...context,address:'8.1.2.4'}),/another host/);
  await assert.rejects(qualify({signer:operator}),/itself/);
  qualification.report.expiresAt++;
  await assert.rejects(verifyQualification(qualification,context),/signature/);
});
test('free ownership waiver does not waive qualification and paid price limits remain enforced',()=>{
  const host={direct:true,address,qualifiedUntil:now+60000,pricePerGiB6:'1000'};
  const lease={id,owner:owner.address,runnerOperator:operator.address,active:true,validUntil:now+30000,
    connectivity:{address:policy.connectivity,nonce:'1',expires:policy.expiresAt/1000,owner:owner.address,direct:true,
      maxPricePerGiB6:policy.maxPricePerGiB6,budget6:policy.budget6,pricePerGiB6:'1000',qualifiedUntil:(now+60000)/1000,
      operator:operator.address,addressHash:keccak256(stringToHex(address)),providerBps:8000,spent6:'0'}};
  const args={policy,host,lease,now,payoutWallet:owner.address};
  assert.equal(directTerms(args).pricePerGiB6,'0');
  assert.equal(directTerms({...args,payoutWallet:operator.address}).pricePerGiB6,'1000');
  assert.throws(()=>directTerms({...args,host:{...host,direct:false}}),/qualified/);
  assert.throws(()=>directTerms({...args,payoutWallet:operator.address,policy:{...policy,maxPricePerGiB6:'999'}}),/authorization/);
  for(const change of [{nonce:'2'},{expires:0},{direct:false},{owner:operator.address},{addressHash:'0x'+'00'.repeat(32)}])
    assert.throws(()=>directTerms({...args,lease:{...lease,connectivity:{...lease.connectivity,...change}}}),/authorization/);
  assert.equal(directTerms(args).providerBps,8000);
  assert.throws(()=>validateDirectPolicy({...policy,directFallback:true}),/policy/);
});
test('direct egress rejects private, own, SMTP, mapped and rebinding destinations',async()=>{
  for(const h of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','64:ff9b::7f00:1'])
    await assert.rejects(directDestination(h,443),/refused/);
  await assert.rejects(directDestination(address,443,{ownAddresses:[address]}),/refused/);
  await assert.rejects(directDestination(address,25),/refused/);
  await assert.rejects(directDestination('rebind.example',443,{resolve:async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}]}),/refused/);
  let calls=0;assert.equal((await directDestination('public.example',443,{resolve:async()=>{calls++;return [{address:'8.8.8.8',family:4}];}})).address,'8.8.8.8');assert.equal(calls,1);
});
