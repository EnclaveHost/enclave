#!/usr/bin/env node
// metal-agent — the in-CVM service that replaces everything the Tinfoil shim
// did for us, with no Tinfoil dependency:
//
//   1. Attestation. Generates the enclave's transport keypair inside the CVM,
//      asks the CPU for a hardware attestation report over configfs-tsm with
//      report_data[0:32] = sha256(transport pubkey SPKI), and serves the Remote
//      Attestation Document at http://127.0.0.1:<RAD_PORT>/.well-known/
//      enclave-attestation. The supervisor is pointed here via ATTESTATION_URL,
//      so it relays + parses this document exactly as it did the shim's.
//
//   2. Reachability. Behind CGNAT there is no inbound, so the agent dials OUT to
//      the relay and holds a fleet tunnel; the relay forwards the enclave's
//      public HTTP surface (/v1/*, /availability, /x/*) back over it. A colo box
//      with a public IP can skip this (set metal.public_url and front 443).
//
// No secret in this file leaves the CVM; the transport key is minted per boot.
import http from 'node:http';
import net from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// borrow ws from the supervisor image (/app); fall back to normal resolution so
// the agent also runs outside the CVM (harnesses, dev boxes)
const WebSocket = (() => {
  for (const base of ['/app/package.json', import.meta.url]) {
    try { return createRequire(base)('ws'); } catch {}
  }
  throw new Error("cannot resolve 'ws' (looked in /app and next to this file)");
})();

const MODE      = process.env.METAL_MODE || 'snp';
const NAME      = process.env.METAL_NAME || 'metal0';
const RAD_PORT  = parseInt(process.env.METAL_RAD_PORT || '8443', 10);
const SUP_URL   = process.env.METAL_SUP_URL || 'http://127.0.0.1:8080';
const RELAY_URL = process.env.METAL_RELAY_URL || '';
const RELAY_HOST = process.env.METAL_RELAY_HOST || '';    // Host/SNI when dialing via an egress helper
const TOKEN     = process.env.METAL_TUNNEL_TOKEN || '';
const log = (...a) => console.log('[agent]', ...a);

// --- transport identity (minted in-CVM) -------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
const keyFp = createHash('sha256').update(spkiDer).digest();         // 32 bytes
log(`transport key fingerprint ${keyFp.toString('hex').slice(0, 16)}…`);

// --- hardware attestation via configfs-tsm ----------------------------------
const TSM = '/sys/kernel/config/tsm/report';
function tsmReport(reportData64) {
  // one entry per call; the kernel serialises access and bumps `generation`
  const dir = `${TSM}/metal-${process.pid}`;
  fs.mkdirSync(dir);
  try {
    fs.writeFileSync(`${dir}/inblob`, reportData64);                 // 64 bytes
    const outblob = fs.readFileSync(`${dir}/outblob`);               // raw report
    let auxblob = null, provider = null;
    try { auxblob = fs.readFileSync(`${dir}/auxblob`); } catch {}    // cert chain (VCEK…)
    try { provider = fs.readFileSync(`${dir}/provider`, 'utf8').trim(); } catch {}
    return { outblob, auxblob, provider };
  } finally { try { fs.rmdirSync(dir); } catch {} }
}

// Build a RAD whose report_data binds an arbitrary 32-byte prefix (the default
// is the transport-key fingerprint; the fleet tunnel's attestation attach asks
// for sha256(transportKey || challenge) so the quote is FRESH per attach).
function radWithReportData(first32) {
  const reportData = Buffer.alloc(64);
  first32.copy(reportData, 0);
  const { outblob, auxblob, provider } = tsmReport(reportData);
  const fmt = (provider || '').includes('tdx') || MODE === 'tdx' ? 'tdx-guest-metal-v1' : 'sev-snp-guest-metal-v1';
  const doc = { format: fmt, body: outblob.toString('base64'), transportKey: spkiDer.toString('base64'), transportKeyFp: keyFp.toString('hex'), name: NAME };
  if (auxblob) doc.certs = auxblob.toString('base64');
  try { doc.manifest = JSON.parse(fs.readFileSync('/opt/metal/manifest.json', 'utf8')); } catch {}
  return doc;
}
// Quote bound to a relay challenge: report_data = sha256(transportKey SPKI || nonce).
function radForChallenge(nonceB64) {
  const nonce = Buffer.from(nonceB64, 'base64');
  const bind = createHash('sha256').update(Buffer.concat([spkiDer, nonce])).digest();
  return radWithReportData(bind);
}

