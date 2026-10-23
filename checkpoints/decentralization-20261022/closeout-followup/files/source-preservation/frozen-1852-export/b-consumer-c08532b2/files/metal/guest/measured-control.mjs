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
//   * leaseGas (optional): the owner's reviewed app-funded lease-gas configuration (network/lease-gas-conduit.mjs), inside
//     the config, so HOST_DATA binds it like every other field; it becomes the supervisor's ENCLAVE_LEASE_GAS_* and record
//     file. Absent: the config, its digest and the supervisor's environment are exactly what they were.
//   * mcp (optional): the hosted independent MCP adapter (mcp/server.mjs --remote, bundled into the image as
//     /opt/metal/mcp-server.bundle.mjs, docs/network/hosted-mcp.md). It answers under THIS guest's bound authority:
//     the config's own contract pins, RPC quorum and admin AddressBook resolution, plus the MCP-only fields below, all
//     bound by HOST_DATA. It listens on loopback only. The front routes exactly MCP_ROUTE to it, so a client that verified
//     this guest and pinned its TLS key talks to the measured adapter end to end. Absent: nothing about the config, its
//     digest, the statement or the services changes.
//   * platformApi (optional): the PLATFORM API as a measured host role (metal/guest/platform-api-role.mjs, bundled as
//     /opt/metal/platform-api.bundle.mjs; docs/network/hosted-platform-api.md). The member is identical on every host of
//     the group and bound by HOST_DATA like the rest; its relayEnv is public configuration only (secrets arrive later,
//     sealed to this boot). PID 1 mints the role's handoff key and the statement names it (keys.platformApi), so a member
//     seals the group's state key only to this attested boot. The front routes Host = platformApi.hostname to the role's
//     API port and /platform-api/* to its peer port. Absent: the config, its digest, the statement and the services are
//     exactly what they were.
//   * nativeControl (optional, needs platformApi): the native control names (api/mcp.enclavehost.eth) this guest serves
//     itself. A native client verifies those names with the existing native CA, so the front presents, for exactly these
//     SNI names, a CA-issued leaf whose public key is THIS boot's attested control TLS key: the private key never leaves the
//     guest, the leaf is public and is issued outside it (scripts/native-control-certificate.mjs), and it is installed over
//     the front (NATIVE_CERT_PATH), which accepts it only after a real TLS handshake under the bound CA proves it covers
//     every bound name with this guest's own key. The statement names the bound names and CA, so a verifier binds the
//     native endpoint to this attested boot, its registry entry and the platform host policy decision for it. No leaf, an
//     expired one, or SNI and Host that disagree: the native name is refused, never served under another key or route.
//     Both names reach the platform API role (mcp.enclavehost.eth as the relay's own /mcp). Absent: nothing changes.
//   * platformPolicyCarriers (optional): how THIS guest's platform host policy gate (supervisor.js, the shared
//     windows/node/host-admission.bundle.mjs createHostServiceGate) obtains the administrator's ANCHORED policy document
//     without a fleet mirror: { peers?: [http(s) base URLs of policy-mirror roles on other hosts], serviceIndex?: the
//     EnclaveServiceIndex pin {chainId 8453, address, codeHash} whose kind "policy" entries name more of them }. A host
//     filesystem directory (importDir, policyMirrorStateDir) is refused: it is not visible inside the measured guest. Bound by
//     HOST_DATA like every field; it becomes exactly ONE supervisor name, ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS (canonical
//     JSON), and nothing else may supply that name. The carriers are untrusted transport: the gate admits only the digest the
//     admin's book anchors, signed by the book's CURRENT owner at a fresh agreed block of this guest's own RPC quorum, with the
//     unchanged sequence, expiry, ban and persisted-refusal rules. planDirectBoot refuses a config that names carriers when the
//     image's host-admission bundle cannot honour them (an older bundle would ignore the name). Absent: the config, its
//     digest and the supervisor's environment are exactly what they were.
// Node builtins only, plus viem resolved from the supervisor image (/app) for keccak where an address must be derived, and
// the dependency-free lease-gas conduit bundle shipped beside this file.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { duplexPair } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTransit, leaseGasGuest, withLeaseGasEnv } from './lease-gas-conduit.bundle.mjs';
import { boundOwnerNomination, ownerNominationEnv } from './owner-nomination.mjs';
import { checkChainVerifier, guestChainVerifier, withChainVerifierEnv, CHAIN_VERIFIER_IMAGE_FILE } from './chain-verifier.mjs';

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
  // every field is required except the optional leaseGas (checked below when present)
  const OPTIONAL_MEMBERS = ['leaseGas', 'mcp', 'platformApi', 'ownerNomination', 'platformPolicyCarriers', 'nativeControl', 'chainVerifier'];
  const fields = raw && typeof raw === 'object' && !Array.isArray(raw) && OPTIONAL_MEMBERS.some((k) => Object.hasOwn(raw, k))
    ? Object.fromEntries(Object.entries(raw).filter(([k]) => !OPTIONAL_MEMBERS.includes(k))) : raw;
  only(fields, ['format', 'chainId', 'contracts', 'profileDigest', 'rpcs', 'quorum', 'releaseId', 'replicas', 'identity', 'selling', 'isolation',
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
  const mcp = raw.mcp !== undefined ? directMcp(raw.mcp, { contracts, controlPort }) : null;
  const platformApi = raw.platformApi !== undefined ? directPlatformApi(raw.platformApi, { controlPort }) : null;
  const ownerNomination = raw.ownerNomination !== undefined ? directOwnerNomination(raw.ownerNomination, {
    operator: raw.identity.operator.toLowerCase(), publicUrl: raw.identity.publicUrl, registry: contracts.registry }) : null;
  if (mcp && platformApi && [platformApi.apiPort, platformApi.peerPort].includes(mcp.port)) bad('mcp.port must differ from both platformApi ports');
  const platformPolicyCarriers = raw.platformPolicyCarriers !== undefined ? checkPolicyCarriers(raw.platformPolicyCarriers, { publicUrl: raw.identity.publicUrl }) : null;
  const nativeControl = raw.nativeControl !== undefined ? directNativeControl(raw.nativeControl, { platformApi }) : null;
  // the owner's LOCAL chain verifier for this guest (metal/guest/chain-verifier.mjs: the same checker as a relay-mode host's
  // fw_cfg setting, bound here by HOST_DATA): its loopback port is in the reserved 50000..57999 range, distinct from every
  // other port this config names
  let chainVerifier = null;
  if (raw.chainVerifier !== undefined) {
    try { chainVerifier = checkChainVerifier(raw.chainVerifier); } catch (e) { bad(e.message); }
    if ([controlPort, mcp?.port, platformApi?.apiPort, platformApi?.peerPort].includes(chainVerifier.port)) bad('chainVerifier.port must differ from every other port of this config');
  }
  return deepFreeze({
    format: CONFIG_FORMAT, chainId: CHAIN_ID, contracts, profileDigest: raw.profileDigest, rpcs, quorum, releaseId: raw.releaseId,
    replicas: { gateways, storagePlan: storagePlan === null ? null : JSON.parse(canonicalJson(storagePlan)) },
    identity: { publicUrl: raw.identity.publicUrl, repo: raw.identity.repo, operator: raw.identity.operator.toLowerCase() },
    selling: { cpuPrice6: raw.selling.cpuPrice6, payout: raw.selling.payout === null ? null : raw.selling.payout.toLowerCase() },
    isolation: { managerUrl: raw.isolation.managerUrl, dataAddr: raw.isolation.dataAddr },
    hostAdmissionSha256: raw.hostAdmissionSha256, controlPort,
    // optional and absent from every config written before it: those keep their exact canonical bytes and digest
    ...(raw.leaseGas !== undefined ? { leaseGas: directLeaseGas(raw.leaseGas) } : {}),
    ...(mcp ? { mcp } : {}),
    ...(platformApi ? { platformApi } : {}),
    ...(ownerNomination ? { ownerNomination } : {}),
    ...(platformPolicyCarriers ? { platformPolicyCarriers } : {}),
    ...(nativeControl ? { nativeControl } : {}),
    ...(chainVerifier ? { chainVerifier: JSON.parse(JSON.stringify(chainVerifier)) } : {}),
  });
}
// The bound native control member (see the header): which native control names this guest serves, and the native CA whose
// leaf over the attested control key it accepts. Strict, nothing defaulted, written in its canonical form (names sorted).
export const NATIVE_NAMES = Object.freeze(['api.enclavehost.eth', 'mcp.enclavehost.eth']);
function directNativeControl(raw, { platformApi }) {
  only(raw, ['names', 'caSha256'], 'nativeControl');
  if (!platformApi) bad('nativeControl needs the platformApi member: the native control names are served by the platform API role');
  if (!Array.isArray(raw.names) || raw.names.length < 1 || raw.names.some((n) => !NATIVE_NAMES.includes(n)) || new Set(raw.names).size !== raw.names.length)
    bad(`nativeControl.names: one or more of ${NATIVE_NAMES.join(', ')}, each once`);
  const names = [...raw.names].sort();
  if (names.join() !== raw.names.join()) bad('nativeControl.names must be written sorted');
  if (names.includes(platformApi.hostname)) bad('nativeControl.names must not include platformApi.hostname: a native name never shares the WebPKI route');
  if (typeof raw.caSha256 !== 'string' || !HEX64.test(raw.caSha256)) bad('nativeControl.caSha256: sha256 (64 lowercase hex) of the native CA certificate (DER)');
  return { names, caSha256: raw.caSha256 };
}
// The policy-carrier setting (see the header), for BOTH control guests: the measured direct guest's bound member and the
// relay-mode (legacy) guest's fw_cfg `platformPolicyCarriers` (metal/enclave-metal.mjs checks it, gsup checks it again with
// guestPolicyCarriers below). The shape is the runner's / the host bundle's carrier setting (network/policy-carriers.mjs
// validateCarrierBases, network/service-index.mjs validateIndexPin), restricted to what a control guest can reach: network
// carriers only. Strict, nothing defaulted, written in its canonical form. A carrier is ANOTHER host's policy-mirror role:
// this host itself (its own public origin, the QEMU host link 10.0.2.2, a loopback name) is refused, because its own roles
// serve only once it is admitted, so a cold start under an anchored policy would wait on itself.
export const CARRIERS_ENV = 'ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS';
const CARRIER_BASE = /^https?:\/\/[A-Za-z0-9.-]{1,200}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]{1,64}){0,8}$/;   // policy-carriers.mjs BASE
const MAX_CARRIERS = 16;                                                                                     // policy-carriers.mjs MAX_CARRIERS
const SELF_CARRIER = /^(10\.0\.2\.2|127(\.[0-9]{1,3}){3}|0\.0\.0\.0|localhost)$/i;
export function checkPolicyCarriers(raw, { publicUrl = null } = {}) {
  let self = null; try { self = publicUrl ? new URL(String(publicUrl)).origin : null; } catch {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('platformPolicyCarriers must be an object');
  for (const k of ['importDir', 'policyMirrorStateDir'])
    if (Object.hasOwn(raw, k)) bad(`platformPolicyCarriers.${k}: a host directory is not visible inside the measured guest (use peers or serviceIndex)`);
  const extra = Object.keys(raw).filter((k) => !['peers', 'serviceIndex'].includes(k));
  if (extra.length) bad(`platformPolicyCarriers has unknown field(s): ${extra.join(', ')}`);
  const out = {};
  if (raw.peers !== undefined) {
    if (!Array.isArray(raw.peers) || raw.peers.length < 1 || raw.peers.length > MAX_CARRIERS) bad(`platformPolicyCarriers.peers: 1 to ${MAX_CARRIERS} base URLs`);
    const seen = new Set();
    out.peers = raw.peers.map((p, i) => {
      const what = `platformPolicyCarriers.peers[${i}]`;
      if (typeof p !== 'string' || !CARRIER_BASE.test(p)) bad(`${what} must be an http(s) base URL without credentials, query, fragment or trailing slash`);
      if (/(^|\.)enclave\.host$/i.test(hostOf(url(p, what)))) bad(`${what} names an Enclave origin: a policy carrier is another host's policy-mirror role`);
      const pu = url(p, what);
      if (SELF_CARRIER.test(hostOf(pu)) || (self && pu.origin === self)) bad(`${what} is this host itself: a policy carrier is ANOTHER host's policy-mirror role (this host's own roles serve only once it is admitted)`);
      if (seen.has(p.toLowerCase())) bad(`${what} repeats a carrier`); seen.add(p.toLowerCase());
      return p;
    });
  }
  if (raw.serviceIndex !== undefined) {
    only(raw.serviceIndex, ['chainId', 'address', 'codeHash'], 'platformPolicyCarriers.serviceIndex');
    const { chainId, address, codeHash } = raw.serviceIndex;
    if (chainId !== CHAIN_ID) bad(`platformPolicyCarriers.serviceIndex.chainId must be ${CHAIN_ID}`);
    if (typeof address !== 'string' || !ADDR.test(address) || ZERO_ADDR.test(address)) bad('platformPolicyCarriers.serviceIndex.address must be a nonzero address');
    if (typeof codeHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) bad('platformPolicyCarriers.serviceIndex.codeHash must be the 0x + 64 hex keccak256 of the runtime code');
    out.serviceIndex = { chainId: CHAIN_ID, address: address.toLowerCase(), codeHash: codeHash.toLowerCase() };
  }
  if (!out.peers && !out.serviceIndex) bad('platformPolicyCarriers names no carrier (peers or serviceIndex)');
  return out;
}
// The bound owner nomination (metal/guest/owner-nomination.mjs): the operator's explicit, public intent to propose ONE
// owner wallet on the original EnclaveHostOwnership. Bound by HOST_DATA like everything here, written in its checked
// form, and only for THIS config's own chain, operator, endpoint and registry - never another host's or recipient.
function directOwnerNomination(raw, { operator, publicUrl, registry }) {
  let n; try { n = boundOwnerNomination(raw); } catch (e) { bad(e.message); }
  if (n.chainId !== CHAIN_ID) bad(`ownerNomination is for chain ${n.chainId}, not ${CHAIN_ID}`);
  if (n.operator !== operator) bad('ownerNomination.operator must be identity.operator');
  if (n.endpoint !== publicUrl) bad('ownerNomination.endpoint must be identity.publicUrl');
  if (n.registry !== registry) bad('ownerNomination.registry must be contracts.registry');
  return n;
}
// The bound hosted-MCP member. Trust is NOT configured here: the adapter takes this config's contracts, rpcs and quorum
// (and resolves the admin AddressBook through contracts.sessionVaultFactory). Only discovery inputs, the storage plan, the
// approval frontend and scan bounds are its own. Strict, nothing defaulted, written in its canonical form.
const MCP_FIELDS = ['port', 'managementDirectories', 'capacityDirectories', 'capacityCold', 'maxHosts', 'storagePlan', 'grantFrontend', 'sessionScan', 'usdc'];
function directMcp(raw, { contracts, controlPort }) {
  only(raw, MCP_FIELDS, 'mcp');
  if (ZERO_ADDR.test(contracts.sessionVaultFactory)) bad('mcp needs contracts.sessionVaultFactory: its implementation names the admin AddressBook the adapter resolves its bindings through');
  const port = intIn(raw.port, 1024, 65535, 'mcp.port');
  if ([8080, 8091, 8443, controlPort].includes(port)) bad('mcp.port must not be a port another guest service listens on');
  const origins = (list, what, literal) => {
    if (!Array.isArray(list) || list.length > 8) bad(`${what}: 0 to 8 origins`);
    return list.map((o, i) => {
      const u = url(o, `${what}[${i}]`);
      if (u.origin !== String(o)) bad(`${what}[${i}] must be written as an origin`);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`${what}[${i}] must be http(s)`);
      if (literal && !IPV4.test(u.hostname)) bad(`${what}[${i}] must name a literal IPv4 address (signed records carry the identity, not DNS)`);
      if (u.protocol === 'http:' && !IPV4.test(u.hostname)) bad(`${what}[${i}]: plain HTTP only for a literal IPv4 address`);
      return u.origin;
    });
  };
  const managementDirectories = origins(raw.managementDirectories, 'mcp.managementDirectories', true);
  const capacityDirectories = origins(raw.capacityDirectories, 'mcp.capacityDirectories', false);
  if (typeof raw.capacityCold !== 'boolean') bad('mcp.capacityCold must be true or false');
  const maxHosts = intIn(raw.maxHosts, 1, 4096, 'mcp.maxHosts');
  const plan = raw.storagePlan;
  if (plan !== null && (typeof plan !== 'object' || Array.isArray(plan) || canonicalJson(plan).length > 16384)) bad('mcp.storagePlan must be null or a JSON object up to 16 KiB (sdk/storage/replicas.mjs validates it at start)');
  let grantFrontend = null;
  if (raw.grantFrontend !== null) {
    const u = url(raw.grantFrontend, 'mcp.grantFrontend');
    if (u.protocol !== 'https:' || u.origin !== String(raw.grantFrontend)) bad('mcp.grantFrontend must be null or an https origin');
    grantFrontend = u.origin;
  }
  only(raw.sessionScan, ['fromBlock', 'chunk', 'maxChunks'], 'mcp.sessionScan');
  const sc = raw.sessionScan;
  if (sc.fromBlock !== null) intIn(sc.fromBlock, 0, Number.MAX_SAFE_INTEGER, 'mcp.sessionScan.fromBlock');
  intIn(sc.chunk, 1, 100000, 'mcp.sessionScan.chunk'); intIn(sc.maxChunks, 1, 10000, 'mcp.sessionScan.maxChunks');
  if (raw.usdc !== null && (typeof raw.usdc !== 'string' || !ADDR.test(raw.usdc) || ZERO_ADDR.test(raw.usdc))) bad('mcp.usdc must be null (Base USDC) or a nonzero address');
  return { port, managementDirectories, capacityDirectories, capacityCold: raw.capacityCold, maxHosts,
    storagePlan: plan === null ? null : JSON.parse(canonicalJson(plan)), grantFrontend,
    sessionScan: { fromBlock: sc.fromBlock, chunk: sc.chunk, maxChunks: sc.maxChunks }, usdc: raw.usdc === null ? null : raw.usdc.toLowerCase() };
}
export const MCP_BUNDLE = '/opt/metal/mcp-server.bundle.mjs';
export const MCP_ROUTE = '/mcp';
export const MCP_PROFILE = 'host';
/**
 * The hosted MCP adapter of a bound config: its files (the adapter configuration and the contract pins, derived from
 * the config), argv and environment, and the front route. This is the one source gsup starts it from.
 * -> null when the config has no mcp member
 */
