import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {probeGuest} from '../network/guest-probe.mjs';

// A Shield guest serves one TPM report at a time and answers the rest with
// HTTP 500 "busy; retry": the probe waits that out, and only that.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'probe-busy-'));
execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=guest.test','-addext','subjectAltName=DNS:guest.test','-days','1',
  '-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});
const tlsOptions={key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))};
// the probe verifies the guest's certificate as usual: trust this one for the test
tls.setDefaultCACertificates([...tls.getCACertificates('default'),tlsOptions.cert.toString()]);
const id='0x'+'ab'.repeat(32),expected={appSha256:'cd'.repeat(32),runtimeId:'ef'.repeat(32)};

async function guest(answers){
  let n=0,ready=0;
  const server=https.createServer(tlsOptions,(req,res)=>{
    if(req.url==='/.well-known/enclave-ready'){ready++;res.writeHead(200);res.end('ok');return;}
    const a=answers[Math.min(n++,answers.length-1)];
    res.writeHead(a.status,{'content-type':'text/plain'});res.end(a.body);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const {port}=server.address();
  const openApp=()=>new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
  return {requests:()=>n,readyRequests:()=>ready,close:()=>new Promise(r=>server.close(r)),
    probe:(extra={})=>probeGuest({deploymentId:id,hostname:'guest.test',expected,shield:{},hostSession:{},openApp,...extra})};
}
const busy={status:500,body:'report: guest VBS report: guest TPM attestation busy; retry'};
const crowded={status:500,body:'report: too many concurrent report requests from this domain'};

test('busy answers are retried until the guest reports', {timeout:60000}, async()=>{
  const g=await guest([busy,crowded,{status:200,body:'{}'}]);
  try{await assert.rejects(g.probe(),/nonce or TLS binding mismatch/);assert.equal(g.requests(),3);}
  finally{await g.close();}
});
test('any other server error fails at once', {timeout:60000}, async()=>{
  const g=await guest([{status:500,body:'report: vTPM quote failed'}]);
  try{await assert.rejects(g.probe(),/guest attestation HTTP 500/);assert.equal(g.requests(),1);}
  finally{await g.close();}
});
test('a guest that stays busy still fails, after a bounded number of tries', {timeout:60000}, async()=>{
  const g=await guest([busy]);
  try{await assert.rejects(g.probe(),/guest attestation HTTP 500/);assert.equal(g.requests(),6);}
  finally{await g.close();}
});

// A route probe pinned to the TLS key of the current proof asks for no report.
const keySha256=createHash('sha256').update(new X509Certificate(tlsOptions.cert).publicKey.export({format:'der',type:'spki'})).digest('hex');
test('a route probe pinned to the proven TLS key needs no new report', {timeout:60000}, async()=>{
  const g=await guest([busy]);
  try{
    const r=await g.probe({pinnedSpkiSha256:keySha256});
    assert.equal(r.verified,true);assert.equal(r.pinned,true);assert.equal(r.spkiSha256,keySha256);
    assert.equal(g.requests(),0);assert.equal(g.readyRequests(),1);
  }finally{await g.close();}
});
test('a guest whose TLS key is not the pinned one is asked for a fresh report', {timeout:60000}, async()=>{
  const g=await guest([{status:500,body:'report: vTPM quote failed'}]);
  try{await assert.rejects(g.probe({pinnedSpkiSha256:'00'.repeat(32)}),/guest attestation HTTP 500/);assert.equal(g.requests(),1);}
  finally{await g.close();fs.rmSync(dir,{recursive:true,force:true});}
});
