import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash, X509Certificate} from 'node:crypto';
import {probeGuest} from '../network/guest-probe.mjs';

test('shared ingress receives SNI and authenticates the pinned guest before WebPKI issuance', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'probe-sni-'));
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=bootstrap',
    '-days','1','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert')],{stdio:'ignore'});
  const cert=fs.readFileSync(path.join(dir,'cert')), key=fs.readFileSync(path.join(dir,'key'));
  const pin=createHash('sha256').update(new X509Certificate(cert).publicKey.export({format:'der',type:'spki'})).digest('hex');
  let requests=0, sni;
  const guest=https.createServer({key,cert},(req,res)=>{requests++;sni=req.socket.servername;res.setHeader('Content-Length','5');res.end('ready');});
  await new Promise(r=>guest.listen(0,'127.0.0.1',r));
  const sockets=new Set();
  const proxy=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.once('data',()=>{
      socket.write(Buffer.from([5,0]));
      socket.once('data',()=>{
        const upstream=net.connect(guest.address().port,'127.0.0.1',()=>{
          socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());
      });
    });
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const probe=extra=>probeGuest({deploymentId:'0x'+'ab'.repeat(32),hostname:'cron.test',address:'127.0.0.1',
    port:guest.address().port,proxy:'127.0.0.1:'+proxy.address().port,expected:{appSha256:'cd'.repeat(32),runtimeId:'ef'.repeat(32)},
    pinnedSpkiSha256:pin,...extra});
  try {
    assert.equal((await probe({})).pinned,true);assert.equal(sni,'cron.test');assert.equal(requests,1);
    await assert.rejects(probe({pinnedSpkiSha256:'00'.repeat(32)}),/guest TLS key changed/);
    assert.equal(requests,1,'mismatched peer receives no HTTP request');
    assert.equal((await probe({domainIndependent:true})).pinned,true);assert.equal(sni,false);
  } finally {
    for(const socket of sockets)socket.destroy();
    await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>guest.close(r))]);fs.rmSync(dir,{recursive:true});
  }
});
