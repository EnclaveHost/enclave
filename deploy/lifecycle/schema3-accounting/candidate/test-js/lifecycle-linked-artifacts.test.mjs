import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {linkTemplate,resolveRuntime,verifyLinkedLifecycleCode,readLinkedLifecyclePreflight} from '../network/lifecycle-linked-artifacts.mjs';
const A=n=>'0x'+n.toString(16).padStart(40,'0'),H=n=>'0x'+n.toString(16).padStart(64,'0');
const placeholder='__$'+'a'.repeat(34)+'$__';
const refs={'ledger.sol':{Accounting:[{start:1,length:20}]}};
const libraryKey='ledger.sol:Accounting';
function artifact(code,extra={}){return {kind:'contract',creationTemplate:code,runtimeTemplate:code,creationLinks:{},runtimeLinks:{},immutableReferences:{},...extra};}
function world(){
 const keys=['ledger.sol:Ledger','controller.sol:Controller','identity.sol:Identity','prover.sol:Prover'];
 const bundle={schema:1,contracts:{
  [keys[0]]:artifact('0x73'+placeholder+'6000',{runtimeLinks:refs}),
  [keys[1]]:artifact('0x6001'),[keys[2]]:artifact('0x6002'),[keys[3]]:artifact('0x6003'),
  [libraryKey]:artifact('0x6080604052307f'+'00'.repeat(32)+'6000',{kind:'library',immutableReferences:{library_deploy_address:[{start:7,length:32}]},librarySelfAddress:{format:'solc-viair-library-immutable32',immutableId:'library_deploy_address'}}),
 }};
 const profile={chainId:8453,lifecycleSchema:3,lifecycleProofSchema:2,registry:A(9),registryCodeHash:keccak256('0x6004'),
  roles:Object.fromEntries(['ledger','controller','identity','prover'].map((name,i)=>[name,keys[i]])),bindings:{}};
 const actual=new Map([[A(9).toLowerCase(),'0x6004']]);
 for(const [i,key] of [...keys,libraryKey].entries())profile.bindings[key]={address:A(i+1),immutables:{}};
 for(const [key,a] of Object.entries(bundle.contracts)){
  const b=profile.bindings[key],libraries=key===keys[0]?{[libraryKey]:A(5)}:{};
  const code=resolveRuntime(a,{...b,libraries});b.codeHash=keccak256(code);actual.set(b.address.toLowerCase(),code);
 }
 const calls=[];
 const client={getCode:async x=>{calls.push(x);return actual.get(x.address.toLowerCase())||'0x';},readContract:async x=>{
  calls.push(x);const f=x.functionName;
  if(f==='deploymentsSchema')return 17n;if(f==='lifecycleSchema')return 3n;if(f==='lifecycleProofSchema')return 2n;
  if(f==='lifecycleController'||f==='lifecycle')return A(2);
  if(f==='selfHostingIdentity')return A(3);if(f==='prover')return A(4);
  if(f==='ledger'||f==='deployments')return A(1);if(f==='registry')return A(9);
  throw Error('unexpected read '+f);
 }};
 const snapshot=async fn=>({value:await fn(client,123n),blockNumber:123n,blockHash:H(123),evidence:{proofVerified:true,tier:'l1-finalized-derived'}});
 return {bundle,profile,client,blockNumber:123n,actual,calls,snapshot,keys};
}
test('known link slots resolve; missing/extra bindings and unresolved slots refuse',()=>{
 assert.equal(linkTemplate('0x73'+placeholder+'00',refs,{[libraryKey]:A(5)}),'0x73'+A(5).slice(2)+'00');
 assert.throws(()=>linkTemplate('0x73'+placeholder+'00',refs,{}),/missing or extra/);
 assert.throws(()=>linkTemplate('0x73'+placeholder+'00',refs,{[libraryKey]:A(5),extra:A(6)}),/missing or extra/);
 assert.throws(()=>linkTemplate('0x73'+placeholder+'00',{},{}),/unresolved/);
});
test('overlapping/out-of-range/wrong-width and already-linked ranges refuse',()=>{
 for(const slots of [[{start:1,length:20},{start:1,length:20}],[{start:100,length:20}],[{start:1,length:19}]])assert.throws(()=>linkTemplate('0x73'+placeholder+'00',{'ledger.sol':{Accounting:slots}},{[libraryKey]:A(5)}),/overlapping|invalid/);
 assert.throws(()=>linkTemplate('0x73'+A(5).slice(2)+'00',refs,{[libraryKey]:A(5)}),/not compiler placeholder/);
});
test('library self address is resolved independently from template',()=>{
 const w=world(),a=w.bundle.contracts[libraryKey];
 const runtime=resolveRuntime(a,{address:A(5)});
 assert.notEqual(keccak256(runtime),keccak256(a.runtimeTemplate));
 assert.equal(runtime,'0x6080604052307f'+'00'.repeat(12)+A(5).slice(2)+'6000');
 assert.throws(()=>resolveRuntime({...a,runtimeTemplate:'0x6000'},{address:A(5)}),/unsupported Solidity|invalid library self range/);
 assert.throws(()=>resolveRuntime(a,{address:A(5),immutables:{library_deploy_address:H(8)}}),/missing or extra immutable/);
});
test('all immutable slots bind exact reviewed values with overlap protection',()=>{
 const a=artifact('0x60'+'00'.repeat(32),{immutableReferences:{'1':[{start:1,length:32}]}});
 assert.equal(resolveRuntime(a,{address:A(1),immutables:{'1':H(7)}}),'0x60'+H(7).slice(2));
 assert.throws(()=>resolveRuntime(a,{address:A(1)}),/missing or extra immutable/);
 assert.throws(()=>resolveRuntime(a,{address:A(1),immutables:{'1':A(7)}}),/invalid runtime binding/);
 const b={...a,immutableReferences:{'1':[{start:1,length:32},{start:1,length:32}]}};
 assert.throws(()=>resolveRuntime(b,{address:A(1),immutables:{'1':H(7)}}),/overlapping/);
});
test('positive mock snapshot checks independent library code and exact same block',async()=>{
 const w=world(),r=await readLinkedLifecyclePreflight(w);
 assert.equal(r.executable,false);assert.equal(r.code.libraryCount,1);assert.equal(r.code.codePinsVerified,true);
 assert.ok(w.calls.some(x=>x.address.toLowerCase()===A(5)));assert.ok(w.calls.every(x=>x.blockNumber===123n));
});
test('unchanged ledger code does not hide library code replacement',async()=>{
 const w=world();w.actual.set(A(5),'0x6005');await assert.rejects(readLinkedLifecyclePreflight(w),/deployed linked code differs/);
});
test('missing library code refuses',async()=>{
 const w=world();w.actual.delete(A(5));await assert.rejects(readLinkedLifecyclePreflight(w),/deployed linked code differs/);
});
test('template hash is not accepted as actual deployed library pin',async()=>{
 const w=world();w.profile.bindings[libraryKey].codeHash=keccak256(w.bundle.contracts[libraryKey].runtimeTemplate);
 await assert.rejects(readLinkedLifecyclePreflight(w),/pin differs from resolved/);
});
test('wrong library address cannot match existing linked ledger',async()=>{
 const w=world();w.profile.bindings[libraryKey].address=A(8);
 await assert.rejects(readLinkedLifecyclePreflight(w),/pin differs from resolved/);
});
test('duplicate address and missing/extra profile dependencies refuse',async()=>{
 const w=world();w.profile.bindings[libraryKey].address=A(2);await assert.rejects(readLinkedLifecyclePreflight(w),/pin differs|duplicate/);
 const x=world();delete x.profile.bindings[libraryKey];await assert.rejects(readLinkedLifecyclePreflight(x),/missing or extra/);
 const y=world();y.profile.bindings.extra=y.profile.bindings[libraryKey];await assert.rejects(readLinkedLifecyclePreflight(y),/missing or extra/);
});
test('unknown library artifact cannot be supplied by profile alone',async()=>{
 const w=world();delete w.bundle.contracts[libraryKey];delete w.profile.bindings[libraryKey];
 await assert.rejects(readLinkedLifecyclePreflight(w),/unknown library/);
});
test('wrong controller pair refuses despite all matching code pins',async()=>{
 const w=world(),original=w.client.readContract;w.client.readContract=x=>x.functionName==='ledger'?Promise.resolve(A(8)):original(x);
 await assert.rejects(readLinkedLifecyclePreflight(w),/authority pair differs/);
});
test('registry code is independently checked',async()=>{
 const w=world();w.actual.set(A(9),'0x6005');await assert.rejects(readLinkedLifecyclePreflight(w),/registry code differs/);
});
test('RPC labels and failed reads cannot become authenticated authority',async()=>{
 const w=world(),snapshot=w.snapshot;w.snapshot=async fn=>({...await snapshot(fn),evidence:{proofVerified:false,tier:'safe'}});
 await assert.rejects(readLinkedLifecyclePreflight(w),/authenticated in-domain/);
 const z=world();z.client.getCode=async()=>{throw Error('reader unavailable');};await assert.rejects(readLinkedLifecyclePreflight(z),/reader unavailable/);
});
test('schema2 profile is not silently treated as schema3',async()=>{
 const w=world();w.profile.lifecycleSchema=2;await assert.rejects(verifyLinkedLifecycleCode(w),/unsupported linked profile/);assert.equal(w.calls.length,0);
});
