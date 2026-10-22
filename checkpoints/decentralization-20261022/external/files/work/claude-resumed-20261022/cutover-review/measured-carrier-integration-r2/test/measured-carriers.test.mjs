// MEASURED Linux guest policy carriers (cutover-review/measured-carrier-integration). Runs inside tools/make-testtree.sh's tree:
//   ../metal/guest/measured-control.mjs           = this package's src (the bound platformPolicyCarriers member)
//   ../windows/node/host-admission.bundle.mjs     = the platform-carrier CANDIDATE 40e8ba71 (createHostServiceGate + carriers)
//   process.env.BASE_TREE                         = the same tree with the FROZEN measured-control 18f47214 + INSTALLED 6bef372d
// The path under test is the real one: owner config -> canonicalDirectConfig -> planDirectBoot (HOST_DATA-bound) -> the derived
// supervisor environment -> the ACTUAL supervisor.js -> its platform host policy gate -> /v1/health and the /x/ route.
// The only test changes to that environment are the guest-local paths, the listening port, network targets the policy gate
// does not use (moved to a closed loopback port), the CA of the local HTTPS RPC world and a 1 s check interval.
// Linux, synthetic SNP binding (the report's HOST_DATA is given): NOT Windows, NOT hardware, NOT a measured image.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as viem from 'viem';
import { keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import * as MC from '../metal/guest/measured-control.mjs';
import { measuredPolicyWorld } from './helpers/measured-policy-world.mjs';

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_TREE = process.env.BASE_TREE;
const BASE_MC = await import(pathToFileURL(path.join(BASE_TREE, 'metal/guest/measured-control.mjs')).href);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'measured-carriers-'));
const children = [];
test.after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} fs.rmSync(tmpRoot, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const PAIR = randomBytes(32).toString('hex');
const PUBLIC_URL = 'https://host.policy.example', HOST = keccak256(toBytes(PUBLIC_URL)).toLowerCase();
const OP = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct';
const PIN = { chainId: 8453, address: '0x' + 'A1'.repeat(20), codeHash: '0x' + 'B2'.repeat(32) };
/** the owner's direct config (the frozen test's shape); `extra` adds optional members */
const RAW = ({ rpcs = ['https://rpc-a.example/v1', 'https://rpc-b.example'], manager = '10.0.2.2:8095', data = '10.0.2.2:8096', ...extra } = {}) => ({
  format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs, quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: PUBLIC_URL, repo: 'owner/enclave', operator: OP },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: `http://${manager}`, dataAddr: data },
  hostAdmissionSha256: null, controlPort: 8444, ...extra,
});
let pathN = 0;
const guestPaths = (bundle) => { const d = path.join(tmpRoot, `guest-${++pathN}`); fs.mkdirSync(d);
  return { ...MC.GUEST_PATHS, runDir: d, pins: path.join(d, 'pins.json'), storagePlan: path.join(d, 'plan.json'), pairKey: path.join(d, 'pair.key'), sessionDir: path.join(d, 'session'),
    acmeDir: path.join(d, 'acme'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'), serveConfig: path.join(d, 'serve.json'),
    status: path.join(d, 'status.json'), hostAdmissionBundle: bundle }; };
const CANDIDATE = path.join(TREE, 'windows/node/host-admission.bundle.mjs'), INSTALLED = path.join(BASE_TREE, 'windows/node/host-admission.bundle.mjs');
const fwFor = (raw, manager = '10.0.2.2:8095', data = '10.0.2.2:8096') => ({ mode: 'snp', name: 'ctl', direct: raw, isolation: { managerUrl: `http://${manager}`, dataAddr: data, pairingKey: PAIR }, registryKey: '' });
async function plan(mc, raw, bundle = CANDIDATE, { manager, data } = {}) {
  const config = mc.canonicalDirectConfig(raw), hd = mc.hostDataHex(mc.configDigest(config));
  return mc.planDirectBoot({ cmdline: CMDLINE, fw: fwFor(raw, manager, data), reportHostData: hd, viem, paths: guestPaths(bundle) });
}

// ---- 1. the bound member ------------------------------------------------------------------------------------------------------
test('platformPolicyCarriers is a strict, canonical, HOST_DATA-bound member; absent, every config keeps its exact digest', () => {
  assert.equal(MC.configDigest(MC.canonicalDirectConfig(RAW())), BASE_MC.configDigest(BASE_MC.canonicalDirectConfig(RAW())), 'default compatibility: same canonical digest as the frozen helper');
  const c = MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { serviceIndex: PIN, peers: ['https://peer-a.example/platform-policy', 'http://198.51.100.7:8080'] } }));
  assert.deepEqual(c.platformPolicyCarriers, { peers: ['https://peer-a.example/platform-policy', 'http://198.51.100.7:8080'],
    serviceIndex: { chainId: 8453, address: '0x' + 'a1'.repeat(20), codeHash: '0x' + 'b2'.repeat(32) } });
  assert.notEqual(MC.configDigest(c), MC.configDigest(MC.canonicalDirectConfig(RAW())), 'the carriers are bound');
  const other = MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['https://peer-b.example/platform-policy'] } }));
  assert.notEqual(MC.configDigest(other), MC.configDigest(MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['https://peer-a.example/platform-policy'] } }))), 'every carrier is bound');
  const refuse = (pc, re) => assert.throws(() => MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: pc })), re);
  refuse({ importDir: '/var/lib/policy-import' }, /importDir: a host directory is not visible inside the measured guest/);
  refuse({ policyMirrorStateDir: '/var/lib/pm', peers: ['https://p.example'] }, /policyMirrorStateDir: a host directory is not visible/);
  refuse({}, /names no carrier/);
  refuse({ peers: [] }, /1 to 16 base URLs/);
  refuse({ peers: ['https://p.example/x'], extra: 1 }, /unknown field/);
  refuse({ peers: ['https://p.example/'] }, /without credentials, query, fragment or trailing slash/);
  refuse({ peers: ['https://u:pw@p.example'] }, /without credentials/);
  refuse({ peers: ['https://p.example/x?y=1'] }, /without credentials, query/);
  refuse({ peers: ['ftp://p.example'] }, /http\(s\) base URL/);
  refuse({ peers: ['https://p.example', 'https://P.example'] }, /repeats a carrier/);
  refuse({ peers: ['https://policy.enclave.host/platform-policy'] }, /names an Enclave origin/);
  refuse({ peers: Array.from({ length: 17 }, (_, i) => `https://p${i}.example`) }, /1 to 16/);
  refuse({ serviceIndex: { ...PIN, chainId: 1 } }, /chainId must be 8453/);
  refuse({ serviceIndex: { ...PIN, address: a(0) } }, /nonzero address/);
  refuse({ serviceIndex: { ...PIN, codeHash: '0x12' } }, /codeHash/);
  refuse({ serviceIndex: { chainId: 8453, address: PIN.address } }, /missing: codeHash/);
  refuse('peers', /must be an object/);
  // OLD NEGATIVE: the frozen helper cannot carry the member at all
  assert.throws(() => BASE_MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['https://p.example'] } })), /unknown field\(s\): platformPolicyCarriers/);
});

