#!/usr/bin/env node
// metal/guest/measured-control.mjs -- the measured control guest of an INDEPENDENT host (direct-only, no Enclave service).
// Shipped in the image beside gsup.mjs (/opt/metal), so every byte of it is covered by the launch measurement.
//
// What it does, and why each piece exists (work/measured-control-interface.txt is the contract):
//   * canonicalDirectConfig: the owner's direct configuration (pins, RPC quorum, release, replicas, identity, guestd
//     endpoints). It arrives over fw_cfg, which is NOT measured, so it is BOUND instead: the launcher puts
//     hostDataHex(configDigest) in the SEV-SNP HOST_DATA field, the PSP signs HOST_DATA into every report, and
//     planDirectBoot refuses to start anything unless the report's HOST_DATA equals the digest of the config it was handed.
//   * planDirectBoot: the direct-only supervisor's environment and files, derived from that config alone. Every relay,
//     fleet, certificate, DNS and secrets service is off. Legacy inputs (relay URL, tunnel token, fleet secret, volumes)
//     are refused, never ignored.
//   * mintControlKeys: the keys the control process uses, minted HERE by PID 1 before any service starts:
//       - the proof-of-time key and the session key, written where supervisor.js already reuses them;
//       - the control TLS key, for the front below.
//   * controlStatement + reportDataFor: one canonical statement naming those keys, the config digest and HOST_DATA,
//     bound into a FRESH report per verifier nonce. report_data[0:32] = sha256(domain || sha256(statement) || nonce);
//     report_data[32:64] = CONTROL_ROLE, which an app guest (whose [32:64] is its AppID) can never present.
//   * createControlFront ("serve"): TLS with the minted control key.
//       - GET /.well-known/enclave-control?nonce=<64 hex> returns the evidence.
//       - Every other path is proxied, path and query only, to the in-guest supervisor on loopback.
//     A verifier that pins the attested key therefore talks to the measured supervisor end to end, through a host that
//     only forwards a TCP port.
// Node builtins only, plus viem resolved from the supervisor image (/app) for keccak where an address must be derived.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONFIG_FORMAT = 'enclave-direct-control-config/v1';
export const STATEMENT_FORMAT = 'enclave-measured-control-statement/v1';
export const EVIDENCE_FORMAT = 'enclave-measured-control-evidence/v1';
export const DOMAIN = 'enclave-measured-control/v1';
export const EVIDENCE_PATH = '/.well-known/enclave-control';
export const DEFAULT_CONTROL_PORT = 8444;
export const CHAIN_ID = 8453;
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
export const sha256Hex = (...parts) => sha256(...parts).toString('hex');
/** report_data[32:64] of every control report: a role, never an AppID (app guests put their AppID there). */
export const CONTROL_ROLE = sha256('enclave measured control guest role v1');
export const MAX_STATEMENT_BYTES = 8192;

export class ControlError extends Error { constructor(message) { super(message); this.name = 'ControlError'; } }
const bad = (m) => { throw new ControlError(m); };

// ---- canonical JSON ----------------------------------------------------------------------------------------------------
/** Sorted keys, no whitespace, strings/booleans/null/safe integers/arrays/objects only. Throws on anything else. */
export function canonicalJson(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) bad('canonical JSON carries only safe integers'); return String(v); }
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype || (v && Object.getPrototypeOf(v) === null))
    return '{' + Object.keys(v).sort().map((k) => { if (v[k] === undefined) bad(`canonical JSON: ${k} is undefined`); return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  return bad(`canonical JSON cannot carry ${typeof v}`);
}
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// ---- the owner's direct configuration -----------------------------------------------------------------------------------
const ADDR = /^0x[0-9a-fA-F]{40}$/, ZERO_ADDR = /^0x0{40}$/i, HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_CONTRACTS = ['registry', 'deployments', 'appCatalog', 'proofOfTime'];
const OPTIONAL_CONTRACTS = ['enclavePay', 'verificationFees', 'sessionVaultFactory', 'secretVaultV2'];
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
function only(o, allowed, what) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) bad(`${what} must be an object`);
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`${what} has unknown field(s): ${extra.join(', ')}`);
  const missing = allowed.filter((k) => !(k in o));
  if (missing.length) bad(`${what} is missing: ${missing.join(', ')}`);
}
function url(v, what) { let u; try { u = new URL(String(v)); } catch { bad(`${what} is not a URL`); } if (u.username || u.password || u.hash || String(v).includes('#')) bad(`${what} may not carry credentials or a fragment`); return u; }
const hostOf = (u) => u.hostname.toLowerCase().replace(/\.+$/, '');
const intIn = (v, lo, hi, what) => { if (!Number.isSafeInteger(v) || v < lo || v > hi) bad(`${what} must be an integer ${lo}..${hi}`); return v; };