export function directMcpLaunch(cfg, { paths = GUEST_PATHS, bundle = MCP_BUNDLE, node = '/usr/local/bin/node' } = {}) {
  if (!cfg.mcp) return null;
  const m = cfg.mcp;
  const profile = { contractPins: paths.mcpPins, rpcs: cfg.rpcs, quorum: cfg.quorum, managementDirectories: m.managementDirectories,
    capacityDirectories: m.capacityDirectories, capacityCold: m.capacityCold, maxHosts: m.maxHosts,
    ...(m.storagePlan ? { storagePlan: paths.mcpStoragePlan } : {}), ...(m.grantFrontend ? { grantFrontend: m.grantFrontend } : {}),
    ...(m.usdc ? { usdc: m.usdc } : {}), sessionScan: m.sessionScan, stateDir: paths.mcpState,
    // a bound local chain verifier decides the adapter's chain reads too (mcp/independent.mjs profile chainVerifier: no fallback)
    ...(cfg.chainVerifier ? { chainVerifier: `http://127.0.0.1:${cfg.chainVerifier.port}/` } : {}) };
  const files = { [paths.mcpPins]: JSON.stringify(contractPinsDoc(cfg)),
    [paths.mcpConfig]: JSON.stringify({ format: 'enclave-mcp-independent/v1', profiles: { [MCP_PROFILE]: profile } }),
    ...(m.storagePlan ? { [paths.mcpStoragePlan]: JSON.stringify(m.storagePlan) } : {}) };
  return { files, stateDir: paths.mcpState, argv: [node, bundle, '--config', paths.mcpConfig, '--remote', '--listen', `127.0.0.1:${m.port}`],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: paths.mcpState, NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt' },
    route: { path: MCP_ROUTE, upstream: { host: '127.0.0.1', port: m.port }, rewrite: `/p/${MCP_PROFILE}` } };
}
// ---- the platform API role (optional member) ---------------------------------------------------------------------------
// Strict, nothing defaulted, written in its canonical form. IDENTICAL on every member host (the role compares it before it
// hands over the state key), so nothing host-specific lives here: each host's own identity is the config's `identity`.
const PA_FIELDS = ['apiPort', 'peerPort', 'hostname', 'members', 'measurements', 'minTcb', 'admins', 'recovery', 'archives', 'archiveMs', 'relayEnv', 'leaseMs'];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// set by the role itself, or never configurable
export const PLATFORM_API_ROLE_ENV = Object.freeze(['AUTH_DATA_DIR', 'API_RELAY_PORT', 'API_RELAY_BIND', 'STATE_DIRECTORY', 'PLATFORM_API_ROLE', 'PATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']);
// relayEnv is PUBLIC (bound, readable in every config): a secret-shaped name belongs in the sealed credentials instead
const SECRET_NAME = /(^|_)(KEY|SECRET|TOKENS?|PASSWORD|PRIVATE|HMAC|SEED|MNEMONIC|EAB)(_|$)/;
// the same local-URL rule network/platform-host-policy-config.mjs applies (that module stays dependency-free too)
const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)/;
function directPlatformApi(raw, { controlPort }) {
  only(raw, PA_FIELDS, 'platformApi');
  const apiPort = intIn(raw.apiPort, 1024, 65535, 'platformApi.apiPort'), peerPort = intIn(raw.peerPort, 1024, 65535, 'platformApi.peerPort');
  for (const [p, w] of [[apiPort, 'apiPort'], [peerPort, 'peerPort']]) if ([8080, 8091, 8443, controlPort].includes(p)) bad(`platformApi.${w} must not be a port another guest service listens on`);
  if (apiPort === peerPort) bad('platformApi.apiPort and peerPort must differ');
  if (typeof raw.hostname !== 'string' || !HOSTNAME.test(raw.hostname)) bad('platformApi.hostname must be a lowercase DNS name');
  if (!Array.isArray(raw.members) || raw.members.length < 3 || raw.members.length > 7) bad('platformApi.members: 3 to 7 hosts (a majority must survive one loss)');
  const seen = { operator: new Set(), publicUrl: new Set(), controlUrl: new Set() };
  const members = raw.members.map((m, i) => {
    only(m, ['operator', 'publicUrl', 'controlUrl'], `platformApi.members[${i}]`);
    if (typeof m.operator !== 'string' || !ADDR.test(m.operator) || ZERO_ADDR.test(m.operator)) bad(`platformApi.members[${i}].operator must be a nonzero address`);
    const pu = url(m.publicUrl, `platformApi.members[${i}].publicUrl`);
    if (pu.protocol !== 'https:' || pu.search || pu.href.replace(/\/+$/, '') !== m.publicUrl) bad(`platformApi.members[${i}].publicUrl: https, exactly as registered`);
    const cu = url(m.controlUrl, `platformApi.members[${i}].controlUrl`);
    if (cu.protocol !== 'https:' || cu.origin !== m.controlUrl) bad(`platformApi.members[${i}].controlUrl must be the https origin of its control front`);
    const out = { operator: m.operator.toLowerCase(), publicUrl: m.publicUrl, controlUrl: m.controlUrl };
    for (const k of Object.keys(seen)) { if (seen[k].has(out[k])) bad(`platformApi.members repeat a ${k}`); seen[k].add(out[k]); }
    return out;
  });
  if (!Array.isArray(raw.measurements) || raw.measurements.length < 1 || raw.measurements.length > 8 || raw.measurements.some((m) => !/^[0-9a-f]{96}$/.test(String(m))))
    bad('platformApi.measurements: 1 to 8 lowercase 96-hex launch digests');
  if (raw.minTcb !== null && (typeof raw.minTcb !== 'object' || Array.isArray(raw.minTcb) || canonicalJson(raw.minTcb).length > 4096)) bad('platformApi.minTcb must be null or a TCB floor object');
  const addrs = (list, what, lo, hi) => { if (!Array.isArray(list) || list.length < lo || list.length > hi || list.some((a) => typeof a !== 'string' || !ADDR.test(a) || ZERO_ADDR.test(a))) bad(`${what}: ${lo} to ${hi} nonzero addresses`);
    const l = list.map((a) => a.toLowerCase()); if (new Set(l).size !== l.length) bad(`${what} repeats an address`); return l; };
  const admins = addrs(raw.admins, 'platformApi.admins', 1, 5);
  if (!Array.isArray(raw.recovery) || raw.recovery.length < 1 || raw.recovery.length > 5 || raw.recovery.some((k) => !HEX64.test(String(k))) || new Set(raw.recovery).size !== raw.recovery.length)
    bad('platformApi.recovery: 1 to 5 distinct X25519 public keys (64 lowercase hex)');
  if (!Array.isArray(raw.archives) || raw.archives.length > 8) bad('platformApi.archives: 0 to 8 origins');
  const archives = raw.archives.map((o, i) => {
    const u = url(o, `platformApi.archives[${i}]`);
    if (u.origin !== String(o)) bad(`platformApi.archives[${i}] must be written as an origin`);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && IPV4.test(u.hostname))) bad(`platformApi.archives[${i}]: https, or plain HTTP to a literal IPv4 address`);
    return u.origin;
  });
  const archiveMs = intIn(raw.archiveMs, 5000, 3600000, 'platformApi.archiveMs');
  if (!raw.relayEnv || typeof raw.relayEnv !== 'object' || Array.isArray(raw.relayEnv) || Object.keys(raw.relayEnv).length > 96) bad('platformApi.relayEnv must be an object of at most 96 names');
  for (const [k, v] of Object.entries(raw.relayEnv)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) bad(`platformApi.relayEnv: ${JSON.stringify(k.slice(0, 40))} is not an environment name`);
    if (PLATFORM_API_ROLE_ENV.includes(k)) bad(`platformApi.relayEnv.${k} is set by the role, not configured`);
    if (SECRET_NAME.test(k)) bad(`platformApi.relayEnv.${k} looks like a secret: secrets go in the sealed credentials, never in the bound (public) config`);
    if (typeof v !== 'string' || v.length > 4096) bad(`platformApi.relayEnv.${k} must be a string up to 4096 characters`);
  }
  // The chain authority the relay child AND the native issuer's host policy read with (both get relayEnv): the provider
  // quorum by default, or EXPLICITLY the local proof-backed verifier on this guest's loopback. Checked here so a bad or
  // ambiguous pair refuses the config instead of a later read.
  const chainAuthority = raw.relayEnv.ENCLAVE_CHAIN_AUTHORITY, chainVerifier = raw.relayEnv.ENCLAVE_CHAIN_VERIFIER;
  if (chainAuthority !== undefined && chainAuthority !== 'verifier' && chainAuthority !== 'quorum') bad('platformApi.relayEnv.ENCLAVE_CHAIN_AUTHORITY must be verifier or quorum');
  if (chainAuthority === 'verifier' && !LOOPBACK_URL.test(chainVerifier || '')) bad('platformApi.relayEnv.ENCLAVE_CHAIN_VERIFIER must be a local (loopback) http(s) URL: a remote server is not a verifier');
  if (chainAuthority !== 'verifier' && chainVerifier !== undefined) bad('platformApi.relayEnv.ENCLAVE_CHAIN_VERIFIER is set but ENCLAVE_CHAIN_AUTHORITY is not verifier');
  const leaseMs = intIn(raw.leaseMs, 2000, 60000, 'platformApi.leaseMs');
  return { apiPort, peerPort, hostname: raw.hostname, members, measurements: [...raw.measurements], minTcb: raw.minTcb === null ? null : JSON.parse(canonicalJson(raw.minTcb)),
    admins, recovery: [...raw.recovery], archives, archiveMs, relayEnv: JSON.parse(canonicalJson(raw.relayEnv)), leaseMs };
}
export const PLATFORM_API_BUNDLE = '/opt/metal/platform-api.bundle.mjs';
export const PLATFORM_API_PREFIX = '/platform-api/';
/**
 * The platform API role of a bound config: its role file, argv and environment, and the two front routes. The one source
 * gsup starts it from. -> null when the config has no platformApi member; { refused } when this host is not a member.
 */