// ---- 2. one exact supervisor name, from the bound config only -------------------------------------------------------------------
test('the derived environment carries exactly ONE carrier name, only from the bound config; injected or malformed values are refused', () => {
  const P = guestPaths(CANDIDATE);
  const cfg = MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['https://peer-a.example/platform-policy'], serviceIndex: PIN } }));
  const env = MC.directSupervisorEnv(cfg, { paths: P, secrets: { secret: 'ab'.repeat(32) } });
  assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS, MC.canonicalJson(cfg.platformPolicyCarriers));
  assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY, 'production'); assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS, cfg.rpcs.join(','));
  assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS, undefined, 'no mirror is configured: the carrier is the transport');
  assert.deepEqual(MC.directEnvProblems(env), []);
  const plain = MC.canonicalDirectConfig(RAW()), inject = { ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: '{"importDir":"/host/dir"}' };
  const e0 = MC.directSupervisorEnv(plain, { paths: P, secrets: { secret: 'ab'.repeat(32) }, hostPolicyEnv: inject, flavorEnv: inject });
  assert.equal('ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS' in e0, false, 'neither the host-policy nor the flavor input can supply it');
  const e1 = MC.directSupervisorEnv(cfg, { paths: P, secrets: { secret: 'ab'.repeat(32) }, hostPolicyEnv: inject });
  assert.equal(e1.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS, env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS, 'the bound value wins over any injected one');
  const problems = (over) => MC.directEnvProblems({ ...env, ...over }).join('\n');
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: '{"importDir":"/host/dir"}' }), /importDir: a host directory is not visible/);
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: 'not json' }), /must be an object/);
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: '{}' }), /names no carrier/);
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: JSON.stringify({ peers: ['https://peer-a.example/platform-policy'], serviceIndex: PIN }) }), /must be the canonical bound carrier setting/);
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY: 'off' }), /needs the platform host policy on/);
  assert.match(problems({ ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS: '{"peers":["https://x.enclave.host/p"]}' }), /names an Enclave origin/);
});