let radCache = null, radAt = 0;
function buildRad() {
  if (radCache && Date.now() - radAt < 10000) return radCache;
  const reportData = Buffer.alloc(64);
  keyFp.copy(reportData, 0);
  let doc;
  if (MODE === 'dev') {
    // Clearly-labeled UNATTESTED document for pre-SNP bring-up. Same shape, but
    // the format name tells every verifier this proves nothing about hardware.
    const body = Buffer.alloc(0x4a0);
    reportData.copy(body, 0x50);                                     // keep the key-binding surface
    doc = { format: 'dev-unattested-metal-v1', body: body.toString('base64') };
  } else {
    const { outblob, auxblob, provider } = tsmReport(reportData);
    const fmt = (provider || '').includes('tdx') || MODE === 'tdx'
      ? 'tdx-guest-metal-v1' : 'sev-snp-guest-metal-v1';
    doc = { format: fmt, body: outblob.toString('base64') };
    if (auxblob) doc.certs = auxblob.toString('base64');
  }
  doc.transportKey = spkiDer.toString('base64');
  doc.transportKeyFp = keyFp.toString('hex');
  doc.name = NAME;
  try { doc.manifest = JSON.parse(fs.readFileSync('/opt/metal/manifest.json', 'utf8')); } catch {}
  radCache = doc; radAt = Date.now();
  return doc;
}

// --- RAD endpoint (loopback; the supervisor's ATTESTATION_URL points here) ---
http.createServer((req, res) => {
  if (req.url.startsWith('/.well-known/enclave-attestation') || req.url === '/health') {
    try {
      const body = req.url === '/health' ? { ok: true } : buildRad();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
  } else { res.writeHead(404); res.end(); }
}).listen(RAD_PORT, '127.0.0.1', () => log(`RAD endpoint on 127.0.0.1:${RAD_PORT} (mode=${MODE})`));

// warm the report so the first /v1/attestation is instant and to fail loudly if
// the silicon can't attest in a non-dev build.
try { const d = buildRad(); log(`attestation ready: format=${d.format}`); }
catch (e) { log(`WARNING: attestation unavailable: ${e.message}`); }

// --- fleet tunnel: forward the enclave's public HTTP surface over an outbound
// wss the relay accepts. Framed request/response (Phase 1 is buffered; SSE
// streaming rides a chunked-frame upgrade). ------------------------------------
function forward(frame, send) {
  const u = new URL(frame.path, SUP_URL);
  const body = frame.body ? Buffer.from(frame.body, 'base64') : undefined;
  const req = http.request(u, { method: frame.method || 'GET', headers: frame.headers || {} }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => send({
      t: 'res', id: frame.id, status: r.statusCode,
      headers: r.headers, body: Buffer.concat(chunks).toString('base64'),
    }));
  });
  req.on('error', (e) => send({ t: 'res', id: frame.id, status: 502, headers: {}, body: Buffer.from(String(e.message)).toString('base64') }));
  if (body) req.write(body);
  req.end();
}

// --- raw streams (Phase D): the hub splices a client's WebSocket UPGRADE into
// a plain TCP connection to the supervisor, which answers the handshake itself
// — this carries the /x/<id>/tls and /x/<id>/https bridges (TLS terminating in
// THIS CVM) out through the tunnel. Frames: s+ open · s= ack · sd data · sx
// close. The only reachable target is the supervisor's own port — the tunnel
// must never become a generic proxy into the guest.
const SUP_PORT = (() => { try { return Number(new URL(SUP_URL).port) || 80; } catch { return 8080; } })();
const MAX_GUEST_STREAMS = 128, GUEST_STREAM_IDLE_MS = 15 * 60_000;
const streams = new Map();                        // sid -> net.Socket
function stream(f, send) {
  if (f.t === 's+') {
    if (streams.size >= MAX_GUEST_STREAMS) return send({ t: 's=', sid: f.sid, ok: false, err: 'stream cap' });
    const sock = net.connect({ host: '127.0.0.1', port: SUP_PORT });
    streams.set(f.sid, sock);
    sock.setTimeout(GUEST_STREAM_IDLE_MS, () => sock.destroy());
    sock.on('connect', () => send({ t: 's=', sid: f.sid, ok: true }));
    sock.on('data', (c) => send({ t: 'sd', sid: f.sid, d: c.toString('base64') }));
    const bye = () => { if (streams.delete(f.sid)) send({ t: 'sx', sid: f.sid }); };
    sock.on('error', (e) => { if (streams.has(f.sid) && !sock.remotePort) { streams.delete(f.sid); send({ t: 's=', sid: f.sid, ok: false, err: e.code || 'connect failed' }); } });
    sock.on('close', bye);
    return;
  }
  const sock = streams.get(f.sid);
  if (!sock) return;
  if (f.t === 'sd') { try { sock.write(Buffer.from(f.d || '', 'base64')); } catch {} }
  else if (f.t === 'sx') { streams.delete(f.sid); sock.destroy(); }
}

