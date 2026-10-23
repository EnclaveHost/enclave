// The local Base chain verifier of an Enclave host: ONE supervised runtime that composes the pieces already built and
// reviewed separately, in this order (each stage needs only the stages before it, and nothing remote, to start):
//
//   1. witness-check helper (owned child; Helios's own commitment/proof code, offline)   network/witness-verify.mjs
//   2. root store: block hash -> state root bindings, ONLY from verified signed heads    network/witness-verify.mjs
//      (pushed below) or authenticated ancestry from them
//   3. head relay on 127.0.0.1 (Helios's --consensus-rpc)                               network/op-head-relay.mjs
//   4. proof-aware witness gateway on 127.0.0.1 (Helios's --execution-rpc) in front of   network/witness-gateway.mjs
//      the EXPLICIT, UNTRUSTED upstream proof sources of the config, with an optional    network/s3-witness-cache.mjs
//      untrusted S3 (Sia-S3) ARCHIVE of verified history behind them (never contacted to start)
//   5. native gossip head source: the pinned enclave-base-head-listener (owned child)    network/gossip-head-source.mjs
//      -> its native `commitment` mode -> op-head-relay verifyCommitment; every verified head is offered to the root
//      store FIRST (roots.offer) and then to the relay, so a head Helios can adopt always has its root bound already
//   6. after the first FRESH verified head only: Helios (enclave-base-evm, owned child) on 127.0.0.1:<verifier.port>,
//      ready once that port's listening socket provably belongs to it, it answers chain id 8453, and its head reached
//      the first verified head
//   7. consumers: LeaseReader authority 'verifier' (chainAuthority: 'verifier', chainVerifier: <verifierUrl>)
//
// No stage asks an RPC service for a proof before its own verifier is running: the helper and the root store start
// with no network at all, the gateway refuses every pinned witness it cannot verify against a bound root, and Helios
// starts only on a head the native listener received over Base gossip and two independent verifiers checked.
//
// What this is NOT (labels the status carries, and the reasons):
//   * not finality: heads are the sequencer-signed UNSAFE head (no L1 derivation, no safe/finalized tier);
//   * not provider independence: fresh state still needs at least one configured, reachable UPSTREAM PROOF SOURCE (an
//     explicit state holder; untrusted, verified before use). No usable maintained peer-proof source is established for
//     this runtime (the reviewed Base clients implement snap/2 serving but ship it off with no Base flag; whether any
//     peer serves proofs is unknown). With every upstream down, reads of new blocks fail closed; the optional archive
//     answers history for its block only, never live availability or a root;
//   * not a public service: every endpoint binds 127.0.0.1, nothing is advertised, no grant or serving decision is made
//     here (platform admission stays where it is). It is not a host-service role (network/host-services/roles.mjs): those
//     are public, advertised and gated by the platform host policy, whose own chain reads may come to depend on this
//     verifier, so gating the verifier by that gate would be a bootstrap cycle.
//   * a failed proof is never replaced by provider agreement: there is no quorum fallback inside; the consumer's
//     rollback to its legacy provider quorum is an explicit config change (chainAuthority unset), not automatic.
//
// Lifecycle: startup is all-or-nothing (every resource registers its cleanup the moment it exists; a failure runs them
// in reverse and rethrows). One runtime per stateDir: a kernel flock on a persistent, empty runtime.lock held through a
// descriptor only this process owns (network/runtime-lock.mjs; never unlinked; a nonempty legacy lock is refused and
// needs a reviewed migration; children do not inherit the descriptor, so an orphaned child never holds it). Children are owned by
// process identity (pid, process group, start time) recorded at spawn, and anything still executing a binary staged
// in an EARLIER run directory of this stateDir is ours by construction; both are reaped before a new start. Binaries
// are copied into a fresh 0700 run directory, hashed there and executed from there (no check-then-swap window).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createHeadRelay, BASE_MAINNET } from './op-head-relay.mjs';
import { createWitnessChecker, createRootStore } from './witness-verify.mjs';
import { createWitnessGateway, WITNESS_METHODS } from './witness-gateway.mjs';
import { s3WitnessCache } from './s3-witness-cache.mjs';
import { takeRuntimeLock } from './runtime-lock.mjs';
import { createGossipHeadSource, procIdentity, signalOwned } from './gossip-head-source.mjs';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';

export const CONFIG_FORMAT = 'enclave-rpc-runtime/v2';
export const STATUS_FORMAT = 'enclave-rpc-runtime-status/v1';
export const CHAIN_ID = 8453;                 // Base mainnet: the listener, the relay and Helios's network 'base'
/**
 * The builds this runtime was tested with (sha256 -> provenance). A config pins one of these per binary; any other
 * digest is refused. Adding a build (e.g. a release) is a reviewed source change with its own test evidence.
 */
export const PINNED_BUILDS = Object.freeze({
  listener: Object.freeze({
    ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a: 'enclave-base-head-listener commitment-mode 5e178676 (code a0c7c4e), base/base 5476069f, Rust 1.96.0, debug profile',
    '9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3': 'enclave-base-head-listener 5e178676, release profile, scripts/rpc-runtime/build-binaries.sh (closure.json), Rust 1.96.0',
  }),
  helios: Object.freeze({
    cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0: 'helios enclave-base-evm eeffcc9 (CLI source identical in function to ef320298: later commits change only the witness-check helper), base/base v1.5.1 EVM, Rust 1.96.0, debug profile (not an optimized release)',
  }),
  witnessCheck: Object.freeze({
    // the final gateway needs the helper's `block`/`header` ops (Helios ef320298); the older aca81764 builds
    // (fab2f1ce debug, a3377048 release) fail closed on blocks and are no longer accepted
    '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411': 'witness-check enclave-witness-check ef320298, Rust 1.96.0, debug profile (not an optimized release)',
  }),
});
const ROLES = Object.freeze(['listener', 'helios', 'witnessCheck']);
/**
 * Exact glibc runtimes a binary may be started under instead of the host's own (sha256 per file, by provenance). For a
 * userland whose glibc is older than a pinned build needs (the Linux guest base is Debian 12, glibc 2.36; the pinned
 * Helios needs GLIBC_2.39 and the helper GLIBC_2.38): the binary runs through this runtime's own loader with
 * --library-path, so only the four files below (the binaries need nothing else) are taken from it. Adding one is a
 * reviewed source change with test evidence, like PINNED_BUILDS.
 */
