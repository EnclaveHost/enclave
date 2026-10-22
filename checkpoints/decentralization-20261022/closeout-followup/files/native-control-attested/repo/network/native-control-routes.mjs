// Native CONTROL routes (relay/native-discovery.mjs): where api.enclavehost.eth and mcp.enclavehost.eth are served, without a
// fixed fleet address and without trusting whoever advertised the address.
//
// An advertisement only says "try this IPv4 address". What is served is decided by the SERVING identity, proven per address:
//   1. NATIVE TLS: a connection to <address>:443 with SNI <name>, verified by Node/OpenSSL against the native CA only, with
//      the hostname check. On that same connection the guest's evidence document is read: its statement must bind <name>
//      to that CA (statement.native, from the HOST_DATA-bound config), and the leaf's public key must be the statement's
//      attested control TLS key - so whatever terminates this connection holds the measured guest's minted key;
//   2. ATTESTATION, unchanged (metal/measured-control-verify.mjs verifyMeasuredControl at https://<address>, port 443, no
//      SNI: the same front, the same key): AMD chain, an allowed measurement, report bound to our fresh nonce, the control
//      role, HOST_DATA = the stated config, the TLS peer = that key, the supervisor holding the minted keys, and the ORIGINAL
//      EnclaveRegistry row (through the RPC quorum) active with the bound operator and this boot's proof key. Same boot and
//      key as step 1, or nothing;
//   3. ADMISSION, fresh: the platform host policy decision for THAT registry id (the serving host, never the advertiser),
//      admit === true, with the decision's registry row naming the same operator. A ban on the host's registry id, operator,
//      accepted owner or registered endpoint withdraws the route at the next refresh. A chipId entry cannot be matched here
//      (nativeHostDecision): while the accepted policy denies any chipId, every native control route is refused.
// A route is the exact address verified, lives at most routeTtlMs (60 s, as an app route record) and never past the leaf, and
// the configured failure domain (the DigitalOcean fleet) is never probed. No route: native discovery answers unavailable.
//
// The advertisements are EnclaveServiceIndex ads of kind 9 ("native-control"; the contract accepts any kind but 0). The shared
// reader (network/service-index.mjs, an image input) names only its own kinds, so this module reads kind 9 through the SAME
// agreedRead quorum rule and pin check, and prepareControlAd builds the publication the existing CLI sends
// (scripts/network/service-index.mjs send --prepared).
import https from 'node:https';
import tls from 'node:tls';
import { randomBytes, X509Certificate } from 'node:crypto';
import { keccak256, encodeFunctionData } from 'viem';
import { agreedRead, peerList, validateIndexPin, publishTypedData, SERVICE_INDEX_ABI, AD_VERSION, LIMITS, publicIPv4, QuorumError } from './service-index.mjs';
import { verifyMeasuredControl } from '../metal/measured-control-verify.mjs';
import { parseStatement, sha256Hex, EVIDENCE_PATH, EVIDENCE_FORMAT, NATIVE_NAMES } from '../metal/guest/measured-control.mjs';

export const CONTROL_KIND = 9;
export const CONTROL_KIND_NAME = 'native-control';
export { NATIVE_NAMES };
const lc = (s) => String(s || '').toLowerCase();
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** An advertised control endpoint -> its IPv4 address: exactly https://<public IPv4>/ (port 443). Throws otherwise. */
export function controlEndpointAddress(endpoint) {
  let u; try { u = new URL(endpoint); } catch { throw new Error('not a URL'); }
  if (u.protocol !== 'https:' || (u.port !== '' && u.port !== '443')) throw new Error('a native control endpoint is https on port 443');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('a native control endpoint is a bare https origin');
  if (!publicIPv4(u.hostname)) throw new Error('a native control endpoint is a public IPv4 literal');
  return u.hostname;
}

