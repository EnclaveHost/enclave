// The explicit local-verifier chain authority across the remaining launch boundaries that filter or rebuild a child's
// configuration: the measured guest's platform API (bound relayEnv -> native issuer host policy AND relay child), the
// relays (api-relay network LeaseReader, dns-relay app-zone LeaseReader), the challenge replica (config -> dns-relay
// child env -> its reader), the host-services directory replica (role config -> directory-server process) and the native
// profile tool. Processes are the real entry points started from a flat relay directory with a freshly built runtime
// bundle (relay/build-network.mjs), never the source text. A stand-in verifier counts what it is asked and refuses, so a
// refusal must stay a refusal: no provider is contacted after it, and the default quorum never touches the verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as MC from '../metal/guest/measured-control.mjs';
import { relayChildEnv, CHAIN_AUTHORITY_ENV } from '../metal/guest/platform-api-role.mjs';
import { issuerDeps } from '../metal/guest/native-issuer.mjs';
import { challengeReplicaConfig, challengeReplicaEnv, hostPolicyGateEnv } from '../network/challenge-replica-host.mjs';
import { resolveHostPolicyConfig } from '../network/platform-host-policy-config.mjs';
import { ROLES } from '../network/host-services/roles.mjs';
import { prepareNativeProfile } from '../scripts/network/native-profile.mjs';
import { flatRelay as flatRelayIn } from './helpers/relay-flat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'native-relay-chain-'));
const servers = new Set(), children = new Set();
test.after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// A JSON-RPC endpoint that records every method it is asked and refuses each one.
async function refusingRpc() {
  const calls = [];
  const s = http.createServer((req, res) => {
    const c = []; req.on('data', (d) => c.push(d));
    req.on('end', () => {
      let q; try { q = JSON.parse(Buffer.concat(c).toString() || 'null'); } catch { q = null; }
      const one = (m) => { calls.push(m?.method); return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32000, message: 'stand-in refuses' } }; };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  servers.add(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}/`, calls };
}
// Run a process until `until` matches its output or it exits; -> { out, code (null while running) }.
function run(argv, { env, cwd, until = null, ms = 30000 }) {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(c);
    let out = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ out, code, child: c }); };
    const t = setTimeout(() => finish(null), ms);
    const on = (d) => { out += d; if (until && until.test(out)) finish(null); };
    c.stdout.on('data', on); c.stderr.on('data', on); c.on('exit', (code) => finish(code ?? -1));
  });
}
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

let flat = null;
const flatRelay = () => (flat ||= flatRelayIn(tmp));

// ---- measured guest: bound relayEnv, native issuer, relay child ------------------------------------------------------
const OPS = [...Array(3)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const rawConfig = (relayEnv) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32), replicas: { gateways: ['https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://host-0.example.org', repo: 'owner/enclave', operator: OPS[0] }, selling: { cpuPrice6: null, payout: null },
  isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  platformApi: { apiPort: 8098, peerPort: 8099, hostname: 'api.chain.test',
    members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${9440 + i}` })),
    measurements: ['77'.repeat(48)], minTcb: null, admins: [a(0xad)], recovery: ['11'.repeat(32)], archives: [], archiveMs: 30000, relayEnv, leaseMs: 2000 } });

