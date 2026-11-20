// `enclave connect`: reach one attested guest from this machine, through a loopback proxy that trusts nothing it
// has not verified. The guest's front terminates TLS on a key that never leaves it, so:
//   1. fetch /.well-known/enclave-attestation with a fresh nonce on a discovery connection, taking the key from
//      THAT handshake (never from the document), and judge it; a refused verdict means nothing is ever forwarded;
//   2. pin the judged key: every later connection must present exactly it before a request is attached to it;
//   3. a connection that presents another key (the guest restarted) is dropped and the guest is attested again;
//      only a fresh passing verdict moves the pin.
// What is served locally: an HTTP + WebSocket origin on 127.0.0.1 (refusing foreign Host/Origin headers, so a web
// page cannot reach it by DNS rebinding or a cross-site request), and optional TCP/UDP ports carried through the
// front's /.well-known/enclave-tunnel/{tcp|udp}/{port} upgrade (isolation/m4/PROTECTED-PORTS.md).
// The caller decides what "verified" means (guestVerifier below, or its own function), so the same proxy serves a
// platform deployment, a whole-VM app, or a developer's local guest.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { startConnector, parseBindings } from '../isolation/m2/port-connector.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MAX_DOC = 2 * 1024 * 1024;
const DROP_UP = ['proxy-authorization', 'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];
const DROP_DOWN = ['strict-transport-security', 'alt-svc'];
export class PinMismatch extends Error {}

// verify(doc, spki, nonce) -> { ok, reason?, measurement?, format? }. Throws only on a usage error.
export async function startConnect({ host, port = 443, servername = host, verify, listen = { host: '127.0.0.1', port: 0 },
  serveHttp = true, ports = null, portHost = '127.0.0.1', authorization = null, stateFile = null, log = () => {}, connect = tls.connect } = {}) {
  if (typeof verify !== 'function') throw new Error('connect needs a verifier');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('connect needs a guest host and port');
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(listen.host)) throw new Error('the local origin binds only to a 127.x loopback address');
  if (ports) parseBindings(ports);
  if (!serveHttp && !ports) throw new Error('nothing to serve: --no-http needs --port');
  const sni = isIP(servername) ? undefined : servername;
  const remoteOrigin = `https://${servername}${port === 443 ? '' : ':' + port}`;

  // One TLS connection. With a pin, it is handed over only after the handshake showed exactly that key; there is
  // no session cache (a resumed TLS 1.3 handshake shows no certificate), so every connection shows its key.
  const dial = (pin) => new Promise((resolve, reject) => {
    const s = connect({ host, port, servername: sni, rejectUnauthorized: false, session: undefined, ALPNProtocols: ['http/1.1'], allowHalfOpen: true });
    let settled = false;
    const done = (e, v) => { if (settled) return; settled = true; s.setTimeout(0); e ? (s.destroy(), reject(e)) : resolve(v); };
    s.setTimeout(15000, () => done(new Error('guest TLS timeout')));
    s.once('error', (e) => done(e));
    s.once('secureConnect', () => {
      const key = s.getPeerX509Certificate()?.publicKey.export({ type: 'spki', format: 'der' });
      if (!key) return done(new Error('the guest showed no TLS key'));
      if (pin && !key.equals(pin)) return done(new PinMismatch(`guest TLS key ${sha(key).slice(0, 16)}… is not the attested ${sha(pin).slice(0, 16)}…`));
      done(null, { socket: s, spki: key });
    });
  });

  let current = null, flight = null;    // current: { pin, verdict, at }
  let localOrigin = '', localHost = '', server = null, stopPorts = null;
  async function fetchEvidence() {
    const nonce = randomBytes(32), { socket, spki } = await dial(null);
    const doc = await new Promise((resolve, reject) => {
      const req = https.request({ host, port, method: 'GET', path: `/.well-known/enclave-attestation?nonce=${nonce.toString('hex')}`,
        headers: { host: servername, accept: 'application/json' }, createConnection: () => socket }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (b) => { size += b.length; if (size > MAX_DOC) res.destroy(new Error('oversized attestation document')); else chunks.push(b); });
        res.once('error', reject);
        res.once('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`attestation endpoint answered HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { reject(new Error('attestation document is not JSON')); }
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error('attestation timeout')));
      req.once('error', reject);
      req.end();
    }).finally(() => socket.destroy());
    return { doc, spki, nonce };
  }
  function attest() {
    if (flight) return flight;
    flight = (async () => {
      const { doc, spki, nonce } = await fetchEvidence();
      const verdict = await verify(doc, spki, nonce);
      if (!verdict?.ok) throw new Error(`attestation refused: ${verdict?.reason || 'no reason given'}`);
      const moved = current && !current.pin.equals(spki);
      current = { pin: spki, verdict, at: new Date().toISOString() };
      log(`${moved ? 'guest restarted: new key attested' : 'attested'}: ${verdict.format || 'report'}${verdict.measurement ? ` measurement ${verdict.measurement.slice(0, 16)}…` : ''}; TLS key sha256:${sha(spki).slice(0, 16)}… pinned`);
      writeState();
      return current;
    })().finally(() => { flight = null; });
    return flight;
  }
  async function pinned() {
    const at = current || await attest();
    try { return (await dial(at.pin)).socket; }
    catch (e) {
      if (!(e instanceof PinMismatch)) throw e;
      log(`${e.message}; attesting again`);
      if (current === at) current = null;
      return (await dial((current || await attest()).pin)).socket;
    }
  }
  class PinnedAgent extends https.Agent {
    createConnection(options, cb) { pinned().then((s) => cb(null, s), cb); return undefined; }
  }
  const agent = new PinnedAgent({ keepAlive: true, maxSockets: 16 }), upgradeAgent = new PinnedAgent({ keepAlive: false });

  // Fail fast: no local port opens before the first passing verdict.
  await attest();

  const allowed = (req) => req.headers.host === localHost && (!req.headers.origin || req.headers.origin === localOrigin);
  function upHeaders(req) {
    const h = { ...req.headers, host: servername };
    for (const k of DROP_UP) delete h[k];
    if (h.origin) h.origin = remoteOrigin;
    if (h.referer?.startsWith(localOrigin + '/')) h.referer = remoteOrigin + h.referer.slice(localOrigin.length);
    if (authorization) h.authorization = authorization;
    return h;
  }
  function downHeaders(headers) {
    const h = { ...headers };
    for (const k of DROP_DOWN) delete h[k];
    if (typeof h.location === 'string' && (h.location === remoteOrigin || h.location.startsWith(remoteOrigin + '/')))
      h.location = localOrigin + h.location.slice(remoteOrigin.length);
    // a cookie scoped to the app's public name would never come back to 127.0.0.1
    if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map((c) => c.replace(/;\s*domain=[^;]*/ig, ''));
    return h;
  }
  const refuse = (res, code, msg) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(msg + '\n'); };

  if (serveHttp) {
    server = http.createServer((req, res) => {
      if (!allowed(req)) return refuse(res, 403, 'refused: this proxy serves only its own loopback origin');
      const up = https.request({ host, port, method: req.method, path: req.url, headers: upHeaders(req), agent }, (reply) => {
        res.writeHead(reply.statusCode, reply.statusMessage, downHeaders(reply.headers));
        reply.pipe(res);
      });
      up.once('error', (e) => refuse(res, e instanceof PinMismatch || /attestation/.test(e.message) ? 503 : 502, e.message));
      res.once('close', () => { if (!res.writableFinished) up.destroy(); });
      req.pipe(up);
    });
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      if (!allowed(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      const up = https.request({ host, port, method: req.method, path: req.url, headers: upHeaders(req), agent: upgradeAgent });
      up.once('upgrade', (res, remote, rest) => {
        const lines = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`);
        socket.write(`HTTP/1.1 101 ${res.statusMessage || 'Switching Protocols'}\r\n${lines.join('')}\r\n`);
        if (head.length) remote.write(head);
        if (rest.length) socket.write(rest);
        socket.pipe(remote); remote.pipe(socket);
        remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      });
      up.once('response', (res) => { res.resume(); socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\nConnection: close\r\n\r\n`); });
      up.once('error', (e) => socket.end(`HTTP/1.1 ${/attestation|key/.test(e.message) ? 503 : 502} Bad Gateway\r\nConnection: close\r\n\r\n${e.message}\n`));
      up.end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listen.port, listen.host, resolve); });
    localHost = `${listen.host}:${server.address().port}`; localOrigin = `http://${localHost}`;
  }

  // A raw port: one pinned connection per local TCP connection or UDP peer, upgraded to the front's tunnel.
  const tunnel = (protocol, remotePort) => new Promise((resolve, reject) => {
    const req = https.request({ host, port, method: 'GET', agent: upgradeAgent, path: `/.well-known/enclave-tunnel/${protocol}/${remotePort}`,
      headers: { host: servername, connection: 'Upgrade', upgrade: 'enclave-port/1', ...(authorization ? { authorization } : {}) } });
    req.setTimeout(15000, () => req.destroy(new Error('tunnel upgrade timeout')));
    req.once('upgrade', (res, socket, head) => {
      if (res.statusCode !== 101 || String(res.headers.upgrade).toLowerCase() !== 'enclave-port/1') { socket.destroy(); return reject(new Error('invalid tunnel upgrade')); }
      req.setTimeout(0); socket.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('response', (res) => { res.resume(); reject(new Error(`tunnel ${protocol}:${remotePort} refused: HTTP ${res.statusCode}`)); });
    req.once('error', reject);
    req.end();
  });
  if (ports) {
    try { stopPorts = await startConnector(ports, tunnel, { host: portHost, log }); }
    catch (e) { server?.close(); throw e; }
  }

  function writeState() {
    if (!stateFile) return;
    const state = { url: localOrigin || null, remote: remoteOrigin, ports: ports ? { host: portHost, bindings: parseBindings(ports) } : null, pid: process.pid,
      spkiSha256: current ? sha(current.pin) : null, measurement: current?.verdict.measurement || null, format: current?.verdict.format || null, attestedAt: current?.at || null };
    const tmp = stateFile + '.tmp';
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, stateFile);
  }
  writeState();

  const stop = () => {
    stopPorts?.(); agent.destroy(); upgradeAgent.destroy();
    if (server) { server.close(); server.closeAllConnections?.(); }
  };
  return { url: localOrigin || null, remote: remoteOrigin, stop, attestation: () => current, reattest: attest };
}