/** The unsigned publication of a native-control ad, in the shape scripts/network/service-index.mjs sign/send take. */
export function prepareControlAd({ pin, operator, slot, sequence, ttlSec = 30 * 86400, endpoints, now = Date.now }) {
  pin = validateIndexPin(pin);
  if (!ADDR.test(String(operator)) || !Number.isInteger(slot) || slot < 0 || slot >= LIMITS.slots) throw new Error('operator and slot 0..7 required');
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > LIMITS.endpoints) throw new Error('1 to 4 endpoints');
  const eps = endpoints.map((e) => `https://${controlEndpointAddress(e)}/`);
  if (!Number.isSafeInteger(ttlSec) || ttlSec < 60 || ttlSec > LIMITS.ttlSec) throw new Error('ttl must be 60 s to 90 days');
  const expiresAt = BigInt(Math.floor(now() / 1000) + ttlSec), descriptor = '0x' + '0'.repeat(64);
  return { action: 'publish', pin, typedData: publishTypedData({ chainId: pin.chainId, index: pin.address, operator: lc(operator), slot, kind: CONTROL_KIND, sequence, expiresAt, descriptor, endpoints: eps }),
    call: { to: pin.address, from: lc(operator), data: encodeFunctionData({ abi: SERVICE_INDEX_ABI, functionName: 'publish', args: [slot, CONTROL_KIND, AD_VERSION, BigInt(sequence), expiresAt, descriptor, eps] }) } };
}

/**
 * Candidate addresses from the pinned index, read at ONE block two RPCs return identically (agreedRead): named operators
 * first (get(operator, slot) for every slot, so listing spam cannot hide them), then up to `window` listed kind-9 ads.
 * -> { candidates: [{ address, operator, slot, expiresAt (ms) }], rejected: [{ operator, slot, endpoint?, reason }], blockNumber, complete }
 */
export async function readControlCandidates({ peers, clients, indexPin, operators = [], window = 256, now = Date.now, ...policy }) {
  const pin = validateIndexPin(indexPin);
  const list = peerList({ peers, clients, methods: ['getCode', 'readContract'] });
  if (!Array.isArray(operators) || operators.length > 32 || operators.some((o) => !ADDR.test(String(o)))) throw new Error('at most 32 operator addresses');
  if (!Number.isSafeInteger(window) || window < 1 || window > LIMITS.perKind) throw new Error(`window must be 1..${LIMITS.perKind}`);
  const wanted = operators.flatMap((o) => [...Array(LIMITS.slots).keys()].map((slot) => ({ operator: lc(o), slot })));
  const r = await agreedRead({ peers: list, chainId: pin.chainId, now, ...policy, read: async (c, blockNumber, call) => {
    const code = await call('code', () => c.getCode({ address: pin.address, blockNumber }));
    const value = { codeHash: code ? keccak256(code) : null, ads: [], total: 0n, lookups: [] };
    if (value.codeHash !== pin.codeHash) return value;
    for (const w of wanted) value.lookups.push(await call(`get ${w.operator}/${w.slot}`, () => c.readContract({ address: pin.address, abi: SERVICE_INDEX_ABI, functionName: 'get', args: [w.operator, w.slot], blockNumber })));
    for (let at = 0n; value.ads.length < window; at += BigInt(LIMITS.page)) {
      const limit = BigInt(Math.min(LIMITS.page, window - value.ads.length));
      const [out, t] = await call(`page ${CONTROL_KIND}@${at}`, () => c.readContract({ address: pin.address, abi: SERVICE_INDEX_ABI, functionName: 'page', args: [CONTROL_KIND, at, limit], blockNumber }));
      value.total = t; value.ads.push(...out);
      if (out.length < Number(limit) || at + BigInt(out.length) >= t) break;
    }
    return value;
  } });
  const v = r.value;
  if (v.codeHash !== pin.codeHash) throw new QuorumError(`the agreed code at ${pin.address} is ${v.codeHash || 'absent'}, not the pinned ${pin.codeHash}`, r.evidence);
  const ts = BigInt(r.timestamp), candidates = [], rejected = [], seen = new Set();
  for (const a of [...v.lookups, ...v.ads]) {
    if (!a || /^0x0{40}$/i.test(a.operator) || Number(a.kind) !== CONTROL_KIND) continue;
    const base = { operator: lc(a.operator), slot: Number(a.slot) };
    if (BigInt(a.expiresAt) <= ts) continue;
    if (Number(a.version) !== AD_VERSION) { rejected.push({ ...base, reason: `ad format version ${a.version}` }); continue; }
    for (const e of a.endpoints) {
      let address; try { address = controlEndpointAddress(e); } catch (x) { rejected.push({ ...base, endpoint: String(e).slice(0, 80), reason: x.message }); continue; }
      if (seen.has(address)) continue;
      seen.add(address); candidates.push({ address, ...base, expiresAt: Number(a.expiresAt) * 1000 });
    }
  }
  return { candidates, rejected, blockNumber: r.blockNumber, complete: BigInt(v.ads.length) >= BigInt(v.total) };
}

