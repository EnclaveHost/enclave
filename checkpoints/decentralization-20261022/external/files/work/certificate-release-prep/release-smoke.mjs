#!/usr/bin/env node
// Import/start smoke of the DELIVERED challenge-replica release (not a fresh test build), run the way a host runs it: the
// release directory is copied into a dependency-free directory (no node_modules on any ancestor, NODE_PATH empty) and its
// own launcher (challenge-host.mjs) is executed as a separate process:
//   check  - judges the configuration and verifies the pinned dns.mjs + runtime bundle;
//   run    - starts the replica (TRUSTED judge) and its HTTPS front; the Windows host's real session keeper attests a
//            (SYNTHETIC) TPM boot; a Shield guest push through the front is answered in DNS; launcher-only evidence is refused;
//   SIGTERM - stops cleanly (exit 0), nothing left listening.
// Run inside an unshared network namespace (loopback only). SYNTHETIC TPM/VBS/chain: not hardware, not a public CA.
//   node release-smoke.mjs <tree> <release dir> <dns.mjs sha256> <runtime bundle sha256> <challenge-host.mjs sha256>
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import https from 'node:https';
import dgram from 'node:dgram';
import {once} from 'node:events';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [tree, dir, dnsSha, bundleSha, hostSha] = process.argv.slice(2);
const fail = (why) => { console.error('SMOKE FAIL: ' + why); throw new Error(why); };
const must = (ok, why) => { if (!ok) fail(why); };
must(tree && dir && [dnsSha, bundleSha, hostSha].every((h) => /^[0-9a-f]{64}$/.test(h || '')), 'usage: release-smoke.mjs <tree> <release dir> <dns sha> <bundle sha> <host sha>');
const imp = (p) => import(pathToFileURL(path.join(tree, p)).href);
const {appZoneShieldParty} = await imp('network/app-zone-shield.mjs');
const {startShieldChain} = await imp('test/challenge-replica-chain.mjs');
const F = await imp('test/app-zone-fixture.mjs'), S = await imp('test/app-zone-shield-fixture.mjs');
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// the dependency-free copy
const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-free-'));
for (let d = clean; d !== path.dirname(d); d = path.dirname(d)) must(!fs.existsSync(path.join(d, 'node_modules')), `node_modules above the clean directory: ${d}`);
const rel = path.join(clean, 'release'); fs.mkdirSync(rel);
for (const f of ['dns.mjs', 'network-runtime.bundle.mjs', 'dns.mjs.manifest.json', 'challenge-host.mjs']) { fs.copyFileSync(path.join(dir, f), path.join(rel, f)); fs.chmodSync(path.join(rel, f), 0o444); }
must(sha(path.join(rel, 'dns.mjs')) === dnsSha && sha(path.join(rel, 'network-runtime.bundle.mjs')) === bundleSha && sha(path.join(rel, 'challenge-host.mjs')) === hostSha,
  'the copied release is not the pinned bytes');
const env = {PATH: process.env.PATH, HOME: clean, TMPDIR: process.env.TMPDIR};   // no NODE_PATH, no inherited configuration

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function udpFree() { for (;;) { const p = await freePort(); const u = dgram.createSocket('udp4'); const ok = await new Promise((r) => { u.once('error', () => r(false)); u.bind(p, '127.0.0.1', () => r(true)); }); u.close(); if (ok) return p; } }
async function ask(port, name) {
  const h = Buffer.alloc(12); h.writeUInt16BE(0x4242, 0); h.writeUInt16BE(1, 4);
  const q = Buffer.concat([h, ...name.split('.').map((v) => Buffer.concat([Buffer.from([v.length]), Buffer.from(v)])), Buffer.from([0, 0, 16, 0, 1])]);
  const s = dgram.createSocket('udp4');
  try { const got = once(s, 'message'); s.send(q, port, '127.0.0.1');
    return (await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error('UDP timeout')), 3000))]))[0]; } finally { s.close(); }
}
const post = (ca, port, p) => new Promise((ok, no) => {
  const r = https.request({host: '127.0.0.1', port, path: '/v1/app-challenge', method: 'POST', ca, headers: {'content-type': 'application/json', 'x-attested-sig': p.sig}}, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let b = null; try { b = JSON.parse(Buffer.concat(c).toString()); } catch {} ok({status: res.statusCode, body: b}); }); });
  r.on('error', no); r.end(p.body);
});
const listening = (port) => new Promise((ok) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); });

