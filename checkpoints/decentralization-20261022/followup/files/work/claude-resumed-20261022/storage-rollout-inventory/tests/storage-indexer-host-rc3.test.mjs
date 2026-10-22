// rc3 DERIVED copy of test/storage-indexer-host.test.mjs (341e6363, unchanged): same lifecycle; only binds the rc3 package
// (version 1.0.0-rc3, indexd 2c0e5b06) and asserts db_version EXACTLY 28 (c2-enclave), with a diagnostic of the actual value.
// The storage-indexer HOST ROLE in REAL processes (network/host-services/storage-indexer-host.mjs):
//   - admission through the EXISTING platform host policy gate (network/host-service-gate.mjs) against the local policy
//     world (test/helpers/platform-policy-world.mjs: admin-signed, book-anchored policy; registry rows; outages);
//   - refusals: a descriptor signed by another key than the host's registry operator, a descriptor for another host,
//     a package that is not the pinned one, an admin BAN, an INACTIVE registry entry; the policy explicitly off;
//   - a real lifecycle on the reviewed package bytes (enclave-storage-indexer-1.0.0-rc1, indexd G-C2 e6e812fd...) and a
//     real PostgreSQL 18.6 (Arch packages verified and extracted into work/storage-host-role/pg18, no system install):
//     init (initdb, database, base config) -> run (PostgreSQL socket-only + indexd: its schema migrations) -> admin API ->
//     encrypted backup -> admin ban stops BOTH processes (data kept) -> unban restarts on the same data -> indexd crash
//     restarts -> restore into a fresh replica -> indexd starts on the restored database.
// Nothing here touches a real chain, key, host or network beyond loopback. Sia syncing is off (bootstrap false).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { platformPolicyWorld } from './helpers/platform-policy-world.mjs';
import { descriptorBytes } from '../network/host-services/storage-indexer-host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(ROOT, '..', '..');
const ROLE = path.join(ROOT, 'network/host-services/storage-indexer-host.mjs');
const PG = process.env.STORAGE_PG18_ROOT || path.join(WORK, 'storage-host-role/pg18/root');
const DIST = process.env.STORAGE_PACKAGE_TARBALL || path.join(WORK, 'storage-hosted-placement/package/dist/enclave-storage-indexer-1.0.0-rc1.tar.zst');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const idOf = (e) => keccak256(toBytes(e)).toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, every = 500) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn().catch(() => null); if (last) return last; await wait(every); } return last; }
const freePort = () => { const s = net.createServer(); return new Promise((r) => s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); })); };