/**
 * Step 1: the evidence document over a NATIVE connection to dial(address) with SNI `name`, the leaf verified under caPem only.
 * -> { spkiSha256, validTo (ms), statement (parsed), statementText }
 */
export function nativeEvidence({ dial, name, caPem, timeoutMs = 8000, maxBytes = 256 * 1024 }) {
  return new Promise((resolve, reject) => {
    let leaf = null;
    const req = https.request({ host: dial.host, port: dial.port, servername: name, ca: caPem, rejectUnauthorized: true, agent: false, timeout: timeoutMs, minVersion: 'TLSv1.2',
      checkServerIdentity: (_h, cert) => tls.checkServerIdentity(name, cert), method: 'GET', path: `${EVIDENCE_PATH}?nonce=${randomBytes(32).toString('hex')}`,
      headers: { host: name, accept: 'application/json' } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) req.destroy(new Error('evidence too large')); else chunks.push(c); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`evidence HTTP ${res.statusCode}`);
          const ev = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (ev?.format !== EVIDENCE_FORMAT) throw new Error('not a control evidence document');
          resolve({ ...leaf, statement: parseStatement(ev.statement), statementText: ev.statement });
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('socket', (s) => s.once('secureConnect', () => {
      try { const c = new X509Certificate(s.getPeerCertificate().raw); leaf = { spkiSha256: sha256Hex(c.publicKey.export({ type: 'spki', format: 'der' })), validTo: Date.parse(c.validTo) }; }
      catch (e) { req.destroy(new Error(`no peer certificate: ${e.message}`)); }
    }));
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', (e) => reject(new Error(String(e.message).slice(0, 200))));
    req.end();
  });
}

/**
 * Steps 1-3 for one address. -> { address, names: [served], registryId, operator, bootId, expiresAt, refused: [{ name, reason }] }
 * Throws when the address serves no name. decideHost(registryId) -> the platform host policy decision (fresh).
 */
