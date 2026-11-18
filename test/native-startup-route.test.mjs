import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {probeGuest} from '../network/guest-probe.mjs';
import {probeNativeGuest} from '../network/native-startup-overlay.mjs';

test('native startup circuit accepts only a pinned 503 and preserves readiness',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-startup-route-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=native.invalid','-days','1','-keyout',dir+'/key','-out',dir+'/cert'],{stdio:'ignore'});
 const cert=fs.readFileSync(dir+'/cert'),key=fs.readFileSync(dir+'/key');
 const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({format:'der',type:'spki'})).digest('hex');
 let status=503,requests=0;
 const server=https.createServer({key,cert},(req,res)=>{requests++;assert.equal(req.socket.servername,'native.invalid');assert.equal(req.url,'/.well-known/enclave-ready');assert.equal(req.headers.authorization,undefined);res.writeHead(status);res.end('still starting');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const options={deploymentId:'0x'+'ab'.repeat(32),hostname:'native.invalid',address:'127.0.0.1',port:server.address().port,direct:true,pinnedSpkiSha256:pin,expected:{requiresDesktop:true,requiresConfigSocketServer:true,requiresSecretsV1:true,appSha256:'cd'.repeat(32),runtimeId:'ef'.repeat(32)}};
 const result=await probeNativeGuest(options);assert.equal(result.verified,true);assert.equal(result.ready,false);assert.equal(result.spkiSha256,pin);
 assert.equal((await probeNativeGuest({...options,domainIndependent:true})).ready,false,'old caller flag cannot remove SNI from shared ingress');
 await assert.rejects(probeGuest(options),/readiness HTTP 503/,'legacy/default route still requires readiness');
 const before=requests;await assert.rejects(probeNativeGuest({...options,pinnedSpkiSha256:'00'.repeat(32)}),/TLS key changed/);assert.equal(requests,before,'wrong key gets no HTTP');
 for(const field of ['requiresDesktop','requiresConfigSocketServer','requiresSecretsV1'])await assert.rejects(async()=>probeNativeGuest({...options,expected:{...options.expected,[field]:false}}),/native/);
 assert.equal(requests,before,'missing native policy gets no request');
 status=500;await assert.rejects(probeNativeGuest(options),/readiness HTTP 500/);
 status=200;assert.equal((await probeNativeGuest(options)).ready,true);
 await assert.rejects(probeGuest({...options,startupRoute:true,pinnedSpkiSha256:null}),/current attested key/);
});

// The agent's own wiring (network/privacy-agent.mjs): what the NucBox's installed agent carried as an overlay since 2026-10-26.
test('the privacy agent probes a desktop expectation natively and forwards its starting guest',async()=>{
 const {guestProbeFor,nativeAppForward}=await import('../network/privacy-agent.mjs');
 const {PassThrough}=await import('node:stream');
 assert.equal(guestProbeFor({requiresDesktop:true}),probeNativeGuest);
 for(const expected of [undefined,null,{},{requiresDesktop:false},{requiresDesktop:'true'}])assert.equal(guestProbeFor(expected),probeGuest,'only an explicit desktop expectation is probed natively');
 // no starting transport (Linux, pVM, a Windows host without the Shield manager): the forwarder is the one it was
 const normal=Object.assign(async()=>{},{plan:async()=>({dataAddr:'127.0.0.1:1',route:{}})});
 assert.equal(nativeAppForward({starting:null,normal,expected:()=>null,proof:()=>null,authorize:()=>true}),normal);
 const id='0x'+'ab'.repeat(32),want={requiresDesktop:true,requiresConfigSocketServer:true,requiresSecretsV1:true,appSha256:'cd'.repeat(32),runtimeId:'ef'.repeat(32)};
 let proof={verified:true,ready:false,deploymentId:id,appSha256:want.appSha256,runtimeId:want.runtimeId,spkiSha256:'12'.repeat(32),validUntil:Date.now()+60000},admitted=true,opened=0,normals=0;
 const guest=new PassThrough();
 const forward=nativeAppForward({starting:async()=>{opened++;return guest;},normal:Object.assign(async()=>{normals++;},{plan:async()=>'planned'}),
   expected:x=>x===id?want:{appSha256:'00'.repeat(32)},proof:()=>proof,authorize:()=>admitted});
 // another app: the normal forwarder and its plan, untouched
 await forward(new PassThrough(),'0x'+'cd'.repeat(32));assert.deepEqual([opened,normals],[0,1]);
 assert.equal(await forward.plan('0x'+'cd'.repeat(32)),'planned');
 // the desktop app while it starts: its starting guest, on the main thread (no plan)
 const socket=new PassThrough();await forward(socket,id);assert.deepEqual([opened,normals],[1,1]);
 assert.equal(await forward.plan(id),null);socket.destroy();guest.destroy();
 // ready: the normal forwarder again; no longer admitted: refused before anything is opened
 proof={...proof,ready:true};await forward(new PassThrough(),id);assert.deepEqual([opened,normals],[1,2]);assert.equal(await forward.plan(id),'planned');
 admitted=false;await assert.rejects(forward(new PassThrough(),id),/current admitted proof/);await assert.rejects(forward.plan(id),/current admitted proof/);
 assert.deepEqual([opened,normals],[1,2]);
});
