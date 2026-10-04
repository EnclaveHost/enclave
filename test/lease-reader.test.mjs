import test from 'node:test';
import assert from 'node:assert/strict';
import {LeaseReader,AdmissionGate,transientProofError} from '../network/lease-reader.mjs';
const id='0x'+'ab'.repeat(32),runner='0x'+'cd'.repeat(32),book='0x'+'01'.repeat(20),contract='0x'+'02'.repeat(20);
const now=()=>1700000000000;
const row={id,runner,owner:book,runnerOperator:book,active:true,isPublic:true,leaseUntil:1700003600n,appRef:'catalog:a:1',configCid:''};
function client({time=1699999995n,hash='0x'+'aa'.repeat(32),value=row,fail=false}={}) {return {
 getChainId:async()=>{if(fail)throw Error('offline');return 8453},getBlockNumber:async()=>1000n,
 getBlock:async()=>({hash,timestamp:time}),readContract:async({functionName})=>functionName==='addr'?contract:functionName==='deploymentsSchema'?15n:value,
};}
test('only an agreeing recent chain quorum can renew authorization',async()=>{
 const reader=new LeaseReader({addressBook:book,clients:[client(),client()],now});
 const [lease]=await reader.refresh([id]);assert.equal(lease.validUntil,1699999995000+90000);
 reader.clients=[client(),client({value:{...row,runner:'0x'+'de'.repeat(32)}})];
 await assert.rejects(reader.refresh([id]),/agreeing chain quorum/);
 assert.equal(reader.get(id).validUntil,lease.validUntil);
 reader.clients=[client({time:1699999800n}),client({time:1699999800n})];
 await assert.rejects(reader.refresh([id]),/fresh agreeing/);
 reader.clients=[client(),client({fail:true})];await assert.rejects(reader.refresh([id]),/quorum unavailable/);
 reader.now=()=>lease.validUntil;assert.equal(reader.get(id),null);
});
test('a stale outlier cannot prevent two fresh peers from agreeing',async()=>{
 const reader=new LeaseReader({addressBook:book,clients:[client({time:1699999800n}),client(),client()],now});
 assert.equal((await reader.refresh([id]))[0].runner,runner);
});
test('guest proof expires without self-extension and lease changes invalidate it',async()=>{
 let clock=now();const expected={appRef:row.appRef,configCid:'',appSha256:'ab'.repeat(32),runtimeId:'cd'.repeat(32)};
 const gate=new AdmissionGate({runner,expected:()=>expected,now:()=>clock});
 const lease={...row,leaseUntil:clock+300000,validUntil:clock+90000};gate.observeLease(lease);
 const verify=async()=>({verified:true,deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:'ef'.repeat(32)});
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 clock+=60000;gate.observeLease({...lease,validUntil:clock+90000});assert.equal(gate.allows(id),false);
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 gate.observeLease({...lease,appRef:'catalog:a:2',validUntil:clock+90000});assert.equal(gate.allows(id),false);
 await assert.rejects(gate.attest(id,verify),/expectation/);
});

test('a missing deployment is revoked without withholding another app lease',async()=>{
 const missing='0x'+'ef'.repeat(32),readers=[client(),client()];
 for(const c of readers){const original=c.readContract;c.readContract=async args=>args.functionName==='get'&&args.args[0]===missing?{...row,id:'0x'+'00'.repeat(32)}:original(args);}
 const reader=new LeaseReader({addressBook:book,clients:readers,now});reader.cache.set(missing,{...row,id:missing,validUntil:now()+60000});
 assert.deepEqual((await reader.refresh([missing,id])).map(x=>x.id),[id]);assert.equal(reader.get(missing),null);assert.ok(reader.get(id));
});
test('a stalled snapshot cannot withhold an already agreeing quorum',async()=>{
 const slow=client();let release;const gate=new Promise(r=>release=r);slow.getBlock=async()=>{await gate;throw Error('late peer failure');};
 const reader=new LeaseReader({addressBook:book,clients:[slow,client(),client()],now});
 try{const result=await Promise.race([reader.refresh([id]),new Promise((_r,j)=>setTimeout(()=>j(Error('quorum stalled')),100))]);assert.equal(result.length,1);}finally{release();}
});
test('a transport failure keeps the last guest proof only until it expires; a mismatch revokes it now',async()=>{
 let clock=now();const expected={appRef:row.appRef,configCid:'',appSha256:'ab'.repeat(32),runtimeId:'cd'.repeat(32)};
 const gate=new AdmissionGate({runner,expected:()=>expected,now:()=>clock});
 gate.observeLease({...row,leaseUntil:clock+300000,validUntil:clock+300000});
 const verify=async()=>({verified:true,deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,spkiSha256:'ef'.repeat(32)});
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 const reset=Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'),{code:'ECONNRESET'});
 for(const e of [reset,new Error('guest probe timeout'),new Error('guest attestation HTTP 503')]){assert.equal(transientProofError(e),true);assert.equal(gate.failed(id,e),true);assert.equal(gate.allows(id),true);}
 clock+=60001;assert.equal(gate.allows(id),false); // never extended by a failed refresh
 await gate.attest(id,verify);assert.equal(gate.allows(id),true);
 for(const e of [new Error('app, nonce or TLS binding mismatch'),new Error('guest attestation HTTP 403'),new Error('something unexpected'),undefined])assert.equal(transientProofError(e),false);
 assert.equal(gate.failed(id,new Error('app, nonce or TLS binding mismatch')),false);assert.equal(gate.allows(id),false);
});

