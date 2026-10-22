// NATIVE G3 HARNESS (work/host-service-tls-20261021/native). Bundled to g3-native.bundle.mjs; root runs it on the Windows
// hs2 host. It is NOT run by Claude there. It proves, with the REAL service-tls code (compose/, patch ebad1796), the parts
// the Linux suite cannot:
//   verifier   Node's in-memory TLS verifier (stream.duplexPair) on this Node: a fixture chain is accepted with its fixture
//              root; refused with the default trust store; a non-CA intermediate is refused by the verifier
//   store      the one-document atomic replace (rename over an existing file) on NTFS; account save/forget; no temp left
//   keydir     (Windows) the role's Get-Acl preflight on a directory that inherits <base>'s ACL, and a refusal after
//              granting Users read on a SEPARATE scratch directory (icacls on the harness's own directory only)
//   fronts     startServiceTls on 127.0.0.1 EPHEMERAL ports with a stored fixture certificate and a stub admit:
//              - SNI-exact TLS to an in-harness upstream, wrong/no SNI refused;
//              - port-80 passthrough, unknown Host 421, challenge path 404;
//              - an admin refusal closes every listener.
// No CA, network, hs2 role, fixed port, service or production file is touched. Everything lives in <base>\g3-native-<id>,
// which is removed at the end; a failed removal FAILS the run. Every network call is denied (fetch stub, counted).
//   node g3-native.bundle.mjs <absolute base dir>   -> <base>\g3-native-receipt-<UTC>.json, exit 0 = all PASS and cleaned
// Run it as the hs2 account (LOCAL SERVICE) to prove the preflight as that identity (see PLAN.txt); as Administrator it
// proves the ACL and the code paths.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { verifyCertificate, createKeyStore, checkKeyDir, startServiceTls } from '../compose/network/host-services/service-tls.mjs';
import FIX from './fixtures/fixtures.json' with { type: 'json' };

const [base, ...extra] = process.argv.slice(2);
if (!base || !path.isAbsolute(base) || extra.length) { console.error('usage: g3-native.bundle.mjs <absolute base dir>'); process.exit(2); }
const win = process.platform === 'win32';
const work = path.join(base, `g3-native-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(work, { recursive: false });
const out = { at: new Date().toISOString(), node: process.version, platform: process.platform, user: os.userInfo().username, base, work, fixtureNotAfter: FIX.notAfter, checks: {} };
const check = async (name, fn, { windowsOnly = false } = {}) => {
  if (windowsOnly && !win) { out.checks[name] = { skipped: 'not Windows' }; return; }
  try { out.checks[name] = { pass: true, ...((await fn()) || {}) }; } catch (e) { out.checks[name] = { pass: false, error: String(e?.message || e).slice(0, 300) }; }
};
const refuses = async (p, re) => { try { await p; } catch (e) { if (re.test(e.message)) return e.message.slice(0, 160); throw new Error(`refused for the wrong reason: ${e.message}`); } throw new Error('was ACCEPTED'); };
const names = FIX.names, roots = [FIX.root];
// no CA or network request may leave this harness: every fetch is refused and counted (asserted 0 at the end)
let fetchCalls = 0;
const denyFetch = async (u) => { fetchCalls++; throw new Error(`network denied in the native harness (${String(u).slice(0, 60)})`); };
// the raw HTTP requests below must carry real CR LF bytes (a doubled escape would send literal backslashes)
const CRLF = '\r\n';
if (Buffer.from(CRLF).toString('hex') !== '0d0a') { console.error('harness self-check: CRLF is not 0d0a'); process.exit(2); }

await check('verifier', async () => {
  const info = await verifyCertificate({ names, ...FIX.good, roots });
  return { accepted: info.fingerprint.slice(0, 20), defaultRoots: await refuses(verifyCertificate({ names, ...FIX.good }), /TLS verifier/),
    nonCaIntermediate: await refuses(verifyCertificate({ names, ...FIX.nonCa, roots }), /TLS verifier/) };
});

await check('store', async () => {
  const dir = path.join(work, 'store'); fs.mkdirSync(dir);
  const s = createKeyStore(dir);
  s.writeDoc(FIX.good.keyPem, FIX.good.chainPem); s.writeDoc(FIX.nonCa.keyPem, FIX.nonCa.chainPem); s.writeDoc(FIX.good.keyPem, FIX.good.chainPem);
  const d = createKeyStore(dir).readDoc();
  if (d.chainPem.trim() !== FIX.good.chainPem.trim() || d.keyPem.trim() !== FIX.good.keyPem.trim()) throw new Error('read back a different pair');
  s.account.save({ directory: 'x', kid: 'y', keyPem: 'z' }); if (s.account.load()?.kid !== 'y') throw new Error('account load');
  s.account.forget(); if (s.account.load() !== null) throw new Error('account forget');
  const left = fs.readdirSync(dir); if (left.join() !== 'current.pem') throw new Error(`left behind: ${left.join()}`);
  return { files: left };
});

await check('keydir-preflight', async () => checkKeyDir(path.join(work, 'keys')), { windowsOnly: true });

await check('keydir-refuses-users', async () => {
  const dir = path.join(work, 'keys-users'); fs.mkdirSync(dir);
  const root = process.env.SystemRoot || 'C:\\Windows';
  const r = spawnSync(path.join(root, 'System32', 'icacls.exe'), [dir, '/grant', '*S-1-5-32-545:(R)'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls failed (${r.status})`);
  return { refused: await refuses(checkKeyDir(dir), /grants access to S-1-5-32-545/) };
}, { windowsOnly: true });

