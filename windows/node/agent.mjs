// windows/node/agent.mjs -- the Windows consumer node's agent (untrusted plumbing, like the phone's host app).
//
// Runs three processes and one tunnel:
//   shielded-worker.exe   the GPU half (Vulkan), on 127.0.0.1:WORKER_PORT, untrusted by design
//   ee-host.exe           the VTL0 host of the enclave engine (windows/enclave-engine), serving keys/attest/gen on 127.0.0.1:HOST_PORT
//   tpmattest.exe         the TPM half (windows/node/tpmattest.c), driven over stdin/stdout
//   wss fleet tunnel      the relay's /v1/fleet-tunnel, attach by evidence per windows/vbs/EVIDENCE.md, then serve req frames
// Nothing here is trusted: the enclave refuses to attest keys it does not hold, the verifier recomputes every
// digest from the log, and the worker only ever sees masked activations.
//
// Configuration (environment, all optional except the model):
//   NODE_NAME            the tunnel name (x-metal-name), default the hostname lower-cased
//   RELAY_URL            wss://api.enclave.host/v1/fleet-tunnel
//   NODE_DIR             where the binaries live (default: this file's directory)
//   MODEL, CALIB         the GGUF and its calibration (required)
//   WORKER_EXE, WORKER_PORT (9595), WORKER_VRAM_GB (2), SHIELDED_VK_DEVICE, SHIELDED_CARD_TFLOPS (8)
//   HOST_EXE, ENCLAVE_DLL, HOST_PORT (9596), THREADS (8), CTX (1024)
//   TPMATTEST_EXE, PUBLIC_URL (the https://<relay>/t/<name> route a registered seller claims)
//   NODE_OPERATOR_KEY    hex private key of the on-chain operator, to sign the attach challenge when the name is registered
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Host } from './host.mjs';
import { appZone } from './appzone.mjs';
import { shieldedCard, shieldedProof } from './shieldedcard.mjs';
import { clientIp as wafClientIp } from './waf.mjs';
import { parseAbiReply } from './appframe.mjs';
import { initSessionKey, mint as mintSession, addressFor } from './session.mjs';
import { nonceStore, siweMessage, verifyLogin } from './siwe.mjs';
import { HV_NODE_FORMAT, buildHvNodeFrame, loadOrCreateNodeKey } from './hvnode-evidence.mjs';
const WAF_TRACE = /^(1|true|yes)$/i.test(String(process.env.WAF_TRACE || ''));
// SIWE, byte-compatible with the platform's own routes so the console signs what this box issues
// and posts it back unchanged. The session it mints is for THIS box only (session.mjs).
const SIWE_DOMAIN = process.env.SIWE_DOMAIN || 'enclave.host';
const SIWE_URI = process.env.SIWE_URI || 'https://enclave.host';
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID || 8453);
const SESSION_TTL = Number(process.env.SESSION_TTL || 604800);   // 7 days, the platform's
const nonces = nonceStore();
const WebSocket = createRequire(import.meta.url)('ws');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.NODE_DIR || HERE;
const NAME = (process.env.NODE_NAME || os.hostname()).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
const RELAY_URL = process.env.RELAY_URL || 'wss://api.enclave.host/v1/fleet-tunnel';
const MODEL = process.env.MODEL, CALIB = process.env.CALIB;
const WORKER_EXE = process.env.WORKER_EXE || path.join(DIR, 'shielded-worker.exe');
const WORKER_PORT = Number(process.env.WORKER_PORT || 9595), WORKER_VRAM_GB = process.env.WORKER_VRAM_GB || '2';
const HOST_EXE = process.env.HOST_EXE || path.join(DIR, 'ee-host.exe');
const ENCLAVE_DLL = process.env.ENCLAVE_DLL || path.join(DIR, 'ee-engine.dll');
const HOST_PORT = Number(process.env.HOST_PORT || 9596), THREADS = process.env.THREADS || '8', CTX = process.env.CTX || '1024';
const TPMATTEST_EXE = process.env.TPMATTEST_EXE || path.join(DIR, 'tpmattest.exe');
// The one string that has to agree in three places: the hello frame (the hub honours only a
// self-routed URL), the registry entry, and therefore keccak256(it) = the enclave id the ledger
// records as a deployment's runner. Get it wrong and every app this box holds reads "claimed"
// forever (relay/tunnel.js selfRoutedUrl, api-relay.js runnerIsLive).
const PUBLIC_URL = process.env.PUBLIC_URL || `https://api.enclave.host/t/${NAME}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[node]', ...a);
// Hosting apps (APPS=1): this box holds a lease on the ledger and runs that deployment's app under
// wasmtime, in VTL0. With APPS off it reports no claimEnabled at all and the relay keeps it out of
// the serving set, which is the honest reading: a box hosting nothing sells nothing.
// CLAIM_SCOPE=market (the default) takes any wallet's public deployment this box can honour;
// CLAIM_SCOPE=owner-only narrows it to the box owner's own. chain.mjs claimPolicy has each rule.
const APPS = /^(1|true|yes)$/i.test(String(process.env.APPS || ''));
// THE LEGACY VBS-ENCLAVE ENGINE IS RETIRED (Steven, 2026-09-25): this node hosts only the isolated backend (a Hyper-V
// type-1 partition per app, windows/vbslike). The engine (ee-host.exe + ee-engine.dll) and its worker start ONLY
// under the explicit rollback setting ENCLAVE_ENGINE=legacy, and under Secure Boot its test-signed image does not
// load anyway. Without it there are no enclave keys and no in-enclave apps (the host refuses them: appsInTee is
// false). Enclave-held sessions and completions answer 503 with the reason. The node attests with
// windows-hv-node/v1 (hvnode-evidence.mjs), which proves only that an admin-level process on this TPM's host, in
// this measured boot state, chose and holds its transport key.
const LEGACY_ENGINE = /^legacy$/i.test(String(process.env.ENCLAVE_ENGINE || ''));
const NO_ENGINE = 'this node runs only the isolated backend: the VBS enclave engine is retired, so this service is unavailable';
let nodeKey = null;          // windows-hv-node/v1: the agent's own Ed25519 transport key, a HOST key
// The app-zone half: built once APPS is on, because it needs the host to know which deployment
// runs where and which certificate belongs to it.
let zone = null;
// This box's session-signing key, minted or reloaded at startup (session.mjs).
let sessionKey = null;
// The card's own numbers, refreshed from the worker. Null until the first HELLO answers.
let card = null;
// The verdict of the platform's own shielded probe on this card, run once at start-up. Null until
// it has actually passed: a row must not say "shielded" on the strength of a config file.
let cardProof = null;
const PROBE = process.env.SHIELDED_PROBE || path.join(DIR, '..', 'probe', 'shielded-probe.mjs');
const readCard = async () => {
  try {
    card = await shieldedCard({ port: WORKER_PORT, budgetGb: Number(WORKER_VRAM_GB) });
  } catch (e) {
    if (card) log(`shielded card: the worker stopped answering (${e.message}); the row drops it`);
    card = null;
  }
};
// The live tunnel's sender, so the app-zone half can answer stream frames from outside connect()'s
// closure. Replaced on every redial; a frame sent while the tunnel is down is dropped, which is
// what the relay's own open timeout already handles.
let tunnelSend = () => {};
let tunnelBuffered = () => 0;
const host = new Host({
  dir: DIR, endpoint: process.env.PUBLIC_URL || `https://api.enclave.host/t/${NAME}`, name: NAME,
  appsEnabled: APPS, ownerWallet: process.env.OWNER_WALLET || '',
  // No engine: only isolated deployments run, anything else is HELD (host.mjs heldReason), never released.
  engineRetired: !LEGACY_ENGINE,
  // Respawn an isolated domain that ENDED instead of giving its lease up: a lease policy, OFF unless set to exactly "1"
  // (host.mjs, RESPAWN_BUDGET per hour). The budget is counted IN MEMORY, so a node restart resets it: "3 an hour" is 3
  // per hour of this process's life (enclave-d1's note for Steven's decision). Recovered VMs stay held either way.
  isolationRespawn: process.env.ENCLAVE_ISOLATION_RESPAWN === '1',
  cpuPricePerSec6: Number(process.env.CPU_PRICE_PER_SEC6 || 12),
  // What the whole CARD costs per second, USDC 6dp, and what a share of it buys here: the model
  // inside the enclave, whose linear algebra runs on this card by masked offload. The default is
  // $0.10 an hour for an iGPU that sustains ~175 G-MAC/s masked; the owner changes it from the
  // fleet row and the registry entry, not this file, is what the ledger charges.
  gpuPricePerSec6: Number(process.env.GPU_PRICE_PER_SEC6 || 28),
  // THE CARD ITSELF, asked of the worker rather than read from a config: the pool this box
  // advertises, the price it posts and every card-dialled claim it accepts all hang off whether a
  // worker is answering right now. `card` is null while it is not.
  card: () => card,
  // How the box proves who is asking, handed to the Host so the check can live at the funnel while
  // the key stays here. Null until the key is minted, and host.proxy fails CLOSED on null.
  sessionVerify: (headers, id) => addressFor(sessionKey, headers, id),
  claimScope: (process.env.CLAIM_SCOPE || 'owner-only').toLowerCase(),
  // CLAIM_LEGACY=1: take deployments created BEFORE this box was listed, which otherwise wait for
  // their owner to pick this enclave. Only an operator with the standing to consent for those
  // owners should set it; on this fleet that is the platform's own governance wallet and the box
  // owner's, and the box owner asked for it (chain.mjs claimPolicy has the reasoning).
  claimLegacy: /^(1|true|yes)$/i.test(String(process.env.CLAIM_LEGACY || '')),
  // Does a hosted app run INSIDE the VBS enclave? No, until the in-enclave runtime lands: stock
  // wasmtime needs a JIT, mmap and Rust std, none of which exist in VTL1. While this is false the
  // box advertises no claimEnabled, sells no app hosting, and runs only its owner's own apps.
  // the enclave gate, for an app that runs INSIDE it: host.mjs sends appopen/apphandle/appclose
  hostCmd: (line) => hostCmd(line),
  precompileExe: process.env.EE_PRECOMPILE || 'C:\\Users\\claude\\vbs\\enclave-rt\\ee-precompile.exe',
  // What an app may have of the enclave's own memory. The enclave is a fixed 2 GB (ee-main.cpp
  // EnclaveSize) and the model, its KV cache and the pads are in there first.
  // THE ENCLAVE'S OWN SIZE, dedicated to it at creation (ee-main.cpp EnclaveSize). This is the
  // RAM pool an app on this box is placed in and the number the fleet row shows; it must match the
  // signed image, which is why it is stated rather than derived.
  enclaveGb: Number(process.env.ENCLAVE_GB || 64),
  // An OPTIONAL ceiling on a single app, below the enclave's own size. Zero means no extra cap:
  // the budget is the enclave less what the engine holds.
  enclaveAppRamMb: Number(process.env.ENCLAVE_APP_RAM_MB || 0),
  // Measured from the enclave itself (the host protocol's `mem`), before any app is claimed: the
  // model, its KV cache and the pads. Never configured - a guess here either oversells the enclave
  // or hides most of it. NULL means "not measured yet", which is not the same as zero and must not
  // be read as one: an unmeasured box admits no new work (host.capacity).
  engineHeldMb: null,
  // filled in at startup from the enclave itself (`appabi`), never from config: see host.appsInTee
  enclaveAppAbi: 0,
  enclaveAppWorlds: 0,          // the bitmask the runtime reports: 1 enclave:app | 2 wasi:http | 4 wasi:cli
  enclaveAppFeatures: 0,        // and the WASM features it enables: 1 mem64 | 2 set | 4 p3 | 8 coop threads
  relayBase: process.env.RELAY_BASE || 'https://api.enclave.host',
  // The zone the platform gives an app its own hostname in: <label>.app.enclave.host.
  appZone: process.env.APP_ZONE || 'app.enclave.host',
  // Serve the hostnames a customer attached to their deployment. Off only if an operator
  // deliberately turns it off; without it their domain resolves here and gets nothing.
  customDomains: !/^(0|false|no|off)$/i.test(String(process.env.CUSTOM_DOMAINS ?? '1')),
  // Signing for the relay's secrets fetch: the operator key, which is what the registry entry
  // names, so the relay can tie the request to this box's on-chain lease. Set below once the key
  // is loaded; a box with no operator key fetches nothing and publishes secrets:false.
  secretsSign: null,
  repo: process.env.NODE_REPO || 'EnclaveHost/enclave',
  // the VBS enclave's own identity key (sha256(FamilyId||ImageId||AuthorId)), published on the
  // registry row so the chain's view and the relay's attestation verdict can be compared
  measurement: process.env.ENCLAVE_MEASUREMENT || '0x0000000000000000000000000000000000000000000000000000000000000000',
  vcpus: Number(process.env.NODE_VCPUS || os.cpus().length),
  ramGb: Number(process.env.NODE_RAM_GB || Math.round(os.totalmem() / 2 ** 30)),
  // the fleet's convention for a node's compute (metal gsup.mjs): 62.5 GFLOPS a vCPU
  gflops: Math.round(62.5 * Number(process.env.NODE_VCPUS || os.cpus().length)),
  // what stays with the enclave, the shielded worker and the owner of the PC, never sold
  reservedShare: Number(process.env.RESERVED_SHARE || 0.25),
  // The most one request body or one response this box holds in memory for an app.
  maxBodyMb: Number(process.env.ENCLAVE_APP_MAX_BODY_MB) || 64,
  wasmtime: process.env.WASMTIME_BIN || path.join(DIR, 'wasmtime.exe'),
  python: process.env.PYTHON_BIN || 'python',
  gateway: process.env.IPFS_GATEWAY || 'https://ipfs.enclave.host',
  portBase: Number(process.env.APP_PORT_BASE || 9700),
  appSlots: Number(process.env.APP_SLOTS || 4),
  // TEMPORARY: see host.mjs. Lets an app that bought a card share run even though its world
  // has no import that reaches the enclave's model.
  allowCardWithoutModel: /^(1|true|on)$/i.test(process.env.ENCLAVE_ALLOW_CARD_WITHOUT_MODEL || ''),
  inferenceUrl: `http://127.0.0.1:${process.env.LOCAL_HTTP_PORT || 9600}/v1/completions`,
  log: (m) => log('[host]', m),
});
if (LEGACY_ENGINE && !MODEL) { console.error('MODEL is required (the GGUF the legacy enclave serves)'); process.exit(2); }

