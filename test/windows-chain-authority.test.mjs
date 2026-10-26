// The Windows node's explicit local-verifier chain authority, through its REAL modules and shipped admission bundle:
// windows/node/chain.mjs (state vs transaction/history clients), chain-reader.mjs (agreed() readers for owner-committed
// startup, ownership and check-endpoint), session-api-auth.mjs (coherent snapshot mode), network-enroll.mjs (the network
// agent's chain section), agent.mjs startup refusal, and the deploy-files closure that ships them. Child processes load the
// chain module under each environment exactly as a node does. Loopback stand-ins count every request: under the verifier
// the provider list (BASE_RPCS) is never contacted, a refusal stays a refusal, and pending-pool, fee and submission work goes only
// to the bound own backend (ENCLAVE_CHAIN_TX_BACKEND); the obsolete ENCLAVE_CHAIN_TX_RPCS is refused (r9 composition). Non-native boundary: Node on Linux, not a Windows host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chainReader, chainAuthorityOf } from '../windows/node/chain-reader.mjs';
import { baseConfig, createNetworkEnroll, agentChain } from '../windows/node/network-enroll.mjs';
import { createSessionApiAuth } from '../windows/node/session-api-auth.mjs';
import { closure } from '../windows/node/deploy-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = path.join(ROOT, 'test/helpers/windows-chain-driver.mjs');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'win-chain-'));
const servers = new Set();
test.after(() => { for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const PINS = { version: 1, chainId: 8453, contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14),
  enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) } };
const pinsFile = path.join(tmp, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(PINS));

// A JSON-RPC stand-in that records every method and refuses each one (a verifier, a provider or a transaction transport).
async function stand(host = '127.0.0.1') {
  const calls = [];
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    let q; try { q = JSON.parse(Buffer.concat(c).toString() || 'null'); } catch { q = null; }
    const one = (m) => { calls.push(m?.method); return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32000, message: 'stand-in refuses' } }; };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  servers.add(s); await new Promise((r) => s.listen(0, host, r));
  return { url: `http://${host}:${s.address().port}/`, calls };
}
const drive = (ops, env, nodeDir) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [DRIVER, JSON.stringify(ops), ...(nodeDir ? [nodeDir] : [])], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('exit', () => { try { resolve(Object.fromEntries(JSON.parse(out).results.map((r) => [r.op, r]))); } catch { reject(new Error(`driver: ${err.slice(-800)}`)); } });
});
const ID = '0x' + 'ab'.repeat(32), ADDR = a(0x77);

test('legacy default is unchanged: state and transaction work go to BASE_RPCS; the verifier is never asked', { timeout: 60000 }, async () => {
  const p1 = await stand(), p2 = await stand(), v = await stand();
  const r = await drive([{ op: 'authority' }, { op: 'resolveAddresses' }, { op: 'readEnclave', id: ID }, { op: 'txNonce', address: ADDR }],
    { BASE_RPCS: `${p1.url},${p2.url}`, ENCLAVE_CONTRACT_PINS_FILE: pinsFile });
  assert.equal(r.authority.value.authority.authority, 'provider-fallback');
  assert.deepEqual(r.authority.value.rpcUrls, [p1.url, p2.url]);
  assert.equal(r.readEnclave.ok, false);
  assert.ok(p1.calls.length + p2.calls.length > 0, 'the provider list was used');
  assert.equal(v.calls.length, 0);
});