export function directPlatformApiLaunch(cfg, { paths = GUEST_PATHS, bundle = PLATFORM_API_BUNDLE, node = '/usr/local/bin/node' } = {}) {
  if (!cfg.platformApi) return null;
  const pa = cfg.platformApi;
  const self = pa.members.findIndex((m) => m.operator === cfg.identity.operator && m.publicUrl === cfg.identity.publicUrl);
  if (self < 0) return { refused: `platformApi: this host (${cfg.identity.publicUrl}, ${cfg.identity.operator}) is not one of the group's members` };
  const dirs = { root: paths.platformApiDir, data: paths.platformApiDir + '/data' };
  const roleCfg = { format: 'enclave-platform-api-role/v1', platformApi: pa, config: cfg, self, statementFile: paths.statement,
    handoffKeyFile: paths.platformApiHandoffKey, dirs, relayEnvBase: { BASE_RPC: cfg.rpcs[0] } };
  return { files: { [paths.platformApiConfig]: JSON.stringify(roleCfg) }, stateDir: paths.platformApiDir,
    argv: [node, bundle, '--config', paths.platformApiConfig],
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: paths.platformApiDir, NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt' },
    hostRoute: { host: pa.hostname, upstream: { host: '127.0.0.1', port: pa.apiPort } },
    prefixRoute: { prefix: PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: pa.peerPort } },
    sni: { [pa.hostname]: { certFile: paths.platformApiDir + '/webpki/cert.pem', keyFile: paths.platformApiDir + '/webpki/key.pem' } } };
}
/**
 * The native control names of a bound config, as the front serves them: the bound names and CA, where an installed leaf is
 * kept (this boot's RAM fs), and the platform API role they reach. -> null when the config has no nativeControl member.
 */