let gpuName = process.env.GPU_NAME || '', tier = '', attachedAt = 0, spkiFp = '';
// ---- the three processes -----------------------------------------------------------------
const children = {};
// Set when the agent is shutting down on purpose, so a child's exit is not a crash to recover.
let stopping = false;
// How to start each supervised child again, filled in where they are first started.
const start = {};

function run(name, exe, args, env) {
  const p = spawn(exe, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const watch = (d) => {
    // the worker names its card on its first line; the row on the site reads that, not a guess
    const m = String(d).match(/vulkan: ([^,]+), queue family/);
    if (m && m[1]) gpuName = m[1].trim();
  };
  p.stdout.on('data', (d) => { watch(d); process.stdout.write(`[${name}] ${d}`); });
  p.stderr.on('data', (d) => { watch(d); process.stderr.write(`[${name}] ${d}`); });
  p.on('exit', (code, sig) => {
    log(`${name} exited (${code ?? sig})`);
    children[name] = null;
    // RESTART IT. The enclave host holds the model, the keys and every app in the box; when it
    // died the node kept answering /availability and serving nothing, which is the worst of both.
    // A crash loop is bounded by the delay, and each restart re-enters the enclave and reloads
    // the apps from the leases this box still holds (host.tick).
    if (!stopping && (name === 'host' || name === 'worker')) {
      setTimeout(() => {
        if (children[name] || stopping) return;
        log(`restarting ${name}`);
        try { start[name] && start[name](); } catch (e) { log(`restart ${name} failed: ${e.message}`); }
      }, 5000);
    }
  });
  children[name] = p; return p;
}
const waitPort = (port, ms = 120_000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(); }); s.once('error', () => { s.destroy(); if (Date.now() - t0 > ms) rej(new Error(`port ${port} never opened`)); else setTimeout(tick, 500); }); };
  tick();
});
async function startWorker() {
  if (process.env.WORKER_EXE === 'none') return;
  start.worker = () => run('worker', WORKER_EXE, ['--port', String(WORKER_PORT), '--vram-gb', WORKER_VRAM_GB, '--quiet'],
      { SHIELDED_VK_SHADERS: process.env.SHIELDED_VK_SHADERS || path.join(path.dirname(WORKER_EXE), 'shaders'), SHIELDED_CARD_TFLOPS: process.env.SHIELDED_CARD_TFLOPS || '8' });
  start.worker();
  await waitPort(WORKER_PORT); log(`worker up on ${WORKER_PORT}`);
  // Ask the card what it is, then keep asking: the free figure moves as links reserve and release,
  // and on a desktop it also moves when the owner starts something of their own.
  await readCard();
  if (card) log(`shielded card: ${card.device}, ${card.vramFreeGb}/${card.vramBudgetGb} GB free, ${card.gmacPerSec || '?'} G-MAC/s, protocol ${card.protocol}`);
  setInterval(() => { readCard().catch(() => {}); }, 30_000);
  // Keep trying to measure what the engine holds of the enclave. Until it answers the box admits
  // no new app, so a single failed probe must not idle the box for its whole life.
  setInterval(() => { measureEngineHold().catch(() => {}); }, 30_000);
  // The proof, once, in the background: it runs a real masked GEMM on the card and must not hold
  // up the box coming online. A failure leaves the verdict absent, which is the honest state.
  shieldedProof({ probe: PROBE, port: WORKER_PORT }).then((p) => {
    cardProof = p;
    log(`shielded proof: ${p.ok ? 'PASSED' : 'FAILED'} (exact ${p.exact}, verified ${p.verified}, lie rejected ${p.lieRejected},`
      + ` no plaintext ${p.noPlaintext}, denylist refused ${p.denylistRefused}, ${p.roundTripMs} ms round trip)`);
  }).catch((e) => log(`shielded proof did not run: ${e.message.slice(0, 120)}`));
}
async function startHost() {
  const args = ['--enclave', ENCLAVE_DLL, '--model', MODEL, '--env', 'SHIELDED_HOST=127.0.0.1', '--env', `SHIELDED_PORT=${WORKER_PORT}`,
                '--threads', THREADS, '--ctx', CTX, '--serve', String(HOST_PORT), '--quiet', '--log', path.join(DIR, 'enclave.log')];
  if (CALIB) args.push('--calib', CALIB);
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('SHIELDED_') && !['SHIELDED_HOST', 'SHIELDED_PORT', 'SHIELDED_VK_SHADERS', 'SHIELDED_CARD_TFLOPS', 'SHIELDED_VK_DEVICE'].includes(k)) args.push('--env', `${k}=${v}`);
  // The app runtime's own socket tracing, if the operator asked for it. It is a LEVEL: 1 is the
  // connection lifecycle (accept, close, errors) and is cheap enough to leave on; 2 adds a line
  // per read and per write, which on a streaming tenant is a line per datagram - it wrote 17 MiB
  // into enclave.log in under an hour here and buried the lifecycle events it exists to show.
  // Turn 2 on for a bug you are chasing, not for a deployment you are running.
  if (process.env.ENCLAVE_RT_TRACE) args.push('--env', `ENCLAVE_RT_TRACE=${process.env.ENCLAVE_RT_TRACE}`);
  start.host = () => {
    // A restarted enclave is a NEW enclave: its keys are per boot and every app that was in it is
    // gone. The apps come back on the next tick from the leases this box still holds; the keys are
    // re-attested on the next tunnel handshake, which is what the relay's row already expects.
    run('host', HOST_EXE, args, {});
    waitPort(HOST_PORT, 600_000).then(() => {
      log(`enclave host up on ${HOST_PORT}`);
      if (host && host.cfg && host.cfg.appsEnabled) { host.apps.clear(); }   // they died with it
    }).catch((e) => log(`enclave host did not come up: ${e.message}`));
  };
  start.host();
  await waitPort(HOST_PORT, 600_000); log(`enclave host up on ${HOST_PORT}`);
}
// one line in, one line out, serialized
let hostQueue = Promise.resolve();
function hostCmd(line) {
  const job = () => new Promise((res, rej) => {
    const s = net.connect(HOST_PORT, '127.0.0.1'); let buf = '';
    s.setTimeout(600_000, () => { s.destroy(); rej(new Error('host timeout')); });
    s.once('connect', () => s.write(line + '\n'));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); const r = buf.slice(0, i); r.startsWith('ok') ? res(r.slice(3).trim()) : rej(new Error(r)); } });
    s.once('error', rej);
  });
  return (hostQueue = hostQueue.then(job, job));
}
// ---- the TPM tool ---------------------------------------------------------------------------
let tpm = null, tpmBuf = '', tpmWaiters = [], tpmReady = null;
function startTpm() {
  tpm = spawn(TPMATTEST_EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  tpm.stderr.on('data', (d) => process.stderr.write(`[tpm] ${d}`));
  tpm.stdout.on('data', (d) => {
    tpmBuf += d; let i;
    while ((i = tpmBuf.indexOf('\n')) >= 0) {
      const line = tpmBuf.slice(0, i).replace(/\r$/, ''); tpmBuf = tpmBuf.slice(i + 1);
      if (line.startsWith('ready ')) { log(`tpm: ${line}`); tpmReady?.res(); continue; }   // the banner has no terminator
      const w = tpmWaiters[0];
      if (!w) { log(`tpm: ${line}`); continue; }
      if (line === 'ok' || line.startsWith('err ')) { tpmWaiters.shift(); line === 'ok' ? w.res(w.lines) : w.rej(new Error(line)); }
      else { const sp = line.indexOf(' '); if (sp > 0) w.lines[line.slice(0, sp)] = line.slice(sp + 1); }
    }
  });
  tpm.on('exit', (c) => { log(`tpm exited (${c})`); tpm = null; tpmReady?.rej(new Error('tpm tool exited')); });
  // A tool that cannot start (missing, not executable) is "attestation unavailable", not a crash of the agent.
  tpm.on('error', (e) => { log(`tpm tool did not start: ${e.message}`); tpm = null; tpmReady?.rej(e); });
  return new Promise((res, rej) => { tpmReady = { res, rej }; setTimeout(() => rej(new Error('tpm tool did not report ready')), 30_000); });
}
function tpmCmd(cmd) { return new Promise((res, rej) => { if (!tpm) return rej(new Error('tpm tool not running')); tpmWaiters.push({ lines: {}, res, rej }); tpm.stdin.write(cmd + '\n'); }); }

// ---- evidence -------------------------------------------------------------------------------
const hex = (b) => Buffer.from(b).toString('hex'), b64 = (b) => Buffer.from(b).toString('base64');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DOMAIN = Buffer.from('enclave-vbs-bind-v1\n');
async function platformInfo() {
  const out = { osBuild: os.release(), hostname: os.hostname(), cpus: os.cpus().length, ramGb: Math.round(os.totalmem() / 2 ** 30) };
  try { const r = fs.readFileSync(path.join(DIR, 'platform.json'), 'utf8'); Object.assign(out, JSON.parse(r)); } catch {}
  return out;
}
// step 3: the TPM's keys, sent before the credential comes back
async function keysFrame() {
  const k = await tpmCmd('keys');
  return { t: 'vbs-keys', ek: b64(Buffer.from(k['ek-cert'], 'hex')), ekChain: [], aikPub: b64(Buffer.from(k['aik-pub'], 'hex')), aikName: b64(Buffer.from(k['aik-name'], 'hex')) };
}
// step 5-6: transcript, enclave report, credential activation, quote, log
async function attestFrame(nonceB64, credentialBlobB64, secretB64) {
  const nonce = Buffer.from(nonceB64, 'base64'); if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const [signPk, boxPk] = (await hostCmd('keys')).split(' ').map((h) => Buffer.from(h, 'hex'));
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, signPk]);
  const bound = Buffer.concat([DOMAIN, spki, boxPk, nonce]);
  const att = (await hostCmd(`attest ${hex(bound)}`)).split(' ');                     // challenge signature report
  const challenge = Buffer.from(att[0], 'hex'), signature = Buffer.from(att[1], 'hex'), report = Buffer.from(att[2], 'hex');
  if (!challenge.equals(createHash('sha256').update(bound).digest())) throw new Error('enclave challenge mismatch');
  const act = await tpmCmd(`activate ${hex(Buffer.from(credentialBlobB64, 'base64'))} ${hex(Buffer.from(secretB64, 'base64'))}`);
  const q = await tpmCmd(`quote ${hex(challenge)}`);
  const pcr0 = String((await tpmCmd('pcr 0')).pcr || '').split(' ').pop() || '';   // the reply line is "pcr 0 <hex>"
  const logPath = (await tpmCmd('log')).log;
  const bootLog = fs.readFileSync(logPath);
  const evidence = {
    report: b64(report), signature: b64(signature), log: b64(bootLog),
    quote: { attest: b64(Buffer.from(q.attest, 'hex')), sig: b64(Buffer.from(q.sig, 'hex')), aikPub: b64(Buffer.from(q['aik-pub'], 'hex')) },
    credential: b64(Buffer.from(act.credential, 'hex')),
    ek: { cert: b64(Buffer.from((await tpmCmd('keys'))['ek-cert'], 'hex')), chain: [] },
    pcr0, platform: await platformInfo(),
  };
  return { frame: { t: 'attest', rad: { format: 'windows-vbs-enclave/v1', transportKey: b64(spki), padKey: hex(boxPk), body: b64(Buffer.from(JSON.stringify(evidence))) } }, spki, boxPk };
}
// Once the name is REGISTERED on chain the hub demands this: a personal_sign of
// "enclave-tunnel-attach:<name>:<nonce>" recovering to the registry entry's operator, so a box
// running the same enclave build cannot take a registered seller's name while it is down
// (relay/tunnel.js). The key is the box's own operator key, the same one that registered it.
// The isolation manager's health, carried in windows-hv-node/v1 as a host STATEMENT (never raised, never weighed).
async function isolationHealth() {
  if (!host.cfg.isolationManager) return null;
  try {
    const { IsolationManagerClient } = await import('./isolation-client.mjs');
    return await new IsolationManagerClient({ base: host.cfg.isolationManager }).health();
  } catch (e) { log(`isolation manager health unavailable: ${e.message}`); return null; }
}
async function operatorSig(nonceB64) {
  try {
    const { loadOperator } = await import('./chain.mjs');
    const acct = loadOperator(path.join(DIR, 'operator.key'));
    if (!acct) return null;
    return await acct.signMessage({ message: `enclave-tunnel-attach:${NAME}:${nonceB64}` });
  } catch (e) { log(`operator signature unavailable: ${e.message}`); return null; }
}

