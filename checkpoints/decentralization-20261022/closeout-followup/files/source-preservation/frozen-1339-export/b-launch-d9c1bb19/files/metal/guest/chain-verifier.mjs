// The host operator's explicit opt-in to the LOCAL Base chain verifier inside this guest (network/rpc-runtime.mjs: native
// gossip head -> verified roots -> proof-aware witness gateway -> Helios on 127.0.0.1), and what it changes: the
// supervisor's verified readers (host wallet admission, the platform host policy gate: network/lease-reader.mjs
// chainAuthorityFromEnv) read through that loopback endpoint instead of the provider quorum.
// Dependency-free on purpose: the host launcher (metal/enclave-metal.mjs) and the guest (gsup.mjs) check the operator's
// config with this ONE checker; the runtime checks its own config a third time.
//
//   { "format": "enclave-chain-verifier/v1",
//     "unsafeSigner": "0x…",                       the administrator's pin of the Base sequencer key
//     "proofSources": ["https://…", …],            1..16 EXPLICIT, untrusted state holders (every witness is verified)
//     "port": 50546,                               the verifier's loopback port inside the guest: 50000..57999
//     "gossip"?: { "maxPeers", "discovery", "sessionSecs" }, "limits"?: { "firstHeadTimeoutMs", "heliosReadyTimeoutMs" } }
//
// Absent: nothing changes (the supervisor's names are not set; its readers keep the provider quorum, exactly as before).
// Present and valid: gsup starts the runtime BEFORE the supervisor and gives the supervisor exactly two names
// (ENCLAVE_CHAIN_AUTHORITY=verifier, ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:<port>/), which no other channel may supply.
// Until the runtime is ready - and whenever its proof sources cannot supply a fresh witness - those readers REFUSE (their
// callers hold or refuse work); booting is not verified readiness, and there is no provider fallback.
// Present but invalid, or an image without the verifier: the supervisor still gets the verifier authority, at a loopback
// URL nothing serves, so every verified read refuses; it never silently falls back to the provider quorum.
// Not offered here: the S3/Sia witness archive (the guest base image has no curl with --aws-sigv4) and a local disk cache
// (no reviewed budget kind); the runtime itself supports the archive where curl exists.
import fs from 'node:fs';
import path from 'node:path';

export const CHAIN_VERIFIER_FORMAT = 'enclave-chain-verifier/v1';
export const CHAIN_VERIFIER_IMAGE_FORMAT = 'enclave-chain-verifier-image/v1';
export const CHAIN_VERIFIER_IMAGE_FILE = '/opt/rpc-runtime/IMAGE.json';
export const CHAIN_AUTHORITY_NAMES = Object.freeze(['ENCLAVE_CHAIN_AUTHORITY', 'ENCLAVE_CHAIN_VERIFIER']);
// the guest's own listeners (supervisor 8080, wasm manager 8091, RAD 8443, direct control 8444) and the host link ports
export const GUEST_RESERVED_PORTS = Object.freeze([8080, 8091, 8443, 8444, 8095, 8096]);
// The verifier's port lies between the tenants' declarable ports (wasm_manager.py PORT_MAX_DECL 49999; a free declared
// number is bound literally) and the kernel's ephemeral range (init pins 58000-65535; a tenant's OS-assigned port comes
// from there): no tenant can hold it, even while gsup restarts the verifier after the wasm manager has started apps.
export const VERIFIER_PORT_RANGE = Object.freeze([50000, 57999]);
/** Where a configured-but-unusable verifier points: TCP discard, nothing in the guest serves it, every verified read refuses. */
export const REFUSING_VERIFIER = 'http://127.0.0.1:9/';
const KEYS = ['format', 'unsafeSigner', 'proofSources', 'port', 'gossip', 'limits'];
const ADDR = /^0x[0-9a-fA-F]{40}$/;

function bad(m) { throw new Error(`chainVerifier: ${m}`); }
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const int = (v, lo, hi, what) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) bad(`${what} must be an integer ${lo}..${hi}`); return v; };

