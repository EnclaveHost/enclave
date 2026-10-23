// Platform policy CARRIERS for the relay-mode (legacy) Linux control guest, end to end:
//   host config (metal/enclave-metal.mjs, the REAL launcher: a fake QEMU copies out the fw_cfg file the guest reads)
//   -> fw_cfg `platformPolicyCarriers` -> gsup's legacy half (measured-control.mjs guestPolicyCarriers / withPolicyCarriersEnv,
//   the measured guest's OWN carrier schema) -> the ONE supervisor name ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS -> the
//   supervisor's own HOST_POLICY_GATE block (sliced from supervisor.js) over the SHIPPED windows/node/host-admission.bundle.mjs.
// On a REAL local chain (test/helpers/cli-independent-rig.mjs: anvil, the registry, three JSON-RPC origins; a deployed
// EnclaveAddressBook owned by the admin and an EnclaveHostOwnership), with the four former DigitalOcean /platform-policy fronts
// REFUSED at the transport and the policy-mirror role (network/host-services/policy-mirror.mjs) of ANOTHER host as the only
// carrier:
//   - unanchored: the supervisor gate admits ("not activated") with and without carriers - today's behaviour;
//   - the admin signs and ANCHORS a policy: the gate with carriers admits from empty state; the same chain read by the OLD
//     source's composition (fec43a6a launcher drops the setting, its gsup sets no carrier) never admits (negative control);
//   - the admin's ban (a new anchored document) refuses this host, sticky; the next anchored document readmits it;
//   - a stale or substituted carrier answer never becomes an admission; an invalid carrier setting refuses work and service.
// FIXTURE evidence: a local chain, loopback listeners and a scripted transport. Not a physical guest, not production policy data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as MC from '../metal/guest/measured-control.mjs';
import { leaseGasGuest, withLeaseGasEnv } from '../metal/guest/lease-gas-conduit.bundle.mjs';
import { withOwnerNominationEnv } from '../metal/guest/owner-nomination.mjs';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';
import { startPolicyMirror } from '../network/host-services/policy-mirror.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(REPO, 'windows/node/host-admission.bundle.mjs');
const OUT = path.join(REPO, 'contracts/foundry/out');
const HA = await import(pathToFileURL(BUNDLE).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-carriers-'));
const skip = haveTools() || false;
const OLD = 'fec43a6a08da2ac287fb3a5c42de89f096f4f678';   // the packaged Linux release this closure supersedes

// ---- the carrier schema: the measured guest's own, in both modes -----------------------------------------------------------
const PUB = 'https://host-s.policy-placement.net';
const INDEX = { chainId: 8453, address: '0x' + 'AB'.repeat(20), codeHash: '0x' + 'CD'.repeat(32) };
const a20 = (b) => '0x' + b.toString(16).padStart(2, '0').repeat(20);
const RAW = (o = {}) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,   // test/owner-nomination-config.test.mjs's direct config
  contracts: { registry: a20(0x11), deployments: a20(0x12), appCatalog: a20(0x13), proofOfTime: a20(0x14), enclavePay: a20(0), verificationFees: a20(0), sessionVaultFactory: a20(0), secretVaultV2: a20(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: PUB, repo: 'owner/enclave', operator: a20(0x99) },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444, ...o });