// The verifier for Enclave's own guests: the guest-domain format (isolation/m2/judge.mjs) and the whole-VM format
// (network/snp-vm-app.mjs). Every expectation is the caller's own; none comes from the guest being judged.
//   hostData        the deployment id (0x + 64 hex) the report's HOST_DATA must equal; null only with unbound:true
//   measurements    96-hex launch measurement(s): exactly one for a guest domain, the version's list for a whole VM
//   appSha          64-hex AppID (guest domain); runtime: the runtime identity object (optional, guest domain)
//   minTcb          {Product:{…}} floor; default the published fleet floor (verifier/metal-box.mjs TCB_FLOORS)
//   vcek / amdChain AMD collateral held locally ({product: pem}); kds: may AMD KDS be contacted (default: when no VCEK)
export async function guestVerifier({ hostData = null, unbound = false, measurements = [], appSha = null, runtime, minTcb, vcek = null, amdChain = null, kds } = {}) {
  if (hostData !== null && !/^0x[0-9a-f]{64}$/.test(hostData)) throw new Error('the deployment id must be 0x + 64 lowercase hex');
  if (hostData === null && !unbound) throw new Error('name the deployment the report must be bound to, or pass --unbound for a development guest');
  if (/^0x0{64}$/.test(hostData || '')) throw new Error('an all-zero deployment id names nothing');
  if (!measurements.length || !measurements.every((m) => /^[0-9a-f]{96}$/.test(m))) throw new Error('at least one expected launch measurement (96 hex) is required');
  const [{ judge }, vm, { seedCertChain }, { TCB_FLOORS }] = await Promise.all([import('../isolation/m2/judge.mjs'), import('../network/snp-vm-app.mjs'),
    import('../relay/snp-verify.mjs'), import('../verifier/metal-box.mjs')]);
  for (const [product, pem] of Object.entries(amdChain || {})) seedCertChain(product, pem);   // refused unless its ARK is the pinned root
  const floor = minTcb ?? structuredClone(TCB_FLOORS), useKds = kds ?? !vcek;
  return async (doc, spki, nonce) => {
    if (doc?.format === vm.SNP_VM_FORMAT) {
      if (!hostData) return { ok: false, format: doc.format, reason: 'a whole-VM report is judged only against a named deployment' };
      const expected = { measurements, runtimeId: vm.snpVmRuntimeId(measurements) };
      const r = await vm.verifySnpVmProof(doc, spki, nonce, { deploymentId: hostData, expected, minTcb: floor, vcek, kds: useKds });
      return { ok: r.ok, format: doc.format, measurement: r.measurement, reason: r.reason };
    }
    if (measurements.length !== 1) return { ok: false, format: doc?.format, reason: 'a guest-domain report is judged against exactly one measurement' };
    if (!/^[0-9a-f]{64}$/.test(appSha || '')) return { ok: false, format: doc?.format, reason: 'a guest-domain report needs the expected AppID (--app-sha)' };
    const v = await judge(doc, spki, nonce, { measurement: measurements[0], appSha, mode: 'trusted', minTcb: floor, vcek: vcek || undefined, kds: useKds,
      ...(runtime ? { runtime } : {}), ...(hostData ? { hostData } : {}) });
    return { ok: v.gateOpen === true && v.verdict === 'attested', format: doc?.format || 'sev-snp-guest-domain', measurement: v.measurement, reason: v.reasons?.at(-1), verdict: v.verdict };
  };
}

