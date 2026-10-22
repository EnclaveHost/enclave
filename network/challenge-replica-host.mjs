// The Enclave host's own challenge service (cfg.enclaveNetwork.challengeReplica): an Enclave host - not a DigitalOcean
// transport machine, not a separate systemd/Caddy deployment - runs the reviewed DNS/challenge release as a child of its
// network runtime (enclave-network-host.mjs). Two roles, both relay/dns-relay.js unchanged:
//   - "app-zone-replica": a read-only route replica for the platform's app zone (DNS_READ_ONLY=1) that answers
//     _acme-challenge.<id8>.<zone> only for pushes it verified itself (APP_CHALLENGE_AUTH=attested-lease: pinned SEV-SNP
//     front measurements, and/or Enclave Shield under the operator's pinned policy with the lease runner's own TPM host
//     session; then one agreeing chain read: current lease, owner, registry host active (platform bans), catalog policy).
//   - "owner-responder": an owner-selected DNS-01 responder for custom names (DNS_CHALLENGE_AUTH=attested, SNP and/or
//     Shield), the CHALLENGE_ZONE only.
// What this module adds is packaging, nothing that decides trust:
//   1. the configuration is judged before anything binds: every trust input (zones, pins, RPCs, measurements, Shield
//      policy and reviewed registry profile, the release's hashes) is explicit - there are no defaults - and legacy
//      inputs are refused, never ignored (relay, CERTS_API/certificate service, fleet SECRET, DNS_TXT_KEY, static
//      fleets, lab judge modes);
//   2. the release directory must hold exactly the pinned dns.mjs and network-runtime.bundle.mjs
//      (scripts/build-challenge-replica-release.mjs); a changed byte refuses the start;
//   3. the child gets ONLY the derived environment (never this host's environment, keys or wallet);
//   4. a minimal HTTPS front exposes only the push and Shield-session routes, with the replica's own body caps, and
//      strips credentials. TLS there is transport: every push is signed by the guest key and attested end to end, and a
//      host session is public evidence the replica verifies itself;
//   5. the EnclaveServiceIndex `dns` (kind 4) advertisement is DRAFTED as unsigned typed data, never published here.
// Trust that packaging cannot change: whoever answers DNS for a delegated zone can satisfy dns-01 for every name in it,
// so which hosts serve the platform app zone stays the zone owner's (Enclave admin's) delegation decision; an
// advertisement is an untrusted candidate, never admission (network/service-index.mjs).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {spawn as spawnProcess} from 'node:child_process';
import {SERVICE_KINDS, validateAdInput, publishTypedData} from './service-index.mjs';
import {canonical as canonicalJson} from './route-record.mjs';
import {createHostServiceGate, resolveHostPolicyConfig} from './host-service-gate.mjs';
import {CARRIER_MIRROR} from './policy-carriers.mjs';

export const ROLES = Object.freeze(['app-zone-replica', 'owner-responder']);
const KEYS = ['role', 'release', 'zones', 'ns', 'listen', 'front', 'routeMap', 'chain', 'snp', 'shield', 'peers', 'upstream', 'hostPolicy'];
// inputs of the central relay era: refused by name so a migrated config never silently keeps one
const LEGACY = ['relay', 'relayUrl', 'certsApi', 'certificateService', 'secret', 'fleetSecret', 'dnsTxtKey', 'enclaves', 'registryAddress',
  'addressBookAddress', 'baseRpc', 'domainsApi', 'judgeMode', 'eab', 'acmeAccount'];
