// Per-partition native worker admission for the operator-trusted T0-hv path.
// This owns stream permission, not masks, plaintext, physical GPU capacity or
// ledger authorization. The manager must already hold the verified allocation.
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { checkPin } from './egress.mjs';
import { BRIDGE_AUTH_FLAG, bridgeAuthLine, createBridgeGate, mintBridgeCredential } from './bridge-auth.mjs';

export const DESKTOP_WORKER_PORT = 19595;
export const DESKTOP_WORKER_SERVICE_GUID = "00004c8b-facb-11e6-bd58-64006a7986d3";
export const MAX_STREAMS = 8;
export const MAX_LINE = 512;
const HEX = /^[0-9a-f]{64}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonzero = s => typeof s === 'string' && s.length === 64 && HEX.test(s) && !/^0+$/.test(s);
function expectation(x) {
  if (!x || !nonzero(x.appID) || !nonzero(x.profileSHA) || !Number.isInteger(x.gpuMilli) || x.gpuMilli < 500 || x.gpuMilli > 1000)
    throw new Error('native worker needs a verified app/profile/allocation binding');
  return Object.freeze({ appID: x.appID, profileSHA: x.profileSHA, gpuMilli: x.gpuMilli });
}
export function parseDesktopWorkerLine(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_LINE) throw new Error('invalid native worker frame');
  const s = raw.toString('latin1');
  let m = /^native-worker-v1 claim ([0-9a-f]{32}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([5-9][0-9]{2}|1000)\n$/.exec(s);
  if (m && m[0] === s && m.slice(1, 5).every(v => !/^0+$/.test(v)))
    return { op: 'claim', boot: m[1], claim: m[2], appID: m[3], profileSHA: m[4], gpuMilli: Number(m[5]) };
  m = /^native-worker-v1 open ([0-9a-f]{64})\n$/.exec(s);
  if (m && m[0] === s && nonzero(m[1])) return { op: 'open', token: m[1] };
  throw new Error('invalid native worker frame');
}
function loopbackWorker(port, signal) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port, signal });
    c.once('connect', () => resolve(c));
    c.on('error', reject);
  });
}

// connectWorker is a trusted test/host adapter; it must honor AbortSignal.
// Only authenticated bridge connections reach this parser. The pinned bridge
// checks the kernel-supplied VmId; its per-start credential stays on stdin.
export async function serveDesktopWorker({ expect, credential, workerPort = DESKTOP_WORKER_PORT,
  connectWorker, handshakeMs = 5000, maxUnauthenticated = 16, authTimeoutMs = 2000 } = {}) {
  const want = expectation(expect);
  if (!Number.isInteger(workerPort) || workerPort < 1 || workerPort > 65535 || !Number.isInteger(handshakeMs) || handshakeMs < 1 || handshakeMs > 10000)
    throw new Error('invalid native worker transport bounds');
  if (connectWorker !== undefined && typeof connectWorker !== 'function') throw new Error('invalid worker adapter');
  const dial = connectWorker ?? (signal => loopbackWorker(workerPort, signal));
  if (!Number.isInteger(maxUnauthenticated) || maxUnauthenticated < 1 || maxUnauthenticated > 64 || !Number.isInteger(authTimeoutMs) || authTimeoutMs < 1 || authTimeoutMs > 10000) throw new Error('invalid native worker authentication bounds');
  const gate = createBridgeGate({ credential, maxUnauthenticated, authTimeoutMs });
  const conns = new Set(), streams = new Set();
  let claimed = false, terminal = false, closing = false, control = null, token = null;
  const refusals = {};
  let accepted = 0, refused = 0, closePromise, resolveClose, serverClosed = false;
  let resolveRevoked;
  const revoked = new Promise(resolve => { resolveRevoked = resolve; });
  const maybeClosed = () => { if (serverClosed && streams.size === 0) resolveClose?.(); };
  function retire() {
    if (terminal) return;
    terminal = true; token = null;
    // The launcher must observe lease loss even if the carrier process lives.
    // Never include peer bytes, the private token or the bridge credential.
    resolveRevoked({ error: 'native worker lease revoked' });
    for (const s of streams) { s.abort.abort(); s.up?.destroy(); }
    for (const c of conns) c.destroy();
  }
  function refuse(c, reason) { refused++; refusals[reason]=(refusals[reason]??0)+1; c.destroy(); }
  function open(c) {
    if (streams.size >= MAX_STREAMS) return refuse(c, 'stream-limit');
    c.pause();
    const s = { c, up: null, abort: new AbortController(), dialDone: false, clientClosed: false, upClosed: true };
    streams.add(s); // before any asynchronous dial: pending attempts consume a slot
    const finish = () => {
      if (s.dialDone && s.clientClosed && s.upClosed) { streams.delete(s); maybeClosed(); }
    };
    c.once('close', () => { s.clientClosed = true; s.abort.abort(); s.up?.destroy(); finish(); });
    const timer = setTimeout(() => { s.abort.abort(); c.destroy(); }, handshakeMs); timer.unref?.();
    Promise.resolve().then(() => dial(s.abort.signal)).then(up => {
      s.up = up; s.upClosed = up.closed === true;
      up.on('error', () => c.destroy());
      up.once('close', () => { s.upClosed = true; c.end(); finish(); });
      c.once('finish', () => c.destroy());
      if (terminal || closing || c.destroyed || s.abort.signal.aborted || up.destroyed) { c.destroy(); up.destroy(); return; }
      c.write('native-worker-v1 stream\n');
      c.pipe(up); up.pipe(c); c.resume(); accepted++;
    }, () => c.destroy()).finally(() => { clearTimeout(timer); s.dialDone = true; finish(); });
  }
  function frame(c, rest) {
    let buf = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => { if (!done) refuse(c, 'header-timeout'); }, handshakeMs); timer.unref?.();
    const cleanup = () => { done = true; clearTimeout(timer); c.off('data', data); c.off('end', ended); };
    const ended = () => { cleanup(); c.destroy(); };
    const data = b => {
      if (done) return;
      if (buf.length + b.length > MAX_LINE) { cleanup(); return refuse(c, 'oversized-header'); }
      buf = Buffer.concat([buf, b]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      cleanup();
      let req;
      try { if (nl !== buf.length - 1) throw new Error(); req = parseDesktopWorkerLine(buf); }
      catch { return refuse(c, 'malformed-header'); }
      if (terminal || closing) return refuse(c, 'terminal');
      if (req.op === 'claim') {
        if (claimed || req.appID !== want.appID || req.profileSHA !== want.profileSHA || req.gpuMilli !== want.gpuMilli) return refuse(c, 'claim-binding');
        claimed = true; control = c; token = crypto.randomBytes(32).toString('hex');
        c.on('data', retire); c.once('end', retire); c.once('close', retire);
        c.write(`native-worker-v1 lease ${token}\n`);
      } else {
        if (!control || control.destroyed || !token || !crypto.timingSafeEqual(Buffer.from(req.token), Buffer.from(token))) return refuse(c, 'stream-binding');
        open(c);
      }
    };
    c.on('data', data); c.once('end', ended); c.once('close', cleanup);
    if (rest.length) data(rest);
  }
  const server = net.createServer(c => {
    conns.add(c); c.on('error', () => {}); c.once('close', () => conns.delete(c));
    if (terminal || closing) return c.destroy();
    gate.admit(c, frame);
  });
  server.on('error', retire);
  server.maxConnections = maxUnauthenticated + MAX_STREAMS + 9;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    revoked,
    // Tokens and private bridge credentials are deliberately never exported.
    stats: () => ({ claimed, terminal, streams: streams.size, accepted, refused, refusals: { ...refusals }, gate: gate.stats() }),
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise(resolve => { resolveClose = resolve; });
      closing = true; retire();
      server.close(() => { serverClosed = true; maybeClosed(); });
      return closePromise;
    }
  };
}