test('one carrier schema: the relay check IS the bound direct member, normalized the same way, same env bytes', () => {
  for (const raw of [{ peers: ['https://mirror-1.example.net/platform-policy'] }, { serviceIndex: INDEX },
    { peers: ['http://9.9.9.9:8188/platform-policy', 'https://m.example.org'], serviceIndex: INDEX }]) {
    const relay = MC.checkPolicyCarriers(raw, { publicUrl: PUB });
    const bound = MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: raw })).platformPolicyCarriers;
    assert.deepEqual(JSON.parse(JSON.stringify(bound)), JSON.parse(JSON.stringify(relay)));
    if (raw.serviceIndex) assert.deepEqual(relay.serviceIndex, { chainId: 8453, address: INDEX.address.toLowerCase(), codeHash: INDEX.codeHash.toLowerCase() });
    // the env value the measured guest derives from its bound copy is byte-identical to the relay guest's
    const direct = MC.directSupervisorEnv(MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: raw })), { secrets: { secret: 'ab'.repeat(32) } });
    assert.equal(direct[MC.CARRIERS_ENV], MC.canonicalJson(relay));
  }
  assert.equal('platformPolicyCarriers' in MC.canonicalDirectConfig(RAW()), false, 'absent keeps the exact direct config');
});
test('malformed or self-referential carrier settings are refused, with the measured guest\'s rules', () => {
  for (const [raw, why] of [
    [null, /must be an object/], [[], /must be an object/], [{}, /names no carrier/],
    [{ importDir: '/srv/policy' }, /host directory is not visible/], [{ policyMirrorStateDir: '/srv/pm' }, /host directory is not visible/],
    [{ peers: ['https://a.example'], extra: 1 }, /unknown field/], [{ peers: [] }, /1 to 16/],
    [{ peers: Array.from({ length: 17 }, (_, i) => `https://m${i}.example`) }, /1 to 16/],
    [{ peers: ['https://u:p@a.example'] }, /without credentials/], [{ peers: ['https://a.example/?q'] }, /without credentials/],
    [{ peers: ['https://a.example/'] }, /without credentials/], [{ peers: ['ftp://a.example'] }, /http\(s\) base URL/],
    [{ peers: ['https://mirror.enclave.host/platform-policy'] }, /Enclave origin/],
    [{ peers: ['https://a.example', 'https://A.example'] }, /repeats a carrier/],
    [{ serviceIndex: { ...INDEX, chainId: 1 } }, /chainId must be 8453/], [{ serviceIndex: { ...INDEX, address: '0x' + '00'.repeat(20) } }, /nonzero address/],
    [{ serviceIndex: { ...INDEX, codeHash: '0x12' } }, /codeHash/], [{ serviceIndex: { ...INDEX, x: 1 } }, /serviceIndex/],
    // this host itself: its public origin, the QEMU host link, loopback (it would wait on its own, still-unadmitted role)
    [{ peers: ['https://host-s.policy-placement.net/platform-policy'] }, /this host itself/],
    [{ peers: ['http://10.0.2.2:8188/platform-policy'] }, /this host itself/], [{ peers: ['http://127.0.0.1:8188'] }, /this host itself/],
    [{ peers: ['http://localhost:8188'] }, /this host itself/],
  ]) assert.throws(() => MC.checkPolicyCarriers(raw, { publicUrl: PUB }), why, JSON.stringify(raw));
});
test('the measured direct config applies the same self-reference rule to its bound member', () => {
  assert.throws(() => MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: [`${PUB}/platform-policy`] } })), /this host itself/);
  assert.throws(() => MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['http://10.0.2.2:8188/platform-policy'] } })), /this host itself/);
});

