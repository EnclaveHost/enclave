#!/usr/bin/env node
// M2 client and verifier (isolation/DESIGN.md section 10). Talks to one app domain the way a platform
// client would:
//   1. fetch the attestation document with a fresh nonce, and take the server key from THAT
//      connection's TLS handshake (never from the document);
//   2. judge it (judge.mjs). Only a verdict the mode allows opens the gate; a closed gate means NO
//      application request is ever sent;
//   3. pin the judged key. Every later connection, reconnects included, must present exactly that key
//      in its handshake BEFORE a request is attached to it; one mismatch aborts all application traffic.
//
// usage: node client.mjs <https://host:port> --measurement <hex> --app-sha <hex>
//          [--lab-unsigned | --t0-diagnostic] [--min-tcb <json>|@<file>] [--vcek <der>]
//          [--amd-chain <Product>=<cert_chain.pem>] [--no-kds] [--t0 <epoch ms>] [--perf] [--save <doc.json>]
//          [--runtime <runtime.json>] [--servername <name>] [--answer-within <ms>]
//   default          trusted: only a report that is AMD-chain-verified AND meets --min-tcb opens the gate
//   --lab-unsigned   lab-only diagnostic: verdicts "no-tcb-policy" / "unauthenticated" open it, never "attested"
//   --t0-diagnostic  talk to a T0 domain, explicitly untrusted (the pin is trust-on-first-use)
//   --min-tcb        the caller's minimum-TCB policy (relay/snp-verify.mjs checkMinTcb); no default floor exists
//   --vcek           a VCEK the caller already holds; judged exactly like one in the report's certificate table
//   --amd-chain      AMD's cert_chain for a product line, held locally; refused unless its ARK is the pinned root
//   --no-kds         never contact AMD KDS (which answers 429 after a couple of requests)
//   --runtime        the runtime identity this domain must state, as a file in the shape
//                    isolation/contract/runtime-identity.sh writes. Supplying it DEMANDS ABI/2 and pins the
//                    runtime field for field: the app is one portable WebAssembly component compiled inside
//                    the domain, so the runtime, its version, its execution mode, the ISA it targets and its
//                    CPU-feature policy are part of what the report vouches for. Without it the runtime a
//                    domain states is bound but unpinned, and the verdict lines say so
//   --vmpl N         the privilege level the report must come from (default 0). A domain beneath a monitor
//                    at VMPL0 reports its own level, and the launch measurement is the same at every level.
//                    Above 0 this ALSO requires the monitor's boundary self-test in the document to record
//                    that a report at VMPL0 was refused: a guest at VMPL0 holds every VMPCK and can request
//                    a report naming a lower level, so the level alone never shows confinement
//
//   --servername     the name to put in the ClientHello when the URL names an address rather than the domain -
//                    a relay or splice in front of the domain that routes on SNI. It changes nothing about trust:
//                    the key is still taken from this handshake and judged against the report
//   --answer-within  how long to keep retrying for the first attestation document (default 180000 ms, for a
//                    domain that is still booting); a route that refuses the connection fails after this
//
// Prints `RESULT k=v` lines for the harness, `evidence:` lines for people, and one VERDICT line.
// Exit status: 0 served, 3 gate closed (no application traffic), 4 application traffic aborted on a key
// mismatch, 1 anything else.
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { judge } from './judge.mjs';
import { seedCertChain } from '../../relay/snp-verify.mjs';

const args = process.argv.slice(2);
const url = new URL(args[0]);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const lab = args.includes('--lab-unsigned'), t0diag = args.includes('--t0-diagnostic');
if (lab && t0diag) { console.error('--lab-unsigned and --t0-diagnostic are exclusive'); process.exit(2); }
const mode = lab ? 'lab-unsigned' : t0diag ? 't0-diagnostic' : 'trusted';
const want = { measurement: (opt('--measurement') || '').toLowerCase(), appSha: (opt('--app-sha') || '').toLowerCase(), mode,
  kds: !args.includes('--no-kds') };
if (opt('--vmpl') !== undefined) want.expectedVmpl = Number(opt('--vmpl'));
if (opt('--min-tcb') !== undefined) {
  const raw = opt('--min-tcb');
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  try { want.minTcb = JSON.parse(text); } catch { want.minTcb = text; }        // malformed: the verifier refuses it
}
if (opt('--vcek')) want.vcek = fs.readFileSync(opt('--vcek'));
if (opt('--runtime')) want.runtime = JSON.parse(fs.readFileSync(opt('--runtime'), 'utf8'));
if (opt('--amd-chain')) {
  const [product, file] = opt('--amd-chain').split('=');
  seedCertChain(product, fs.readFileSync(file, 'utf8'));                       // throws unless the ARK is the pin
}
const t0 = Number(opt('--t0') || 0);
const servername = opt('--servername');
const answerMs = opt('--answer-within') !== undefined ? Number(opt('--answer-within')) : 180000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const out = (k, v) => console.log(`RESULT ${k}=${v}`);

