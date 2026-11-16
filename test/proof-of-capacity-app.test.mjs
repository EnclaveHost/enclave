// The served-app check of a capacity check (network/proof-of-capacity-app.mjs): what counts against a host, and what
// is not judged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppCheck, pickApp, APP_CHECK} from '../network/proof-of-capacity-app.mjs';

const H = n => '0x' + String(n).padStart(2, '0').repeat(32);
const checker = H(1), target = H(2), seed = H(9), apps = [H(31), H(32), H(33)];
const row = {endpoint: 'https://api.example/t/box-a', proofKey: '0x' + '1'.repeat(40)};
const future = Math.floor(Date.now() / 1000) + 3600;
const lease = (over = {}) => async id => ({runner: target, leaseUntil: future, active: true, isPublic: true, id, ...over});
const relay = (answer = {name: 'box-a', mode: 'snp', apps: apps.map(id => ({id, appRef: 'x@1'}))}, seen = []) => async url => {
  seen.push(String(url));
  if (answer instanceof Error) throw answer;
  return {ok: true, status: 200, json: async () => answer};
};
const verdict = (status, checks = {}, reasons = []) => ({status, checks, reasons, omissions: status === 'limited' ? ['expected-guest-relay-predicted'] : [], summary: status});
const verifierOf = (v, calls = []) => Object.fromEntries(['verifySnpAppWeb', 'verifyShieldAppWeb', 'verifyPvmAppWeb'].map(k => [k, async a => { calls.push([k, a]); return typeof v === 'function' ? v(a) : v; }]));
const make = (o = {}) => createAppCheck({host: checker, apiBase: 'https://api.example', leaseOf: lease(), fetch: relay(), verifier: verifierOf(verdict('limited', {chain: true})), ...o});

test('an app the ledger leases to the host, verified: a pass that names the app and what the verdict leans on', async () => {
  const calls = [], seen = [];
  const r = await make({fetch: relay(undefined, seen), verifier: verifierOf(verdict('limited', {chain: true, binding: true}), calls)})(target, row, {epoch: 4, seed});
  assert.equal(r.name, APP_CHECK); assert.equal(r.ok, true);
  assert.deepEqual(seen, ['https://api.example/v1/enclaves/box-a/apps']);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'verifySnpAppWeb');
  assert.equal(calls[0][1].name, 'box-a'); assert.equal(calls[0][1].deployment, pickApp(apps, seed, checker));
  assert.equal(r.evidence.deployment, calls[0][1].deployment); assert.equal(r.evidence.of, 3); assert.equal(r.evidence.status, 'limited');
  assert.deepEqual(r.evidence.omissions, ['expected-guest-relay-predicted']);
});

test('the app is chosen by the seed and the checker: the same for one checker in one epoch, not the same for all', () => {
  const many = Array.from({length: 40}, (_, i) => '0x' + (i + 16).toString(16).padStart(2, '0').repeat(32));
  assert.equal(pickApp(many, seed, checker), pickApp([...many].reverse(), seed, checker));
  const picks = new Set(Array.from({length: 12}, (_, i) => pickApp(many, H(40 + i), checker)));
  assert.ok(picks.size > 3);
  assert.notEqual(pickApp(many, seed, checker), pickApp(many, seed, H(7)));
  assert.equal(pickApp([], seed, checker), null);
});

test('each kind of host is verified by its own verifier', async () => {
  for (const [mode, fn] of [['snp', 'verifySnpAppWeb'], ['hv-node', 'verifyShieldAppWeb'], ['avf', 'verifyPvmAppWeb']]) {
    const calls = [];
    const r = await make({fetch: relay({mode, apps: [{id: apps[0]}]}), verifier: verifierOf(verdict('limited'), calls)})(target, row, {epoch: 1, seed});
    assert.equal(r.ok, true); assert.equal(calls[0][0], fn);
  }
  const r = await make({fetch: relay({mode: 'tdx', apps: [{id: apps[0]}]})})(target, row, {epoch: 1, seed});
  assert.equal(r.ok, null); assert.match(r.why, /no app verifier/);
});

