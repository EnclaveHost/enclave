// Two hosts checking each other through network/proof-of-capacity-host.mjs: the work, the challenge and its answer,
// what each kind of misbehaviour is judged as, and the agent that keeps a host in standing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pad, toHex, keccak256, toBytes, recoverTypedDataAddress} from 'viem';
const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {capacityWork, capacityLanes, createCapacityResponder, createCapacityChecker, createCapacityAgent, selfCapacityRecord,
  createClaimReader, challengeMessage, capacityAnswerHere, furtherMode, CAPACITY_CHECK_PATH} from '../network/proof-of-capacity-host.mjs';
import {buildCapacityRecord, signCapacityRecord} from '../network/host-capacity-record.mjs';
import {recoverMessageAddress} from 'viem';
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
    verdictOf: async (_e, c, t) => done[`${c}>${t}`] || 0, standing: async () => [true, ''], anchor: async () => ({number: 77n, hash: keccak256(toBytes('recent'))})};
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
  const targetOf = async id => hosts[id] ? {endpoint: hosts[id].endpoint, proofKey: hosts[id].key.address, operator: hosts[id].key.address} : null;
  const checkerOf = (id, over = {}) => createCapacityChecker({recover, host: id, domain, sign: hosts[id].sign, targetOf, fetch, ...small, ...over});
  return {hosts, reader, done, sent, fetch, targetOf, checkerOf, proofKeyOf};
}
const ctx = {epoch: 9, seed};

