import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import dgram from 'node:dgram';import {execFileSync} from 'node:child_process';
import {createProviderCanary} from '../network/provider-canary.mjs';import {providerProbes} from '../network/provider-probes.mjs';import {DirectRuntime} from '../network/direct-runtime.mjs';
test('independent probe exercises canary ingress and negative proxy checks before app admission',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-probe-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const keyFile=path.join(dir,'key'),certFile=path.join(dir,'cert'),tokenFile=path.join(dir,'token');
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=probe-local.enclave.host','-days','1','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
 await fs.writeFile(tokenFile,'ab'.repeat(32),{mode:0o600});
 const port=dgram.createSocket('udp4');await new Promise(r=>port.bind(0,'127.0.0.1',r));const udpPort=port.address().port;await new Promise(r=>port.close(r));
 const canary=await createProviderCanary({keyFile,certFile,tokenFile,udpPort,hostname:'probe-local.enclave.host',bindHost:'127.0.0.1',manifestFile:path.join(dir,'manifest')},{address:'127.0.0.1'});
 const runtime=new DirectRuntime({address:'127.0.0.1',bindHost:'127.0.0.1',httpsPort:0,httpPort:0,canary,authorize:()=>false});t.after(()=>runtime.close());await runtime.listen();
 const probes=providerProbes(canary.manifest,{testPorts:{http:runtime.httpPort,https:runtime.httpsPort}});
 for(const name of ['tcp80','tcp443','udpEcho','payloadIntegrity','blocksPrivateDestinations','blocksOwnAddresses','blocksSmtp','rejectsUnauthorizedProxy'])assert.equal(await probes[name](),true,name);
 assert.equal(runtime.apps.size,0);assert.equal((await fs.stat(path.join(dir,'manifest'))).mode&0o777,0o600);
 const wrong=providerProbes({...canary.manifest,certificateSha256:'ff'.repeat(32)},{testPorts:{http:runtime.httpPort,https:runtime.httpsPort}});await assert.rejects(wrong.tcp443(),/key mismatch/);
});
