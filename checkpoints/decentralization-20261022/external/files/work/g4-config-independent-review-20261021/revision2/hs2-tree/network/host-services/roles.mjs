// Enclave host-service roles (work/hosted-service-placement): the PUBLIC discovery and bootstrap services that today run
// as ordinary systemd units on the four DigitalOcean transport machines, as roles an Enclave host runs from a pinned,
// reproducible package (scripts/build-host-service-packages.mjs) under network/host-services/runner.mjs.
//
// Why a host role and not an Enclave app: an Enclave app is a WebAssembly component (isolation/contract/RUNTIME.md,
// bundle kind wasm-component, refused otherwise). These services are Node programs (node:http, node:dgram, durable
// files, viem, IPNS). No supported runtime runs them as a component, and none is claimed here. What makes them fit an
// Enclave HOST is what they serve: public records whose authority is a signature, a chain read or a content hash, never
// the server. A host serves them; clients verify them (network/cold-bootstrap.mjs, directory-client.mjs, discovery.mjs).
//
// Every role here:
//   - holds NO secret (no key, token, fleet secret, upload or control credential) and its config refuses any (one
//     exception: service-tls GENERATES its ACME account key and TLS key on the host, in a private directory it checks
//     before starting; its configuration still holds none);
//   - keeps the original authority resolution: the admin-controlled EnclaveAddressBook (and optional authority pins), the
//     operator's RPC quorum, the operator's pinned checkers; nothing defaults to an enclave.host origin;
//   - starts COLD: no discovery, storage adapter, artifact download, lease relay or app it helps recover is needed to start
//     (`cold` lists exactly what is);
//   - is advertised by the host operator in the ownerless EnclaveServiceIndex (`advertise`) as an untrusted candidate; the
//     platform host policy (bans, allowlist) applies on the host (runner gate) and on every client (applyHostPolicy).
import net from 'node:net';
import path from 'node:path';
import { validateNetworkAuthorities } from '../network-authorities.mjs';
import { rpcEndpoint } from '../rpc-identity.mjs';
import { publicIPv4 } from '../service-index.mjs';
import { validateCarrierBases } from '../policy-carriers.mjs';
import { CREDIT_VAULT_SUBMITTER_ROLE } from './credit-vault-submitter.mjs';
import { SERVICE_TLS_ROLE } from './service-tls.mjs';

