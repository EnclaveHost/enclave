// The card check of a capacity check (network/proof-of-capacity-card.mjs): the work from the seeds, the Freivalds check
// of a row, the three requests between a checker and a host, each way a host fails, and the wire to a real worker
// (shielded/worker.py in its reference mode, no card: skipped where torch is not installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pad, toHex, keccak256, toBytes, recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {cardWeights, cardVector, cardFrame, softwareGemm, CardVerifier, createCardResponder, createCardCheck, softwareCardDriver, shieldedCardDriver,
  CARD_CHECK, CARD_CHECK_PATH, CARD_LIMITS} from '../network/proof-of-capacity-card.mjs';

const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
const domain = {chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'};
const A = pad(toHex(0xA1), {size: 32}), B = pad(toHex(0xB2), {size: 32}), C = pad(toHex(0xC3), {size: 32});
const seed = keccak256(toBytes('epoch seed')), run = keccak256(toBytes('run'));
const shape = {k: 64, n: 48, batch: 4};

test('the matrix and the vectors come from the seeds, inside the bounds that keep a product in the field', () => {
  const w = cardWeights(seed, 64, 48), x = cardVector(run, 3, 64);
  assert.equal(w.length, 64 * 48); assert.ok(w.every(v => v >= -119 && v <= 119)); assert.ok(new Set(w).size > 100);
  assert.ok(x.every(v => v >= -31 && v <= 31)); assert.ok(new Set(x).size > 20);
  assert.deepEqual(cardWeights(seed, 64, 48), w); assert.notDeepEqual(cardWeights(run, 64, 48), w);
  assert.notDeepEqual(cardVector(run, 4, 64), x);
  // a frame is the worker's planes int8[3][m][K]: the same small values in each of the three
  const f = cardFrame(run, 1, 4, 64);
  assert.equal(f.length, 3 * 4 * 64);
  for (let p = 0; p < 3; p++) for (let r = 0; r < 4; r++) assert.deepEqual([...new Int8Array(f.buffer, f.byteOffset + p * 256 + r * 64, 64)], [...cardVector(run, 4 + r, 64)]);
});

test('Freivalds accepts the product and refuses one changed element, one changed row and another vector\'s product', () => {
  const {k, n} = shape, w = cardWeights(seed, k, n), v = new CardVerifier(w, k, n);
  const y = softwareGemm(w, k, n, cardFrame(run, 0, 4, k), 4), row = i => y.subarray(i * n * 4, (i + 1) * n * 4);
  // the product, computed the slow way, for one element
  const x0 = cardVector(run, 0, k); let want = 0; for (let i = 0; i < k; i++) want += x0[i] * w[i * n + 7];
  assert.equal(row(0).readInt32LE(7 * 4), want);
  for (let i = 0; i < 4; i++) assert.equal(v.check(cardVector(run, i, k), row(i)), true);
  const lie = Buffer.from(row(1)); lie.writeInt32LE(lie.readInt32LE(20) + 1, 20);
  assert.equal(v.check(cardVector(run, 1, k), lie), false);
  assert.equal(v.check(cardVector(run, 1, k), row(2)), false);
  assert.equal(v.check(cardVector(run, 1, k), row(1).subarray(4)), false);
  // a secret the worker knew would be no check: two verifiers do not share one
  assert.notDeepEqual([...new CardVerifier(w, k, n).s[0]], [...v.s[0]]);
});

// two hosts and the contract's views as plain data; B sells one card
function network({open = softwareCardDriver(), cards = [{id: 0, endpoint: '10.0.2.2:9500'}], checkers = {[B]: [A]}} = {}) {
  const hosts = {};
  const reader = {epochNow: async () => 9n, seedOf: async () => seed, checkersOf: async (_e, t) => checkers[t] || []};
  for (const id of [A, B, C]) { const key = privateKeyToAccount(generatePrivateKey()); hosts[id] = {id, key, sign: m => key.signTypedData(m), endpoint: `https://${id.slice(-2)}.example`}; }
  const proofKeyOf = async id => hosts[id]?.key.address || null;
  hosts[B].card = createCardResponder({hostId: B, domain, reader, proofKeyOf, sign: hosts[B].sign, recover, cards: async () => cards, open});
  const log = [];
  const fetch = async (url, init) => {
    assert.equal(url, hosts[B].endpoint + CARD_CHECK_PATH);
    const body = JSON.parse(init.body); log.push(body.phase);
    if (hosts[B].status?.[body.phase]) return {ok: false, status: hosts[B].status[body.phase], json: async () => ({})};
    const r = await hosts[B].card(body), out = hosts[B].tamper ? hosts[B].tamper(body.phase, r.body) : r.body;
    return {ok: r.status === 200, status: r.status, json: async () => out};
  };
  const row = {endpoint: hosts[B].endpoint, proofKey: hosts[B].key.address};
  const check = (over = {}) => createCardCheck({host: A, domain, sign: hosts[A].sign, recover, fetch, ...shape, graceMs: 2000, ...over});
  return {hosts, fetch, row, check, log, reader, proofKeyOf};
}
const claim = (gmacPerSec = 0.001, share = 1) => ({cards: [{id: 0, gmacPerSec, share}]});
const ctx = (c = claim()) => ({epoch: 9, seed, claim: c});

test('a host that sells a card is asked for its advertised rate and passes with correct products in time', async () => {
  const n = network(), r = await n.check()(B, n.row, ctx());
  assert.equal(r.name, CARD_CHECK); assert.equal(r.ok, true, r.why);
  assert.deepEqual(n.log, ['prepare', 'run', 'open']);
  const e = r.evidence;
  // 0.001 G/s for 2 s = 2,000,000 products; one frame is 4 x 64 x 48 = 12,288: 163 frames
  assert.deepEqual({card: e.card, k: e.k, n: e.n, batch: e.batch, frames: e.frames, advertised: e.advertised}, {card: 0, ...shape, frames: 163, advertised: {gmacPerSec: 0.001, share: 1}});
  assert.equal(e.opened, 24); assert.match(e.root, /^0x[0-9a-f]{64}$/); assert.ok(e.allowMs >= 8000 && e.allowMs <= 8100, `allowed ${e.allowMs} ms`);
  // half the card free: half the work
  const n2 = network(), half = await n2.check()(B, n2.row, ctx(claim(0.001, 0.5)));
  assert.equal(half.ok, true); assert.equal(half.evidence.frames, 82);
  // a faster card than the cap covers is timed over the cap
  const n3 = network(), fast = await n3.check({maxFrames: 5})(B, n3.row, ctx(claim(50, 1)));
  assert.equal(fast.evidence.frames, 5);
});

test('no card advertised, or none of it free: not judged, and the host is not asked', async () => {
  const n = network();
  for (const [c, why] of [[{cards: []}, /advertises no card/], [{}, /advertises no card/], [undefined, /advertises no card/], [claim(0, 1), /advertises no card/], [claim(5, 0), /none of it is advertised as free/]]) {
    const r = await n.check()(B, n.row, {epoch: 9, seed, claim: c});
    assert.equal(r.ok, null); assert.match(r.why, why);
  }
  assert.deepEqual(n.log, []);
});

test('each way a host fails its card check', async () => {
  const fails = async (n, why, over = {}, c = claim()) => { const r = await n.check(over)(B, n.row, ctx(c)); assert.equal(r.ok, false, r.why); assert.match(r.why, why); return r; };
  // wrong products: the rows hash to what was committed, and are not the product
  let n = network({open: async o => { const card = await softwareCardDriver()(o); return {...card, gemm: async (p, m) => { const y = await card.gemm(p, m); for (let i = 0; i < y.length; i += 4) y.writeInt32LE(y.readInt32LE(i) ^ 1, i); return y; }}; }});
  await fails(n, /row \d+ is not the product/);
  // rows opened that are not the rows committed
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'open' ? {rows: Buffer.alloc(Buffer.from(body.rows, 'base64').length).toString('base64')} : body);
  await fails(n, /is not the row it committed to/);
  // digests that are not under the signed root, or not one per row
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'run' ? {...body, digests: Buffer.alloc(Buffer.from(body.digests, 'base64').length).toString('base64')} : body);
  await fails(n, /digests are not 652 rows under the signed root/);
  // another key's signature
  n = network(); n.row.proofKey = privateKeyToAccount(generatePrivateKey()).address;
  await fails(n, /not signed by the host's proof key/);
  // an answer for another run
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'run' ? {...body, run: keccak256(toBytes('other'))} : body);
  await fails(n, /not for this run/);
  // too slow for the rate it advertises: the clock is the checker's
  n = network(); const clock = [0, 9000];
  const r = await fails(n, /G\/s where 0\.00 G\/s is advertised as free/, {now: () => (clock.length > 1 ? clock.shift() : clock[0])});
  assert.equal(r.evidence.elapsedMs, 9000);
  // it advertises a card and does not answer for it; or refuses the checker
  n = network(); n.hosts[B].status = {prepare: 404};
  await fails(n, /advertised, and the host does not answer for it \(HTTP 404\)/);
  n = network({cards: []});
  await fails(n, /does not answer for it \(HTTP 404\)/);
  // with enforce off the same refusal is recorded and fails nobody
  n = network({cards: []});
  const soft = await n.check({enforce: false})(B, n.row, ctx());
  assert.equal(soft.ok, null); assert.match(soft.why, /^recorded, not enforced: card 0: advertised/);
});

