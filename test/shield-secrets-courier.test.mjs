import test from 'node:test';import assert from 'node:assert/strict';import https from 'node:https';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {X509Certificate} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {createShieldSecrets} from '../windows/node/shield-secrets.mjs';
test('courier binds each proof to its actual TLS connection even with a warm global connection pool',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shield-courier-'));
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','key','-out','cert','-subj','/CN=guest','-days','1'],{cwd:dir,stdio:'ignore'});
 const cert=fs.readFileSync(path.join(dir,'cert')),key=fs.readFileSync(path.join(dir,'key')),spki=new X509Certificate(cert).publicKey.export({type:'spki',format:'der'}).toString('base64');
 const id='0x'+'34'.repeat(32),appId='56'.repeat(32);let mismatch=false;
 const server=https.createServer({cert,key},(q,r)=>{const nonce=new URL(q.url,'https://local').searchParams.get('nonce');r.end(JSON.stringify({id,purpose:'enclave-shield-secrets/1',doc:{transportKey:mismatch?'wrong':spki,appSha256:appId,nonce}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{
  await new Promise((resolve,reject)=>{https.get({host:'127.0.0.1',port,rejectUnauthorized:false},r=>{r.resume();r.on('end',resolve);}).on('error',reject);});
  const courier=createShieldSecrets({base:'http://manager',fetchImpl:async()=>({ok:true,json:async()=>({vms:[{id:'vm1',name:id,secretDeployment:id,status:'starting',appId,relay:{host:'127.0.0.1',port}}]})})});
  for(let n=1;n<=2;n++)assert.equal((await courier.evidence(id,n.toString(16).padStart(64,'0'))).handshakeSpki,spki);
  mismatch=true;await assert.rejects(courier.evidence(id,'09'.repeat(32)),/differs from TLS guest/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