/** The owner's config, strictly validated and canonical. Nothing is defaulted except controlPort. -> frozen object */
export function canonicalDirectConfig(raw) {
  // platformHostPolicy is OPTIONAL (absent in every existing config); every other key is required exactly as before
  const { platformHostPolicy: _platformHostPolicy, ...required } = raw && typeof raw === 'object' ? raw : {};
  only(raw && typeof raw === 'object' ? required : raw, ['format', 'chainId', 'contracts', 'profileDigest', 'rpcs', 'quorum', 'releaseId', 'replicas', 'identity', 'selling', 'isolation',
    'hostAdmissionSha256', 'controlPort'], 'direct config');
  if (raw.format !== CONFIG_FORMAT) bad(`direct config format must be ${CONFIG_FORMAT}`);
  if (raw.chainId !== CHAIN_ID) bad(`direct config chainId must be ${CHAIN_ID}`);
  only(raw.contracts, [...REQUIRED_CONTRACTS, ...OPTIONAL_CONTRACTS], 'direct config contracts');
  const contracts = {};
  for (const k of [...REQUIRED_CONTRACTS, ...OPTIONAL_CONTRACTS]) {
    const a = raw.contracts[k];
    if (typeof a !== 'string' || !ADDR.test(a)) bad(`contracts.${k} must be an address`);
    if (REQUIRED_CONTRACTS.includes(k) && ZERO_ADDR.test(a)) bad(`contracts.${k} must be nonzero`);
    contracts[k] = a.toLowerCase();
  }
  if (raw.profileDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(raw.profileDigest)) bad('profileDigest must be null or sha256:<64 hex>');
  if (!Array.isArray(raw.rpcs) || raw.rpcs.length < 2 || raw.rpcs.length > 8) bad('rpcs: 2 to 8 https RPC URLs');
  const seen = new Set();
  const rpcs = raw.rpcs.map((r, i) => {
    const u = url(r, `rpcs[${i}]`);
    if (u.protocol !== 'https:') bad(`rpcs[${i}] must be https (the control guest has no loopback chain)`);
    const h = hostOf(u); if (!h || h.split('.').some((l) => !l)) bad(`rpcs[${i}] has a malformed host`);
    if (seen.has(h)) bad(`rpcs[${i}] repeats a host: a quorum needs distinct hosts`); seen.add(h);
    // the form cli/independent.mjs validateRpcOrigins writes: the bare origin when there is no path, else the full href
    const canonical = u.href.replace(/\/$/, '') === u.origin ? u.origin : u.href;
    if (canonical !== String(r)) bad(`rpcs[${i}] must be written in normalized form (${canonical})`);
    return canonical;
  });
  const quorum = intIn(raw.quorum, 2, rpcs.length, 'quorum');
  if (typeof raw.releaseId !== 'string' || !HEX64.test(raw.releaseId)) bad('releaseId must be the 64-hex release pin');
  only(raw.replicas, ['gateways', 'storagePlan'], 'replicas');
  if (!Array.isArray(raw.replicas.gateways) || raw.replicas.gateways.length < 1 || raw.replicas.gateways.length > 8) bad('replicas.gateways: 1 to 8 origins');
  const gateways = raw.replicas.gateways.map((g, i) => {
    const u = url(g, `replicas.gateways[${i}]`);
    if (u.origin !== String(g)) bad(`replicas.gateways[${i}] must be written as an origin`);
    if (u.protocol === 'http:' && !IPV4.test(u.hostname)) bad(`replicas.gateways[${i}]: plain HTTP only for a literal IPv4 address`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`replicas.gateways[${i}] must be http(s)`);
    return u.origin;
  });
  const storagePlan = raw.replicas.storagePlan;
  if (storagePlan !== null && (typeof storagePlan !== 'object' || Array.isArray(storagePlan) || canonicalJson(storagePlan).length > 65536)) bad('replicas.storagePlan must be null or a JSON object up to 64 KiB');
  only(raw.identity, ['publicUrl', 'repo', 'operator'], 'identity');
  const pu = url(raw.identity.publicUrl, 'identity.publicUrl');
  if (pu.protocol !== 'https:' || pu.search || pu.href.replace(/\/+$/, '') !== raw.identity.publicUrl) bad('identity.publicUrl: https, exactly as registered (no trailing slash, query or fragment)');
  if (/(^|\.)enclave\.host$/i.test(hostOf(pu))) bad('identity.publicUrl is an Enclave relay name; an independent host is reached at its own endpoint');
  if (typeof raw.identity.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.identity.repo)) bad('identity.repo: owner/name');
  if (typeof raw.identity.operator !== 'string' || !ADDR.test(raw.identity.operator) || ZERO_ADDR.test(raw.identity.operator)) bad('identity.operator: the operator address');
  only(raw.selling, ['cpuPrice6', 'payout'], 'selling');
  if (raw.selling.cpuPrice6 !== null) intIn(raw.selling.cpuPrice6, 1, 1e12, 'selling.cpuPrice6');
  if (raw.selling.payout !== null && (typeof raw.selling.payout !== 'string' || !ADDR.test(raw.selling.payout) || ZERO_ADDR.test(raw.selling.payout))) bad('selling.payout: a nonzero address or null');
  only(raw.isolation, ['managerUrl', 'dataAddr'], 'isolation');
  const mu = /^http:\/\/([0-9.]+):(\d{1,5})$/.exec(String(raw.isolation.managerUrl));
  if (!mu || !IPV4.test(mu[1]) || Number(mu[2]) < 1 || Number(mu[2]) > 65535) bad('isolation.managerUrl must be http://<IPv4>:<port>');
  const da = /^([0-9.]+):(\d{1,5})$/.exec(String(raw.isolation.dataAddr));
  if (!da || !IPV4.test(da[1]) || Number(da[2]) < 1 || Number(da[2]) > 65535) bad('isolation.dataAddr must be <IPv4>:<port>');
  if (raw.hostAdmissionSha256 !== null && !(typeof raw.hostAdmissionSha256 === 'string' && HEX64.test(raw.hostAdmissionSha256))) bad('hostAdmissionSha256 must be null or 64 hex');
  const controlPort = intIn(raw.controlPort, 1, 65535, 'controlPort');
  if ([8080, 8091, 8443].includes(controlPort)) bad('controlPort must not be a port another guest service listens on');
  return deepFreeze({
    format: CONFIG_FORMAT, chainId: CHAIN_ID, contracts, profileDigest: raw.profileDigest, rpcs, quorum, releaseId: raw.releaseId,
    replicas: { gateways, storagePlan: storagePlan === null ? null : JSON.parse(canonicalJson(storagePlan)) },
    identity: { publicUrl: raw.identity.publicUrl, repo: raw.identity.repo, operator: raw.identity.operator.toLowerCase() },
    selling: { cpuPrice6: raw.selling.cpuPrice6, payout: raw.selling.payout === null ? null : raw.selling.payout.toLowerCase() },
    isolation: { managerUrl: raw.isolation.managerUrl, dataAddr: raw.isolation.dataAddr },
    hostAdmissionSha256: raw.hostAdmissionSha256, controlPort,
    // the admin's anchored platform host policy authority (network/host-policy-runtime.mjs); present only when set, so
    // every existing config keeps its digest. The book here is the policy AUTHORITY, not a contract resolver.
    ...(raw.platformHostPolicy === undefined || raw.platformHostPolicy === null ? {} : { platformHostPolicy: platformPolicySection(raw.platformHostPolicy) }),
  });
}
export const configDigest = (cfg) => sha256Hex(canonicalJson(cfg));
/** The 32-byte HOST_DATA the launcher sets and the guest requires, as hex. */
export const hostDataHex = (digestHex) => { if (!HEX64.test(String(digestHex))) bad('config digest must be 64 hex'); return sha256Hex(`${DOMAIN}\nconfig ${digestHex}\n`); };
/** The digest of the existing fw_cfg hostAdmission object (null when there is none). */
export const hostAdmissionDigest = (obj) => (obj === undefined || obj === null ? null : sha256Hex(canonicalJson(obj)));
export const contractPinsDoc = (cfg) => ({ version: 1, chainId: CHAIN_ID, contracts: { ...cfg.contracts } });

