import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {TunaTransportController} from '../network/tuna-transport-control.mjs';
import {startTunaControlServer} from '../network/tuna-control-server.mjs';
import {tunaReceiptDigest} from '../network/tuna-usdc-settlement.mjs';
const id='0x'+'aa'.repeat(32),runner='0x'+'bb'.repeat(32),providerId='0x'+'dd'.repeat(32),owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20),ledger='0x'+'33'.repeat(20),hash='0x'+'cc'.repeat(32);
const host=privateKeyToAccount('0x'+'04'.repeat(32)),provider=privateKeyToAccount('0x'+'05'.repeat(32));
const wire={clientKey:'01'.repeat(32),providerKey:'02'.repeat(32),nonce:'03'.repeat(32)};
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tuna-control-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let now=100000,served=0n;
 const lease={id,runner,owner,runnerProofKey:host.address,active:true,chainId:8453,deployments:ledger,validUntil:190000,leaseUntil:200000,blockNumber:'100',blockHash:hash,balance6:'100000',bandwidthBackingRequired6:'0',
 connectivity:{address:contract,viaTuna:true,owner,nonce:'1',expires:200,maxPricePerGiB6:'1000000',budget6:'10000',spent6:'0',providers:[{id:providerId,qualified:true,active:true,qualifiedUntil:200,pricePerGiB6:'1000000',operator:provider.address,proofKey:provider.address}]}};
 const client={readContract:async()=>served,getBlock:async()=>({hash})},reader={clients:[client,client],get:()=>lease,refresh:async()=>[lease]};
 const settlements=[];
 const common={leaseReader:reader,maxPending6:'100',now:()=>now};
 const a=new TunaTransportController({...common,role:'runner',hostId:runner,proofAccount:host,directory:path.join(directory,'runner'),settlementFactory:async(pid,cosign)=>({authorizeDebit:async r=>settlements.push(r),flush:async()=>{},close:async()=>{},cosign})});
 const b=new TunaTransportController({...common,role:'provider',hostId:providerId,proofAccount:provider,directory:path.join(directory,'provider')});
 t.after(async()=>{await a.close();await b.close()});
 const open=async(nonce=wire.nonce)=>{
  const w={...wire,nonce};const ah=await a.open({transcript:{...w,server:false},deploymentId:id,providerId});
  const bh=await b.open({transcript:{...w,server:true},proof:ah.proof});
  await a.confirm(ah.session,bh.proof);await b.confirm(bh.session,null);return {a:ah.session,b:bh.session,proof:ah.proof};
 };
 const observe=async(c,s,d,n)=>{const r=await c.reserve(s,{direction:d,bytes:n});await c.commit(s,{ticket:r.ticket,bytes:n});};
 return {a,b,lease,open,observe,settlements,directory,setNow:n=>now=n,setServed:n=>served=n};
}
test('mutual signatures bind the real transport keys, nonce, provider, app and owner policy',async t=>{
 const x=await fixture(t),hello=await x.a.open({transcript:{...wire,server:false},deploymentId:id,providerId});
 await assert.rejects(x.a.reserve(hello.session,{direction:'out',bytes:1}),/unconfirmed/);
 await assert.rejects(x.b.open({transcript:{...wire,nonce:'04'.repeat(32),server:true},proof:hello.proof}),/signature/);
 const peer=await x.b.open({transcript:{...wire,server:true},proof:hello.proof});
 await assert.rejects(x.b.open({transcript:{...wire,server:true},proof:hello.proof}),/replay/);
 await assert.rejects(x.a.confirm(hello.session,{...peer.proof,signature:hello.proof.signature}),/signature/);
 await x.a.confirm(hello.session,peer.proof);await x.b.confirm(peer.session,null);
 await x.observe(x.a,hello.session,'out',100);await x.observe(x.b,peer.session,'in',100);
 assert.equal(await x.a.observed(hello.proof.terms),100n);assert.equal(await x.b.observed(hello.proof.terms),100n);
 x.lease.connectivity.nonce='2';await assert.rejects(x.a.reserve(hello.session,{direction:'out',bytes:1}),/authorization/);
});
test('credit reservations cover concurrent streams and only committed writes count',async t=>{
 const x=await fixture(t),s=await x.open();
 const r=await x.a.reserve(s.a,{direction:'out',bytes:32768});
 await x.a.commit(s.a,{ticket:r.ticket,bytes:100});assert.equal(await x.a.observed(s.proof.terms),100n);
 await assert.rejects(x.a.commit(s.a,{ticket:r.ticket,bytes:100}),/invalid/);
 const reserved=await Promise.allSettled(Array.from({length:4},()=>x.a.reserve(s.a,{direction:'out',bytes:32768})));
 assert.equal(reserved.filter(r=>r.status==='fulfilled').length,3);
 const key=x.a.key(s.proof.terms);x.a.drop(s.a);await x.a.queues.get(key);assert.equal(x.a.reservations.get(key),0n);
});
test('provider cosigns only its own durable observed traffic and rejects client meter claims',async t=>{
 const x=await fixture(t),s=await x.open();await x.observe(x.b,s.b,'in',1000);
 const receipt={id,runnerId:runner,providerId,policyNonce:1n,leaseUntil:200n,issuedAt:100n,anchor:99n,cumulativeBytes:1000n,pricePerGiB6:1000000n};
 const envelope=async r=>({receipt:r,anchorHash:hash,runnerSignature:await host.signMessage({message:{raw:tunaReceiptDigest({chainId:8453,connectivity:contract,ledger,receipt:r,anchorHash:hash})}})});
 const ok=await x.b.remote(s.b,{type:'cosign',envelope:await envelope(receipt)});assert.match(ok.signature,/^0x/);
 await assert.rejects(x.b.remote(s.b,{type:'cosign',envelope:await envelope({...receipt,cumulativeBytes:1001n})}),/observed/);
 const stored=JSON.parse(await fs.readFile(path.join(x.directory,'provider','transport',x.b.key(s.proof.terms)+'.json'),'utf8'));assert.equal(stored.in,'1000');
});
test('settlement uses the smaller independent meter and control traffic never changes counters',async t=>{
 const x=await fixture(t),s=await x.open();await x.observe(x.a,s.a,'out',2000);await x.observe(x.b,s.b,'in',1500);
 const tick=x.a.tick(),q=await x.a.next(s.a);const answer=await x.b.remote(s.b,q.request);await x.a.reply(s.a,{id:q.id,response:answer});await tick;
 assert.equal(x.settlements[0].cumulativeBytes,'1500');assert.equal(await x.a.observed(s.proof.terms),2000n);
 assert.equal(await x.b.observed(s.proof.terms),1500n);
});
test('controller HTTP requires bearer token and exposes no unauthenticated operations',async t=>{
 const x=await fixture(t),token='ab'.repeat(32),server=await startTunaControlServer({controller:x.a,token});t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.port+'/';
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
 const res=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({action:'open',body:{transcript:{...wire,server:false},deploymentId:id,providerId}})});
 assert.equal(res.status,200);assert.match((await res.json()).session,/^[0-9a-f]{48}$/);
});

