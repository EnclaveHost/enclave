// A host's proof key inside a Shield partition: the vectors the guest's Go code is held to, the host's use of its
// partition (network/proof-of-capacity-partition.mjs, windows/node/shield-capacity.mjs), a checker's verification of
// where another host's proof key lives, and the manager's rule for the host's own partitions.
//
// The partition here is a stand-in that answers as isolation/m2/front/capacity.go does (same paths, same bodies), with
// the keys the vectors use. The guest code itself is tested in Go (isolation/m2/capacity, isolation/m2/front) against
// the same vectors and the same key statement, which is what ties the two sides together.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash, generateKeyPairSync, sign as signWith} from 'node:crypto';
import {pad, toHex, keccak256, toBytes, recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {vectors, TEST_KEY} from '../isolation/m2/capacity/vectors.mjs';
import {createPartitionProofKey, createProofKeyCheck, keyStatementHolds, pinnedCapacityApps, KEY_STATEMENT, GUEST, PROOF_KEY_CHECK, CAPACITY_KEY_PATH}
  from '../network/proof-of-capacity-partition.mjs';
import {createCapacityResponder, createCapacityChecker, capacityLanes, answerMessage, CAPACITY_CHECK_PATH} from '../network/proof-of-capacity-host.mjs';
import {reportMessage, selfMessage, proofMessage} from '../network/proof-of-capacity.mjs';
import {createShieldCapacity, CAPACITY_NAME} from '../windows/node/shield-capacity.mjs';
import {hostOwnedSpawn, HOST_CAPACITY_NAME} from '../windows/vbslike/manager/server.mjs';
import {READINESS_WITNESS_APP_ID} from '../windows/vbslike/manager/wmi-launcher.mjs';

const recover = (typedData, signature) => recoverTypedDataAddress({...typedData, signature});
const domain = {chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'};
const A = pad(toHex(0xA1), {size: 32}), B = pad(toHex(0xB2), {size: 32}), seed = keccak256(toBytes('epoch seed'));
const sha = b => createHash('sha256').update(b).digest();

test('the vectors the guest code is checked against are what the hosts\' code and viem compute now', async () => {
  const file = fs.readFileSync(new URL('../isolation/m2/capacity/testdata/vectors.json', import.meta.url), 'utf8');
  assert.equal(file, JSON.stringify(await vectors(), null, 1) + '\n', 'stale: node isolation/m2/capacity/vectors.mjs --write, then go test ./capacity/ in isolation/m2');
});

test('a key statement made by the guest code verifies here, and only for its address and its key', () => {
  const v = JSON.parse(fs.readFileSync(new URL('../isolation/m2/capacity/testdata/statement.json', import.meta.url), 'utf8'));
  const spki = Buffer.from(v.Spki, 'base64');
  assert.equal(keyStatementHolds({address: v.Address, tlsSignature: v.TLSSignature, spki}), true);
  assert.equal(keyStatementHolds({address: '0x' + '11'.repeat(20), tlsSignature: v.TLSSignature, spki}), false);
  const other = generateKeyPairSync('ec', {namedCurve: 'P-256'}).publicKey.export({type: 'spki', format: 'der'});
  assert.equal(keyStatementHolds({address: v.Address, tlsSignature: v.TLSSignature, spki: other}), false);
  for (const bad of [{address: v.Address, tlsSignature: '', spki}, {address: 'x', tlsSignature: v.TLSSignature, spki}, {address: v.Address, tlsSignature: v.TLSSignature, spki: Buffer.from('nope')}])
    assert.equal(keyStatementHolds(bad), false);
});

// a partition as the front answers: a proof key and a TLS key of its own, the work done there
function partition({account = privateKeyToAccount(TEST_KEY)} = {}) {
  const tls = generateKeyPairSync('ec', {namedCurve: 'P-256'}), address = account.address.toLowerCase(), seen = [];
  const spki = tls.publicKey.export({type: 'spki', format: 'der'});
  const tlsSignature = signWith('sha256', Buffer.concat([Buffer.from(KEY_STATEMENT + '\n'), Buffer.from(address.slice(2), 'hex')]), {key: tls.privateKey, dsaEncoding: 'der'}).toString('base64');
  const TYPES = {CapacityReport: reportMessage, CapacitySelf: selfMessage, ProofOfTime: proofMessage};
  let instance = 'hv1', busy = false;
  async function call(method, path, body) {
    seen.push([method, path]);
    if (path === GUEST.key) return {status: 200, body: {address, statement: KEY_STATEMENT, tlsSignature}, instance};
    const d = {chainId: body.chainId, contract: body.contract};
    if (path === GUEST.sign) {
      const make = TYPES[body.primaryType];
      if (!make) return {status: 400, body: {error: 'this key does not sign that message here'}, instance};
      const m = body.message, typed = make(d, {...m, epoch: Number(m.epoch), verdict: Number(m.verdict)});
      return {status: 200, body: {signature: await account.signTypedData(typed)}, instance};
    }
    if (path === GUEST.work) {
      if (busy) return {status: 503, body: {error: 'busy with another check'}, instance};
      const c = body.challenge, workSeed = '0x' + sha(Buffer.from(c.Seed.slice(2) + c.Nonce.slice(2), 'hex')).toString('hex');
      const digest = await capacityLanes({seed: workSeed, rounds: c.Rounds, memoryMiB: c.MemoryMiB, lanes: c.Lanes});
      return {status: 200, body: {digest, signature: await account.signTypedData(answerMessage(d, {epoch: c.Epoch, checker: c.Checker, target: c.Target, nonce: c.Nonce, digest}))}, instance};
    }
    return {status: 404, body: null, instance};
  }
  return {call, account, address, spki, tlsSignature, seen, restart() { instance = 'hv2'; }, set busy(v) { busy = v; }};
}

test('the host\'s use of its partition: the address, the other messages signed there, and never an answer by that path', async () => {
  const p = partition(), key = createPartitionProofKey({call: p.call});
  assert.equal(await key.address(), p.address); assert.equal(await key.address(), p.address);
  assert.deepEqual(p.seen, [['GET', GUEST.key]]);                               // asked once, until asked afresh
  await key.address({fresh: true}); assert.equal(p.seen.length, 2);
  const d = {chainId: 8453, contract: '0x00000000000000000000000000000000000C0FFE'};
  for (const m of [reportMessage(d, {epoch: 9, checker: A, target: B, verdict: 1, seed, evidence: keccak256(toBytes('e'))}),
                   selfMessage(d, {epoch: 9, host: A, anchorBlock: 77, anchorHash: seed, evidence: seed}),
                   proofMessage(d, {id: seed, enclaveId: A, operator: p.account.address, upto: 1800000000, anchorBlock: 77, anchorHash: seed})])
    assert.equal((await recover(m, await key.sign(m))).toLowerCase(), p.address, m.primaryType);
  await assert.rejects(key.sign(answerMessage(domain, {epoch: 9, checker: A, target: B, nonce: seed, digest: seed})), /signed with the work/);
  const foreign = reportMessage(domain, {epoch: 9, checker: A, target: B, verdict: 1, seed, evidence: seed});
  await assert.rejects(key.sign({...foreign, domain: {...foreign.domain, name: 'EnclaveProofOfTime'}}), /only for an EnclaveProofOfCapacity/);
  await assert.rejects(key.sign({...foreign, primaryType: 'Permit'}), /did not sign \(HTTP 400: this key does not sign/);
  await assert.rejects(createPartitionProofKey({call: async () => ({status: 404, body: null})}).address(), /states no proof key \(HTTP 404\)/);
  assert.throws(() => createPartitionProofKey({}));
});

test('a checked host answers from its partition: the checker sees the work and the partition\'s signature, and passes it', async () => {
  const p = partition(), key = createPartitionProofKey({call: p.call});
  const checkerKey = privateKeyToAccount(generatePrivateKey());
  const reader = {epochNow: async () => 9n, seedOf: async () => seed, checkersOf: async () => [A]};
  const answer = createCapacityResponder({recover, hostId: B, domain, reader, proofKeyOf: async () => checkerKey.address,
    sign: async () => { throw new Error('this process holds no proof key'); }, answerOf: (c, d) => key.answerOf(c, d)});
  const fetch = async (url, init) => { assert.equal(url, 'https://b2.example' + CAPACITY_CHECK_PATH); const r = await answer(JSON.parse(init.body)); return {ok: r.status === 200, status: r.status, json: async () => r.body}; };
  const check = createCapacityChecker({recover, host: A, domain, sign: m => checkerKey.signTypedData(m), fetch, rounds: 300, memoryMiB: 1,
    targetOf: async () => ({endpoint: 'https://b2.example', proofKey: p.address})});
  const r = await check(B, {epoch: 9, seed});
  assert.equal(r.verdict, 'pass'); assert.ok(p.seen.some(([m, path]) => m === 'POST' && path === GUEST.work));
  // the partition busy is "not now", never a verdict
  p.busy = true;
  const again = createCapacityResponder({recover, hostId: B, domain, reader, proofKeyOf: async () => checkerKey.address, sign: async () => '0x', answerOf: (c, d) => key.answerOf(c, d)});
  const busyFetch = async (url, init) => { const r = await again(JSON.parse(init.body)); return {ok: r.status === 200, status: r.status, json: async () => r.body}; };
  await assert.rejects(createCapacityChecker({recover, host: A, domain, sign: m => checkerKey.signTypedData(m), fetch: busyFetch, rounds: 300, memoryMiB: 1,
    targetOf: async () => ({endpoint: 'https://b2.example', proofKey: p.address})})(B, {epoch: 9, seed}), /answered 503/);
});

// ---- the checker's look at where a proof key lives ---------------------------------------------------------------------------
const APP = 'c1'.repeat(32), RT = 'd2'.repeat(32), M1 = 'e3'.repeat(32), M2 = 'f4'.repeat(32);
const policyOf = (over = {}) => ({schema: 'enclave-shield-app-policy/1', platforms: 'attested', images: [{measurement: M1, runtimeId: RT}, {measurement: M2, runtimeId: RT}, {measurement: 'aa'.repeat(32), runtimeId: 'bb'.repeat(32)}],
  capacity: {appSha256: APP, runtimeId: RT}, ...over});

test('the capacity apps a policy pins, each with the images admitted for its runtime', () => {
  assert.deepEqual(pinnedCapacityApps(policyOf()), [{appSha256: APP, runtimeId: RT, measurements: [M1, M2]}]);
  assert.deepEqual(pinnedCapacityApps(policyOf({capacity: [{appSha256: APP, runtimeId: RT}, {appSha256: 'zz', runtimeId: RT}]})).length, 1);
  assert.deepEqual(pinnedCapacityApps(policyOf({capacity: undefined})), []);
  assert.deepEqual(pinnedCapacityApps({...policyOf(), schema: 'other/1'}), []);
  assert.deepEqual(pinnedCapacityApps(null), []);
  const id = {signer: '11'.repeat(32), productId: 1, moduleId: 2};
  assert.deepEqual(pinnedCapacityApps(policyOf({images: [{measurement: M1, runtimeId: RT, identity: id}]}))[0].imageIdentities, [{measurement: M1, identity: id}]);
  assert.equal(pinnedCapacityApps(policyOf({images: [{measurement: M1, runtimeId: RT, identity: id}, {measurement: M2, runtimeId: RT}]}))[0].imageIdentities, null);   // partly pinned: ambiguous
  assert.deepEqual(pinnedCapacityApps(policyOf({images: [{measurement: M1, runtimeId: RT, nativeDesktop: true}]}))[0].measurements, []);
});

// a relay, a target host with a partition, and a verifier that runs the app request as the real one does and returns `verdict`
function world({p = partition(), verdict = {status: 'limited', checks: {'app-signature': true, 'app-binding': true}, reasons: [], omissions: ['app-expectation-relay-derived']},
  mode = 'hv-node', hostAnswers = 200, policy = policyOf()} = {}) {
  const asked = [], seenByVerifier = [];
  const row = {endpoint: 'https://api.example/t/box-b', proofKey: p.address};
  const fetch = async (url) => {
    const u = String(url); asked.push(u);
    if (u === 'https://api.example/v1/enclaves/box-b/apps') return {ok: true, status: 200, json: async () => ({name: 'box-b', mode, apps: []})};
    if (u.startsWith(row.endpoint + CAPACITY_KEY_PATH)) {
      if (hostAnswers !== 200) return {ok: false, status: hostAnswers, json: async () => ({error: 'no_capacity_partition'})};
      const nonce = new URL(u).searchParams.get('nonce');
      return {ok: true, status: 200, json: async () => ({document: {appSha256: APP, nonce, transportKey: p.spki.toString('base64')}, handshakeSpki: p.spki.toString('base64'),
        key: {address: p.address, tlsSignature: p.tlsSignature}})};
    }
    throw new Error('unexpected ' + u);
  };
  const verifier = {verifyShieldAppWeb: async ({apiBase, name, deployment, fetchImpl}) => {
    const nonce = 'ab'.repeat(32);
    const r = await fetchImpl(`${apiBase}/v1/enclaves/${name}/apps/${deployment}/attestation?nonce=${nonce}`, {});
    const body = JSON.parse(await r.text()); seenByVerifier.push({status: r.status, body, deployment});
    if (r.status !== 200) return {status: 'error', checks: {}, reasons: [`app attestation: HTTP ${r.status}: ${body.message}`]};
    return typeof verdict === 'function' ? verdict(body) : verdict;
  }};
  const check = (over = {}) => createProofKeyCheck({host: A, apiBase: 'https://api.example', verifier, policy: () => policy, fetch, ...over});
  return {p, row, check, asked, seenByVerifier};
}

test('an Enclave Shield host whose proof key is its capacity partition\'s passes, on this checker\'s own pins', async () => {
  const w = world(), r = await w.check()(B, w.row, {epoch: 9, seed});
  assert.equal(r.name, PROOF_KEY_CHECK); assert.equal(r.ok, true, r.why);
  // what the verifier was handed for the app: the host's document and key, and THIS checker's expectation and images
  const a = w.seenByVerifier[0].body;
  assert.equal(w.seenByVerifier[0].deployment, '0x' + APP);
  assert.deepEqual(a.expected, {source: 'the capacity app this checker\'s own Shield policy pins', appSha256: APP, runtimeId: RT});
  assert.deepEqual(a.policy.measurements, [M1, M2]); assert.equal(a.policy.platforms, 'attested'); assert.equal(a.policy.minimumGuestSvn, 0);
  assert.equal(a.mode, 'hv-node'); assert.equal(a.name, 'box-b'); assert.equal(a.document.nonce, a.nonce);
  assert.deepEqual({box: r.evidence.box, status: r.evidence.status, partitionKey: r.evidence.partitionKey, registered: r.evidence.registered, appSha256: r.evidence.appSha256},
    {box: 'box-b', status: 'limited', partitionKey: w.p.address, registered: w.p.address, appSha256: APP});
  assert.equal(r.evidence.tlsKeySha256, sha(w.p.spki).toString('hex'));
  // the host's TPM session was left to the relay, and only the app request went to the host
  assert.deepEqual(w.asked, ['https://api.example/v1/enclaves/box-b/apps', `${w.row.endpoint}${CAPACITY_KEY_PATH}?nonce=${'ab'.repeat(32)}`]);
});

test('a verified key is remembered for the key the registry publishes, and asked about again when that changes', async () => {
  const w = world(); let t = 1000;
  const check = w.check({now: () => t, cacheMs: 60000});
  assert.equal((await check(B, w.row, {epoch: 9, seed})).ok, true);
  const n = w.seenByVerifier.length; t += 30000;
  const cached = await check(B, w.row, {epoch: 10, seed});
  assert.equal(cached.ok, true); assert.match(cached.why, /verified as a capacity partition's 1 min ago/); assert.equal(w.seenByVerifier.length, n);
  t += 60000;
  assert.equal((await check(B, w.row, {epoch: 11, seed})).ok, true); assert.equal(w.seenByVerifier.length, n + 1);     // the time is up
  const moved = await check(B, {...w.row, proofKey: '0x' + '99'.repeat(20)}, {epoch: 12, seed});                        // another key registered
  assert.equal(moved.ok, false); assert.match(moved.why, /registry publishes is not the capacity partition's/);
});

test('each way an Enclave Shield host fails it', async () => {
  const fails = async (w, why, over) => { const r = await w.check(over)(B, w.row, {epoch: 9, seed}); assert.equal(r.ok, false, r.why); assert.match(r.why, why); return r; };
  // its proof key is the host's file: it serves no partition key
  await fails(world({hostAnswers: 404}), /proof key is not a capacity partition's: it serves no partition key/);
  // the partition's evidence was read and refused
  await fails(world({verdict: {status: 'rejected', checks: {'app-measurement': false, 'app-signature': true}, reasons: ['image measurement is not admitted']}}), /evidence was refused: image measurement is not admitted/);
  // the statement is another TLS key's
  const other = partition({account: privateKeyToAccount(generatePrivateKey())});
  await fails(world({p: {...partition(), tlsSignature: other.tlsSignature}}), /not stated by the partition's attested TLS key/);
  // the partition's key is not the one registered
  const reg = world(); reg.row.proofKey = '0x' + '99'.repeat(20);
  await fails(reg, /registry publishes is not the capacity partition's/);
  // with enforce off: recorded, and fails nobody
  const off = world({hostAnswers: 404}), soft = await off.check({enforce: false})(B, off.row, {epoch: 9, seed});
  assert.equal(soft.ok, null); assert.match(soft.why, /^recorded, not enforced: an Enclave Shield host whose proof key/);
});

test('what is not an Enclave Shield host is not checked, and what could not be judged is said, not held against it', async () => {
  let w = world({mode: 'snp'});
  assert.equal(await w.check()(B, w.row, {epoch: 9, seed}), null);            // a confidential server makes its key in its own VM
  const unjudged = async (w2, why, over) => { const r = await w2.check(over)(B, w2.row, {epoch: 9, seed}); assert.equal(r.ok, null, r.why); assert.match(r.why, why); };
  await unjudged(world({policy: policyOf({capacity: undefined})}), /pins no capacity app/);
  await unjudged(world(), /this checker's Shield policy: no file/, {policy: () => { throw new Error('no file'); }});
  await unjudged(world({hostAnswers: 503}), /app attestation: HTTP 503/);
  await unjudged(world({verdict: {status: 'error', checks: {}, reasons: ['TPM keys: busy']}}), /TPM keys: busy/);
  await unjudged(world({verdict: {status: 'rejected', checks: {server: true}, reasons: ['the relay answered for another nonce']}}), /another nonce/);
  await unjudged(world(), /has no verifyShieldAppWeb/, {verifier: {}});
  await unjudged(world(), /which box the host is/, {fetch: async () => { throw new Error('down'); }});
  // the independent verifier as shipped, with a relay that is not there: not judged
  w = world();
  const r = await w.check({verifier: () => import('../verifier/web/dist/enclave-verifier-web.js'), timeoutMs: 4000,
    fetch: async url => { if (String(url).endsWith('/apps')) return {ok: true, status: 200, json: async () => ({mode: 'hv-node', apps: []})}; throw new Error('down'); }})(B, w.row, {epoch: 9, seed});
  assert.equal(r.ok, null); assert.equal(r.evidence.status, 'error');
});

// ---- the node's capacity partition and the manager's rule --------------------------------------------------------------------
const pinned = (over = {}) => ({appId: APP, derive: {derivation: 'enclave-catalog-bundle/1', catalog: {app: '0x' + '12'.repeat(32), version: 1}, cid: 'bafkreiexample', runtimeId: RT,
  policy: {vcpus: 8, memMiB: 1536, cpuPercent: 800}, ...over}});

test('the node keeps one capacity partition from its pinned config and reaches its front on the verified key', async () => {
  const p = partition(), calls = [], vms = [];
  const client = {findByName: async name => vms.find(v => v.name === name) || null,
    spawn: async body => { calls.push(['spawn', body.name, body.derive.policy.vcpus]); const view = {id: 'hv1', name: body.name, status: 'running', appId: APP, runtimeId: RT}; vms.push(view); return {view}; },
    remove: async id => { calls.push(['remove', id]); vms.splice(vms.findIndex(v => v.id === id), 1); }, get: async id => vms.find(v => v.id === id) || null};
  const request = async o => { calls.push(['request', o.instanceId, o.expectAppId, o.method, o.path]); const r = await p.call(o.method, o.path, o.body ? JSON.parse(o.body) : null);
    return {status: r.status, body: Buffer.from(JSON.stringify(r.body)), spki: p.spki.toString('base64')}; };
  const read = async o => ({doc: {appSha256: o.expectAppId, nonce: o.nonce.toString('hex')}, handshakeSpki: p.spki.toString('base64')});
  let t = 0;
  const c = createShieldCapacity({config: pinned(), base: 'http://127.0.0.1:1', dataAddr: '127.0.0.1:2', client, request, read, now: () => t});
  assert.equal(await c.key.address(), p.address);
  assert.deepEqual(calls, [['spawn', CAPACITY_NAME, 8], ['request', 'hv1', APP, 'GET', GUEST.key]]);
  const e = await c.evidence('ab'.repeat(32));
  assert.deepEqual(e, {document: {appSha256: APP, nonce: 'ab'.repeat(32)}, handshakeSpki: p.spki.toString('base64'), key: {address: p.address, tlsSignature: p.tlsSignature}});
  assert.equal(keyStatementHolds({...e.key, spki: p.spki}), true);
  await assert.rejects(c.evidence('xyz'), /32-byte nonce/);
  // another app under its name is never adopted, a stopped one is replaced after the cool-down, and hosting off removes it
  vms[0].appId = 'ee'.repeat(32);
  await assert.rejects(c.ensure(), /identity mismatch/);
  vms[0].appId = APP; vms[0].status = 'failed';
  await assert.rejects(c.ensure(), /cooling down/);
  t = 61000; await c.ensure();
  assert.deepEqual(calls.slice(-2), [['remove', 'hv1'], ['spawn', CAPACITY_NAME, 8]]);
  assert.equal(await c.stop(), true); assert.equal(await c.stop(), false);
  for (const bad of [pinned({policy: {vcpus: 0, memMiB: 1536, cpuPercent: 0}}), pinned({policy: {vcpus: 8, memMiB: 128, cpuPercent: 800}}), pinned({policy: {vcpus: 8, memMiB: 1536, cpuPercent: 100}}),
                     pinned({derivation: 'other/1'}), {...pinned(), appId: 'x'}, null])
    assert.throws(() => createShieldCapacity({config: bad, base: 'http://x', dataAddr: 'y', client}), /invalid pinned capacity partition/);
});

test('the manager sizes by policy alone only the pinned witness and the capacity app its operator pinned', () => {
  assert.equal(hostOwnedSpawn('shield-readiness-v1', READINESS_WITNESS_APP_ID), 'witness');
  assert.equal(hostOwnedSpawn(HOST_CAPACITY_NAME, APP, {hostCapacityAppId: APP}), 'capacity');
  assert.equal(hostOwnedSpawn(HOST_CAPACITY_NAME, APP), null);                                         // no capacity app pinned
  assert.equal(hostOwnedSpawn(HOST_CAPACITY_NAME, 'ee'.repeat(32), {hostCapacityAppId: APP}), null);  // another app under the name
  assert.equal(hostOwnedSpawn('0x' + '11'.repeat(32), APP, {hostCapacityAppId: APP}), null);          // the app under a deployment's name
  assert.equal(hostOwnedSpawn('shield-readiness-v1', APP, {hostCapacityAppId: APP}), null);
  assert.equal(hostOwnedSpawn(HOST_CAPACITY_NAME, READINESS_WITNESS_APP_ID, {hostCapacityAppId: READINESS_WITNESS_APP_ID}), null);
});
