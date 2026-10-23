import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readStartupState, loadStartupState } from '../custody/v2/startup-state.mjs';

test('storage outage, malformed body and transport failures never create or overwrite an identity', async t => {
  let mode = 'stored', created = 0, writes = 0;
  const saved = Buffer.alloc(64, 7), identity = { identity: 'dedicated-test-only' };
  const srv = http.createServer((req, res) => {
    if (mode === 'disconnect') return req.socket.destroy();
    if (mode === 'stall') return;
    if (mode === 'redirect') { res.writeHead(302, {location:'/state'}); return res.end(); }
    if (mode === 'missing') { res.writeHead(404); return res.end(); }
    if (mode === 'unavailable') { res.writeHead(503); return res.end(); }
    if (mode === 'forbidden') { res.writeHead(403); return res.end(); }
    if (mode === 'empty') return res.end();
    if (mode === 'short') return res.end(Buffer.alloc(27));
    if (mode === 'oversize') return res.end(Buffer.alloc(129));
    if (mode === 'bad-seal') return res.end(Buffer.alloc(64, 8));
    res.end(saved);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)); });
  const options = {
    read: () => readStartupState(`http://127.0.0.1:${srv.address().port}/state`, {timeoutMs:300,maxBytes:128}),
    unseal: blob => { assert.deepEqual(blob, saved, 'authenticated blob only'); return identity; },
    fresh: () => { created++; return { identity:'new-test-only' }; },
    persist: async () => { writes++; },
  };
  assert.equal(await loadStartupState(options), identity);
  for (mode of ['unavailable','forbidden','empty','short','oversize','bad-seal','redirect','disconnect','stall']) {
    await assert.rejects(loadStartupState(options), undefined, mode);
    assert.equal(created, 0, mode + ': no replacement identity');
    assert.equal(writes, 0, mode + ': existing disk untouched');
  }
  mode = 'stored';
  assert.equal(await loadStartupState(options), identity, 'recovery reopens the same state');
  mode = 'missing';
  assert.deepEqual(await loadStartupState(options), {identity:'new-test-only'});
  assert.equal(created,1); assert.equal(writes,1);
});

test('initial persistence is a barrier; a failed save exposes no initialized state', async () => {
  let release;
  const pending = new Promise(r => { release = r; }); let done = false;
  const opts = { read:async()=>null, unseal:()=>assert.fail(), fresh:()=>({identity:'canary'}), persist:()=>pending };
  const load = loadStartupState(opts).then(v => {done=true;return v;});
  await new Promise(r=>setImmediate(r)); assert.equal(done,false);
  release(); assert.deepEqual(await load,{identity:'canary'});
  await assert.rejects(loadStartupState({...opts,persist:async()=>{throw Error('disk unavailable');}}),/disk unavailable/);
});
