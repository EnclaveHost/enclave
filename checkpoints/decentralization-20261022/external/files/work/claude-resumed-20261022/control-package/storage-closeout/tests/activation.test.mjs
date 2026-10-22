// storage-closeout activation helpers + the pinned host-software closure, offline. Every helper and the ROLE's own CLI run
// from an ISOLATED copy of host-software/tree (under os.tmpdir(): no parent node_modules, so a missing closure file fails
// here), against the existing test-only platform policy world (loopback RPCs + HTTPS mirror, admin-signed policies;
// work/enclave/test/helpers/platform-policy-world.mjs) and the real rc2 package bytes. No real chain, key or host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url)), SC = path.resolve(HERE, '..'), WORK = path.resolve(SC, '../../..');
const ENCLAVE = path.join(WORK, 'enclave');
const { platformPolicyWorld } = await import(path.join(ENCLAVE, 'test/helpers/platform-policy-world.mjs'));
const { generatePrivateKey, privateKeyToAccount } = await import(path.join(ENCLAVE, 'node_modules/viem/_esm/accounts/index.js'));
const { keccak256, toBytes } = await import(path.join(ENCLAVE, 'node_modules/viem/_esm/index.js'));
const DIST = path.join(WORK, 'storage-host-role/package/dist/enclave-storage-indexer-1.0.0-rc2.tar.zst');
const PG = path.join(WORK, 'storage-host-role/pg18/root');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const idOf = (e) => keccak256(toBytes(e)).toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, every = 750) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn(); if (last.ok) return last; await wait(every); } return last; }
const run = (bin, args, env) => new Promise((ok) => { const c = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => ok({ code, out, err })); });
const lastJson = (s) => { const l = s.trim().split('\n').filter((x) => x.trim().startsWith('{')).pop(); try { return JSON.parse(l); } catch { return null; } };
const roleJson = (s) => { const i = s.search(/^\{/m); try { return i < 0 ? null : JSON.parse(s.slice(i)); } catch { return null; } };   // the role CLI prints indented JSON

test('storage-closeout: isolated closure + gate preflight + descriptor + render + the role check, against the policy world', { timeout: 600_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-closeout-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // the pinned closure, copied byte for byte; its manifest must verify there
  const HS = path.join(tmp, 'opt/enclave-host-software/tree'); fs.cpSync(path.join(SC, 'host-software/tree'), HS, { recursive: true });
  for (const line of fs.readFileSync(path.join(SC, 'host-software/MANIFEST.sha256'), 'utf8').trim().split('\n')) {
    const [h, rel] = line.split('  '); assert.equal(sha(fs.readFileSync(path.join(HS, rel))), h, rel);
  }
  assert.ok(!fs.existsSync(path.join(tmp, 'node_modules')) && !fs.existsSync(path.join(os.tmpdir(), 'node_modules')), 'no parent node_modules can mask a missing closure file');
  fs.mkdirSync(path.join(tmp, 'pkg')); execFileSync('bash', ['-c', `zstd -q -d -c "${DIST}" | tar -C "${tmp}/pkg" -xf -`]);
  const pkgDir = path.join(tmp, 'pkg/enclave-storage-indexer'); const pin = 'sha256:' + sha(fs.readFileSync(path.join(pkgDir, 'MANIFEST.sha256')));

  const operator = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
  const endpoint = 'https://api.enclave.host/t/metal0', hostId = idOf(endpoint);
  const w = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint, operator: operator.address.toLowerCase(), owner: operator.address.toLowerCase(), active: true } } });
  await w.publish({ deny: [] });
  const env = { PATH: '/usr/bin:/bin', HOME: tmp, NODE_EXTRA_CA_CERTS: w.ca };
  const node = (script, args) => run(process.execPath, [path.join(SC, 'activation', script), ...args, '--host-software', HS], env);   // subcommand first
  const gp = (extra = []) => node('gate-preflight.mjs', ['--endpoint', endpoint, '--policy', JSON.stringify(w.config), '--rpcs', w.rpcs.join(','), '--timeout-ms', '8000', ...extra]);
  const seenReasons = new Set();
  const verdict = async (want) => until(async () => { const r = await gp(); const j = lastJson(r.out) || {}; seenReasons.add(`${j.verdict}:${j.gate?.reason}:${j.registry?.error || ''}:${r.err.slice(-200)}`); return { ok: j.verdict === want, j, r }; }, 60000);

  // 1. ADMISSIBLE before any descriptor exists, from the isolated closure (the role's dynamic imports all resolve)
  let g = await verdict('ADMISSIBLE');
  assert.equal(g.j.verdict, 'ADMISSIBLE', JSON.stringify([...seenReasons]) + g.r.err.slice(-400)); assert.equal(g.r.code, 0);
  assert.equal(g.j.hostId, hostId); assert.equal(g.j.registry.operator, operator.address.toLowerCase()); assert.equal(g.j.platformPolicy, 'on');
  // 2. refusals: an admin ban, an inactive registry entry; an outage is UNKNOWN, never admitted; policy off never runs
  await w.publish({ deny: [{ kind: 'registryId', value: hostId, reason: 'abuse' }] });
  g = await verdict('NOT_ADMISSIBLE'); assert.equal(g.j.verdict, 'NOT_ADMISSIBLE'); assert.match(g.j.why, /banned/); assert.equal(g.r.code, 1);
  await w.publish({ deny: [] }); w.state.hosts[hostId].active = false;
  g = await until(async () => { const r = await gp(); const j = lastJson(r.out) || {}; return { ok: j.verdict === 'NOT_ADMISSIBLE' && /not active/.test(j.why), j, r }; });
  assert.ok(g.ok, JSON.stringify(g.j));
  w.state.hosts[hostId].active = true; w.setDown(true);
  const down = lastJson((await gp()).out); assert.notEqual(down.verdict, 'ADMISSIBLE', 'an unreadable policy/registry is never admitted'); w.setDown(false);
  const off = lastJson((await node('gate-preflight.mjs', ['--endpoint', endpoint, '--policy', 'off'])).out); assert.equal(off.verdict, 'NOT_ADMISSIBLE');
  g = await verdict('ADMISSIBLE'); assert.equal(g.j.verdict, 'ADMISSIBLE');

  // 3. the descriptor: request bytes, the OPERATOR signs, assemble verifies with the role's verifyDescriptor
  const advertise = 'https://r1.indexer.example';
  const req = await node('descriptor.mjs', ['request', '--package-dir', pkgDir, '--endpoint', endpoint, '--replica', 'r1', '--advertise', advertise, '--operator', g.j.registry.operator]);
  assert.equal(req.code, 0, req.err); const rq = JSON.parse(req.out); fs.writeFileSync(path.join(tmp, 'request.json'), req.out);
  assert.equal(rq.packagePin, pin); assert.equal(rq.hostId, hostId); assert.match(rq.eip191Digest, /^0x[0-9a-f]{64}$/);
  const bad = await node('descriptor.mjs', ['assemble', '--request', path.join(tmp, 'request.json'), '--signature', await stranger.signMessage({ message: rq.descriptor }), '--out', path.join(tmp, 'bad.json')]);
  assert.equal(bad.code, 1); assert.ok(!fs.existsSync(path.join(tmp, 'bad.json')), 'another key\'s signature never produces a descriptor file');
  const sig = await operator.signMessage({ message: rq.descriptor }); const dFile = path.join(tmp, 'descriptor.json');
  const asm = await node('descriptor.mjs', ['assemble', '--request', path.join(tmp, 'request.json'), '--signature', sig, '--out', dFile]); assert.equal(asm.code, 0, asm.err);
  const again = await node('descriptor.mjs', ['assemble', '--request', path.join(tmp, 'request.json'), '--signature', sig, '--out', dFile]); assert.equal(again.code, 1, 'never overwrites');
  const noAdv = await node('descriptor.mjs', ['request', '--package-dir', pkgDir, '--endpoint', endpoint, '--replica', 'r1', '--operator', g.j.registry.operator]);
  assert.equal(noAdv.code, 1); assert.match(noAdv.err, /MISSING/);

  // 4. render-config: host.json the ROLE accepts + replica.env the PACKAGE accepts; refusals never invent a value
  const inputs = { endpoint, replica: 'r1', advertiseURL: advertise, pgBin: path.join(PG, 'usr/bin'), pgLibDir: path.join(PG, 'usr/lib'), hostSoftwareDir: HS, packageDir: pkgDir,
                   platformHostPolicy: 'production', failureDomain: { site: 'fixture-site', provider: 'fixture-provider', power: 'fixture-power' } };
  const render = async (inp, out) => { const f = path.join(tmp, `in-${out}.json`); fs.writeFileSync(f, JSON.stringify(inp)); return node('render-config.mjs', ['--inputs', f, '--out', path.join(tmp, out)]); };
  const rr = await render(inputs, 'cfg'); assert.equal(rr.code, 0, rr.err);
  for (const [name, mut, re] of [['no advertise', { advertiseURL: '' }, /MISSING advertiseURL/], ['DO provider', { failureDomain: { ...inputs.failureDomain, provider: 'DigitalOcean' } }, /DigitalOcean/],
                                 ['DO-only name', { advertiseURL: 'https://sia.enclave.host' }, /only to DigitalOcean/], ['home', { hostSoftwareDir: '/home/x/enclave' }, /hostSoftwareDir/],
                                 ['placeholder', { replica: '@REPLICA@' }, /placeholder/]]) {
    const x = await render({ ...inputs, ...mut }, 'cfg-' + name.replace(/\W/g, '')); assert.equal(x.code, 1, name); assert.match(x.err, re, name);
  }
  assert.equal((await render(inputs, 'cfg')).code, 1, 'never overwrites a rendered config');
  const env1 = fs.readFileSync(path.join(tmp, 'cfg/replica.env'), 'utf8');
  assert.deepEqual(env1.trim().split('\n').map((l) => l.split('=')[0]), ['REPLICA', 'ADVERTISE_URL', 'ENCLAVE_HOST_ID', 'FAILURE_DOMAIN_SITE', 'FAILURE_DOMAIN_PROVIDER', 'FAILURE_DOMAIN_POWER', 'PG_BIN', 'ENCLAVE_HOST_SOFTWARE']);
  // the package's OWN preflight accepts it (test root; fake DMI/meminfo), and refuses a DigitalOcean machine
  const esi = path.join(tmp, 'esi'); fs.mkdirSync(path.join(esi, 'etc/enclave-storage-indexer/r1'), { recursive: true }); fs.copyFileSync(path.join(tmp, 'cfg/replica.env'), path.join(esi, 'etc/enclave-storage-indexer/r1/replica.env'));
  const dmi = path.join(tmp, 'dmi'); fs.mkdirSync(dmi); for (const f of ['sys_vendor', 'board_vendor', 'bios_vendor', 'chassis_vendor']) fs.writeFileSync(path.join(dmi, f), 'Fixture Inc.\n');
  fs.writeFileSync(path.join(tmp, 'meminfo'), 'MemAvailable:   8388608 kB\n');
  const pre = (d) => run('bash', [path.join(pkgDir, 'libexec/preflight'), 'r1'], { ...env, ESI_TEST_ROOT: esi, ESI_TEST_DMI: d, ESI_TEST_MEMINFO: path.join(tmp, 'meminfo'), LD_LIBRARY_PATH: path.join(PG, 'usr/lib') });
  const p1 = await pre(dmi); assert.equal(p1.code, 0, p1.err + p1.out); assert.match(p1.out, /PREFLIGHT OK: replica r1/);
  fs.writeFileSync(path.join(dmi, 'sys_vendor'), 'DigitalOcean\n'); const p2 = await pre(dmi); assert.equal(p2.code, 1); assert.match(p2.err, /DigitalOcean machines are transport-only/);

  // 5. the ROLE's own `check`, from the isolated closure, admits the rendered config + the assembled descriptor (fixture
  //    policy/RPCs and descriptor path substituted for the production values: the role runs exactly its production code)
  const hj = JSON.parse(fs.readFileSync(path.join(tmp, 'cfg/host.json'), 'utf8'));
  const fixture = { ...hj, platformHostPolicy: w.config, platformHostPolicyRpcs: w.rpcs, descriptorFile: dFile, stateRoot: path.join(tmp, 'state'), runtimeDir: path.join(tmp, 'run'), credentialsDir: path.join(tmp, 'cred') };
  fs.writeFileSync(path.join(tmp, 'host-fixture.json'), JSON.stringify(fixture));
  const ck = await until(async () => { const r = await run(process.execPath, [path.join(HS, 'network/host-services/storage-indexer-host.mjs'), 'check', path.join(tmp, 'host-fixture.json')], env);
    const j = roleJson(r.out) || {}; return { ok: j.admit === true, j, r }; });
  assert.equal(ck.j.admit, true, JSON.stringify(ck.j) + ck.r.err.slice(-300)); assert.equal(ck.j.operator, operator.address.toLowerCase());
});