// ---- 3. the plan refuses an image whose supervisor would ignore the carriers ----------------------------------------------------
test('planDirectBoot: the image bundle must honour the bound carriers (an older bundle would silently ignore them)', async () => {
  const raw = RAW({ platformPolicyCarriers: { peers: ['https://peer-a.example/platform-policy'] } });
  const ok = await plan(MC, raw, CANDIDATE); assert.equal(ok.ok, true, ok.reasons?.join('; '));
  assert.equal(ok.env.ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS, '{"peers":["https://peer-a.example/platform-policy"]}');
  const old = await plan(MC, raw, INSTALLED); assert.equal(old.ok, false);
  assert.match(old.reasons.join('\n'), /does not support policy carriers: platformPolicyCarriers would be ignored/);
  const gone = await plan(MC, raw, path.join(tmpRoot, 'no-such-bundle.mjs')); assert.equal(gone.ok, false); assert.match(gone.reasons.join('\n'), /cannot be loaded/);
  const plain = await plan(MC, RAW(), path.join(tmpRoot, 'no-such-bundle.mjs'));
  assert.equal(plain.ok, true, 'no carriers: the bundle is never consulted, the plan is as before'); assert.equal('ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS' in plain.env, false);
  const base = await plan(BASE_MC, RAW(), INSTALLED); assert.deepEqual(Object.keys(plain.env).sort(), Object.keys(base.env).sort(), 'same names as the frozen helper');
});

// ---- 4. end to end: bound config -> plan -> ACTUAL supervisor -> its gate ------------------------------------------------------
async function bootSupervisor(t, tree, mc, raw, bundle, w) {
  const dead = `127.0.0.1:${await freePort()}`;
  raw = { ...raw, isolation: { managerUrl: `http://${dead}`, dataAddr: dead } };       // bound, and moved to a closed loopback port
  const p = await plan(mc, raw, bundle, { manager: dead, data: dead });
  assert.equal(p.ok, true, p.reasons?.join('; '));
  for (const [f, text] of Object.entries(p.files)) fs.writeFileSync(f, text, { mode: 0o600 });
  const run = fs.mkdtempSync(path.join(tmpRoot, 'sup-')), port = await freePort();
  const env = { ...p.env, PORT: String(port), STATE_FILE: path.join(run, 'state.json'), HOME: run, PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: w.ca,
    ATTESTATION_URL: `http://${dead}/.well-known/enclave-attestation`, BASE_RPC: `http://${dead}`, BASE_RPCS: `http://${dead}`,
    GUEST_BOOTSTRAP_GATEWAYS: `http://${dead}/ipfs`, IPFS_GATEWAY: JSON.stringify([`http://${dead}`]),
    ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' };
  for (const k of ['ENCLAVE_PLATFORM_HOST_POLICY', 'ENCLAVE_PLATFORM_HOST_POLICY_RPCS', 'ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS', 'PUBLIC_URL', 'ADDRESS_BOOK_ADDRESS', 'ISOLATION_DIRECT_ONLY'])
    assert.equal(env[k], p.env[k], `${k} exactly as planDirectBoot derived it`);
  assert.deepEqual(mc.directEnvProblems(env), [], 'still the direct-only environment');
  const c = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--max-old-space-size=200', '--import', path.join(tree, 'test/helpers/loopback-only-fetch.mjs'), path.join(tree, 'supervisor.js')],
    { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c); t.after(() => { try { c.kill('SIGKILL'); } catch {} });
  let log = ''; c.stdout.on('data', (b) => { log += b; }); c.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 300; i++) {
    if (c.exitCode !== null) throw new Error(`supervisor exited ${c.exitCode}:\n${log.slice(-2500)}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/v1/health`); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const base = `http://127.0.0.1:${port}`;
  const health = async () => (await (await fetch(`${base}/v1/health`)).json()).platformHostPolicy;
  const app = async () => { const r = await fetch(`${base}/x/${'0x' + 'ab'.repeat(32)}/`); let j = null; try { j = JSON.parse(await r.text()); } catch {} return { status: r.status, error: j?.code || j?.error || null }; };
  const until = async (fn, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); } return false; };
  return { p, env, log: () => log, health, app, until };
}

