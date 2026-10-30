// Operator tool for staging Enclave host-service roles on an existing Enclave host (work/hosted-services-activation).
// Everything here reads PUBLIC data or this host's own staged files; nothing signs, sends a transaction, publishes an
// advertisement or reads a key. The authority code is the unchanged platform host policy gate and carriers.
//
//   node stage-tool.mjs capture-public --endpoint <registry endpoint> [--rpc <url> ...]
//        one agreed block of the policy's RPC quorum: book owner, policy anchor state, book registry, the host's registry
//        entry (operator, active), its accepted owner on hostOwnership, and the pinned service index's code hash
//   node stage-tool.mjs policy-import --import-dir <dir> [--carrier <base URL> ...] [--dry-run]    (both: [--rpc <url> ...] [--book 0x.. --host-ownership 0x..], default production)
//        the CURRENTLY ANCHORED admin-signed policy document, verified at a fresh agreed block (digest = anchor, signed by
//        the book's current owner), written to <dir>/<digest>.json. Unanchored book: nothing is written and the result
//        says so explicitly (the unchanged gate treats an unanchored book as "not activated" under production
//        activation "anchor"). Torn anchor or unavailable document: exit 3, nothing written.
//   node stage-tool.mjs fill-artifacts --manifest <verified manifest> --dir <artifact dir> [--from-dir <dir> ...] [--from-origin <url> ...] [--max-object-bytes N]
//        copies every manifest object (<cid>.bin and <cid>.car) OPAQUELY, keeping a file only after its sha256 matches
//   node stage-tool.mjs gen-config --spec <spec.json> --listeners <ss capture: text, or JSON {listeners:[...]}> --out <file>
//        the exact host-services.json from a public spec; refuses a port that the capture shows in use
//   node stage-tool.mjs health --config <host-services.json> [--artifacts sample|all] [--json]
//   node stage-tool.mjs capture-app-static --zone app.enclave.host --label <label> ... --server <authoritative IPv4> ...
//        PUBLIC-ONLY: each label's A record from every authoritative server (no recursion, AA required); kept only when all
//        agree on one public address and the label passes the route-dns role's validation; disagreements are reported
//   node stage-tool.mjs host-services --endpoint <registry endpoint> --zone <app zone> --exit <providerId>=<IPv4> ... [--dns] [--tls-http P --tls R=P ...]
//        THIS host's public service names (network/host-service-names.mjs, from the endpoint's registry id) and, from ONE
//        list of WireGuard exits: the route-dns appStatic labels (each name -> every exit's address), the privacy agent's
//        enclaveNetwork.hostServices block (the same exits) and the http(s) endpoints to advertise later. Nothing is
//        changed anywhere: gen-config takes it as spec.hostServices (its appStatic), the agent block is the operator's.
//        stage-1 health: a FRESH decision of the unchanged gate for this host (admission/ban/anchor), each role's own
//        health, served artifacts against the manifest, real DNS answers, and the policy mirror's anchored document
// Exit: 0 ok, 1 usage/config error, 2 unhealthy, 3 refused (torn anchor, unverifiable document, port in use, digest mismatch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { keccak256 } from 'viem';
import { registryIdOfEndpoint } from '../host-service-gate.mjs';
import { PRODUCTION_BOOK, PRODUCTION_HOST_OWNERSHIP, PRODUCTION_MIRRORS, PRODUCTION_RPCS, PRODUCTION_HOST_POLICY } from '../platform-host-policy-config.mjs';
import { quorumSnapshot } from '../host-policy-runtime.mjs';
import { readPolicyFacts, decodeAnchor } from '../platform-host-policy.mjs';
import { httpCarriers, freshVerifier, candidateDigest } from '../policy-carriers.mjs';
import { hostIdOfEndpoint, createHostServiceGate } from '../host-service-gate.mjs';
import { planHostServices, policyEnv, policyCarrierFetch } from './runner.mjs';
import { hostServiceNames, hostRpcName, HOST_RPC_ROLE, validServiceZone } from '../host-service-names.mjs';
import { validateHostServicesTransport, tlsReady } from '../host-service-transport.mjs';
import { keccak256 as keccakBytes, toBytes } from 'viem';
import { ROLES } from './roles.mjs';