// An Enclave Shield guest (a VBS-isolated Hyper-V partition on a Windows host). Its evidence chains to the HOST, not to
// a CPU vendor, and the host is not excluded: a pass proves the host's measured boot (a genuine TPM, over our nonce) and
// the partition's image, signed under the VSM identity key from that same verified boot, never confidentiality from the
// host. So it is opt-in (--shield) and reported as limited. The app and image expectations are the relay's statement
// (derived from the deployment's catalog entry), the same trust verifier/web/shield-app.mjs places in them.
export const SHIELD_FORMAT = 'hyperv-partition-domain/v1';
const HEX64 = /^[0-9a-f]{64}$/;
export function shieldVerifier({ apiBase = 'https://api.enclave.host', name, deployment, fetchImpl = globalThis.fetch, log = () => {}, hostTtlMs = 10 * 60 * 1000 } = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name || '')) throw new Error('a Shield guest needs its host name (--shield-host)');
  if (!/^0x[0-9a-f]{64}$/.test(deployment || '')) throw new Error('a Shield guest needs its deployment id');
  const deps = { fetchImpl, randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), now: () => new Date() };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let host = null, exp = null;
  async function hostSession() {
    if (host && Date.now() - host.at < hostTtlMs) return host;
    const { verifyShieldHostSessionWith } = await import('../verifier/web/shield-host.mjs');
    const r = await verifyShieldHostSessionWith(deps, { apiBase, name });
    if (r.verdict.status !== 'limited' || !r.session) throw new Error(`attestation refused: Shield host ${name}: ${r.verdict.summary}`);
    log(`Shield host ${name}: TPM session verified over our nonce (limited: ${r.verdict.omissions.join(', ')})`);
    return (host = { ...r.session, omissions: r.verdict.omissions, at: Date.now() });
  }
  // guest reports are rate-limited on the host: a busy answer is waited out a bounded number of times
  async function expectations() {
    if (exp) return exp;
    const { SHIELD_APP_PATH } = await import('../verifier/web/shield-app.mjs');
    for (let i = 0; ; i++) {
      const nonce = Buffer.from(deps.randomBytes(32)).toString('hex');
      const r = await fetchImpl(`${apiBase}${SHIELD_APP_PATH(name, deployment, nonce)}`, { headers: { accept: 'application/json' }, redirect: 'error' });
      const a = await r.json().catch(() => null);
      if (r.status === 503 && a?.error === 'busy' && i < 4) { const s = Math.min(Number(a.retryAfter) || 20, 60); log(`Shield expectations: host busy, retrying in ${s}s`); await sleep(s * 1000); continue; }
      if (r.status !== 200 || !a) throw new Error(`attestation refused: Shield expectations: HTTP ${r.status} ${a?.message || a?.error || ''}`.trim());
      if (a.mode !== 'hv-node' || String(a.deployment).toLowerCase() !== deployment) throw new Error('attestation refused: the relay answered for another host or deployment');
      const { expected: e, policy: p } = a;
      if (!HEX64.test(e?.appSha256 || '') || !HEX64.test(e?.runtimeId || '') || !Array.isArray(p?.measurements) || !p.measurements.length || !p.measurements.every((m) => HEX64.test(m)))
        throw new Error('attestation refused: the relay stated no usable app expectation or image list');
      // a per-image floor (newer relays) is enforced, conservatively, as the floor for every admitted image
      const pins = Array.isArray(p.imageIdentities) ? p.imageIdentities.map(({ measurement, identity }) => ({ measurement, identity })) : undefined;
      const floor = Math.max(Number.isSafeInteger(p.minimumGuestSvn) ? p.minimumGuestSvn : 0, ...(p.imageIdentities || []).map((x) => (Number.isSafeInteger(x.minimumGuestSvn) ? x.minimumGuestSvn : 0)));
      return (exp = { appSha256: e.appSha256, runtimeId: e.runtimeId, policy: { allowedMeasurements: p.measurements, minimumGuestSvn: floor, imageIdentities: pins, platforms: p.platforms } });
    }
  }
  return async (doc, spki, nonce) => {
    const h = await hostSession(), e = await expectations();
    const { verifyShieldAppEvidenceWeb } = await import('../verifier/web/shield-app.mjs');
    const v = await verifyShieldAppEvidenceWeb({ doc, handshakeSpki: spki, nonce, expectedAppSha256: e.appSha256, expectedRuntimeId: e.runtimeId, idks: h.idks, boot: h.boot }, e.policy);
    return { ok: v.ok === true, format: SHIELD_FORMAT, measurement: v.measurement, reason: v.reason, limited: true,
      omissions: [...h.omissions, 'app-expectation-relay-derived', 'image-list-operator-stated'] };
  };
}

// One verifier per evidence format; a format nobody asked to accept is refused with what would accept it.
export function composeVerifier({ snp = null, shield = null }) {
  return async (doc, spki, nonce) => {
    if (doc?.format === SHIELD_FORMAT) return shield ? shield(doc, spki, nonce)
      : { ok: false, format: SHIELD_FORMAT, reason: 'this is an Enclave Shield (Hyper-V) guest: host-attested, the host is not excluded; pass --shield to accept that' };
    return snp ? snp(doc, spki, nonce) : { ok: false, format: doc?.format, reason: 'an SEV-SNP guest needs its expected launch measurement (--expect)' };
  };
}
