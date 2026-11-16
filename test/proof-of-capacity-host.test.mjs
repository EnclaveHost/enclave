// Two hosts checking each other through network/proof-of-capacity-host.mjs: the work, the challenge and its answer,
// what each kind of misbehaviour is judged as, and the agent that keeps a host in standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pad, toHex, keccak256, toBytes, recoverTypedDataAddress} from 'viem';
const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {capacityWork, createCapacityResponder, createCapacityChecker, createCapacityAgent, selfCapacityRecord,
  challengeMessage, CAPACITY_CHECK_PATH} from '../network/proof-of-capacity-host.mjs';
import {evidenceDigest} from '../network/proof-of-capacity.mjs';

const domain = {chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'};
const A = pad(toHex(0xA1), {size: 32}), B = pad(toHex(0xB2), {size: 32}), C = pad(toHex(0xC3), {size: 32});
const seed = keccak256(toBytes('epoch seed')), small = {rounds: 300, memoryMiB: 1};

test('the work is the same for the same challenge, another for another, and lets the event loop in', async () => {
  let turns = 0, stop = false; const spin = () => { turns++; if (!stop) setImmediate(spin); }; setImmediate(spin);
  const d = await capacityWork({seed, rounds: 2000, memoryMiB: 8}); stop = true;
  assert.match(d, /^0x[0-9a-f]{64}$/); assert.ok(turns >= 10, `the loop ran ${turns} times`);
  assert.equal(await capacityWork({seed, rounds: 2000, memoryMiB: 8}), d);
  assert.notEqual(await capacityWork({seed, rounds: 2001, memoryMiB: 8}), d);
  assert.notEqual(await capacityWork({seed, rounds: 2000, memoryMiB: 9}), d);
  assert.notEqual(await capacityWork({seed: keccak256(toBytes('other')), rounds: 2000, memoryMiB: 8}), d);
  await assert.rejects(capacityWork({seed, rounds: 0, memoryMiB: 8})); await assert.rejects(capacityWork({seed, rounds: 10, memoryMiB: 100000}));
});

// a little network: hosts by id, each with a proof key and a responder; the contract's views are plain data
function network({checkers = {[A]: [B], [B]: [A]}, epoch = 9} = {}) {
  const hosts = {}, done = {}, sent = [];
  const reader = {epochNow: async () => BigInt(epoch), seedOf: async () => seed,
    checkersOf: async (_e, t) => checkers[t] || [], targetsOf: async (_e, c) => Object.keys(checkers).filter(t => checkers[t].includes(c)),
    verdictOf: async (_e, c, t) => done[`${c}>${t}`] || 0, standing: async () => [true, '']};
  for (const id of [A, B, C]) {
    const key = privateKeyToAccount(generatePrivateKey()), sign = m => key.signTypedData(m);
    hosts[id] = {id, key, sign, endpoint: `https://${id.slice(-2)}.example`};
  }
  const proofKeyOf = async id => hosts[id]?.key.address || null;
  for (const h of Object.values(hosts)) h.answer = createCapacityResponder({recover, hostId: h.id, domain, reader, proofKeyOf, sign: h.sign});
  // fetch: the URL names the host; `tamper` lets a test stand between them
  const fetch = async (url, init) => {
    const h = Object.values(hosts).find(x => url === x.endpoint + CAPACITY_CHECK_PATH);
    if (!h || h.down) throw Object.assign(new Error('connect ECONNREFUSED'), {name: 'Error'});
    const r = await h.answer(JSON.parse(init.body));
    const body = h.tamper ? h.tamper(r.body) : r.body;
    return {ok: r.status === 200, status: r.status, json: async () => body};
  };
  const targetOf = async id => hosts[id] ? {endpoint: hosts[id].endpoint, proofKey: hosts[id].key.address} : null;
  const checkerOf = (id, over = {}) => createCapacityChecker({recover, host: id, domain, sign: hosts[id].sign, targetOf, fetch, ...small, ...over});
  return {hosts, reader, done, sent, fetch, targetOf, checkerOf, proofKeyOf};
}
const ctx = {epoch: 9, seed};

test('an assigned checker gets a signed answer and passes the host; the record says what was asked', async () => {
  const n = network(), r = await n.checkerOf(A)(B, ctx);
  assert.equal(r.verdict, 'pass');
  const rec = JSON.parse(r.evidence);
  assert.deepEqual({kind: rec.kind, epoch: rec.epoch, checker: rec.checker, target: rec.target, rounds: rec.rounds, memoryMiB: rec.memoryMiB, verdict: rec.verdict},
    {kind: 'enclave-capacity-check/1', epoch: 9, checker: A, target: B, ...small, verdict: 'pass'});
  assert.match(rec.digest, /^0x[0-9a-f]{64}$/); assert.match(rec.signature, /^0x[0-9a-f]{130}$/);
});

test('fail: a wrong digest, another key\'s signature, an answer to another challenge, an answer that came too late', async () => {
  let n = network(); n.hosts[B].tamper = b => ({...b, digest: '0x' + '11'.repeat(32)});
  assert.equal((await n.checkerOf(A)(B, ctx)).verdict, 'fail');   // (the signature no longer covers it either)
  n = network(); n.hosts[B].answer = createCapacityResponder({recover, hostId: B, domain, reader: n.reader, proofKeyOf: n.proofKeyOf, sign: n.hosts[C].sign});
  assert.match(JSON.parse((await n.checkerOf(A)(B, ctx)).evidence).why, /not signed by the host's proof key/);
  n = network(); n.hosts[B].tamper = b => ({...b, nonce: '0x' + '22'.repeat(32)});
  assert.match(JSON.parse((await n.checkerOf(A)(B, ctx)).evidence).why, /not for this challenge/);
  n = network(); let t = 0;
  const late = await n.checkerOf(A, {timeoutMs: 1000, now: () => (t += 1200)})(B, ctx);   // the answer took 1200 ms of a 1000 ms deadline
  assert.equal(late.verdict, 'fail'); assert.match(JSON.parse(late.evidence).why, /too late/);
  // a host that cheats on the work: the digest of less work is not the digest
  n = network(); n.hosts[B].answer = createCapacityResponder({recover, hostId: B, domain, reader: n.reader, proofKeyOf: n.proofKeyOf, sign: n.hosts[B].sign,
    work: c => capacityWork({...c, rounds: 1})});
  assert.match(JSON.parse((await n.checkerOf(A)(B, ctx)).evidence).why, /wrong digest/);
});

test('unreachable: no answer, an HTTP error, no registry row; but not when it is the checker that is cut off, or the host says try again', async () => {
  let n = network(); n.hosts[B].down = true;
  assert.equal((await n.checkerOf(A)(B, ctx)).verdict, 'unreachable');
  await assert.rejects(n.checkerOf(A, {reachable: async () => false})(B, ctx), /cannot reach the outside/);
  n = network(); const unknown = pad(toHex(0xD4), {size: 32});
  assert.equal((await n.checkerOf(A)(unknown, ctx)).verdict, 'unreachable');
  n = network(); n.fetch500 = async () => ({ok: false, status: 500, json: async () => ({})});
  assert.equal((await createCapacityChecker({recover, host: A, domain, sign: n.hosts[A].sign, targetOf: n.targetOf, fetch: n.fetch500, ...small})(B, ctx)).verdict, 'unreachable');
  // busy / not this epoch / already asked: the host is up and has not been checked - no verdict, try again
  for (const status of [409, 429, 503])
    await assert.rejects(createCapacityChecker({recover, host: A, domain, sign: n.hosts[A].sign, targetOf: n.targetOf, ...small,
      fetch: async () => ({ok: false, status, json: async () => ({})})})(B, ctx), /try again/);
});

test('a host works only for a checker the contract assigned, over that checker\'s signature, once an epoch', async () => {
  const n = network(), b = n.hosts[B];
  const challenge = async (from, over = {}, signer = from) => {
    const c = {version: 1, epoch: 9, checker: from, target: B, seed, nonce: '0x' + '33'.repeat(32), ...small, ...over};
    return {...c, signature: await n.hosts[signer].sign(challengeMessage(domain, c))};
  };
  assert.equal((await b.answer(await challenge(C))).status, 403);                       // not assigned
  assert.equal((await b.answer(await challenge(A, {}, C))).status, 403);                // assigned, but another key signed
  assert.equal((await b.answer(await challenge(A, {epoch: 8}))).status, 409);           // another epoch
  assert.equal((await b.answer(await challenge(A, {seed: '0x' + '44'.repeat(32)}))).status, 409);
  assert.equal((await b.answer(await challenge(A, {target: C}))).status, 404);
  assert.equal((await b.answer({...(await challenge(A)), rounds: 10 ** 9})).status, 400);
  assert.equal((await b.answer('nonsense')).status, 400);
  const first = await b.answer(await challenge(A)); assert.equal(first.status, 200);
  assert.deepEqual((await b.answer(await challenge(A))).body, first.body);              // the same challenge again: the same answer
  assert.equal((await b.answer(await challenge(A, {nonce: '0x' + '55'.repeat(32)}))).status, 429);   // a second one: no more work
});

test('the agent: seeds the epoch, checks what it was assigned, reports once, proves itself only when that is what is missing', async () => {
  const n = network({checkers: {[A]: [B], [B]: [A], [C]: [A]}}), sent = [];
  let seedSet = false, standing = [false, 'needs its own proof of capacity'];
  const reader = {...n.reader, seedOf: async () => seedSet ? seed : '0x' + '00'.repeat(32), standing: async () => standing};
  const send = async (fn, args) => { sent.push([fn, args]); if (fn === 'touch') seedSet = true; if (fn === 'report') n.done[`${args[1]}>${args[2]}`] = args[3]; };
  n.hosts[C].down = true;
  const agent = createCapacityAgent({host: A, domain, reader, sign: n.hosts[A].sign, send, check: n.checkerOf(A),
    selfCheck: selfCapacityRecord(A, small)});
  // B's and C's responders ask the contract for the seed too: give them the agent's view
  for (const id of [B, C]) n.hosts[id].answer = createCapacityResponder({recover, hostId: id, domain, reader, proofKeyOf: n.proofKeyOf, sign: n.hosts[id].sign});
  const r = await agent.tick();
  assert.deepEqual(sent.map(x => x[0]), ['touch', 'report', 'report', 'proveSelf']);
  assert.deepEqual(sent.filter(x => x[0] === 'report').map(x => [x[1][2], x[1][3]]).sort(), [[B, 1], [C, 3]].sort());
  assert.deepEqual({reported: r.reported, selfProved: r.selfProved, standing: r.standing}, {reported: 2, selfProved: true, standing: {ok: false, why: 'needs its own proof of capacity'}});
  const self = sent.find(x => x[0] === 'proveSelf')[1];
  assert.equal(self[0], A); assert.match(self[1], /^0x[0-9a-f]{64}$/);
  // next tick: nothing left to report; in standing: nothing to send
  sent.length = 0; standing = [true, ''];
  assert.deepEqual((await agent.tick()).standing, {ok: true, why: ''}); assert.deepEqual(sent, []);
  // a duty missed or failed checks are said, not signed away
  standing = [false, 'failed its capacity checks'];
  assert.equal((await agent.tick()).selfProved, false); assert.deepEqual(sent, []);
  // a send that fails does not stop the round, and a host with nothing to be paid for neither seeds nor proves itself
  const n2 = network(), sent2 = [];
  const quiet = createCapacityAgent({host: A, domain, reader: {...n2.reader, standing: async () => [false, 'needs its own proof of capacity']},
    sign: n2.hosts[A].sign, send: async fn => { sent2.push(fn); throw new Error('no gas'); }, check: n2.checkerOf(A), selfCheck: selfCapacityRecord(A, small), wantsCredit: async () => false});
  const q = await quiet.tick();
  assert.deepEqual(sent2, ['report']); assert.equal(q.reported, 0); assert.equal(q.standing, null);
});

test('a host\'s own record is the same work on itself, and its digest is what goes on chain', async () => {
  const text = await selfCapacityRecord(A, small)({epoch: 9, seed}), rec = JSON.parse(text);
  assert.equal(rec.digest, await capacityWork({seed, ...small})); assert.equal(rec.host, A);
  assert.match(evidenceDigest(text), /^0x[0-9a-f]{64}$/);
});