// ---- the direct-only supervisor ------------------------------------------------------------------------------------------
export const GUEST_PATHS = Object.freeze({
  runDir: '/run/measured-control', pins: '/run/measured-control/contract-pins.json', storagePlan: '/run/measured-control/storage-plan.json',
  pairKey: '/run/guestd-pair.key', sessionDir: '/mnt/ramdisk/enclave-session', acmeDir: '/mnt/ramdisk/enclave-acme',
  statement: '/run/measured-control/statement.json', tlsKey: '/run/measured-control/tls-key.pem', tlsCert: '/run/measured-control/tls-cert.pem',
  serveConfig: '/run/measured-control/serve.json', status: '/run/measured-control.json',
});
// The baked flavor env (enclaves/cpu/config.yml) is the HOSTED fleet's: it names the Enclave address book, Enclave's own
// payout wallet, SIWE/CORS origins at enclave.host. A direct guest inherits only these authority-free tunables from it.
export const DIRECT_FLAVOR_KEYS = Object.freeze(['CHAIN_ID', 'USDC_ADDRESS', 'PAYMENT_WINDOW_SEC', 'GRACE_SEC', 'PAY_POLL_SEC', 'SESSION_TTL']);
/** The supervisor environment for a measured direct-only control guest. Secrets come in `secrets`, never from config. */
function platformPolicySection(p) {
  only(p, ['book', 'hostOwnership', 'mirrors'], 'platformHostPolicy');
  for (const k of ['book', 'hostOwnership']) if (typeof p[k] !== 'string' || !ADDR.test(p[k]) || ZERO_ADDR.test(p[k])) bad(`platformHostPolicy.${k} must be a nonzero address`);
  if (!Array.isArray(p.mirrors) || p.mirrors.length < 1 || p.mirrors.length > 8) bad('platformHostPolicy.mirrors: 1 to 8 https URLs');
  const mirrors = p.mirrors.map((m, i) => { const u = url(m, `platformHostPolicy.mirrors[${i}]`); if (u.protocol !== 'https:' || u.search || u.hash) bad(`platformHostPolicy.mirrors[${i}] must be https`); return u.href.replace(/\/+$/, ''); });
  return { book: p.book.toLowerCase(), hostOwnership: p.hostOwnership.toLowerCase(), mirrors };
}
export function directSupervisorEnv(cfg, { paths = GUEST_PATHS, capacity = {}, secrets = {}, hostPolicyEnv = {}, flavorEnv = {} } = {}) {
  const selling = !!secrets.operatorKey;
  const env = {
    ...Object.fromEntries(DIRECT_FLAVOR_KEYS.filter((k) => typeof flavorEnv[k] === 'string').map((k) => [k, flavorEnv[k]])),
    ...hostPolicyEnv,
    NODE_VCPUS: String(capacity.vcpus ?? 1), NODE_RAM_GB: String(capacity.ramGb ?? 1), NODE_GFLOPS: String(capacity.gflops ?? 1),
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', PORT: '8080', GPU_COUNT: '0',
    // the mode and the tier: owner-committed startup deployments only, each in its own SEV-SNP guest launched by guestd
    ISOLATION_DIRECT_ONLY: '1', ISOLATION_BACKEND: 'snp-guest-per-app', PROVISION_BACKEND: 'vm',
    VMMGR_URL: cfg.isolation.managerUrl, GUESTD_KEY_FILE: paths.pairKey, GUESTD_DATA_ADDR: cfg.isolation.dataAddr,
    // chain authorities: the owner's pins and RPCs; no address book
    ENCLAVE_CONTRACT_PINS_FILE: paths.pins, ADDRESS_BOOK_ADDRESS: '', BASE_RPC: cfg.rpcs[0], BASE_RPCS: cfg.rpcs.join(','),
    // package and component replicas the owner chose
    ...(cfg.replicas.storagePlan ? { GUEST_BOOTSTRAP_STORAGE_PLAN_FILE: paths.storagePlan } : { GUEST_BOOTSTRAP_GATEWAYS: cfg.replicas.gateways.map((g) => g + '/ipfs').join(',') }),
    IPFS_GATEWAY: JSON.stringify(cfg.replicas.gateways),
    // every Enclave service explicitly off (unset would mean the Enclave default)
    SECRETS_API: '', DOMAINS_API: '', CERTS_API: '', DNS_API: '', APP_CERT_DOMAIN: '', ISOLATION_RELEASE: '',
    // identity
    PUBLIC_URL: cfg.identity.publicUrl, ENCLAVE_REPO: cfg.identity.repo,
    REGISTRY_ENABLED: selling ? '1' : '0', CLAIM_ENABLED: selling ? '1' : '0',
    ...(selling ? { REGISTRY_PRIVATE_KEY: secrets.operatorKey } : {}),
    ...(cfg.selling.cpuPrice6 !== null ? { SELL_CPU_PRICE6: String(cfg.selling.cpuPrice6) } : {}),
    ...(cfg.selling.payout ? { PAYOUT_ADDRESS: cfg.selling.payout } : {}),
    // in-guest state: the keys PID 1 minted, the agent's loopback document, tmpfs certificate store
    SESSION_KEY_DIR: paths.sessionDir, ACME_STORE_DIR: paths.acmeDir,
    ATTESTATION_URL: 'http://127.0.0.1:8443/.well-known/enclave-attestation', RAD_CACHE_MS: '15000',
    SECRETS_CAPABLE: '0', FLEET_SECRET_PRESENT: '0',
    SECRET: secrets.secret || '', ADMIN_TOKEN: secrets.adminToken || '',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
    // measured platform host policy: the supervisor's measured host gate (network/host-policy-adapters.mjs measuredHostGate)
    // checks THIS host (keccak256(PUBLIC_URL)) at agreed blocks over the measured RPC quorum before claiming or serving
    ...(cfg.platformHostPolicy ? { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify(cfg.platformHostPolicy), ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.rpcs.join(',') } : {}),
  };
  return env;
}
/** The rules supervisor.js directOnlyProblems applies at startup, plus this guest's own (no Enclave origin, keys present). */
export function directEnvProblems(env) {
  const out = [], v = (k) => String(env[k] ?? '').trim();
  if (v('ISOLATION_DIRECT_ONLY') !== '1') out.push('ISOLATION_DIRECT_ONLY must be 1');
  if (v('ISOLATION_BACKEND') !== 'snp-guest-per-app') out.push('ISOLATION_BACKEND must be snp-guest-per-app');
  if (v('PROVISION_BACKEND') !== 'vm') out.push('PROVISION_BACKEND must be vm');
  if (!v('ENCLAVE_CONTRACT_PINS_FILE')) out.push('ENCLAVE_CONTRACT_PINS_FILE must pin the contracts');
  if (v('ADDRESS_BOOK_ADDRESS')) out.push('ADDRESS_BOOK_ADDRESS must be empty');
  if (!v('GUEST_BOOTSTRAP_STORAGE_PLAN_FILE') && !v('GUEST_BOOTSTRAP_GATEWAYS')) out.push('package replicas must be named');
  if (!v('GUEST_BOOTSTRAP_STORAGE_PLAN_FILE') && !v('IPFS_GATEWAY')) out.push('IPFS_GATEWAY must name the component replicas');
  for (const k of ['SECRETS_API', 'DOMAINS_API', 'CERTS_API', 'DNS_API', 'APP_CERT_DOMAIN']) if (!(k in env) || v(k)) out.push(`${k} must be set and empty`);
  if (/^(1|true|on)$/i.test(v('ISOLATION_RELEASE'))) out.push('ISOLATION_RELEASE must be off');
  if (!/^[0-9a-f]{64}$/.test(v('SECRET'))) out.push('SECRET must be a per-boot 64-hex value minted in the guest');
  for (const [k, val] of Object.entries(env)) if (/enclave\.host/i.test(String(val))) out.push(`${k} names an Enclave origin`);
  return out;
}

