// The card check of a capacity check (network/proof-of-capacity-card.mjs): the work from the seeds, the Freivalds check
// of a row, the commitment, the three requests between a checker and a host, each way a host fails, and the wire to a
// real worker (shielded/worker.py in its reference mode, no card: skipped where torch is not installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pad, toHex, keccak256, toBytes, recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {cardWeights, cardVector, cardPad, cardStart, chainStep, softwareGemm, CardVerifier, merkleLevels, merkleProof, merkleRoot, createCardResponder, createCardCheck,
  softwareCardDriver, shieldedCardDriver, cardChallengeMessage, CARD_CHECK, CARD_CHECK_PATH, CARD_LIMITS} from '../network/proof-of-capacity-card.mjs';

const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
const domain = {chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'};
const A = pad(toHex(0xA1), {size: 32}), B = pad(toHex(0xB2), {size: 32}), C = pad(toHex(0xC3), {size: 32});
const seed = keccak256(toBytes('epoch seed')), run = keccak256(toBytes('run'));
const shape = {k: 64, batch: 4, stride: 4};
const sha = b => createHash('sha256').update(b).digest();

test('the matrix, the rows and the pads come from the seeds, inside the bounds that keep a product in the field', () => {
  const w = cardWeights(seed, 64, 64), x = cardVector(run, 3, 64), p = cardPad(run, 3, 64);
  assert.equal(w.length, 64 * 64); assert.ok(w.every(v => v >= -119 && v <= 119)); assert.ok(new Set(w).size > 100);
  assert.ok(x.every(v => v >= -31 && v <= 31)); assert.ok(new Set(x).size > 20);
  assert.ok(p.every(v => v >= 0 && v <= 62)); assert.ok(new Set(p).size > 20);
  assert.deepEqual(cardWeights(seed, 64, 64), w); assert.notDeepEqual(cardWeights(run, 64, 64), w);
  assert.notDeepEqual(cardVector(run, 4, 64), x); assert.notDeepEqual([...cardPad(run, 4, 64)], [...p]);
  // a run's start as the worker takes it: the rows one after another, then their pads
  const s = cardStart(run, 4, 64);
  assert.equal(s.x.length, 4 * 64); assert.equal(s.pad.length, 4 * 64);
  for (let r = 0; r < 4; r++) { assert.deepEqual([...new Int8Array(s.x.buffer, s.x.byteOffset + r * 64, 64)], [...cardVector(run, r, 64)]); assert.deepEqual([...s.pad.subarray(r * 64, r * 64 + 64)], [...cardPad(run, r, 64)]); }
  // the step between two products keeps a row in [-31, 31] whatever the product, and the pad moves it
  const y = Buffer.alloc(64 * 4); for (let j = 0; j < 64; j++) y.writeInt32LE((j - 32) * 100003, j * 4);
  const next = chainStep(y, p, 64);
  assert.ok(next.every(v => v >= -31 && v <= 31));
  for (const j of [0, 31, 32, 63]) assert.equal(next[j], ((((j - 32) * 100003 + p[j]) % 63) + 63) % 63 - 31);
  assert.notDeepEqual([...chainStep(y, cardPad(run, 4, 64), 64)], [...next]);
});

test('Freivalds accepts the product and refuses one changed element, one changed row and another vector\'s product', () => {
  const k = 64, n = 48, w = cardWeights(seed, k, n), v = new CardVerifier(w, k, n);
  const y = softwareGemm(w, k, n, cardStart(run, 4, k).x, 4), row = i => y.subarray(i * n * 4, (i + 1) * n * 4);
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

test('the commitment: every leaf proves to the one root, and no other leaf, place or count does', () => {
  for (const count of [1, 2, 3, 5, 8, 13, 64]) {
    const leaves = Buffer.concat(Array.from({length: count}, (_, i) => sha(Buffer.from('leaf ' + i)))), levels = merkleLevels(leaves), root = levels.at(-1)[0];
    for (let i = 0; i < count; i++) {
      const leaf = leaves.subarray(i * 32, i * 32 + 32), proof = merkleProof(levels, i);
      assert.ok(merkleRoot(leaf, i, count, proof).equals(root), `leaf ${i} of ${count}`);
      assert.ok(!merkleRoot(sha(leaf), i, count, proof)?.equals(root));
      if (count > 1) { assert.ok(!merkleRoot(leaf, (i + 1) % count, count, proof)?.equals(root)); assert.ok(!merkleRoot(leaf, i, count, proof.subarray(32))?.equals(root)); }
      assert.equal(merkleRoot(leaf, i, count, Buffer.concat([proof, leaf])), null);
    }
    assert.equal(merkleRoot(leaves.subarray(0, 32), count, count, Buffer.alloc(0)), null);
  }
});

test('the chain in software is the products fed back: each kept row is the step of the product of the row before', async () => {
  const k = 64, w = cardWeights(seed, k, k), start = cardStart(run, 4, k), card = await softwareCardDriver()({w, k, batch: 4});
  const digests = await card.chain(start.x, start.pad, 6, 2);
  assert.equal(digests.length, 3 * 4 * 32);
  let cur = start.x;
  for (let t = 1; t <= 6; t++) {
    const y = softwareGemm(w, k, k, cur, 4);
    cur = Buffer.concat(Array.from({length: 4}, (_, r) => Buffer.from(chainStep(y.subarray(r * k * 4, (r + 1) * k * 4), start.pad.subarray(r * k, (r + 1) * k), k).buffer)));
    if (t % 2 === 0) { const c = t / 2 - 1; assert.deepEqual(await card.state(c), cur);
      for (let r = 0; r < 4; r++) assert.deepEqual(digests.subarray((c * 4 + r) * 32, (c * 4 + r + 1) * 32), sha(cur.subarray(r * k, (r + 1) * k))); }
  }
  // another pad, another chain from the first step on
  assert.notDeepEqual((await (await softwareCardDriver()({w, k, batch: 4})).chain(start.x, cardStart(seed, 4, k).pad, 6, 2)).subarray(0, 32), digests.subarray(0, 32));
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
// one round here is 4 x 64 x 64 = 16,384 products
const claim = (gmacPerSec = 0.0001, share = 1) => ({cards: [{id: 0, gmacPerSec, share}]});
const ctx = (c = claim()) => ({epoch: 9, seed, claim: c});

test('a host that sells a card is asked for its advertised rate and passes with a correct chain in time', async () => {
  const n = network(), r = await n.check()(B, n.row, ctx());
  assert.equal(r.name, CARD_CHECK); assert.equal(r.ok, true, r.why);
  assert.deepEqual(n.log, ['prepare', 'run', 'open']);
  const e = r.evidence;
  // 0.0001 G/s for 4 s = 400,000 products = 24.4 rounds: 7 stretches of 4, 28 rounds
  assert.deepEqual({card: e.card, k: e.k, batch: e.batch, rounds: e.rounds, stride: e.stride, advertised: e.advertised}, {card: 0, ...shape, rounds: 28, advertised: {gmacPerSec: 0.0001, share: 1}});
  assert.equal(e.opened, 24); assert.match(e.root, /^0x[0-9a-f]{64}$/);
  // the allowance: 1.5 x the 4.59 s the advertised rate takes for it, and the grace; what that holds the host to is in the record
  assert.ok(e.allowMs >= 8880 && e.allowMs <= 8890, `allowed ${e.allowMs} ms`);
  assert.ok(Math.abs(e.enforcedGmacPerSec - 28 * 16384 / 1e9 / e.allowMs * 1000) < 1e-8); assert.ok(e.enforcedGmacPerSec > 0.5 * 0.0001);
  // half the card free: half the work
  const n2 = network(), half = await n2.check()(B, n2.row, ctx(claim(0.0001, 0.5)));
  assert.equal(half.ok, true); assert.equal(half.evidence.rounds, 16);
  // a faster card than the cap covers is timed over the cap
  const n3 = network(), fast = await n3.check({maxCommits: 3})(B, n3.row, ctx(claim(50, 1)));
  assert.equal(fast.ok, true, fast.why); assert.equal(fast.evidence.rounds, 12); assert.equal(fast.evidence.opened, 12);
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
  const cardWith = change => async o => { const card = await softwareCardDriver()(o); return {...card, ...change(card)}; };
  // wrong products shown for a stretch: it starts where it should, and a row is not the product
  let n = network({open: cardWith(card => ({gemm: async (rows, m) => { const y = await card.gemm(rows, m); for (let i = 0; i < y.length; i += 4) y.writeInt32LE(y.readInt32LE(i) ^ 1, i); return y; }}))});
  await fails(n, /step 0: the row is not the product/);
  // digests made up instead of worked: no stretch joins the states it committed to
  n = network({open: cardWith(card => ({chain: async (...a) => { const d = await card.chain(...a); return Buffer.from(d.map((v, i) => v ^ (i % 32 === 0 ? 1 : 0))); }}))});
  await fails(n, /does not (start|end) at the state it committed to/);
  // a chain worked before the run was known (its pads are not the run's): every stretch ends somewhere else
  n = network({open: cardWith(card => ({chain: (x, pad, ...a) => card.chain(x, Buffer.alloc(pad.length), ...a)}))});
  await fails(n, /does not end at the state it committed to/);
  // a stretch that starts from rows of the host's own choosing
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'open' ? {stretches: body.stretches.map(v => ({...v, x: Buffer.alloc(64, 1).toString('base64')}))} : body);
  await fails(n, /does not start at the state it committed to/);
  // a stretch not shown whole, or not all of them
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'open' ? {stretches: body.stretches.map(v => ({...v, ys: v.ys.slice(0, 64)}))} : body);
  await fails(n, /was not shown whole/);
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'open' ? {stretches: body.stretches.slice(1)} : body);
  await fails(n, /the work was not shown \(HTTP 200\)/);
  // another key's signature
  n = network(); n.row.proofKey = privateKeyToAccount(generatePrivateKey()).address;
  await fails(n, /not signed by the host's proof key/);
  // an answer for another run, or another root than the one signed
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'run' ? {...body, run: keccak256(toBytes('other'))} : body);
  await fails(n, /not for this run/);
  n = network(); n.hosts[B].tamper = (phase, body) => (phase === 'run' ? {...body, root: keccak256(toBytes('other'))} : body);
  await fails(n, /not signed by the host's proof key/);
  // too slow for the rate it advertises: the clock is the checker's
  n = network(); const clock = [0, 9000];
  const r = await fails(n, /G\/s where 0\.00 G\/s is advertised as free/, {now: () => (clock.length > 1 ? clock.shift() : clock[0])});
  assert.equal(r.evidence.elapsedMs, 9000);
  // it advertises a card and does not answer for it; or refuses the checker
  n = network(); n.hosts[B].status = {prepare: 404};
  await fails(n, /advertised, and the host does not answer for it \(HTTP 404\)/);
  n = network({cards: []});
  await fails(n, /does not answer for it \(HTTP 404\)/);
  // its worker predates the check: the card cannot show its rate
  n = network({open: async () => { throw Object.assign(new Error('the card worker has no FIELD_CHAIN (protocol 1.5)'), {code: 'UNSUPPORTED'}); }});
  await fails(n, /the host's worker cannot run the check \(HTTP 501\)/);
  // with enforce off the same refusal is recorded and fails nobody
  n = network({cards: []});
  const soft = await n.check({enforce: false})(B, n.row, ctx());
  assert.equal(soft.ok, null); assert.match(soft.why, /^recorded, not enforced: card 0: advertised/);
});

test('the clock holds a card to its rate: the same honest work passes at its own rate and fails at ten times it', async () => {
  // a card that makes 0.0001 G products a second: every chain takes it rounds x 16,384 / 100,000 seconds, on the checker's clock
  const real = 0.0001; let t = 0, took = 0;
  const open = async o => { const card = await softwareCardDriver()(o); return {...card, chain: async (x, p, rounds, stride) => { took = rounds * 16384 / 1e9 / real * 1000; return card.chain(x, p, rounds, stride); }}; };
  const timed = n => { const inner = n.fetch; return async (url, init) => { const r = await inner(url, init); if (JSON.parse(init.body).phase === 'run') t += took; return r; }; };
  for (const [advertised, ok] of [[1, true], [2, true], [2.2, false], [10, false]]) {
    const n = network({open}), fetch = timed(n);
    const r = await createCardCheck({host: A, domain, sign: n.hosts[A].sign, recover, fetch, ...shape, now: () => t})(B, n.row, ctx(claim(real * advertised)));
    assert.equal(r.ok, ok, `advertising ${advertised}x: ${r.why}`);
    // what the record says the clock enforced is what decided it
    assert.equal(r.evidence.gmacPerSec >= r.evidence.enforcedGmacPerSec, ok);
    assert.ok(r.evidence.enforcedGmacPerSec > 0.45 * real * advertised && r.evidence.enforcedGmacPerSec < 0.5 * real * advertised);
  }
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
  const challenge = async (from, over = {}) => {
    const c = {phase: 'prepare', version: 2, epoch: 9, checker: from, target: B, seed, nonce: keccak256(toBytes('n' + Math.random())), card: 0, ...shape, rounds: 8, ...over};
    c.signature = await n.hosts[over.signer || from].sign(cardChallengeMessage(domain, c)); return c; };
  assert.equal((await card(await challenge(C))).status, 403);                                   // not assigned
  assert.equal((await card(await challenge(A, {signer: C}))).status, 403);                      // not its signature
  assert.equal((await card(await challenge(A, {epoch: 8}))).status, 409);                       // not this epoch
  assert.equal((await card(await challenge(A, {card: 3}))).status, 404);                        // no such card
  for (const bad of [{stride: CARD_LIMITS.stride + 1}, {rounds: 6}, {rounds: 0}, {rounds: (CARD_LIMITS.commits + 1) * 4}, {k: 48}, {batch: 0}, {version: 1}])
    assert.equal((await card({...(await challenge(A)), ...bad})).status, 400, JSON.stringify(bad));
  assert.equal((await card({phase: 'run', epoch: 9, checker: A, nonce: seed, run})).status, 409);   // nothing prepared
  const c = await challenge(A);
  assert.deepEqual((await card(c)).body, {ready: true, device: 'software'});
  assert.deepEqual((await card(c)).body, {ready: true, device: 'software'});                    // the same challenge again
  assert.equal((await card(await challenge(A))).status, 503);                                   // another while one is open
  assert.equal((await card({phase: 'open', epoch: 9, checker: A, nonce: c.nonce, stretches: [0]})).status, 409);   // before the run
  const ran = await card({phase: 'run', epoch: 9, checker: A, nonce: c.nonce, run});
  // only the signed root crosses: nothing of the rows
  assert.equal(ran.status, 200); assert.deepEqual(Object.keys(ran.body).sort(), ['checker', 'epoch', 'nonce', 'root', 'run', 'signature', 'target', 'version']);
  assert.equal((await card({phase: 'run', epoch: 9, checker: A, nonce: c.nonce, run})).status, 409);          // one run
  assert.equal((await card({phase: 'open', epoch: 9, checker: A, nonce: c.nonce, stretches: [0, 8]})).status, 400);   // a stretch that is not there (and the check ends)
  assert.equal((await card(await challenge(A))).status, 429);                                   // once per checker and epoch
  assert.equal((await card({phase: 'x'})).status, 400);
});

// ---- the wire: the worker a card runs, in its reference mode (the pre-encoded (N,K) form; exact, slow, no card) -----------
const worker = fileURLToPath(new URL('../shielded/worker.py', import.meta.url));
const torch = spawnSync('python3', ['-c', 'import torch, numpy'], {stdio: 'ignore'}).status === 0;
test('the driver speaks the worker\'s protocol: the chain shielded/worker.py works is the chain, and a full check passes over it', {skip: !torch && 'python3 with torch and numpy is not installed'}, async t => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const proc = spawn('python3', [worker, '--host', '127.0.0.1', '--port', String(port), '--device', 'cpu', '--vram-gb', '1'], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => proc.kill());
  await new Promise((resolve, reject) => {
    let out = ''; const seen = d => { out += d; if (/listening on/.test(out)) resolve(); };
    proc.stdout.on('data', seen); proc.stderr.on('data', seen); proc.once('exit', c => reject(new Error(`worker exited ${c}: ${out.slice(-300)}`)));
    setTimeout(() => reject(new Error('the worker did not start: ' + out.slice(-300))), 60000).unref();
  });
  const k = 64, w = cardWeights(seed, k, k), open = shieldedCardDriver({encoding: 'w'}), start = cardStart(run, 4, k);
  const card = await open({endpoint: `127.0.0.1:${port}`, w, k, batch: 4, commits: 3});
  assert.match(card.device, /cpu/);
  const y = await card.gemm(start.x, 4);
  assert.deepEqual(y, softwareGemm(w, k, k, start.x, 4));        // the worker's field product IS the integer product
  // the worker's chain, digest for digest and kept state for kept state, is the one worked here
  const soft = await softwareCardDriver()({w, k, batch: 4}), digests = await card.chain(start.x, start.pad, 12, 4);
  assert.deepEqual(digests, await soft.chain(start.x, start.pad, 12, 4));
  for (let c = 0; c < 3; c++) assert.deepEqual(await card.state(c), await soft.state(c));
  // the worker lets nothing else be read back, and refuses a chain past what was installed
  await assert.rejects(card.chain(start.x, start.pad, 16, 4), /installed shape/);
  card.close();
  const other = await open({endpoint: `127.0.0.1:${port}`, w, k, batch: 4, commits: 1});
  await assert.rejects(other.state(1), /refused/);
  other.close();
  // and the whole check, the host driving that worker
  const net2 = network({open, cards: [{id: 0, endpoint: `127.0.0.1:${port}`}]});
  const r = await net2.check({maxCommits: 3, graceMs: 20000})(B, net2.row, ctx());
  assert.equal(r.ok, true, r.why); assert.match(r.evidence.root, /^0x/); assert.equal(r.evidence.opened, 12);
});

test('the driver refuses an endpoint that is not host:port, says when the worker is not there, and refuses a worker without the chain', async () => {
  const open = shieldedCardDriver({timeoutMs: 2000});
  await assert.rejects(open({endpoint: 'not an endpoint', w: new Int8Array(1024), k: 32, batch: 1}), /host:port/);
  const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await assert.rejects(open({endpoint: `127.0.0.1:${port}`, w: new Int8Array(1024), k: 32, batch: 1}), /ECONNREFUSED/);
  assert.throws(() => shieldedCardDriver({encoding: 'f32'}));
  // a worker at protocol 1.4: its HELLO names no FIELD_CHAIN
  const old = net.createServer(sock => sock.once('data', () => { const reply = Buffer.from(JSON.stringify({version: [1, 4, 0], device: 'old card'})), h = Buffer.alloc(9); h.writeBigUInt64LE(BigInt(reply.length), 1); sock.write(Buffer.concat([h, reply])); }));
  await new Promise(r => old.listen(0, '127.0.0.1', r));
  try { await assert.rejects(open({endpoint: `127.0.0.1:${old.address().port}`, w: new Int8Array(1024), k: 32, batch: 1}), e => e.code === 'UNSUPPORTED' && /FIELD_CHAIN/.test(e.message)); }
  finally { old.close(); }
});

test('the production encoding: under the fp16 scale 1/256 the kernel\'s fixed weight is the quant itself', async () => {
  // metal/guest/shielded.mjs encodeWeightFixed is the one shared weight encoding (it mirrors the card's kernel operation
  // for operation). The driver's 'q8' form sends the matrix as quants with every block scale 0x1c00: the card then
  // multiplies by exactly the matrix the checker verifies against. (The kernel itself runs only on a card: not run here.)
  const {encodeWeightFixed, floatToHalf, halfToFloat} = await import('../metal/guest/shielded.mjs');
  assert.equal(floatToHalf(1 / 256), 0x1c00); assert.equal(halfToFloat(0x1c00), 1 / 256);
  for (let q = -119; q <= 119; q++) assert.equal(encodeWeightFixed(0x1c00, q), q);
  // and what the driver puts on the wire for it: the quants as they are, then K/32 x N scales of 0x1c00
  const sent = [], k = 64, n = 64, w = cardWeights(seed, k, n);
  const server = net.createServer(sock => { let buf = Buffer.alloc(0), bid = 0;
    sock.on('data', d => { buf = Buffer.concat([buf, d]);
      while (buf.length >= 9 && buf.length >= 9 + Number(buf.readBigUInt64LE(1))) {
        const size = Number(buf.readBigUInt64LE(1)), cmd = buf[0], payload = buf.subarray(9, 9 + size); buf = buf.subarray(9 + size); sent.push([cmd, Buffer.from(payload)]);
        const reply = cmd === 0 ? Buffer.from(JSON.stringify({device: 'fake card', field_chain: 1})) : cmd === 1 ? (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(++bid)); return b; })()
          : cmd === 16 ? Buffer.alloc(2 * 4 * 32) : Buffer.from('{}');
        const h = Buffer.alloc(9); h.writeBigUInt64LE(BigInt(reply.length), 1); sock.write(Buffer.concat([h, reply]));
      } }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const card = await shieldedCardDriver()({endpoint: `127.0.0.1:${server.address().port}`, w, k, batch: 4, commits: 2});
    const start = cardStart(run, 4, k); await card.chain(start.x, start.pad, 8, 4);
    card.close();
    const sets = sent.filter(([cmd]) => cmd === 8).map(([, p]) => ({bid: Number(p.readBigUInt64LE(0)), off: Number(p.readBigUInt64LE(8)), data: p.subarray(24)}));
    assert.deepEqual([...new Int8Array(sets[0].data.buffer, sets[0].data.byteOffset, k * n)], [...w]);
    assert.equal(sets[1].off, Math.ceil(k * n / 64) * 64); assert.equal(sets[1].data.length, (k / 32) * n * 2);
    for (let i = 0; i < sets[1].data.length; i += 2) assert.equal(sets[1].data.readUInt16LE(i), 0x1c00);
    const graph = JSON.parse(sent.find(([cmd]) => cmd === 10)[1].toString());
    assert.deepEqual(Object.keys(graph.nodes[0]).sort(), ['K', 'N', 'id', 'max_m', 'op', 'wd', 'wq', 'x', 'y']);
    assert.deepEqual({K: graph.nodes[0].K, N: graph.nodes[0].N, max_m: graph.nodes[0].max_m, op: graph.nodes[0].op}, {K: k, N: n, max_m: 4, op: 'FIELD_GEMM'});
    // the kept states are declared outputs, one each, after the node's own planes and products; the chain names that region
    const state = 4 * k, tAt = Math.ceil((Math.ceil(3 * state / 64) * 64 + 4 * n * 4) / 64) * 64;
    assert.deepEqual(graph.outputs.slice(1), [{bid: 2, offset: tAt, nbytes: state}, {bid: 2, offset: tAt + state, nbytes: state}]);
    const chain = sent.find(([cmd]) => cmd === 16)[1];
    assert.deepEqual([chain.readUInt32LE(0), chain.readUInt32LE(4), chain.readUInt32LE(8), chain.readUInt32LE(12), Number(chain.readBigUInt64LE(16)), Number(chain.readBigUInt64LE(24))], [0, 4, 8, 4, 2, tAt]);
    assert.deepEqual(chain.subarray(32, 32 + state), start.x); assert.deepEqual(chain.subarray(32 + state), start.pad); assert.equal(chain.length, 32 + 2 * state);
  } finally { server.close(); }
});