/**
 * Ask the enclave what the engine holds of it, and keep asking until it answers.
 *
 * The first reading is the honest one - taken before any app is claimed, so it is the model, its
 * KV cache and the pads alone. Once taken it is kept: later readings would include tenants' apps
 * and would shrink the pool by charging their memory twice.
 *
 * Until it succeeds the box admits NO NEW WORK (host.capacity refuses on an unmeasured engine),
 * so this retries on the tick rather than leaving a box that failed one probe permanently idle.
 */
async function measureEngineHold() {
  // Only the retired engine has a hold to measure; on the isolated path capacity never waits on it (enclave-d1 F1).
  if (!LEGACY_ENGINE || !APPS || host.cfg.engineHeldMb !== null) return;
  try {
    const [privB] = String(await hostCmd('mem')).trim().split(/\s+/).map(Number);
    if (!(privB > 0)) throw new Error(`the enclave reported ${privB} bytes`);
    host.cfg.engineHeldMb = Math.ceil(privB / (1024 * 1024));
    log(`enclave memory: the engine holds ${host.cfg.engineHeldMb} MB of ${host.cfg.enclaveGb} GB`
      + `; ${host.capacity().ramMbFree} MB is free for apps`);
  } catch (e) {
    log(`enclave memory unreadable (${e.message}): this box will take no NEW app until it can measure`
      + ` what its engine holds; retrying`);
  }
}