test('an assigned checker gets a signed answer and passes the host; the record says what was asked', async () => {
  const n = network(), r = await n.checkerOf(A)(B, ctx);
  assert.equal(r.verdict, 'pass');
  const rec = JSON.parse(r.evidence);
  assert.deepEqual({kind: rec.kind, epoch: rec.epoch, checker: rec.checker, target: rec.target, rounds: rec.rounds, memoryMiB: rec.memoryMiB, verdict: rec.verdict},
    {kind: 'enclave-capacity-check/2', epoch: 9, checker: A, target: B, ...small, verdict: 'pass'});
  assert.equal(rec.lanes, 1); assert.deepEqual(rec.claim, {none: 'no claim reader on this checker'});
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
  // one lane took this checker 100 ms; the answer took 5000 ms where 3 x 100 + 1500 are allowed
  const clock = [0, 100, 100, 5100];   // (start of the one lane, its end, the request sent, the answer back)
  const late = await n.checkerOf(A, {now: () => clock.length > 1 ? clock.shift() : clock[0]})(B, ctx);
  assert.equal(late.verdict, 'fail'); assert.match(JSON.parse(late.evidence).why, /too late/);
  // a host that cheats on the work: the digest of less work is not the digest
  n = network(); n.hosts[B].answer = createCapacityResponder({recover, hostId: B, domain, reader: n.reader, proofKeyOf: n.proofKeyOf, sign: n.hosts[B].sign,
    work: c => capacityLanes({...c, rounds: 1})});
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
    const c = {version: 2, epoch: 9, checker: from, target: B, seed, nonce: '0x' + '33'.repeat(32), ...small, lanes: 1, ...over};
    return {...c, signature: await n.hosts[signer].sign(challengeMessage(domain, c))};
  };
  assert.equal((await b.answer(await challenge(C))).status, 403);                       // not assigned
  assert.equal((await b.answer(await challenge(A, {}, C))).status, 403);                // assigned, but another key signed
  assert.equal((await b.answer(await challenge(A, {epoch: 8}))).status, 409);           // another epoch
  assert.equal((await b.answer(await challenge(A, {seed: '0x' + '44'.repeat(32)}))).status, 409);
  assert.equal((await b.answer(await challenge(A, {target: C}))).status, 404);
  assert.equal((await b.answer({...(await challenge(A)), rounds: 10 ** 9})).status, 400);
  assert.equal((await b.answer({...(await challenge(A)), lanes: 1000})).status, 400);
  assert.equal((await b.answer({...(await challenge(A)), version: 1})).status, 400);
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
  assert.equal(self[0], A); assert.deepEqual([self[1], self[2]], [77n, keccak256(toBytes('recent'))]); assert.match(self[3], /^0x[0-9a-f]{64}$/);
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

test('lanes: as many as the host advertises free, side by side; a host that runs them one after another is late', async () => {
  // the digest is over every lane, and one lane's is not it
  const one = await capacityLanes({seed, rounds: 500, memoryMiB: 1, lanes: 1}), four = await capacityLanes({seed, rounds: 500, memoryMiB: 1, lanes: 4});
  assert.notEqual(one, four); assert.equal(await capacityLanes({seed, rounds: 500, memoryMiB: 1, lanes: 4}), four);
  await assert.rejects(capacityLanes({seed, rounds: 500, memoryMiB: 256, lanes: 64}));   // more memory in all than a check may ask
  // the checker asks what the host claims (bounded by its own maxLanes), each lane with its share of the free memory
  const n = network(), claimed = {lanes: 6, freeMiB: 9, record: '0x' + 'ee'.repeat(32)};
  let r = JSON.parse((await n.checkerOf(A, {claimOf: async () => claimed, maxLanes: 4, memoryMiB: 4})(B, ctx)).evidence);
  assert.deepEqual({verdict: r.verdict, lanes: r.lanes, memoryMiB: r.memoryMiB, claim: r.claim}, {verdict: 'pass', lanes: 4, memoryMiB: 2, claim: claimed});
  // a host that has one processor for the four it advertises: the same digest, four times one lane's time
  const n2 = network();
  const clock = [0, 1000, 1000, 1000 + 4 * 1000 + 600];   // one lane: 1000 ms here; the answer: 4600 ms; allowed: 3 x 1000 + 1500
  r = JSON.parse((await n2.checkerOf(A, {claimOf: async () => ({lanes: 4, freeMiB: 64, record: '0x' + 'ee'.repeat(32)}),
    now: () => clock.length > 1 ? clock.shift() : clock[0]})(B, ctx)).evidence);
  assert.equal(r.verdict, 'fail'); assert.match(r.why, /4 lanes took 4600 ms where one takes this checker 1000 ms/);
  // a host with no claim the checker can verify is asked for one lane, and the record says why
  r = JSON.parse((await network().checkerOf(A, {claimOf: async () => ({none: 'the record is not signed by the host\'s registry operator'})})(B, ctx)).evidence);
  assert.deepEqual({verdict: r.verdict, lanes: r.lanes, claim: r.claim}, {verdict: 'pass', lanes: 1, claim: {none: 'the record is not signed by the host\'s registry operator'}});
});

test('the claim is the host\'s own signed capacity record: its host id, its operator, this chain and registry, current', async () => {
  const op = privateKeyToAccount(generatePrivateKey()), registry = '0x' + '1e'.repeat(20), endpoint = 'https://b2.example';
  const row = {endpoint, operator: op.address, proofKey: op.address};
  const envelope = async (over = {}, signer = op) => {
    const record = buildCapacityRecord({availability: {cpuShareFree: 0.5, nodeVcpus: 16, nodeRamGb: 96, ...over.availability}, chainId: 8453, registry,
      endpoint: over.endpoint || endpoint, hostId: over.hostId || B, operator: signer.address});
    return signCapacityRecord(signer, record);
  };
  const reader = env => createClaimReader({chainId: 8453, registry, recoverMessage: (message, signature) => recoverMessageAddress({message, signature}),
    fetch: async url => { assert.equal(url, endpoint + '/v1/host/capacity'); return env ? {ok: true, json: async () => env} : {ok: false, status: 503}; }});
  const c = await reader(await envelope())(B, row);
  assert.deepEqual({lanes: c.lanes, freeMiB: c.freeMiB}, {lanes: 8, freeMiB: 49152}); assert.match(c.record, /^0x[0-9a-f]{64}$/);
  assert.deepEqual({...(await reader(await envelope({availability: {vcpusFree: 3.9, ramGbFree: 1.5}}))(B, row)), record: 0}, {lanes: 3, freeMiB: 1536, record: 0, cards: []});
  // the cards it sells by masked offload: each with the rate it states and the share of it that is free now
  const sold = await reader(await envelope({availability: {shieldedCards: [{id: 0, gmacPerSec: 6.2, gpuShareFree: 0.5, card: 'x'}, {id: 1, gmacPerSec: 3}, {id: 99, gmacPerSec: 1}, {gmacPerSec: 1}, null]}}))(B, row);
  assert.deepEqual(sold.cards, [{id: 0, gmacPerSec: 6.2, share: 0.5}, {id: 1, gmacPerSec: 3, share: 0}]);
  // a Windows box's one card, as its row states it: card 0, free as its memory is free
  const win = await reader(await envelope({availability: {shielded: {worker: 'vulkan', gmacPerSec: 173, vramBudgetGb: 12, vramFreeGb: 9}}}))(B, row);
  assert.deepEqual(win.cards, [{id: 0, gmacPerSec: 173, share: 0.75}]);
  assert.deepEqual((await reader(await envelope({availability: {shielded: {gmacPerSec: 173}}}))(B, row)).cards, [{id: 0, gmacPerSec: 173, share: 0}]);
  assert.deepEqual((await reader(await envelope({availability: {shielded: null}}))(B, row)).cards, []);
  assert.match((await reader(await envelope({hostId: C}))(B, row)).none, /another host's/);
  assert.match((await reader(await envelope())(B, {...row, operator: '0x' + '77'.repeat(20)})).none, /not signed by the host's registry operator/);
  assert.match((await createClaimReader({chainId: 1, registry, recoverMessage: async () => op.address, fetch: async () => ({ok: true, json: async () => envelope()})})(B, row)).none, /another chain or registry/);
  assert.match((await reader(null)(B, row)).none, /HTTP 503/);
  const tampered = await envelope(); tampered.record = {...tampered.record, availabilityJson: JSON.stringify({cpuShareFree: 1, nodeVcpus: 64})};
  assert.match((await reader(tampered)(B, row)).none, /not signed by the host's registry operator/);
});

test('further checks: one that fails makes the verdict a fail, with its reason; one that throws is no verdict', async () => {
  const n = network(), seen = [];
  const served = async (target, row, c) => { seen.push([target, row.endpoint, c.epoch]); return {name: 'served app', ok: true, why: 'answers on its attested key', evidence: '0x' + 'aa'.repeat(32)}; };
  let r = JSON.parse((await n.checkerOf(A, {also: [served, async () => null]})(B, ctx)).evidence);
  assert.equal(r.verdict, 'pass'); assert.deepEqual(r.also, [{name: 'served app', ok: true, why: 'answers on its attested key', evidence: '0x' + 'aa'.repeat(32)}]);
  assert.deepEqual(seen, [[B, n.hosts[B].endpoint, 9]]);
  r = JSON.parse((await network().checkerOf(A, {also: [async () => ({name: 'card', ok: false, why: 'the result of the card\'s work is not the checker\'s'})]})(B, ctx)).evidence);
  assert.equal(r.verdict, 'fail'); assert.match(r.why, /^card: the result of the card's work/);
  await assert.rejects(network().checkerOf(A, {also: [async () => { throw new Error('the verifier has no session'); }]})(B, ctx), /no session/);
  // one that could not judge is recorded with its reason and leaves the verdict to the rest; each is handed the claim
  const got = [];
  r = JSON.parse((await network().checkerOf(A, {claimOf: async () => ({lanes: 1, freeMiB: 64, record: '0x' + '11'.repeat(32), cards: [{id: 0, gmacPerSec: 5, share: 1}]}),
    also: [async (_t, _row, c) => { got.push(c.claim.cards); return {name: 'served-app', ok: null, why: 'the relay is busy'}; }, served]})(B, ctx)).evidence);
  assert.equal(r.verdict, 'pass'); assert.deepEqual(r.also[0], {name: 'served-app', ok: null, why: 'the relay is busy'}); assert.equal(r.also[1].ok, true);
  assert.deepEqual(got, [[{id: 0, gmacPerSec: 5, share: 1}]]);
});

test('a host whose proof key is elsewhere hands the challenge over: the work and the signature come back together', async () => {
  const n = network(), elsewhere = privateKeyToAccount(generatePrivateKey()), asked = [];
  n.hosts[B].key = elsewhere;   // the registry publishes the partition's key
  n.hosts[B].answer = createCapacityResponder({recover, hostId: B, domain, reader: n.reader, proofKeyOf: n.proofKeyOf, sign: async () => { throw new Error('this process holds no proof key'); },
    answerOf: async (c, d) => { asked.push([c.lanes, d.contract]); return capacityAnswerHere(c, d, m => elsewhere.signTypedData(m)); }});
  const r = await n.checkerOf(A)(B, ctx);
  assert.equal(r.verdict, 'pass'); assert.deepEqual(asked, [[1, domain.contract]]);
  // busy there is busy here: no verdict, tried again
  n.hosts[B].answer = createCapacityResponder({recover, hostId: B, domain, reader: n.reader, proofKeyOf: n.proofKeyOf, sign: n.hosts[B].sign,
    answerOf: async () => { throw Object.assign(new Error('busy'), {busy: true}); }});
  await assert.rejects(n.checkerOf(A)(B, ctx), /answered 503/);
});

test('a further check is enforce, record or off, and nothing else', () => {
  assert.equal(furtherMode(undefined), 'enforce'); assert.equal(furtherMode(''), 'enforce'); assert.equal(furtherMode(' record '), 'record'); assert.equal(furtherMode('off'), 'off');
  assert.throws(() => furtherMode('no', 'PROOF_OF_CAPACITY_APP'), /PROOF_OF_CAPACITY_APP must be enforce, record or off/);
});

test('a host\'s own record is the same work on itself, and its digest is what goes on chain', async () => {
  const text = await selfCapacityRecord(A, small)({epoch: 9, seed}), rec = JSON.parse(text);
  assert.equal(rec.digest, await capacityWork({seed, ...small})); assert.equal(rec.host, A);
  assert.match(evidenceDigest(text), /^0x[0-9a-f]{64}$/);
});