// The caller supplies a derived/verified mapping and the selected image's
// RuntimeID pin. This transport cannot turn a host request into authorization.
export async function startDesktopWorkerTransport({ bridge, vmId, mapping, runtimeId, workerPort = DESKTOP_WORKER_PORT,
  spawn = nodeSpawn, readyTimeoutMs = 10000 } = {}) {
  if (!bridge?.exe || !nonzero(bridge.sha256) || typeof vmId !== 'string' || vmId.length !== 36 || !GUID.test(vmId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(vmId))
    throw new Error('native worker needs the pinned bridge and one partition id');
  const d = mapping?.record?.desktop;
  if (!nonzero(runtimeId) || mapping?.record?.runtimeId !== runtimeId || d?.profile !== 'kvm-box-masked-v1')
    throw new Error('native worker mapping differs from the selected desktop runtime');
  const expect = expectation({ appID: mapping.appId, profileSHA: d.profileSha256, gpuMilli: d.gpuMilli });
  checkPin(bridge.exe, bridge.sha256, 'the native worker bridge executable');
  const credential = mintBridgeCredential();
  const server = await serveDesktopWorker({ expect, credential, workerPort });
  let child;
  try {
    child = spawn(bridge.exe, [vmId, String(DESKTOP_WORKER_PORT), String(server.port), '0', BRIDGE_AUTH_FLAG],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); child.stdin.write(bridgeAuthLine(credential));
    const childExited = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ error: 'native worker bridge failed' }));
    });
    const exited = Promise.race([childExited, server.revoked]);
    let stopping;
    const stop = () => stopping ??= (async () => {
      // Revoke immediately, but still wait for the actual child and all owned
      // worker dials. The public exited signal is not proof of child reaping.
      const draining = server.close();
      child.stdin.destroy();
      const timer = setTimeout(() => child.kill(), 2000); timer.unref?.();
      try { await Promise.all([draining, childExited]); }
      finally { clearTimeout(timer); }
    })();
    exited.then(stop);
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('native worker bridge readiness timed out')), readyTimeoutMs);
      child.stdout.on('data', b => { out = (out + b).slice(-1000); if (out.includes('shielded bridge ready')) { clearTimeout(timer); resolve(); } });
      child.stderr.resume(); // no payload, credential or token is copied to logs
      exited.then(() => { clearTimeout(timer); reject(new Error('native worker bridge exited')); });
    });
    return { exited, stats: server.stats, stop };
  } catch (e) {
    if (child) { child.stdin?.destroy(); child.kill(); }
    await server.close(); throw e;
  }
}