// ---- the public surface over the tunnel ------------------------------------------------------
async function handle(frame) {
  const p = String(frame.path || '').split('?')[0]; const method = frame.method || 'GET';
  const json = (status, o) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  if (p === '/availability') return json(200, { ok: true, role: LEGACY_ENGINE ? 'windows-vbs-node' : 'windows-hv-node', name: NAME,
    // gpu:false stays false, and it is not a statement about whether the card is for sale: on this
    // fleet that flag means the card is INSIDE the measured enclave, and this one is not. It sits
    // on the untrusted Windows host and the enclave uses it by masked offload. The card's facts,
    // including the share that is free, ride in `shielded` and `gpuShareFree` below, which is
    // where the fleet row reads a shielded box. Saying true would also make this box the relay's
    // sticky pick for /v1/auth and /v1/pricing, which it does not serve.
    //
    // gpuShareFree IS now real: this box sells shares of its card (what one buys is the model in
    // the enclave, reached from an app through the enclave:app world's generate), and the figure
    // is the smaller of what it has left to sell and what the worker says is free on the silicon.
    gpu: false, maxShare: host.cpuShareFree(),
    gpuShareFree: APPS ? host.gpuShareFree() : 0, cpuShareFree: host.cpuShareFree(),
    nodeVcpus: Number(process.env.NODE_VCPUS || os.cpus().length),
    // RAM, and the honest number here is NOT the machine's. An app on this box runs inside the
    // enclave, so the pool is the ENCLAVE - a fixed, dedicated allocation made when it was created
    // (ee-main.cpp EnclaveSize), not a slice of the machine's 112 GB and not a fraction of the
    // share ledger. What is left of it rides beside this as ramGbFree, measured: the enclave's own
    // size less what the engine holds (asked of the enclave before any app was claimed) and less
    // what each running app was promised. The machine's own figure is machineRamGb.
    nodeRamGb: host.appsInTee()
      ? Number(host.cfg.enclaveGb) || 0
      : Number(process.env.NODE_RAM_GB || Math.round(os.totalmem() / 2 ** 30)),
    machineRamGb: Number(process.env.NODE_RAM_GB || Math.round(os.totalmem() / 2 ** 30)),
    nodeGflops: Math.round(62.5 * Number(process.env.NODE_VCPUS || os.cpus().length)),   // the fleet's convention (metal gsup.mjs)
    // teeCpu names a CPU TEE this box's own attestation shows. An isolation-only node has none: its attach is a
    // host-attested boot state (windows-hv-node/v1), so it says null rather than the retired engine's name.
    teeCpu: LEGACY_ENGINE ? 'windows-vbs-enclave' : null, tier: tier || null,
    // THE CARD, as the worker itself reports it (shieldedcard.mjs), refreshed on a timer. The
    // fallback is what this box knows without asking - a worker that is down must not leave the
    // row advertising a card nobody can use.
    // An isolation-only node starts no worker, so it advertises no card at all.
    shielded: !LEGACY_ENGINE ? null : (card ? { ...card, ...(cardProof ? { proof: cardProof } : {}) } : null) || { worker: 'vulkan', protocol: '1.4.0', vramGiB: Number(WORKER_VRAM_GB), vramGb: Number(WORKER_VRAM_GB),
                        vramBudgetGb: Number(WORKER_VRAM_GB), vramFreeGb: 0, vramReservedGb: 0,
                        ...(gpuName ? { device: gpuName } : {}), note: 'the worker has not answered a HELLO yet' },
    model: MODEL ? path.basename(MODEL) : null, attachedAt, ...(APPS ? host.availability() : {}) });
  // ---- who is asking ---------------------------------------------------------------------
  // The public half of this box's session key. Anyone can verify a token it minted - and confirm
  // the operator did not mint it - holding no secret. On a confidential VM that last part is a
  // guarantee; here the key is in VTL0 and /availability says so, which is the same bar this box
  // already publishes for app traffic.
  if (p === '/v1/session-jwks') return json(200, { keys: sessionKey ? [sessionKey.jwk] : [] });
  if (p === '/v1/auth/nonce' && method === 'GET') {
    const q = new URL('http://x' + String(frame.path || '/')).searchParams;
    const address = String(q.get('address') || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return json(422, { error: 'invalid_address', message: 'Provide a valid ?address.' });
    // The nonce is issued WITH the challenge it belongs to, and login requires that exact message
    // back: every field in it is then required and exactly ours, without parsing any of them.
    const nonce = nonces.issue(address);
    const m = siweMessage({ address, nonce, domain: SIWE_DOMAIN, uri: SIWE_URI, chainId: SIWE_CHAIN_ID });
    nonces.bind(nonce, m.message);
    return json(200, m);
  }
  if (p === '/v1/auth/login' && method === 'POST') {
    if (!sessionKey) return json(503, { error: 'no_session_key', message: 'This box mints no sessions.' });
    let b = {}; try { b = JSON.parse(Buffer.from(frame.body || '', 'base64').toString('utf8')); } catch {}
    const { verifyMessage } = await import('viem');
    const r = await verifyLogin({ message: b.message, signature: b.signature, nonces,
                                  domain: SIWE_DOMAIN, uri: SIWE_URI, chainId: SIWE_CHAIN_ID, verifyMessage });
    if (r.error) return json(401, { error: r.error, message: r.message });
    return json(200, { token: mintSession(sessionKey, { subject: r.address, ttlSec: SESSION_TTL }),
                       address: r.address, expiresIn: SESSION_TTL, kid: sessionKey.kid });
  }
  if (p === '/v1/health') return json(200, { ok: true, role: LEGACY_ENGINE ? 'windows-vbs-node' : 'windows-hv-node', engine: LEGACY_ENGINE ? 'legacy' : 'retired',
                                             name: NAME, host: !!children.host, worker: !!children.worker, tpm: !!tpm });
  if (p === '/v1/completions' && method === 'POST') {
    if (!LEGACY_ENGINE) return json(503, { error: 'unavailable', reason: NO_ENGINE });
    let body = {}; try { body = JSON.parse(Buffer.from(frame.body || '', 'base64').toString('utf8')); } catch { return json(400, { error: 'bad json' }); }
    const prompt = String(body.prompt || ''); const n = Math.max(1, Math.min(512, Number(body.max_tokens || 16)));
    if (!prompt) return json(400, { error: 'prompt required' });
    try {
      const r = (await hostCmd(`gen ${n} ${hex(Buffer.from(prompt, 'utf8'))}`)).split(' ');
      const text = Buffer.from(r[0], 'hex').toString('utf8');
      return json(200, { id: `cmpl-${Date.now()}`, object: 'text_completion', model: path.basename(MODEL), choices: [{ index: 0, text, finish_reason: 'length' }],
                         usage: { completion_tokens: Number(r[1]) }, timing: { prompt_us: Number(r[2]), decode_us: Number(r[3]) }, shielded: { offloaded: Number(r[4]), local: Number(r[5]), macs: Number(r[6]), verify_fail: Number(r[7]) } });
    } catch (e) { return json(500, { error: e.message }); }
  }
  if (APPS && p === '/v1/deployments') return json(200, { deployments: host.deployments() });
  if (APPS && /^\/v1\/deployments\/0x[0-9a-fA-F]{64}$/.test(p)) {
    const id = p.split('/').pop().toLowerCase();
    const r = host.deployments().find((d) => d.id === id);
    return r ? json(200, r) : json(404, { error: 'not_found', id });
  }
  if (APPS && /^\/v1\/deployments\/0x[0-9a-fA-F]{64}\/logs$/.test(p)) {
    const id = p.split('/')[3].toLowerCase();
    const app = host.apps.get(id);
    return app ? json(200, { id, lines: app.logs(200) }) : json(404, { error: 'not_found', id });
  }
  if (APPS && method === 'POST' && /^\/v1\/deployments\/0x[0-9a-fA-F]{64}\/restart$/.test(p)) {
    const id = p.split('/')[3].toLowerCase();
    let d; try { d = await (await import('./chain.mjs')).readDeployment(id); } catch (e) { return json(502, { error: 'chain', message: e.message }); }
    const r = await host.ensureApp(id, d, { force: true });
    return json(200, r);
  }
  // The platform's own "come and claim this" nudge (the relay sends it after funding, the console
  // when a row reads queued). The policy in chain.mjs decides; a refusal names its reason.
  if (APPS && method === 'POST' && p === '/v1/claim-hint') {
    let b = {}; try { b = JSON.parse(Buffer.from(frame.body || '', 'base64').toString('utf8')); } catch {}
    // A hint that NAMES this box is the deploy console's target pick: the relay sends it only
    // here (api-relay.js /v1/claim-hint), so it is the buyer choosing this enclave, which is the
    // consent chain.claimPolicy looks for before taking an older deployment onto a box whose apps
    // run outside the TEE. A blanket fan-out hint carries no name and grants nothing.
    const invited = String(b.enclave || '').trim().toLowerCase() === NAME;
    const r = await host.consider(b.id, { force: b.force === true, invited });
    return json(r.accepted ? 200 : 409, r);
  }
  // The relay asks HEAD /x/<id> of every box to find which one owns a deployment: any status
  // other than 404 means "here". It must be answered BEFORE the app is consulted, or a box that
  // holds the lease while its app is still starting disowns it (api-relay.js xOwnerOf).
  if (APPS && method === 'HEAD' && /^\/x\/0x[0-9a-fA-F]{64}\/?$/.test(p)) {
    const id = p.split('/')[2].toLowerCase();
    return host.records.has(id) ? { status: 204, headers: {}, body: '' } : json(404, { error: 'not_found', id });
  }
  if (APPS && /^\/x\/0x[0-9a-fA-F]{64}(\/|$)/.test(p)) {
    const id = p.split('/')[2].toLowerCase();
    const rest = p.slice(('/x/' + id).length) || '/';
    // The caller's address, as the relay forwarded it. It is what the deployment's rate and
    // concurrency limits count, so it is passed explicitly rather than guessed at the far end.
    // The private-deployment check is NOT here. It lives in host.proxy, which is the one place
    // every HTTP serving path funnels through - this one and the app zone's own hostname. It was
    // here, and only here, which left a private app reachable anonymously on its own hostname.
    const ip = wafClientIp(frame.headers);
    // WAF_TRACE=1: say which address a deployment's rate and concurrency limits are counting. It
    // exists because "the relay forwards the caller's address" is a claim this box PUBLISHES
    // (host.features), and a claim about whose bucket a request lands in should be checkable on
    // the box rather than inferred from the relay's source.
    if (WAF_TRACE) log(`[waf] ${id.slice(0, 10)} ${method} ${rest} from ${ip}`
      + ` (x-forwarded-for: ${frame.headers?.['x-forwarded-for'] ?? 'absent'})`);
    const r = await host.proxy(id, { method, pathRest: rest + (String(frame.path || '').includes('?') ? '?' + String(frame.path).split('?')[1] : ''),
                                     headers: frame.headers, body: frame.body ? Buffer.from(frame.body, 'base64') : null,
                                     ip });
    return { status: r.status, headers: r.headers, body: Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.body };
  }
  if (!LEGACY_ENGINE && (p === '/v1/session/keys' || p === '/v1/session')) return json(503, { error: 'unavailable', reason: NO_ENGINE });
  if (p === '/v1/session/keys') { const [signPk, boxPk] = (await hostCmd('keys')).split(' '); return json(200, { transportKey: b64(Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signPk, 'hex')])), padKey: boxPk, note: 'verify these against the attested tunnel row, not against this answer' }); }
  if (p === '/v1/session' && method === 'POST') {           // opaque bytes in, opaque bytes out: sealed to the enclave's attested pad key
    const blob = Buffer.from(frame.body || '', 'base64'); if (blob.length < 76) return json(400, { error: 'blob too short' });
    try { const r = (await hostCmd(`session ${hex(blob)}`)).split(' ');
          return json(200, { blob: Buffer.from(r[0], 'hex').toString('base64'), usage: { completion_tokens: Number(r[1]) }, timing: { prompt_us: Number(r[2]), decode_us: Number(r[3]) }, shielded: { offloaded: Number(r[4]), local: Number(r[5]), macs: Number(r[6]), verify_fail: Number(r[7]) } }); }
    catch (e) { return json(500, { error: e.message }); }
  }
  return json(404, { error: 'not_found' });
}