export async function verifyNativeControlEndpoint({ address, names = NATIVE_NAMES, caPem, expect, collateral, registry, decideHost, dial = (a) => ({ host: a, port: 443 }),
  timeoutMs = 8000, routeTtlMs = 60_000, now = Date.now, verify = verifyMeasuredControl }) {
  if (typeof decideHost !== 'function') throw new Error('a platform host policy decision is required');
  const caSha256 = sha256Hex(new X509Certificate(caPem).raw), d = dial(address), refused = [], ok = [];
  for (const name of names) {
    try {
      const n = await nativeEvidence({ dial: d, name, caPem, timeoutMs });
      if (!n.statement.native || !n.statement.native.names.includes(name) || n.statement.native.caSha256 !== caSha256) throw new Error(`the attested boot is not bound to serve ${name} under this native CA`);
      if (n.spkiSha256 !== n.statement.keys.controlTls.spkiSha256) throw new Error('the native certificate is not over the attested control key');
      ok.push({ name, ...n });
    } catch (e) { refused.push({ name, reason: String(e.message).slice(0, 200) }); }
  }
  if (!ok.length) throw new Error(`no native name: ${refused.map((r) => `${r.name}: ${r.reason}`).join('; ')}`);
  const st = ok[0].statement;
  if (ok.some((n) => n.spkiSha256 !== ok[0].spkiSha256 || n.statement.bootId !== st.bootId)) throw new Error('the native names are served by different keys or boots');
  const v = await verify({ url: `https://${d.host}:${d.port}`, collateral, registry, timeoutMs,
    expect: { ...expect, configDigest: st.configDigest } });
  if (v.status !== 'verified') throw new Error(`attestation ${v.status}: ${v.reasons.filter((r) => /^(REJECT|UNKNOWN|PENDING)|report:/.test(r)).slice(-2).join('; ').slice(0, 300)}`);
  if (v.identity.controlTlsSpkiSha256 !== ok[0].spkiSha256 || v.identity.bootId !== st.bootId) throw new Error('the attested boot is not the one that answered the native connection');
  let dec;
  try { dec = await decideHost(v.identity.registryId); } catch (e) { throw new Error(`platform host policy unreadable: ${String(e.message).slice(0, 160)}`); }
  if (!dec || dec.admit !== true) throw new Error(`refused by the platform host policy: ${dec?.reason || dec?.status || 'no decision'}`);
  if (!dec.host || lc(dec.host.operator) !== v.identity.operator || dec.host.active === false) throw new Error('the policy decision names another registry row than the attested host');
  const expiresAt = Math.min(now() + routeTtlMs, ...ok.map((n) => n.validTo));
  return { address, names: ok.map((n) => n.name), registryId: v.identity.registryId, operator: v.identity.operator, bootId: st.bootId, expiresAt, refused };
}

/**
 * The platform host policy decision for the ATTESTED host, as native routes use it. The policy's chipId kind is a 32-byte
 * value; no source derives it from the verified 64-byte SNP CHIP_ID and no enforcement point supplies one, so a chipId deny
 * entry cannot be evaluated for this host. Rather than serve a host an administrator may have banned by chip, every native
 * route is refused while the accepted policy carries a chipId denial. -> { admit, status, reason, host }
 */
export function nativeHostDecision(decision, acceptedPolicy = null) {
  if (!decision || decision.admit !== true) return decision || { admit: false, reason: 'no decision' };
  if (acceptedPolicy && Array.isArray(acceptedPolicy.deny) && acceptedPolicy.deny.some((e) => e && e.kind === 'chipId'))
    return { ...decision, admit: false, status: 'chip-unverifiable', reason: `platform policy #${acceptedPolicy.sequence} denies by chipId, which native control routes cannot match to a verified chip: refused` };
  return decision;
}

const bounded = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t)); };
/**
 * One discovery round -> { routes: { [name]: { addresses, expiresAt } }, verified, excluded, rejected, blockNumber }.
 * readCandidates() -> readControlCandidates' result; verifyEndpoint(address) -> verifyNativeControlEndpoint's result.
 */