// ---- viem from the supervisor image (keccak for an address) ----------------------------------------------------------------
let _viem = null;
export async function loadViem() {
  if (_viem) return _viem;
  for (const base of ['/app/package.json', import.meta.url]) {
    try { _viem = await import(pathToFileURL(createRequire(base).resolve('viem')).href); return _viem; } catch {}
  }
  try { _viem = await import('viem'); return _viem; } catch { bad('cannot resolve viem (looked in /app and beside this file): an operator key cannot be checked'); }
}
/** 0x-address of an uncompressed secp256k1 public key ("04" + x + y, hex), via keccak. */
export function addressOfPublicKey(publicKeyHex, keccak256) {
  if (!/^04[0-9a-f]{128}$/.test(String(publicKeyHex))) bad('not an uncompressed secp256k1 public key');
  return ('0x' + keccak256(Buffer.from(publicKeyHex.slice(2), 'hex')).slice(-40)).toLowerCase();
}
const keccakOf = (viem) => (bytes) => viem.keccak256(bytes);
/** The uncompressed secp256k1 public key of a 0x-hex private key (node crypto). */
export function secp256k1PublicKey(privHex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(privHex))) bad('not a 32-byte hex private key');
  const der = Buffer.concat([Buffer.from('302e0201010420', 'hex'), Buffer.from(privHex.slice(2), 'hex'), Buffer.from('a00706052b8104000a', 'hex')]);
  const jwk = createPublicKey({ key: der, format: 'der', type: 'sec1' }).export({ format: 'jwk' });
  return '04' + Buffer.from(jwk.x, 'base64url').toString('hex').padStart(64, '0') + Buffer.from(jwk.y, 'base64url').toString('hex').padStart(64, '0');
}

