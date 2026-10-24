import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import {execFileSync} from 'node:child_process';import {X509Certificate} from 'node:crypto';
import {sha256hex} from '../driver/canonical.mjs';
import {fetchPinnedProof,proveLiveRecipient} from '../driver/recipient-proof.mjs';
import {mac} from '../driver/proof.mjs';
const id='0x'+'12'.repeat(32),required=[{CANARY_A:'CANARY_20261024T000000Z_fixture_'+'a'.repeat(64)}];
// Dedicated-canary syntax, with no real secret fixture.
function fixture(){
 const observation={status:'recipient-observed',attemptDigest:'a'.repeat(64),custodianWindowDigest:'b'.repeat(64),identity:{id},instance:{id:'gd12345678',transportKeySha256:'c'.repeat(64)},process:{pid:1,startTicks:'2'}};
 const quote={status:'recipient-attested',id,attemptDigest:observation.attemptDigest,transportKeySha256:observation.instance.transportKeySha256,requestedAt:1000,verifiedAt:1000};
 return {id,pins:{},required,observeRecipient:async()=>structuredClone(observation),attest:async()=>quote,now:()=>1000,
  fetchProof:async({id:got,keyHash,url})=>{assert.equal(got,id);assert.equal(keyHash,quote.transportKeySha256);const c=new URL(url).searchParams.get('c');return new Response(JSON.stringify({v:1,names:['CANARY_A'],proofs:{CANARY_A:mac(required[0].CANARY_A,'CANARY_A',c)}}),{headers:{'content-type':'application/json','cache-control':'no-store'}});}};
}
test('consumption uses the fresh attested transport and retains only curated evidence',async()=>{
 const r=await proveLiveRecipient(fixture());assert.equal(r.outcome,'pass');assert.equal(r.evidence.transportPinned,true);assert.equal(r.evidence.attestation.status,'recipient-attested');assert.ok(!JSON.stringify(r).includes(required[0].CANARY_A));
});
test('recipient replacement after a correct proof, expired quote, or wrong HMAC cannot pass',async()=>{
 const f=fixture();let n=0;const observe=f.observeRecipient;
 await assert.rejects(()=>proveLiveRecipient({...f,observeRecipient:async()=>{const r=await observe();if(++n===3)r.process.startTicks='3';return r;}}));
 let clock=1000;await assert.rejects(()=>proveLiveRecipient({...f,now:()=>clock,fetchProof:async x=>{const r=await f.fetchProof(x);clock=121001;return r;}}));
 const r=await proveLiveRecipient({...f,fetchProof:async()=>new Response(JSON.stringify({v:1,names:['CANARY_A'],proofs:{CANARY_A:'0'.repeat(64)}}),{headers:{'content-type':'application/json','cache-control':'no-store'}})});assert.equal(r.outcome,'fail');
});
test('real TLS pin rejects a different key before HTTP and bounds responses without redirects',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recipient-proof-tls-'));
 execFileSync('/usr/bin/openssl',['req','-x509','-newkey','ed25519','-nodes','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore',timeout:10000});
 const cert=fs.readFileSync(path.join(dir,'cert'));let hits=0,mode='ok';
 const server=https.createServer({key:fs.readFileSync(path.join(dir,'key')),cert},(_req,res)=>{hits++;if(mode==='redirect'){res.writeHead(302,{location:'https://other.invalid'});res.end();}else{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(mode==='large'?Buffer.alloc(4097):'{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});});
 const keyHash=sha256hex(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'}));
 const requestImpl=(opts,cb)=>{assert.equal(opts.agent,false);assert.equal(opts.hostname,'12121212.app.enclave.host');return https.request({...opts,hostname:'127.0.0.1',port:server.address().port,servername:'localhost'},cb);};
 const args={id,keyHash,url:`https://12121212.app.enclave.host/canary/proof?c=${'a'.repeat(64)}`,requestImpl};
 assert.equal((await fetchPinnedProof(args)).status,200);assert.equal(hits,1);
 await assert.rejects(()=>fetchPinnedProof({...args,keyHash:'0'.repeat(64)}));assert.equal(hits,1);
 for(mode of ['redirect','large'])await assert.rejects(()=>fetchPinnedProof(args));
 for(const url of ['https://other.invalid/canary/proof?c='+ 'a'.repeat(64),args.url+'&secret=x'])assert.throws(()=>fetchPinnedProof({...args,url}));
});
