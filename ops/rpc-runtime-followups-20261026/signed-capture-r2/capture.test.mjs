import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, collectWitness, ownEndpoint, signedInput, witnessAccumulator, checkRawHeader } from './capture.mjs';
const { commitmentDigest } = await import('./vendor/op-head-relay.mjs');
import { POLICY, checkCapturePolicy, canonicalConfigSha256, bindNativeResult } from './policy.mjs';
import { verifyVendor, requireOffline, VENDOR_PIN } from './runtime.mjs';
const require=createRequire(new URL('./vendor/package.json',import.meta.url));
const {keccak256,toRlp}=require('viem');
const {privateKeyToAccount}=require('viem/accounts');
const hx=b=>`0x${Buffer.from(b).toString('hex')}`;
const ZERO=`0x${'00'.repeat(32)}`;
const EMPTY={preimageStore:{preimage_map:[]},blobData:{blobs:[],commitments:[],proofs:[]}};
async function fixture(txType){
  // Public deterministic TEST key; this is synthetic transport data, not chain evidence.
  const signer=privateKeyToAccount(`0x${'0'.repeat(63)}1`);
  const header=toRlp([ZERO, ZERO,`0x${'00'.repeat(20)}`,ZERO,ZERO,ZERO,`0x${'00'.repeat(256)}`,'0x','0x','0x01','0x','0x01','0x',ZERO,'0x0000000000000000','0x01']);
  const parent=keccak256(header),p=Buffer.alloc(txType===undefined?569:574);
  Buffer.from(parent.slice(2),'hex').copy(p);p.writeBigUInt64LE(1n,404);p.writeBigUInt64LE(1000000n,412);p.writeBigUInt64LE(2n,428);
  p.writeUInt32LE(560,436);p.writeUInt32LE(569,504);p.writeUInt32LE(p.length,508);p[564]=8;p[568]=8;
  if(txType!==undefined){p.writeUInt32LE(4,569);p[573]=txType;}
  const data=hx(Buffer.concat([Buffer.alloc(32),p]));
  const signature=await signer.sign({hash:commitmentDigest(data,8453)});
  const commitment={data,signature:{r:signature.slice(0,66),s:`0x${signature.slice(66,130)}`,v:`0x${signature.slice(130)}`}};
  const parsed=await signedInput(commitment,signer.address.toLowerCase());
  const context={format:'enclave-signed-payload-candidate/v1',parentHash:parent,parentNumber:0,unsafeSigner:signer.address.toLowerCase(),
    base:{chainId:8453,l1Head:ZERO,l1HeadNumber:0,agreedL2OutputRoot:ZERO,claimedL2OutputRoot:parsed.outputRoot,
      claimedL2BlockNumber:1,intermediateBlockInterval:1,rollupConfig:{},expectedRollupConfigHash:ZERO,expectedScheduleId:ZERO}};
  return {header,commitment,parsed,context,plan:{format:'enclave-signed-capture-plan/v1',endpoint:'http://127.0.0.1:12345/',context}};
}
test('only explicit owned private endpoint scopes; no credentials or public fallback',()=>{
  assert.match(ownEndpoint('http://127.0.0.1:9/'),/127/);
  for(const url of ['https://example.com/','http://8.8.8.8/','http://user:pass@127.0.0.1/','http://127.0.0.1/a','http://127.0.0.1/?token=x'])assert.throws(()=>ownEndpoint(url));
});
test('signed advisory parser binds signer and exposes original transactions/metadata',async()=>{
  const f=await fixture();assert.equal(f.parsed.attrs.timestamp,'0x2');assert.equal(f.parsed.attrs.eip1559Params,'0x0000000800000008');
  assert.equal(f.parsed.head.parentHash,f.context.parentHash);
  await assert.rejects(signedInput(f.commitment,`0x${'11'.repeat(20)}`),/signer/);
  const changed=structuredClone(f.commitment);changed.data=`${changed.data.slice(0,-2)}09`;
  await assert.rejects(signedInput(changed,f.context.unsafeSigner),/signer/);
});
test('preimages must reproduce hashes; local inputs stripped; conflicts never overwrite',()=>{
  const value=Buffer.from('real preimage bytes'),digest=Buffer.from(keccak256(value).slice(2),'hex');
  const key={data:[...digest.subarray(1)],key_type:'Keccak256'};
  const seed={preimageStore:{preimage_map:[[key,[...value]],[{data:Array(31).fill(0),key_type:'Local'},[1]]]},blobData:EMPTY.blobData};
  const a=witnessAccumulator(seed);a.add(hx(value));assert.equal(a.finish().entries,1);assert.equal(a.finish().strippedLocals,1);
  assert.throws(()=>witnessAccumulator({...seed,preimageStore:{preimage_map:[[key,[1]]]}}),/hash mismatch/);
  assert.throws(()=>witnessAccumulator({...seed,preimageStore:{preimage_map:[[{...key,key_type:'GlobalGeneric'},[1]]]}}),/non-hash/);
});
test('raw headers bind hash and exact ancestor height',async()=>{
  const f=await fixture();assert.equal(checkRawHeader(f.header,f.context.parentHash,0n),ZERO);
  assert.throws(()=>checkRawHeader(f.header,ZERO,0n),/hash mismatch/);
  assert.throws(()=>checkRawHeader(f.header,f.context.parentHash,1n),/height mismatch/);
});
test('capture success stays untrusted; exact method/parent binding and absent witness refuse',async()=>{
  const f=await fixture(),seen=[];
  const transport=async(url,opts)=>{assert.equal(opts.redirect,'error');const q=JSON.parse(opts.body);seen.push(q);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='debug_executePayload'?{state:[],codes:[],keys:[]}:f.header}));};
  const args={context:f.context,signed:f.parsed,endpoint:f.plan.endpoint,bootstrapWitness:EMPTY};
  const c=await collectWitness({...args,fetchImpl:transport,signal:AbortSignal.timeout(5000)});
  assert.equal(c.receipt.authority,false);assert.equal(c.receipt.nativeEvaluated,false);
  assert.deepEqual(seen.map(q=>q.method),['debug_executePayload','debug_getRawHeader']);assert.equal(seen[0].params[0],f.context.parentHash);
  assert.equal(JSON.parse(c.witness).preimageStore.preimage_map.length,1);
  assert.equal(c.receipt.provenance.vendorManifestSha256,VENDOR_PIN);
  assert.equal(c.receipt.provenance.endpointOrigin,f.plan.endpoint);
  assert.equal(c.receipt.canonicalRollupConfigSha256,canonicalConfigSha256(f.context.base.rollupConfig));
  await assert.rejects(collectWitness({...args,fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{state:[],codes:[]}})),signal:AbortSignal.timeout(1000)}),/lacks keys/);
});
test('native Snappy/signature interoperability; fabricated header is correctly refused',async()=>{
  const binary=process.env.CANDIDATE_BINARY;
  assert.ok(binary,'root job must supply the pinned compiled native binary; no skip');
  assert.equal(createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),'581d56a6c052f80c49cc8557e6d0c16fe148be8c67939c00c3ece011a2dbadb8');
  const f=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'signed-capture-'));
  try{
    const ctx={...f.context,envelopeKeccak:keccak256(f.parsed.envelope)};
    fs.writeFileSync(path.join(dir,'c'),JSON.stringify(ctx));fs.writeFileSync(path.join(dir,'w'),JSON.stringify(EMPTY));fs.writeFileSync(path.join(dir,'e'),f.parsed.envelope);
    const r=spawnSync('/usr/bin/prlimit',['--as=1073741824','--cpu=5',binary,'--offline-candidate',path.join(dir,'c'),path.join(dir,'w'),path.join(dir,'e')],{env:{PATH:'/usr/bin:/bin',LANG:'C'},encoding:'utf8',timeout:10000,maxBuffer:65536});
    assert.equal(r.error,undefined);assert.equal(r.status,1);const j=JSON.parse(r.stdout);
    assert.equal(j.authority,false);assert.match(j.refused,/signed payload blockHash mismatch/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('production capture enforces reviewed signer/config/schedule before network',async()=>{
  const f=await fixture();let calls=0;
  const opts={commitment:f.commitment,bootstrapWitness:EMPTY,fetchImpl:()=>{calls++;throw Error('must not fetch');},signal:AbortSignal.timeout(1000)};
  await assert.rejects(capture({...opts,plan:f.plan}),/unreviewed unsafe signer/);
  const plan=structuredClone(f.plan);plan.context.unsafeSigner=POLICY.unsafeSigner;
  await assert.rejects(capture({...opts,plan}),/unreviewed rollup config/);
  plan.context.base.expectedRollupConfigHash=POLICY.rollupConfigHash;
  await assert.rejects(capture({...opts,plan}),/unreviewed schedule/);
  plan.context.base.expectedScheduleId=POLICY.scheduleId;
  // Even all matching policy labels cannot make a test-key signature acceptable.
  await assert.rejects(capture({...opts,plan}),/not signed by the pinned/);
  assert.equal(calls,0);
});
test('native result must echo reviewed config/schedule and bind canonical supplied config',()=>{
  const context={unsafeSigner:POLICY.unsafeSigner,base:{expectedRollupConfigHash:POLICY.rollupConfigHash,expectedScheduleId:POLICY.scheduleId,rollupConfig:{b:2,a:1}}};
  const cap={rollupConfigHash:POLICY.rollupConfigHash,scheduleId:POLICY.scheduleId,canonicalRollupConfigSha256:canonicalConfigSha256({a:1,b:2}),candidateHash:ZERO,parentHash:ZERO,outputRoot:ZERO,number:1};
  const result={format:'enclave-signed-payload-candidate/v1',authority:false,hash:ZERO,parentHash:ZERO,outputRoot:ZERO,coverage:{toBlock:1,blocks:[{}]},rollupConfigHash:POLICY.rollupConfigHash,scheduleId:POLICY.scheduleId};
  bindNativeResult(result,cap,context);
  for(const key of ['rollupConfigHash','scheduleId'])assert.throws(()=>bindNativeResult({...result,[key]:ZERO},cap,context),/bind/);
  assert.throws(()=>bindNativeResult(result,cap,{...context,base:{...context.base,rollupConfig:{a:3,b:2}}}),/binding/);
  assert.throws(()=>bindNativeResult({...result,authority:true},cap,context),/bind/);
});
test('runtime rejects changed, added, missing or linked dependency files before imports',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capture-vendor-'));
  try{
    fs.mkdirSync(path.join(dir,'vendor'));const name=path.join(dir,'vendor','dependency.mjs');
    fs.writeFileSync(name,'original');
    const raw=JSON.stringify({format:'enclave-capture-vendor/v1',files:{'vendor/dependency.mjs':createHash('sha256').update('original').digest('hex')}});
    const pin=createHash('sha256').update(raw).digest('hex');fs.writeFileSync(path.join(dir,'VENDOR.json'),raw);
    await verifyVendor(dir,pin);
    fs.writeFileSync(name,'changed');await assert.rejects(verifyVendor(dir,pin),/source pin/);
    fs.writeFileSync(name,'original');fs.writeFileSync(path.join(dir,'vendor','extra'),'x');await assert.rejects(verifyVendor(dir,pin),/unmanifested/);
    fs.unlinkSync(path.join(dir,'vendor','extra'));fs.unlinkSync(name);await assert.rejects(verifyVendor(dir,pin),/file set/);
    fs.symlinkSync('/etc/hostname',name);await assert.rejects(verifyVendor(dir,pin),/symlink/);
    fs.writeFileSync(path.join(dir,'VENDOR.json'),raw+' ');await assert.rejects(verifyVendor(dir,pin),/manifest pin/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('root job executes in an isolated network namespace',async()=>{await requireOffline();});

test('unsupported signed transaction types refuse before witness RPC',async()=>{
  await assert.rejects(fixture(0x79),/unsupported transaction type/);
  await assert.rejects(fixture(0x7d),/unsupported transaction type/);
});