// ---- the tunnel ----------------------------------------------------------------------------
function connect() {
  let ws, pending = null;   // pending: { nonce } between challenge and attest-result
  const dial = () => {
    log(`dialing ${RELAY_URL} as ${NAME}`);
    // maxPayload: an explicit ceiling on one tunnel frame. `ws` defaults to 100 MB, which is a
    // lot of agent memory to hand a single message, and every frame this tunnel legitimately
    // carries is one request or one response - already bounded by the same knob at the app.
    ws = new WebSocket(RELAY_URL, { headers: { 'x-metal-name': NAME, 'x-metal-attest': '1' }, family: 4,
                                    maxPayload: Math.round((Number(process.env.ENCLAVE_APP_MAX_BODY_MB) || 64) * 1048576 * 1.4) });
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    tunnelSend = send;
    tunnelBuffered = () => { try { return ws.bufferedAmount || 0; } catch { return 0; } };
    let last = Date.now(); const live = setInterval(() => { if (Date.now() - last > 90_000) { log('tunnel silent for 90s, redialing'); try { ws.terminate(); } catch {} } }, 15_000);
    ws.on('open', () => { last = Date.now(); log('tunnel open, waiting for the challenge'); });
    ws.on('message', async (data) => {
      last = Date.now(); let f; try { f = JSON.parse(data); } catch { return; }
      try {
        if (f.t === 'challenge') { pending = { nonce: f.nonce }; send(await keysFrame()); log('sent TPM keys'); }
        else if (f.t === 'vbs-credential') {
          if (!pending) return;
          if (LEGACY_ENGINE) {
            const { frame, spki } = await attestFrame(pending.nonce, f.credentialBlob, f.secret);
            spkiFp = createHash('sha256').update(spki).digest('hex');
            const sig = await operatorSig(pending.nonce); if (sig) frame.operatorSig = sig;
            send(frame); log('sent evidence (report, quote, credential, log)');
          } else {
            // windows-hv-node/v1: the TPM's quote over this node's own key and the relay's nonce. It refuses
            // (throws) on a boot state the relay would refuse, and never sends an enclave-format frame.
            const frame = await buildHvNodeFrame({ nonce: Buffer.from(pending.nonce, 'base64'),
              credentialBlob: Buffer.from(f.credentialBlob, 'base64'), secret: Buffer.from(f.secret, 'base64'),
              spki: nodeKey.spki, privateKey: nodeKey.privateKey, tpm: tpmCmd,
              managerHealth: await isolationHealth(), platform: await platformInfo() });
            spkiFp = createHash('sha256').update(nodeKey.spki).digest('hex');
            const sig = await operatorSig(pending.nonce); if (sig) frame.operatorSig = sig;
            send(frame); log(`sent ${HV_NODE_FORMAT} evidence (quote, credential, log, signed binding)`);
          }
        } else if (f.t === 'attest-result') {
          if (f.ok) { tier = f.tier || '';   // the relay's verdict (vbs | vbs-dev); never our own claim
                      host.relayTier = tier;   // the host's contract gate reads the relay's verdict, not ours
                      attachedAt = Date.now(); log(`attach ACCEPTED tier=${tier} measurement=${String(f.measurement || '').slice(0, 16)}`); send({ t: 'hello', name: NAME, mode: LEGACY_ENGINE ? 'vbs' : 'hv-node', publicUrl: PUBLIC_URL, transportKeyFp: spkiFp }); }
          else log(`attach REJECTED: ${f.reason}`);
        } else if (f.t === 'ping') send({ t: 'pong' });
        else if (f.t === 'req') { const r = await handle(f); send({ t: 'res', id: f.id, status: r.status, headers: r.headers, body: Buffer.from(r.body).toString('base64') }); }
        // The app's OWN origin arrives as a raw stream with the WebSocket upgrade replayed into
        // it (relay/tunnel.js spliceUpgrade -> relay/relay.js splice). appzone.mjs answers the
        // handshake with this deployment's certificate and proxies the plaintext to its port.
        else if (f.t === 's+' || f.t === 'sd' || f.t === 'sx') {
          if (!zone) send({ t: 's=', sid: f.sid, ok: false, err: 'this node is not hosting apps (APPS=1)' });
          else zone.onFrame(f);
        }
      } catch (e) { log(`frame ${f.t} failed: ${e.message}`); if (f.t === 'challenge' || f.t === 'vbs-credential') send({ t: 'attest', rad: { format: LEGACY_ENGINE ? 'windows-vbs-enclave/v1' : HV_NODE_FORMAT, body: '', refused: e.message } }); }
    });
    ws.on('unexpected-response', (_r, res) => { log(`handshake rejected: HTTP ${res.statusCode}`); try { ws.terminate(); } catch {} });
    ws.on('close', () => {
      if (zone) zone.closeAll(); clearInterval(live); attachedAt = 0; log('tunnel closed'); setTimeout(dial, 5000); });
    ws.on('error', (e) => { log(`tunnel error: ${e.message}`); try { ws.terminate(); } catch {} });
  };
  dial();
}