export function directNativeLaunch(cfg, { paths = GUEST_PATHS } = {}) {
  if (!cfg.nativeControl) return null;
  return { names: [...cfg.nativeControl.names], caSha256: cfg.nativeControl.caSha256, certificateFile: paths.nativeCertificate,
    upstream: { host: '127.0.0.1', port: cfg.platformApi.apiPort }, apiHost: cfg.platformApi.hostname };
}
// The bound lease-gas member: exactly a conduit transit (lease-gas-conduit.mjs leaseGasTransit makes one from the host form),
// re-checked as PUBLISHED (an owner document a verifier recomputes: no RPC query, which could hold a key), chain 8453.
function directLeaseGas(raw) {
  let t;
  try { t = checkTransit(raw, { published: true }); } catch (e) { bad(`leaseGas: ${e.message}`); }
  if (t.chainId !== CHAIN_ID) bad(`leaseGas: the deployment record is for chain ${t.chainId}, not ${CHAIN_ID}`);
  if (canonicalJson(t) !== canonicalJson(raw)) bad('leaseGas must be written in its checked form (lease-gas-conduit.mjs leaseGasTransit)');
  return JSON.parse(canonicalJson(t));
}
/** Where the direct guest installs the bound deployment record (GUEST_PATHS.leaseGasRecord). */
export const LEASE_GAS_RECORD = '/run/measured-control/lease-gas-deployment.json';
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
  leaseGasRecord: '/run/measured-control/lease-gas-deployment.json',
  mcpConfig: '/run/measured-control/mcp.json', mcpPins: '/run/measured-control/mcp-contract-pins.json',
  mcpStoragePlan: '/run/measured-control/mcp-storage-plan.json', mcpState: '/run/measured-control/mcp-state',
  platformApiConfig: '/run/measured-control/platform-api.json', platformApiHandoffKey: '/run/measured-control/platform-api-handoff.key',
  platformApiDir: '/run/measured-control/platform-api',
  nativeCertificate: '/run/measured-control/native-certificate.pem',
  // the supervisor image's shared host-admission bundle (supervisor.js imports it): checked only when the config names carriers
  hostAdmissionBundle: '/app/windows/node/host-admission.bundle.mjs',
  // the image's pinned chain verifier runtime record (metal/chain-verifier-image.json), used only with a bound chainVerifier
  chainVerifierImage: CHAIN_VERIFIER_IMAGE_FILE,
});
// The baked flavor env (enclaves/cpu/config.yml) is the HOSTED fleet's: it names the Enclave address book, Enclave's own
// payout wallet, SIWE/CORS origins at enclave.host. A direct guest inherits only these authority-free tunables from it.
export const DIRECT_FLAVOR_KEYS = Object.freeze(['CHAIN_ID', 'USDC_ADDRESS', 'PAYMENT_WINDOW_SEC', 'GRACE_SEC', 'PAY_POLL_SEC', 'SESSION_TTL']);
/** The supervisor environment for a measured direct-only control guest. Secrets come in `secrets`, never from config. */
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
    // PLATFORM HOST POLICY: a measured guest on the production chain always enforces it (network/host-service-gate.mjs in
    // supervisor.js), over the owner's measured RPC quorum - the activation is part of the measured image, not an opt-in.
    ENCLAVE_PLATFORM_HOST_POLICY: 'production', ENCLAVE_PLATFORM_HOST_POLICY_RPCS: cfg.rpcs.join(','),
  };
  // the policy carriers: ONLY from the bound config (never flavor or host policy input), absent = no such name at all
  delete env[CARRIERS_ENV];
  if (cfg.platformPolicyCarriers) env[CARRIERS_ENV] = canonicalJson(cfg.platformPolicyCarriers);
  // app-funded lease gas: only from the bound config (never flavor or host policy), absent = none of these names at all
  const out = { ...withLeaseGasEnv(env, cfg.leaseGas ? leaseGasGuest(cfg.leaseGas, { recordFile: paths.leaseGasRecord || LEASE_GAS_RECORD, published: true }) : null),
    // the owner nomination: only from the bound config, absent = no such name
    ...ownerNominationEnv(cfg.ownerNomination || null) };
  // the chain authority: ONLY from the bound chainVerifier (the local verifier this guest starts before the supervisor, and
  // the owner's own transaction backend); absent = none of these names. The supervisor then reads only through the verifier
  // (the configured rpcs stay for the members that name them, and are never used by the supervisor for its chain).
  return withChainVerifierEnv(out, cfg.chainVerifier ? { configured: true, ok: true, url: `http://127.0.0.1:${cfg.chainVerifier.port}/`, verifier: cfg.chainVerifier } : null);
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
  if (CARRIERS_ENV in env) {
    let c = null; try { c = JSON.parse(String(env[CARRIERS_ENV])); } catch {}
    try { if (canonicalJson(checkPolicyCarriers(c)) !== String(env[CARRIERS_ENV])) out.push(`${CARRIERS_ENV} must be the canonical bound carrier setting`); }
    catch (e) { out.push(`${CARRIERS_ENV}: ${e.message}`); }
    if (v('ENCLAVE_PLATFORM_HOST_POLICY') !== 'production') out.push(`${CARRIERS_ENV} needs the platform host policy on (production)`);
  }
  return out;
}
/**
 * The image's own host-admission bundle must HONOUR a bound carrier setting: its hostPolicyCarriersFromEnv (the exact parser
 * createHostServiceGate uses) must accept the derived environment and see the same carriers. An older bundle has no such
 * export and would silently run without them, so that is a refusal. -> null (ok) or the reason.
 */