// ---- the boot decision ------------------------------------------------------------------------------------------------------
const cmdToken = (cmdline, key) => (String(cmdline).match(new RegExp(`(?:^|\\s)metal\\.${key}=([^\\s]+)`)) || [])[1] || '';
/**
 * Decide a direct control boot from the MEASURED cmdline, the fw_cfg object and the report's HOST_DATA.
 * -> { ok:true, config, digest, hostData, bound, mode, env, files, operator } | { ok:false, reasons }
 * Never throws for bad input: every reason is listed so the console says all of them at once.
 */
export async function planDirectBoot({ cmdline, fw = {}, reportHostData = '', capacity = {}, hostPolicyEnv = {}, flavorEnv = {}, paths = GUEST_PATHS, viem = null, secret = null, adminToken = null } = {}) {
  const reasons = [];
  const control = cmdToken(cmdline, 'control'), iso = cmdToken(cmdline, 'isolation'), mode = cmdToken(cmdline, 'mode') || fw.mode || 'snp';
  if (control !== 'direct') reasons.push(`the measured cmdline says metal.control=${control || '(absent)'}, not direct`);
  if (iso !== 'snp-guest-per-app') reasons.push('a direct control guest runs the per-app SEV-SNP tier: the measured cmdline must carry metal.isolation=snp-guest-per-app');
  if (fw.mode && fw.mode !== mode) reasons.push(`fw_cfg mode ${fw.mode} differs from the measured mode ${mode}`);
  if (!['snp', 'dev'].includes(mode)) reasons.push(`mode ${mode}: HOST_DATA binding is implemented for SEV-SNP only (dev is a lab launch that proves nothing)`);
  for (const k of ['relayUrl', 'relayHost', 'tunnelToken', 'fleetSecret', 'certsApi', 'acmeEabKid', 'acmeEabHmac'])
    if (fw[k]) reasons.push(`fw_cfg ${k} is set: a direct control guest takes no relay, fleet, certificate or ACME input`);
  if (Array.isArray(fw.volumes) && fw.volumes.length) reasons.push('fw_cfg volumes: a control guest runs no apps, so it mounts no model volumes');
  let config = null, digest = null, hostData = null;
  try { config = canonicalDirectConfig(fw.direct); digest = configDigest(config); hostData = hostDataHex(digest); }
  catch (e) { reasons.push(`fw_cfg direct: ${e.message}`); }
  if (config) {
    if (fw.publicUrl && fw.publicUrl !== config.identity.publicUrl) reasons.push('fw_cfg publicUrl differs from the bound direct config');
    const had = hostAdmissionDigest(fw.hostAdmission);
    if (had !== config.hostAdmissionSha256) reasons.push(`fw_cfg hostAdmission digest ${had ? had.slice(0, 16) + '…' : 'none'} is not the bound ${config.hostAdmissionSha256 ? config.hostAdmissionSha256.slice(0, 16) + '…' : 'none'}`);
    const fi = fw.isolation || {};
    if (fi.managerUrl !== config.isolation.managerUrl || fi.dataAddr !== config.isolation.dataAddr) reasons.push('fw_cfg isolation endpoints differ from the bound direct config');
    if (!/^[0-9a-f]{64}$/.test(String(fi.pairingKey || ''))) reasons.push('fw_cfg isolation.pairingKey (the guestd pairing key) is missing');
    if (fi.release === true) reasons.push('isolation.release is on: direct startup takes no relay ticket');
  }
  // the binding: HOST_DATA from the PSP-signed report must name exactly this config
  const bound = mode === 'snp' && !!hostData && String(reportHostData).toLowerCase() === hostData;
  if (mode === 'snp' && hostData && !bound)
    reasons.push(`HOST_DATA ${reportHostData ? String(reportHostData).slice(0, 16) + '…' : '(unreadable)'} does not bind this config (expected ${hostData.slice(0, 16)}…): the host handed over a config the hardware is not attesting to`);
  // the operator key, when the host sells: it must be the operator the owner named
  let operator = null;
  if (fw.registryKey) {
    try {
      const v = viem || await loadViem();
      operator = addressOfPublicKey(secp256k1PublicKey(fw.registryKey), keccakOf(v));
      if (config && operator !== config.identity.operator) reasons.push(`the operator key is ${operator}, not the bound operator ${config.identity.operator}`);
    } catch (e) { reasons.push(`registryKey: ${e.message}`); }
  }
  if (reasons.length) return { ok: false, reasons, mode, digest, hostData };
  const s = secret || randomBytes(32).toString('hex'), a = adminToken || randomBytes(32).toString('hex');
  const env = directSupervisorEnv(config, { paths, capacity, hostPolicyEnv, flavorEnv, secrets: { operatorKey: fw.registryKey || null, secret: s, adminToken: a } });
  const problems = directEnvProblems(env);
  if (problems.length) return { ok: false, reasons: problems.map((p) => `derived environment: ${p}`), mode, digest, hostData };
  const files = { [paths.pins]: JSON.stringify(contractPinsDoc(config)), [paths.pairKey]: fw.isolation.pairingKey + '\n',
    ...(config.replicas.storagePlan ? { [paths.storagePlan]: JSON.stringify(config.replicas.storagePlan) } : {}) };
  return { ok: true, config, digest, hostData, bound, mode, env, files, operator, selling: !!fw.registryKey };
}

