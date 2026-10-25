// Test-only: the REAL local verifier runtime (network/rpc-runtime.mjs through test/fixtures/rpc-runtime-launcher.mjs, as
// test/rpc-runtime.e2e.test.mjs launches it) in front of a local reth --dev chain: the pinned Helios and witness helper
// from $RUNTIME_BIN_DIR, the listener's `listen` replaced by the reth stand-in (its commitment step is the real pinned
// listener), heads signed by a TEST sequencer key, proofs from the given UNTRUSTED sources.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG_FORMAT } from '../../network/rpc-runtime.mjs';
import { procIdentity, signalOwned } from '../../network/gossip-head-source.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname), FIX = path.join(HERE, '..', 'fixtures');
const STANDIN = path.join(FIX, 'reth-gossip-listener.mjs'), LAUNCHER = path.join(FIX, 'rpc-runtime-launcher.mjs');
export const SEQ_KEY = '0x' + '5e'.repeat(32);
export const seqSigner = privateKeyToAccount(SEQ_KEY).address;
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** an UNTRUSTED proof source in front of the chain: st.mode ok | down */
export function startProofSource(chainRpc) {
  const st = { mode: 'ok', hits: 0 };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    st.hits++;
    if (st.mode === 'down') { res.writeHead(503); return res.end(); }
    try { res.end(JSON.stringify(await (await fetch(chainRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json())); }
    catch { res.writeHead(502); res.end(); }
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}

/** -> {child, url, stateDir, out(), setControl(c), ready(ms), stop(), owned()} */
export function launchVerifierRuntime({ chainRpc, proofSources, port, dir, binDir = process.env.RUNTIME_BIN_DIR }) {
  const bin = (n) => path.join(binDir, n);
  const stateDir = path.join(dir, 'state'), controlFile = path.join(dir, 'control.json');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(controlFile, '{}');
  const config = { format: CONFIG_FORMAT, chain: { chainId: 8453, unsafeSigner: seqSigner },
    binaries: { listener: { path: STANDIN, sha256: sha(STANDIN) }, helios: { path: bin('helios-eeffcc9'), sha256: sha(bin('helios-eeffcc9')) },
      witnessCheck: { path: bin('witness-check'), sha256: sha(bin('witness-check')) } },
    proofSources: { untrusted: proofSources }, verifier: { port }, stateDir, gossip: { discovery: 'off', sessionSecs: 3600 },
    hostTools: { flock: '/usr/bin/flock' } };
  const cfgFile = path.join(dir, 'rpc-runtime.json'); fs.writeFileSync(cfgFile, JSON.stringify(config, null, 1));
  const child = spawn(process.execPath, [LAUNCHER, cfgFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LAUNCH_LISTENER_SHA256: sha(STANDIN),
      LAUNCH_LISTENER_ENV: JSON.stringify({ REAL_LISTENER: bin('enclave-base-head-listener'), FIXTURES_DIR: FIX, RIG_RPC: chainRpc, FEED_CONTROL: controlFile }) } });
  let out = ''; child.stdout.on('data', (d) => { out = (out + d).slice(-40000); }); child.stderr.on('data', (d) => { out = (out + d).slice(-40000); });
  const ready = async (ms = 300000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fs.existsSync(path.join(stateDir, 'ready.json'))) { remember(); return; } if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 250)); }
    throw new Error('the verifier runtime did not become ready:\n' + out.slice(-2000));
  };
  // The runtime starts Helios and the listener DETACHED (their own process groups) and records each one's identity (pid,
  // pgid, start time) in ITS stateDir's children.json; it stops them itself on SIGTERM and then removes that record. So a
  // stop is: remember the recorded identities, SIGTERM the runtime, await its exit (bounded); only if it does not exit,
  // SIGKILL its own group; then whatever of the REMEMBERED identities still runs (pid, pgid and start time re-checked in
  // /proc, so a reused pid is never touched) is SIGKILLed by its group. Nothing else is ever signalled.
  const seen = new Map();
  const remember = () => {
    let ids = []; try { ids = JSON.parse(fs.readFileSync(path.join(stateDir, 'children.json'), 'utf8')); } catch {}
    for (const id of Array.isArray(ids) ? ids : []) if (Number.isSafeInteger(id?.pid) && Number.isSafeInteger(id?.pgid) && typeof id?.startTime === 'string') seen.set(`${id.pid}:${id.startTime}`, id);
  };
  const isLive = (id) => { const now = procIdentity(id.pid); return !!now && now.startTime === id.startTime && now.pgid === id.pgid; };
  const owned = () => { remember(); return [...seen.values()]; };
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise((r) => { if (exited()) r(); else child.once('exit', () => r()); });
  let stopping = null;
  const stop = ({ graceMs = 20_000 } = {}) => (stopping ||= (async () => {
    remember();
    const report = { runtimeExit: null, escalated: false, killedChildren: [], leftover: [] };
    if (!exited()) {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      if (!(await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), graceMs))]))) {
        report.escalated = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await Promise.race([exit, new Promise((r) => setTimeout(r, 5_000))]);
      }
    }
    report.runtimeExit = { code: child.exitCode, signal: child.signalCode };
    for (const id of [...seen.values()].filter(isLive)) report.killedChildren.push(...(await signalOwned(id, 'SIGKILL')));
    for (let i = 0; i < 100 && [...seen.values()].some(isLive); i++) await new Promise((r) => setTimeout(r, 100));
    report.leftover = [...seen.values()].filter(isLive).map((id) => id.pid);
    return report;
  })());
  return { child, url: `http://127.0.0.1:${port}/`, stateDir, out: () => out, setControl: (c) => fs.writeFileSync(controlFile, JSON.stringify(c)), ready, stop, owned };
}
