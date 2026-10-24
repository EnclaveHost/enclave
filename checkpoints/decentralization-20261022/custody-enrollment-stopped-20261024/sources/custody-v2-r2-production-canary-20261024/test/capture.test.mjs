import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {captureGenesis,readCapturedGenesis,validateCaptureDirectory} from '../driver/genesis-capture.mjs';
import {captureHostCopy} from '../driver/capture-host-copy.mjs';
import {R2,METAL0_REGISTRY_ID} from '../driver/plan.mjs';
const endpoint='https://custody-canary.enclave.host',H=x=>'0x'+x.repeat(32);
const request=()=>({fn:'createCommittee',args:[H('ab'),{identity:'0x'+'12'.repeat(20),encKey:H('34'),endpoint,chipId:H('56'),registryId:METAL0_REGISTRY_ID,measurement:R2.measurementSha256},
 '0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',[R2.measurementSha256],'0x'+'00'.repeat(65),'0x'+'00'.repeat(65)]});
const tmp=()=>fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'custody-capture-')));
const run=(d,p=request(),io)=>captureGenesis({dir:d,endpoint,body:Buffer.from(JSON.stringify(p)),io});
test('one private durable request, same-intent retry, different intent refused, no success acknowledgement',()=>{
 const d=tmp();try{
  const first=run(d);assert.equal(first.status,503);assert.equal(first.code,'canary_genesis_captured');
  assert.deepEqual(run(d),first);assert.equal(fs.statSync(path.join(d,'genesis-request.json')).mode&0o777,0o600);
  const changed=request();changed.args[0]=H('cd');assert.equal(run(d,changed).status,409);
  assert.deepEqual(readCapturedGenesis({dir:d,endpoint}).request,request());
  assert.deepEqual(fs.readdirSync(d),['genesis-request.json']);
  for(const part of [request().args[1].chipId,request().args[4]])assert.ok(!JSON.stringify(first).includes(part));
 }finally{fs.rmSync(d,{recursive:true});}
});
test('rejects any other operation, shape, machine, code set, endpoint, signature or oversized request',()=>{
 const d=tmp();try{
  const variants=[p=>p.fn='removeCode',p=>p.extra=true,p=>p.args.pop(),p=>p.args[1].endpoint='https://other.example',p=>p.args[1].registryId=H('77'),
   p=>p.args[1].measurement=H('77'),p=>p.args[1].extra=true,p=>p.args[3].push(H('88')),p=>p.args[4]='bad',p=>p.args[2]='0x04'+'00'.repeat(32)];
  for(const mutate of variants){const p=request();mutate(p);assert.equal(run(d,p).code,'canary_capture_refused');assert.equal(fs.readdirSync(d).length,0);}
  assert.equal(captureGenesis({dir:d,endpoint,body:Buffer.alloc(16385)}).code,'canary_capture_refused');
  assert.equal(captureGenesis({dir:d,endpoint,body:Buffer.from(JSON.stringify(request())+' '.repeat(16385))}).code,'canary_capture_refused');
 }finally{fs.rmSync(d,{recursive:true});}
});
test('refuses symlinked/unsafe directories and records; no existing capture is overwritten',()=>{
 const d=tmp(),link=d+'-link';try{
  fs.symlinkSync(d,link);assert.throws(()=>validateCaptureDirectory(link));
  fs.chmodSync(d,0o755);assert.equal(run(d).code,'canary_capture_refused');fs.chmodSync(d,0o700);
  const target=path.join(d,'target');fs.writeFileSync(target,'do not overwrite',{mode:0o600});fs.symlinkSync(target,path.join(d,'genesis-request.json'));
  assert.equal(run(d).code,'canary_capture_refused');assert.equal(fs.readFileSync(target,'utf8'),'do not overwrite');
 }finally{fs.unlinkSync(link);fs.rmSync(d,{recursive:true});}
});
test('storage failure never acknowledges submission or exposes an intent or error payload',()=>{
 const d=tmp();try{
  const io={...fs,fsyncSync:()=>{throw Error('private error material');}};
  const r=run(d,request(),io);assert.deepEqual(r,{status:503,code:'canary_capture_refused'});assert.equal(fs.readdirSync(d).length,0);
  run(d);fs.chmodSync(path.join(d,'genesis-request.json'),0o644);assert.equal(run(d).code,'canary_capture_refused');
 }finally{fs.rmSync(d,{recursive:true});}
});
test('exact host transformation removes automatic wallet submission, parses, and refuses changed source',()=>{
 const src=fs.readFileSync('/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-release-20261023/repo-r2/custody/v2/host.mjs');
 const captureURL=pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../driver/genesis-capture.mjs')).href;
 const made=captureHostCopy(src,{captureURL});assert.equal(made.sourceSha256,R2.hostSha256);assert.equal(made.copySha256.length,64);
 assert.ok(!made.source.includes('wallet.writeContract'));assert.ok(!made.source.includes('CUSTODY_SUBMITTER_KEY'));
 assert.ok(made.source.includes('watchCanaryGuest(child,{isStopping:()=>stopping,notify:log})'));
 assert.ok(!made.source.includes('setTimeout(launch'));assert.ok(!made.source.includes('restarts++'));
 assert.ok(made.source.includes('validateCaptureDirectory(cfg.canarySubmitDir)'));assert.ok(made.source.includes('captureGenesis({dir:cfg.canarySubmitDir'));
 assert.ok(made.source.includes("req.url==='/submit'?16384:4<<20"));
 const d=tmp();try{const p=path.join(d,'host.mjs');fs.writeFileSync(p,made.source);const c=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);}finally{fs.rmSync(d,{recursive:true});}
 assert.throws(()=>captureHostCopy(Buffer.concat([src,Buffer.from('\n')]),{captureURL}),/differs/);
 assert.throws(()=>captureHostCopy(src,{captureURL:'https://remote.example/module.mjs'}),/local/);
});