// ---- keys minted in the guest ---------------------------------------------------------------------------------------------
// A minimal self-signed X.509 v3 certificate (ECDSA P-256 / SHA-256): clients never validate it against a CA, they pin
// the SPKI the attested statement names. Encoded here so the guest needs no openssl.
const der = (tag, ...parts) => { const body = Buffer.concat(parts); const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]); };
const oid = (dotted) => { const p = dotted.split('.').map(Number); const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) { const b = []; let x = v; do { b.unshift(x & 127); x = Math.floor(x / 128); } while (x); for (let i = 0; i < b.length - 1; i++) b[i] |= 128; out.push(...b); }
  return der(0x06, Buffer.from(out)); };
const utcTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
export function selfSignedCert(privateKey, publicKey, { cn = 'enclave-measured-control', days = 3650, now = new Date() } = {}) {
  const alg = der(0x30, oid('1.2.840.10045.4.3.2'));
  const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
  const serial = randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const tbs = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), alg, name,
    der(0x30, utcTime(new Date(now.getTime() - 3600e3)), utcTime(new Date(now.getTime() + days * 86400e3))), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const sig = cryptoSign('sha256', tbs, privateKey);
  const cert = der(0x30, tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
const writePrivate = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); fs.chmodSync(file, 0o600); };
/**
 * Mint this boot's control keys and write them where their users read them. Existing files are REPLACED: PID 1 runs once
 * per boot, on tmpfs, so a file already there was not minted by this boot.
 * -> { proof: { publicKey }, session: { jwk }, controlTls: { spkiDer, spkiSha256, certPem } } (public halves only)
 */