// ---- the guest half and its environment boundary --------------------------------------------------------------------------
const FLAVOR = { CHAIN_ID: '8453', ADDRESS_BOOK_ADDRESS: '0xab214342d5a490150a4a977063a2f88e21f80907', NODE_VCPUS: '4' };
test('guest half: absent = no name; valid = exactly one canonical name the SHIPPED bundle honours; invalid = a refusal the gate enforces', async () => {
  const none = await MC.guestPolicyCarriers(undefined, { publicUrl: PUB, bundleFile: BUNDLE });
  assert.deepEqual(none.env, {}); assert.equal(none.configured, false);
  const ok = await MC.guestPolicyCarriers({ peers: ['https://mirror-1.example.net/platform-policy'] }, { publicUrl: PUB, bundleFile: BUNDLE });
  assert.equal(ok.ok, true, ok.message); assert.deepEqual(Object.keys(ok.env), [MC.CARRIERS_ENV]);
  assert.deepEqual(HA.hostPolicyCarriersFromEnv(ok.env).peers, ['https://mirror-1.example.net/platform-policy']);
  for (const bad of [{ importDir: '/x' }, { peers: [`${PUB}/platform-policy`] }, { peers: ['https://B.example'], serviceIndex: INDEX }]) {
    const r = await MC.guestPolicyCarriers(bad, { publicUrl: PUB, bundleFile: BUNDLE });
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.match(r.message, /REFUSED/);
    assert.throws(() => HA.hostPolicyCarriersFromEnv(r.env), /ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS/, 'the shipped parser refuses the marker');
    const env = { ...FLAVOR, ...r.env, PUBLIC_URL: PUB };
    assert.throws(() => HA.createHostServiceGate({ env, chainId: 8453, book: FLAVOR.ADDRESS_BOOK_ADDRESS, endpoint: PUB, log: () => {} }));
  }
  // an image whose host-admission bundle cannot honour carriers is refused, never silently run without them
  const oldBundle = path.join(tmp, 'old-bundle.mjs');
  fs.writeFileSync(oldBundle, 'export const createHostServiceGate = () => ({}); export const hostAdmissionFromEnv = () => null;\n');
  const old = await MC.guestPolicyCarriers({ peers: ['https://mirror-1.example.net/platform-policy'] }, { publicUrl: PUB, bundleFile: oldBundle });
  assert.equal(old.ok, false); assert.match(old.message, /does not support policy carriers/);
});
test('boot env boundary: ONLY fw_cfg platformPolicyCarriers supplies the name; lease gas, owner nomination and flavor cannot set it or any authority name', async () => {
  const pc = await MC.guestPolicyCarriers({ peers: ['https://mirror-1.example.net/platform-policy'] }, { publicUrl: PUB, bundleFile: BUNDLE });
  const forged = { ...FLAVOR, [MC.CARRIERS_ENV]: '{"peers":["https://attacker.example"]}' };   // a stale/other source of the name
  const nomination = null, lease = leaseGasGuest({ bogus: true });                              // an invalid transit
  const compose = (base, carriers) => MC.withPolicyCarriersEnv(withOwnerNominationEnv(withLeaseGasEnv(base, lease), nomination), carriers);
  const env = compose(forged, pc);
  assert.equal(env[MC.CARRIERS_ENV], pc.env[MC.CARRIERS_ENV]);
  assert.equal(MC.CARRIERS_ENV in compose(forged, null), false, 'absent: the forged name is dropped, not kept');
  const AUTHORITY = ['CHAIN_ID', 'ADDRESS_BOOK_ADDRESS', 'ENCLAVE_PLATFORM_HOST_POLICY', 'ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS',
    'ENCLAVE_PLATFORM_HOST_POLICY_RPCS', 'ENCLAVE_PLATFORM_HOST_POLICY_ACTIVATION', 'ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN',
    // the chain authority switch A 71448f63 added (network/platform-host-policy-config.mjs chainAuthority): provider quorum
    // unless EXPLICITLY the local verifier; no fw_cfg channel may supply it to a relay-mode supervisor
    'ENCLAVE_CHAIN_AUTHORITY', 'ENCLAVE_CHAIN_VERIFIER'];
  for (const k of AUTHORITY) assert.equal(env[k], FLAVOR[k], k);
  // the measured direct guest's supervisor env never names the chain authority either (only the platform API role's
  // bound, checked relayEnv may): the bound carriers member adds exactly the one carrier name
  const direct = MC.directSupervisorEnv(MC.canonicalDirectConfig(RAW({ platformPolicyCarriers: { peers: ['https://mirror-1.example.net/platform-policy'] } })), { secrets: { secret: 'ab'.repeat(32) } });
  for (const k of ['ENCLAVE_CHAIN_AUTHORITY', 'ENCLAVE_CHAIN_VERIFIER']) assert.equal(k in direct, false, k);
  // the other fw_cfg channels emit only their own names
  const ok = leaseGasGuest(undefined);
  for (const names of [Object.keys(lease.env), Object.keys(ok.env), Object.keys(pc.env)])
    for (const k of names) assert.ok(!AUTHORITY.includes(k), k);
  assert.deepEqual(Object.keys(pc.env), [MC.CARRIERS_ENV]);
});
test('gsup and the launcher wire it exactly once; the supervisor gate call and its refuse-on-error branch are unchanged', () => {
  const gsup = fs.readFileSync(path.join(REPO, 'metal/guest/gsup.mjs'), 'utf8'), launcher = fs.readFileSync(path.join(REPO, 'metal/enclave-metal.mjs'), 'utf8');
  assert.match(gsup, /const POLICY_CARRIERS = CONTROL \? null : await MC_LEGACY\.guestPolicyCarriers\(fw\.platformPolicyCarriers, \{ publicUrl: PUBLIC_URL \}\);/);
  assert.match(gsup, /start\('supervisor', \['\/usr\/local\/bin\/node', '\/app\/supervisor\.js'\], withChainVerifierEnv\(MC_LEGACY\.withPolicyCarriersEnv\(withOwnerNominationEnv\(withLeaseGasEnv\(supEnv, LEASE_GAS\), OWNER_NOMINATION\.nomination\), POLICY_CARRIERS\), CHAIN_VERIFIER\), \{ cwd: '\/app' \}\);/);
  assert.equal((gsup.match(/ENCLAVE_PLATFORM_HOST_POLICY/g) || []).length, 0, 'gsup names no policy variable itself');
  assert.match(launcher, /takes platformPolicyCarriers only inside the bound direct config/);
  assert.match(launcher, /\.\.\.\(POLICY_CARRIERS \? \{ platformPolicyCarriers: POLICY_CARRIERS \} : \{\}\),/);
  const sup = fs.readFileSync(path.join(REPO, 'supervisor.js'), 'utf8');
  assert.match(sup, /createHostServiceGate\(\{ env: process\.env, chainId: CHAIN_ID, book: \(process\.env\.ADDRESS_BOOK_ADDRESS \|\| ""\)\.trim\(\) \|\| null,\n    endpoint: PUBLIC_URL \|\| null, stateDir: dirname\(STATE_FILE\), log: \(m\) => console\.log\(m\) \}\);/);
  assert.match(sup, /console\.error\(`\[host-policy\] REFUSING work and service: \$\{e\.message\}`\);/);
});