export async function supervisorCarrierProblem(env, bundleFile) {
  if (!(CARRIERS_ENV in env)) return null;
  let mod; try { mod = await import(pathToFileURL(bundleFile).href); } catch (e) { return `the supervisor's host-admission bundle ${bundleFile} cannot be loaded (${e.message})`; }
  if (typeof mod.hostPolicyCarriersFromEnv !== 'function') return `the supervisor's host-admission bundle ${bundleFile} does not support policy carriers: platformPolicyCarriers would be ignored`;
  let got; try { got = mod.hostPolicyCarriersFromEnv(env); } catch (e) { return `the supervisor's own carrier parser refuses the bound setting: ${e.message}`; }
  const want = JSON.parse(String(env[CARRIERS_ENV]));
  if (!got || got.importDir || got.policyMirrorStateDir || JSON.stringify(got.peers) !== JSON.stringify(want.peers || [])
      || JSON.stringify(got.serviceIndex) !== JSON.stringify(want.serviceIndex || null)) return 'the supervisor would read a different carrier setting than the bound one';
  return null;
}

// ---- the relay-mode (legacy) guest: the same carrier setting from fw_cfg ------------------------------------------------------
// gsup's legacy branch hands its supervisor exactly ONE carrier name, from fw_cfg `platformPolicyCarriers` only (the launcher
// checked it; it is checked here again with the same schema, and must arrive in that checked form), and only when the image's
// own host-admission bundle honours it (supervisorCarrierProblem). Absent: no such name. Present but unusable: a value the
// bundle's parser refuses, so the supervisor's gate REFUSES work and service (supervisor.js HOST_POLICY_GATE) - never an
// admission, and never a silent run without the carriers the operator configured. Carriers convey untrusted signed documents
// only: the gate still admits nothing but the digest the admin's book anchors, signed by its CURRENT owner, at its own quorum.
const carriersRefused = (why) => canonicalJson({ refused: String(why).slice(0, 300) });
const carrierSummary = (c) => [c.peers ? `${c.peers.length} peer(s)` : null, c.serviceIndex ? `service index ${c.serviceIndex.address}` : null].filter(Boolean).join(', ');
export async function guestPolicyCarriers(value, { publicUrl = '', bundleFile = GUEST_PATHS.hostAdmissionBundle } = {}) {
  if (value === undefined || value === null) return { configured: false, ok: false, env: {}, carriers: null, message: null };
  const refused = (why) => ({ configured: true, ok: false, env: { [CARRIERS_ENV]: carriersRefused(why) }, carriers: null,
    message: `platform policy carriers REFUSED (${why}): the supervisor refuses work and service until the host config is fixed` });
  let c;
  try {
    c = checkPolicyCarriers(value, { publicUrl });
    if (canonicalJson(c) !== canonicalJson(value)) bad('platformPolicyCarriers must arrive in its checked form (the launcher writes it)');
  } catch (e) { return refused(e.message); }
  const env = { [CARRIERS_ENV]: canonicalJson(c) };
  const problem = await supervisorCarrierProblem(env, bundleFile);
  if (problem) return refused(problem);
  return { configured: true, ok: true, env, carriers: c, message: `platform policy carriers: ${carrierSummary(c)} (untrusted transport; each document verified by the supervisor's gate)` };
}
/** env with the carrier name ONLY from the checked fw_cfg setting (any other source of that name - flavor, lease gas, owner
 *  nomination - is dropped); applied LAST, so nothing composed before it can supply or override the name. */
