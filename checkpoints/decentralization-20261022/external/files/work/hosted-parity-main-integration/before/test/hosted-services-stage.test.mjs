// The stage-1 rollout ARCHIVE (work/hosted-services-activation/build-stage.mjs) in a dependency-free directory with the real
// Node and nothing else: no node_modules in any parent directory, no NODE_PATH, an empty environment (PATH only).
//   1. the PRODUCTION stage as built: compare-and-swap install into a fake root, `runner check` of the exact production
//      configuration (four final pins, no warnings), idempotent re-run, refusal of changed bytes, exact rollback that
//      keeps a changed file and every pre-existing file; systemd-analyze verify of the unit;
//   2. the SAME archive live on a local chain (anvil): only its configuration's chain addresses, RPCs, ports and fixture
//      manifest are swapped for the local ones. The installed unit's own ExecStart runs the bundled runner (a systemctl
//      test double moves its absolute paths under the fake root). Covered:
//      - fill-data copies artifacts with digest checks;
//      - policy-import on an UNANCHORED book writes nothing, and the unchanged gate admits as "not-activated";
//      - stage-1 health passes for the gate and all four roles (real HTTP and real DNS);
//      - the admin anchors a policy: policy-import verifies and imports it, and health shows "current" with the mirror
//        serving it;
//      - the admin bans the host's operator: every role stops and health fails on the gate;
//      - stop.sh: the runner exits on SIGTERM with no child left and no port listening;
//      - rollback.sh restores the fake root exactly.
//   3. the runner's registry-endpoint fix: warden's real endpoint (with a path) is accepted and hashes to its host id.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import * as si from '../network/service-index.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';
import { validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { hostIdOfEndpoint } from '../network/host-service-gate.mjs';
import { artifactIdentity } from '../sdk/storage/unixfs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAR = process.env.STAGE_TAR;
const NODE = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath;
const WARDEN = 'https://api.enclave.host/t/metal0', WARDEN_ID = '0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be';
// haveTools() is null when anvil and openssl ARE present (node:test skips on any non-false value, null included)
const skip = haveTools() || (!TAR || !fs.existsSync(TAR) ? 'needs STAGE_TAR (the built archive)' : false);
const OUT = path.join(REPO, 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + '.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const compileIndexInChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { compileServiceIndex } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/network/service-index.mjs')).href)}; process.stdout.write(JSON.stringify(compileServiceIndex()));`],
  { maxBuffer: 16 << 20, timeout: 180000 }).toString());
const sha = (b) => createHash('sha256').update(b).digest('hex');
const Z32 = '0x' + '00'.repeat(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostsvc-stage-'));
const wait = async (f, ms, what) => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 300)); } };
const listening = (port) => new Promise((ok) => { const s = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (r) => { r.resume(); ok(true); }); s.on('error', () => ok(false)); s.on('timeout', () => { s.destroy(); ok(false); }); });

function extract(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', TAR, '-C', dir]);
  const stage = path.join(dir, fs.readdirSync(dir)[0]);
  for (let d = stage; d !== path.dirname(d); d = path.dirname(d)) assert.equal(fs.existsSync(path.join(d, 'node_modules')), false, `node_modules above the stage at ${d}`);
  return stage;
}
// a systemctl test double: records every call; with FAKE_LIVE=1, start runs the installed unit's ExecStart (absolute paths
// moved under DESTDIR, the configuration's paths too) in an EMPTY environment, and stop sends SIGTERM like systemd
function fakeSystemctl(dir) {
  const f = path.join(dir, 'systemctl');
  fs.writeFileSync(f, `#!/bin/bash
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
[ "$1" = "--quiet" ] && shift
cmd=$1
unitfile=$DESTDIR/etc/systemd/system/enclave-host-services.service; pidf=$DESTDIR/fake-unit.pid
case "$cmd" in
 clean) rm -rf "$DESTDIR/var/lib/enclave-host-services"; exit 0 ;;
 start) [ "$FAKE_LIVE" = 1 ] || exit 0
   line=$(grep '^ExecStart=' "$unitfile" | head -1 | cut -d= -f2-)
   cfg=$(echo "$line" | awk '{print $NF}'); pcfg=$DESTDIR/fake-unit-config.json
   sed -e "s#\\"/opt/enclave-host-services/#\\"$DESTDIR/opt/enclave-host-services/#g" -e "s#\\"/var/lib/enclave-host-services#\\"$DESTDIR/var/lib/enclave-host-services#g" "$DESTDIR$cfg" > "$pcfg"
   line=$(echo "$line" | sed -e "s#/opt/enclave-host-services/#$DESTDIR/opt/enclave-host-services/#" -e "s#$cfg#$pcfg#")
   mkdir -p "$DESTDIR/var/lib/enclave-host-services"; cd "$DESTDIR/var/lib/enclave-host-services"
   setsid env -i PATH=/usr/bin:/bin $line > "$DESTDIR/fake-unit.log" 2>&1 < /dev/null &
   echo $! > "$pidf"; exit 0 ;;
 stop) [ -f "$pidf" ] || exit 0; pid=$(cat "$pidf")
   kill -TERM "$pid" 2>/dev/null; for i in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
   if kill -0 "$pid" 2>/dev/null; then kill -KILL -- -"$pid"; echo KILLED >> "$FAKE_SYSTEMCTL_LOG"; fi
   wait "$pid" 2>/dev/null; rm -f "$pidf"; exit 0 ;;
 is-active) [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && exit 0; exit 3 ;;
 show) echo ActiveState=fake; exit 0 ;;
 *) exit 0 ;;
