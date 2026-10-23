// LeaseReader authority 'verifier': ONE deadline and ONE closure for each whole operation (agreed/verifiedRead, readAt,
// blockHashIs), including a caller callback that never settles. Real LeaseReader methods, driven by scripted in-process
// transports and a real loopback HTTP verifier; no chain, no network beyond 127.0.0.1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pad, toHex, parseAbi } from 'viem';
import { LeaseReader } from '../network/lease-reader.mjs';

const BOOK = '0x' + '33'.repeat(20), ADDR = '0x' + '44'.repeat(20);
const HASH = (n) => pad(toHex(BigInt(n) * 1000n + 1n), { size: 32 });
const T = { timeout: 5000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAL_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
// Keeps the event loop alive so that, on code WITHOUT a whole-operation deadline (the base-failure control), a
// never-settling read fails by its own 5 s test timeout instead of draining the loop and cancelling every later test.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

// A scripted in-process verifier. `hang` lists methods that never answer; every request records its AbortSignal.
function scripted({ hang = [], head = 100n } = {}) {
  const st = { calls: [], signals: [] };
  const verifier = {
    request: (method, params, _ms, signal) => {
      st.calls.push(method); st.signals.push(signal);
      if (hang.includes(method)) return new Promise(() => {});
      switch (method) {
        case 'eth_chainId': return Promise.resolve('0x2105');
        case 'eth_blockNumber': return Promise.resolve(toHex(head));
        case 'eth_getBlockByNumber': {
          const n = BigInt(params[0]);
          return Promise.resolve({ number: toHex(n), hash: HASH(n), stateRoot: pad('0x22', { size: 32 }), timestamp: toHex(Math.floor(Date.now() / 1000)) });
        }
        case 'eth_getStorageAt': return Promise.resolve(pad('0x2a', { size: 32 }));
        case 'eth_getBalance': return Promise.resolve('0x10');
        case 'eth_call': return Promise.resolve(pad('0x05', { size: 32 }));
        default: return Promise.reject(new Error('method not supported'));
      }
    },
  };
  return { st, verifier };
}
const reader = (verifier, opts = {}) => new LeaseReader({ authority: 'verifier', verifier, addressBook: BOOK, confirmations: 2, deadlineMs: 100, ...opts });
const sends = (st) => st.calls.length;

test('a callback that never settles is rejected at the deadline; reader state is untouched', T, async () => {
  const { st, verifier } = scripted();
  const r = reader(verifier), failures = [];
  const t0 = performance.now();
  await assert.rejects(r.agreed(() => new Promise(() => {}), failures), /no fresh verified chain state: .*deadline/);
  const took = performance.now() - t0;
  assert.ok(took >= 90 && took < 300, `rejected after ${Math.round(took)} ms (deadline 100 ms)`);
  assert.equal(r.lastBlock, 0n);
  assert.equal(r.lastEvidence, null);
  assert.equal(failures.length, 1);
  assert.ok(st.signals.every((s) => s?.aborted), 'every transport signal is aborted when the operation closes');
});

test('a callback that resolves after the deadline cannot answer, change state or send', T, async () => {
  const { st, verifier } = scripted();
  const r = reader(verifier);
  let late = null;
  const p = r.agreed(async (c) => {
    await sleep(250);
    late = await c.getStorageAt({ address: ADDR, slot: '0x0' }).then(() => 'sent', (e) => e.message);
    return { ok: true };
  });
  await assert.rejects(p, /deadline/);
  const before = sends(st);
  await sleep(350);
  assert.match(late, /closed|deadline/);
  assert.equal(sends(st), before, 'the late attempt sends nothing');
  assert.equal(r.lastBlock, 0n);
  assert.equal(r.lastEvidence, null);
});

test('a hung RPC inside the callback is bounded and its transport signal is aborted', T, async () => {
  const { st, verifier } = scripted({ hang: ['eth_getBalance'] });
  const r = reader(verifier);
  const t0 = performance.now();
  await assert.rejects(r.agreed(async (c) => ({ v: String(await c.getBalance({ address: ADDR })) })), /deadline|timed out/);
  assert.ok(performance.now() - t0 < 300);
  const i = st.calls.indexOf('eth_getBalance');
  assert.ok(i >= 0 && st.signals[i].aborted, 'the hung request was told to abort');
});

test('retained clients cannot send after success, failure or timeout', T, async () => {
  for (const outcome of ['success', 'failure', 'timeout']) {
    const { st, verifier } = scripted();
    const r = reader(verifier);
    let kept;
    const p = r.agreed(async (c) => {
      kept = c;
      if (outcome === 'failure') throw new Error('callback failed');
      if (outcome === 'timeout') return new Promise(() => {});
      return { ok: true };
    });
    if (outcome === 'success') assert.equal((await p).ok, true); else await assert.rejects(p);
    const before = sends(st);
    await assert.rejects(kept.getStorageAt({ address: ADDR, slot: '0x0' }), /closed|deadline/, outcome);
    await assert.rejects(kept.readContract({ address: ADDR, abi: BAL_ABI, functionName: 'balanceOf', args: [ADDR] }), /closed|deadline/, outcome);
    await sleep(5);
    assert.equal(sends(st), before, `${outcome}: retained client sent nothing`);
  }
});

test('the deadline is re-checked when the transport is actually invoked, not only when the request is queued', T, async () => {
  const { st, verifier } = scripted();
  const r = reader(verifier);
  let queued;
  const p = r.agreed((c) => {
    queued = c.getStorageAt({ address: ADDR, slot: '0x0' }).then(() => 'sent', (e) => e.message);
    const until = performance.now() + 130;   // block the event loop past the 100 ms deadline before the microtask runs
    while (performance.now() < until) { /* busy */ }
    return { ok: true };
  });
  await assert.rejects(p, /deadline/);
  assert.match(await queued, /deadline|closed/);
  assert.equal(st.calls.filter((m) => m === 'eth_getStorageAt').length, 0, 'the expired request never reached the transport');
});

test('normal completion: callback-created pending requests are aborted, no timers stay behind', T, async () => {
  const { st, verifier } = scripted({ hang: ['eth_getBalance'] });
  const r = reader(verifier, { deadlineMs: 2000 });
  const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const base = timeouts();
  let orphan;
  const out = await r.agreed(async (c) => {
    orphan = c.getBalance({ address: ADDR }).then(() => 'answered', (e) => e.message);   // never awaited by the callback
    return { v: (await c.getStorageAt({ address: ADDR, slot: '0x0' })).slice(0, 4) };
  });
  assert.equal(out.v, '0x00');
  assert.match(await orphan, /closed|finished/);
  const i = st.calls.indexOf('eth_getBalance');
  assert.ok(st.signals[i].aborted, 'the orphaned request was aborted at completion');
  await sleep(0);
  assert.equal(timeouts(), base, 'no per-request or deadline timer outlives the operation');
  assert.equal(r.lastEvidence.tier, 'unsafe');
});

test('readAt (history) is bounded and closed the same way, and never becomes fresh authority', T, async () => {
  const { st, verifier } = scripted();
  const r = reader(verifier);
  const t0 = performance.now();
  await assert.rejects(r.readAt({ blockNumber: 98n, blockHash: HASH(98) }, () => new Promise(() => {})), /deadline/);
  assert.ok(performance.now() - t0 < 300);
  let kept;
  const v = await r.readAt({ blockNumber: 98n, blockHash: HASH(98) }, async (c) => { kept = c; return { s: await c.getStorageAt({ address: ADDR, slot: '0x1' }) }; });
  assert.ok(v.s);
  const before = sends(st);
  await assert.rejects(kept.getBalance({ address: ADDR }), /closed/);
  assert.equal(sends(st), before);
  assert.equal(r.lastBlock, 0n, 'a history read does not move the accepted block');
  assert.equal(r.lastEvidence, null, 'a history read is not fresh evidence');
  await assert.rejects(r.readAt({ blockNumber: 98n, blockHash: HASH(97) }, () => ({})), /no longer canonical/);
});

test('blockHashIs: true/false as before, a hung verifier answers false within the deadline and is aborted', T, async () => {
  const ok = scripted();
  assert.equal(await reader(ok.verifier).blockHashIs(98n, HASH(98)), true);
  assert.equal(await reader(ok.verifier).blockHashIs(98n, HASH(97)), false);
  const hung = scripted({ hang: ['eth_getBlockByNumber'] });
  const t0 = performance.now();
  assert.equal(await reader(hung.verifier).blockHashIs(98n, HASH(98)), false);
  assert.ok(performance.now() - t0 < 300);
  assert.ok(hung.st.signals[0].aborted);
});

test('the loopback HTTP verifier: a hung request is cancelled on the wire at the deadline', T, async () => {
  const closedAt = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method === 'eth_chainId') return reply('0x2105');
      if (method === 'eth_blockNumber') return reply('0x64');
      if (method === 'eth_getBlockByNumber') return reply({ number: params[0], hash: HASH(BigInt(params[0])), stateRoot: pad('0x22', { size: 32 }), timestamp: toHex(Math.floor(Date.now() / 1000)) });
      res.on('close', () => { if (!res.writableEnded) closedAt.push(performance.now()); });   // eth_call: never answered
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = new LeaseReader({ authority: 'verifier', verifier: `http://127.0.0.1:${server.address().port}/`, addressBook: BOOK, confirmations: 2, deadlineMs: 200 });
    const t0 = performance.now();
    await assert.rejects(r.agreed(async (c) => ({ v: String(await c.readContract({ address: ADDR, abi: BAL_ABI, functionName: 'balanceOf', args: [ADDR] })) })), /deadline|timed out/);
    await sleep(100);
    assert.equal(closedAt.length, 1, 'the server saw the hung request aborted');
    assert.ok(closedAt[0] - t0 < 400, `aborted ${Math.round(closedAt[0] - t0)} ms after start (deadline 200 ms)`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('the deadline fires even when nothing else keeps the process alive (child process, no keep-alive)', T, async () => {
  const { spawnSync } = await import('node:child_process');
  const src = `import { LeaseReader } from ${JSON.stringify(new URL('../network/lease-reader.mjs', import.meta.url).href)};
    const ts = '0x' + Math.floor(Date.now() / 1000).toString(16), h = '0x' + '11'.repeat(32);
    const verifier = { request: async (m, p) => m === 'eth_chainId' ? '0x2105' : m === 'eth_blockNumber' ? '0x64'
      : { number: p[0], hash: h, stateRoot: h, timestamp: ts } };
    const r = new LeaseReader({ authority: 'verifier', verifier, addressBook: '0x' + '33'.repeat(20), deadlineMs: 100 });
    try { await r.agreed(() => new Promise(() => {})); console.log('resolved'); } catch (e) { console.log('rejected: ' + e.message); }`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 4000 });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^rejected: no fresh verified chain state: .*deadline of 100 ms has passed/);
});

test('policy is unchanged: the deadline bound and legacy quorum construction', () => {
  const { verifier } = scripted();
  assert.throws(() => reader(verifier, { deadlineMs: 99 }), /invalid chain policy/);
  assert.throws(() => reader(verifier, { deadlineMs: 300001 }), /invalid chain policy/);
  assert.equal(reader(verifier, { deadlineMs: 300000 }).deadlineMs, 300000);
});