test('"not now" from the host is not a verdict', async () => {
  for (const [phase, status] of [['prepare', 503], ['prepare', 429], ['run', 503], ['prepare', 409]]) {
    const n = network(); n.hosts[B].status = {[phase]: status};
    const r = await n.check()(B, n.row, ctx());
    assert.equal(r.ok, null); assert.match(r.why, new RegExp(`answered ${status} to ${phase}`));
  }
  // a card that does not take the work is the host saying 503
  const n = network({open: async () => { throw new Error('connect ECONNREFUSED 10.0.2.2:9500'); }});
  const r = await n.check()(B, n.row, ctx());
  assert.equal(r.ok, null); assert.match(r.why, /answered 503 to prepare/);
});

test('a host works its card only for a checker the contract assigned, once an epoch, one check at a time', async () => {
  const n = network(), card = n.hosts[B].card;
  const challenge = async (from, over = {}) => { const {cardChallengeMessage} = await import('../network/proof-of-capacity-card.mjs');
    const c = {phase: 'prepare', version: 1, epoch: 9, checker: from, target: B, seed, nonce: keccak256(toBytes('n' + Math.random())), card: 0, ...shape, frames: 2, ...over};
    c.signature = await n.hosts[over.signer || from].sign(cardChallengeMessage(domain, c)); return c; };
  assert.equal((await card(await challenge(C))).status, 403);                                   // not assigned
  assert.equal((await card(await challenge(A, {signer: C}))).status, 403);                      // not its signature
  assert.equal((await card(await challenge(A, {epoch: 8}))).status, 409);                       // not this epoch
  assert.equal((await card(await challenge(A, {card: 3}))).status, 404);                        // no such card
  assert.equal((await card({...(await challenge(A)), frames: CARD_LIMITS.frames + 1})).status, 400);
  assert.equal((await card({phase: 'run', epoch: 9, checker: A, nonce: seed, run})).status, 409);   // nothing prepared
  const c = await challenge(A);
  assert.deepEqual((await card(c)).body, {ready: true, device: 'software'});
  assert.deepEqual((await card(c)).body, {ready: true, device: 'software'});                    // the same challenge again
  assert.equal((await card(await challenge(A))).status, 503);                                   // another while one is open
  assert.equal((await card({phase: 'open', epoch: 9, checker: A, nonce: c.nonce, rows: [0]})).status, 409);   // before the run
  const ran = await card({phase: 'run', epoch: 9, checker: A, nonce: c.nonce, run});
  assert.equal(ran.status, 200); assert.equal(Buffer.from(ran.body.digests, 'base64').length, 8 * 32);
  assert.equal((await card({phase: 'run', epoch: 9, checker: A, nonce: c.nonce, run})).status, 409);          // one run
  assert.equal((await card({phase: 'open', epoch: 9, checker: A, nonce: c.nonce, rows: [0, 8]})).status, 400);   // a row that is not there (and the check ends)
  assert.equal((await card(await challenge(A))).status, 429);                                   // once per checker and epoch
  assert.equal((await card({phase: 'x'})).status, 400);
});