// --- connections: the key is checked at the handshake, before any request can use the socket -------
class PinMismatch extends Error {}
let tripped = null;               // the first mismatch; after it, no connection is handed to a request
let appRequests = 0, refusedHandshakes = 0;
const handshakeKey = new WeakMap();

// createConnection is asynchronous here: the agent attaches a request to the socket only when `cb`
// hands it over, which is after the handshake finished and the key matched. A socket whose key does not
// match is destroyed without a byte of application data ever having been queued on it. The sockets are
// built directly with tls.connect, so there is no TLS session cache: a resumed TLS 1.3 handshake shows
// no certificate, and every handshake here must show the key (the front issues no tickets either).
class PinnedAgent extends https.Agent {
  constructor(pin) { super({ keepAlive: true, maxSockets: 1 }); this.pin = pin; }   // pin null: discovery
  createConnection(options, cb) {
    if (tripped) { process.nextTick(cb, tripped); return undefined; }
    let settled = false;
    const done = (err, s) => { if (!settled) { settled = true; cb(err, s); } };
    const s = tls.connect({ ...options, ...(servername ? { servername } : {}), rejectUnauthorized: false,
      session: undefined });                                                             // trust = the report
    s.once('secureConnect', () => {
      const cert = s.getPeerX509Certificate();
      const key = cert ? cert.publicKey.export({ type: 'spki', format: 'der' }) : null;
      if (this.pin && !(key && key.equals(this.pin))) {
        refusedHandshakes++;
        tripped = tripped || new PinMismatch(`handshake key ${key ? sha(key).slice(0, 16) : 'none'}... is not the pinned ${sha(this.pin).slice(0, 16)}...`);
        s.destroy();
        return done(tripped);
      }
      handshakeKey.set(s, key);
      done(null, s);
    });
    s.once('error', (e) => done(e));
    return undefined;
  }
}

function request(agent, method, path, body, { app = true } = {}) {
  if (app && tripped) return Promise.reject(tripped);
  return new Promise((resolve, reject) => {
    const r = https.request({ host: url.hostname, port: url.port, method, path, agent,
      headers: body ? { 'content-length': body.length } : {} }, (res) => {
      const spki = handshakeKey.get(res.socket) || null;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), spki }));
      res.on('error', reject);
    });
    if (app) r.once('socket', () => { appRequests++; });   // only a verified socket is ever handed over
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    r.end(body);
  });
}

async function attest(agent, nonce) {
  const r = await request(agent, 'GET', `/.well-known/enclave-attestation?nonce=${nonce.toString('hex')}`, null, { app: false });
  if (r.status !== 200) throw new Error(`attestation HTTP ${r.status}: ${r.body.toString().slice(0, 200)}`);
  return { doc: JSON.parse(r.body.toString()), spki: r.spki };
}

function finish(code) {
  out('app_requests_sent', appRequests);
  out('refused_handshakes', refusedHandshakes);
  process.exit(code);
}

out('mode', mode);
// 1. the document, on a discovery connection: before a verdict, this GET and its nonce are the only traffic
const n1 = randomBytes(32), n2 = randomBytes(32);
let a1;
for (const until = Date.now() + answerMs; ; await new Promise((r) => setTimeout(r, 50))) {
  const probe = new PinnedAgent(null);
  try { a1 = await attest(probe, n1); probe.destroy(); break; } catch { probe.destroy(); }
  if (Date.now() > until) { console.log('VERDICT reject reason="the domain never answered"'); finish(1); }
}
if (t0) out('first_attestation_ms', Date.now() - t0);
if (opt('--save')) fs.writeFileSync(opt('--save'), JSON.stringify({ doc: a1.doc, spki: a1.spki.toString('base64'), nonce: n1.toString('hex') }));
out('tier', a1.doc.tier);
out('spki_sha256', sha(a1.spki));
out('doc_key_matches_handshake', a1.doc.transportKey === a1.spki.toString('base64') ? 1 : 0);