export const PACKAGE_FORMAT = 'enclave-host-service-package/v1';
export const CONFIG_FORMAT = 'enclave-host-services/v1';
const ADDR = /^0x[0-9a-fA-F]{40}$/, NONZERO = (a) => ADDR.test(a) && !/^0x0{40}$/i.test(a);
const fail = (role, m) => { throw new Error(`${role}: ${m}`); };
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
function only(role, o, allowed, required = allowed) {
  if (!plain(o)) fail(role, 'config must be an object');
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(role, `unknown config field ${JSON.stringify(k)}${SECRETISH.test(k) ? ' (a host service holds no secret)' : ''}`);
  for (const k of required) if (o[k] === undefined || o[k] === null || o[k] === '') fail(role, `${k} is required`);
}
// a name that looks like a credential is refused even before the allowlist says why
export const SECRETISH = /(secret|token|password|passwd|private|mnemonic|seed|apikey|api_key|auth|hmac|credential|key$|keyfile)/i;
const port = (role, v, what) => { if (!Number.isInteger(v) || v < 1 || v > 65535) fail(role, `${what} must be a port`); return v; };
const bind = (role, v) => { if (typeof v !== 'string' || !/^(127\.0\.0\.1|0\.0\.0\.0|::|::1|(\d{1,3}\.){3}\d{1,3})$/.test(v)) fail(role, 'bind must be an IP literal'); return v; };
const absDir = (role, v, what) => { if (typeof v !== 'string' || !path.isAbsolute(v) || v.includes('\0')) fail(role, `${what} must be an absolute path`); return v; };
function rpcs(role, list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 8) fail(role, 'rpc: 2 to 8 Base RPC URLs of distinct providers (the operator\'s quorum)');
  const seen = new Set();
  for (const [i, r] of list.entries()) {
    let e; try { e = rpcEndpoint(r); } catch (x) { fail(role, `rpc[${i}]: ${x.message}`); }
    if (seen.has(e.identity)) fail(role, `rpc[${i}] repeats a provider`); seen.add(e.identity);
  }
  return list;
}
const origins = (role, list, what, { min = 0, max = 8 } = {}) => {
  if (!Array.isArray(list) || list.length < min || list.length > max) fail(role, `${what}: ${min} to ${max} origins`);
  return list.map((o, i) => {
    let u; try { u = new URL(o); } catch { fail(role, `${what}[${i}] is not a URL`); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') fail(role, `${what}[${i}] must be a bare http(s) origin`);
    return u.origin;
  });
};

// APP_STATIC (relay/dns-relay.js): fixed A records for PLATFORM services sharing the app zone, answered before the route
// map. Every other single label there is a deployment's: an on-chain id (8-64 hex, optionally 0x / dep- / dep_) or a
// legacy dep_<[a-z0-9]+> id (relay/api-relay.js depFromHost), so a static label must not be readable as either - it MUST
// contain a hyphen and must not start with dep-, dep_, 0x or xn--. Malformed, deployment-shaped or non-public entries are
// REFUSED (the relay would silently drop them). -> { label: ipv4 | [ipv4, ...] } sorted by label. A list (1-8 distinct public
// addresses, joined with "+" for the relay) is a host's own service name reached through several WireGuard providers
// (network/host-services/stage-tool.mjs hostServicePublication); a single string is unchanged.
function appStatic(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('route-dns', 'appStatic must map labels to IPv4 addresses');
  const entries = Object.entries(m);
  if (entries.length > 32) fail('route-dns', 'appStatic: at most 32 labels');
  for (const [l, a] of entries) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) fail('route-dns', `appStatic label ${JSON.stringify(l)} is not a lowercase DNS label`);
    if (!l.includes('-') || /^(dep[-_]|0x|xn--)/.test(l)) fail('route-dns', `appStatic label ${JSON.stringify(l)} could name a deployment (a static label needs a hyphen and no dep-/0x/xn-- prefix)`);
    const list = Array.isArray(a) ? a : [a];
    if (!list.length || list.length > 8 || list.some((x) => typeof x !== 'string' || !publicIPv4(x)) || new Set(list).size !== list.length)
      fail('route-dns', `appStatic.${l}: a public IPv4 address, or a list of 1 to 8 distinct ones`);
  }
  return Object.fromEntries(entries.sort(([x], [y]) => (x < y ? -1 : 1)));
}

/**
 * role -> { entry (repo-relative module bundled), kind (service-index kind), runtime, state, cold, launch(config, paths) }.
 * launch -> { args: [...], env: {...}, configFile: object|null } for the child process; only validated, public fields.
 */