const fail = (code, m) => Object.assign(new Error(m), { exit: code });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const writeAtomic = (file, data, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.tmp-${process.pid}`; fs.writeFileSync(t, data, { mode }); fs.renameSync(t, file); };
function args(argv, multi = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2), boolean = ['dry-run', 'json', 'dns', 'probe-tls'].includes(k);
    const v = boolean ? true : argv[++i];
    if (!boolean && v === undefined) throw fail(1, `--${k} needs a value`);
    if (multi.includes(k)) (o[k] ||= []).push(v); else o[k] = v;
  }
  return o;
}
const snapOf = (rpcs) => quorumSnapshot({ rpcs: rpcs?.length ? rpcs : [...PRODUCTION_RPCS], minAgree: rpcs?.length ? null : PRODUCTION_HOST_POLICY.minAgree });
const anchorOf = (facts) => { try { return decodeAnchor(facts.anchorHi, facts.anchorLo); } catch (e) { return { state: 'torn', reason: e.message }; } };

// ---------------------------------------------------------------- capture-public
export async function capturePublic({ endpoint, rpcs = null, book = PRODUCTION_BOOK, hostOwnership = PRODUCTION_HOST_OWNERSHIP, indexPin = null, snapshot = null }) {
  // the registry id of the endpoint EXACTLY as given (as registered); a trailing slash is kept, never normalized away
  const hostId = registryIdOfEndpoint(endpoint);
  const facts = await (snapshot || snapOf(rpcs))(async (at) => ({ ...(await readPolicyFacts(at, { book, hostOwnership, registryIds: [hostId] })), block: at.block ?? null,
    indexCode: indexPin ? await at.code(indexPin.address) : null }));
  const host = facts.hosts[hostId];
  return { at: new Date().toISOString(), readOnly: true, block: String(facts.block), book, hostOwnership, bookOwner: facts.owner, bookOwnerIsContract: facts.ownerIsContract,
    anchor: anchorOf(facts), registry: facts.registry, endpoint: String(endpoint), hostId,
    registryEntry: host ? { endpoint: host.endpoint, operator: host.operator, active: host.active } : null, acceptedOwner: host?.owner ?? null,
    ...(indexPin ? { serviceIndex: { ...indexPin, agreedCodeHash: facts.indexCode && facts.indexCode !== '0x' ? keccak256(facts.indexCode) : null,
      matchesPin: !!facts.indexCode && facts.indexCode !== '0x' && keccak256(facts.indexCode) === indexPin.codeHash.toLowerCase() } } : {}),
    rpcs: rpcs?.length ? rpcs : [...PRODUCTION_RPCS] };
}

// ---------------------------------------------------------------- policy-import
export async function policyImport({ importDir, carriers = [...PRODUCTION_MIRRORS], rpcs = null, book = PRODUCTION_BOOK, hostOwnership = PRODUCTION_HOST_OWNERSHIP, dryRun = false, fetch = globalThis.fetch }) {
  const verify = freshVerifier({ snapshot: snapOf(rpcs), book, hostOwnership });
  const first = await verify([]);
  if (first.anchor.state === 'unanchored') {
    if (!dryRun) fs.mkdirSync(importDir, { recursive: true, mode: 0o755 });
    return { state: 'unanchored', block: first.block, wrote: null,
      meaning: 'the address book anchors no platform host policy: under production activation "anchor" the unchanged gate admits this host as "not-activated" (reported as such); once the admin anchors a policy, run policy-import again (or let a carrier deliver it) or the host stops taking new work and stops serving after the gate\'s grace' };
  }
  if (first.anchor.state !== 'anchored') throw fail(3, `refused: the book's anchor is ${first.anchor.state}${first.anchor.reason ? ` (${first.anchor.reason})` : ''}; the gate refuses every host until the admin repairs it`);
  const digest = first.anchor.digest, file = path.join(importDir, `${digest}.json`);
  const tried = [];
  for (const carrier of httpCarriers(carriers, { fetch })) {
    const cands = (await carrier(digest)).filter((c) => candidateDigest(c) === digest);
    tried.push(cands.length);
    if (!cands.length) continue;
    const v = (await verify(cands)).verified.find((x) => x.digest === digest);
    if (!v) continue;
    if (!dryRun) writeAtomic(file, JSON.stringify({ document: v.document, signature: v.signature, sequence: v.sequence }));
    return { state: 'anchored', block: first.block, digest, sequence: v.sequence, wrote: dryRun ? null : file };
  }
  throw fail(3, `refused: no carrier (${carriers.length}) served the anchored document ${digest} signed by the book's current owner (candidates per carrier: ${tried.join(',')}); nothing written`);
}