test('real Go encrypted transport uses the local controllers for authorization, metering and receipt signatures',async t=>{
 const {spawn}=await import('node:child_process');
 const x=await fixture(t);x.a.maxPending6=x.b.maxPending6=1000000n;let signed=0;
 x.a.settlementFactory=async(pid,cosign)=>{
  let accepted;return {authorizeDebit:async r=>{accepted=r},close:async()=>{},flush:async()=>{
   const r={id,runnerId:runner,providerId:pid,policyNonce:1n,leaseUntil:200n,issuedAt:100n,anchor:99n,cumulativeBytes:BigInt(accepted.cumulativeBytes),pricePerGiB6:1000000n};
   const digest=tunaReceiptDigest({chainId:8453,connectivity:contract,ledger,receipt:r,anchorHash:hash});
   const runnerSignature=await host.signMessage({message:{raw:digest}}),providerSignature=await cosign({receipt:r,runnerSignature,anchorHash:hash});
   const {recoverMessageAddress}=await import('viem');assert.equal(await recoverMessageAddress({message:{raw:digest},signature:providerSignature}),provider.address);signed++;
  }};
 };
 const token='ab'.repeat(32),tokenFile=path.join(x.directory,'token');await fs.writeFile(tokenFile,token,{mode:0o600});
 const a=await startTunaControlServer({controller:x.a,token,intervalMs:1000}),b=await startTunaControlServer({controller:x.b,token,intervalMs:1000});t.after(async()=>{await a.close();await b.close()});
 const cfg={Runner:{endpoint:'http://127.0.0.1:'+a.port+'/',tokenFile,deploymentId:id,providerId},Provider:{endpoint:'http://127.0.0.1:'+b.port+'/',tokenFile}};
 const result=await new Promise((resolve,reject)=>{const p=spawn('go',['test','github.com/nknorg/tuna','-run','^TestUSDCLocalControllerIntegration$','-count=1','-timeout=45s'],{cwd:new URL('../network/tuna/',import.meta.url),env:{...process.env,ENCLAVE_USDC_TEST_CONTROLLERS:JSON.stringify(cfg)}});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);p.on('error',reject);p.on('exit',code=>resolve({code,out}));});
 assert.equal(result.code,0,result.out);assert.ok(signed>0,'no provider receipt crossed the real transport');
 const meters=await fs.readdir(path.join(x.directory,'provider','transport'));const file=meters.find(f=>/^[0-9a-f]{64}\.json$/.test(f));
 assert.ok(file);const meter=JSON.parse(await fs.readFile(path.join(x.directory,'provider','transport',file),'utf8'));assert.equal(meter.in,String(Buffer.byteLength('tls-passthrough\0')*128*1024));
});

test('worker control capabilities cannot cross app, provider or session boundaries',async t=>{
 const x=await fixture(t),token='ab'.repeat(32);
 const first=await startTunaControlServer({controller:x.a,token,scope:{deploymentId:id,providerId},ownsController:false,intervalMs:0});
 const second=await startTunaControlServer({controller:x.a,token,scope:{deploymentId:id,providerId},ownsController:false,intervalMs:0});
 t.after(async()=>{await first.close();await second.close()});
 const call=(port,body)=>fetch('http://127.0.0.1:'+port+'/',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});
 const body={transcript:{...wire,server:false},deploymentId:id,providerId};
 assert.equal((await call(first.port,{action:'open',body:{...body,deploymentId:runner}})).status,409);
 const opened=await (await call(first.port,{action:'open',body})).json();
 assert.equal((await call(second.port,{action:'close',session:opened.session})).status,409);
 assert.ok(x.a.sessions.has(opened.session));await first.close();assert.equal(x.a.sessions.has(opened.session),false);assert.equal(x.a.closed,false);
});