const HEX64 = /^[0-9a-f]{64}$/, MEAS = /^[0-9a-f]{96}$/, ADDR = /^0x[0-9a-f]{40}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const fail = (m) => { throw new Error('Enclave network: challengeReplica: ' + m); };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
function only(o, keys, where) {
  if (!isObj(o)) fail(`${where} must be an object`);
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(`${where} has unknown field(s): ${extra.join(', ')}`);
}
function zoneName(z, where) {
  if (typeof z !== 'string' || z !== z.toLowerCase() || z.endsWith('.') || z.length > 204) fail(`${where} must be a lowercase DNS zone`);
  const l = z.split('.');
  if (l.length < 2 || !l.every((x) => LABEL.test(x))) fail(`${where} must be a lowercase DNS zone`);
  return z;
}
function absFile(p, where) { if (typeof p !== 'string' || !path.isAbsolute(p)) fail(`${where} must be an absolute path`); return p; }
function hostPort(v, where, {loopback = false} = {}) {
  const m = /^(\[[0-9a-f:]+\]|[0-9.]+):(\d{1,5})$/i.exec(String(v));
  if (!m) fail(`${where} must be <ip>:<port>`);
  const ip = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2]);
  if (!net.isIP(ip) || port < 1 || port > 65535) fail(`${where} must be <ip>:<port>`);
  if (loopback && !['127.0.0.1', '::1'].includes(ip)) fail(`${where} must be a loopback address`);
  return {ip, port};
}
function httpsOrigin(u, where) {
  let x; try { x = new URL(u); } catch { fail(`${where} must be an https origin`); }
  if (x.protocol !== 'https:' || x.username || x.password || x.search || x.hash || x.pathname !== '/') fail(`${where} must be an https origin`);
  return x.origin;
}
function rpcList(list, where) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 8) fail(`${where} must name 2 to 8 RPCs`);
  const out = list.map((u) => { let x; try { x = new URL(u); } catch { fail(`${where}: not a URL`); } if (x.protocol !== 'https:' || x.username || x.password) fail(`${where} must be https without credentials`); return x.href; });
  if (new Set(out.map((u) => new URL(u).hostname)).size !== out.length) fail(`${where} must name distinct hosts (one host cannot vote twice)`);
  return out;
}

// The integrated runner's configuration shape for the SAME gate inputs (network/host-services/runner.mjs policyEnv and
// policyCarrierFetch take it): no second implementation of the policy env or the carrier fetch.
function runnerPolicyShape(h) {
  const pc = h.carriers ? {...(h.carriers.importDir ? {importDir: h.carriers.importDir} : {}), ...(h.carriers.peers ? {peers: h.carriers.peers} : {})} : null;
  return {platformHostPolicy: h.policy, ...(h.mirrors.length ? {platformHostPolicyMirrors: h.mirrors} : {}), ...(h.rpcs ? {platformHostPolicyRpcs: h.rpcs} : {}),
    ...(pc && Object.keys(pc).length ? {platformHostPolicyCarriers: pc} : {}),
    services: h.carriers?.policyMirrorStateDir ? [{role: 'policy-mirror', config: {stateDir: h.carriers.policyMirrorStateDir}}] : []};
}
/** The gate's environment for a normalized hostPolicy (with the reserved carrier origin when carriers are configured). */
export function hostPolicyGateEnv(h) {
  const shape = runnerPolicyShape(h);
  const env = {ENCLAVE_PLATFORM_HOST_POLICY: typeof h.policy === 'string' ? h.policy : JSON.stringify(h.policy)};
  const mirrors = [...h.mirrors, ...(h.carriers ? [CARRIER_MIRROR] : [])];
  if (mirrors.length) env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS = mirrors.join(',');
  if (h.rpcs) env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS = h.rpcs.join(',');
  return {env, shape};
}