// ---- the wire: the worker a card runs, in its reference mode (the pre-encoded (N,K) form; exact, slow, no card) -----------
const worker = fileURLToPath(new URL('../shielded/worker.py', import.meta.url));
const torch = spawnSync('python3', ['-c', 'import torch, numpy'], {stdio: 'ignore'}).status === 0;
test('the driver speaks the worker\'s protocol: products from shielded/worker.py verify, and a full check passes over it', {skip: !torch && 'python3 with torch and numpy is not installed'}, async t => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const proc = spawn('python3', [worker, '--host', '127.0.0.1', '--port', String(port), '--device', 'cpu', '--vram-gb', '1'], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => proc.kill());
  await new Promise((resolve, reject) => {
    let out = ''; const seen = d => { out += d; if (/listening on/.test(out)) resolve(); };
    proc.stdout.on('data', seen); proc.stderr.on('data', seen); proc.once('exit', c => reject(new Error(`worker exited ${c}: ${out.slice(-300)}`)));
    setTimeout(() => reject(new Error('the worker did not start: ' + out.slice(-300))), 60000).unref();
  });
  const {k, n} = shape, w = cardWeights(seed, k, n), open = shieldedCardDriver({encoding: 'w'});
  const card = await open({endpoint: `127.0.0.1:${port}`, w, k, n, batch: 4});
  assert.match(card.device, /cpu/);
  const planes = cardFrame(run, 0, 4, k), y = await card.gemm(planes, 4);
  assert.deepEqual(y, softwareGemm(w, k, n, planes, 4));        // the worker's field product IS the integer product
  const v = new CardVerifier(w, k, n);
  for (let i = 0; i < 4; i++) assert.equal(v.check(cardVector(run, i, k), y.subarray(i * n * 4, (i + 1) * n * 4)), true);
  card.close();
  // and the whole check, the host driving that worker
  const net2 = network({open, cards: [{id: 0, endpoint: `127.0.0.1:${port}`}]});
  const r = await net2.check({maxFrames: 6, graceMs: 20000})(B, net2.row, ctx());
  assert.equal(r.ok, true, r.why); assert.match(r.evidence.root, /^0x/);
});