/** -> the canonical, frozen setting (fixed key order), or throws. allowLoopbackHttp: tests only (loopback proof fixtures). */
export function checkChainVerifier(raw, { allowLoopbackHttp = false } = {}) {
  if (!plain(raw)) bad('must be an object');
  if ('witnessArchive' in raw) bad('witnessArchive is not offered in the guest (its base image has no curl with --aws-sigv4); remove it');
  if ('witnessCache' in raw) bad('witnessCache is not offered (no reviewed NVMe budget kind for a local witness cache)');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) bad(`unknown field ${k}`);
  if (raw.format !== CHAIN_VERIFIER_FORMAT) bad(`format must be ${CHAIN_VERIFIER_FORMAT}`);
  if (typeof raw.unsafeSigner !== 'string' || !ADDR.test(raw.unsafeSigner) || /^0x0{40}$/i.test(raw.unsafeSigner)) bad('unsafeSigner must be the pinned sequencer address');
  if (!Array.isArray(raw.proofSources) || raw.proofSources.length < 1 || raw.proofSources.length > 16) bad('proofSources must list 1..16 explicit proof source URLs (fresh state needs one; there is no implicit provider)');
  const seen = new Set();
  const proofSources = raw.proofSources.map((u, i) => {
    let x; try { x = new URL(u); } catch { bad(`proofSources[${i}] must be a URL`); }
    const loop = x.protocol === 'http:' && allowLoopbackHttp && (x.hostname === '127.0.0.1' || x.hostname === '[::1]');
    if ((x.protocol !== 'https:' && !loop) || x.username || x.password || x.search || x.hash) bad(`proofSources[${i}] must be https without credentials, query or fragment`);
    if (seen.has(x.href)) bad(`proofSources[${i}] repeats a source`); seen.add(x.href);
    return String(u);
  });
  if (GUEST_RESERVED_PORTS.includes(raw.port)) bad(`port ${raw.port} is one of the guest's own ports`);
  const port = int(raw.port, ...VERIFIER_PORT_RANGE, 'port (between the tenants\' ports and the ephemeral range)');
  let gossip = null;
  if (raw.gossip !== undefined && raw.gossip !== null) {
    if (!plain(raw.gossip) || Object.keys(raw.gossip).some((k) => !['maxPeers', 'discovery', 'sessionSecs'].includes(k))) bad('gossip: { maxPeers?, discovery?, sessionSecs? }');
    gossip = {};
    if (raw.gossip.maxPeers !== undefined) gossip.maxPeers = int(raw.gossip.maxPeers, 1, 50, 'gossip.maxPeers');
    if (raw.gossip.discovery !== undefined) { if (!['off', 'bounded'].includes(raw.gossip.discovery)) bad('gossip.discovery must be off or bounded'); gossip.discovery = raw.gossip.discovery; }
    if (raw.gossip.sessionSecs !== undefined) gossip.sessionSecs = int(raw.gossip.sessionSecs, 60, 3600, 'gossip.sessionSecs');
    gossip = Object.freeze(gossip);
  }
  let limits = null;
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!plain(raw.limits) || Object.keys(raw.limits).some((k) => !['firstHeadTimeoutMs', 'heliosReadyTimeoutMs'].includes(k))) bad('limits: { firstHeadTimeoutMs?, heliosReadyTimeoutMs? }');
    limits = {};
    if (raw.limits.firstHeadTimeoutMs !== undefined) limits.firstHeadTimeoutMs = int(raw.limits.firstHeadTimeoutMs, 5000, 900000, 'limits.firstHeadTimeoutMs');
    if (raw.limits.heliosReadyTimeoutMs !== undefined) limits.heliosReadyTimeoutMs = int(raw.limits.heliosReadyTimeoutMs, 5000, 600000, 'limits.heliosReadyTimeoutMs');
    limits = Object.freeze(limits);
  }
  return Object.freeze({ format: CHAIN_VERIFIER_FORMAT, unsafeSigner: raw.unsafeSigner.toLowerCase(), proofSources: Object.freeze(proofSources), port,
    ...(gossip ? { gossip } : {}), ...(limits ? { limits } : {}) });
}