// 2. the verdict, and the gate
const j1 = await judge(a1.doc, a1.spki, n1, want);
for (const s of j1.reasons) console.log(`evidence: ${s}`);
if (j1.measurement) { out('measurement', j1.measurement); out('report_data', j1.reportData); }
out('expected_vmpl', want.expectedVmpl ?? 0);
if (j1.vmpl !== undefined) out('report_vmpl', j1.vmpl);
// The monitor's boundary self-test, as it arrived over THIS attested connection rather than on the host's
// serial console. A report naming a lower level proves nothing on its own; the refusal at level 0 is the
// part that distinguishes confinement, and judge.mjs rejects a document that cannot show it.
if (j1.boundary !== undefined) out('boundary', JSON.stringify(j1.boundary));
// The ABI the domain bound, and under ABI/2 the runtime identity that went into report_data[0:32] plus the
// domain's own runtime self-test (may it hold an executable page at all; is any page writable AND
// executable). Whether that identity was PINNED by this caller is in the evidence lines above.
out('abi', j1.abi ?? 'enclave-domain-abi/1');
out('runtime_pinned', want.runtime !== undefined ? 1 : 0);
if (j1.runtime !== undefined) out('runtime', JSON.stringify(j1.runtime));
if (j1.runtimeSelfTest !== undefined) out('runtime_selftest', JSON.stringify(j1.runtimeSelfTest));
if (j1.tcb) { out('tcb_product', j1.tcb.product); out('tcb_reported', JSON.stringify(j1.tcb.reported)); out('tcb_checked', j1.tcb.checked ? 1 : 0); }
console.log(`VERDICT ${j1.verdict} reason=${JSON.stringify(j1.reasons.at(-1))}`);
out('gate', j1.gateOpen ? 'open' : 'closed');
if (!j1.gateOpen) finish(3);

// 3. everything from here runs on connections that must present the judged key
const pin = a1.spki;
const agent = new PinnedAgent(pin);
try {
  if (a1.doc.format !== 'none') {
    // freshness: a second nonce on a new, pinned connection gets the same verdict, and the first
    // report does not satisfy the second nonce (no replay)
    const side = new PinnedAgent(pin);
    const a2 = await attest(side, n2);
    side.destroy();
    out('key_stable_in_launch', a2.spki && a2.spki.equals(pin) ? 1 : 0);
    out('second_nonce_verdict', (await judge(a2.doc, a2.spki, n2, want)).verdict);
    out('replay_rejected', (await judge(a1.doc, a1.spki, n2, want)).verdict === 'reject' ? 1 : 0);
  }

  // the app (it may still be starting behind the front: retry a 502 briefly)
  let app;
  for (const until = Date.now() + 60000; ; await new Promise((r) => setTimeout(r, 50))) {
    app = await request(agent, 'GET', '/hello?from=client');
    if (app.status !== 502 || Date.now() > until) break;
  }
  if (t0) out('first_app_response_ms', Date.now() - t0);
  out('app_status', app.status);
  out('app_body', JSON.stringify(app.body.toString().trim()));
  out('app_on_pinned_key', app.spki && app.spki.equals(pin) ? 1 : 0);

  // cost of serving through the domain: sequential latency and echo throughput, pinned throughout
  if (args.includes('--perf')) {
    const lat = [];
    for (let i = 0; i < 300; i++) {
      const s = process.hrtime.bigint();
      const r = await request(agent, 'GET', '/p');
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (r.status !== 200) { out('perf_error', `latency-${i}`); break; }
    }
    lat.sort((x, y) => x - y);
    out('latency_p50_ms', lat[Math.floor(lat.length * 0.5)].toFixed(2));
    out('latency_p99_ms', lat[Math.floor(lat.length * 0.99)].toFixed(2));
    const blob = randomBytes(16 << 20);
    let bytes = 0, ok = 1;
    const s = process.hrtime.bigint();
    for (let i = 0; i < 4; i++) {
      const r = await request(agent, 'POST', '/echo', blob);
      if (r.status !== 200 || !r.body.equals(blob)) ok = 0;
      bytes += blob.length * 2;
    }
    const secs = Number(process.hrtime.bigint() - s) / 1e9;
    out('echo_intact', ok);
    out('echo_mb_per_s', (bytes / secs / 1e6).toFixed(1));
  }
} catch (e) {
  if (!(e instanceof PinMismatch)) throw e;
  console.log(`evidence: application traffic ABORTED: ${e.message}`);
  out('app_aborted', 'pin-mismatch');
  agent.destroy();
  finish(4);
}
agent.destroy();
finish(0);