export async function discoverControlRoutes({ readCandidates, verifyEndpoint, excludeAddresses = [], names = NATIVE_NAMES, maxProbes = 16, endpointDeadlineMs = 45_000,
  routeTtlMs = 60_000, now = Date.now }) {
  const read = await readCandidates(), excluded = [], rejected = [...(read.rejected || [])], probes = [];
  const exclude = new Set(excludeAddresses);
  for (const c of read.candidates) {
    if (exclude.has(c.address)) { excluded.push({ address: c.address, operator: c.operator, reason: 'in the excluded failure domain' }); continue; }
    if (probes.length >= maxProbes) { rejected.push({ address: c.address, operator: c.operator, reason: `probe budget (${maxProbes}) exhausted` }); continue; }
    probes.push(c);
  }
  const results = await Promise.all(probes.map((c) => bounded(verifyEndpoint(c.address), endpointDeadlineMs, `verifying ${c.address}`).then((r) => ({ c, r }), (e) => ({ c, e }))));
  const at = now(), routes = {}, verified = [];
  for (const { c, r, e } of results) {
    if (e) { rejected.push({ address: c.address, operator: c.operator, reason: String(e.message).slice(0, 300) }); continue; }
    verified.push({ ...r, advertisedBy: c.operator });
    for (const x of r.refused || []) rejected.push({ address: c.address, name: x.name, reason: x.reason });
  }
  for (const name of names) {
    const ok = verified.filter((v) => v.names.includes(name) && Math.min(v.expiresAt, read.candidates.find((c) => c.address === v.address).expiresAt) > at);
    if (ok.length) routes[name] = { addresses: ok.map((v) => v.address),
      expiresAt: Math.min(at + routeTtlMs, ...ok.map((v) => Math.min(v.expiresAt, read.candidates.find((c) => c.address === v.address).expiresAt))) };
  }
  return { routes, verified, excluded, rejected, blockNumber: read.blockNumber ?? null };
}

/**
 * A single-flight cache of the route map: reused until its earliest route expires (at most routeTtlMs), refreshed in the
 * background after half of that; a failed round is remembered for retryMs. No admission outlives a route's own expiry.
 */
export function cachedControlRoutes(discover, { retryMs = 10_000, log = () => {}, now = Date.now } = {}) {
  let last = null, failed = null, inflight = null;
  const refresh = () => {
    if (!inflight) inflight = Promise.resolve().then(discover).then((r) => {
      const at = now(), exp = Object.values(r.routes).map((x) => x.expiresAt);
      last = { at, until: exp.length ? Math.min(...exp) : at + retryMs, map: { routes: r.routes } }; failed = null;
      log(`[native-discovery] control routes: ${Object.entries(r.routes).map(([n, x]) => `${n}=${x.addresses.join('|')}`).join(' ') || 'none'} (${r.verified.length} verified, ${r.excluded.length} excluded, ${r.rejected.length} rejected)`);
      return last.map;
    }, (e) => { failed = { at: now(), error: e }; log(`[native-discovery] control route discovery failed: ${String(e?.message || e).slice(0, 300)}`); throw e; })
      .finally(() => { inflight = null; });
    return inflight;
  };
  return async () => {
    const t = now();
    if (last && last.until > t) { if (t - last.at > (last.until - last.at) / 2) refresh().catch(() => {}); return last.map; }
    if (failed && t - failed.at < retryMs && !inflight) throw failed.error;
    return refresh();
  };
}

const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
/**
 * The deployed discovery's control-route source from its environment -> getControlRoutes(). Everything is explicit:
 *   NATIVE_CONTROL_SERVICE_INDEX  <index address>@<runtime code hash> (the pinned EnclaveServiceIndex, Base 8453)
 *   NATIVE_CONTROL_RPCS           2-8 Base RPC URLs of distinct providers (the index read, and the registry quorum)
 *   NATIVE_CONTROL_QUORUM         registry quorum (default: all of them)
 *   NATIVE_CONTROL_REGISTRY       the ORIGINAL EnclaveRegistry address
 *   NATIVE_CONTROL_MEASUREMENTS   the reviewed control-image launch digests (96 hex, comma-separated)
 *   NATIVE_CONTROL_EXCLUDE        REQUIRED: IPv4 addresses never probed or served (the DigitalOcean fleet)
 *   NATIVE_CONTROL_OPERATORS      optional operator addresses read directly
 *   ENCLAVE_PLATFORM_HOST_POLICY* the unchanged platform host policy resolution (production unless explicitly "off")
 */