/** cfg.enclaveNetwork.challengeReplica -> the normalized configuration; throws on anything malformed, missing or legacy. */
export function challengeReplicaConfig(c) {
  if (!isObj(c)) fail('must be an object');
  const legacy = Object.keys(c).filter((k) => LEGACY.includes(k));
  if (legacy.length) fail(`legacy central input(s) refused: ${legacy.join(', ')} (this service runs without the relay, its certificate service or the fleet secret)`);
  only(c, KEYS, 'challengeReplica');
  if (!ROLES.includes(c.role)) fail(`role must be one of ${ROLES.join(', ')}`);
  only(c.release, ['dir', 'dnsSha256', 'runtimeBundleSha256'], 'release');
  const release = {dir: absFile(c.release.dir, 'release.dir'), dnsSha256: String(c.release.dnsSha256), runtimeBundleSha256: String(c.release.runtimeBundleSha256)};
  if (!HEX64.test(release.dnsSha256) || !HEX64.test(release.runtimeBundleSha256)) fail('release.dnsSha256 and release.runtimeBundleSha256 must be the reviewed 64-hex hashes');
  const replica = c.role === 'app-zone-replica';
  only(c.zones, replica ? ['app', 'ip'] : ['challenge'], 'zones');
  const zones = replica ? {app: zoneName(c.zones.app, 'zones.app'), ip: zoneName(c.zones.ip, 'zones.ip')} : {challenge: zoneName(c.zones.challenge, 'zones.challenge')};
  only(c.ns, ['name', 'names'], 'ns');
  const nsName = zoneName(c.ns.name, 'ns.name');
  const nsNames = c.ns.names === undefined ? [nsName] : c.ns.names.map((n, i) => zoneName(n, `ns.names[${i}]`));
  if (!nsNames.includes(nsName) || nsNames.length > 8 || new Set(nsNames).size !== nsNames.length) fail('ns.names must list 1 to 8 distinct names including ns.name');
  only(c.listen, ['dns', 'api'], 'listen');
  const listen = {dns: hostPort(c.listen.dns, 'listen.dns'), api: hostPort(c.listen.api, 'listen.api', {loopback: true})};
  only(c.front, ['listen', 'certFile', 'keyFile', 'origin'], 'front');
  const front = {listen: hostPort(c.front.listen, 'front.listen'), certFile: absFile(c.front.certFile, 'front.certFile'), keyFile: absFile(c.front.keyFile, 'front.keyFile'),
    origin: httpsOrigin(c.front.origin, 'front.origin')};
  let routeMap = null;
  if (replica) {
    let u; try { u = new URL(c.routeMap); } catch { fail('routeMap must be an http(s) URL'); }
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) || u.username || u.password) fail('routeMap must be https, or http on loopback');
    routeMap = u.href;
  } else if (c.routeMap !== undefined) fail('routeMap belongs to the app-zone-replica role');
  if (c.snp === undefined && c.shield === undefined) fail('at least one evidence family is required: snp (pinned measurements) and/or shield (pinned policy)');
  let snp = null, shield = null, chain = null;
  if (c.snp !== undefined) {
    only(c.snp, ['measurements', 'minTcb'], 'snp');
    if (!Array.isArray(c.snp.measurements) || !c.snp.measurements.length || c.snp.measurements.length > 64 || !c.snp.measurements.every((m) => MEAS.test(m)))
      fail('snp.measurements must list 1 to 64 pinned 96-hex launch measurements');
    if (c.snp.minTcb !== undefined && !/^\d{1,20}$/.test(String(c.snp.minTcb))) fail('snp.minTcb must be an unsigned integer');
    snp = {measurements: [...new Set(c.snp.measurements)], ...(c.snp.minTcb !== undefined ? {minTcb: String(c.snp.minTcb)} : {})};
  }
  if (c.shield !== undefined) {
    only(c.shield, ['policyFile', 'profileFile', 'profileDigest', 'rpcs', 'pinsFile'], 'shield');
    if (!/^sha256:[0-9a-f]{64}$/.test(String(c.shield.profileDigest))) fail('shield.profileDigest must be sha256:<64 hex> of the reviewed authority profile');
    shield = {policyFile: absFile(c.shield.policyFile, 'shield.policyFile'), profileFile: absFile(c.shield.profileFile, 'shield.profileFile'),
      profileDigest: c.shield.profileDigest, rpcs: rpcList(c.shield.rpcs, 'shield.rpcs'), ...(c.shield.pinsFile !== undefined ? {pinsFile: absFile(c.shield.pinsFile, 'shield.pinsFile')} : {})};
  }
  if (replica) {
    only(c.chain, ['rpcs', 'pins'], 'chain');
    only(c.chain.pins, ['addressBook', 'deployments', 'registry', 'catalog'], 'chain.pins');
    const pins = Object.fromEntries(['addressBook', 'deployments', 'registry', 'catalog'].map((k) => {
      const v = String(c.chain.pins[k] || '').toLowerCase(); if (!ADDR.test(v) || /^0x0{40}$/.test(v)) fail(`chain.pins.${k} must be a contract address`); return [k, v]; }));
    chain = {rpcs: rpcList(c.chain.rpcs, 'chain.rpcs'), pins};
  } else if (c.chain !== undefined) fail('chain belongs to the app-zone-replica role (the owner responder reads only the registry, through shield.rpcs)');
  let peers = [];
  if (c.peers !== undefined) {
    if (!replica) fail('peers belong to the app-zone-replica role');
    if (!Array.isArray(c.peers) || c.peers.length > 8) fail('peers must list at most 8 https origins');
    peers = c.peers.map((p, i) => httpsOrigin(p, `peers[${i}]`));
  }
  let upstream = null;
  if (c.upstream !== undefined) { if (!replica) fail('upstream belongs to the app-zone-replica role'); const u = hostPort(c.upstream, 'upstream'); upstream = `${u.ip.includes(':') ? `[${u.ip}]` : u.ip}:${u.port}`; }
  // the platform host policy (network/host-service-gate.mjs, the gate both host runtimes use for app service): explicit,
  // never defaulted; "off" must be written and is reported as such
  only(c.hostPolicy, ['policy', 'endpoint', 'stateDir', 'mirrors', 'rpcs', 'carriers'], 'hostPolicy');
  const policy = c.hostPolicy.policy;
  if (!(policy === 'production' || policy === 'off' || isObj(policy))) fail('hostPolicy.policy must be "production", "off" or an explicit {book, hostOwnership, mirrors, ...}');
  try { resolveHostPolicyConfig({env: {ENCLAVE_PLATFORM_HOST_POLICY: typeof policy === 'string' ? policy : JSON.stringify(policy)}, chainId: 8453}); }
  catch (e) { fail(`hostPolicy.policy: ${e.message}`); }
  let endpoint = null, stateDir = null;
  if (policy !== 'off') {
    try { const u = new URL(c.hostPolicy.endpoint); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0; endpoint = String(c.hostPolicy.endpoint); }
    catch { fail('hostPolicy.endpoint must be this host\'s registry endpoint (its PUBLIC_URL)'); }
    stateDir = absFile(c.hostPolicy.stateDir, 'hostPolicy.stateDir');
  } else if (['endpoint', 'stateDir', 'mirrors', 'rpcs', 'carriers'].some((k) => c.hostPolicy[k] !== undefined)) fail('hostPolicy "off" takes no endpoint, stateDir, mirrors, rpcs or carriers');
  // Carriers for the policy DOCUMENT without the fleet (network/policy-carriers.mjs through the integrated runner's own
  // policyEnv/policyCarrierFetch, not a copy): an operator-imported directory, this host's policy-mirror role store, other
  // hosts' policy mirrors. Untrusted transport: the unchanged gate still requires the book's anchored digest signed by its
  // current owner at a fresh agreed block. mirrors: extra HTTPS mirror origins; rpcs: the policy's own RPC quorum.
  let mirrors = [], rpcs = null, carriers = null;
  if (c.hostPolicy.mirrors !== undefined) {
    if (!Array.isArray(c.hostPolicy.mirrors) || c.hostPolicy.mirrors.length > 8) fail('hostPolicy.mirrors must list at most 8 https origins');
    mirrors = c.hostPolicy.mirrors.map((m, i) => { let u; try { u = new URL(m); } catch { fail(`hostPolicy.mirrors[${i}] is not a URL`); }
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail(`hostPolicy.mirrors[${i}] must be https without credentials`); return u.href.replace(/\/+$/, ''); });
  }
  if (c.hostPolicy.rpcs !== undefined) rpcs = rpcList(c.hostPolicy.rpcs, 'hostPolicy.rpcs');
  if (c.hostPolicy.carriers !== undefined) {
    only(c.hostPolicy.carriers, ['importDir', 'policyMirrorStateDir', 'peers'], 'hostPolicy.carriers');
    const k = c.hostPolicy.carriers;
    carriers = {...(k.importDir !== undefined ? {importDir: absFile(k.importDir, 'hostPolicy.carriers.importDir')} : {}),
      ...(k.policyMirrorStateDir !== undefined ? {policyMirrorStateDir: absFile(k.policyMirrorStateDir, 'hostPolicy.carriers.policyMirrorStateDir')} : {}),
      ...(k.peers !== undefined ? {peers: k.peers} : {})};
    if (!Object.keys(carriers).length) fail('hostPolicy.carriers names no carrier');
  }
  const hostPolicy = {policy, endpoint, stateDir, mirrors, rpcs, carriers};
  if (policy !== 'off') { try { const e = hostPolicyGateEnv(hostPolicy); resolveHostPolicyConfig({env: e.env, chainId: 8453}); } catch (e) { fail(`hostPolicy: ${e.message}`); } }
  return Object.freeze({role: c.role, release, zones, nsName, nsNames, listen, front, routeMap, snp, shield, chain, peers, upstream, hostPolicy});
}