const chain = await startShieldChain();
let child = null;
try {
  const dns = await udpFree(), api = await freePort(), front = await freePort();
  const cfgFile = path.join(clean, 'challenge.json');
  fs.writeFileSync(cfgFile, JSON.stringify({challengeReplica: {role: 'app-zone-replica', release: {dir: rel, dnsSha256: dnsSha, runtimeBundleSha256: bundleSha},
    zones: {app: F.ZONE, ip: 'ip.enclave.host'}, ns: {name: 'ns-smoke.enclave.host'}, listen: {dns: `127.0.0.1:${dns}`, api: `127.0.0.1:${api}`},
    front: {listen: `127.0.0.1:${front}`, certFile: chain.front.certFile, keyFile: chain.front.keyFile, origin: 'https://challenge-smoke.example.org'},
    routeMap: chain.routeMapUrl, chain: {rpcs: chain.rpcUrls, pins: chain.pins},
    shield: {policyFile: chain.policyFile, profileFile: chain.profileFile, profileDigest: chain.digest, rpcs: chain.rpcUrls},
    hostPolicy: {policy: 'off'}}}, null, 1));
  const launcher = path.join(rel, 'challenge-host.mjs');
  const check = JSON.parse(execFileSync(process.execPath, [launcher, 'check', cfgFile], {cwd: clean, env, encoding: 'utf8'}));
  must(check.ok === true && check.release.dnsSha256 === dnsSha && check.release.runtimeBundleSha256 === bundleSha, 'check did not verify the pinned release');
  must(/OFF/.test(String(check.platformHostPolicy)), 'check does not state the explicit policy-off of this fixture');
  console.log('check OK: pinned release verified by the delivered launcher');
  let log = '';
  child = spawn(process.execPath, [launcher, 'run', cfgFile, '--extra-ca-file', chain.caFile], {cwd: clean, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 400 && !/challenge host running/.test(log); i++) { if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
  must(/challenge host running/.test(log), 'the launcher did not report running: ' + log.slice(-1500));
  console.log(`run OK: launcher pid ${child.pid} started the delivered release`);
  const keeper = chain.keeper(chain.world, S.ENDPOINT, {'challenge-smoke.example.org': `http://127.0.0.1:${api}`});
  const s = await keeper.refresh([{url: 'https://challenge-smoke.example.org', party: appZoneShieldParty(F.ZONE), path: '/v1/app-zone/shield-session'}]);
  must(s.failed.length === 0 && s.done.length === 1, 'host session: ' + JSON.stringify(s));
  const health = await fetch(`http://127.0.0.1:${api}/health`).then((r) => r.json());
  must(health.appChallenge?.judgeMode === 'trusted' && health.appChallenge?.shield?.hostExcluded === false, 'not the trusted judge / Shield tier: ' + JSON.stringify(health.appChallenge));
  const ca = fs.readFileSync(chain.caFile);
  const p = S.shieldPush(F.guestKey(), {signer: chain.world.idks.privateKey});
  const r = await post(ca, front, p);
  must(r.status === 200, 'Shield push not accepted: ' + JSON.stringify(r.body));
  const m = await ask(dns, p.name);
  must(m.readUInt16BE(6) === 1 && m.includes(Buffer.from(p.value)), 'the accepted value is not answered in DNS');
  const bad = await post(ca, front, S.shieldPush(F.guestKey(), {signer: chain.world.idks.privateKey, doc: {launcherOnly: true}}));
  must(bad.status === 403 && /VBS report missing/.test(bad.body?.message || ''), 'launcher-only evidence was not refused: ' + JSON.stringify(bad));
  child.kill('SIGTERM');
  const [code] = await Promise.race([once(child, 'exit'), new Promise((_, no) => setTimeout(() => no(new Error('no exit after SIGTERM')), 20_000))]);
  must(code === 0 && /challenge host stopped/.test(log), `SIGTERM did not stop cleanly (exit ${code})`);
  child = null;
  must(!(await listening(front)) && !(await listening(api)), 'something is still listening after the stop');
  console.log('SMOKE OK: the delivered launcher (dependency-free copy) checked and ran the pinned release; host session; Shield push answered in DNS; launcher-only refused; SIGTERM clean');
} finally {
  if (child) child.kill('SIGKILL');
  await chain.close();
  fs.rmSync(clean, {recursive: true, force: true});
}