test('evidence that was read and refused fails the host; with enforce off it is recorded and not judged', async () => {
  const refused = verdict('rejected', {chain: true, binding: false, 'host data': false}, ['REJECT: report does not bind the handshake key']);
  const r = await make({verifier: verifierOf(refused)})(target, row, {epoch: 1, seed});
  assert.equal(r.ok, false); assert.match(r.why, /does not bind/); assert.deepEqual(r.evidence.failed, ['binding', 'host data']);
  const soft = await make({verifier: verifierOf(refused), enforce: false})(target, row, {epoch: 1, seed});
  assert.equal(soft.ok, null); assert.match(soft.why, /recorded, not enforced/); assert.deepEqual(soft.evidence.failed, ['binding', 'host data']);
});

test('what the checker or the relay could not do is never held against the host', async () => {
  const cases = [
    [{verifier: verifierOf(verdict('error', {}, ['app attestation: busy']))}, /busy/],
    [{verifier: verifierOf(verdict('rejected', {server: true}, ['the relay answered for another nonce']))}, /another nonce/],   // refused, but no check failed
    [{verifier: verifierOf(verdict('unsupported'))}, /unsupported/],
    [{verifier: verifierOf(() => { throw new Error('boom'); })}, /the verifier: boom/],
    [{verifier: {}}, /has no verifySnpAppWeb/],
    [{fetch: relay(new Error('connect ECONNREFUSED'))}, /list of the host's apps/],
    [{fetch: relay({mode: 'snp', apps: []})}, /no public app is leased/],
    [{leaseOf: lease({runner: H(5)})}, /no public app is leased/],              // the relay lists it, the ledger says another host
    [{leaseOf: lease({leaseUntil: Math.floor(Date.now() / 1000) + 5})}, /no public app is leased/],   // the lease ends inside the check
    [{leaseOf: lease({isPublic: false})}, /no public app is leased/],
    [{leaseOf: async () => { throw new Error('rpc down'); }}, /ledger's record/],
  ];
  for (const [o, why] of cases) {
    const r = await make(o)(target, row, {epoch: 1, seed});
    assert.equal(r.ok, null, String(why)); assert.match(r.why, why);
  }
});

test('the box is the endpoint\'s /t/<name>, else the relay\'s row with the host\'s id', async () => {
  const seen = [];
  const fetch = async url => { seen.push(String(url));
    return {ok: true, status: 200, json: async () => (String(url).endsWith('/enclaves') ? {enclaves: [{id: H(3), name: 'other'}, {id: target, name: 'metal-x'}]} : {mode: 'snp', apps: [{id: apps[0]}]})}; };
  const calls = [];
  const r = await make({fetch, verifier: verifierOf(verdict('verified'), calls)})(target, {endpoint: 'https://metal-x.example'}, {epoch: 1, seed});
  assert.equal(r.ok, true); assert.equal(calls[0][1].name, 'metal-x');
  assert.deepEqual(seen, ['https://api.example/enclaves', 'https://api.example/v1/enclaves/metal-x/apps']);
  const none = await make({fetch: async () => ({ok: true, status: 200, json: async () => ({enclaves: []})})})(target, {endpoint: 'https://metal-x.example'}, {epoch: 1, seed});
  assert.equal(none.ok, null); assert.match(none.why, /no box/);
});

test('the independent verifier as shipped loads under Node and answers a dead relay with "not judged"', async () => {
  const check = createAppCheck({host: checker, apiBase: 'https://api.example', leaseOf: lease(),
    verifier: () => import('../verifier/web/dist/enclave-verifier-web.js'),
    fetch: async url => { if (String(url).endsWith('/apps')) return {ok: true, status: 200, json: async () => ({mode: 'snp', apps: [{id: apps[0]}]})}; throw new Error('down'); },
    timeoutMs: 4000});
  const r = await check(target, row, {epoch: 1, seed});
  assert.equal(r.ok, null); assert.equal(r.evidence.status, 'error');
});

test('it is built only with a host id, an https relay and a ledger reader', () => {
  assert.throws(() => createAppCheck({host: checker, apiBase: 'http://api.example', leaseOf: lease()}));
  assert.throws(() => createAppCheck({host: checker, apiBase: 'https://api.example'}));
  assert.throws(() => createAppCheck({host: 'x', apiBase: 'https://api.example', leaseOf: lease()}));
});