export function withPolicyCarriersEnv(env, carriers) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => k !== CARRIERS_ENV));
  return { ...out, ...(carriers?.env || {}) };
}
export const policyCarriersLaunchSummary = carrierSummary;

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
  const carrierProblem = await supervisorCarrierProblem(env, paths.hostAdmissionBundle || GUEST_PATHS.hostAdmissionBundle);
  if (carrierProblem) return { ok: false, reasons: [`platformPolicyCarriers: ${carrierProblem}`], mode, digest, hostData };
  const leaseGas = config.leaseGas ? leaseGasGuest(config.leaseGas, { recordFile: paths.leaseGasRecord || LEASE_GAS_RECORD, published: true }) : null;
  if (leaseGas && !leaseGas.ok) return { ok: false, reasons: [`leaseGas: ${leaseGas.reason}`], mode, digest, hostData };
  const files = { [paths.pins]: JSON.stringify(contractPinsDoc(config)), [paths.pairKey]: fw.isolation.pairingKey + '\n',
    ...(config.replicas.storagePlan ? { [paths.storagePlan]: JSON.stringify(config.replicas.storagePlan) } : {}),
    ...(leaseGas ? leaseGas.files : {}) };
  const mcp = directMcpLaunch(config, { paths });
  if (mcp) Object.assign(files, mcp.files);
  const platformApi = directPlatformApiLaunch(config, { paths });
  if (platformApi && platformApi.refused) return { ok: false, reasons: [platformApi.refused], mode, digest, hostData };
  if (platformApi) Object.assign(files, platformApi.files);
  const native = directNativeLaunch(config, { paths });
  // the bound local chain verifier: this image must carry its pinned runtime, or the guest refuses to boot (the config the
  // hardware attests to names a verifier this image cannot start; the supervisor never falls back to the rpcs)
  let chainVerifier = null;
  if (config.chainVerifier) {
    chainVerifier = guestChainVerifier(config.chainVerifier, { imageFile: paths.chainVerifierImage || CHAIN_VERIFIER_IMAGE_FILE });
    if (!chainVerifier.ok) return { ok: false, reasons: [`chainVerifier: ${chainVerifier.message}`], mode, digest, hostData };
  }
  return { ok: true, config, digest, hostData, bound, mode, env, files, operator, selling: !!fw.registryKey, mcp, platformApi, native, chainVerifier };
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
/** The platform API role's per-boot handoff key (X25519, raw 32-byte scalar as hex, 0600 on the RAM fs). -> public key hex */
export function mintPlatformApiKey({ paths = GUEST_PATHS } = {}) {
  const k = generateKeyPairSync('x25519');
  const jwk = k.privateKey.export({ format: 'jwk' });
  writePrivate(paths.platformApiHandoffKey, Buffer.from(jwk.d, 'base64url').toString('hex') + '\n');
  return Buffer.from(jwk.x, 'base64url').toString('hex');
}
/** RFC 7638 thumbprint, exactly as supervisor.js jwkThumbprint computes the session kid. */
export const jwkThumbprint = (jwk) => sha256(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`).toString('base64url');

// ---- the statement and its binding ---------------------------------------------------------------------------------------
export function controlStatement({ config, digest, hostData, mode, keys, runtime = {}, bootId = randomBytes(16).toString('hex') }) {
  const obj = { format: STATEMENT_FORMAT, role: 'direct-control', mode, chainId: CHAIN_ID, configDigest: digest, hostData,
    identity: { publicUrl: config.identity.publicUrl, operator: config.identity.operator },
    // a bound owner nomination is stated (who may be proposed, on which contract); absent: the statement keeps its bytes
    ...(config.ownerNomination ? { ownerNomination: { ownershipContract: config.ownerNomination.ownershipContract,
      ownershipCodeHash: config.ownerNomination.ownershipCodeHash, hostId: config.ownerNomination.hostId, owner: config.ownerNomination.owner } } : {}),
    keys: { proof: { curve: 'secp256k1', publicKey: keys.proof.publicKey }, session: keys.session.jwk, controlTls: { spkiSha256: keys.controlTls.spkiSha256 },
      // only a guest that runs the platform API role names its handoff key: every other statement keeps its exact bytes
      ...(keys.platformApi ? { platformApi: { publicKey: keys.platformApi.publicKey } } : {}) },
    // only a guest bound to serve native control names states them (and the CA): every other statement keeps its exact bytes
    ...(config.nativeControl ? { native: { names: [...config.nativeControl.names], caSha256: config.nativeControl.caSha256 } } : {}),
    runtime: { gsupSha256: runtime.gsupSha256 ?? null, helperSha256: runtime.helperSha256 ?? null, supervisorSha256: runtime.supervisorSha256 ?? null,
      ...(runtime.mcpSha256 !== undefined ? { mcpSha256: runtime.mcpSha256 } : {}),
      ...(runtime.platformApiSha256 !== undefined ? { platformApiSha256: runtime.platformApiSha256 } : {}),
      ...(runtime.chainVerifierImageSha256 !== undefined ? { chainVerifierImageSha256: runtime.chainVerifierImageSha256 } : {}) },
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
  only(o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'ownerNomination' && k !== 'native')) : o,
    ['format', 'role', 'mode', 'chainId', 'configDigest', 'hostData', 'identity', 'keys', 'runtime', 'bootId'], 'statement');
  if (Object.hasOwn(o, 'native')) {
    only(o.native, ['names', 'caSha256'], 'statement native names');
    if (!Array.isArray(o.native.names) || !o.native.names.length || o.native.names.some((n) => !NATIVE_NAMES.includes(n)) || [...new Set(o.native.names)].sort().join() !== o.native.names.join()
        || !HEX64.test(o.native.caSha256)) bad('statement native names malformed');
  }
  if (Object.hasOwn(o, 'ownerNomination')) {
    only(o.ownerNomination, ['ownershipContract', 'ownershipCodeHash', 'hostId', 'owner'], 'statement owner nomination');
    if (!/^0x[0-9a-f]{40}$/.test(o.ownerNomination.ownershipContract) || !/^0x[0-9a-f]{40}$/.test(o.ownerNomination.owner)
        || !/^0x[0-9a-f]{64}$/.test(o.ownerNomination.ownershipCodeHash) || !/^0x[0-9a-f]{64}$/.test(o.ownerNomination.hostId)) bad('statement owner nomination malformed');
  }
  if (o.format !== STATEMENT_FORMAT || o.role !== 'direct-control' || o.chainId !== CHAIN_ID) bad('statement format, role or chain is not a direct control statement');
  if (!HEX64.test(o.configDigest) || !HEX64.test(o.hostData) || !/^[0-9a-f]{32}$/.test(o.bootId)) bad('statement digests or boot id malformed');
  only(o.identity, ['publicUrl', 'operator'], 'statement identity');
  only(Object.hasOwn(o.keys || {}, 'platformApi') ? Object.fromEntries(Object.entries(o.keys).filter(([k]) => k !== 'platformApi')) : o.keys, ['proof', 'session', 'controlTls'], 'statement keys');
  if (Object.hasOwn(o.keys, 'platformApi')) { only(o.keys.platformApi, ['publicKey'], 'statement platform API key'); if (!HEX64.test(o.keys.platformApi.publicKey)) bad('statement platform API key malformed'); }
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

// ---- the native control certificate --------------------------------------------------------------------------------------
export const NATIVE_CERT_PATH = '/.well-known/enclave-native-certificate';
export const MAX_NATIVE_CHAIN_BYTES = 16384;
const NATIVE_BODY_MS = 10000;
const PEM_CERT = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----\r?\n?/g;
/** One TLS handshake over an in-memory pair: this guest's key and `leafPem` serve; Node/OpenSSL's verifier checks it for `name`. */
function handshake({ keyPem, leafPem, caPem, name, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const [a, b] = duplexPair();
    const server = new tls.TLSSocket(a, { isServer: true, secureContext: tls.createSecureContext({ key: keyPem, cert: leafPem, minVersion: 'TLSv1.2' }) });
    const client = tls.connect({ socket: b, servername: name, ca: caPem, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    let done = false;
    const finish = (e) => { if (done) return; done = true; clearTimeout(t); client.destroy(); server.destroy(); if (e) reject(e); else resolve(); };
    const t = setTimeout(() => finish(new Error('handshake timed out')), timeoutMs);
    server.on('error', () => {});
    client.once('secureConnect', () => finish(client.authorized ? null : new Error(String(client.authorizationError || 'not authorized'))));
    client.once('error', (e) => finish(e));
  });
}
/**
 * Accept a native control certificate chain (the leaf, then the native CA certificate) for this guest -> { leafPem, caPem,
 * validFrom, validTo } (ms), or throws. The CA must be the bound one (sha256 of its DER); the leaf must not be a CA, must carry
 * exactly this guest's control TLS public key, and must pass a real TLS handshake under that CA for EVERY bound name.
 */
export async function checkNativeCertificate(chainPem, { keyPem, caSha256, names, now = Date.now() }) {
  if (typeof chainPem !== 'string' || Buffer.byteLength(chainPem) > MAX_NATIVE_CHAIN_BYTES) bad(`a native certificate chain is PEM text up to ${MAX_NATIVE_CHAIN_BYTES} bytes`);
  const blocks = chainPem.match(PEM_CERT) || [];
  if (blocks.length !== 2 || blocks.join('').replace(/\r/g, '').trim() !== chainPem.replace(/\r/g, '').trim()) bad('a native certificate chain is exactly two PEM certificates: the leaf, then the native CA');
  let leaf, ca;
  try { leaf = new X509Certificate(blocks[0]); ca = new X509Certificate(blocks[1]); } catch (e) { bad(`unparseable certificate: ${e.message}`); }
  if (sha256Hex(ca.raw) !== caSha256 || !ca.ca) bad('the chain does not end in the bound native CA');
  if (leaf.ca) bad('the leaf is a CA certificate');
  const own = createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  if (!leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(own)) bad('the leaf does not certify this guest\'s attested control TLS key');
  const validFrom = Date.parse(leaf.validFrom), validTo = Date.parse(leaf.validTo);
  if (!(validFrom <= now && now < validTo)) bad('the leaf is not valid now');
  for (const name of names) {
    try { await handshake({ keyPem, leafPem: blocks[0], caPem: blocks[1], name }); }
    catch (e) { bad(`the leaf does not serve ${name} under the native CA: ${String(e.message).slice(0, 160)}`); }
  }
  return { leafPem: blocks[0], caPem: blocks[1], validFrom, validTo };
}

// ---- the control front ----------------------------------------------------------------------------------------------------
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
// One proxied HTTP exchange's lifecycle. A client that leaves before its answer is complete (a closed connection, an aborted
// upload, an abandoned stream) cancels the upstream request, so no front->upstream leg outlives its client; an upstream answer
// that ends before it is complete closes the client's connection instead of leaving it waiting for the promised bytes.
function proxyLifecycle(req, res, up, onUnreachable) {
  const cancel = () => { if (!up.destroyed) up.destroy(); };
  res.on('close', () => { if (!res.writableFinished) cancel(); });
  req.on('error', cancel);
  up.on('response', (r) => r.on('close', () => { if (!r.complete) res.destroy(); }));
  up.on('error', () => { if (res.destroyed) return; if (!res.headersSent) onUnreachable(); else res.destroy(); });
}
/**
 * The TLS front of the control guest. evidence: GET EVIDENCE_PATH?nonce=<64 hex>. Anything else: proxied to the
 * in-guest supervisor, path and query only (never an absolute URL: no SSRF through the front).
 * opts: { statementText, keyPem, certPem, reporter(reportData64) -> {report, certs}, upstream: {host, port}, mode }
 * native (directNativeLaunch, optional): the bound native control names, served only with keyPem and an installed CA leaf.
 * The returned server has installNativeCertificate(chainPem) (also PUT NATIVE_CERT_PATH) when native is given.
 */
export function createControlFront({ statementText, keyPem, certPem, reporter, upstream = { host: '127.0.0.1', port: 8080 }, mode = 'snp', maxQueue = 8, routes = [],
                                    hostRoutes = [], prefixRoutes = [], sni = {}, native = null }) {
  const statement = parseStatement(statementText);
  // native control names: exactly the bound ones the statement names, to the platform API role, and never a shared SNI file
  if (native) {
    if (!statement.native || !Array.isArray(native.names) || native.names.join() !== statement.native.names.join() || native.caSha256 !== statement.native.caSha256
        || native.upstream?.host !== '127.0.0.1' || !Number.isInteger(native.upstream?.port) || !HOSTNAME.test(String(native.apiHost)) || native.names.includes(native.apiHost)
        || Object.keys(sni).some((n) => native.names.includes(n.toLowerCase()))) bad('front native names must be the statement\'s bound names and CA, to the platform API role, with no SNI certificate of their own');
  } else if (statement.native) bad('the statement names native control names but the front was given none');
  // routes: [{ path, upstream, rewrite }] - an EXACT path (query kept) sent to another in-guest loopback service under a
  // fixed rewritten path (the hosted MCP: MCP_ROUTE -> its /p/<profile>). Everything else still goes to the supervisor.
  for (const r of routes) if (!/^\/[a-z0-9-]+$/.test(String(r.path)) || r.path === EVIDENCE_PATH || r.upstream?.host !== '127.0.0.1' || !/^\/[a-z0-9/-]+$/.test(String(r.rewrite)))
    bad('front routes are exact /<name> paths to a 127.0.0.1 service under a fixed path');
  // hostRoutes: [{ host, upstream }] - every request whose Host is exactly `host` (the platform API hostname), path and query
  // kept, upgrades included, to a 127.0.0.1 service. prefixRoutes: [{ prefix, upstream }] - a /<name>/ path prefix (the
  // platform API peer protocol) to a 127.0.0.1 service. Everything else still goes to the supervisor.
  for (const r of hostRoutes) if (!HOSTNAME.test(String(r.host)) || r.upstream?.host !== '127.0.0.1' || !Number.isInteger(r.upstream?.port)) bad('front host routes name a DNS host and a 127.0.0.1 service');
  for (const r of prefixRoutes) if (!/^\/[a-z0-9-]+\/$/.test(String(r.prefix)) || r.upstream?.host !== '127.0.0.1' || !Number.isInteger(r.upstream?.port)) bad('front prefix routes are /<name>/ to a 127.0.0.1 service');
  const hostOfReq = (req) => String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  const routeOf = (req, pathname) => hostRoutes.find((r) => r.host === hostOfReq(req)) || prefixRoutes.find((r) => pathname.startsWith(r.prefix)) || routes.find((r) => pathname === r.path) || null;
  // the native leaf over THIS guest's control key (checkNativeCertificate), held in memory; a native name is served only with it
  // ONE install at a time, no queue: a second one is refused before its body is read (the PUT path), so an unauthenticated
  // installer holds at most one MAX_NATIVE_CHAIN_BYTES body and one verification. The installed leaf changes only when a
  // new one passed every check AND expires strictly later (a replayed or reissued shorter leaf never rolls expiry back);
  // a refused, interrupted or failed install leaves the current one serving.
  let nativeCert = null, installing = false, bodyHeld = false;
  const nativeCtx = () => (nativeCert && Date.now() >= nativeCert.validFrom && Date.now() < nativeCert.validTo ? nativeCert.ctx : null);
  const installNativeCertificate = async (chainPem) => {
    if (installing) throw new ControlError('another native certificate install is in progress');
    installing = true;
    try {
      const c = await checkNativeCertificate(chainPem, { keyPem, caSha256: native.caSha256, names: native.names });
      if (nativeCert && Date.now() < nativeCert.validTo && c.validTo <= nativeCert.validTo) bad('the installed native certificate expires no earlier than this one');
      const ctx = tls.createSecureContext({ key: keyPem, cert: c.leafPem, minVersion: 'TLSv1.2' });
      if (native.certificateFile) { const tmp = native.certificateFile + '.tmp'; fs.writeFileSync(tmp, c.leafPem + c.caPem, { mode: 0o644 }); fs.renameSync(tmp, native.certificateFile); }
      nativeCert = { ...c, ctx };
      return { names: native.names, validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString() };
    } finally { installing = false; }
  };
  // a WebPKI certificate for a routed hostname, provisioned inside the guest (certificate role) at sni[name]; read per handshake
  const sniCache = new Map();
  const SNICallback = (name, cb) => {
    const lname = String(name || '').toLowerCase();
    if (native && native.names.includes(lname)) { const ctx = nativeCtx(); return ctx ? cb(null, ctx) : cb(new Error(`no current native certificate for ${lname}`)); }
    const s = sni[lname];
    if (!s) return cb(null, null);
    try {
      const st = fs.statSync(s.certFile).mtimeMs + ':' + fs.statSync(s.keyFile).mtimeMs, c = sniCache.get(name);
      if (c && c.st === st) return cb(null, c.ctx);
      const ctx = tls.createSecureContext({ cert: fs.readFileSync(s.certFile), key: fs.readFileSync(s.keyFile), minVersion: 'TLSv1.2' });
      sniCache.set(name, { st, ctx }); return cb(null, ctx);
    } catch { return cb(null, null); }      // not provisioned yet: the control certificate (clients that pin it still work)
  };
  let chain = Promise.resolve(), queued = 0;
  const evidence = async (nonce) => {
    if (mode !== 'snp') return { format: EVIDENCE_FORMAT, statement: statementText, report: null, unattested: `mode ${mode}: no hardware report`, certificate: certPem };
    const { report, certs } = await reporter(reportDataFor(statementText, nonce));
    return { format: EVIDENCE_FORMAT, statement: statementText, report: report.toString('base64'), ...(certs && certs.length ? { certs: certs.toString('base64') } : {}), certificate: certPem };
  };
  const json = (res, status, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b); };
  const server = https.createServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.2', requestTimeout: 30000, headersTimeout: 15000, SNICallback }, (req, res) => {
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
    if (native && u.pathname === NATIVE_CERT_PATH) {
      if (req.method === 'GET') {
        if (!nativeCert) return json(res, 404, { error: 'no_native_certificate' });
        res.writeHead(200, { 'content-type': 'application/x-pem-file', 'cache-control': 'no-store' }); return res.end(nativeCert.leafPem + nativeCert.caPem);
      }
      if (req.method !== 'PUT') return json(res, 405, { error: 'method' });
      // refused BEFORE any body byte is kept: a declared length within the bound, and no install already holding the slot
      const len = Number(req.headers['content-length']);
      if (req.headers['transfer-encoding'] || !Number.isSafeInteger(len) || len < 1) return json(res, 411, { error: 'length_required' });
      if (len > MAX_NATIVE_CHAIN_BYTES) return json(res, 413, { error: 'too_large' });
      if (installing || bodyHeld) return json(res, 429, { error: 'busy' });
      bodyHeld = true;
      const chunks = []; let size = 0, released = false;
      const release = () => { if (!released) { released = true; bodyHeld = false; clearTimeout(timer); } };
      const timer = setTimeout(() => { release(); json(res, 408, { error: 'body_timeout' }); req.destroy(); }, NATIVE_BODY_MS);
      req.on('data', (c) => { size += c.length; if (size > len) { release(); json(res, 413, { error: 'too_large' }); req.destroy(); } else chunks.push(c); });
      req.on('close', release);
      req.on('error', release);
      req.on('end', () => {
        if (released) return;
        release();
        installNativeCertificate(Buffer.concat(chunks).toString('utf8')).then((r) => json(res, 200, r),
          (e) => json(res, /in progress/.test(String(e?.message)) ? 429 : 400, { error: 'native_certificate_refused', message: String(e?.message || e).slice(0, 300) }));
      });
      return;
    }
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    if (native) {
      const h = hostOfReq(req), sn = String(req.socket.servername || '').toLowerCase();
      if (native.names.includes(h) || native.names.includes(sn)) {
        // a native name only on a connection made (and authenticated) for that very name: never under another SNI key
        if (h !== sn) return json(res, 421, { error: 'misdirected_request', message: 'a native control name is served only on a TLS connection made for that name' });
        Object.assign(headers, { host: native.apiHost, 'x-enclave-client-ip': String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') });
        // the platform API, exactly as on its WebPKI host; mcp.enclavehost.eth is the relay's own MCP endpoint (/mcp on that host)
        const toPath = (h === 'mcp.enclavehost.eth' ? '/mcp' : u.pathname) + u.search;
        const up = http.request({ host: native.upstream.host, port: native.upstream.port, method: req.method, path: toPath, headers }, (r) => {
          const hh = {}; for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) hh[k] = v;
          res.writeHead(r.statusCode || 502, hh); r.pipe(res);
        });
        proxyLifecycle(req, res, up, () => json(res, 502, { error: 'service_unreachable' }));
        return req.pipe(up);
      }
    }
    const route = routeOf(req, u.pathname), to = route ? route.upstream : upstream;
    // a host-routed service (the platform API) learns the client's address only from this front: the TCP peer, never a
    // client-written header
    if (route && route.host) { headers.host = route.host; headers['x-enclave-client-ip'] = String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
    else delete headers['x-enclave-client-ip'];
    const toPath = route?.rewrite ? route.rewrite + u.search : u.pathname + u.search;
    const up = http.request({ host: to.host, port: to.port, method: req.method, path: toPath, headers }, (r) => {
      const h = {}; for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(r.statusCode || 502, h); r.pipe(res);
    });
    proxyLifecycle(req, res, up, () => json(res, 502, { error: route ? 'service_unreachable' : 'supervisor_unreachable' }));
    req.pipe(up);
  });
  // upgrades (the platform API's websocket routes) only on a host route; the supervisor's own surface takes none here
  server.on('upgrade', (req, socket, head) => {
    let route = hostRoutes.find((r) => r.host === hostOfReq(req));
    if (native) {
      const h = hostOfReq(req), sn = String(req.socket.servername || '').toLowerCase();
      if (native.names.includes(h) || native.names.includes(sn)) {
        if (h !== sn || h !== 'api.enclavehost.eth') { socket.end('HTTP/1.1 421 Misdirected Request\r\ncontent-length: 0\r\n\r\n'); return; }
        route = { host: native.apiHost, upstream: native.upstream };
      }
    }
    if (!route || !String(req.url || '').startsWith('/') || String(req.url).startsWith('//')) { socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n'); return; }
    const headers = { ...req.headers, host: route.host,
      'x-enclave-client-ip': String(req.socket.remoteAddress || '').replace(/^::ffff:/, '') };
    const up = net.connect(route.upstream.port, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
  });
  if (native) { server.installNativeCertificate = installNativeCertificate; server.nativeState = () => ({ installing, bodyHeld, validTo: nativeCert ? nativeCert.validTo : null }); }
  return server;
}

// ---- `node measured-control.mjs serve --config FILE` (started by gsup) ----------------------------------------------------
async function serveMain(argv) {
  const i = argv.indexOf('--config');
  const cfg = JSON.parse(fs.readFileSync(i > 0 ? argv[i + 1] : GUEST_PATHS.serveConfig, 'utf8'));
  const front = createControlFront({ statementText: fs.readFileSync(cfg.statement, 'utf8'), keyPem: fs.readFileSync(cfg.tlsKey, 'utf8'),
    certPem: fs.readFileSync(cfg.tlsCert, 'utf8'), reporter: configfsReporter({ vcekB64: cfg.vcekB64 || '' }), upstream: cfg.upstream, mode: cfg.mode,
    routes: Array.isArray(cfg.routes) ? cfg.routes : [],
    hostRoutes: Array.isArray(cfg.hostRoutes) ? cfg.hostRoutes : [], prefixRoutes: Array.isArray(cfg.prefixRoutes) ? cfg.prefixRoutes : [],
    sni: cfg.sni && typeof cfg.sni === 'object' ? cfg.sni : {}, native: cfg.native || null });
  // a native leaf already installed this boot (a restarted front): accepted again only through the same checks
  if (cfg.native && fs.existsSync(cfg.native.certificateFile)) await front.installNativeCertificate(fs.readFileSync(cfg.native.certificateFile, 'utf8'))
    .then((r) => console.log(`[control] native control certificate for ${r.names.join(', ')} until ${r.validTo}`), (e) => console.error(`[control] installed native certificate refused: ${e.message}`));
  front.listen(cfg.port, '0.0.0.0', () => console.log(`[control] measured control front on :${cfg.port} (mode ${cfg.mode}); evidence at ${EVIDENCE_PATH}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'serve')
  serveMain(process.argv).catch((e) => { console.error(`[control] ${e.message}`); process.exit(1); });