/** The child's COMPLETE environment for the normalized configuration (nothing inherited but PATH / SystemRoot). */
export function challengeReplicaEnv(cfg, {basePath = process.env.PATH || '', systemRoot = process.env.SystemRoot} = {}) {
  const env = {PATH: basePath, ...(systemRoot ? {SystemRoot: systemRoot} : {}),
    NS_NAME: cfg.nsName, NS_NAMES: cfg.nsNames.join(','), DNS_BIND: cfg.listen.dns.ip, DNS_PORT: String(cfg.listen.dns.port),
    DNS_API_BIND: cfg.listen.api.ip, DNS_API_PORT: String(cfg.listen.api.port)};
  if (cfg.role === 'app-zone-replica') {
    Object.assign(env, {DNS_READ_ONLY: '1', IP_ZONE: cfg.zones.ip, APP_ZONE: cfg.zones.app, ROUTE_MAP_URL: cfg.routeMap, APP_CHALLENGE_AUTH: 'attested-lease',
      APP_CHALLENGE_JUDGE_MODE: 'trusted', APP_CHALLENGE_RPCS: cfg.chain.rpcs.join(','), APP_CHALLENGE_PINS: JSON.stringify(cfg.chain.pins)});
    if (cfg.snp) { env.APP_CHALLENGE_MEASUREMENTS = cfg.snp.measurements.join(','); if (cfg.snp.minTcb) env.APP_CHALLENGE_MIN_TCB = cfg.snp.minTcb; }
    if (cfg.shield) Object.assign(env, {APP_CHALLENGE_SHIELD_POLICY: cfg.shield.policyFile, APP_CHALLENGE_SHIELD_PROFILE: cfg.shield.profileFile,
      APP_CHALLENGE_SHIELD_PROFILE_DIGEST: cfg.shield.profileDigest, APP_CHALLENGE_SHIELD_RPCS: cfg.shield.rpcs.join(','),
      ...(cfg.shield.pinsFile ? {APP_CHALLENGE_SHIELD_PINS: cfg.shield.pinsFile} : {})});
    if (cfg.peers.length) env.APP_CHALLENGE_PEERS = cfg.peers.join(',');
    if (cfg.upstream) env.APP_CHALLENGE_UPSTREAM = cfg.upstream;
  } else {
    Object.assign(env, {DNS_CHALLENGE_AUTH: 'attested', CHALLENGE_ZONE: cfg.zones.challenge, ATTESTED_JUDGE_MODE: 'trusted'});
    if (cfg.snp) { env.ATTESTED_MEASUREMENTS = cfg.snp.measurements.join(','); if (cfg.snp.minTcb) env.ATTESTED_MIN_TCB = cfg.snp.minTcb; }
    if (cfg.shield) Object.assign(env, {ATTESTED_SHIELD_POLICY: cfg.shield.policyFile, ATTESTED_SHIELD_PROFILE: cfg.shield.profileFile,
      ATTESTED_SHIELD_PROFILE_DIGEST: cfg.shield.profileDigest, ATTESTED_SHIELD_RPCS: cfg.shield.rpcs.join(','),
      ...(cfg.shield.pinsFile ? {ATTESTED_SHIELD_PINS: cfg.shield.pinsFile} : {})});
  }
  return env;
}