export const PINNED_GLIBC_RUNTIMES = Object.freeze({
  'arch glibc 2.44+r50+g1848099f063e-1, gcc-libs 16.2.1+r23+gd564253eb6c8-1 (the build host of the pinned binaries)': Object.freeze({
    'ld-linux-x86-64.so.2': 'f5e11cc62f8f2c24dff532982559f4303dba3b17e7450551372a88c8e7ea8757',
    'libc.so.6': '02c8c3d06180beee9c7d0392aa85736c7d19f274a81e7f8f0b3d9e28e0641524',
    'libm.so.6': '965106704753eefe8c31ae7da6daba3ead3d18c52b19b5fcc41178bcc4aa999d',
    'libgcc_s.so.1': 'e618cb9c90c2eb3a1dad1cfea5b6c1eebcf2e799ad805976f4ae47bdd61c716a',
  }),
});
const GLIBC_FILES = Object.freeze(['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libgcc_s.so.1']);
const STAGED = Object.freeze({ listener: 'enclave-base-head-listener', helios: 'helios', witnessCheck: 'witness-check' });
const NO_HINT = Object.freeze(WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList'));
const ADDR = /^0x[0-9a-fA-F]{40}$/, SHA = /^[0-9a-f]{64}$/;
// a field that names a credential is refused (the same rule as network/host-services/roles.mjs): this config holds none
const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;
const LIMITS = Object.freeze({ killGraceMs: 5000, stopStepMs: 10000, readyPollMs: 250, statusEveryMs: 2000, stderrTailBytes: 16 * 1024 });
// The optional archive's local footprint: request bodies of in-flight archive writes only (s3WitnessCache defaults
// maxInflightPuts 2 x maxObjectBytes 4 MiB), in a 0700 scratch under <stateDir>/tmp (TMPDIR), removed on close. No NVMe
// cache is allocated by this runtime: a local witness cache would need a root-approved reservation in the central budget.
const ARCHIVE_SCRATCH_MAX_BYTES = 2 * (4 << 20);
const DEFAULT_TOOLS = Object.freeze({ flock: '/usr/bin/flock', curl: '/usr/bin/curl' });

const fail = (m) => { throw new Error(`rpc runtime: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (s) => String(s).toLowerCase();
function only(where, o, allowed, required = []) {
  if (!plain(o)) fail(`${where} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: unknown field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (this config holds no secret)' : ''}`);
  for (const k of required) if (o[k] === undefined || o[k] === null || o[k] === '') fail(`${where}.${k} is required`);
}
const int = (where, v, lo, hi, dflt) => {
  if (v === undefined) return dflt;
  if (!Number.isSafeInteger(v) || v < lo || v > hi) fail(`${where} must be an integer ${lo}..${hi}`);
  return v;
};
const absPath = (where, v) => { if (typeof v !== 'string' || !path.isAbsolute(v) || v.includes('\0')) fail(`${where} must be an absolute path`); return path.normalize(v); };

/**
 * Strict config validation -> the normalized config (no defaults hidden elsewhere). acceptedBuilds: PINNED_BUILDS
 * unless a caller (a test launcher, never the config file) passes its own table.
 *
 * {
 *   "format": "enclave-rpc-runtime/v2",
 *   "chain": { "chainId": 8453, "unsafeSigner": "0x..." },            the administrator's pin of the sequencer key
 *   "binaries": { "listener": {"path", "sha256"}, "helios": {...}, "witnessCheck": {...} },
 *   "proofSources": { "untrusted": ["https://...", ...], "accessListHint": false },
 *   "verifier": { "port": 8545 },                                       Helios JSON-RPC, always 127.0.0.1
 *   "stateDir": "/abs/dir",
 *   "gossip"?: { "maxPeers": 20, "discovery": "bounded"|"off", "sessionSecs": 3600, "restartIfNoHeadMs": 120000 },
 *   "witnessCache"?: null,                                             no local cache (see below)
 *   "witnessArchive"?: null | { "kind": "s3", "endpoint": "https://...", "bucket": "...", "region"?: "us-east-1",
 *                               "prefix"?: "enclave-witness", "accessFile": "/abs/0600 JSON {accessKeyId, secretAccessKey}",
 *                               "writes"?: false },                    optional untrusted history; never needed to start
 *   "hostTools"?: { "flock": "/usr/bin/flock", "curl": "/usr/bin/curl" }, reviewed absolute paths (util-linux flock; curl
 *                                                                        with --aws-sigv4, needed only with an archive)
 *   "limits"?: { "firstHeadTimeoutMs": 180000, "heliosReadyTimeoutMs": 120000 }
 * }
 */
export function validateRuntimeConfig(raw, { acceptedBuilds = PINNED_BUILDS } = {}) {
  only('config', raw, ['format', 'chain', 'binaries', 'proofSources', 'verifier', 'stateDir', 'gossip', 'witnessCache', 'witnessArchive', 'hostTools',
    'glibcRuntime', 'binaryStaging', 'limits'],
    ['format', 'chain', 'binaries', 'proofSources', 'verifier', 'stateDir']);
  if (raw.format !== CONFIG_FORMAT) fail(`format must be ${CONFIG_FORMAT}${raw.format === 'enclave-rpc-runtime/v1' ? ' (v1 had an unbudgeted local cache and no archive; rewrite the config)' : ''}`);
  only('chain', raw.chain, ['chainId', 'unsafeSigner'], ['chainId', 'unsafeSigner']);
  if (raw.chain.chainId !== CHAIN_ID) fail(`chain.chainId must be ${CHAIN_ID} (Base mainnet: the listener, relay and Helios network are Base-only)`);
  if (!ADDR.test(raw.chain.unsafeSigner) || /^0x0{40}$/i.test(raw.chain.unsafeSigner)) fail('chain.unsafeSigner must be the pinned sequencer address');
  only('binaries', raw.binaries, ROLES, ROLES);
  const binaries = {};
  for (const role of ROLES) {
    const b = raw.binaries[role];
    only(`binaries.${role}`, b, ['path', 'sha256'], ['path', 'sha256']);
    if (!SHA.test(b.sha256)) fail(`binaries.${role}.sha256 must be 64 lowercase hex`);
    if (!Object.hasOwn(acceptedBuilds[role] || {}, b.sha256)) fail(`binaries.${role}.sha256 ${b.sha256} is not a tested build of this runtime`);
    binaries[role] = { path: absPath(`binaries.${role}.path`, b.path), sha256: b.sha256, build: acceptedBuilds[role][b.sha256] };
  }
  only('proofSources', raw.proofSources, ['untrusted', 'accessListHint'], ['untrusted']);
  const ups = raw.proofSources.untrusted;
  if (!Array.isArray(ups) || ups.length < 1 || ups.length > 16) fail('proofSources.untrusted: 1 to 16 execution JSON-RPC URLs (untrusted witness sources)');
  only('verifier', raw.verifier, ['port'], ['port']);
  const port = int('verifier.port', raw.verifier.port, 1, 65535);
  const seen = new Set();
  for (const [i, u] of ups.entries()) {
    let e; try { e = rpcEndpoint(u); } catch (x) { fail(`proofSources.untrusted[${i}]: ${x.message}`); }
    if (e.url.search) fail(`proofSources.untrusted[${i}] carries a query string (no credentials in this config)`);
    if (seen.has(e.url.href)) fail(`proofSources.untrusted[${i}] repeats a source`); seen.add(e.url.href);
    if (e.loopback && Number(e.port) === port) fail(`proofSources.untrusted[${i}] is the verifier's own port (a verifier cannot be its own witness source)`);
  }
  if (raw.proofSources.accessListHint !== undefined && typeof raw.proofSources.accessListHint !== 'boolean') fail('proofSources.accessListHint must be a boolean');
  const g = raw.gossip ?? {};
  only('gossip', g, ['maxPeers', 'discovery', 'sessionSecs', 'restartIfNoHeadMs']);
  if (g.discovery !== undefined && !['off', 'bounded'].includes(g.discovery)) fail('gossip.discovery must be off or bounded');
  // A local (NVMe) witness cache allocates disk: it would need its own root-approved reservation in the ONE central cache
  // budget (enclave-rpc-nvme-cache-budget/v2, /etc/enclave-rpc-cache/nvme-cache-budget.json; 250,000,000,000-byte cap,
  // 200 GB target), whose v2 kinds reserve only preallocated fixed-size files. A growing directory cache has no reviewed
  // kind there, and a quota of this runtime's own would compete with it, so none is offered: null only.
  if (raw.witnessCache !== undefined && raw.witnessCache !== null) fail('witnessCache must be null: a local witness cache needs a root-approved reservation of a reviewed kind in the central NVMe cache budget (v2 reserves only preallocated files); use witnessArchive for remote history');
  let witnessArchive = null;
  if (raw.witnessArchive !== undefined && raw.witnessArchive !== null) {
    const a = raw.witnessArchive;
    only('witnessArchive', a, ['kind', 'endpoint', 'bucket', 'region', 'prefix', 'accessFile', 'writes'], ['kind', 'endpoint', 'bucket', 'accessFile']);
    if (a.kind !== 's3') fail('witnessArchive.kind must be "s3"');
    let e; try { e = rpcEndpoint(a.endpoint); } catch (x) { fail(`witnessArchive.endpoint: ${x.message}`); }
    if (e.url.search || e.url.pathname !== '/') fail('witnessArchive.endpoint must be a bare https origin (or http on loopback)');
    if (typeof a.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(a.bucket)) fail('witnessArchive.bucket must be an S3 bucket name');
    if (a.region !== undefined && !/^[a-z0-9-]{1,32}$/.test(a.region)) fail('witnessArchive.region must be a region name');
    if (a.prefix !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(a.prefix)) fail('witnessArchive.prefix must be a simple name');
    if (a.writes !== undefined && typeof a.writes !== 'boolean') fail('witnessArchive.writes must be a boolean');
    witnessArchive = Object.freeze({ kind: 's3', endpoint: e.url.origin, bucket: a.bucket, region: a.region ?? 'us-east-1', prefix: a.prefix ?? 'enclave-witness',
      accessFile: absPath('witnessArchive.accessFile', a.accessFile), writes: a.writes === true });
  }
  const t = raw.hostTools ?? {};
  only('hostTools', t, ['flock', 'curl']);
  const hostTools = Object.freeze({ flock: absPath('hostTools.flock', t.flock ?? DEFAULT_TOOLS.flock), curl: absPath('hostTools.curl', t.curl ?? DEFAULT_TOOLS.curl) });
  let glibcRuntime = null;
  if (raw.glibcRuntime !== undefined && raw.glibcRuntime !== null) {
    const r = raw.glibcRuntime;
    only('glibcRuntime', r, ['dir', 'files', 'binaries'], ['dir', 'files', 'binaries']);
    only('glibcRuntime.files', r.files, GLIBC_FILES, GLIBC_FILES);
    const set = Object.entries(PINNED_GLIBC_RUNTIMES).find(([, f]) => GLIBC_FILES.every((n) => f[n] === r.files[n]));
    if (!set) fail('glibcRuntime.files is not a tested glibc runtime of this runtime');
    if (!Array.isArray(r.binaries) || !r.binaries.length || r.binaries.some((b) => !['helios', 'witnessCheck'].includes(b)) || new Set(r.binaries).size !== r.binaries.length)
      fail('glibcRuntime.binaries: helios and/or witnessCheck (the listener is checked by its own digest and runs on the host glibc)');
    glibcRuntime = Object.freeze({ dir: absPath('glibcRuntime.dir', r.dir), files: Object.freeze({ ...set[1] }), build: set[0], binaries: Object.freeze([...r.binaries]) });
  }
  if (raw.binaryStaging !== undefined && !['copy', 'verify-in-place'].includes(raw.binaryStaging)) fail('binaryStaging must be copy or verify-in-place');
  const binaryStaging = raw.binaryStaging ?? 'copy';
  const l = raw.limits ?? {};
  only('limits', l, ['firstHeadTimeoutMs', 'heliosReadyTimeoutMs']);
  const stateDir = absPath('stateDir', raw.stateDir);
  return Object.freeze({
    format: CONFIG_FORMAT,
    chain: Object.freeze({ chainId: CHAIN_ID, unsafeSigner: lower(raw.chain.unsafeSigner) }),
    binaries: Object.freeze(binaries),
    proofSources: Object.freeze({ untrusted: Object.freeze([...ups]), accessListHint: raw.proofSources.accessListHint === true }),
    verifier: Object.freeze({ bind: '127.0.0.1', port }),
    stateDir,
    gossip: Object.freeze({ maxPeers: int('gossip.maxPeers', g.maxPeers, 1, 50, 20), discovery: g.discovery ?? 'bounded',
      sessionSecs: int('gossip.sessionSecs', g.sessionSecs, 60, 3600, 3600), restartIfNoHeadMs: int('gossip.restartIfNoHeadMs', g.restartIfNoHeadMs, 5000, 3_600_000, 120_000) }),
    witnessCache: null,
    witnessArchive,
    hostTools,
    glibcRuntime,
    binaryStaging,
    limits: Object.freeze({ firstHeadTimeoutMs: int('limits.firstHeadTimeoutMs', l.firstHeadTimeoutMs, 5000, 900_000, 180_000),
      heliosReadyTimeoutMs: int('limits.heliosReadyTimeoutMs', l.heliosReadyTimeoutMs, 5000, 600_000, 120_000) }),
  });
}

/** The honest scope labels every status carries. */
export const LABELS = Object.freeze({
  head: 'sequencer-signed Base UNSAFE head received over native gossip (no L1 safety, no finality)',
  execution: 'Helios enclave-base-evm over proof-backed state (maintained Base EVM; refuses execution from Denim)',
  witnesses: 'UNTRUSTED upstream proof sources from config (explicit state holders), every pinned witness verified against a bound root before use; no usable maintained peer-proof source is established for this runtime (reviewed Base clients ship snap/2 serving off, peer availability unknown), so fresh state requires a configured, reachable proof source',
  roots: 'signed-head roots (pushed per verified head) and ancestor roots (authenticated ancestry) are history for their block, never freshness',
  cache: 'no local witness cache (none is budgeted); the optional S3/Sia archive is untrusted history for its block only: never a root, never freshness, never needed to start',
  independence: 'NOT provider-independent: fresh reads need at least one configured, reachable proof source; no provider agreement replaces a failed proof',
  exposure: 'loopback only; no public serving, advertisement or grant',
});

// ---- owned processes ------------------------------------------------------------------------------------------------

/** The process's executable path (as the kernel names it, " (deleted)" suffix removed), or null. */
function exeOf(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { return null; }
}
/** PIDs of live processes executing a binary staged under `runsDir` in a run other than `currentRun`. */
function leftoverStaged(runsDir, currentRun) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const exe = exeOf(name);
    if (exe && exe.startsWith(runsDir + path.sep) && !(currentRun && exe.startsWith(currentRun + path.sep)) && procIdentity(Number(name))) out.push(Number(name));
  }
  return out;
}
/** inodes of sockets LISTENing on 127.0.0.1:<port> (tcp4), from /proc/net/tcp. */
function listeningInodes(port) {
  const want = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`, out = [];
  let text = ''; try { text = fs.readFileSync('/proc/net/tcp', 'utf8'); } catch { return out; }
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length > 9 && f[1] === want && f[3] === '0A') out.push(f[9]);
  }
  return out;
}
function anyListener(port) {           // any LISTEN socket on this port, any local address (tcp4 + tcp6)
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[3] === '0A' && parseInt(f[1].split(':')[1], 16) === port) return true;
    }
  }
  return false;
}
function socketInodesOf(pid) {
  const out = new Set();
  let fds = []; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return out; }
  for (const fd of fds) { try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) out.add(m[1]); } catch {} }
  return out;
}
const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
};
async function rpc(url, method, params = [], ms = 3000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(ms), redirect: 'error' });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message || 'rpc error').slice(0, 200));
  return j.result;
}

/** Host tools the runtime runs: absolute, regular, executable, and the right program (version/feature probe, bounded). */
export async function preflightTools(tools, { needCurl }) {
  const probe = (bin, args) => new Promise((resolve) => {
    let out = '';
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const timer = setTimeout(() => p.kill('SIGKILL'), 5000);
    p.stdout.on('data', (d) => { if (out.length < 1 << 20) out += d; }); p.stderr.on('data', () => {});
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
  const regular = (what, bin) => {
    let st; try { st = fs.statSync(bin); } catch { fail(`hostTools.${what}: ${bin} does not exist`); }
    if (!st.isFile() || !(st.mode & 0o111)) fail(`hostTools.${what}: ${bin} is not an executable file`);
  };
  regular('flock', tools.flock);
  const fv = await probe(tools.flock, ['--version']);
  if (!fv || !/util-linux/.test(fv)) fail(`hostTools.flock: ${tools.flock} is not util-linux flock`);
  const out = { flock: fv.trim().split('\n')[0] };
  if (needCurl) {
    regular('curl', tools.curl);
    const help = await probe(tools.curl, ['--help', 'all']);
    if (!help || !help.includes('--aws-sigv4')) fail(`hostTools.curl: ${tools.curl} lacks --aws-sigv4 (the S3 archive signs with it)`);
    out.curl = ((await probe(tools.curl, ['--version'])) || '').split('\n')[0];
  }
  return out;
}

/** verify-in-place: the file and every directory above it are owned by root or this user and writable by nobody else. */
function safeInPlace(what, file) {
  const me = process.getuid();
  let st; try { st = fs.lstatSync(file); } catch { fail(`${what}: ${file} cannot be read`); }
  if (!st.isFile()) fail(`${what}: ${file} must be a regular file (not a symlink) to be verified in place`);
  for (let p = file; ; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if ((s.uid !== 0 && s.uid !== me) || (s.mode & 0o022)) fail(`${what}: ${p} must be owned by root or the runtime user and writable by no one else (verify-in-place)`);
    if (s.isSymbolicLink()) fail(`${what}: ${p} is a symlink (verify-in-place needs a real path)`);
    if (p === path.dirname(p)) break;
  }
}

/** S3 archive access: a regular, non-symlink, owner-only (0600) file of this user holding {accessKeyId, secretAccessKey}. */
function readArchiveAccess(file) {
  let st; try { st = fs.lstatSync(file); } catch { fail(`witnessArchive.accessFile ${file} does not exist`); }
  if (!st.isFile() || st.isSymbolicLink()) fail('witnessArchive.accessFile must be a regular file (not a symlink)');
  if (st.mode & 0o077) fail('witnessArchive.accessFile must be readable by its owner only (0600)');
  if (st.uid !== process.getuid()) fail('witnessArchive.accessFile must belong to the runtime user');
  if (st.size > 4096) fail('witnessArchive.accessFile is too large');
  let a; try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('witnessArchive.accessFile is not JSON'); }
  if (!plain(a) || Object.keys(a).some((k) => !['accessKeyId', 'secretAccessKey'].includes(k))) fail('witnessArchive.accessFile must hold exactly {accessKeyId, secretAccessKey}');
  return { accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey };
}

// ---- the head path (shared by the runtime and its tests) ------------------------------------------------------------

/**
 * The verified-head fan-out: every head the gossip source verified goes to the root store FIRST (which verifies it
 * again with the helper and binds its state root), then to the relay Helios polls. -> {onCommitment, counters}.
 */
export function createHeadFanout({ roots, relay, onFirstHead }) {
  const counters = { offered: 0, rootsBound: 0, rootsRefused: 0, relayAccepted: 0, relayRefused: {} };
  let first = true;
  async function onCommitment(commitment, meta) {
    counters.offered++;
    const bound = await roots.offer(commitment);
    if (!bound) { counters.rootsRefused++; throw new Error('the root store refused a head the gossip source verified'); }
    counters.rootsBound++;
    const r = await relay.offer(commitment, 'native-gossip');
    if (!r.accepted) { counters.relayRefused[r.reason] = (counters.relayRefused[r.reason] || 0) + 1; return; }
    counters.relayAccepted++;
    if (first) { first = false; onFirstHead?.(meta); }
  }
  return { onCommitment, counters };
}

// ---- the runtime ----------------------------------------------------------------------------------------------------

/**
 * startRpcRuntime(config, opts) -> Promise<{ verifierUrl, status(), failed: Promise<reason>, close() }>
 * config: the raw config document (validated here with validateRuntimeConfig). opts (callers only, never the config file):
 *   acceptedBuilds  the tested-build table (PINNED_BUILDS)
 *   listenerEnv     extra environment for the listener child (test stand-ins)
 *   log(event)      structured event sink (default: none)
 *   signal          AbortSignal: aborting during startup stops it (everything started is cleaned up, the promise rejects)
 * Resolves only when ready; rejects (after cleaning up everything it started) otherwise.
 */
export async function startRpcRuntime(rawConfig, { acceptedBuilds = PINNED_BUILDS, listenerEnv = {}, log = () => {}, signal } = {}) {
  if (process.platform !== 'linux') fail('this runtime supervises children through /proc (Linux); see docs for the Windows status');
  const config = validateRuntimeConfig(rawConfig, { acceptedBuilds });
  const { stateDir } = config, signer = config.chain.unsafeSigner;
  const stops = [];                                 // reverse-order cleanup, registered as each resource comes up
  const state = { phase: 'starting', startedAt: Date.now(), readyAt: null, failure: null, stopping: false, reaped: { recorded: 0, staged: 0, runDirs: 0 }, firstHead: null };
  let resolveFailed; const failed = new Promise((r) => { resolveFailed = r; });
  let closing = null, helios = null, statusTimer = null, statusFile = null, readyFile = null, childrenFile = null;
  const children = new Map();                       // role/session -> owned identity (also written to children.json)
  const recordChildren = () => { try { writeJsonAtomic(childrenFile, [...children.values()]); } catch {} };
  const stopAll = async () => {
    while (stops.length) {
      const f = stops.pop();
      try { await Promise.race([Promise.resolve().then(f), sleep(LIMITS.stopStepMs)]); } catch {}
    }
  };
  const failNow = (reason) => {
    if (state.failure) return;
    state.failure = String(reason); state.phase = 'failed';
    log({ event: 'failed', reason: state.failure });
    resolveFailed(state.failure);
  };

  const onAbort = () => { state.stopping = true; failNow('stopped during startup'); };
  if (signal?.aborted) fail('stopped before start');
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const sd = fs.lstatSync(stateDir);
    if (!sd.isDirectory() || sd.uid !== process.getuid() || (sd.mode & 0o077)) fail('stateDir must be a directory owned by the runtime user and private (0700)');
    const tools = await preflightTools(config.hostTools, { needCurl: !!config.witnessArchive });
    // kernel exclusion: the release closes our descriptor (never unlinks the file); registered before any other await
    const releaseLock = await takeRuntimeLock(path.join(stateDir, 'runtime.lock'), { flockPath: config.hostTools.flock, signal });
    stops.push(releaseLock);
    log({ event: 'locked', tools });
    const archiveAccess = config.witnessArchive ? readArchiveAccess(config.witnessArchive.accessFile) : null;   // fail before staging
    childrenFile = path.join(stateDir, 'children.json');
    stops.push(() => fs.rmSync(childrenFile, { force: true }));      // after every child is stopped (stops run in reverse)
    readyFile = path.join(stateDir, 'ready.json'); statusFile = path.join(stateDir, 'status.json');
    fs.rmSync(readyFile, { force: true });
    const runsDir = path.join(stateDir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });

    // reap what an earlier run of this stateDir left behind: recorded identities, then anything executing a staged binary
    let recorded = []; try { recorded = JSON.parse(fs.readFileSync(childrenFile, 'utf8')); } catch {}
    for (const id of Array.isArray(recorded) ? recorded : []) {
      if (Number.isSafeInteger(id?.pid) && Number.isSafeInteger(id?.pgid) && typeof id?.startTime === 'string' && id.pid !== process.pid) {
        if ((await signalOwned(id, 'SIGKILL')).length) state.reaped.recorded++;
      }
    }
    if (config.binaryStaging === 'copy') for (const pid of leftoverStaged(runsDir, null)) { try { process.kill(pid, 'SIGKILL'); state.reaped.staged++; } catch {} }
    for (const name of fs.readdirSync(runsDir)) {
      const dir = path.join(runsDir, name);
      if (/^r\d+-[0-9a-f]{12}$/.test(name) && fs.existsSync(path.join(dir, 'OWNER'))) { fs.rmSync(dir, { recursive: true, force: true }); state.reaped.runDirs++; }
    }
    fs.rmSync(childrenFile, { force: true });
    if (state.reaped.recorded || state.reaped.staged) await sleep(200);   // let the kernel tear the reaped ones down

    // a fresh 0700 run directory. 'copy': binaries are copied in, hashed THERE and executed from there (no check-then-swap
    // window). 'verify-in-place' (a read-only measured image, where a second copy would cost guest RAM): each file and every
    // directory above it must be owned by root or this user and writable by nobody else, then it is hashed and executed
    // where it is; leftover children are then reaped by their recorded identities only.
    const runDir = path.join(runsDir, `r${Date.now()}-${randomBytes(6).toString('hex')}`);
    fs.mkdirSync(runDir, { mode: 0o700 });
    stops.push(() => fs.rmSync(runDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(runDir, 'OWNER'), `rpc-runtime pid=${process.pid}\n`, { flag: 'wx' });
    fs.mkdirSync(path.join(runDir, 'bin'), { mode: 0o700 });
    const inPlace = config.binaryStaging === 'verify-in-place';
    const place = (what, src, name, sha, mode) => {
      if (inPlace) {
        safeInPlace(what, src);
        const digest = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
        if (digest !== sha) fail(`${what}: ${src} has sha256 ${digest}, not the pinned ${sha}`);
        return src;
      }
      const dst = path.join(runDir, name);
      try { fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); } catch (e) { fail(`${what}: ${src} cannot be read (${e.code || e.message})`); }
      fs.chmodSync(dst, mode);
      const digest = createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
      if (digest !== sha) fail(`${what}: ${src} has sha256 ${digest}, not the pinned ${sha}`);
      return dst;
    };
    const bin = {};
    for (const role of ROLES) bin[role] = place(`binaries.${role}`, config.binaries[role].path, path.join('bin', STAGED[role]), config.binaries[role].sha256, 0o500);
    // the pinned glibc runtime (optional): its loader starts the binaries that need it, with ONLY its directory searched
    let glibc = null;
    if (config.glibcRuntime) {
      if (!inPlace) fs.mkdirSync(path.join(runDir, 'glibc'), { mode: 0o700 });
      const files = {};
      for (const n of GLIBC_FILES) files[n] = place(`glibcRuntime ${n}`, path.join(config.glibcRuntime.dir, n), path.join('glibc', n), config.glibcRuntime.files[n],
        n === 'ld-linux-x86-64.so.2' ? 0o500 : 0o400);
      glibc = { loader: files['ld-linux-x86-64.so.2'], dir: path.dirname(files['libc.so.6']), for: new Set(config.glibcRuntime.binaries) };
      if (Object.values(files).some((f) => path.dirname(f) !== glibc.dir)) fail('glibcRuntime: its four files must be in one directory');
    }
    const viaGlibc = (role, args) => (glibc?.for.has(role) ? [glibc.loader, ['--library-path', glibc.dir, bin[role], ...args]] : [bin[role], args]);
    log({ event: 'staged', runDir, staging: config.binaryStaging, binaries: Object.fromEntries(ROLES.map((r) => [r, config.binaries[r].sha256])),
      glibcRuntime: config.glibcRuntime ? { build: config.glibcRuntime.build, for: config.glibcRuntime.binaries } : null });

    // 1. the helper: alive, and holding exactly our pins. Started through the pinned glibc runtime when configured: the
    // helper client takes one executable, so a private 0500 wrapper in the run directory execs the loader with it.
    let helperBin = bin.witnessCheck;
    if (glibc?.for.has('witnessCheck')) {
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      helperBin = path.join(runDir, 'bin', 'witness-check.sh');
      fs.writeFileSync(helperBin, `#!/bin/sh\nexec ${[glibc.loader, '--library-path', glibc.dir, bin.witnessCheck].map(q).join(' ')} "$@"\n`, { flag: 'wx', mode: 0o500 });
    }
    const checker = createWitnessChecker({ bin: helperBin, chainId: CHAIN_ID, signer });
    stops.push(() => checker.close());
    const v = await checker.check({ op: 'version' }).catch((e) => fail(`witness-check did not answer: ${e.message}`));
    if (!v.ok || v.chainId !== CHAIN_ID || lower(v.signer) !== signer) fail('witness-check does not hold the pinned chain and signer');

    // 2. roots (pushed only), 3. relay, 4. archive (optional; constructing it contacts nothing), 5. gateway
    const roots = createRootStore({ checker });
    stops.push(() => roots.close());
    const relay = createHeadRelay({ sources: [], chainId: CHAIN_ID, signer, maxAgeMs: 60000 });
    const relayUrl = await relay.listen(0);
    stops.push(() => relay.close());
    let archive = null;
    if (config.witnessArchive) {
      const a = config.witnessArchive, tmp = path.join(stateDir, 'tmp');
      fs.rmSync(tmp, { recursive: true, force: true });           // only this runtime's scratch, under its lock
      fs.mkdirSync(tmp, { mode: 0o700 });
      stops.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
      const prior = process.env.TMPDIR;
      process.env.TMPDIR = tmp;                                   // the archive's private scratch is made under os.tmpdir()
      try {
        archive = s3WitnessCache({ endpoint: a.endpoint, bucket: a.bucket, region: a.region, prefix: a.prefix, chainId: CHAIN_ID,
          credentials: archiveAccess, archive: a.writes, curl: config.hostTools.curl });
      } finally { if (prior === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prior; }
      stops.push(() => archive.close());
    }
    const gateway = createWitnessGateway({ upstreams: [...config.proofSources.untrusted], proofs: { checker, roots }, archive,
      methods: config.proofSources.accessListHint ? WITNESS_METHODS : NO_HINT });
    const gatewayUrl = await gateway.listen(0);
    stops.push(() => gateway.close());

    // 5. the native head source, fanning out to roots then relay
    let firstHead; const gotFirstHead = new Promise((r) => { firstHead = r; });
    const fanout = createHeadFanout({ roots, relay, onFirstHead: (meta) => { state.firstHead = { number: meta.number, hash: meta.hash, at: Date.now() }; firstHead(meta); } });
    const gossipDir = path.join(stateDir, 'gossip');
    const source = createGossipHeadSource({ listenerPath: bin.listener, listenerSha256: config.binaries.listener.sha256, chainId: CHAIN_ID, signer,
      workDir: gossipDir, onCommitment: fanout.onCommitment, sessionSecs: config.gossip.sessionSecs, maxPeers: config.gossip.maxPeers,
      discovery: config.gossip.discovery, restartIfNoHeadMs: config.gossip.restartIfNoHeadMs, extraEnv: listenerEnv });
    stops.push(() => source.stop());
    const trackSession = () => {
      const s = source.status().session;
      const key = 'listener';
      if (s?.pid) {
        const id = procIdentity(s.pid);
        if (id && id.pgid === s.pid && children.get(key)?.pid !== s.pid) { children.set(key, { role: 'listener', pid: s.pid, pgid: id.pgid, startTime: id.startTime }); recordChildren(); }
      } else if (children.delete(key)) recordChildren();
    };
    const port = config.verifier.port, verifierUrl = `http://127.0.0.1:${port}/`;
    // status: written from here on (starting, ready, degraded), so an operator sees WHY a runtime is not ready
    const status = () => {
      const g = source.status(), r = roots.stats(), rel = relay.status();
      const fresh = !!rel.head && g.fresh;
      return {
        format: STATUS_FORMAT, phase: state.failure ? 'failed' : state.stopping ? 'stopping' : state.readyAt ? (fresh ? 'ready' : 'degraded') : 'starting',
        failure: state.failure, verifierUrl, startedAt: state.startedAt, readyAt: state.readyAt, labels: LABELS,
        internal: { relayUrl, gatewayUrl, note: 'loopback, ephemeral; Helios consumes these, consumers use verifierUrl' },
        pins: { chainId: CHAIN_ID, unsafeSigner: signer, signerIsBaseMainnetDefault: signer === lower(BASE_MAINNET.unsafeSigner),
          binaries: Object.fromEntries(ROLES.map((x) => [x, { sha256: config.binaries[x].sha256, build: config.binaries[x].build }])) },
        head: { fresh, relay: rel.head ?? null, gossip: g.head, firstVerified: state.firstHead },
        roots: { signedHead: r.verified, ancestor: r.ancestors, refused: r.refused, conflicts: r.conflicts, bound: r.roots, ancestryRefused: r.ancestryRefused },
        fanout: { ...fanout.counters, relayRefused: { ...fanout.counters.relayRefused } },
        witnesses: { untrustedSources: config.proofSources.untrusted.map(rpcLabel), gateway: gateway.stats(), cache: 'none',
          archive: archive ? { endpoint: rpcLabel(config.witnessArchive.endpoint), writes: config.witnessArchive.writes, scratchMaxBytes: config.witnessArchive.writes ? ARCHIVE_SCRATCH_MAX_BYTES : 0, stats: archive.stats() } : null },
        gossip: { running: g.running, session: g.session, counters: g.counters, lastExit: g.lastExit },
        helios: helios ? { pid: helios.owned?.pid ?? null, exit: helios.exit } : null,
        reaped: state.reaped,
        binaries: { staging: config.binaryStaging, glibcRuntime: config.glibcRuntime ? { build: config.glibcRuntime.build, for: config.glibcRuntime.binaries } : null },
      };
    };
    const writeStatus = () => { try { writeJsonAtomic(statusFile, status()); } catch {} };
    await source.start();
    trackSession();
    const tracker = setInterval(() => { trackSession(); }, 500); tracker.unref?.();
    stops.push(() => clearInterval(tracker));
    writeStatus();
    statusTimer = setInterval(writeStatus, LIMITS.statusEveryMs); statusTimer.unref?.();
    stops.push(() => { clearInterval(statusTimer); fs.rmSync(statusFile, { force: true }); });
    log({ event: 'head-source-started' });
    const headTimer = sleep(config.limits.firstHeadTimeoutMs).then(() => null);
    const head = await Promise.race([gotFirstHead, headTimer, failed.then(() => null)]);
    if (!head) {
      const g = source.status();
      fail(state.failure || `no fresh verified head within ${config.limits.firstHeadTimeoutMs} ms (Helios not started; gossip ${JSON.stringify({ heads: g.counters.heads, delivered: g.counters.delivered, rejected: g.counters.rejected, lastExit: g.lastExit && { reason: g.lastExit.reason, exit: g.lastExit.exit, error: g.lastExit.error } })}, fanout ${JSON.stringify(fanout.counters)})`);
    }
    log({ event: 'first-head', number: head.number, hash: head.hash });

    // 6. Helios, only now; its port must be free (any address), then provably its own
    if (anyListener(port)) fail(`verifier port ${port} is already in use`);
    const home = path.join(runDir, 'helios-home');
    fs.mkdirSync(path.join(home, '.helios'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${signer}"\n`, { flag: 'wx', mode: 0o600 });
    const [heliosExe, heliosArgs] = viaGlibc('helios', ['opstack', '--network', 'base', '--consensus-rpc', relayUrl, '--execution-rpc', gatewayUrl,
      '--rpc-bind-ip', '127.0.0.1', '--rpc-port', String(port)]);
    const child = spawn(heliosExe, heliosArgs,
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { HOME: home, PATH: '/usr/bin:/bin', RUST_LOG: 'warn' } });
    const id = child.pid ? procIdentity(child.pid) : null;
    helios = { child, owned: id && id.pgid === child.pid ? { pid: child.pid, pgid: id.pgid, startTime: id.startTime } : null, exit: null, stderrTail: '' };
    if (helios.owned) { children.set('helios', { role: 'helios', ...helios.owned }); recordChildren(); }
    helios.exited = new Promise((r) => { child.once('exit', (code, sig) => { helios.exit = { code, signal: sig }; r(); }); child.once('error', (e) => { helios.exit ||= { error: e.code || e.message }; r(); }); });
    child.stderr.on('data', (d) => { helios.stderrTail = (helios.stderrTail + d).slice(-LIMITS.stderrTailBytes); });
    stops.push(async () => {
      if (!helios.exit && helios.owned) {
        await signalOwned(helios.owned, 'SIGTERM');
        if (!(await Promise.race([helios.exited.then(() => true), sleep(LIMITS.killGraceMs).then(() => false)]))) await signalOwned(helios.owned, 'SIGKILL');
      }
      await Promise.race([helios.exited, sleep(LIMITS.killGraceMs)]);
      if (helios.owned) await signalOwned(helios.owned, 'SIGKILL');    // any member of its group left behind
      children.delete('helios'); recordChildren();
    });
    if (!helios.owned) fail('Helios started without an owned process identity');
    helios.exited.then(() => { if (!state.stopping) failNow(`helios exited (${JSON.stringify(helios.exit)}): ${helios.stderrTail.slice(-400)}`); });
    const readyBy = Date.now() + config.limits.heliosReadyTimeoutMs;
    let owns = false;
    for (;;) {
      if (state.failure) fail(state.failure);
      if (Date.now() > readyBy) fail(`Helios was not ready within ${config.limits.heliosReadyTimeoutMs} ms`);
      const inodes = listeningInodes(port);
      if (inodes.length) {
        const mine = socketInodesOf(helios.owned.pid);
        if (!inodes.every((i) => mine.has(i))) fail(`verifier port ${port} is held by another process`);
        owns = true;
      }
      if (owns) {
        try {
          const [cid, n] = await Promise.all([rpc(verifierUrl, 'eth_chainId'), rpc(verifierUrl, 'eth_blockNumber')]);
          if (Number(cid) !== CHAIN_ID) fail(`Helios follows chain ${cid}`);
          if (BigInt(n) >= BigInt(head.number)) break;
        } catch (e) { if (/rpc runtime:/.test(e.message)) throw e; }
      }
      await sleep(LIMITS.readyPollMs);
    }

    // ready: files, supervision
    state.readyAt = Date.now(); state.phase = 'ready';
    writeJsonAtomic(readyFile, { format: STATUS_FORMAT, verifierUrl, pid: process.pid, readyAt: state.readyAt, firstHead: state.firstHead });
    stops.push(() => fs.rmSync(readyFile, { force: true }));
    writeStatus();
    log({ event: 'ready', verifierUrl, firstHead: state.firstHead });
    signal?.removeEventListener('abort', onAbort);
    const close = () => (closing ??= (async () => {
      state.stopping = true; log({ event: 'stopping' }); fs.rmSync(readyFile, { force: true }); await stopAll(); log({ event: 'stopped' });
    })());
    return { verifierUrl, status, failed, close, chainAuthority: { chainAuthority: 'verifier', chainVerifier: verifierUrl } };
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    failNow(e.message); state.stopping = true;
    await stopAll();
    throw e;
  }
}

/**
 * The process entry used by rpc-runtime-main.mjs (and by test launchers with their own opts): start, report events
 * as JSON lines on stdout, stop cleanly on SIGTERM/SIGINT (exit 0), exit 1 when startup or an essential child fails
 * (after cleanup), so the host service manager restarts it.
 */
export async function runRpcRuntimeProcess(config, opts = {}) {
  const log = (e) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  const startup = new AbortController();
  let rt = null, stopping = false;
  const stop = async (code) => { if (stopping) return; stopping = true; try { await rt?.close(); } finally { process.exit(code); } };
  const onSignal = () => { if (rt) stop(0); else startup.abort(); };       // during startup: abort it (it cleans up)
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try { rt = await startRpcRuntime(config, { ...opts, log, signal: startup.signal }); }
  catch (e) { log({ event: 'startup-failed', reason: String(e.message || e) }); process.exit(startup.signal.aborted ? 0 : 1); }
  const reason = await rt.failed;
  log({ event: 'exiting', reason });
  await stop(1);
}