// ---- the REAL launcher (fake QEMU), as test/owner-nomination-config.test.mjs drives it ------------------------------------
const KEY = 'ab'.repeat(32);
function launch(launcherFile, cfgOver, { direct = null } = {}) {
  const t = fs.mkdtempSync(path.join(tmp, 'launch-'));
  fs.mkdirSync(path.join(t, 'dist')); fs.mkdirSync(path.join(t, 'tmp'));
  fs.writeFileSync(path.join(t, 'dist', 'vmlinuz'), 'k'); fs.writeFileSync(path.join(t, 'dist', 'initramfs.cpio.gz'), 'i');
  fs.writeFileSync(path.join(t, 'pair.key'), KEY + '\n', { mode: 0o600 });
  if (direct) fs.writeFileSync(path.join(t, 'direct.json'), JSON.stringify(direct));
  fs.writeFileSync(path.join(t, 'fake-qemu'), ['#!/bin/sh', 'while [ $# -gt 0 ]; do',
    '  if [ "$1" = -fw_cfg ]; then case "$2" in name=opt/org.enclave.metal,file=*) cp "${2#name=opt/org.enclave.metal,file=}" "$FAKE_QEMU_OUT.tmp" && mv "$FAKE_QEMU_OUT.tmp" "$FAKE_QEMU_OUT";; esac; fi',
    '  shift', 'done', 'exec sleep 30'].join('\n') + '\n', { mode: 0o755 });
  const cfg = { mode: 'snp', name: 'carrier-test', cpus: 1, memMiB: 512, measureGflops: false, dist: path.join(t, 'dist'), ovmf: path.join(t, 'ovmf.fd'),
    qemu: path.join(t, 'fake-qemu'), relayUrl: 'wss://relay.example.test/v1/fleet-tunnel', publicUrl: PUB,
    isolation: { backend: 'snp-guest-per-app', managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096', pairingKeyFile: path.join(t, 'pair.key') },
    ...(direct ? { control: 'direct', direct: path.join(t, 'direct.json'), relayUrl: undefined, hostfwd: [{ host: 18444, guest: 8444 }] } : {}), ...cfgOver };
  for (const k of Object.keys(cfg)) if (cfg[k] === undefined) delete cfg[k];
  fs.writeFileSync(path.join(t, 'config.json'), JSON.stringify(cfg));
  const out = path.join(t, 'fwcfg.json');
  const p = spawn(process.execPath, [launcherFile, '--config', path.join(t, 'config.json')],
    { env: { ...process.env, TMPDIR: path.join(t, 'tmp'), FAKE_QEMU_OUT: out }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  return { out, p, exited, log: () => log };
}
async function launched(cfgOver = {}, o = {}, launcherFile = path.join(REPO, 'metal/enclave-metal.mjs')) {
  const run = launch(launcherFile, cfgOver, o);
  try {
    for (let i = 0; i < 200 && !fs.existsSync(run.out); i++) { if (run.p.exitCode !== null) break; await new Promise((r) => setTimeout(r, 50)); }
    if (!fs.existsSync(run.out)) return { refused: true, code: await Promise.race([run.exited, new Promise((r) => setTimeout(() => r('running'), 3000))]), log: run.log() };
    return { fw: JSON.parse(fs.readFileSync(run.out, 'utf8')), log: run.log() };
  } finally { if (run.p.exitCode === null && run.p.signalCode === null) { run.p.kill('SIGTERM'); await run.exited; } }
}
// the OLD source's launcher (the packaged fec43a6a release), from its Git objects
const oldLauncher = () => {
  const d = path.join(tmp, 'old-' + OLD.slice(0, 8));
  if (!fs.existsSync(d)) { fs.mkdirSync(d); execFileSync('sh', ['-c', `git -C "${REPO}" archive ${OLD} metal | tar -x -C "${d}"`]); }
  return path.join(d, 'metal/enclave-metal.mjs');
};

test('the real launcher: carriers cross in their checked form; malformed or self ones refuse the launch; absent stays absent', async () => {
  const peers = ['http://9.9.9.9:8188/platform-policy'];
  const r = await launched({ platformPolicyCarriers: { peers, serviceIndex: INDEX } });
  assert.ok(!r.refused, r.log);
  assert.deepEqual(r.fw.platformPolicyCarriers, MC.checkPolicyCarriers({ peers, serviceIndex: INDEX }, { publicUrl: PUB }));
  assert.match(r.log, /platform policy carriers: 1 peer\(s\), service index/);
  for (const [what, c, why] of [
    ['host directory', { importDir: '/srv/policy' }, /host directory is not visible/],
    ['own origin', { peers: [`${PUB}/platform-policy`] }, /this host itself/],
    ['host link', { peers: ['http://10.0.2.2:8188/platform-policy'] }, /this host itself/],
    ['unknown field', { peers, mirrors: [] }, /unknown field/],
    ['empty', {}, /names no carrier/],
  ]) { const x = await launched({ platformPolicyCarriers: c }); assert.equal(x.refused, true, what); assert.match(x.log, why, what); }
  const off = await launched({});
  assert.ok(!off.refused, off.log); assert.equal('platformPolicyCarriers' in off.fw, false);
  // negative control: the OLD launcher silently drops the setting, so its guest can never be given a carrier
  const old = await launched({ platformPolicyCarriers: { peers } }, {}, oldLauncher());
  assert.ok(!old.refused, old.log); assert.equal('platformPolicyCarriers' in old.fw, false, 'fec43a6a forwards no carrier');
  assert.doesNotMatch(execFileSync('git', ['-C', REPO, 'show', `${OLD}:metal/guest/gsup.mjs`]).toString(), /platformPolicyCarriers|POLICY_CARRIERS/);
});
test('the real launcher, direct control: carriers only inside the HOST_DATA-bound config; a host-level setting refuses', async () => {
  const carriers = { peers: ['https://m.example.net/platform-policy'] };
  const r = await launched({ publicUrl: undefined, platformPolicyCarriers: carriers }, { direct: RAW() });
  assert.equal(r.refused, true, r.log); assert.match(r.log, /takes platformPolicyCarriers only inside the bound direct config/);
  const ok = await launched({ publicUrl: undefined }, { direct: RAW({ platformPolicyCarriers: carriers }) });
  assert.ok(!ok.refused, ok.log);
  assert.deepEqual(ok.fw.direct.platformPolicyCarriers, carriers); assert.equal('platformPolicyCarriers' in ok.fw, false);
});

// ---- the supervisor's own gate on a real chain ---------------------------------------------------------------------------
const DO = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];
const DO_MIRRORS = DO.map((ip) => `https://${ip}/platform-policy`);
const CARRIER_ADDR = '9.9.9.9';   // stand-in public address of ANOTHER host's policy-mirror role, mapped to its loopback listener
const denied = [];
let substitute = null;            // when set: the carrier's answer is replaced (stale/substituted bytes)
const realFetch = globalThis.fetch;
const netFetch = async (url, opts) => {
  const u = new URL(url);
  if (DO.includes(u.hostname)) { denied.push(u.href); throw new TypeError('connect ECONNREFUSED (DigitalOcean down)'); }
  if (u.hostname === CARRIER_ADDR) {
    if (substitute && /\/platform-policy\/0x[0-9a-f]{64}\.json$/.test(u.pathname)) return new Response(JSON.stringify(substitute), { status: 200, headers: { 'content-type': 'application/json' } });
    u.hostname = '127.0.0.1'; return realFetch(u, opts);
  }
  if (u.hostname === '127.0.0.1') return realFetch(u, opts);
  throw new TypeError(`no route to ${u.hostname}`);
};
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + '.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const Z32 = '0x' + '00'.repeat(32);
const admin = privateKeyToAccount(KEYS.deployer);
const hostOp = privateKeyToAccount(KEYS.owner);
let rig, book, bookAbi, ownership, mirror, mirrorPort, docs = [];
async function sign(deny) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) };
  docs.push(d); return d;
}
const anchor = async (digest) => { const a = encodeAnchor(digest); await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); for (let i = 0; i < 3; i++) await rig.mine(); };
const publish = async (d) => {
  const r = await netFetch(`http://${CARRIER_ADDR}:${mirrorPort}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: d.document, signature: d.signature }) });
  assert.equal(r.status, 201, await r.clone().text());
};
// the supervisor's environment exactly as the relay guest composes it (launcher fw_cfg -> gsup legacy half), then the
// supervisor's OWN gate block. FLAVOR stands in for the baked production default: this chain's book with the four former
// fleet mirrors configured (all refused) - the production default itself names no mirror (40e8ba71).
async function supervisorGate(name, fw, { old = false } = {}) {
  const flavor = { CHAIN_ID: '8453', ADDRESS_BOOK_ADDRESS: book, PUBLIC_URL: PUB,
    ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: DO_MIRRORS, activation: 'anchor' }),
    ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rig.rpcs.join(','), ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '3600' };
  const base = withOwnerNominationEnv(withLeaseGasEnv(flavor, leaseGasGuest(fw.leaseGas)), null);
  const env = old ? base   // fec43a6a's gsup: no carrier wrapper at all
    : MC.withPolicyCarriersEnv(base, await MC.guestPolicyCarriers(fw.platformPolicyCarriers, { publicUrl: PUB, bundleFile: BUNDLE }));
  const sup = fs.readFileSync(path.join(REPO, 'supervisor.js'), 'utf8');
  const a = sup.indexOf('const HOST_POLICY_GATE = (() => {'), b = sup.indexOf('HOST_POLICY_GATE.start();');
  assert.ok(a > 0 && b > a);
  const logs = [], dir = fs.mkdtempSync(path.join(tmp, `state-${name}-`));
  const ctx = vm.createContext({ createHostServiceGate: HA.createHostServiceGate, process: { env }, CHAIN_ID: 8453, PUBLIC_URL: PUB,
    STATE_FILE: path.join(dir, 'state.json'), dirname: path.dirname, console: { log: (m) => logs.push(m), error: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  vm.runInContext(sup.slice(a, b) + '\nglobalThis.GATE = HOST_POLICY_GATE;', ctx);
  return { gate: ctx.GATE, env, logs };
}
const settle = async (g, want, what, ms = 40000) => {
  const end = Date.now() + ms;
  for (;;) {
    await g.gate.check?.().catch(() => {});
    const s = g.gate.status();
    if (want(s)) return s;
    if (Date.now() > end) throw new Error(`timed out: ${what}\n${JSON.stringify(s).slice(0, 1500)}\n${g.logs.slice(-12).join('\n')}`);
    await new Promise((r) => setTimeout(r, 400));
  }
};
const CARRIED = () => ({ platformPolicyCarriers: { peers: [`http://${CARRIER_ADDR}:${mirrorPort}/platform-policy`] } });

before(async () => {
  if (skip) return;
  globalThis.fetch = netFetch;
  rig = await startRig();
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  ownership = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  await rig.write(rig.wc(KEYS.owner), rig.addresses.registry, rig.A.registry4.abi, 'register', [PUB, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  mirrorPort = await freePort();
  mirror = await startPolicyMirror({ port: mirrorPort, bind: '127.0.0.1', stateDir: path.join(tmp, 'other-host-policy-mirror'), rpc: rig.rpcs,
    book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), peers: [], syncSec: 5 }, { fetch: netFetch, log: () => {} });
  for (let i = 0; i < 3; i++) await rig.mine();
});
after(async () => { await mirror?.close(); await rig?.stop(); globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

test('unanchored: the supervisor gate admits with and without carriers (today\'s behaviour, not activated)', { skip, timeout: 120000 }, async () => {
  for (const fw of [CARRIED(), {}]) {
    const g = await supervisorGate('unanchored', fw);
    const s = await settle(g, (x) => x.serving === true, 'admitted while unanchored');
    assert.equal(g.gate.newWorkRefusal(), null); assert.equal(g.gate.serviceRefusal(), null);
    assert.match(JSON.stringify(s.runtime), /not activated|unanchored/i);
  }
});

test('anchored policy, ban and readmission through ANOTHER host\'s carrier with every former fleet mirror refused; the old source never admits', { skip, timeout: 240000 }, async () => {
  const hostOperator = hostOp.address.toLowerCase();
  const p1 = await sign([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated abuse' }]);
  await publish(p1); await anchor(p1.digest);
  // fresh supervisor, empty state: admitted only by the anchored document the carrier holds
  const g = await supervisorGate('carried', CARRIED());
  let s = await settle(g, (x) => x.serving === true && x.runtime?.accepted?.digest === p1.digest, 'admitted from the carrier under the anchor');
  assert.ok(denied.some((u) => u.startsWith(DO_MIRRORS[0])), 'the gate tried the former fleet mirrors and they were refused');
  assert.ok(g.logs.some((l) => /policy carriers: peers 1/.test(l)), g.logs.join('\n'));
  // NEGATIVE CONTROL: the same chain, the old source's composition (no carrier crosses): never a first admit
  const oldFw = (await launched(CARRIED(), {}, oldLauncher())).fw;
  assert.equal('platformPolicyCarriers' in oldFw, false);
  const gOld = await supervisorGate('old', oldFw, { old: true });
  await new Promise((r) => setTimeout(r, 3000)); await gOld.gate.check().catch(() => {});
  const so = gOld.gate.status();
  assert.equal(so.serving, false, JSON.stringify(so)); assert.notEqual(gOld.gate.newWorkRefusal(), null);
  assert.match(String(so.reason), /has not loaded the policy the book anchors|anchored policy is not available|not available/, JSON.stringify(so));

  // the admin's ban of this host's operator: published to the carrier, anchored -> refused, sticky
  const ban = await sign([...p1.policy.deny, { kind: 'operator', value: hostOperator, reason: 'abuse report 9' }]);
  await publish(ban); await anchor(ban.digest);
  s = await settle(g, (x) => x.serving === false && x.banned === true, 'refused by the anchored ban');
  assert.match(String(g.gate.serviceRefusal()), /banned by platform policy #2 \(operator\): abuse report 9/);
  await new Promise((r) => setTimeout(r, 1500)); await g.gate.check();
  assert.equal(g.gate.status().serving, false, 'stays refused while the ban is anchored');
  // a fresh supervisor under the anchored ban never admits either
  const gFresh = await supervisorGate('fresh-banned', CARRIED());
  await settle(gFresh, (x) => x.serving === false && x.banned === true, 'a fresh gate loads the ban too');

  // the readmission: the next admin-signed document, anchored
  const unban = await sign(p1.policy.deny);
  await publish(unban); await anchor(unban.digest);
  s = await settle(g, (x) => x.serving === true && x.runtime?.accepted?.sequence === 3, 'admitted again after the authenticated unban');
  assert.equal(g.gate.newWorkRefusal(), null);
});

test('stale or substituted carrier bytes never become an admission; nothing in the carrier confers authority', { skip, timeout: 120000 }, async () => {
  const anchored = docs[docs.length - 1];
  // stale: the carrier answers the anchored digest with an OLDER, validly signed document
  substitute = { document: docs[0].document, signature: docs[0].signature };
  try {
    const g = await supervisorGate('stale', CARRIED());
    await new Promise((r) => setTimeout(r, 3000)); await g.gate.check().catch(() => {});
    assert.equal(g.gate.status().serving, false, JSON.stringify(g.gate.status()));
    // substituted: edited content under the anchored document's real signature
    const edited = JSON.parse(anchored.document); edited.deny = [];
    substitute = { document: JSON.stringify(edited), signature: anchored.signature };
    const g2 = await supervisorGate('substituted', CARRIED());
    await new Promise((r) => setTimeout(r, 3000)); await g2.gate.check().catch(() => {});
    assert.equal(g2.gate.status().serving, false, JSON.stringify(g2.gate.status()));
  } finally { substitute = null; }
  // the honest carrier again: admitted (the refusals above were the bytes, not the transport)
  const g3 = await supervisorGate('honest', CARRIED());
  await settle(g3, (x) => x.serving === true && x.runtime?.accepted?.digest === anchored.digest, 'admitted from honest bytes');
});

test('an invalid carrier setting reaching the guest refuses work and service in the supervisor (never admission, never a silent run without carriers)', { skip, timeout: 60000 }, async () => {
  const g = await supervisorGate('invalid', { platformPolicyCarriers: { peers: [`${PUB}/platform-policy`] } });
  assert.equal(g.gate.enabled, true);
  assert.match(String(g.gate.newWorkRefusal()), /platform host policy: ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS/);
  assert.match(String(g.gate.serviceRefusal()), /platform host policy/);
  assert.ok(g.logs.some((l) => /REFUSING work and service/.test(l)));
});