export async function controlRoutesFromEnv(env, { caPem, log = () => {}, fetch = globalThis.fetch, now = Date.now,
  // test fixtures only (offline): the SYNTHETIC AMD collateral and its pinned ARK, and loopback ports for public addresses
  collateral: testCollateral = null, roots = null, dial = undefined } = {}) {
  const m = /^(0x[0-9a-fA-F]{40})@(0x[0-9a-fA-F]{64})$/.exec(String(env.NATIVE_CONTROL_SERVICE_INDEX || '').trim());
  if (!m) throw new Error('NATIVE_CONTROL_SERVICE_INDEX must be <index address>@<runtime code hash>');
  const indexPin = validateIndexPin({ chainId: 8453, address: m[1], codeHash: m[2].toLowerCase() });
  const rpcs = list(env.NATIVE_CONTROL_RPCS);
  if (rpcs.length < 2 || rpcs.length > 8) throw new Error('NATIVE_CONTROL_RPCS: 2 to 8 Base RPC URLs of distinct providers');
  const quorum = env.NATIVE_CONTROL_QUORUM ? Number(env.NATIVE_CONTROL_QUORUM) : rpcs.length;
  if (!Number.isInteger(quorum) || quorum < 2 || quorum > rpcs.length) throw new Error('NATIVE_CONTROL_QUORUM: 2 to the number of RPCs');
  if (!ADDR.test(String(env.NATIVE_CONTROL_REGISTRY || '')) || /^0x0{40}$/i.test(env.NATIVE_CONTROL_REGISTRY)) throw new Error('NATIVE_CONTROL_REGISTRY: the original EnclaveRegistry address');
  const measurements = list(env.NATIVE_CONTROL_MEASUREMENTS).map(lc);
  if (!measurements.length || measurements.some((x) => !/^[0-9a-f]{96}$/.test(x))) throw new Error('NATIVE_CONTROL_MEASUREMENTS: the reviewed control-image launch digests (96 hex)');
  const exclude = list(env.NATIVE_CONTROL_EXCLUDE);
  if (!exclude.length || exclude.some((x) => !/^(\d{1,3}\.){3}\d{1,3}$/.test(x))) throw new Error('NATIVE_CONTROL_EXCLUDE is required: the IPv4 failure domain (the DigitalOcean fleet) never probed or served');
  const operators = list(env.NATIVE_CONTROL_OPERATORS);
  const { rpcPeers } = await import('./policy-carriers.mjs');
  const { createHostPolicyRuntime, resolveHostPolicyConfig } = await import('./host-policy-runtime.mjs');
  const { PRODUCTION_BOOK } = await import('./platform-host-policy-config.mjs');
  const { freshAdmissions } = await import('./host-policy-adapters.mjs');
  const { quorumRegistry } = await import('../metal/guest/platform-api-verify.mjs');
  const { httpCollateral } = await import('../verifier/collateral.mjs');
  const { TCB_FLOORS } = await import('../verifier/metal-box.mjs');
  const peers = rpcPeers(rpcs);
  const runtime = createHostPolicyRuntime(resolveHostPolicyConfig({ env, chainId: 8453, book: PRODUCTION_BOOK }), { fetch, log });
  // explicit "off" serves NOTHING here: an endpoint routed for the platform's own control names is always judged
  if (!runtime) throw new Error('native control routes need the platform host policy: it is explicitly off');
  const decide = freshAdmissions(runtime.gate);
  const decideHost = async (id) => nativeHostDecision((await decide([id]))[lc(id)], runtime.gate.accepted()?.policy || null);
  const registry = quorumRegistry({ rpcs, quorum, registry: env.NATIVE_CONTROL_REGISTRY.toLowerCase() });
  const collateral = testCollateral || httpCollateral({ fetchImpl: fetch });
  const expect = { measurements, minTcb: TCB_FLOORS, crl: 'required', ...(roots ? { roots } : {}) };
  return cachedControlRoutes(() => discoverControlRoutes({ now, excludeAddresses: exclude,
    readCandidates: () => readControlCandidates({ peers, indexPin, operators, now }),
    verifyEndpoint: (address) => verifyNativeControlEndpoint({ address, caPem, expect, collateral, registry, now, decideHost, ...(dial ? { dial } : {}) }) }), { log, now });
}
