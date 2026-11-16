// The signer of a signed text is remembered per (text, signature), and a batch of new recoveries lets the event loop run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {recoverSigner} from '../network/provider-directory.mjs';

test('recovers the signer, and another text or signature is another answer',async()=>{
  const a=privateKeyToAccount(generatePrivateKey()),b=privateKeyToAccount(generatePrivateKey());
  const sa=await a.signMessage({message:'one'}),sb=await b.signMessage({message:'one'});
  assert.equal(await recoverSigner('one',sa),a.address.toLowerCase());
  assert.equal(await recoverSigner('one',sa),a.address.toLowerCase());   // remembered
  assert.equal(await recoverSigner('one',sb),b.address.toLowerCase());
  assert.notEqual(await recoverSigner('two',sa),a.address.toLowerCase());   // the same signature over another text
  await assert.rejects(recoverSigner('one','0x00'));
  await assert.rejects(recoverSigner('one','0x00'));   // a failure is not remembered as a signer
});

test('a batch of new recoveries does not hold the event loop; a repeated batch costs almost nothing',async()=>{
  const a=privateKeyToAccount(generatePrivateKey()),signed=[];
  for(let i=0;i<24;i++)signed.push(['text '+i,await a.signMessage({message:'text '+i})]);
  let turns=0,stop=false;const spin=()=>{turns++;if(!stop)setImmediate(spin);};setImmediate(spin);
  const t0=process.hrtime.bigint();
  for(const [m,s] of signed)assert.equal(await recoverSigner(m,s),a.address.toLowerCase());
  const first=Number(process.hrtime.bigint()-t0),seen=turns;
  assert.ok(seen>=signed.length,`the loop ran ${seen} times during ${signed.length} recoveries`);
  const t1=process.hrtime.bigint();
  for(const [m,s] of signed)assert.equal(await recoverSigner(m,s),a.address.toLowerCase());
  const second=Number(process.hrtime.bigint()-t1);stop=true;
  assert.ok(second*5<first,`remembered: ${Math.round(second/1e3)} us against ${Math.round(first/1e3)} us`);
});