/** The release directory must hold exactly the pinned files: -> {entry, dnsSha256, runtimeBundleSha256}; throws otherwise. */
export function verifyReplicaRelease(release) {
  const read = (name) => {
    const p = path.join(release.dir, name);
    const st = fs.lstatSync(p, {throwIfNoEntry: false});
    if (!st || !st.isFile()) fail(`release: ${name} must be a regular file in ${release.dir}`);
    if (process.platform !== 'win32' && (st.mode & 0o022)) fail(`release: ${name} must not be group- or world-writable`);
    return fs.readFileSync(p);
  };
  const dns = sha256(read('dns.mjs')), bundle = sha256(read('network-runtime.bundle.mjs'));
  if (dns !== release.dnsSha256) fail(`release: dns.mjs is ${dns}, not the pinned ${release.dnsSha256}`);
  if (bundle !== release.runtimeBundleSha256) fail(`release: network-runtime.bundle.mjs is ${bundle}, not the pinned ${release.runtimeBundleSha256}`);
  let manifest;
  try { manifest = JSON.parse(read('dns.mjs.manifest.json')); } catch (e) { fail(`release: dns.mjs.manifest.json: ${e.message}`); }
  if (manifest.sha256 !== dns || manifest.runtimeBundleSha256 !== bundle) fail('release: the manifest does not name the pinned files');
  return {entry: path.join(release.dir, 'dns.mjs'), dnsSha256: dns, runtimeBundleSha256: bundle};
}

