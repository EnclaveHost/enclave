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
//   - holds NO secret (no key, token, fleet secret, upload or control credential) and its config refuses any;
//   - keeps the original authority resolution: the admin-controlled EnclaveAddressBook (and optional authority pins), the
//     operator's RPC quorum, the operator's pinned checkers; nothing defaults to an enclave.host origin;
//   - starts COLD: no discovery, storage adapter, artifact download, lease relay or app it helps recover is needed to start
//     (`cold` lists exactly what is);
//   - is advertised by the host operator in the ownerless EnclaveServiceIndex (`advertise`) as an untrusted candidate; the
//     platform host policy (bans, allowlist) applies on the host (runner gate) and on every client (applyHostPolicy).
import path from 'node:path';
import { validateNetworkAuthorities } from '../network-authorities.mjs';
import { rpcEndpoint } from '../rpc-identity.mjs';

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
    serves: 'authoritative answers for the app zone from VERIFIED routes (DNS_READ_ONLY: no fleet discovery, no challenge writes, no TXT key)',
    state: { durable: false, what: 'none: the route map is re-read from the route source', rebuild: 'n/a' },
    secrets: 'none (read-only mode forces the TXT key off)',
    cold: ['a route source: this host\'s own directory replica (loopback) or another directory origin the operator names'],
    notCold: ['the fleet relay', 'api.enclave.host', 'storage adapters', 'lease relays', 'any app'],
    validate(c) {
      only('route-dns', c, ['dnsPort', 'bind', 'apiPort', 'apiBind', 'zone', 'ipZone', 'nsName', 'nsNames', 'routeMapUrl', 'rateLimitPerSec', 'rateLimitCap'],
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
      for (const k of ['rateLimitPerSec', 'rateLimitCap']) if (c[k] !== undefined && (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 1e6)) fail('route-dns', `${k}: 1 to 1000000`);
      return { ...c };
    },
    // dns-relay reads its configuration from the environment: exactly these names, every one explicit (NO_FALLBACK there
    // refuses an absent name instead of an enclave.host default)
    launch(c) {
      // the push API answers 503 without a TXT key (read-only); it listens on loopback unless the operator says otherwise
      return { configFile: null, env: { DNS_READ_ONLY: '1', APP_ZONE: c.zone, IP_ZONE: c.ipZone, NS_NAME: c.nsName, NS_NAMES: c.nsNames.join(','), ROUTE_MAP_URL: c.routeMapUrl,
        DNS_PORT: String(c.dnsPort), DNS_BIND: c.bind, DNS_API_PORT: String(c.apiPort), DNS_API_BIND: c.apiBind || '127.0.0.1',
        ...(c.rateLimitPerSec ? { DNS_RL_PER_SEC: String(c.rateLimitPerSec) } : {}), ...(c.rateLimitCap ? { DNS_RL_CAP: String(c.rateLimitCap) } : {}) } };
    },
  }),
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