test('END TO END: the bound peer carrier delivers the admin\'s anchored policy to the ACTUAL measured supervisor; ban, forged and malformed documents are refused; the admin\'s unban restores', { timeout: 240_000 }, async (t) => {
  const w = await measuredPolicyWorld(t, { hosts: { [HOST]: { endpoint: PUBLIC_URL, operator: OP, owner: '0x' + '55'.repeat(20), active: true } } });
  let d = await w.sign({ sequence: 1 }); w.docs.set(d.digest, d.entry);               // anchored BEFORE the guest starts: a fresh host
  const raw = RAW({ rpcs: w.rpcs, platformPolicyCarriers: { peers: [w.peerBase] } });
  const s = await bootSupervisor(t, TREE, MC, raw, CANDIDATE, w);
  assert.equal(s.env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS, w.rpcs.join(','), 'the gate reads this guest\'s OWN bound RPC quorum');
  assert.ok(await s.until(async () => (await s.health())?.serving === true), 'admitted through the bound peer carrier\n' + s.log().slice(-2500));
  let h = await s.health();
  assert.equal(h.runtime.accepted.digest, d.digest); assert.equal(h.runtime.anchor, 'anchored');
  assert.deepEqual(h.carriers, { importDir: false, policyMirrorStateDir: false, peers: 1, serviceIndex: false });
  assert.match(s.log(), /\[host-policy\] policy carriers: peers 1 \(each candidate verified at the gate's own quorum\)/);
  assert.ok(w.served.includes(`/platform-policy/${d.digest}.json`), 'the document came from the peer');
  assert.notEqual((await s.app()).error, 'host_policy_refused');
  // the admin's BAN, delivered by the same carrier: refused at once (claims, service), persisted
  d = await w.sign({ sequence: 2, deny: [{ kind: 'registryId', value: HOST, reason: 'abuse' }] }); w.docs.set(d.digest, d.entry);
  assert.ok(await s.until(async () => (await s.health())?.banned === true), 'the carrier-delivered ban is enforced\n' + s.log().slice(-1500));
  assert.deepEqual(await s.app(), { status: 403, error: 'host_policy_refused' });
  const banned = d.digest;
  // a FORGED document (a non-owner's signature) under a new anchor: never accepted; the refusal stays
  const mallory = privateKeyToAccount(generatePrivateKey());
  const forged = await w.sign({ sequence: 3, signer: mallory }); w.docs.set(forged.digest, forged.entry);
  await new Promise((r) => setTimeout(r, 4000));
  h = await s.health(); assert.equal(h.serving, false); assert.equal(h.runtime.accepted.digest, banned, 'the forged #3 is never accepted');
  assert.ok(w.served.includes(`/platform-policy/${forged.digest}.json`), 'the forged document was offered and refused');
  // a MALFORMED body under the next anchor: never accepted; still refused
  const bad = await w.sign({ sequence: 4 }); w.docs.set(bad.digest, '{"document": 1, "signature": "nope"');
  await new Promise((r) => setTimeout(r, 4000));
  h = await s.health(); assert.equal(h.serving, false); assert.equal(h.runtime.accepted.digest, banned, 'the malformed #4 is never accepted');
  assert.deepEqual(await s.app(), { status: 403, error: 'host_policy_refused' });
  // the admin's UNBAN: a newer anchored document from the current owner restores service
  d = await w.sign({ sequence: 5 }); w.docs.set(d.digest, d.entry);
  assert.ok(await s.until(async () => (await s.health())?.serving === true), 'the admin\'s unban restores\n' + s.log().slice(-1500));
  assert.equal((await s.health()).runtime.accepted.digest, d.digest);
  assert.ok(w.served.every((u) => /^\/platform-policy\/0x[0-9a-f]{64}\.json$/.test(u)), 'only digest-named documents were ever asked for');
});

test('OLD NEGATIVE (B-LINUX): the frozen measured helper + installed bundle cannot carry a policy; the same guest stays refused after the anchor', { timeout: 120_000 }, async (t) => {
  const w = await measuredPolicyWorld(t, { hosts: { [HOST]: { endpoint: PUBLIC_URL, operator: OP, owner: '0x' + '55'.repeat(20), active: true } } });
  const d = await w.sign({ sequence: 1 }); w.docs.set(d.digest, d.entry);
  const s = await bootSupervisor(t, BASE_TREE, BASE_MC, RAW({ rpcs: w.rpcs }), INSTALLED, w);
  assert.equal('ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS' in s.env, false);
  assert.ok(await s.until(async () => { const h = await s.health(); return h?.status === 'behind'; }, 20000), 'the fresh measured host is behind\n' + s.log().slice(-1500));
  await new Promise((r) => setTimeout(r, 3000));
  const h = await s.health(); assert.equal(h.serving, false, 'never admitted: no transport for the anchored document'); assert.equal(h.runtime.accepted, null);
  assert.deepEqual(w.served, [], 'nothing could ask the peer');
  assert.deepEqual(await s.app(), { status: 403, error: 'host_policy_refused' });
});