// the routes the public HTTPS front carries, per role, with the replica's own body caps (relay/dns-relay.js
// APP_PUSH_MAX, relay/dns-challenge-shield.mjs SHIELD_CHALLENGE_MAX_BYTES / SHIELD_ATTEST_MAX_BYTES)
const FRONT_ROUTES = {
  'app-zone-replica': [['/v1/app-challenge', ['POST', 'DELETE'], 32768], ['/v1/app-zone/shield-session/challenge', ['POST'], 796108],
    ['/v1/app-zone/shield-session/attest', ['POST'], 12591104], ['/health', ['GET'], 0]],
  'owner-responder': [['/v1/txt', ['POST', 'DELETE'], 32768], ['/v1/shield-session/challenge', ['POST'], 796108],
    ['/v1/shield-session/attest', ['POST'], 12591104], ['/health', ['GET'], 0]],
};
/** The HTTPS front: only the role's routes, bounded bodies, no credentials or cookies either way. -> {server, close} */
export async function startReplicaFront(cfg, {log = () => {}} = {}) {
  const routes = new Map(FRONT_ROUTES[cfg.role].map(([p, methods, cap]) => [p, {methods, cap}]));
  const server = https.createServer({cert: fs.readFileSync(cfg.front.certFile), key: fs.readFileSync(cfg.front.keyFile), minVersion: 'TLSv1.2'}, (req, res) => {
    const send = (code, body) => { if (res.headersSent) return; res.writeHead(code, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); };
    let u; try { u = new URL(req.url, 'https://front'); } catch { req.resume(); return send(400, {error: 'bad request'}); }
    const r = routes.get(u.pathname);
    if (!r || u.search) { req.resume(); return send(404, {error: 'not_found'}); }
    if (!r.methods.includes(req.method)) { req.resume(); return send(405, {error: 'method_not_allowed'}); }
    if (req.headers.authorization || req.headers.cookie) { req.resume(); return send(400, {error: 'credentials are not accepted'}); }
    const declared = req.headers['content-length'];
    if (declared !== undefined && !(Number(declared) <= r.cap)) { req.resume(); return send(413, {error: 'body_too_large'}); }
    const headers = {'content-type': req.headers['content-type'] || 'application/json'};
    for (const h of ['x-attested-sig']) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
    const up = http.request({host: cfg.listen.api.ip, port: cfg.listen.api.port, method: req.method, path: u.pathname, headers, timeout: 60_000}, (ur) => {
      const out = {'content-type': ur.headers['content-type'] || 'application/json', 'cache-control': 'no-store'};
      if (ur.headers['retry-after']) out['retry-after'] = ur.headers['retry-after'];
      res.writeHead(ur.statusCode || 502, out); ur.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => send(502, {error: 'the local replica is unavailable'}));
    let n = 0;
    req.on('data', (d) => { n += d.length; if (n > r.cap) { up.destroy(); req.destroy(); send(413, {error: 'body_too_large'}); } });
    req.pipe(up);
  });
  server.headersTimeout = 15_000; server.requestTimeout = 180_000;
  await new Promise((ok, no) => { server.once('error', no); server.listen(cfg.front.listen.port, cfg.front.listen.ip, ok); });
  log(`challenge replica: https front on ${cfg.front.listen.ip}:${server.address().port} (${cfg.role})`);
  return {server, port: server.address().port, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); })};
}