test('the driver refuses an endpoint that is not host:port and says when the worker is not there', async () => {
  const open = shieldedCardDriver({timeoutMs: 2000});
  await assert.rejects(open({endpoint: 'not an endpoint', w: new Int8Array(64), k: 32, n: 2, batch: 1}), /host:port/);
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await assert.rejects(open({endpoint: `127.0.0.1:${port}`, w: new Int8Array(64), k: 32, n: 2, batch: 1}), /ECONNREFUSED/);
  assert.throws(() => shieldedCardDriver({encoding: 'f32'}));
});

test('the production encoding: under the fp16 scale 1/256 the kernel\'s fixed weight is the quant itself', async () => {
  // metal/guest/shielded.mjs encodeWeightFixed is the one shared weight encoding (it mirrors the card's kernel operation
  // for operation). The driver's 'q8' form sends the matrix as quants with every block scale 0x1c00: the card then
  // multiplies by exactly the matrix the checker verifies against. (The kernel itself runs only on a card: not run here.)
  const {encodeWeightFixed, floatToHalf, halfToFloat} = await import('../metal/guest/shielded.mjs');
  assert.equal(floatToHalf(1 / 256), 0x1c00); assert.equal(halfToFloat(0x1c00), 1 / 256);
  for (let q = -119; q <= 119; q++) assert.equal(encodeWeightFixed(0x1c00, q), q);
  // and what the driver puts on the wire for it: the quants as they are, then K/32 x N scales of 0x1c00
  const sent = [], {k, n} = shape, w = cardWeights(seed, k, n);
  const server = net.createServer(sock => { let buf = Buffer.alloc(0), bid = 0;
    sock.on('data', d => { buf = Buffer.concat([buf, d]);
      while (buf.length >= 9 && buf.length >= 9 + Number(buf.readBigUInt64LE(1))) {
        const size = Number(buf.readBigUInt64LE(1)), cmd = buf[0], payload = buf.subarray(9, 9 + size); buf = buf.subarray(9 + size); sent.push([cmd, Buffer.from(payload)]);
        const reply = cmd === 0 ? Buffer.from(JSON.stringify({device: 'fake card'})) : cmd === 1 ? (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(++bid)); return b; })() : Buffer.from('{}');
        const h = Buffer.alloc(9); h.writeBigUInt64LE(BigInt(reply.length), 1); sock.write(Buffer.concat([h, reply]));
      } }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const card = await shieldedCardDriver()({endpoint: `127.0.0.1:${server.address().port}`, w, k, n, batch: 4});
    card.close();
    const sets = sent.filter(([cmd]) => cmd === 8).map(([, p]) => ({bid: Number(p.readBigUInt64LE(0)), off: Number(p.readBigUInt64LE(8)), data: p.subarray(24)}));
    assert.deepEqual([...new Int8Array(sets[0].data.buffer, sets[0].data.byteOffset, k * n)], [...w]);
    assert.equal(sets[1].off, Math.ceil(k * n / 64) * 64); assert.equal(sets[1].data.length, (k / 32) * n * 2);
    for (let i = 0; i < sets[1].data.length; i += 2) assert.equal(sets[1].data.readUInt16LE(i), 0x1c00);
    const graph = JSON.parse(sent.find(([cmd]) => cmd === 10)[1].toString());
    assert.deepEqual(Object.keys(graph.nodes[0]).sort(), ['K', 'N', 'id', 'max_m', 'op', 'wd', 'wq', 'x', 'y']);
    assert.deepEqual({K: graph.nodes[0].K, N: graph.nodes[0].N, max_m: graph.nodes[0].max_m, op: graph.nodes[0].op}, {K: k, N: n, max_m: 4, op: 'FIELD_GEMM'});
  } finally { server.close(); }
});