test('publications arriving during a snapshot share the next one',async()=>{
 const other='0x'+'ef'.repeat(32);let heads=0;const peers=[client(),client()];
 for(const c of peers){const original=c.getBlockNumber;c.getBlockNumber=async()=>{heads++;return original();};
  const read=c.readContract;c.readContract=async args=>args.functionName==='get'?{...row,id:args.args[0]}:read(args);}
 const reader=new LeaseReader({addressBook:book,clients:peers,now});
 // Requested together: one snapshot answers both.
 const [x,y]=[reader.refresh([id]),reader.refresh([other])];
 assert.deepEqual((await x).map(r=>r.id),[id]);assert.deepEqual((await y).map(r=>r.id),[other]);assert.equal(heads,2);
 // Requested while a snapshot is in flight: all of them share the next one.
 let started;const inFlight=new Promise(r=>started=r);
 for(const c of peers){const original=c.getBlock;c.getBlock=async args=>{started();return original(args);};}
 const first=reader.refresh([id]);await inFlight;
 const [a,b,c]=[reader.refresh([other]),reader.refresh([id]),reader.refresh([other,id])];
 assert.deepEqual((await first).map(r=>r.id),[id]);
 assert.deepEqual((await a).map(r=>r.id),[other]);assert.deepEqual((await b).map(r=>r.id),[id]);assert.deepEqual((await c).map(r=>r.id),[other,id]);
 assert.equal(heads,6); // three snapshots on two peers, not five
 await assert.rejects(reader.refresh(['0xBAD']),/exact deployment ids/);
 assert.equal((await reader.refresh([id])).length,1);
});
test('a peer head lagging behind the accepted block rereads that block instead of refusing',async()=>{
 let head=1000n;const peers=[client(),client()];const asked=[];
 for(const c of peers){c.getBlockNumber=async()=>head;const original=c.getBlock;c.getBlock=async args=>{asked.push(args.blockNumber);return original(args);};}
 const reader=new LeaseReader({addressBook:book,clients:peers,now});
 await reader.refresh([id]);assert.equal(reader.lastBlock,998n);
 head=999n;assert.equal((await reader.refresh([id])).length,1);
 assert.equal(reader.lastBlock,998n);assert.ok(asked.slice(-4).every(n=>n===998n));
 // Reading the accepted block again still needs it to be recent.
 for(const c of peers)c.getBlock=async()=>({hash:'0x'+'aa'.repeat(32),timestamp:1699999800n});
 await assert.rejects(reader.refresh([id]),/agreeing chain quorum/);
});
test('only a rate-limit refusal is retried',async()=>{
 const limited=client(),broken=client();let limitedCalls=0,brokenCalls=0;
 limited.getChainId=async()=>{if(limitedCalls++<2)throw Error('RPC Request failed.\n\nDetails: You reached Public endpoint rate limit, please upgrade to paid plan');return 8453;};
 broken.getChainId=async()=>{brokenCalls++;throw Error('wrong answer');};
 const reader=new LeaseReader({addressBook:book,clients:[limited,client()],now});reader.retryDelayMs=1;
 assert.equal((await reader.refresh([id])).length,1);assert.equal(limitedCalls,3);
 const strict=new LeaseReader({addressBook:book,clients:[broken,client()],now});strict.retryDelayMs=1;
 await assert.rejects(strict.refresh([id]),/quorum unavailable/);assert.equal(brokenCalls,1);
});
test('an app whose host left the registry is withheld without failing the apps sharing its snapshot',async()=>{
 const moved='0x'+'ef'.repeat(32),gone='0x'+'99'.repeat(32);
 const peers=[client(),client()];
 for(const c of peers)c.readContract=async({functionName,args})=>functionName==='addr'?contract:functionName==='deploymentsSchema'?15n:
  args[0]===runner||args[0]===gone?{active:args[0]===runner,operator:book,payoutWallet:book,proofKey:book}:{...row,id:args[0],runner:args[0]===moved?gone:runner};
 const reader=new LeaseReader({addressBook:book,clients:peers,includeHostPayout:true,now});
 reader.cache.set(moved,{...row,id:moved,validUntil:now()+60000});
 assert.deepEqual((await reader.refresh([moved,id])).map(x=>x.id),[id]);
 assert.equal(reader.get(moved),null);assert.equal(reader.get(id).runnerPayoutWallet,book);assert.equal(reader.get(id).runnerRegistered,true);
 assert.ok(reader.failures.some(f=>f.includes('inactive or changed runner')));
});
test('a peer that never answers its head cannot hold the snapshot for its request timeout',async()=>{
 const hung=client();let release;hung.getBlockNumber=()=>new Promise(r=>release=r);
 const reader=new LeaseReader({addressBook:book,clients:[hung,client(),client()],now});reader.headGraceMs=20;
 const started=Date.now();
 try{assert.equal((await Promise.race([reader.refresh([id]),new Promise((_r,j)=>setTimeout(()=>j(Error('head phase stalled')),500))])).length,1);}
 finally{release?.(1000n);}
 assert.ok(Date.now()-started<500);
});
test('registry entries come from agreeing peers and decode only the original entry prefix',async()=>{
 const registry='0x'+'03'.repeat(20),host='0x'+'cd'.repeat(32),other='0x'+'ce'.repeat(32);
 const entry=(op,active)=>({endpoint:'https://x',repo:'',measurement:'0x'+'00'.repeat(32),operator:op,registeredAt:1n,lastSeen:1n,active});
 const peer=(op=book)=>{const c=client();c.readContract=async({address,functionName,args,abi})=>{
  assert.equal(address,registry);assert.equal(functionName,'get');assert.equal(abi[0].outputs[0].components.length,7);
  return args[0]===host?entry(op,true):entry('0x'+'00'.repeat(20),false);};return c;};
 const reader=new LeaseReader({addressBook:book,clients:[peer(),peer()],now});
 assert.deepEqual((await reader.registryEntries(registry,[host,other])).map(({id,active,operator})=>({id,active,operator})),
  [{id:host,active:true,operator:book.toLowerCase()},{id:other,active:false,operator:'0x'+'00'.repeat(20)}]);
 reader.clients=[peer(),peer('0x'+'09'.repeat(20))];
 await assert.rejects(reader.registryEntries(registry,[host]),/agreeing chain quorum/);
 await assert.rejects(reader.registryEntries('0xnope',[host]),/exact registry ids/);
 await assert.rejects(reader.registryEntries(registry,[]),/exact registry ids/);
});
test('a registry read does not wait behind a stalled lease snapshot',async()=>{
 const registry='0x'+'03'.repeat(20),host='0x'+'cd'.repeat(32);let stall=true,release;
 const gate=new Promise(r=>release=r);
 const peer=()=>{const c=client();const read=c.readContract;c.readContract=async args=>{
  if(args.address===registry)return {endpoint:'',repo:'',measurement:'0x'+'00'.repeat(32),operator:book,registeredAt:1n,lastSeen:1n,active:true};
  if(stall&&args.functionName==='get')await gate;return read(args);};return c;};
 const reader=new LeaseReader({addressBook:book,clients:[peer(),peer()],now});
 const lease=reader.refresh([id]);
 try{const [entry]=await Promise.race([reader.registryEntries(registry,[host]),new Promise((_r,j)=>setTimeout(()=>j(Error('registry read queued behind the lease snapshot')),300))]);
  assert.equal(entry.active,true);}
 finally{stall=false;release();}
 assert.equal((await lease).length,1);
});