/** The measured image's verifier record (/opt/rpc-runtime/IMAGE.json, installed by metal/overlay-control-image.py from the
 *  committed metal/chain-verifier-image.json): entry, node, pinned binaries, glibc runtime, staging, state paths. */
export function readVerifierImage(file = CHAIN_VERIFIER_IMAGE_FILE) {
  let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!plain(m) || m.format !== CHAIN_VERIFIER_IMAGE_FORMAT) return null;
  for (const k of ['entry', 'node', 'stateDir', 'configDir']) if (typeof m[k] !== 'string' || !path.isAbsolute(m[k])) return null;
  if (!plain(m.binaries) || !['listener', 'helios', 'witnessCheck'].every((r) => plain(m.binaries[r]) && path.isAbsolute(String(m.binaries[r].path)) && /^[0-9a-f]{64}$/.test(String(m.binaries[r].sha256)))) return null;
  return m;
}

/** The runtime's own config (enclave-rpc-runtime/v2) for a checked setting on this image. */
export function runtimeConfigFor(v, image) {
  const pick = (r) => ({ path: image.binaries[r].path, sha256: image.binaries[r].sha256 });
  return { format: 'enclave-rpc-runtime/v2', chain: { chainId: 8453, unsafeSigner: v.unsafeSigner },
    binaries: { listener: pick('listener'), helios: pick('helios'), witnessCheck: pick('witnessCheck') },
    proofSources: { untrusted: [...v.proofSources] }, verifier: { port: v.port }, stateDir: image.stateDir,
    ...(v.gossip ? { gossip: { ...v.gossip } } : {}), witnessCache: null, witnessArchive: null,
    hostTools: { ...(image.hostTools || {}) },
    ...(image.glibcRuntime ? { glibcRuntime: image.glibcRuntime } : {}), ...(image.binaryStaging ? { binaryStaging: image.binaryStaging } : {}),
    ...(v.limits ? { limits: { ...v.limits } } : {}) };
}

/**
 * The legacy guest's view of fw_cfg `chainVerifier` (gsup.mjs).
 * -> { configured, ok, url, message, runtimeConfig?, image?, argv(configFile)?, env? }
 */
export function guestChainVerifier(value, { imageFile = CHAIN_VERIFIER_IMAGE_FILE, image, allowLoopbackHttp = false } = {}) {
  if (value === undefined || value === null) return { configured: false, ok: false, url: null, message: null };
  let v;
  try { v = checkChainVerifier(value, { allowLoopbackHttp }); }
  catch (e) { return { configured: true, ok: false, url: REFUSING_VERIFIER, message: `chain verifier REFUSED (${e.message}): every verified chain read refuses; no provider fallback` }; }
  const img = image ?? readVerifierImage(imageFile);
  if (!img) return { configured: true, ok: false, url: REFUSING_VERIFIER, message: 'chain verifier REFUSED (this image carries no chain verifier runtime): every verified chain read refuses; no provider fallback' };
  const url = `http://127.0.0.1:${v.port}/`;
  return { configured: true, ok: true, url, verifier: v, image: img, runtimeConfig: runtimeConfigFor(v, img),
    argv: (configFile) => [img.node, img.entry, 'run', configFile],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: img.configDir },
    message: `chain verifier configured: ${v.proofSources.length} proof source(s), loopback port ${v.port}, signer ${v.unsafeSigner}; `
      + 'verified readers refuse until it is ready (unsafe-head tier, no finality)' };
}

/** Writes the runtime config (0700 directory, 0600 file) and returns its path. */
export function writeChainVerifierConfig(cv) {
  fs.mkdirSync(cv.image.configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cv.image.configDir, 0o700);
  const file = path.join(cv.image.configDir, 'rpc-runtime.json'), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cv.runtimeConfig, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** env with the two chain-authority names ONLY from this channel (any other source of them is dropped). */
export function withChainVerifierEnv(env, cv) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !CHAIN_AUTHORITY_NAMES.includes(k)));
  if (!cv?.configured) return out;
  return { ...out, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: cv.ok ? cv.url : REFUSING_VERIFIER };
}