test('measured guest: the bound relayEnv chain authority is validated at bind time; quorum stays the default', () => {
  const ok = MC.canonicalDirectConfig(rawConfig({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' }));
  assert.equal(ok.platformApi.relayEnv.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/');
  assert.equal(MC.canonicalDirectConfig(rawConfig({})).platformApi.relayEnv.ENCLAVE_CHAIN_AUTHORITY, undefined);
  MC.canonicalDirectConfig(rawConfig({ ENCLAVE_CHAIN_AUTHORITY: 'quorum' }));
  for (const [env, why] of [[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local \(loopback\)/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'verifier' }, /local \(loopback\)/],
    [{ ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' }, /not verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'quorum', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' }, /not verifier/],
    [{ ENCLAVE_CHAIN_AUTHORITY: 'helios' }, /verifier or quorum/]])
    assert.throws(() => MC.canonicalDirectConfig(rawConfig(env)), why);
});

test('relay child: the chain authority is exactly the bound one; a sealed credential can neither set nor change it', () => {
  const bound = { relayEnvBase: { BASE_RPC: 'https://rpc-a.example/v1' }, platformApi: { relayEnv: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/' } } };
  const credEnv = { ENCLAVE_CHAIN_AUTHORITY: 'quorum', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:9999/', NATIVE_CA_KEY: 'k', RELEASE_SIGNING_SEED_FILE: '/run/x' };
  const env = relayChildEnv({ cfg: bound, credEnv, dataDir: '/data' });
  assert.equal(env.ENCLAVE_CHAIN_AUTHORITY, 'verifier'); assert.equal(env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/');
  assert.equal(env.NATIVE_CA_KEY, undefined); assert.equal(env.RELEASE_SIGNING_SEED_FILE, '/run/x'); assert.equal(env.BASE_RPC, 'https://rpc-a.example/v1');
  const unbound = relayChildEnv({ cfg: { relayEnvBase: {}, platformApi: { relayEnv: {} } }, credEnv, dataDir: '/data' });
  for (const k of CHAIN_AUTHORITY_ENV) assert.equal(unbound[k], undefined, `${k} from a credential alone never reaches the relay`);
});

test('native issuer: the host decision reads the policy through the bound verifier, never the RPC quorum; quorum default never asks the verifier', async () => {
  const pa = MC.canonicalDirectConfig(rawConfig({})).platformApi;
  const ownConfig = { rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, contracts: { registry: a(0x11) } };
  const host = '0x' + 'ab'.repeat(32);
  const decide = async (policyEnv) => {
    let fetched = 0; const fetch = async () => { fetched++; throw new Error('no mirror in this test'); };
    const deps = await issuerDeps({ platformApi: pa, ownConfig, policyEnv, collateral: {}, registry: {}, fetch, log: () => {} });
    // a refused chain read is a refusal either way: decideHost throws (no decision) or answers admit:false
    const d = await deps.decideHost(host, { chipId: null }).catch((e) => ({ admit: false, threw: e.message }));
    return { d, fetched };
  };
  const v = await refusingRpc(), q = await refusingRpc();
  const rpcs = q.url;   // the policy's own RPC list (one loopback stand-in; one host is one vote)
  const viaVerifier = await decide({ BASE_RPC: 'https://rpc-a.example/v1', ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rpcs });
  assert.equal(viaVerifier.d.admit, false, 'a verifier refusal admits nothing');
  assert.match(String(viaVerifier.d.threw || viaVerifier.d.reason), /verif|chain_/i, 'and says why');
  assert.equal(viaVerifier.fetched, 0, 'no policy document is fetched without a verified anchor');
  assert.ok(v.calls.length > 0, 'the verifier was asked');
  assert.equal(q.calls.length, 0, 'no provider was asked after (or instead of) the verifier');
  const asked = v.calls.length;
  const viaQuorum = await decide({ BASE_RPC: 'https://rpc-a.example/v1', ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rpcs });
  assert.equal(viaQuorum.d.admit, false);
  assert.ok(q.calls.length > 0, 'the default reads the configured quorum');
  assert.equal(v.calls.length, asked, 'the default never asks the verifier');
});

// ---- relays: real processes from the flat directory --------------------------------------------------------------------
async function apiRelay(env) {
  const dir = flatRelay(), port = await freePort();
  return run([process.execPath, path.join(dir, 'api-relay.js')], { cwd: dir, until: /\[chain\] network lease reader: .*\n|\[api-relay\] :\d+/, ms: 45000,
    env: { PATH: process.env.PATH, HOME: dir, ENCLAVES: 'http://127.0.0.1:1', API_RELAY_PORT: String(port), API_RELAY_BIND: '127.0.0.1', RPC_FALLBACKS: '0',
      BASE_RPC: 'http://127.0.0.1:1', DEPLOYMENTS_ADDRESS: a(0x12), FEATURED_VIEWS_FILE: path.join(dir, `views-${port}.json`), ...env } });
}

test('api-relay process: the network LeaseReader takes the explicit local verifier with no provider client; misconfiguration stops the relay', { timeout: 240000 }, async () => {
  const book = { ADDRESS_BOOK_ADDRESS: a(0xb00c) };
  const q = await apiRelay({ ...book });
  assert.match(q.out, /\[chain\] network lease reader: provider-quorum \(provider-reported tier\)/, q.out.slice(-800));
  const v = await refusingRpc();
  const ok = await apiRelay({ ...book, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, NETWORK_CHAIN_RPCS: 'https://rpc-a.invalid,https://rpc-b.invalid' });
  assert.match(ok.out, /\[chain\] network lease reader: local-verifier \(unsafe tier, proof-backed, no provider fallback\)/, ok.out.slice(-800));
  for (const [env, why] of [[{ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url }, /needs ADDRESS_BOOK_ADDRESS/],
    [{ ...book, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' }, /local endpoint/],
    [{ ...book, ENCLAVE_CHAIN_VERIFIER: v.url }, /not verifier/]]) {
    const r = await apiRelay(env);
    await waitFor(() => r.child.exitCode !== null);
    assert.equal(r.child.exitCode, 1, r.out.slice(-800)); assert.match(r.out, /fatal: network chain authority: /); assert.match(r.out, why);
  }
});

// The challenge replica's configuration -> its child's COMPLETE environment -> the real dns-relay process.
const replicaRaw = async (extra = {}) => ({ role: 'app-zone-replica', release: { dir: '/opt/replica', dnsSha256: 'aa'.repeat(32), runtimeBundleSha256: 'bb'.repeat(32) },
  zones: { app: 'app.chain.test', ip: 'ip.chain.test' }, ns: { name: 'ns1.chain.test' }, listen: { dns: `127.0.0.1:${await freePort()}`, api: `127.0.0.1:${await freePort()}` },
  front: { listen: '127.0.0.1:8443', certFile: '/etc/c.pem', keyFile: '/etc/k.pem', origin: 'https://ns1.chain.test' }, routeMap: 'http://127.0.0.1:1/v1/network/routes',
  snp: { measurements: ['77'.repeat(48)] }, chain: { rpcs: ['https://rpc-a.invalid/', 'https://rpc-b.invalid/'], pins: { addressBook: a(0xb00c), deployments: a(0x12), registry: a(0x11), catalog: a(0x13) } },
  hostPolicy: { policy: 'off' }, ...extra });

test('challenge replica: explicit verifier config reaches the gate env and the dns-relay child env; ambiguous, remote or unused is refused', async () => {
  const base = await replicaRaw();
  const q = challengeReplicaConfig(base);
  assert.equal(q.chainVerifier, null); assert.equal(challengeReplicaEnv(q).ENCLAVE_CHAIN_AUTHORITY, undefined);
  const { rpcs: _drop, ...pinsOnly } = base.chain;
  const v = challengeReplicaConfig({ ...base, chain: pinsOnly, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  const env = challengeReplicaEnv(v, { basePath: '/usr/bin' });
  assert.equal(env.ENCLAVE_CHAIN_AUTHORITY, 'verifier'); assert.equal(env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/'); assert.equal(env.APP_CHALLENGE_RPCS, '');
  const gated = challengeReplicaConfig({ ...base, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/',
    hostPolicy: { policy: 'production', endpoint: 'https://host.chain.test', stateDir: '/var/lib/hp' } });
  const g = hostPolicyGateEnv(gated.hostPolicy);
  assert.equal(g.env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/'); assert.equal(g.shape.chainAuthority, 'verifier');
  const resolved = resolveHostPolicyConfig({ env: g.env, chainId: 8453 });
  assert.equal(resolved.config.chainAuthority, 'verifier', 'the gate resolves the verifier authority');
  for (const [extra, why] of [[{ chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org/' }, /local endpoint/],
    [{ chainVerifier: 'http://127.0.0.1:8545/' }, /not verifier/], [{ chainAuthority: 'verifier' }, /needs chainVerifier/], [{ chain: pinsOnly }, /chain.rpcs must name/]])
    assert.throws(() => challengeReplicaConfig({ ...base, ...extra }), why);
  // the owner responder: its Shield registry read follows the verifier too (shield.rpcs then optional); with neither a
  // Shield read nor a host policy there is nothing for a verifier to serve, so naming one is refused as unused
  const shield = { policyFile: '/etc/p.json', profileFile: '/etc/prof.json', profileDigest: 'sha256:' + 'cc'.repeat(32) };
  const owner = { ...base, role: 'owner-responder', zones: { challenge: 'acme.chain.test' } };
  for (const k of ['routeMap', 'chain']) delete owner[k];
  const o = challengeReplicaConfig({ ...owner, shield, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  const oenv = challengeReplicaEnv(o, { basePath: '/usr/bin' });
  assert.equal(oenv.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/'); assert.equal(oenv.ATTESTED_SHIELD_RPCS, '');
  assert.throws(() => challengeReplicaConfig({ ...owner, shield }), /shield.rpcs must name/);
  assert.throws(() => challengeReplicaConfig({ ...owner, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' }), /no chain read of this configuration would use it/);
});

test('dns-relay process (challenge replica child): the app-zone reader reads only the verifier; the default never asks it; a remote URL stops it', { timeout: 240000 }, async () => {
  const dir = flatRelay(), v = await refusingRpc();
  const base = await replicaRaw();
  const { rpcs: _drop, ...pinsOnly } = base.chain;
  const start = async (raw, over = {}) => {
    const env = { ...challengeReplicaEnv(challengeReplicaConfig(raw), { basePath: process.env.PATH }), ...over };
    return run([process.execPath, path.join(dir, 'dns-relay.js')], { cwd: dir, env, until: /app-zone ledger index: [^\n]*\n/, ms: 45000 });
  };
  const r = await start({ ...base, chain: pinsOnly, chainAuthority: 'verifier', chainVerifier: v.url });
  assert.match(r.out, /\[dns-relay\] app-zone chain reads: local-verifier \(unsafe tier, proof-backed, no provider fallback\)/, r.out.slice(-800));
  assert.ok(await waitFor(() => v.calls.length > 0), 'the forced first ledger sync asked the verifier');
  assert.match(r.out, /app-zone ledger index: .*(verif|chain_)/i, 'the refusal is reported as a refusal');
  r.child.kill('SIGKILL');
  const asked = v.calls.length;
  const q = await start(await replicaRaw());
  assert.match(q.out, /\[dns-relay\] app-zone chain reads: provider-quorum/, q.out.slice(-800));
  q.child.kill('SIGKILL');
  assert.equal(v.calls.length, asked, 'the default quorum never asks the verifier');
  const bad = await start({ ...base, chain: pinsOnly, chainAuthority: 'verifier', chainVerifier: v.url }, { ENCLAVE_CHAIN_VERIFIER: 'https://rpc.example.org/' });
  await waitFor(() => bad.child.exitCode !== null);
  assert.equal(bad.child.exitCode, 1, bad.out.slice(-800)); assert.match(bad.out, /fatal: APP_CHALLENGE_AUTH: .*local endpoint/);
});

// ---- host-services directory replica: role config -> directory-server process --------------------------------------------
test('directory replica role: explicit verifier passes the role filter into the directory-server process; rpc optional only then', { timeout: 120000 }, async () => {
  const role = ROLES['directory-replica'];
  const common = { bind: '127.0.0.1', addressBook: a(0xb00c), checkers: [a(0xc4)] };
  const startDir = async (c) => {
    const cfg = role.validate({ ...c, port: await freePort(), stateDir: fs.mkdtempSync(path.join(tmp, 'dir-')) });
    const file = path.join(tmp, `dir-${cfg.port}.json`); fs.writeFileSync(file, JSON.stringify(role.launch(cfg).configFile));
    return { cfg, r: await run([process.execPath, path.join(ROOT, 'network/directory-server.mjs'), file], { cwd: ROOT, env: { PATH: process.env.PATH }, until: /chain reads: [^\n]*\n/, ms: 30000 }) };
  };
  const v = await startDir({ ...common, chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  assert.equal(v.cfg.rpc, undefined); assert.equal(v.cfg.chainVerifier, 'http://127.0.0.1:8545/');
  assert.match(v.r.out, /chain reads: local-verifier \(unsafe tier, proof-backed, no provider fallback\)/, v.r.out.slice(-600));
  const q = await startDir({ ...common, rpc: ['https://rpc-a.invalid', 'https://rpc-b.invalid'] });
  assert.match(q.r.out, /chain reads: provider-quorum/, q.r.out.slice(-600));
  for (const [c, why] of [[{ ...common, chainAuthority: 'verifier', chainVerifier: 'https://rpc.example.org/' }, /local endpoint/],
    [{ ...common, rpc: ['https://rpc-a.invalid', 'https://rpc-b.invalid'], chainVerifier: 'http://127.0.0.1:8545/' }, /not verifier/], [{ ...common }, /rpc is required/]])
    assert.throws(() => role.validate({ ...c, port: 1234, stateDir: '/var/lib/dir' }), why);
});

// ---- native profile tool -------------------------------------------------------------------------------------------------
test('native-profile: --chain-verifier makes its own lease reads use the verifier (refusal stays a refusal) and is refused if remote or conflicting', async () => {
  const v = await refusingRpc();
  const input = { version: 1, deploymentId: '0x' + '06'.repeat(32), chainId: 8453, hostname: 'never-resolve.invalid', stateDir: path.join(tmp, 'np'),
    authorityPins: { deployments: a(0x12), registry: a(0x11), connectivity: a(0), sessionVaultFactory: a(0) }, rpc: ['https://rpc-a.invalid', 'https://rpc-b.invalid'],
    directories: ['http://192.0.2.1:8188'], checkers: [a(0xc4)], linux: {}, startup: { packageBase64: Buffer.from('x').toString('base64') } };
  const opts = { releaseDir: '/nonexistent', bundleFile: '/nonexistent', releaseId: 'ab'.repeat(32), vcpus: 1, measure: async () => { throw new Error('must not measure'); } };
  await assert.rejects(prepareNativeProfile(input, { ...opts, chainVerifier: v.url }), (e) => !/must not measure/.test(e.message));
  assert.ok(v.calls.length > 0, 'the deployment read asked the verifier');
  await assert.rejects(prepareNativeProfile(input, { ...opts, chainVerifier: 'https://rpc.example.org/' }), /local endpoint/);
  await assert.rejects(prepareNativeProfile({ ...input, chainAuthority: 'quorum' }, { ...opts, chainVerifier: v.url }), /conflicts/);
});