export const ROLES = Object.freeze({
  'directory-replica': Object.freeze({
    entry: 'network/directory-server.mjs', kind: 'directory', runtime: 'node>=22 (host role; not a wasm component)',
    serves: 'signed public network records: providers, checker qualifications, owner policies, app routes, host management records',
    state: { durable: true, what: 'accepted records and per-app replay floors (route-floors)', rebuild: 'records re-import from peers and re-publication; replay floors must persist (a corrupt store refuses startup, never resets)' },
    secrets: 'none',
    cold: ['two or more Base RPC providers (the operator\'s quorum)', 'the admin-controlled EnclaveAddressBook address (and optional authority pins)'],
    notCold: ['peers (optional; a replica starts empty and accepts signed submissions)', 'storage adapters', 'artifact replicas', 'lease relays', 'any app'],
    validate(c) {
      only('directory-replica', c, ['port', 'bind', 'stateDir', 'rpc', 'addressBook', 'authorityPins', 'checkers', 'peers'], ['port', 'bind', 'stateDir', 'rpc', 'addressBook', 'checkers']);
      port('directory-replica', c.port, 'port'); bind('directory-replica', c.bind); absDir('directory-replica', c.stateDir, 'stateDir'); rpcs('directory-replica', c.rpc);
      if (!NONZERO(c.addressBook)) fail('directory-replica', 'addressBook must be the admin-controlled EnclaveAddressBook address');
      if (c.authorityPins !== undefined) { try { validateNetworkAuthorities(c.authorityPins); } catch (e) { fail('directory-replica', `authorityPins: ${e.message}`); } }
      if (!Array.isArray(c.checkers) || c.checkers.length < 1 || c.checkers.length > 16 || !c.checkers.every(NONZERO)) fail('directory-replica', 'checkers: 1 to 16 checker addresses the operator trusts');
      const peers = origins('directory-replica', c.peers ?? [], 'peers');
      return { port: c.port, bind: c.bind, stateDir: c.stateDir, rpc: [...c.rpc], addressBook: c.addressBook, ...(c.authorityPins ? { authorityPins: c.authorityPins } : {}),
        checkers: c.checkers.map((x) => x.toLowerCase()), peers };
    },
    launch(c) { return { configFile: c, env: {} }; },
  }),
  'bootstrap-replica': Object.freeze({
    entry: 'network/bootstrap-gateway.mjs', kind: 'replica', runtime: 'node>=22 (host role; not a wasm component)',
    serves: 'CID-addressed public bootstrap artifacts (release and runtime downloads), GET/HEAD /ipfs/<cid>, digest-checked at start',
    state: { durable: true, what: 'the artifact files of a verified bootstrap manifest', rebuild: 'refilled by CID from any replica or storage copy (fill: sha256 and CAR digest checked before a file is kept)' },
    secrets: 'none',
    cold: ['the artifact files on local disk, each checked against the manifest\'s sha256 and CAR digest before the first request'],
    notCold: ['discovery', 'directories', 'storage adapters', 'lease relays', 'any app', 'the network (once filled)'],
    validate(c) {
      only('bootstrap-replica', c, ['port', 'bind', 'directory', 'manifest', 'maxObjectBytes'], ['port', 'bind', 'directory', 'manifest']);
      port('bootstrap-replica', c.port, 'port'); bind('bootstrap-replica', c.bind);
      absDir('bootstrap-replica', c.directory, 'directory'); absDir('bootstrap-replica', c.manifest, 'manifest');
      if (c.maxObjectBytes !== undefined && (!Number.isSafeInteger(c.maxObjectBytes) || c.maxObjectBytes < 1 || c.maxObjectBytes > 1024 ** 3)) fail('bootstrap-replica', 'maxObjectBytes: 1 byte to 1 GiB');
      return { port: c.port, bind: c.bind, directory: c.directory, manifest: c.manifest, ...(c.maxObjectBytes ? { maxObjectBytes: c.maxObjectBytes } : {}) };
    },
    launch(c) { return { configFile: c, env: {} }; },
  }),
  'route-dns': Object.freeze({
    entry: 'relay/dns-relay.js', kind: 'dns', runtime: 'node>=22 (host role; not a wasm component)',
    // a plain script: bundled behind the argv guard so no bundled library's own CLI entry check can fire (argv-guard.mjs)
    bundleEntry: 'network/host-services/entries/route-dns.mjs',
    serves: 'authoritative answers for the app zone from VERIFIED routes (DNS_READ_ONLY: no fleet discovery, no challenge writes, no TXT key)',
    state: { durable: false, what: 'none: the route map is re-read from the route source', rebuild: 'n/a' },
    secrets: 'none (read-only mode forces the TXT key off)',
    cold: ['a route source: this host\'s own directory replica (loopback) or another directory origin the operator names'],
    notCold: ['the fleet relay', 'api.enclave.host', 'storage adapters', 'lease relays', 'any app'],
    validate(c) {
      only('route-dns', c, ['dnsPort', 'bind', 'apiPort', 'apiBind', 'zone', 'ipZone', 'nsName', 'nsNames', 'routeMapUrl', 'rateLimitPerSec', 'rateLimitCap', 'transportRateLimitPerSec', 'transportRateLimitCap', 'appStatic', 'challengeTxtUpstream', 'challengeTxtUpstreams'],
        ['dnsPort', 'bind', 'apiPort', 'zone', 'ipZone', 'nsName', 'nsNames', 'routeMapUrl']);
      port('route-dns', c.dnsPort, 'dnsPort'); bind('route-dns', c.bind); port('route-dns', c.apiPort, 'apiPort');
      if (c.apiBind !== undefined) bind('route-dns', c.apiBind);
      const zoneRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
      if (typeof c.zone !== 'string' || !zoneRe.test(c.zone)) fail('route-dns', 'zone must be the app zone the operator serves');
      if (typeof c.ipZone !== 'string' || !zoneRe.test(c.ipZone)) fail('route-dns', 'ipZone must be the address zone the operator serves');
      if (!Array.isArray(c.nsNames) || c.nsNames.length < 1 || c.nsNames.length > 8 || !c.nsNames.every((n) => typeof n === 'string' && zoneRe.test(n))) fail('route-dns', 'nsNames: 1 to 8 nameserver names');
      if (!c.nsNames.includes(c.nsName)) fail('route-dns', 'nsName (this replica) must be one of nsNames');
      let u; try { u = new URL(c.routeMapUrl); } catch { fail('route-dns', 'routeMapUrl is not a URL'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/v1/network/routes') fail('route-dns', 'routeMapUrl must be a directory\'s /v1/network/routes (no credentials or query)');
      for (const k of ['rateLimitPerSec', 'rateLimitCap', 'transportRateLimitPerSec', 'transportRateLimitCap']) if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 1e6)) fail('route-dns', `${k}: 1 to 1000000`);
      // the loopback transport's ONE aggregate bucket (relay/dns-relay.js DNS_RL_TRANSPORT_*): both or neither, cap >= rate
      if ((c.transportRateLimitPerSec === undefined) !== (c.transportRateLimitCap === undefined) || (c.transportRateLimitCap !== undefined && c.transportRateLimitCap < c.transportRateLimitPerSec))
        fail('route-dns', 'transportRateLimitPerSec and transportRateLimitCap: both or neither, cap >= rate');
      // the platform's dns-01 challenge source this replica merges TXT from (relay/dns-relay.js CHALLENGE_TXT_UPSTREAM): an
      // explicit IP literal and port, never a name (no resolver is consulted for it), and never this replica's own DNS port
      if (c.challengeTxtUpstream !== undefined && c.challengeTxtUpstreams !== undefined)
        fail('route-dns', 'give challengeTxtUpstream or challengeTxtUpstreams, not both');
      const ups = c.challengeTxtUpstreams !== undefined ? c.challengeTxtUpstreams : (c.challengeTxtUpstream !== undefined ? [c.challengeTxtUpstream] : null);
      if (c.challengeTxtUpstreams !== undefined || c.challengeTxtUpstream !== undefined) {
        if (!Array.isArray(ups) || ups.length < 1 || ups.length > 4) fail('route-dns', 'challengeTxtUpstreams must contain 1 to 4 distinct IP literal and port endpoints');
        const seen = new Set();
        for (const up of ups) {
          const m = typeof up === 'string' && /^(\[[0-9a-f:]+\]|[0-9.]+):([0-9]{1,5})$/i.exec(up);
          const host = m ? m[1].replace(/^\[|\]$/g, '') : '', p = m ? Number(m[2]) : 0;
          if (!m || !net.isIP(host) || p < 1 || p > 65535) fail('route-dns', 'challengeTxtUpstream(s) must be an IP literal and port (ip:port or [ipv6]:port)');
          const key = new URL(`http://${up}`).host, canonicalHost = new URL(`http://${up}`).hostname;
          if (seen.has(key)) fail('route-dns', 'challengeTxtUpstreams must contain distinct endpoints');
          seen.add(key);
          const bindHost = net.isIP(c.bind) === 6 ? `[${c.bind}]` : c.bind;
          if (p === c.dnsPort && (canonicalHost === new URL(`http://${bindHost}`).hostname || ['127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(canonicalHost)))
            fail('route-dns', 'challengeTxtUpstream(s) must not be this replica itself');
        }
      }

      return { ...c, ...(c.appStatic !== undefined ? { appStatic: appStatic(c.appStatic) } : {}) };
    },
    // dns-relay reads its configuration from the environment: exactly these names, every one explicit (NO_FALLBACK there
    // refuses an absent name instead of an enclave.host default)
    launch(c) {
      // the push API answers 503 without a TXT key (read-only); it listens on loopback unless the operator says otherwise
      return { configFile: null, env: { DNS_READ_ONLY: '1', APP_ZONE: c.zone, IP_ZONE: c.ipZone, NS_NAME: c.nsName, NS_NAMES: c.nsNames.join(','), ROUTE_MAP_URL: c.routeMapUrl,
        DNS_PORT: String(c.dnsPort), DNS_BIND: c.bind, DNS_API_PORT: String(c.apiPort), DNS_API_BIND: c.apiBind || '127.0.0.1',
        ...(c.rateLimitPerSec ? { DNS_RL_PER_SEC: String(c.rateLimitPerSec) } : {}), ...(c.rateLimitCap ? { DNS_RL_CAP: String(c.rateLimitCap) } : {}),
        ...(c.transportRateLimitPerSec ? { DNS_RL_TRANSPORT_PER_SEC: String(c.transportRateLimitPerSec), DNS_RL_TRANSPORT_CAP: String(c.transportRateLimitCap) } : {}),
        ...(c.challengeTxtUpstream ? { CHALLENGE_TXT_UPSTREAM: c.challengeTxtUpstream } : {}),
        ...(c.challengeTxtUpstreams ? { CHALLENGE_TXT_UPSTREAMS: JSON.stringify(c.challengeTxtUpstreams) } : {}),
        ...(c.appStatic && Object.keys(c.appStatic).length ? { APP_STATIC: Object.entries(c.appStatic).map(([l, a]) => `${l}=${Array.isArray(a) ? a.join('+') : a}`).join(',') } : {}) } };
    },
  }),
  'policy-mirror': Object.freeze({
    entry: 'network/host-services/policy-mirror.mjs', kind: 'policy', runtime: 'node>=22 (host role; not a wasm component)',
    serves: 'the administrator\'s signed platform host policy documents by digest (GET /platform-policy/<digest>.json, POST /platform-policy): an untrusted carrier the platform host policy gate and clients verify',
    state: { durable: false, what: 'documents the address book\'s current owner signs at a fresh agreed block (public data)', rebuild: 'refilled by digest from importDir, peers or publication; every gate re-verifies' },
    secrets: 'none',
    cold: ['two or more Base RPC providers (the operator\'s quorum)', 'the admin-controlled EnclaveAddressBook and the hostOwnership extension it binds', 'the anchored document from ANY carrier: importDir (an operator-imported copy), a peer, or a publication'],
    notCold: ['the fleet\'s /platform-policy routes', 'discovery', 'storage adapters', 'lease relays', 'any app', 'this host\'s own admission (its gate reads importDir and this role\'s store from disk)'],
    validate(c) {
      only('policy-mirror', c, ['port', 'bind', 'stateDir', 'rpc', 'minAgree', 'book', 'hostOwnership', 'peers', 'importDir', 'syncSec', 'maxDocuments'],
        ['port', 'bind', 'stateDir', 'rpc', 'book', 'hostOwnership']);
      port('policy-mirror', c.port, 'port'); bind('policy-mirror', c.bind); absDir('policy-mirror', c.stateDir, 'stateDir'); rpcs('policy-mirror', c.rpc);
      if (c.minAgree !== undefined && (!Number.isInteger(c.minAgree) || c.minAgree <= c.rpc.length / 2 || c.minAgree > c.rpc.length)) fail('policy-mirror', 'minAgree must be a majority of rpc');
      for (const k of ['book', 'hostOwnership']) if (!NONZERO(c[k])) fail('policy-mirror', `${k} must be the platform host policy's ${k === 'book' ? 'admin-controlled EnclaveAddressBook' : 'EnclaveHostOwnership extension'}`);
      let peers; try { peers = validateCarrierBases(c.peers ?? [], 'peers'); } catch (e) { fail('policy-mirror', e.message); }
      if (c.importDir !== undefined) absDir('policy-mirror', c.importDir, 'importDir');
      if (c.syncSec !== undefined && (!Number.isInteger(c.syncSec) || c.syncSec < 5 || c.syncSec > 3600)) fail('policy-mirror', 'syncSec: 5 to 3600');
      if (c.maxDocuments !== undefined && (!Number.isInteger(c.maxDocuments) || c.maxDocuments < 2 || c.maxDocuments > 32)) fail('policy-mirror', 'maxDocuments: 2 to 32');
      return { port: c.port, bind: c.bind, stateDir: c.stateDir, rpc: [...c.rpc], ...(c.minAgree ? { minAgree: c.minAgree } : {}), book: c.book.toLowerCase(),
        hostOwnership: c.hostOwnership.toLowerCase(), peers, ...(c.importDir ? { importDir: c.importDir } : {}), ...(c.syncSec ? { syncSec: c.syncSec } : {}),
        ...(c.maxDocuments ? { maxDocuments: c.maxDocuments } : {}) };
    },
    launch(c) { return { configFile: c, env: {} }; },
  }),
  // passkey-signed credit-vault requests (and, only with a reviewed record, the proposed parallel lease-gas reserve's): no key in
  // the role, gas signed by the operator's loopback external signer (network/host-services/credit-vault-submitter.mjs)
  'credit-vault-submitter': CREDIT_VAULT_SUBMITTER_ROLE,
  // HTTPS for this host's derived service names: a host-local Let's Encrypt http-01 client and loopback TLS terminator in
  // front of the three roles above (network/host-services/service-tls.mjs; the runner binds it to the host config)
  'service-tls': SERVICE_TLS_ROLE,
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