// One-shot connectivity probe so failures are diagnosable from the journal:
// separate DNS from TCP-reachability, and IPv4 from IPv6.
async function probe() {
  const net = await import('node:net');
  const dns = await import('node:dns');
  let host = 'api.enclave.host';
  try { host = new URL(RELAY_URL).hostname; } catch {}
  try {
    const a = await dns.promises.resolve4(host).catch(() => []);
    const aaaa = await dns.promises.resolve6(host).catch(() => []);
    log(`probe: ${host} -> A=[${a.join(',')}] AAAA=[${aaaa.length ? aaaa.join(',') : 'none'}]`);
    for (const ip of a.slice(0, 1)) {
      await new Promise((res) => {
        const s = net.connect({ host: ip, port: 443, family: 4 });
        const t = setTimeout(() => { s.destroy(); log(`probe: TCP ${ip}:443 (v4) TIMEOUT`); res(); }, 6000);
        s.on('connect', () => { clearTimeout(t); log(`probe: TCP ${ip}:443 (v4) OK`); s.destroy(); res(); });
        s.on('error', (e) => { clearTimeout(t); log(`probe: TCP ${ip}:443 (v4) ${e.code}`); res(); });
      });
    }
  } catch (e) { log(`probe error: ${e.message}`); }
}

function connectTunnel() {
  if (!RELAY_URL) { log('no relay configured; tunnel disabled (RAD-only mode)'); return; }
  probe();
  let ws, alive = false;
  const dial = () => {
    log(`tunnel dialing ${RELAY_URL}`);
    // force IPv4: QEMU user-net (slirp) NATs IPv4 only, but api.enclave.host has
    // an AAAA record, so an unpinned dial hangs on the IPv6 attempt. RELAY_HOST,
    // when set (egress-helper mode), carries the real relay hostname for the Host
    // header even though the socket target is the helper.
    const headers = { 'x-metal-name': NAME, 'x-metal-token': TOKEN };
    if (!TOKEN) headers['x-metal-attest'] = '1';   // no token → prove identity by SEV-SNP quote (permissionless)
    if (RELAY_HOST) headers.host = RELAY_HOST;
    ws = new WebSocket(RELAY_URL, { headers, family: 4 });
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    ws.on('open', () => {
      alive = true;
      send({ t: 'hello', name: NAME, mode: MODE, token: TOKEN, publicUrl: process.env.METAL_PUBLIC_URL || '', transportKeyFp: keyFp.toString('hex') });
      log('tunnel open');
    });
    ws.on('message', (data) => {
      let f; try { f = JSON.parse(data); } catch { return; }
      if (f.t === 'req') forward(f, send);
      else if (f.t === 's+' || f.t === 'sd' || f.t === 'sx') stream(f, send);
      else if (f.t === 'ping') send({ t: 'pong' });
      else if (f.t === 'challenge') {         // permissionless attach: answer with a fresh quote over the nonce
        try { send({ t: 'attest', rad: radForChallenge(f.nonce) }); log('sent attestation for tunnel challenge'); }
        catch (e) { log(`attest failed: ${e.message}`); }
      } else if (f.t === 'attest-result') log(`attest ${f.ok ? 'ACCEPTED' + (f.measurement ? ' meas=' + String(f.measurement).slice(0, 16) + '…' : '') : 'REJECTED: ' + f.reason}`);
    });
    ws.on('unexpected-response', (_req, res) => { log(`tunnel handshake rejected: HTTP ${res.statusCode}`); try { ws.terminate(); } catch {} });
    ws.on('close', () => { if (alive) log('tunnel closed'); alive = false; for (const s of [...streams.values()]) s.destroy(); streams.clear(); setTimeout(dial, 2000); });
    ws.on('error', (e) => { log(`tunnel error: ${e.code || ''} ${e.message || String(e)}`); try { ws.terminate(); } catch {} });
  };
  dial();
}
connectTunnel();