export function mintControlKeys({ paths = GUEST_PATHS } = {}) {
  const proof = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const pj = proof.privateKey.export({ format: 'jwk' });
  const proofPriv = '0x' + Buffer.from(pj.d, 'base64url').toString('hex').padStart(64, '0');
  writePrivate(path.join(paths.sessionDir, 'proof-secp256k1.hex'), proofPriv);
  const session = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writePrivate(path.join(paths.sessionDir, 'session-ec-p256.pkcs8.pem'), session.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const sj = session.publicKey.export({ format: 'jwk' });
  const tlsPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const certPem = selfSignedCert(tlsPair.privateKey, tlsPair.publicKey);
  writePrivate(paths.tlsKey, tlsPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(paths.tlsCert, certPem, { mode: 0o644 });
  const spkiDer = tlsPair.publicKey.export({ type: 'spki', format: 'der' });
  return { proof: { publicKey: secp256k1PublicKey(proofPriv) }, session: { jwk: { kty: sj.kty, crv: sj.crv, x: sj.x, y: sj.y } },
    controlTls: { spkiDer, spkiSha256: sha256Hex(spkiDer), certPem } };
}
/** RFC 7638 thumbprint, exactly as supervisor.js jwkThumbprint computes the session kid. */
export const jwkThumbprint = (jwk) => sha256(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).toString('base64url');

// ---- the statement and its binding ---------------------------------------------------------------------------------------
export function controlStatement({ config, digest, hostData, mode, keys, runtime = {}, bootId = randomBytes(16).toString('hex') }) {
  const obj = { format: STATEMENT_FORMAT, role: 'direct-control', mode, chainId: CHAIN_ID, configDigest: digest, hostData,
    identity: { publicUrl: config.identity.publicUrl, operator: config.identity.operator },
    keys: { proof: { curve: 'secp256k1', publicKey: keys.proof.publicKey }, session: keys.session.jwk, controlTls: { spkiSha256: keys.controlTls.spkiSha256 } },
    runtime: { gsupSha256: runtime.gsupSha256 ?? null, helperSha256: runtime.helperSha256 ?? null, supervisorSha256: runtime.supervisorSha256 ?? null },
    bootId };
  const text = canonicalJson(obj);
  if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) bad('control statement too large');
  return { text, obj };
}
/** Strictly parse a served statement: canonical bytes, known shape. -> object (throws ControlError) */
export function parseStatement(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STATEMENT_BYTES) bad('statement must be a string up to 8 KiB');
  let o; try { o = JSON.parse(text); } catch { bad('statement is not JSON'); }
  if (canonicalJson(o) !== text) bad('statement is not in canonical form: the bound bytes are exactly the served bytes');
  only(o, ['format', 'role', 'mode', 'chainId', 'configDigest', 'hostData', 'identity', 'keys', 'runtime', 'bootId'], 'statement');
  if (o.format !== STATEMENT_FORMAT || o.role !== 'direct-control' || o.chainId !== CHAIN_ID) bad('statement format, role or chain is not a direct control statement');
  if (!HEX64.test(o.configDigest) || !HEX64.test(o.hostData) || !/^[0-9a-f]{32}$/.test(o.bootId)) bad('statement digests or boot id malformed');
  only(o.identity, ['publicUrl', 'operator'], 'statement identity'); only(o.keys, ['proof', 'session', 'controlTls'], 'statement keys');
  only(o.keys.proof, ['curve', 'publicKey'], 'statement proof key');
  if (o.keys.proof.curve !== 'secp256k1' || !/^04[0-9a-f]{128}$/.test(o.keys.proof.publicKey)) bad('statement proof key malformed');
  only(o.keys.session, ['crv', 'kty', 'x', 'y'], 'statement session key');
  if (o.keys.session.kty !== 'EC' || o.keys.session.crv !== 'P-256') bad('statement session key is not P-256');
  only(o.keys.controlTls, ['spkiSha256'], 'statement control TLS key');
  if (!HEX64.test(o.keys.controlTls.spkiSha256)) bad('statement control TLS key digest malformed');
  return o;
}
/** report_data for one request: [0:32] = sha256(DOMAIN "\n" || sha256(statement) || nonce), [32:64] = CONTROL_ROLE. */
export function reportDataFor(statementText, nonce) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) bad('nonce must be 32 bytes');
  return Buffer.concat([sha256(DOMAIN + '\n', sha256(statementText), nonce), CONTROL_ROLE]);
}
export const bindingFor = (statementText, nonce) => reportDataFor(statementText, nonce).subarray(0, 32);