/** The EnclaveServiceIndex kind-dns advertisement, as UNSIGNED typed data for the host operator's key. Never published here. */
export function challengeReplicaAdDraft(cfg, {chainId, index, operator, slot, sequence, expiresAt, ttlSec}) {
  const descriptor = {schema: 'enclave-challenge-replica/1', role: cfg.role, zones: cfg.zones, ns: cfg.nsNames, dnsSha256: cfg.release.dnsSha256,
    runtimeBundleSha256: cfg.release.runtimeBundleSha256, evidence: {snp: !!cfg.snp, shield: !!cfg.shield}, ...(cfg.shield ? {profileDigest: cfg.shield.profileDigest} : {})};
  const canonical = canonicalJson(descriptor);
  const ad = validateAdInput({slot, kind: 'dns', endpoints: [cfg.front.origin], ttlSec, descriptor: '0x' + sha256(canonical)});
  return {descriptor, descriptorJson: canonical, typedData: publishTypedData({chainId, index, operator, slot: ad.slot, kind: SERVICE_KINDS.dns, sequence, expiresAt,
    descriptor: ad.descriptor, endpoints: ad.endpoints}), notice: 'unsigned draft: publishing is the host operator\'s signed, separate decision; an ad is an untrusted candidate, never admission'};
}

/**
 * Start the challenge service: verify the release; ask the platform host policy gate; while this host is admitted, run
 * the replica child with its derived environment (restarted with backoff when it exits) and, once its /health states the
 * configured role and pins, the HTTPS front. A refusal (ban, allowlist miss, deregistration; sticky until the admin's
 * admit) stops both; an admit starts them again. -> {health(), status(), pid(), close(), env, release}.
 * Throws (leaving nothing running) when the release, the policy's first answer, or the first start is refused.
 */
