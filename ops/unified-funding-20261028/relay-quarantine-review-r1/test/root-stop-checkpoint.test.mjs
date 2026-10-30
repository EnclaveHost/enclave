// Root tests: actual hash-pinned JsonStore and owned child processes, no RPC/signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const STORE = fileURLToPath(new URL('../../../source/relay/store.js', import.meta.url));
const RELAY = fileURLToPath(new URL('../generated/relay/sessions.mjs', import.meta.url));
const EXPECTED = '12157d8ccf8b1ec4ffd4d0af9b5b846650ec20aac748bcc51ad087e119922dcd';

async function run(t, mode) {
  assert.equal(createHash('sha256').update(readFileSync(STORE)).digest('hex'), EXPECTED);
  const dir = mkdtempSync(join(tmpdir(), 'funding-stop-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = join(dir, 'sessions-relayer.json');
  const seed = JSON.stringify({ txs: [] });
  writeFileSync(journal, seed);
  const childFile = join(dir, 'child.mjs');
  writeFileSync(childFile, `
    import {JsonStore} from ${JSON.stringify(STORE)};
    const journal = new JsonStore(${JSON.stringify(journal)}, {txs:[]}, {durable:true});
    const mode = ${JSON.stringify(mode)};
    if (mode === 'quarantine') {
      const {createSessionsService} = await import(${JSON.stringify(RELAY)});
      createSessionsService({pc:{},wc:{chain:{id:8453}},account:{address:'0x3333333333333333333333333333333333333333'},
        chainId:8453,factory:'0x4444444444444444444444444444444444444444',
        store:{data:{},flush(){},saveSoon(){}}, journal, log(){},alert(){}});
    }
    journal.data.txs.push({nonce:94,status:'sending',hashes:[],label:'PUBLIC TEST ONLY'});
    if (mode === 'flush-failure') journal.file = ${JSON.stringify(join(dir, 'missing', 'unwritable.json'))};
    process.send({ready:true,dirty:journal.dirty});
    setInterval(()=>{},1000);
  `);
  const child = fork(childFile, [], { stdio: ['ignore','pipe','pipe','ipc'],
    env: {...process.env, SESSIONS_WRITE_QUARANTINE: mode === 'quarantine' ? '1' : '0'} });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => clearTimeout(timeout));
  const ready = await Promise.race([
    once(child, 'message').then(([m]) => m),
    once(child, 'exit').then(([code]) => { throw new Error(`early exit ${code}: ${stderr}`); }),
  ]);
  assert.deepEqual(ready, {ready:true,dirty:false});
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await ended;
  assert.equal(code, 0, stderr); assert.equal(signal, null);
  return { data: JSON.parse(readFileSync(journal, 'utf8')), unchanged: readFileSync(journal,'utf8') === seed };
}

test('actual old JsonStore SIGTERM persists a memory-only sending record even when dirty=false', async t => {
  const r = await run(t, 'normal');
  assert.equal(r.data.txs.length, 1);
  assert.deepEqual(r.data.txs[0].hashes, []);
  assert.equal(r.data.txs[0].status, 'sending');
});
test('actual JsonStore clean exit alone does not prove checkpoint success: flush failure is swallowed', async t => {
  assert.equal((await run(t, 'flush-failure')).unchanged, true);
});
test('quarantined successor preserves the actual JsonStore journal on SIGTERM', async t => {
  assert.equal((await run(t, 'quarantine')).unchanged, true);
});