test('verifier mode: every state read asks only the verifier (a refusal stays a refusal); pool/fee/submission work refuses without the bound own backend', { timeout: 60000 }, async () => {
  const p1 = await stand(), p2 = await stand(), v = await stand();
  const env = { BASE_RPCS: `${p1.url},${p2.url}`, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url };
  const r = await drive([{ op: 'authority' }, { op: 'resolveAddresses' }, { op: 'readEnclave', id: ID }, { op: 'readDeployment', id: ID },
    { op: 'claimableBy', id: ID, enclaveId: ID }, { op: 'allDeployments' }, { op: 'resolveAppRef', appRef: `catalog://${ID}/1` },
    { op: 'stateTx', address: ADDR }, { op: 'txNonce', address: ADDR }, { op: 'txLogs', id: ID }, { op: 'txPending', address: ADDR }, { op: 'gate' }], env);
  assert.equal(r.authority.value.authority.authority, 'local-verifier');
  assert.equal(r.authority.value.authority.tier, 'unsafe');
  assert.deepEqual(r.authority.value.rpcUrls, [], 'no provider is a read source');
  assert.equal(r.resolveAddresses.ok, true, 'pinned addresses need no chain read');
  for (const op of ['readEnclave', 'readDeployment', 'claimableBy', 'allDeployments', 'resolveAppRef']) {
    assert.equal(r[op].ok, false, op); assert.match(r[op].error, /verified chain state|verifier/i, op);
  }
  // INTENTIONAL API CHANGE (r9): the node's ONE client is the explicit authority's routed client, so a plain nonce and history are
  // proven by the verifier (refused here by the verifier stand-in) and pool/fee/submission work needs the BOUND own backend
  for (const op of ['stateTx', 'txNonce', 'txLogs']) assert.equal(r[op].ok, false, op);
  assert.match(r.txPending.error, /pending pool is only known to an own transaction backend \(ENCLAVE_CHAIN_TX_BACKEND unset\)/);
  assert.equal(r.gate.ok, false, 'no backend: the send gate refuses');
  assert.ok(!v.calls.includes('eth_sendRawTransaction'), 'nothing was submitted anywhere');
  assert.ok(v.calls.length > 0, 'the verifier was asked');
  assert.equal(p1.calls.length + p2.calls.length, 0, 'BASE_RPCS was never contacted');
});

test('verifier mode + own backend: pool work goes ONLY to the backend, nothing is sent before the backend is bound, BASE_RPCS never', { timeout: 60000 }, async () => {
  const p1 = await stand(), v = await stand(), be = await stand();
  const r = await drive([{ op: 'txPending', address: ADDR }, { op: 'txNonce', address: ADDR }, { op: 'txLogs', id: ID }, { op: 'gate' }],
    { BASE_RPCS: p1.url, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_CHAIN_TX_BACKEND: be.url });
  for (const op of ['txPending', 'txNonce', 'txLogs', 'gate']) assert.equal(r[op].ok, false, op);   // the stand-ins refuse every method
  assert.ok(be.calls.length > 0, 'the own backend was asked for the pending-pool nonce');
  assert.ok(be.calls.every((m) => m !== 'eth_sendRawTransaction') && v.calls.every((m) => m !== 'eth_sendRawTransaction'), 'nothing was submitted: an unbound backend never receives a transaction');
  assert.ok(v.calls.length > 0, 'plain nonce and history went to the verifier');
  assert.equal(p1.calls.length, 0, 'BASE_RPCS was never contacted');
});

test('verifier mode with the OBSOLETE ENCLAVE_CHAIN_TX_RPCS: the selection is refused explicitly - nothing is read or sent, no request anywhere', { timeout: 60000 }, async () => {
  const p1 = await stand(), v = await stand(), tx = await stand();
  const r = await drive([{ op: 'authority' }, { op: 'readEnclave', id: ID }, { op: 'txPending', address: ADDR }, { op: 'gate' }],
    { BASE_RPCS: p1.url, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_CHAIN_TX_RPCS: tx.url });
  assert.equal(r.authority.value.authority.authority, 'refusing');
  assert.match(r.authority.value.authority.why, /ENCLAVE_CHAIN_TX_RPCS is obsolete/);
  assert.deepEqual(r.authority.value.rpcUrls, [], 'no provider list is handed out');
  for (const op of ['readEnclave', 'txPending', 'gate']) assert.equal(r[op].ok, false, op);
  assert.equal(tx.calls.length + p1.calls.length + v.calls.length, 0, 'no request anywhere: the obsolete list is never used');
});

test('an ambiguous, remote or malformed authority REFUSES every chain read (INTENTIONAL API CHANGE: a refusing authority, not a load-time throw), and the agent does not start', { timeout: 60000 }, async () => {
  for (const [env, why] of [[{ ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' }, /not verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local endpoint|loopback/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, /needs (ENCLAVE_CHAIN_VERIFIER|chainVerifier)/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/', ENCLAVE_CHAIN_TX_RPCS: 'ftp://x' }, /ENCLAVE_CHAIN_TX_RPCS is obsolete/]]) {
    const r = await drive([{ op: 'authority' }, { op: 'readEnclave', id: ID }], { ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ...env });
    assert.equal(r.authority.value.authority.authority, 'refusing'); assert.match(r.authority.value.authority.why, why);
    assert.equal(r.readEnclave.ok, false, 'every chain read refuses');
  }
  const agent = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'windows/node/agent.mjs')], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: tmp, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 30000); c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  assert.notEqual(agent.code, 0, agent.out.slice(-500)); assert.match(agent.out, /INVALID .*(local endpoint|loopback)/);
});

