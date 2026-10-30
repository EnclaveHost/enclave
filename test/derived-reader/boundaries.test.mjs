import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageLibraries, nativeCommand } from '../../network/derived-reader/libraries.mjs';
import { spawnOwned, reapRun, stageBinary, sha256File } from '../../network/derived-reader/process.mjs';
import { serveDerivedReader } from '../../network/derived-reader/api.mjs';
import { invokeDerivation } from '../../network/derived-reader/native.mjs';
import { openDerivedJournal } from '../../network/derived-reader/journal.mjs';
import { readCheckpoint } from '../../network/derived-reader/l1-runtime.mjs';
import { createHash } from 'node:crypto';
import { createLifecycleFinalitySnapshot } from '../../network/lifecycle-finality-bridge.mjs';
import { openLifecycleJournal } from '../../network/deployment-lifecycle-journal.mjs';
import { createDerivedProvider } from '../../network/derived-reader/provider.mjs';
import { setup, nativeResult } from './helpers.mjs';
const directory = t => { const d=fs.mkdtempSync(path.join(os.tmpdir(),'reader-boundary-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d; };

test('native deadline, cancellation, oversized stdout and nonzero exit cannot yield a result', async t => {
  const dir = directory(t), native = path.join(dir, 'native');
  const invoke = extras => invokeDerivation({ executable: native, trusted: {}, witness: Buffer.from('{}'), workDir: dir, timeoutMs: 1000, ...extras });
  // These fast fixtures must reach their output/exit checks after spawnOwned has
  // recorded the live child. Otherwise an early exit exercises ownership refusal.
  const ownedFixture = body => fs.writeFileSync(native, '#!/bin/sh\nwhile [ ! -f child.json ]; do sleep 0.01; done\n' + body);
  fs.writeFileSync(native, '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
  await assert.rejects(invoke({ timeoutMs: 25 }), /deadline/);
  const ac = new AbortController(), waiting = invoke({ signal: ac.signal }); setTimeout(() => ac.abort(Error('test cancellation')), 25);
  await assert.rejects(waiting, /cancellation/);
  ownedFixture('head -c 100000 /dev/zero\n');
  await assert.rejects(invoke({ outputBytes: 1024 }), /output limit/);
  ownedFixture('printf "{}"\nexit 1\n');
  await assert.rejects(invoke(), /refused/);
  ownedFixture('printf "{}trailing"\n');
  await assert.rejects(invoke(), /one JSON/);
  assert.deepEqual(fs.readdirSync(dir), ['native']);
});
test('journal has one owner, refuses missing/corrupt state, and binds its runtime configuration', async t => {
  const dir = directory(t), binding = '1'.repeat(64);
  await assert.rejects(openDerivedJournal(dir,{binding}), /missing/);
  const j = await openDerivedJournal(dir,{binding,initialize:true});
  await assert.rejects(openDerivedJournal(dir,{binding}), /lock|in use/i);j.close();
  await assert.rejects(openDerivedJournal(dir,{binding:'2'.repeat(64)}), /binding/);
  fs.writeFileSync(path.join(dir,'derived-state.json'),'not json');
  await assert.rejects(openDerivedJournal(dir,{binding}), /JSON|Unexpected/);
});
test('checkpoint cannot outlive its reviewed weak-subjectivity window', t => {
  const dir=directory(t), file=path.join(dir,'checkpoint.json'), slot=15511008;
  const bytes=JSON.stringify({format:'enclave-l1-checkpoint/v1',network:'mainnet',slot,root:`0x${'11'.repeat(32)}`});fs.writeFileSync(file,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex'), timestamp=1606824023+slot*12;
  const accepted = {[hash]:'fixture'};
  assert.equal(readCheckpoint(file,{accepted,now:()=>timestamp*1000}).slot,slot);
  assert.throws(()=>readCheckpoint(file,{accepted,now:()=>(timestamp+604801)*1000}),/expired/);
  assert.throws(()=>readCheckpoint(file,{accepted,now:()=>(timestamp-3)*1000}),/future/);
});
test('local HTTP orchestration enforces exact shape, payload cap and cancellation', async t => {
  let aborted=false;
  const reader={status:()=>({hasDerivedAnchor:false}),readAnchor:async()=>{throw Error('no anchor');},
    prepare:async({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true})),
    submit:async()=>({status:'verified'})};
  const api=await serveDerivedReader(reader,{maxWitnessBytes:32,operationTimeoutMs:50});t.after(()=>api.close());
  const url=`http://127.0.0.1:${api.port}`;
  assert.equal((await fetch(url+'/status')).status,200);
  reader.status = () => { throw Error('journal failed'); };
  assert.equal((await fetch(url+'/status')).status,503);
  assert.equal((await fetch(url+'/anchor')).status,409);
  assert.equal((await fetch(url+'/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{"authority":true}'})).status,409);
  const tooBig=await fetch(url+'/witness/'+'a'.repeat(64),{method:'POST',headers:{'content-type':'application/octet-stream'},body:Buffer.alloc(33)});
  assert.equal(tooBig.status,409);
  const timed=await fetch(url+'/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{"blockNumber":1,"rollupConfigTemplate":{}}'});
  assert.equal(timed.status,409);assert.equal(aborted,true);
});
test('startup deadline cancels a hung owned L1 response and cleans up its child record', async t => {
  const started = Date.now();
  await assert.rejects(setup(t, { stall: true, readyTimeoutMs: 500 }), /readiness deadline/);
  assert.ok(Date.now() - started < 5000, 'readiness must not wait for the 20-second RPC timeout');
});
test('saved native ownership is reaped before its private executable is removed', async t => {
  const dir = directory(t), hash = await sha256File(process.execPath);
  const executable = await stageBinary(process.execPath, hash, dir, { [hash]: 'process ownership fixture' });
  const child = spawnOwned(executable, ['--max-old-space-size=64', '-e', 'setInterval(()=>{},1000)'], { cwd: dir });
  t.after(async () => { await child.kill(); await child.done; });
  assert.ok(fs.existsSync(path.join(dir, 'child.json')));
  await reapRun(dir); await child.done;
  assert.equal(child.exited, true);
  assert.equal(fs.existsSync(path.join(dir, 'child.json')), false);
});
test('explicit loader selection cannot introduce an unreviewed library set', async t => {
  const dir = directory(t);
  await assert.rejects(stageLibraries({ build: 'operator-provided', dir }, dir), /unreviewed/);
  const result = nativeCommand('/private/native', ['input', 'witness'], { loader: '/private/lib/ld', dir: '/private/lib' });
  assert.deepEqual(result, { executable: '/private/lib/ld', args: ['--inhibit-cache', '--library-path', '/private/lib', '/private/native', 'input', 'witness'] });
});
test('the lifecycle snapshot consumes the local reader capability and pins state reads to its derived hash', async t => {
  const f=await setup(t), journal=await openDerivedJournal(f.directory,{binding:'3'.repeat(64),initialize:true});t.after(()=>journal.close());
  const reader=await createDerivedProvider({l1:f.l1,journal,executable:f.native,workDir:f.directory,now:()=>f.now,
    bootstrap:async()=>f.agreed,base:async()=>f.candidate});t.after(()=>reader.close());
  const ticket=await reader.prepare({blockNumber:101,rollupConfigTemplate:{l2_chain_id:8453}});
  await reader.submit({ticket:ticket.ticket,witness:Buffer.from(JSON.stringify(nativeResult(ticket,f.candidate)))});
  const calls=[];
  const verifier={request:async(method,params)=>{calls.push({method,params});
    if(method==='eth_chainId')return '0x2105';if(method==='eth_getBlockByNumber')return f.candidate;if(method==='eth_getBalance')return '0x123';throw Error('fixture unknown method');}};
  const snapshot=createLifecycleFinalitySnapshot({readAnchor:reader.readAnchor,verifier,now:()=>f.now,
    journal:openLifecycleJournal(path.join(f.directory,'lifecycle.json')),maxAnchorAgeSec:1800});
  const result=await snapshot(c=>c.getBalance({address:'0x0000000000000000000000000000000000000001'}));
  assert.equal(result.value,291n);assert.equal(result.evidence.tier,'l1-finalized-derived');
  assert.deepEqual(calls.find(c=>c.method==='eth_getBalance').params[1],{blockHash:f.candidate.hash});
});
