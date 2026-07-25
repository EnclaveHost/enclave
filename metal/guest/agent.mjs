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
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/app/package.json');       // borrow ws from the supervisor image
const WebSocket = require('ws');

const MODE      = process.env.METAL_MODE || 'snp';
const NAME      = process.env.METAL_NAME || 'metal0';
const RAD_PORT  = parseInt(process.env.METAL_RAD_PORT || '8443', 10);
const SUP_URL   = process.env.METAL_SUP_URL || 'http://127.0.0.1:8080';
const RELAY_URL = process.env.METAL_RELAY_URL || '';
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

function connectTunnel() {
  if (!RELAY_URL) { log('no relay configured; tunnel disabled (RAD-only mode)'); return; }
  let ws, alive = false;
  const dial = () => {
    log(`tunnel dialing ${RELAY_URL}`);
    ws = new WebSocket(RELAY_URL, { headers: { 'x-metal-name': NAME, 'x-metal-token': TOKEN } });
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    ws.on('open', () => {
      alive = true;
      send({ t: 'hello', name: NAME, mode: MODE, token: TOKEN, publicUrl: process.env.METAL_PUBLIC_URL || '', transportKeyFp: keyFp.toString('hex') });
      log('tunnel open');
    });
    ws.on('message', (data) => {
      let f; try { f = JSON.parse(data); } catch { return; }
      if (f.t === 'req') forward(f, send);
      else if (f.t === 'ping') send({ t: 'pong' });
    });
    ws.on('close', () => { if (alive) log('tunnel closed'); alive = false; setTimeout(dial, 2000); });
    ws.on('error', (e) => { log(`tunnel error ${e.message}`); try { ws.terminate(); } catch {} });
  };
  dial();
}
connectTunnel();
