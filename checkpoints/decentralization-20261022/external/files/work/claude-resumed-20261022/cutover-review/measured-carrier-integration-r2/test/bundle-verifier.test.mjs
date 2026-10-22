// The GENERATED platform API guest bundle's config verifier (metal/guest/platform-api.bundle.mjs, rebuilt from the changed
// measured-control.mjs), exercised as the ACTUAL bundle process: `node <bundle> --config <role file>`, exactly the argv
// measured-control directPlatformApiLaunch gives gsup. The bundle exports nothing (its entry runs the role), so the bundled
// verifyMeasuredControl is reached the way production reaches it: a member that holds the group key is asked for a HANDOFF by
// a newcomer, and runs productionVerifier -> verifyMeasuredControl({ expect: { config: <the newcomer's presented config> } }).
// What that shows, in the bundle's own order: (expectation) canonicalDirectConfig of the presented config, (evidence) the
// newcomer's control front, (statement) its canonical statement, (config) statement digest == digest(presented config) and
// HOST_DATA derived from it, (endpoint key) the TLS peer is the attested key, then (report) the hardware report.
// The newcomer fronts serve a deliberately MALFORMED (3-byte) report, so every case stops at the report at the latest: nothing here
// is, or could be, accepted; the bundle keeps its real AMD roots and collateral (no test roots, no shortcut). The member's
// handoff answer names the bundle's verdict (rejected: <last three reasons>), which is what the assertions read.
// Fixture side (the newcomer's statement/front, the member's statement and key files) uses the SOURCE helper in this tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import * as hpke from '../custody/hpke.mjs';
import { HANDOFF_PATH } from '../metal/guest/platform-api-role.mjs';

const NEW_BUNDLE = process.env.NEW_BUNDLE, OLD_BUNDLE = process.env.OLD_BUNDLE;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-verifier-'));
const children = [], servers = [];
test.after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const OPS = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const ADMIN = privateKeyToAccount(generatePrivateKey()), REC = hpke.generateKeyPair();
const PEERS_A = ['https://peer-a.example/platform-policy'], PEERS_B = ['https://peer-b.example/platform-policy'];
let PA = null;
const raw = (i, extra = {}) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189'], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: 'owner/enclave', operator: OPS[i] },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' },
  hostAdmissionSha256: null, controlPort: 8444, platformApi: PA, ...extra });
const pathsOf = (d) => ({ ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'),
  tlsCert: path.join(d, 'tls-cert.pem'), platformApiConfig: path.join(d, 'platform-api.json'), platformApiHandoffKey: path.join(d, 'handoff.key'), platformApiDir: path.join(d, 'pa') });