// ---------------------------------------------------------------- fill-artifacts
async function fileSha(file) { const h = createHash('sha256'); for await (const c of fs.createReadStream(file)) h.update(c); return h.digest('hex'); }
async function keepVerified(src, dest, want) {
  if (await fileSha(src) !== want) return false;
  const t = `${dest}.tmp-${process.pid}`; fs.copyFileSync(src, t); fs.chmodSync(t, 0o644);
  if (await fileSha(t) !== want) { fs.rmSync(t, { force: true }); return false; }
  fs.renameSync(t, dest); return true;
}
async function fetchVerified(url, dest, want, max, fetch) {
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
  if (!r.ok || !r.body) return false;
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > max + 1024 * 1024) return false;
  const t = `${dest}.tmp-${process.pid}`, out = fs.createWriteStream(t, { mode: 0o644 }), h = createHash('sha256');
  let n = 0;
  try { for await (const c of r.body) { n += c.length; if (n > max + 1024 * 1024) throw Error('too large'); h.update(c); if (!out.write(c)) await new Promise((ok) => out.once('drain', ok)); } }
  catch { out.destroy(); fs.rmSync(t, { force: true }); return false; }
  await new Promise((ok) => out.end(ok));
  if (h.digest('hex') !== want) { fs.rmSync(t, { force: true }); return false; }
  fs.renameSync(t, dest); return true;
}
export async function fillArtifacts({ manifest, dir, fromDirs = [], fromOrigins = [], maxObjectBytes = 1 << 30, fetch = globalThis.fetch, log = () => {} }) {
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!Array.isArray(m.verifiedObjects) || !m.verifiedObjects.length || m.verifiedObjects.length > 4096) throw fail(1, 'manifest: verifiedObjects (1..4096) required');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const out = { manifest, manifestSha256: sha(fs.readFileSync(manifest)), objects: m.verifiedObjects.length, kept: 0, copied: 0, fetched: 0, missing: [] };
  for (const e of m.verifiedObjects) {
    if (!/^[a-z0-9]{20,120}$/.test(String(e.cid)) || !/^[0-9a-f]{64}$/.test(String(e.sha256)) || !/^[0-9a-f]{64}$/.test(String(e.carSha256))) throw fail(3, `manifest entry is malformed: ${String(e.cid).slice(0, 80)}`);
    if (e.bytes > maxObjectBytes) throw fail(3, `${e.cid}: ${e.bytes} bytes exceeds maxObjectBytes ${maxObjectBytes}`);
    for (const [ext, want, query] of [['bin', e.sha256, ''], ['car', e.carSha256, '?format=car']]) {
      const dest = path.join(dir, `${e.cid}.${ext}`);
      if (fs.existsSync(dest) && await fileSha(dest) === want) { out.kept++; continue; }
      let ok = false;
      for (const d of fromDirs) { const src = path.join(d, `${e.cid}.${ext}`); if (fs.existsSync(src) && await keepVerified(src, dest, want)) { ok = true; out.copied++; break; } }
      for (const o of ok ? [] : fromOrigins) { if (await fetchVerified(`${String(o).replace(/\/+$/, '')}/ipfs/${e.cid}${query}`, dest, want, maxObjectBytes, fetch).catch(() => false)) { ok = true; out.fetched++; break; } }
      if (!ok) out.missing.push(`${e.cid}.${ext}`);
      log(`${ok ? 'ok' : 'MISSING'} ${e.cid}.${ext}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- gen-config
/** listeners: `ss -Hltnu`-style lines (proto state recvq sendq local peer) -> [{ proto, address, port }] */
export function parseListeners(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !['tcp', 'udp'].includes(cols[0])) continue;
    const m = /^(.*):(\d+|\*)$/.exec(cols[4]);
    if (m && m[2] !== '*') rows.push({ proto: cols[0], address: m[1].replace(/%.*$/, '').replace(/^\[|\]$/g, ''), port: Number(m[2]) });
  }
  return rows;
}
const conflicts = (rows, proto, bind, port) => rows.filter((r) => r.proto === proto && r.port === port &&
  ['0.0.0.0', '*', '::', bind].includes(r.address));
/**
 * A host's public service names and how they resolve, all from ONE exit list (work/host-service-transport-20261021):
 *   - names: hostServiceNames(registry id of `endpoint`, zone) - only this host's, nobody chooses them - plus its public
 *     RPC origin rpc-<b32>.<zone> when `ports` names the public-rpc role (its exits must have opted in: hostServices.rpc);
 *   - appStatic: { '<label>': [every exit's IPv4] } for the hosted route-dns (the zone must be the app zone it serves): a
 *     client gets every provider that carries this host's grant, and tries the next when one is down;
 *   - agent: enclaveNetwork.hostServices for the privacy agent - a service circuit to EXACTLY those exits;
 *   - endpoints: what `runner.mjs advertise` may publish: http://, and https:// ONLY for a role in `ready` (a VERIFIED G3
 *     handshake, tlsReady / --probe-tls) - a configured TLS port alone never advertises https.
 * hostId: the registry id (the runner) = keccak256 of the endpoint bytes EXACTLY as registered (EnclaveRegistry idOf;
 * windows/node chain.mjs enclaveIdOf). Never normalized: a registered endpoint with a trailing slash is valid and keeps
 * its own id. A given hostId that is not that hash is refused. G1 and G3 must name the same host by this one id.
 * ports default to the hs2 stage-1 ports; dns (route-dns 53) is included only with `dns: true`.
 */
export function hostServicePublication({ endpoint, zone, exits, hostId: givenId = null, ports = { 'directory-replica': 18188, 'bootstrap-replica': 18189, 'policy-mirror': 18190 },
  dns = null, tls = null, ready = {} }) {
  validServiceZone(zone);
  if (!/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(String(endpoint || ''))) throw fail(1, 'host services: the host\'s registry endpoint (https) is required');
  if (!Array.isArray(exits) || !exits.length || exits.length > 8) throw fail(1, 'host services: 1 to 8 exits {providerId, address}');
  const addresses = exits.map((x) => x?.address), ids = exits.map((x) => x?.providerId);
  if (new Set(addresses).size !== addresses.length || new Set(ids).size !== ids.length) throw fail(1, 'host services: each exit once (distinct ids and addresses)');
  const hostId = keccakBytes(toBytes(String(endpoint))).toLowerCase();
  if (givenId !== null && String(givenId).toLowerCase() !== hostId) throw fail(1, 'host services: hostId is not keccak256 of this endpoint (the registry id)');
  const names = { ...hostServiceNames(hostId, zone), ...(ports[HOST_RPC_ROLE] ? { [HOST_RPC_ROLE]: hostRpcName(hostId, zone) } : {}) };
  const agent = validateHostServicesTransport({ zone, exits: ids, ports, ...(tls ? { tls } : {}), ...(dns ? { dns } : {}) });
  const appStatic = Object.fromEntries(Object.keys(ports).map((role) => [names[role].slice(0, -(zone.length + 1)), [...addresses]]));
  // the route-dns role's own validation (public IPv4s, non-deployment labels): the same check its config will get
  ROLES['route-dns'].validate({ dnsPort: 53, bind: '127.0.0.1', apiPort: 8154, zone, ipZone: 'ip.' + zone.split('.').slice(1).join('.'), nsName: 'ns-check.' + zone,
    nsNames: ['ns-check.' + zone], routeMapUrl: 'http://127.0.0.1:1/v1/network/routes', appStatic });
  const endpoints = Object.fromEntries(Object.keys(ports).map((role) => [role, [`${agent.tls?.tlsPorts[role] && ready[role] === true ? 'https' : 'http'}://${names[role]}/`]]));
  return { hostId, zone, names, appStatic, agent: { hostServices: { zone, exits: ids, ports, ...(tls ? { tls } : {}), ...(dns ? { dns } : {}) } }, endpoints };
}

export function genConfig(spec, listenersText) {
  const rows = parseListeners(listenersText);
  if (!rows.length) throw fail(1, 'the listener capture has no tcp/udp listeners: capture `ss -Hltnu` on the host first');
  const p = spec.ports, b = spec.bind;
  const need = [['tcp', p.directory], ['tcp', p.bootstrap], ['udp', p.dns], ['tcp', p.dns], ['tcp', p.dnsApi], ['tcp', p.policy]];
  if (new Set([p.directory, p.bootstrap, p.dns, p.dnsApi, p.policy]).size !== 5) throw fail(3, 'ports must be distinct');
  for (const [proto, port] of need) { const c = conflicts(rows, proto, b, port); if (c.length) throw fail(3, `refused: ${proto} port ${port} is in use in the capture (${c.map((r) => r.address).join(', ')})`); }
  // S: the service's WRITABLE state (systemd StateDirectory); D: root-filled PUBLIC data the service only reads
  const S = spec.stateRoot, D = spec.dataRoot, rpcFleet = spec.directoryRpc, polRpc = [...PRODUCTION_RPCS];
  const J = spec.platform === 'win32' ? path.win32.join : path.posix.join;      // the TARGET host's paths, not this one's
  return {
    format: 'enclave-host-services/v1',
    host: { endpoint: spec.endpoint, publicEndpoints: {} },        // stage 1: NOT advertised (no publicEndpoints)
    platformHostPolicy: 'production',
    platformHostPolicyCarriers: { importDir: J(D, 'policy-import'), serviceIndex: true },
    serviceIndex: spec.serviceIndex,
    packagesDir: spec.packagesDir, stateRoot: S,
    services: [
      { role: 'directory-replica', package: spec.pins['directory-replica'], heapMiB: 192,
        config: { port: p.directory, bind: b, stateDir: J(S, 'directory-replica-state'), rpc: rpcFleet, addressBook: PRODUCTION_BOOK,
          authorityPins: spec.authorityPins, checkers: spec.checkers, peers: spec.directoryPeers } },
      { role: 'bootstrap-replica', package: spec.pins['bootstrap-replica'], heapMiB: 128,
        config: { port: p.bootstrap, bind: b, directory: J(D, 'artifacts'), manifest: J(D, 'bootstrap-manifest.json'), maxObjectBytes: 1 << 30 } },
      { role: 'route-dns', package: spec.pins['route-dns'], heapMiB: 160,
        config: { dnsPort: p.dns, bind: b, apiPort: p.dnsApi, apiBind: '127.0.0.1', zone: spec.dns.zone, ipZone: spec.dns.ipZone, nsName: spec.dns.nsName,
          nsNames: spec.dns.nsNames, routeMapUrl: `http://127.0.0.1:${p.directory}/v1/network/routes`,
          // only mappings captured from public authoritative answers (capture-app-static.sh), never inferred; plus THIS
          // host's own service labels from spec.hostServices (hostServicePublication: its exits' addresses)
          ...(() => { const own = spec.hostServices ? hostServicePublication({ endpoint: spec.endpoint, zone: spec.dns.zone, ...spec.hostServices }).appStatic : {};
            for (const l of Object.keys(own)) if (spec.dns.appStatic?.[l] !== undefined) throw fail(3, `refused: appStatic label ${l} is both captured and this host's service name`);
            const all = { ...(spec.dns.appStatic || {}), ...own };
            return Object.keys(all).length ? { appStatic: all } : {}; })(),
          // this host answers DNS for the exits (spec.hostServices.dns): every relayed query arrives from loopback, so give the
          // transport ONE bounded aggregate >= what the exits may forward in total (each provider's global DNS rate, default
          // 2000/s, times the exits; burst twice that). Each provider still limits every real source.
          ...(spec.hostServices?.dns ? (() => { const rate = (spec.hostServices.dnsGlobalPps ?? 2000) * spec.hostServices.exits.length;
            return { transportRateLimitPerSec: rate, transportRateLimitCap: 2 * rate }; })() : {}) } },
      { role: 'policy-mirror', package: spec.pins['policy-mirror'], heapMiB: 128,
        config: { port: p.policy, bind: b, stateDir: J(S, 'policy-mirror-state'), rpc: polRpc, minAgree: PRODUCTION_HOST_POLICY.minAgree,
          book: PRODUCTION_BOOK, hostOwnership: PRODUCTION_HOST_OWNERSHIP, peers: [...PRODUCTION_MIRRORS], importDir: J(D, 'policy-import'), syncSec: 60 } },
    ],
  };
}

// ---------------------------------------------------------------- health
function dnsQuery(port, address, name, qtype, { recursion = false, timeoutMs = 3000 } = {}) {
  const id = Math.floor(Math.random() * 65535);
  const q = Buffer.concat([Buffer.from([id >> 8, id & 255, recursion ? 1 : 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, qtype, 0, 1])]);
  return new Promise((ok) => {
    const s = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
    const t = setTimeout(() => { s.close(); ok(null); }, timeoutMs);
    s.on('error', () => { clearTimeout(t); s.close(); ok(null); });
    s.on('message', (m) => { if (m.readUInt16BE(0) !== id) return; clearTimeout(t); s.close();
      const answers = m.readUInt16BE(6);
      // every A record in the answer section (the question is echoed: skip it; then name, type, class, ttl, rdlength, rdata)
      const addresses = [];
      try {
        let o = 12; while (m[o]) o += m[o] + 1; o += 5;
        for (let i = 0; i < answers; i++) {
          if ((m[o] & 0xc0) === 0xc0) o += 2; else { while (m[o]) o += m[o] + 1; o++; }
          const type = m.readUInt16BE(o), len = m.readUInt16BE(o + 8);
          if (type === 1 && len === 4) addresses.push([...m.subarray(o + 10, o + 14)].join('.'));
          o += 10 + len;
        }
      } catch {}
      ok({ rcode: m[3] & 0x0f, authoritative: !!(m[2] & 0x04), answers, address: addresses[0] ?? null, addresses }); });
    s.send(q, port, address);
  });
}
const local = (bind) => (bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind);
async function getJson(url) { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; }
export async function health({ config, artifacts = 'sample', fetch: f = globalThis.fetch, rpcs = null, policyRuntime = null }) {
  const raw = JSON.parse(fs.readFileSync(config, 'utf8'));
  const { cfg, services } = planHostServices(raw);            // pins and configuration exactly as the runner checks them
  const checks = [], add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return ok; };
  const role = (r) => services.find((s) => s.role === r)?.config;
  let book = { state: 'unread', digest: null };     // the book's anchor as the gate just read it (the mirror must match it)
  // the gate: a FRESH decision by the unchanged gate (its own empty state; the same configuration and carriers as the runner)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostsvc-health-'));
  try {
    const env = { ...policyEnv(cfg), ...(rpcs ? { ENCLAVE_PLATFORM_HOST_POLICY_RPCS: rpcs.join(',') } : {}) };
    // the same host id as the runner's gate: the registry id of the endpoint exactly as registered (policyRuntime: tests only)
    const gate = createHostServiceGate({ env, chainId: 8453, hostId: registryIdOfEndpoint(cfg.host.endpoint), stateDir: tmp, log: () => {},
      ...(policyRuntime ? { runtime: policyRuntime } : { fetch: await policyCarrierFetch(cfg, { fetch: f }) }) });
    const s = await gate.check();
    const st = gate.status();
    add('gate: platform host policy admits this host now', s.serving === true, { hostId: st.hostId, status: s.status, reason: s.reason, banned: !!s.banned, anchor: st.runtime?.anchor, accepted: st.runtime?.accepted, activation: st.runtime?.activation });
    // anchored: the gate holds that policy only once it verified the exact anchored digest at the same block
    book = { state: st.runtime?.anchor || 'unread', digest: st.runtime?.anchor === 'anchored' ? st.runtime?.accepted?.digest ?? null : null };
  } catch (e) { add('gate: platform host policy admits this host now', false, { error: e.message }); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const d = role('directory-replica');
  if (d) { const r = await getJson(`http://${local(d.bind)}:${d.port}/health`).catch((e) => ({ error: e.message })); add('directory-replica /health', r.status === 200 && r.body?.ok === true, r); }
  const b = role('bootstrap-replica');
  if (b) {
    const m = JSON.parse(fs.readFileSync(b.manifest, 'utf8')).verifiedObjects;
    const pick = artifacts === 'all' ? m : [...m].sort((x, y) => x.bytes - y.bytes).slice(0, 1);
    let bad = [];
    for (const e of pick) {
      try {
        const r = await f(`http://${local(b.bind)}:${b.port}/ipfs/${e.cid}`, { signal: AbortSignal.timeout(120_000) });
        const bytes = Buffer.from(await r.arrayBuffer());
        if (r.status !== 200 || bytes.length !== e.bytes || sha(bytes) !== e.sha256) bad.push(e.cid);
      } catch { bad.push(e.cid); }
    }
    const heads = [];
    for (const e of artifacts === 'all' ? [] : m) { try { const r = await f(`http://${local(b.bind)}:${b.port}/ipfs/${e.cid}`, { method: 'HEAD', signal: AbortSignal.timeout(8000) }); if (r.status !== 200 || Number(r.headers.get('content-length')) !== e.bytes) heads.push(e.cid); } catch { heads.push(e.cid); } }
    add(`bootstrap-replica serves the manifest (${pick.length} verified by sha256, ${artifacts === 'all' ? 0 : m.length} by HEAD size)`, !bad.length && !heads.length, { objects: m.length, badContent: bad.slice(0, 10), badHead: heads.slice(0, 10) });
  }
  const dn = role('route-dns');
  if (dn) {
    const soa = await dnsQuery(dn.dnsPort, local(dn.bind), dn.zone, 6), ns = await dnsQuery(dn.dnsPort, local(dn.bind), dn.zone, 2);
    add(`route-dns answers SOA and NS for ${dn.zone} (authoritative, NOERROR)`, soa && soa.rcode === 0 && soa.authoritative && soa.answers >= 1 && ns && ns.rcode === 0 && ns.answers === dn.nsNames.length, { soa, ns });
    // every configured static platform label answers exactly its configured address
    const statics = Object.entries(dn.appStatic || {}), wrong = [];
    for (const [label, address] of statics) {
      const a = await dnsQuery(dn.dnsPort, local(dn.bind), `${label}.${dn.zone}`, 1), want = Array.isArray(address) ? address : [address];
      if (!a || a.rcode !== 0 || !a.authoritative || a.addresses.length !== want.length || [...a.addresses].sort().join() !== [...want].sort().join()) wrong.push({ label, want: address, got: a });
    }
    if (statics.length) add(`route-dns answers ${statics.length} static platform label(s) with their configured addresses`, !wrong.length, { wrong });
  }
  const pm = role('policy-mirror');
  if (pm) {
    const r = await getJson(`http://${local(pm.bind)}:${pm.port}/health`).catch((e) => ({ error: e.message }));
    // the mirror must agree with the BOOK (as the gate just read it), not merely with itself: a mirror still reporting an
    // older anchor (or none) after the admin anchored a policy is unhealthy until it has synced and serves that document
    let doc = null;
    if (book.digest) { const g = await getJson(`http://${local(pm.bind)}:${pm.port}/platform-policy/${book.digest}.json`).catch(() => null); doc = g?.status === 200 && candidateDigest(g.body) === book.digest; }
    const agrees = book.state === 'unanchored' ? r.body?.anchor === 'unanchored'
      : book.state === 'anchored' && !!book.digest && r.body?.anchor === book.digest && r.body?.anchoredAvailable === true && doc === true;
    add('policy-mirror /health (agrees with the book\'s anchor; serves the anchored document)', r.status === 200 && r.body?.ok === true && !r.body.error && agrees,
      { anchor: r.body?.anchor, anchoredAvailable: r.body?.anchoredAvailable, documents: r.body?.documents, lastSyncError: r.body?.error ?? null, servedAnchoredDocument: doc, book });
  }
  return { at: new Date().toISOString(), config, hostEndpoint: cfg.host.endpoint, ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------- capture-app-static
/**
 * PUBLIC-ONLY capture of APP_STATIC mappings: ask each AUTHORITATIVE server (recursion off; the answer must carry AA) for
 * each candidate label's A records. A label is kept only when EVERY server answers NOERROR + AA with exactly one and the
 * same address, and that mapping passes the route-dns role's own validation (a hyphenated non-deployment label, a public
 * IPv4). Anything else is reported, never resolved by choice. -> { zone, servers, labels: {label: ipv4}, refused: [...] }
 */
export async function captureAppStatic({ zone, labels, servers, port = 53, query = dnsQuery }) {
  const { ROLES } = await import('./roles.mjs');
  const validate = (m) => ROLES['route-dns'].validate({ dnsPort: 53, bind: '127.0.0.1', apiPort: 8154, zone, ipZone: 'ip.' + zone.split('.').slice(1).join('.'),
    nsName: 'ns-capture.' + zone, nsNames: ['ns-capture.' + zone], routeMapUrl: 'http://127.0.0.1:1/v1/network/routes', appStatic: m }).appStatic;
  const out = { at: new Date().toISOString(), zone, servers, labels: {}, answers: {}, refused: [] };
  for (const label of labels) {
    const per = {};
    for (const server of servers) per[server] = await query(port, server, `${label}.${zone}`, 1, { recursion: false });
    out.answers[label] = per;
    const sets = Object.values(per).map((a) => (a && a.rcode === 0 && a.authoritative ? [...a.addresses].sort().join(',') : null));
    if (sets.some((x) => x === null)) { out.refused.push({ label, reason: 'a server did not answer authoritatively (NOERROR + AA)' }); continue; }
    if (new Set(sets).size !== 1) { out.refused.push({ label, reason: `the servers disagree: ${[...new Set(sets)].join(' | ')}` }); continue; }
    const addrs = sets[0] ? sets[0].split(',') : [];
    if (addrs.length !== 1) { out.refused.push({ label, reason: `${addrs.length} A records (a static label answers exactly one)` }); continue; }
    try { validate({ [label]: addrs[0] }); out.labels[label] = addrs[0]; } catch (e) { out.refused.push({ label, reason: e.message }); }
  }
  return out;
}

// ---------------------------------------------------------------- CLI
// The staged bundle runs this through entries/stage-tool.mjs (behind argv-guard.mjs: the runner bundled with it has its own
// "am I main?" check, which must not fire inside the tool).
export function main(argv) {
  const [cmd, ...rest] = argv;
  const o = (() => { try { return args(rest, ['rpc', 'carrier', 'from-dir', 'from-origin', 'label', 'server', 'exit', 'tls']); } catch (e) { console.error(e.message); process.exit(1); } })();
  const print = (v) => console.log(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
  (async () => {
    if (cmd === 'capture-public') {
      if (!o.endpoint) throw fail(1, 'capture-public needs --endpoint');
      const pin = o['index-pin'] ? JSON.parse(fs.readFileSync(o['index-pin'], 'utf8')) : null;
      print(await capturePublic({ endpoint: o.endpoint, rpcs: o.rpc, indexPin: pin, book: (o.book || PRODUCTION_BOOK).toLowerCase(), hostOwnership: (o['host-ownership'] || PRODUCTION_HOST_OWNERSHIP).toLowerCase() }));
    } else if (cmd === 'policy-import') {
      if (!o['import-dir'] || !path.isAbsolute(o['import-dir'])) throw fail(1, 'policy-import needs an absolute --import-dir');
      print(await policyImport({ importDir: o['import-dir'], carriers: o.carrier?.length ? o.carrier : [...PRODUCTION_MIRRORS], rpcs: o.rpc, dryRun: !!o['dry-run'],
        book: (o.book || PRODUCTION_BOOK).toLowerCase(), hostOwnership: (o['host-ownership'] || PRODUCTION_HOST_OWNERSHIP).toLowerCase() }));
    } else if (cmd === 'fill-artifacts') {
      if (!o.manifest || !o.dir) throw fail(1, 'fill-artifacts needs --manifest and --dir');
      const r = await fillArtifacts({ manifest: o.manifest, dir: o.dir, fromDirs: o['from-dir'] || [], fromOrigins: o['from-origin'] || [], maxObjectBytes: Number(o['max-object-bytes'] || (1 << 30)), log: (m) => console.error(m) });
      print(r); if (r.missing.length) process.exitCode = 3;
    } else if (cmd === 'gen-config') {
      if (!o.spec || !o.listeners || !o.out) throw fail(1, 'gen-config needs --spec, --listeners and --out');
      let text = fs.readFileSync(o.listeners, 'utf8');
      try { const j = JSON.parse(text); if (Array.isArray(j.listeners)) text = j.listeners.join('\n'); } catch {}
      const cfg = genConfig(JSON.parse(fs.readFileSync(o.spec, 'utf8')), text);
      writeAtomic(o.out, JSON.stringify(cfg, null, 2) + '\n');
      print({ wrote: o.out, sha256: sha(fs.readFileSync(o.out)) });
    } else if (cmd === 'health') {
      if (!o.config) throw fail(1, 'health needs --config');
      const r = await health({ config: o.config, artifacts: o.artifacts || 'sample', rpcs: o.rpc });
      if (o.json) print(r); else for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.detail).slice(0, 400)}`);
      if (!r.ok) process.exitCode = 2;
    } else if (cmd === 'capture-app-static') {
      if (!o.zone || !o.label?.length || !o.server?.length) throw fail(1, 'capture-app-static needs --zone, --label ... and --server <authoritative IPv4> ...');
      const r = await captureAppStatic({ zone: o.zone, labels: o.label, servers: o.server });
      print(r); if (r.refused.length) process.exitCode = 3;
    } else if (cmd === 'host-services') {
      if (!o.endpoint || !o.zone || !o.exit?.length) throw fail(1, 'host-services needs --endpoint, --zone and --exit <providerId>=<IPv4> ...');
      const exits = o.exit.map((x) => { const [providerId, address] = String(x).split('='); return { providerId, address }; });
      const tls = o['tls-http'] ? { httpPort: Number(o['tls-http']), tlsPorts: Object.fromEntries((o.tls || []).map((x) => { const [r, p] = String(x).split('='); return [r, Number(p)]; })) } : null;
      // --probe-tls: https only for roles whose loopback G3 listener completes a VERIFIED handshake for the derived name now
      const base = hostServicePublication({ endpoint: o.endpoint, zone: o.zone, exits, tls, hostId: o['host-id'] || null, ...(o.dns ? { dns: { tcp: 18153, udp: 18153 } } : {}) });
      const ready = {};
      if (o['probe-tls'] && tls) for (const [role, port] of Object.entries(tls.tlsPorts)) ready[role] = await tlsReady({ port, servername: base.names[role] });
      print(hostServicePublication({ endpoint: o.endpoint, zone: o.zone, exits, tls, hostId: o['host-id'] || null, ready, ...(o.dns ? { dns: { tcp: 18153, udp: 18153 } } : {}) }));
    } else throw fail(1, 'usage: stage-tool.mjs capture-public|policy-import|fill-artifacts|gen-config|health|capture-app-static|host-services ... (see the header)');
  })().catch((e) => { console.error(e.message); process.exit(e.exit || 1); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