test('chain-reader: the verifier reader is the shared LeaseReader and builds no RPC client; the legacy quorum still does', async () => {
  const env = { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' };
  const v = await chainReader({ rpcs: ['not a url at all'], env });      // rpcClients would throw on this list: it is never called
  assert.equal(v.authority, 'verifier'); assert.equal(v.clients.length, 0); assert.equal(typeof v.agreed, 'function');
  assert.deepEqual(chainAuthorityOf(env), { authority: 'local-verifier', verifier: 'http://127.0.0.1:8545/', tier: 'unsafe' });
  await assert.rejects(chainReader({ rpcs: ['not a url at all'], env: {} }), /RPC|https/);
  const q = await chainReader({ rpcs: ['https://rpc-a.example.org', 'https://rpc-b.example.org'], env: {} });
  assert.equal(q.authority, undefined); assert.equal(typeof q.agreed, 'function');
  assert.throws(() => chainAuthorityOf({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://x.example/' }), /local endpoint|loopback/);
  assert.throws(() => chainAuthorityOf({ ...env, ENCLAVE_CHAIN_TX_RPCS: 'https://x.example/' }), /ENCLAVE_CHAIN_TX_RPCS is obsolete/);
  await assert.rejects(chainReader({ rpcs: [], env: { ...env, ENCLAVE_CHAIN_TX_RPCS: 'https://x.example/' } }), /ENCLAVE_CHAIN_TX_RPCS is obsolete/);
});

test('check-endpoint (the installer\'s own ownership check) refuses through the verifier and never contacts its --rpc list', { timeout: 60000 }, async () => {
  const v = await stand(), r1 = await stand();
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'windows/node/host-identity.mjs'), 'check-endpoint', '--endpoint', 'https://host.example.org',
      '--operator', ADDR, '--pins', pinsFile, '--rpc', `${r1.url.replace('http:', 'https:')},https://other.example.org`], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url } });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('exit', (code) => resolve({ code, o }));
  });
  assert.equal(out.code, 1, out.o); assert.match(out.o, /identity: .*verified chain state/);
  assert.ok(v.calls.length > 0); assert.equal(r1.calls.length, 0);
});

