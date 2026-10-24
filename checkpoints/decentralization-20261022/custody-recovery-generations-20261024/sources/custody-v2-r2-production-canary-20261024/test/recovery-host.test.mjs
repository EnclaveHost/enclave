// Execute the exact transformed host HTTP handler against private fixture state. No QEMU, host key, RPC or TEE.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {pathToFileURL} from 'node:url';
import {captureHostCopy} from '../driver/capture-host-copy.mjs';import {createRecoveryStateGate} from '../driver/recovery-state.mjs';import {captureGenesis} from '../driver/genesis-capture.mjs';import {sha256hex} from '../driver/canonical.mjs';
const source=fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2/custody/v2/host.mjs');
const made=captureHostCopy(source,{captureURL:pathToFileURL(path.resolve('driver/genesis-capture.mjs')).href}).source;
const begin=made.indexOf('const srv = http.createServer('),end=made.indexOf('\nsrv.listen(',begin);assert.ok(begin>0&&end>begin);const handler=made.slice(begin,end);
async function fixture(t,{fault=false}={}){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-recovery-http-'))),STATE=dir+'/state.bin',bytes=Buffer.alloc(80,29);fs.writeFileSync(STATE,bytes,{mode:0o600});fs.mkdirSync(dir+'/capture',{mode:0o700});const s=fs.statSync(STATE,{bigint:true}),expected={bytes:80,sha256:sha256hex(bytes),...Object.fromEntries(['dev','ino','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]))};
 const gate=createRecoveryStateGate({file:STATE,expected}),cfg={stateDir:dir,canarySubmitDir:dir+'/capture',endpoint:'https://custody-canary.example',canaryRecoveryFault:fault?'state-503':null};
 const server=Function('http','fs','path','cfg','STATE','recoveryState','log','captureGenesis',handler+'\nreturn srv;')(http,fs,path,cfg,STATE,gate,()=>{},captureGenesis);
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));fs.rmSync(dir,{recursive:true,force:true});});
 const request=async(method,p,body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+p,{method,body,signal:AbortSignal.timeout(3000)});return {status:r.status,body:Buffer.from(await r.arrayBuffer())};};
 return {dir,STATE,bytes,gate,request};
}
test('actual recovery handler refuses writes before reading retained state and never captures a new genesis',async t=>{
 const f=await fixture(t);assert.equal((await f.request('PUT','/state',Buffer.alloc(80,31))).status,500);assert.deepEqual(fs.readFileSync(f.STATE),f.bytes);
 const submit=await f.request('POST','/submit','{}');assert.equal(submit.status,503);assert.equal(JSON.parse(submit.body).error,'recovery_submit_disabled');assert.deepEqual(fs.readdirSync(f.dir+'/capture'),[]);
 const read=await f.request('GET','/state');assert.equal(read.status,200);assert.deepEqual(read.body,f.bytes);
 assert.equal((await f.request('PUT','/state',Buffer.alloc(80,31))).status,200);assert.deepEqual(fs.readFileSync(f.STATE),Buffer.alloc(80,31));
});
test('actual recovery handler returns a failure, never missing-state 404, when retained state disappears or changes',async t=>{
 for(const action of ['delete','replace']){const f=await fixture(t);if(action==='delete')fs.unlinkSync(f.STATE);else fs.writeFileSync(f.STATE,Buffer.alloc(80,30));const r=await f.request('GET','/state');assert.equal(r.status,500);assert.equal(f.gate.hasRead,false);assert.equal((await f.request('PUT','/state',Buffer.alloc(80,31))).status,500);if(action==='delete')assert.equal(fs.existsSync(f.STATE),false);else assert.deepEqual(fs.readFileSync(f.STATE),Buffer.alloc(80,30));}
});
test('state-503 fault does not read or overwrite sealed state and cannot submit anything',async t=>{
 const f=await fixture(t,{fault:true});assert.equal((await f.request('GET','/state')).status,503);assert.equal(f.gate.hasRead,false);assert.equal((await f.request('PUT','/state',Buffer.alloc(80,31))).status,500);assert.equal((await f.request('POST','/submit','{}')).status,503);assert.deepEqual(fs.readFileSync(f.STATE),f.bytes);assert.deepEqual(fs.readdirSync(f.dir+'/capture'),[]);
});