await check('fronts', async () => {
  const got = [];
  const up = net.createServer((s) => { s.on('data', (d) => { got.push(String(d)); s.write('UPSTREAM ' + d.length + '\n'); }); s.on('error', () => {}); });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  const hostId = '0x' + '11'.repeat(32), stateDir = path.join(work, 'role');
  fs.mkdirSync(path.join(stateDir, 'keys'), { recursive: true, mode: 0o700 });
  createKeyStore(path.join(stateDir, 'keys')).writeDoc(FIX.good.keyPem, FIX.good.chainPem);
  let decision = { admit: true, status: 'admitted' };
  const logs = [];
  const c = { hostId, zone: 'native-test.invalid', httpPort: 0, tlsPorts: { 'directory-replica': 0, 'bootstrap-replica': 0 }, ca: 'letsencrypt',
    host: { endpoint: 'https://native.invalid', hostId }, upstreams: { 'directory-replica': up.address().port, 'bootstrap-replica': up.address().port }, stateDir,
    policy: { platformHostPolicy: 'production' } };
  const role = await startServiceTls(c, { admit: async () => decision, roots, loop: false, log: (m) => logs.push(m), fetch: denyFetch, directoryUrl: 'https://acme.invalid/directory' });
  try {
    const st = role.status();
    if (!st.certificate || !st.listening.http || !st.listening.tls['directory-replica']) throw new Error(`not serving: ${JSON.stringify(st.listening)} ${logs.join(' | ').slice(0, 200)}`);
    const talk = (port, servername) => new Promise((ok, no) => {
      const s = tls.connect({ port, host: '127.0.0.1', ...(servername ? { servername } : {}), ca: roots, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }, () => {
        s.write('ping'); s.once('data', (d) => { s.end(); ok({ reply: String(d).trim(), alpn: s.alpnProtocol, protocol: s.getProtocol() }); });
      });
      s.on('error', no); setTimeout(() => { s.destroy(); no(new Error('timeout')); }, 5000);
    });
    const raw = (text) => new Promise((ok) => { if (!Buffer.from(text).includes(Buffer.from([13, 10, 13, 10]))) throw new Error('request head lacks CR LF CR LF bytes'); const s = net.connect(role.ports.http, '127.0.0.1', () => s.write(text)); let o = ''; s.on('data', (d) => { o += d; }); s.on('error', () => ok(o)); s.on('close', () => ok(o)); setTimeout(() => { s.destroy(); ok(o); }, 1000); });
    // a renewal round with a fresh certificate must not order (and the stub proves nothing reached a network)
    await role.tick();
    if (role.status().orders !== 0 || fetchCalls !== 0) throw new Error(`an order/fetch was attempted (orders ${role.status().orders}, fetch ${fetchCalls})`);
    const tlsOk = await talk(role.ports.tls['directory-replica'], names[0]);
    if (tlsOk.reply !== 'UPSTREAM 4') throw new Error(`tls pipe reply ${tlsOk.reply}`);
    const wrongSni = await refuses(talk(role.ports.tls['directory-replica'], names[1]), /./);
    const noSni = await refuses(talk(role.ports.tls['directory-replica'], null), /./);
    const pass = await raw(`GET /x HTTP/1.1\r\nHost: ${names[0]}\r\n\r\n`);
    const r421 = (await raw('GET / HTTP/1.1\r\nHost: evil.invalid\r\n\r\n')).split('\r\n')[0];
    const r404 = (await raw(`GET /.well-known/acme-challenge/abcdefghijklmnopqrstuv HTTP/1.1\r\nHost: ${names[0]}\r\n\r\n`)).split('\r\n')[0];
    if (!/^UPSTREAM/.test(pass) || r421 !== 'HTTP/1.1 421 Misdirected Request' || r404 !== 'HTTP/1.1 404 Not Found') throw new Error(`http front: ${pass.slice(0, 40)} / ${r421} / ${r404}`);
    decision = { admit: false, status: 'banned', reason: 'native test refusal' };
    await role.checkPolicy();
    const closed = role.status().listening;
    if (closed.http || closed.tls['directory-replica'] || closed.tls['bootstrap-replica']) throw new Error(`still listening after refusal: ${JSON.stringify(closed)}`);
    const afterRefusal = await refuses(talk(role.ports.tls['directory-replica'] || 1, names[0]), /./);
    return { orders: role.status().orders, fetchCalls, tls: tlsOk, wrongSni, noSni, http421: r421, challenge404: r404, refusalClosedAll: true, afterRefusal, keyDir: st.keyDir, logLines: logs.length };
  } finally { await role.stop(); up.close(); }
});

try { fs.rmSync(work, { recursive: true, force: true }); out.cleaned = !fs.existsSync(work); } catch (e) { out.cleaned = false; out.cleanupError = String(e.message).slice(0, 200); }
out.fetchCalls = fetchCalls;
const ran = Object.values(out.checks).filter((x) => !x.skipped);
// PASS only if every check that ran passed, the scratch directory is gone, and nothing tried the network
out.pass = ran.length > 0 && ran.every((x) => x.pass) && out.cleaned === true && fetchCalls === 0;
const receipt = path.join(base, `g3-native-receipt-${out.at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
fs.writeFileSync(receipt, JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