test('storage-indexer host role: platform-policy admission, refusals, and a real PostgreSQL 18 + indexd lifecycle', { timeout: 900_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-role-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // the reviewed package bytes: unpack the frozen dist tarball; its pin is the digest of its MANIFEST.sha256
  fs.mkdirSync(path.join(tmp, 'pkg'));
  execFileSync('bash', ['-c', `zstd -q -d -c "${DIST}" | tar -C "${tmp}/pkg" -xf -`]);
  const pkgDir = path.join(tmp, 'pkg/enclave-storage-indexer');
  const pin = 'sha256:' + sha(fs.readFileSync(path.join(pkgDir, 'MANIFEST.sha256')));
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'PACKAGE.json'), 'utf8'));
  const RC3_INDEXD = '2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7';
  assert.equal(pkg.version, '1.0.0-rc3', 'the rc3 package'); assert.equal(pkg.indexd.sha256, RC3_INDEXD, 'PACKAGE.json names the c2-enclave indexd');
  assert.equal(sha(fs.readFileSync(path.join(pkgDir, pkg.indexd.file))), RC3_INDEXD, 'the bundled indexd bytes are 2c0e5b06');
  t.diagnostic(`package ${pkg.version} pin ${pin} indexd ${pkg.indexd.sha256}`);

  const operator = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
  // the PRODUCTION shape of a registered host endpoint (registry PUBLIC_URL), path included
  const endpoint = 'https://api.enclave.host/t/metal0', hostId = idOf(endpoint);
  const w = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint, operator: operator.address.toLowerCase(), owner: operator.address.toLowerCase(), active: true } } });
  await w.publish({ deny: [] });                                         // the admin's anchored policy (no denial)

  const replicaCfg = async (replica, { signer = operator, forHost = hostId, packagePin = pin } = {}) => {
    const root = path.join(tmp, replica);
    for (const d of ['state', 'run', 'cred']) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
    const [adminPort, appPort, syncPort] = [await freePort(), await freePort(), await freePort()];
    const advertiseURL = `https://${replica}.indexer.example`;
    const bytes = descriptorBytes({ operator: signer.address, hostId: forHost, replica, packagePin, advertiseURL, indexdSha256: pkg.indexd.sha256 });
    fs.writeFileSync(path.join(root, 'descriptor.json'), JSON.stringify({ descriptor: bytes, signature: await signer.signMessage({ message: bytes }) }));
    // the credentials systemd would decrypt into $CREDENTIALS_DIRECTORY: a fresh throwaway wallet phrase and admin password
    const phrase = execFileSync(path.join(pkgDir, pkg.indexd.file), ['seed'], { env: { PATH: '/usr/bin:/bin' } }).toString().match(/Recovery Phrase: (.+)/)[1].trim();
    fs.writeFileSync(path.join(root, 'cred/recovery-phrase'), phrase, { mode: 0o600 });
    const adminPw = sha(generatePrivateKey()).slice(0, 40);
    fs.writeFileSync(path.join(root, 'cred/admin-password'), adminPw, { mode: 0o600 });
    const cfg = { format: 'enclave-storage-indexer-host/v1', host: { endpoint }, platformHostPolicy: w.config, platformHostPolicyRpcs: w.rpcs, replica,
      package: { dir: pkgDir, manifest: pin }, pgBin: path.join(PG, 'usr/bin'), pgLibDir: path.join(PG, 'usr/lib'), stateRoot: path.join(root, 'state'),
      runtimeDir: path.join(root, 'run'), credentialsDir: path.join(root, 'cred'), descriptorFile: path.join(root, 'descriptor.json'),
      adminAddress: `127.0.0.1:${adminPort}`, appAddress: `127.0.0.1:${appPort}`, advertiseURL, memoryMiB: { indexd: 1024, postgres: 512 },
      syncer: { address: `127.0.0.1:${syncPort}`, bootstrap: false } };
    const file = path.join(root, 'host.json'); fs.writeFileSync(file, JSON.stringify(cfg));
    return { file, cfg, adminPw, root };
  };
  const env = { PATH: '/usr/bin:/bin', HOME: tmp, NODE_EXTRA_CA_CERTS: w.ca };
  const cli = (args) => new Promise((ok) => {
    const c = spawn(process.execPath, [ROLE, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => ok({ code, out }));
  });
  // the CLI prints the gate's own log lines, then the JSON verdict
  // a refusal is asserted by its DECISIVE reason: a transient policy read (fail closed, "policy unreadable") is retried
  const refusedFor = async (file, re) => until(async () => { const x = await check(file); return x.code === 1 && re.test(x.reason) ? x : null; }, 60000, 1000);
  const check = async (file) => { const r = await cli(['check', file]); const i = r.out.search(/^\{/m);
    try { return { code: r.code, ...JSON.parse(r.out.slice(i)) }; } catch { return { code: r.code, reason: r.out.trim() }; } };

  // ---- refusals (nothing starts)
  const r1 = await replicaCfg('r1');
  const bad = await replicaCfg('rbad', { signer: stranger });
  let c = await refusedFor(bad.file, /is not this host's registry operator/);
  assert.ok(c, 'a descriptor signed by another key than the registry operator is refused');
  const other = await replicaCfg('rother', { forHost: idOf('https://api.enclave.host/t/nucbox-k11-4') });   // a real sibling host's id
  c = await refusedFor(other.file, /descriptor names host 0x[0-9a-f]+, not this host/); assert.ok(c, 'a descriptor for another host is refused');
  const wrongPkg = await replicaCfg('rpkg', { packagePin: 'sha256:' + '00'.repeat(32) });
  c = await refusedFor(wrongPkg.file, /descriptor names package/); assert.ok(c, 'a descriptor for another package is refused');
  await w.publish({ deny: [{ kind: 'registryId', value: hostId, reason: 'abuse' }] });            // the admin BANS the host
  c = await until(async () => { const x = await check(r1.file); return /banned/.test(x.reason) ? x : null; }, 30000);
  assert.ok(c, 'the ban is enforced'); assert.equal(c.code, 1); assert.match(c.reason, /banned by platform policy #\d+ \(registryId\): abuse/);
  const initBanned = await until(async () => { const x = await cli(['init', r1.file]); return /refusing init: .*banned/.test(x.out) ? x : null; }, 60000, 1000);
  assert.ok(initBanned && initBanned.code === 1, 'a banned host cannot even initialise a replica');
  assert.ok(!fs.existsSync(path.join(r1.cfg.stateRoot, 'r1/postgres/PG_VERSION')), 'a refused init creates nothing');
  await w.publish({ deny: [] });                                                                     // the admin unbans
  w.state.hosts[hostId].active = false;                                                              // ... but the registry entry is inactive
  c = await until(async () => { const x = await check(r1.file); return /not active/.test(x.reason) ? x : null; }, 30000);
  assert.ok(c, 'an inactive registry entry refuses');
  w.state.hosts[hostId].active = true;
  const offCfg = { ...r1.cfg, platformHostPolicy: 'off' }; delete offCfg.platformHostPolicyRpcs;
  fs.writeFileSync(path.join(tmp, 'off.json'), JSON.stringify(offCfg));
  c = await refusedFor(path.join(tmp, 'off.json'), /policy is off: the storage-indexer role runs only under the platform host policy/); assert.ok(c, 'no silent ungated mode');
  const seen = [];
  c = await until(async () => { const x = await check(r1.file); seen.push(x); return x.admit ? x : null; }, 60000);
  assert.ok(c?.admit, `admitted: active, not banned, descriptor signed by the registry operator; last checks: ${JSON.stringify(seen.slice(-3))}`); assert.equal(c.operator, operator.address.toLowerCase());

  // ---- init with real PostgreSQL 18
  // init refuses unless admitted NOW (a fresh process has no grace): retried as an operator would
  const init = await until(async () => { const x = await cli(['init', r1.file]); return x.code === 0 ? x : null; }, 60000, 2000);
  assert.ok(init, 'init on the admitted host');
  assert.equal(fs.readFileSync(path.join(r1.cfg.stateRoot, 'r1/postgres/PG_VERSION'), 'utf8').trim(), '18');
  assert.ok(fs.existsSync(path.join(r1.cfg.stateRoot, 'r1/state/GeoLite2-City.mmdb')), 'the pinned GeoIP database is placed (indexd never downloads it)');

  // ---- run under the supervisor
  const psql = (cfg, sqlText) => execFileSync(path.join(PG, 'usr/bin/psql'), ['-h', path.join(cfg.runtimeDir, cfg.replica, 'pg'), '-d', 'indexd', '-Atc', sqlText],
    { env: { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: path.join(PG, 'usr/lib') } }).toString().trim();
  // null when indexd is not serving (connection refused included)
  const adminState = async (r) => { try { const res = await fetch(`http://${r.cfg.adminAddress}/api/state`, { headers: { authorization: 'Basic ' + Buffer.from(':' + r.adminPw).toString('base64') } }); return res.ok ? await res.json() : null; } catch { return null; } };
  const startRun = (r) => { const c2 = spawn(process.execPath, [ROLE, 'run', r.file], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
    c2.stdout.on('data', (d) => { out += d; }); c2.stderr.on('data', (d) => { out += d; }); t.after(() => { try { c2.kill('SIGKILL'); } catch {} }); return { child: c2, log: () => out }; };
  const sup = startRun(r1);
  const st1 = await until(() => adminState(r1), 120000);
  assert.ok(st1, `indexd serves its admin API under the supervisor:\n${sup.log().slice(-2000)}`);
  const phrase1 = fs.readFileSync(path.join(r1.root, 'cred/recovery-phrase'), 'utf8').trim();
  assert.ok(!sup.log().includes(phrase1) && !sup.log().includes(r1.adminPw) && !/Recovery Phrase/i.test(sup.log()), 'no secret in the supervisor log');
  const v1 = psql(r1.cfg, 'SELECT db_version FROM global_settings');
  const tables1 = psql(r1.cfg, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'");
  t.diagnostic(`db_version ${v1}, ${tables1} public tables`);
  assert.ok(Number(v1) === 28 && Number(tables1) > 10, `indexd migrated its schema in PostgreSQL 18 to exactly 28 (db_version ${v1}, ${tables1} tables)`);
  assert.equal(fs.statSync(path.join(r1.cfg.runtimeDir, 'r1/indexd/indexd.yml')).mode & 0o777, 0o600, 'the rendered config is private');
  assert.equal(psql(r1.cfg, 'SHOW listen_addresses'), '', 'PostgreSQL listens on no TCP address');

  // ---- encrypted backup of the live replica
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-384', '-nodes', '-keyout', path.join(tmp, 'owner.key'), '-out', path.join(tmp, 'owner.pem'),
    '-subj', '/CN=owner-backup', '-days', '2'], { stdio: 'pipe' });
  const bk = await cli(['backup', r1.file, path.join(tmp, 'r1.cms'), path.join(tmp, 'owner.pem')]);
  assert.equal(bk.code, 0, bk.out);
  assert.match(execFileSync('openssl', ['cms', '-cmsout', '-inform', 'DER', '-in', path.join(tmp, 'r1.cms'), '-print']).toString(), /authEnvelopedData/);

  // ---- the admin BANS the host: both processes stop, data kept; the unban restarts them on the same data
  const pidBefore = st1 && Number(execFileSync('bash', ['-c', `pgrep -f "^${pkgDir}/bin/indexd" | head -1`]).toString().trim());
  await w.publish({ deny: [{ kind: 'operator', value: operator.address.toLowerCase(), reason: 'abuse' }] });
  assert.ok(await until(async () => !(await adminState(r1)) && !fs.existsSync(path.join(r1.cfg.runtimeDir, 'r1/pg/.s.PGSQL.5432')) && /NOT running replica r1: platform host policy: banned/.test(sup.log()), 90000),
    `a ban stops indexd AND PostgreSQL:\n${sup.log().slice(-1500)}`);
  assert.ok(fs.existsSync(path.join(r1.cfg.stateRoot, 'r1/postgres/PG_VERSION')), 'the replica data is kept');
  await w.publish({ deny: [] });
  assert.ok(await until(() => adminState(r1), 120000), `the unban restarts the replica:\n${sup.log().slice(-3000)}`);
  assert.equal(psql(r1.cfg, 'SELECT db_version FROM global_settings'), v1, 'same database after the restart');

  // ---- an indexd crash restarts under backoff
  const pid = Number(execFileSync('bash', ['-c', `pgrep -f "^${pkgDir}/bin/indexd" | head -1`]).toString().trim());
  assert.ok(pid > 0 && pid !== pidBefore, 'a new indexd process after the unban');
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(async () => /indexd exited \(SIGKILL\)/.test(sup.log()) && /indexd restarting in \d+ ms/.test(sup.log()) && (await adminState(r1)), 120000), `the supervisor restarts a crashed indexd:\n${sup.log().slice(-2000)}`);

  // ---- restore drill (a): the backup restored under a NEW wallet phrase is REFUSED by indexd itself (a restored database is
  //      that replica's identity; two indexers must never act for the same contracts), and the supervisor backs off
  const r2 = await replicaCfg('r2');
  assert.ok(await until(async () => (await cli(['init', r2.file])).code === 0 || null, 60000, 2000), 'init r2');
  const rs = await cli(['restore', r2.file, path.join(tmp, 'r1.cms'), path.join(tmp, 'owner.key'), path.join(tmp, 'owner.pem')]);
  assert.equal(rs.code, 0, rs.out);
  const sup2 = startRun(r2);
  assert.ok(await until(async () => /wallet seed change detected/.test(sup2.log()), 120000), `indexd refuses another wallet's restored database:\n${sup2.log().slice(-1500)}`);
  await wait(20000);
  // restarts follow the exponential backoff (1 s doubling): every gap >= ~1 s and the gaps grow
  const starts = [...sup2.log().matchAll(/^(\S+) \[storage-indexer\] indexd started/gm)].map((m) => Date.parse(m[1]));
  const gaps = starts.slice(1).map((x, i) => x - starts[i]);
  assert.ok(gaps.length >= 2 && gaps.every((g) => g >= 900) && gaps[gaps.length - 1] >= 3500, `restarts follow the backoff, gaps ms ${JSON.stringify(gaps)}`);
  assert.equal(await adminState(r2), null, 'nothing served from a mismatched identity');
  sup2.child.kill('SIGTERM'); await new Promise((r) => sup2.child.once('exit', r));
  // ---- restore drill (b): r1's HOST is lost; r1 is restored on a new host directory with r1's OWN offline phrase -> serves
  sup.child.kill('SIGTERM'); await new Promise((r) => sup.child.once('exit', r));
  const r1b = await replicaCfg('r1b');
  fs.copyFileSync(path.join(r1.root, 'cred/recovery-phrase'), path.join(r1b.root, 'cred/recovery-phrase'));
  assert.ok(await until(async () => (await cli(['init', r1b.file])).code === 0 || null, 60000, 2000), 'init r1b');
  const rb = await cli(['restore', r1b.file, path.join(tmp, 'r1.cms'), path.join(tmp, 'owner.key'), path.join(tmp, 'owner.pem')]);
  assert.equal(rb.code, 0, rb.out);
  const sup3 = startRun(r1b);
  assert.ok(await until(() => adminState(r1b), 120000), `the restored replica serves with its own phrase:\n${sup3.log().slice(-1500)}`);
  assert.equal(psql(r1b.cfg, 'SELECT db_version FROM global_settings'), v1);
  assert.equal(psql(r1b.cfg, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"), tables1);
  // a tampered backup never reaches pg_restore
  const tampered = fs.readFileSync(path.join(tmp, 'r1.cms')); tampered[tampered.length >> 1] ^= 1;
  fs.writeFileSync(path.join(tmp, 't.cms'), tampered); fs.writeFileSync(path.join(tmp, 't.cms.sha256'), sha(tampered) + '  t.cms\n');
  const r3 = await replicaCfg('r3'); assert.ok(await until(async () => (await cli(['init', r3.file])).code === 0 || null, 60000, 2000), 'init r3');
  const rt = await cli(['restore', r3.file, path.join(tmp, 't.cms'), path.join(tmp, 'owner.key'), path.join(tmp, 'owner.pem')]);
  assert.equal(rt.code, 1, 'a tampered backup is refused (GCM)');

  sup3.child.kill('SIGTERM'); await new Promise((r) => sup3.child.once('exit', r));
  assert.ok(!fs.existsSync(path.join(r1b.cfg.runtimeDir, 'r1b/pg/.s.PGSQL.5432')) && !fs.existsSync(path.join(r1.cfg.runtimeDir, 'r1/pg/.s.PGSQL.5432')), 'a supervisor stop shuts PostgreSQL down cleanly');
});