// extraCaFile and gate: CODE-LEVEL parameters for embedders and tests (a fixture RPC's test CA; an injected gate), like
// enclave-network-host.mjs ownerNameRoots; no configuration file can set them. Production RPCs and peers are verified
// against Node's public roots, and the gate is network/host-service-gate.mjs for hostPolicy.
export async function startChallengeReplica(cfg, {node = process.execPath, spawn = spawnProcess, fetch = globalThis.fetch, log = () => {}, readyMs = 60_000,
                                                  extraCaFile = null, gate = null, gateIntervalMs = 5000} = {}) {
  const release = verifyReplicaRelease(cfg.release);
  const env = challengeReplicaEnv(cfg);
  if (extraCaFile) env.NODE_EXTRA_CA_CERTS = extraCaFile;
  if (!gate) {
    const {env: policyEnvVars, shape} = hostPolicyGateEnv(cfg.hostPolicy);
    // carriers: the integrated runner's own carrier fetch (it answers only CARRIER_MIRROR; everything else is `fetch`)
    const gateFetch = cfg.hostPolicy.carriers ? await (await import('./host-services/runner.mjs')).policyCarrierFetch(shape, {fetch, log}) : fetch;
    gate = createHostServiceGate({env: policyEnvVars, chainId: 8453, endpoint: cfg.hostPolicy.endpoint, stateDir: cfg.hostPolicy.stateDir, fetch: gateFetch, log});
  }
  let child = null, closed = false, backoff = 1000, timer = null, lastExit = null, front = null, serving = false, stoppedFor = null;
  const run = () => {
    if (closed || !serving) return;
    child = spawn(node, [release.entry], {cwd: cfg.release.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    const pid = child.pid;
    const line = (d) => { for (const l of String(d).split('\n')) if (l.trim()) log(`challenge replica[${pid}]: ${l.slice(0, 400)}`); };
    child.stdout?.on('data', line); child.stderr?.on('data', line);
    // one restart per child, whichever comes first: 'exit', or 'error' without one (a failed spawn emits no 'exit')
    const me = child;
    let done = false;
    const restart = (why) => {
      if (done) return; done = true; lastExit = why;
      if (child === me) child = null;
      if (closed || !serving) return;
      log(`challenge replica ${why}; restart in ${backoff} ms`);
      timer = setTimeout(run, backoff); timer.unref?.(); backoff = Math.min(backoff * 2, 60_000);
    };
    child.on('error', (e) => restart(`spawn error ${e.code || e.message}`));
    child.on('exit', (code, sig) => restart(`exited code=${code} sig=${sig}`));
  };
  const api = `http://${cfg.listen.api.ip.includes(':') ? `[${cfg.listen.api.ip}]` : cfg.listen.api.ip}:${cfg.listen.api.port}`;
  const health = async () => {
    const h = await fetch(api + '/health', {signal: AbortSignal.timeout(5000)}).then((r) => r.json());
    const ok = cfg.role === 'app-zone-replica'
      ? h.readOnly === true && h.appChallenge?.mode === 'attested-lease' && h.appChallenge.judgeMode === 'trusted' && h.appChallenge.ledgerIndex?.complete === true
        && (!cfg.shield || (h.appChallenge.shield?.hostExcluded === false && h.appChallenge.shield.registry?.profileDigest === cfg.shield.profileDigest))
      : h.mode === 'attested' && h.judgeMode === 'trusted' && (!cfg.shield || (h.shield?.hostExcluded === false && h.shield.registry?.profileDigest === cfg.shield.profileDigest));
    return {ok, state: h};
  };
  const stopChild = async () => {
    clearTimeout(timer);
    const c = child; if (!c) return;
    await new Promise((ok) => { const k = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} ok(); }, 5000); c.once('exit', () => { clearTimeout(k); ok(); }); try { c.kill('SIGTERM'); } catch { clearTimeout(k); ok(); } });
  };
  const halt = async (why) => { serving = false; stoppedFor = why; await front?.close(); front = null; await stopChild(); };
  // start: the child, then (once healthy) the front. Throws on no readiness, after stopping what it started.
  const begin = async () => {
    serving = true; stoppedFor = null; backoff = 1000; lastExit = null;
    run();
    const deadline = Date.now() + readyMs;
    let ready = null, why = 'not answering';
    while (Date.now() < deadline && serving) {
      try { const h = await health(); if (h.ok) { ready = h; break; } why = 'health does not state the configured role, trusted judge, complete index and pinned profile'; }
      catch (e) { why = e.message; }
      if (!child && lastExit && backoff > 4000) break;   // it keeps exiting: a configuration the replica itself refuses
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) { await halt('not ready'); fail(`the replica did not become ready (${lastExit || why})`); }
    backoff = 1000;
    try { front = await startReplicaFront(cfg, {log}); } catch (e) { await halt('front'); fail(`https front: ${e.message}`); }
    log(`challenge replica serving: ${cfg.role}, release ${release.dnsSha256.slice(0, 12)}, ${cfg.snp ? 'SEV-SNP ' : ''}${cfg.shield ? 'Shield ' : ''}evidence`);
  };
  // the policy's first answer decides whether anything starts at all
  await gate.check().catch(() => {});
  const first = gate.serviceRefusal();
  if (first) fail(`not started: ${first}`);
  await begin();
  let frontPort = front.port, ticking = null;
  gate.start?.();
  const tick = setInterval(() => {
    if (ticking || closed) return;
    ticking = (async () => {
      await gate.check().catch(() => {});
      const refusal = gate.serviceRefusal();
      if (refusal && serving) { log(`challenge replica STOPPED: ${refusal}`); await halt(refusal); }
      else if (!refusal && !serving && !closed) {
        log('challenge replica: this host is admitted again; starting');
        try { await begin(); frontPort = front.port; } catch (e) { log(`challenge replica restart refused: ${e.message}`); }
      }
    })().finally(() => { ticking = null; });
  }, gateIntervalMs);
  tick.unref?.();
  return {env, release, get frontPort() { return frontPort; }, health, pid: () => child?.pid ?? null,
    // serving: healthy and the front is open; wanted: admitted and (re)starting or running
    status: () => ({serving: front !== null, wanted: serving, stoppedFor, platformHostPolicy: gate.status?.() ?? null}),
    close: async () => { closed = true; clearInterval(tick); gate.stop?.(); await ticking; await halt('closed'); }};
}