// ---- reports ----------------------------------------------------------------------------------------------------------------
/** A configfs-tsm reporter (the agent's mechanism): 64 bytes in, the raw report and the certificate table out. */
export function configfsReporter({ root = '/sys/kernel/config/tsm/report', vcekB64 = '' } = {}) {
  const fallback = vcekB64 ? (() => { const d = Buffer.from(vcekB64, 'base64'); const h = Buffer.alloc(48);
    Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(h, 0); h.writeUInt32LE(48, 16); h.writeUInt32LE(d.length, 20); return Buffer.concat([h, d]); })() : null;
  let seq = 0;
  return async (reportData) => {
    if (!Buffer.isBuffer(reportData) || reportData.length !== 64) bad('report data must be 64 bytes');
    const dir = path.join(root, `control-${process.pid}-${seq++}`);
    fs.mkdirSync(dir);
    try {
      fs.writeFileSync(path.join(dir, 'inblob'), reportData);
      const report = fs.readFileSync(path.join(dir, 'outblob'));
      let certs = null; try { certs = fs.readFileSync(path.join(dir, 'auxblob')); } catch {}
      if ((!certs || !certs.length) && fallback) certs = fallback;
      return { report, certs };
    } finally { try { fs.rmdirSync(dir); } catch {} }
  };
}
/** HOST_DATA (bytes 0xC0..0xE0) of a raw SNP report, hex, or '' when the report is too short. */
export const hostDataOfReport = (report) => (Buffer.isBuffer(report) && report.length >= 0xe0 ? report.subarray(0xc0, 0xe0).toString('hex') : '');

// ---- the control front ----------------------------------------------------------------------------------------------------
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
/**
 * The TLS front of the control guest. evidence: GET EVIDENCE_PATH?nonce=<64 hex>. Anything else: proxied to the
 * in-guest supervisor, path and query only (never an absolute URL: no SSRF through the front).
 * opts: { statementText, keyPem, certPem, reporter(reportData64) -> {report, certs}, upstream: {host, port}, mode }
 */
export function createControlFront({ statementText, keyPem, certPem, reporter, upstream = { host: '127.0.0.1', port: 8080 }, mode = 'snp', maxQueue = 8 }) {
  parseStatement(statementText);
  let chain = Promise.resolve(), queued = 0;
  const evidence = async (nonce) => {
    if (mode !== 'snp') return { format: EVIDENCE_FORMAT, statement: statementText, report: null, unattested: `mode ${mode}: no hardware report`, certificate: certPem };
    const { report, certs } = await reporter(reportDataFor(statementText, nonce));
    return { format: EVIDENCE_FORMAT, statement: statementText, report: report.toString('base64'), ...(certs && certs.length ? { certs: certs.toString('base64') } : {}), certificate: certPem };
  };
  const json = (res, status, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b); };
  return https.createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2', requestTimeout: 30000, headersTimeout: 15000 }, (req, res) => {
    const target = String(req.url || '');
    if (!target.startsWith('/') || target.startsWith('//')) return json(res, 400, { error: 'bad_request_target' });
    const u = new URL('http://control.invalid' + target);
    if (u.pathname === EVIDENCE_PATH) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method' });
      const n = u.searchParams.get('nonce') || '';
      if (!/^[0-9a-f]{64}$/.test(n)) return json(res, 400, { error: 'nonce', message: 'nonce must be 64 lowercase hex characters (32 bytes) chosen by the verifier' });
      if (queued >= maxQueue) return json(res, 429, { error: 'busy' });
      queued++;
      const job = chain.then(() => evidence(Buffer.from(n, 'hex')));
      chain = job.catch(() => {});
      job.then((e) => json(res, 200, e), (e) => json(res, 503, { error: 'report_unavailable', message: String(e?.message || e).slice(0, 200) }))
        .finally(() => { queued--; });
      return;
    }
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const up = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      const h = {}; for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(r.statusCode || 502, h); r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'supervisor_unreachable' }); else res.destroy(); });
    req.pipe(up);
  });
}

// ---- `node measured-control.mjs serve --config FILE` (started by gsup) ----------------------------------------------------
async function serveMain(argv) {
  const i = argv.indexOf('--config');
  const cfg = JSON.parse(fs.readFileSync(i > 0 ? argv[i + 1] : GUEST_PATHS.serveConfig, 'utf8'));
  const front = createControlFront({ statementText: fs.readFileSync(cfg.statement, 'utf8'), keyPem: fs.readFileSync(cfg.tlsKey, 'utf8'),
    certPem: fs.readFileSync(cfg.tlsCert, 'utf8'), reporter: configfsReporter({ vcekB64: cfg.vcekB64 || '' }), upstream: cfg.upstream, mode: cfg.mode });
  front.listen(cfg.port, '0.0.0.0', () => console.log(`[control] measured control front on :${cfg.port} (mode ${cfg.mode}); evidence at ${EVIDENCE_PATH}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'serve')
  serveMain(process.argv).catch((e) => { console.error(`[control] ${e.message}`); process.exit(1); });