/** a newcomer guest stand-in: its statement binds `bound` (the config it was launched with); its front serves a malformed report */
async function newcomer(i, bound, port) {
  const d = fs.mkdtempSync(path.join(tmp, `n${i}-`)), P = pathsOf(d);
  const config = MC.canonicalDirectConfig(bound), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'snp', keys, runtime: { platformApiSha256: '00'.repeat(32) } });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, mode: 'snp',
    reporter: async () => ({ report: 'AAAA', certs: null }), upstream: { host: '127.0.0.1', port: 9 } });
  await new Promise((r) => front.listen(port, '127.0.0.1', r)); servers.push(front);
  return { digest, hostData };
}
/** the member under test: the ACTUAL bundle as its role process, holding the group key (as after a genesis) */
async function member(bundle) {
  const d = fs.mkdtempSync(path.join(tmp, 'm0-')), P = pathsOf(d);
  const config = MC.canonicalDirectConfig(raw(0)), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  fs.writeFileSync(P.statement, MC.controlStatement({ config, digest, hostData, mode: 'snp', keys, runtime: { platformApiSha256: '00'.repeat(32) } }).text);
  const launch = MC.directPlatformApiLaunch(config, { paths: P, bundle });
  const api = await freePort(), peer = await freePort();
  const roleCfg = { ...JSON.parse(launch.files[P.platformApiConfig]), listen: { api, peer }, askMs: 300 };
  fs.mkdirSync(roleCfg.dirs.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(roleCfg.dirs.root, 'k'), 'cd'.repeat(32), { mode: 0o600 });       // the group key K, as a genesis leaves it
  const cfgFile = path.join(d, 'role.json'); fs.writeFileSync(cfgFile, JSON.stringify(roleCfg));
  assert.deepEqual(launch.argv.slice(1), [bundle, '--config', P.platformApiConfig], 'the argv gsup uses');
  const c = spawn(process.execPath, [bundle, '--config', cfgFile], { cwd: d, env: { PATH: process.env.PATH, HOME: d }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c); let log = ''; c.stdout.on('data', (b) => { log += b; }); c.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 200; i++) {
    if (c.exitCode !== null) throw new Error(`the bundle exited ${c.exitCode}:\n${log.slice(-2000)}`);
    try { await new Promise((ok, no) => { const s = net.connect(peer, '127.0.0.1', () => { s.end(); ok(); }); s.on('error', no); }); break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const handoff = async (config) => {
    const r = await fetch(`http://127.0.0.1:${peer}${HANDOFF_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }) });
    return { status: r.status, body: await r.json() };
  };
  return { handoff, log: () => log };
}

test('the ACTUAL generated bundle verifies the bound platformPolicyCarriers member; the reproduced old bundle refuses it', { timeout: 120_000 }, async () => {
  assert.ok(NEW_BUNDLE && OLD_BUNDLE, 'NEW_BUNDLE / OLD_BUNDLE');
  const ports = [await freePort(), await freePort(), await freePort()];
  PA = { apiPort: 8098, peerPort: 8099, hostname: 'api.platform.test',
    members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${ports[i]}` })),
    measurements: ['77'.repeat(48)], minTcb: TCB_FLOORS, admins: [ADMIN.address], recovery: [Buffer.from(REC.publicKey).toString('hex')],
    archives: ['http://127.0.0.1:1'], archiveMs: 5000, relayEnv: { ENCLAVES: 'http://127.0.0.1:1', OFAC_SDN_URLS: 'http://127.0.0.1:1/x', RPC_FALLBACKS: '0',
      SIWE_DOMAIN: 'platform.test', SIWE_URI: 'https://platform.test', BASE_RPC: 'http://127.0.0.1:1/rpc' }, leaseMs: 2000 };
  const withCarriers = raw(1, { platformPolicyCarriers: { peers: PEERS_A } });
  const n1 = await newcomer(1, withCarriers, ports[1]);                 // launched (HOST_DATA-bound) WITH the carriers member
  const n2 = await newcomer(2, raw(2), ports[2]);                       // launched with NO carriers member (absent-field compatibility)
  const changed = { ...withCarriers, platformPolicyCarriers: { peers: PEERS_B } };
  const digestChanged = MC.configDigest(MC.canonicalDirectConfig(changed));
  const pass = (n) => `config ${n.digest.slice(0, 16)}… (HOST_DATA ${n.hostData.slice(0, 16)}…)`;
  // a newcomer presents its CANONICAL bound config (plan.config), as production does; the variants below keep that canonical
  // platformApi member (else the member refuses the group before verifying) and change only the carriers
  const canon = (c) => JSON.parse(JSON.stringify(MC.canonicalDirectConfig(c)));
  const C1 = canon(withCarriers), C2 = canon(raw(2));
  const NEW = await member(NEW_BUNDLE);
  // A. the bound member, its correct digest: expectation and config pass in the bundle, the attested key passes, the report refuses
  let r = await NEW.handoff(C1);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_verified');
  assert.ok(r.body.message.startsWith('rejected: ') && r.body.message.includes(pass(n1)), r.body.message);
  assert.match(r.body.message, /; report: REJECT: report is 3 bytes; the ABI fixes ATTESTATION_REPORT at 1184/); assert.doesNotMatch(r.body.message, /REJECT \((expectation|config)\)/);
  // B. a CHANGED carrier set (not what the hardware binds): refused at the config digest
  r = await NEW.handoff(canon(changed));
  assert.equal(r.body.error, 'not_verified');
  assert.ok(r.body.message.includes(`REJECT (config): the guest runs config ${n1.digest.slice(0, 16)}…, not the owner's ${digestChanged.slice(0, 16)}…`), r.body.message);
  // C. MALFORMED carriers (a host directory): refused before anything is fetched
  r = await NEW.handoff({ ...C1, platformPolicyCarriers: { importDir: '/var/lib/policy-import' } });
  assert.match(r.body.message, /REJECT \(expectation\): the expected direct config is invalid: platformPolicyCarriers\.importDir: a host directory is not visible/);
  r = await NEW.handoff({ ...C1, platformPolicyCarriers: {} });
  assert.match(r.body.message, /REJECT \(expectation\).*names no carrier/);
  // D. UNBOUND: presenting the newcomer WITHOUT its bound carriers member (a config the hardware does not bind): refused
  const { platformPolicyCarriers, ...stripped } = C1;
  r = await NEW.handoff(stripped);
  assert.ok(r.body.message.includes(`REJECT (config): the guest runs config ${n1.digest.slice(0, 16)}…`), r.body.message);
  // E. absent-field compatibility: a config without the member verifies exactly as before (up to the hardware report)
  r = await NEW.handoff(C2);
  assert.ok(r.body.message.includes(pass(n2)), r.body.message); assert.match(r.body.message, /; report: REJECT: report is 3 bytes; the ABI fixes ATTESTATION_REPORT at 1184/);
  // OLD NEGATIVE: the reproduced current bundle 2a903c36 cannot verify a carrier-configured guest at all; a plain one as before
  const OLD = await member(OLD_BUNDLE);
  r = await OLD.handoff(C1);
  assert.match(r.body.message, /REJECT \(expectation\): the expected direct config is invalid: direct config has unknown field\(s\): platformPolicyCarriers/);
  r = await OLD.handoff(C2);
  assert.ok(r.body.message.includes(pass(n2)), r.body.message); assert.match(r.body.message, /; report: REJECT: report is 3 bytes; the ABI fixes ATTESTATION_REPORT at 1184/);
  assert.doesNotMatch(NEW.log() + OLD.log(), /state key handed/, 'no handoff ever happened');
});