esac
`);
  fs.chmodSync(f, 0o755);
  return f;
}
// ASYNC on purpose: the rig's RPC origins are HTTP proxies inside THIS process, so a synchronous spawn would block them
function sh(stage, script, args, { destdir, systemctl, live = false, log, extraEnv = {} }) {
  return new Promise((ok) => {
    const c = spawn('bash', [path.join(stage, 'scripts', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: tmp, DESTDIR: destdir, SYSTEMCTL: systemctl, NODE, FAKE_SYSTEMCTL_LOG: log, FAKE_LIVE: live ? '1' : '0', ...extraEnv } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 900_000);
    c.on('close', (status) => { clearTimeout(t); ok({ status, out: stdout + stderr, stdout }); });
  });
}
const filesUnder = (d) => { const out = []; const walk = (x) => { for (const n of fs.readdirSync(x)) { const p = path.join(x, n); if (fs.lstatSync(p).isDirectory()) walk(p); else out.push(path.relative(d, p)); } }; walk(d); return out.sort(); };

// a failing run must not leave the unit's runner and roles behind (the test double starts them in their own session)
after(() => {
  for (const root of ['root1', 'root2']) {
    const pidf = path.join(tmp, root, 'fake-unit.pid');
    if (!fs.existsSync(pidf)) continue;
    const pid = Number(fs.readFileSync(pidf, 'utf8'));
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    const end = Date.now() + 10000;
    while (Date.now() < end) { try { process.kill(-pid, 0); } catch { break; } spawnSync('sleep', ['0.2']); }
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the production stage: verified compare-and-swap install, exact production `runner check`, and an exact rollback', { skip }, async () => {
  const stage = extract(path.join(tmp, 'x1')), root = path.join(tmp, 'root1'), log = path.join(tmp, 'sc1.log');
  for (const d of ['etc/systemd/system', 'opt', 'var/lib']) fs.mkdirSync(path.join(root, d), { recursive: true });   // as on a real host
  fs.writeFileSync(path.join(root, 'etc/systemd/system/existing-app.service'), '[Service]\nExecStart=/bin/true\n');   // must survive untouched
  const sc = fakeSystemctl(tmp), o = { destdir: root, systemctl: sc, log };
  const cfg = JSON.parse(fs.readFileSync(path.join(stage, 'config/host-services.json'), 'utf8'));
  assert.equal(cfg.platformHostPolicy, 'production'); assert.equal(cfg.host.endpoint, WARDEN); assert.deepEqual(cfg.host.publicEndpoints, {}, 'stage 1 advertises nothing');
  assert.deepEqual(cfg.services.map((s) => s.package).sort(), ['sha256:2d69a8be882bea9fc107208a3828e25a773ce0c988eac6347d377904e9e78668', 'sha256:350c276f17a0ea15fc0451c614146554c2b08cf89c9b3258013ac188950d3cf8',
    'sha256:7732950bc2f6385275278553bd36f5372a799f3183b2e26abebadd940414dffc', 'sha256:a031723ee86c9bf3a2489936a3c7449a6c72ff9b999902e57644c9fbc773eb41']);
  for (const s of cfg.services) for (const k of ['bind', 'apiBind']) if (s.config[k]) assert.equal(s.config[k], '127.0.0.1');
  let r = await sh(stage, 'install.sh', [], o);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /installed stage hs1 \(first install\)/); assert.match(r.out, /NOT started and NOT enabled/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /^(start|enable|restart)/m, 'install starts and enables nothing');
  r = await sh(stage, 'install.sh', [], o); assert.equal(r.status, 0, r.out); assert.match(r.out, /re-run, unchanged/);
  const tool = path.join(root, 'opt/enclave-host-services/hs1/bin/stage-tool.mjs');
  fs.appendFileSync(tool, '\n// changed');
  r = await sh(stage, 'install.sh', [], o); assert.equal(r.status, 3); assert.match(r.out, /differs from this stage/);
  // a fresh root that already has an enclave-host-services unit of someone else's: refused, nothing written
  const other = path.join(tmp, 'root1b'); fs.mkdirSync(path.join(other, 'etc/systemd/system'), { recursive: true });
  fs.writeFileSync(path.join(other, 'etc/systemd/system/enclave-host-services.service'), '[Service]\nExecStart=/bin/false\n');
  r = await sh(stage, 'install.sh', [], { ...o, destdir: other }); assert.equal(r.status, 3); assert.match(r.out, /already exists/);
  assert.deepEqual(filesUnder(other), ['etc/systemd/system/enclave-host-services.service']);
  // rollback keeps the changed file (exit 4) and removes everything else install wrote
  r = await sh(stage, 'rollback.sh', [], o); assert.equal(r.status, 4, r.out); assert.match(r.out, /KEPT \(changed since install\): .*stage-tool\.mjs/);
  assert.deepEqual(filesUnder(root), ['etc/enclave-host-services/hs1/install-receipt.txt', 'etc/systemd/system/existing-app.service', 'opt/enclave-host-services/hs1/bin/stage-tool.mjs']);
  fs.rmSync(tool);
  r = await sh(stage, 'rollback.sh', [], o); assert.equal(r.status, 0, r.out);
  assert.deepEqual(filesUnder(root), ['etc/systemd/system/existing-app.service'], 'exactly the pre-install state');
  assert.equal(fs.readFileSync(path.join(root, 'etc/systemd/system/existing-app.service'), 'utf8'), '[Service]\nExecStart=/bin/true\n');
  assert.deepEqual([fs.readdirSync(path.join(root, 'opt')), fs.readdirSync(path.join(root, 'var/lib')), fs.readdirSync(path.join(root, 'etc')).sort()], [[], [], ['systemd']],
    'the directories install created are gone, and only those');
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^stop enclave-host-services\.service$/m); assert.match(calls, /^clean --what=state enclave-host-services\.service$/m);
  for (const line of calls.split('\n').filter(Boolean)) if (line !== 'daemon-reload') assert.match(line, /enclave-host-services\.service$/, `only this unit is touched: ${line}`);
  // the unit file itself
  const v = spawnSync('systemd-analyze', ['verify', '--man=no', path.join(stage, 'systemd/enclave-host-services.service')], { encoding: 'utf8' });
  assert.doesNotMatch(v.stderr + v.stdout, /Unknown (key|section)|Invalid|Failed to parse|bad-setting|Unknown lvalue/i, v.stderr);
  const unit = fs.readFileSync(path.join(stage, 'systemd/enclave-host-services.service'), 'utf8');
  for (const k of ['MemoryMax=1024M', 'MemoryHigh=768M', 'MemorySwapMax=0', 'CPUQuota=150%', 'TasksMax=256', 'Restart=on-failure', 'DynamicUser=yes', 'KillMode=mixed'])
    assert.match(unit, new RegExp('^' + k.replace(/[%=]/g, (c) => c) + '$', 'm'), k);
});

let rig, book, ownership, bookAbi, index, indexPin, docs = [];
async function sign(deny) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await privateKeyToAccount(KEYS.deployer).signTypedData(policyTypedData(p)) };
  docs.push(d); return d;
}
const anchor = async (digest) => { const a = encodeAnchor(digest); await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); await rig.mine(); };
before(async () => {
  if (skip) return;
  rig = await startRig();
  const built = compileIndexInChild();
  index = (await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).deployContract({ abi: built.abi, bytecode: built.bytecode }) })).contractAddress;
  indexPin = si.validateIndexPin({ chainId: 8453, address: index, codeHash: built.codeHash });
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi; book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  ownership = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  // warden's REAL registry endpoint, registered on the local chain by a host operator
  await rig.write(rig.wc(KEYS.other), rig.addresses.registry, rig.A.registry4.abi, 'register', [WARDEN, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  for (let i = 0; i < 3; i++) await rig.mine();
});
after(async () => { await rig?.stop(); });

test('the same archive live on a local chain: unanchored -> anchored import -> ban, with stage-1 health, stop and rollback', { skip }, async () => {
  const stage = extract(path.join(tmp, 'x2')), root = path.join(tmp, 'root2'), log = path.join(tmp, 'sc2.log');
  for (const d of ['etc/systemd/system', 'opt', 'var/lib']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const sc = fakeSystemctl(tmp), o = { destdir: root, systemctl: sc, log, live: true };
  // the local chain's addresses, RPCs, free ports and a fixture manifest in place of production's (nothing else changes)
  const fixture = path.join(tmp, 'fixture-artifacts'); fs.mkdirSync(fixture);
  const objects = [];
  for (const n of [1, 2]) {
    const bytes = Buffer.from(`enclave bootstrap fixture ${n} ` + 'x'.repeat(2048 * n)), car = Buffer.concat([Buffer.from('car:'), bytes]), cid = artifactIdentity(new Uint8Array(bytes)).cid;
    fs.writeFileSync(path.join(fixture, `${cid}.bin`), bytes); fs.writeFileSync(path.join(fixture, `${cid}.car`), car);
    objects.push({ cid, bytes: bytes.length, sha256: sha(bytes), carSha256: sha(car) });
  }
  const ports = { dir: await freePort(), boot: await freePort(), dns: await freePort(), api: await freePort(), pm: await freePort() };
  const cfg = JSON.parse(fs.readFileSync(path.join(stage, 'config/host-services.json'), 'utf8'));
  const pins = { deployments: rig.addresses.ledger, registry: rig.addresses.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) };
  cfg.platformHostPolicy = { book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: [], activation: 'anchor' };
  cfg.platformHostPolicyRpcs = rig.rpcs; cfg.serviceIndex = indexPin;
  const svc = Object.fromEntries(cfg.services.map((s) => [s.role, s.config]));
  Object.assign(svc['directory-replica'], { port: ports.dir, rpc: rig.rpcs, addressBook: book, authorityPins: pins, peers: [] });
  Object.assign(svc['bootstrap-replica'], { port: ports.boot });
  Object.assign(svc['route-dns'], { dnsPort: ports.dns, apiPort: ports.api, routeMapUrl: `http://127.0.0.1:${ports.dir}/v1/network/routes` });
  Object.assign(svc['policy-mirror'], { port: ports.pm, rpc: rig.rpcs, minAgree: 2, book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), peers: [], syncSec: 5 });
  fs.writeFileSync(path.join(stage, 'config/host-services.json'), JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(path.join(stage, 'data/bootstrap-manifest.json'), JSON.stringify({ verifiedObjects: objects }));
  const sums = fs.readFileSync(path.join(stage, 'STAGE-SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => {
    const f = l.slice(66); return ['config/host-services.json', 'data/bootstrap-manifest.json'].includes(f) ? `${sha(fs.readFileSync(path.join(stage, f)))}  ${f}` : l; });
  fs.writeFileSync(path.join(stage, 'STAGE-SHA256SUMS'), sums.join('\n') + '\n');
  const chain = ['--rpc', rig.rpcs[0], '--rpc', rig.rpcs[1], '--rpc', rig.rpcs[2], '--book', book, '--host-ownership', ownership];

  let r = await sh(stage, 'install.sh', [], o); assert.equal(r.status, 0, r.out);
  r = await sh(stage, 'fill-data.sh', ['artifacts', '--from-dir', fixture], o); assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(r.stdout).missing.length, 0);
  // UNANCHORED: explicit, nothing written
  r = await sh(stage, 'fill-data.sh', ['policy', ...chain], o); assert.equal(r.status, 0, r.out);
  const un = JSON.parse(r.stdout); assert.equal(un.state, 'unanchored'); assert.equal(un.wrote, null); assert.match(un.meaning, /not-activated/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'var/lib/enclave-host-services-data/hs1/policy-import')), []);
  // start: the unit's ExecStart (the bundled runner) in an empty environment, then stage-1 health
  r = await sh(stage, 'start.sh', [], { ...o, extraEnv: { HEALTH_WAIT: '180' } });
  assert.equal(r.status, 0, r.out + '\n--- unit log\n' + (fs.existsSync(path.join(root, 'fake-unit.log')) ? fs.readFileSync(path.join(root, 'fake-unit.log'), 'utf8').slice(-4000) : ''));
  for (const name of ['gate: platform host policy admits this host now', 'directory-replica /health', 'bootstrap-replica serves the manifest', 'route-dns answers SOA and NS', 'policy-mirror /health'] )
    assert.match(r.out, new RegExp(`PASS  ${name.replace(/[/()]/g, (c) => '\\' + c)}`), name);
  assert.match(r.out, /"status":"not-activated"/); assert.match(r.out, new RegExp(`"hostId":"${WARDEN_ID}"`));
  // ANCHORED: the admin signs and anchors; policy-import fetches it from a carrier and verifies it before writing
  const docsServed = new Map();
  const carrier = http.createServer((req, res) => { const m = /^\/policy\/(0x[0-9a-f]{64})\.json$/.exec(req.url); const d = m && docsServed.get(m[1]);
    if (!d) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ document: d.document, signature: d.signature })); });
  await new Promise((ok) => carrier.listen(0, '127.0.0.1', ok));
  const carrierUrl = `http://127.0.0.1:${carrier.address().port}/policy`;
  try {
    const p1 = await sign([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated' }]); docsServed.set(p1.digest, p1); await anchor(p1.digest);
    r = await sh(stage, 'fill-data.sh', ['policy', '--carrier', carrierUrl, ...chain], o); assert.equal(r.status, 0, r.out);
    const imp = JSON.parse(r.stdout); assert.equal(imp.state, 'anchored'); assert.equal(imp.digest, p1.digest);
    assert.ok(fs.existsSync(path.join(root, `var/lib/enclave-host-services-data/hs1/policy-import/${p1.digest}.json`)));
    r = await sh(stage, 'health.sh', ['--wait', '120'], o); assert.equal(r.status, 0, r.out);
    assert.match(r.out, /"status":"current"/); assert.match(r.out, new RegExp(`"anchor":"${p1.digest}","anchoredAvailable":true`));
    // a substituted document under the real signature is refused and nothing is written
    const fake = { ...p1, document: JSON.stringify({ ...p1.policy, deny: [] }) };
    const p2 = await sign([...p1.policy.deny, { kind: 'operator', value: privateKeyToAccount(KEYS.other).address.toLowerCase(), reason: 'abuse report' }]);
    docsServed.set(p2.digest, { ...fake }); await anchor(p2.digest);
    r = await sh(stage, 'fill-data.sh', ['policy', '--carrier', carrierUrl, ...chain], o); assert.equal(r.status, 3, r.out); assert.match(r.out, /refused: no carrier/);
    assert.equal(fs.existsSync(path.join(root, `var/lib/enclave-host-services-data/hs1/policy-import/${p2.digest}.json`)), false);
    // BAN: the real document; the runner stops every role, health fails on the gate
    docsServed.set(p2.digest, p2);
    r = await sh(stage, 'fill-data.sh', ['policy', '--carrier', carrierUrl, ...chain], o); assert.equal(r.status, 0, r.out);
    await wait(async () => !(await listening(ports.dir)) && !(await listening(ports.pm)) && !(await listening(ports.boot)), 60000, 'every role stops on the ban');
    // the refusal is sticky but the RUNNER STAYS UP (unit active, no role running) so an authenticated admit can resume it
    await new Promise((x) => setTimeout(x, 3000));
    r = await sh(stage, 'health.sh', [], o); assert.equal(r.status, 2, r.out);
    assert.doesNotMatch(r.out, /unit enclave-host-services\.service is not active/, 'the runner must stay up while banned');
    assert.match(r.out, /FAIL  gate: platform host policy admits this host now .*banned by platform policy #2 \(operator\): abuse report/);
    assert.match(fs.readFileSync(path.join(root, 'fake-unit.log'), 'utf8'), /STOPPING every role/);
    // UNBAN: the admin's next anchored policy, imported the same way; the same runner process restarts every role
    const p3 = await sign(p1.policy.deny); docsServed.set(p3.digest, p3); await anchor(p3.digest);
    r = await sh(stage, 'fill-data.sh', ['policy', '--carrier', carrierUrl, ...chain], o); assert.equal(r.status, 0, r.out);
    r = await sh(stage, 'health.sh', ['--wait', '120'], o); assert.equal(r.status, 0, r.out);
    assert.match(r.out, /"status":"current"/); assert.match(r.out, new RegExp(`"anchor":"${p3.digest}","anchoredAvailable":true`));
    assert.match(fs.readFileSync(path.join(root, 'fake-unit.log'), 'utf8'), /admitted again/);
  } finally { carrier.close(); }
  // STOP: SIGTERM to the runner; no child left, no stage port listening
  r = await sh(stage, 'stop.sh', [], o); assert.equal(r.status, 0, r.out); assert.match(r.out, /none of the stage ports/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /KILLED/, 'the runner exited on SIGTERM');
  const left = spawnSync('pgrep', ['-f', root], { encoding: 'utf8' }).stdout.trim(); assert.equal(left, '', `processes left: ${left}`);
  // ROLLBACK: exactly the pre-install state
  r = await sh(stage, 'rollback.sh', [], o); assert.equal(r.status, 0, r.out);
  assert.deepEqual(filesUnder(root).filter((f) => !f.startsWith('fake-unit')), [], 'nothing of the stage remains');
  assert.deepEqual([fs.readdirSync(path.join(root, 'opt')), fs.readdirSync(path.join(root, 'var/lib')), fs.readdirSync(path.join(root, 'etc')).sort()], [[], [], ['systemd']]);
});

test('the runner accepts warden\'s registry endpoint (with a path) and its host id is the registered one', () => {
  assert.equal(hostIdOfEndpoint(WARDEN), WARDEN_ID);
  const base = { format: 'enclave-host-services/v1', host: { endpoint: WARDEN }, platformHostPolicy: 'production', packagesDir: '/opt/x', stateRoot: '/var/x',
    services: [{ role: 'bootstrap-replica', package: 'sha256:' + '0'.repeat(64), config: { port: 1, bind: '127.0.0.1', directory: '/a', manifest: '/b' } }] };
  assert.equal(validateHostServicesConfig(base).host.endpoint, WARDEN);
  for (const bad of [`${WARDEN}?x=1`, `${WARDEN}#f`, 'https://user@api.enclave.host/t/metal0', 'http://api.enclave.host/t/metal0', 'https://api.enclave.host/t/me tal0'])
    assert.throws(() => validateHostServicesConfig({ ...base, host: { endpoint: bad } }), /registry endpoint/, bad);
});