test('network enrollment: the agent\'s chain section carries the verifier instead of the RPC list; a switch restarts the agent once', async () => {
  const common = { agentDir: path.join(tmp, 'agent'), binDir: path.join(tmp, 'bin'), nodeBinary: process.execPath, operatorKeyFile: path.join(tmp, 'op.key'),
    runner: ID, endpoint: 'https://host.example.org', relayBase: 'https://relay.example.org', policyFile: path.join(tmp, 'p.json'), tpmBinary: 'tpm.exe', tpmSha256: 'aa'.repeat(32),
    addressBook: a(0xb00c), chainRpc: ['https://rpc-a.example.org', 'https://rpc-b.example.org'], enclaveNetwork: { checkers: [a(0xc4)] } };
  const verifier = { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' };   // INTENTIONAL API CHANGE: chainAuthoritySelection() shape
  assert.deepEqual(baseConfig({ ...common, chainRpc: [], chainAuthority: verifier }).chain, { addressBook: a(0xb00c), authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.deepEqual(baseConfig(common).chain, { addressBook: a(0xb00c), rpc: common.chainRpc });
  assert.throws(() => agentChain({ addressBook: a(0xb00c), chainRpc: [], chainAuthority: { authority: 'verifier', verifier: 'https://x.example/' } }), /loopback/);
  assert.throws(() => agentChain({ addressBook: a(0xb00c), chainRpc: common.chainRpc, chainAuthority: verifier }), /never mixed/);
  // an existing box (one enrolled app): legacy config -> verifier -> legacy, each a restart of the agent
  fs.mkdirSync(common.agentDir, { recursive: true });
  fs.writeFileSync(common.policyFile, JSON.stringify({ cpu: { runtimeId: 'aa'.repeat(32) } }));
  const cfgFile = path.join(common.agentDir, 'privacy-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...baseConfig(common), apps: [{ deploymentId: ID, names: [], expectedFile: path.join(tmp, 'e.json'), internetMode: 'enclave-network', publishToMirror: true }] }));
  let restarts = 0;
  const pass = (config) => createNetworkEnroll({ agentDir: common.agentDir, binDir: common.binDir, runner: ID, relayBase: common.relayBase, config,
    rows: async () => [], version: async () => ({}), vms: async () => [], fetch: async () => ({ ok: false }), restartAgent: async () => { restarts++; }, log: () => {} }).pass();
  const read = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).chain;
  await pass({ ...common, chainRpc: [], chainAuthority: verifier });
  assert.deepEqual(read(), { addressBook: a(0xb00c), authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.equal(restarts, 1, 'switching to the verifier restarts the agent once');
  await pass({ ...common, chainRpc: [], chainAuthority: verifier });
  assert.equal(restarts, 1, 'an unchanged verifier changes nothing');
  await pass(common);
  assert.equal(read().authority, undefined); assert.deepEqual(read().rpc, common.chainRpc);
  assert.equal(restarts, 2, 'leaving the verifier restores the RPC list and restarts once');
});

test('session API snapshot mode: each request\'s factory, session and owner facts come from ONE snapshot and are never cached', async () => {
  const sdk = await import('../sdk/sessions/dist/node.mjs');
  const kp = await sdk.generateKeyPair(true); const signer = await sdk.signerFromKeyPair(kp); const { x, y } = await sdk.publicKeyXY(kp.publicKey);
  const VAULT = a(0x5a), SID = '0x' + '5b'.repeat(32), OWNER = a(0x5c), FACTORY = a(0x5d), LEDGER = a(0x12);
  let live = true, snapshots = 0, legacyReads = 0;
  const client = (tag) => ({ readContract: async ({ functionName }) => {
    if (tag === 'legacy') legacyReads++;
    if (functionName === 'isVault') return true;
    if (functionName === 'owner') return OWNER;
    if (functionName === 'sessionOf') return [{ keyHash: sdk.keyHashOf(x, y), actions: (1n << 129n), envs: 2, expiresAt: 9999999999n, anyApp: true }, live, []];
    throw new Error('unexpected ' + functionName);
  } });
  const snapshot = async (fn) => { snapshots++; return fn(client('snap'), 100n); };
  const auth = createSessionApiAuth({ pc: client('legacy'), snapshot, authorityPins: { deployments: LEDGER, sessionVaultFactory: FACTORY }, bases: () => ['api.example.org'] });
  const req = async () => auth.verify({ header: await sdk.signApiRequest(signer, VAULT, SID, 'GET', 'https://api.example.org/v1/x'), method: 'GET', path: '/v1/x', scope: 'api.logs' });
  assert.equal((await req()).owner.toLowerCase(), OWNER);
  live = false;                                                      // the owner ends the session
  await assert.rejects(req(), (e) => e.code === 'session_ended', 'the very next request sees the revocation (no cache)');
  assert.equal(snapshots, 2); assert.equal(legacyReads, 0, 'nothing was read outside the snapshots');
  // legacy (no snapshot): unchanged per-read cache semantics
  live = true; let n = 0;
  const legacy = createSessionApiAuth({ pc: { readContract: async (r) => { n++; return client('x').readContract(r); } }, authorityPins: { deployments: LEDGER, sessionVaultFactory: FACTORY }, bases: () => ['api.example.org'] });
  await legacy.verify({ header: await sdk.signApiRequest(signer, VAULT, SID, 'GET', 'https://api.example.org/v1/x'), method: 'GET', path: '/v1/x', scope: 'api.logs' });
  assert.ok(n > 0);
});

test('the shipped deploy-files closure carries the new reader module and bundle; a staged copy loads the verifier authority', { timeout: 60000 }, async () => {
  const c = closure();
  assert.deepEqual(c.problems, []);
  for (const f of ['windows/node/chain-reader.mjs', 'windows/node/chain-selection.mjs', 'windows/node/chain.mjs', 'windows/node/host-admission.bundle.mjs', 'windows/node/session-api-auth.mjs', 'windows/node/network-enroll.mjs'])
    assert.ok(c.files.includes(f), `${f} ships`);
  assert.ok(!c.files.some((f) => f.startsWith('network/verified-read-client')), 'the shared module ships inside the bundle, not as a loose file');
  const stage = path.join(tmp, 'stage');
  for (const f of c.files) { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(stage, f)); }
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(stage, 'windows/node/node_modules'));
  const v = await stand(), p = await stand();
  const r = await drive([{ op: 'authority' }, { op: 'resolveAddresses' }, { op: 'readEnclave', id: ID }],
    { BASE_RPCS: p.url, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url }, path.join(stage, 'windows/node'));
  assert.equal(r.authority.value.authority.authority, 'local-verifier');
  assert.equal(r.readEnclave.ok, false); assert.ok(v.calls.length > 0); assert.equal(p.calls.length, 0);
});