// LOCAL_HTTP_PORT: the same surface the tunnel serves, on loopback, for tests without a relay
function localHttp(port) {
  const http = requireHttp();
  http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const p = String(req.url || '').split('?')[0];
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    // OPERATOR ROUTES, loopback only. handle() serves the tunnel and never sees these, so nothing
    // on the relay can run an app on this box: only somebody already on the machine.
    if (APPS && req.method === 'POST' && p === '/v1/host/run') {
      let b = {}; try { b = JSON.parse(body.toString('utf8')); } catch {}
      try { return json(200, await host.runUnleased(b)); } catch (e) { return json(400, { error: e.message }); }
    }
    if (APPS && req.method === 'POST' && p === '/v1/host/stop') {
      let b = {}; try { b = JSON.parse(body.toString('utf8')); } catch {}
      const app = host.apps.get(String(b.id || '').toLowerCase());
      if (!app) return json(404, { error: 'not_running', id: b.id });
      await app.stop(); host.apps.delete(String(b.id).toLowerCase());
      return json(200, { id: b.id, stopped: true });
    }
    if (APPS && p === '/v1/host/state') return json(200, { deployments: host.deployments(), availability: host.availability() });
    const r = await handle({ path: req.url, method: req.method, headers: req.headers, body: body.toString('base64') });
    res.writeHead(r.status, r.headers); res.end(r.body);
  }).listen(port, '127.0.0.1', () => log(`local http on 127.0.0.1:${port}`));
}
function requireHttp() { return createRequire(import.meta.url)('node:http'); }
(async () => {
  if (LEGACY_ENGINE) { await startWorker(); await startHost(); }
  else {
    nodeKey = loadOrCreateNodeKey(DIR);
    log(`isolation-only node: the VBS enclave engine is retired; transport key ${createHash('sha256').update(nodeKey.spki).digest('hex').slice(0, 16)}… `
      + '(a host key: it proves only that an admin-level process on this host chose it)');
  }
  await startTpm().catch((e) => log(`tpm: ${e.message} (attestation unavailable)`));
  const k = await tpmCmd('keys').catch((e) => { log(`tpm keys failed: ${e.message}`); return null; });
  if (k) log(`TPM ready: AIK name ${k['aik-name'].slice(0, 16)}…, EK cert ${k['ek-cert'].length / 2} bytes (${k['ek-cert-source']})`);
  if (LEGACY_ENGINE) {
  const hk = await hostCmd('keys'); log(`enclave keys: transport ${hk.slice(0, 16)}…`);
  // Does the loaded enclave image carry an app runtime? The enclave answers, not a config file:
  // this is what decides whether the box hosts a tenant's app INSIDE the enclave, and therefore
  // whether it sells app hosting at all (host.mjs appsInTee).
  try {
    // Parsed by appframe.parseAbiReply, which is the tested article: both directions of version
    // mismatch fail closed there (an older enclave's two-word reply means no features at all).
    const { abi, worlds, features } = parseAbiReply(await hostCmd('appabi'));
    host.cfg.enclaveAppAbi = abi; host.cfg.enclaveAppWorlds = worlds;
    host.cfg.enclaveAppFeatures = features;
    const names = [worlds & 1 ? 'enclave:app@0.1.0' : null, worlds & 2 ? 'wasi:http@0.2' : null,
                   worlds & 4 ? 'wasi:cli@0.2' : null].filter(Boolean);
    // WHAT THE ENGINE HOLDS OF THE ENCLAVE, measured here: this is the one moment the enclave
    // contains the model, its KV cache and the pads and NOTHING ELSE, because no app has been
    // claimed yet. Everything left of the enclave's fixed size is what the box may promise a
    // tenant, so this reading is what makes the RAM pool a real figure instead of a fraction of
    // the share ledger.
    await measureEngineHold();
    log(abi >= 1
      ? `app runtime in the enclave: abi ${abi}, worlds ${names.join(' + ')}`
        + `${host.cfg.enclaveAppFeatures ? ', features ' + [[1,'mem64'],[2,'set'],[4,'p3'],[8,'threads']]
              .filter(([b]) => host.cfg.enclaveAppFeatures & b).map(([, n]) => n).join(' + ') : ''}, `
        + `${host.cfg.enclaveGb} GB enclave, engine holds ${host.cfg.engineHeldMb ?? '?'} MB, `
        + `${host.capacity().ramMbFree} MB for apps`
      : 'no app runtime in this enclave image: this box sells no app hosting');
  } catch (e) { log(`app runtime check failed: ${e.message}`); }
  }
  if (APPS) {
    // The session key, before anything can be asked for one. Where it lives is published rather
    // than implied (host.features sessionKeyIn): on a confidential VM the operator never sees the
    // private half, and on this box they do.
    sessionKey = initSessionKey({ dir: DIR, log: (m) => log(m) });
    host.cfg.sessionKid = sessionKey.kid;
    log(`session: ES256 key ${sessionKey.kid.slice(0, 12)}… (in the agent's process, not the enclave)`);
    setInterval(() => nonces.sweep(), 60_000).unref?.();
    await host.init();
    // resolve(id): the app's loopback port and its certificate, or null. Both come from the host,
    // which is the half that holds leases; a deployment this box does not serve resolves to null
    // and the stream is refused with a status rather than a silent close.
    // The splicer for ISOLATED deployments, built only when this box is configured for that
    // backend. Null otherwise, and the app zone then has nothing to splice with and says so
    // rather than terminating TLS for a partition, which it must never do.
    let isolationSplicer = null;
    if (host.cfg.isolationManager && host.cfg.isolationDataAddr) {
      const { createIsolationSplicer } = await import("../vbslike/datapath/node-bridge.mjs");
      const { IsolationManagerClient } = await import("./isolation-client.mjs");
      isolationSplicer = createIsolationSplicer({
        client: new IsolationManagerClient({ base: host.cfg.isolationManager }),
        dataAddr: host.cfg.isolationDataAddr,
        log: (m) => log(m),
      });
    }
    zone = appZone({
      isolationSplicer,
      send: (o) => tunnelSend(o),
      resolve: (id) => host.appZoneTarget(id),
      // What the tunnel socket is still holding, so a streaming response applies backpressure
      // rather than filling this process's memory.
      pressure: () => tunnelBuffered(),
      // A gate-served app (wasi:http, enclave:app) has no socket: its own hostname is served by
      // terminating TLS here and carrying the request through the gate, the same frame the /x/
      // path uses.
      serveHttp: (id, req) => host.proxy(id, req),
      // The operator's ceiling on a single request body held in the agent's memory for an app
      // served on its own port. A gate-served app has a tighter one that the enclave itself
      // imposes (its request staging buffer), and a deployment's own maxBodyMb narrows either.
      maxBodyBytes: Math.round((Number(process.env.ENCLAVE_APP_MAX_BODY_MB) || 64) * 1048576),
      log: (m) => log(`[app-zone] ${m}`),
    });
    try {
      const { loadOperator } = await import('./chain.mjs');
      const acct = loadOperator(path.join(DIR, 'operator.key'));
      if (acct) host.cfg.secretsSign = async (message) => acct.signMessage({ message });
    } catch (e) { log(`secrets signer unavailable: ${e.message}`); }
  }
  if (process.env.LOCAL_HTTP_PORT) localHttp(Number(process.env.LOCAL_HTTP_PORT));
  if (process.env.RELAY_URL !== 'none') connect(); else log('RELAY_URL=none: local only');
})().catch((e) => { console.error(e); process.exit(1); });
process.on('SIGINT', () => { for (const c of Object.values(children)) c?.kill(); tpm?.kill(); process.exit(0); });
