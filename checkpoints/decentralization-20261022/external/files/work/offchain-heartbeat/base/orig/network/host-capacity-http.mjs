// Serving, publishing, fetching and discovering host capacity records (network/host-capacity.mjs;
// docs/network/independent-capacity.md). Nothing here needs, or defaults to, an Enclave service:
//   - a HOST serves its own signed record at GET <registered endpoint>/v1/host/capacity (network/host-capacity-producer.mjs,
//     re-exported here) and may POST it to directories its operator chooses;
//   - a DIRECTORY is anyone's storage (createHostCapacityDirectory): POST/GET /v1/host-capacity; it verifies before it
//     stores, but readers verify again and never trust it;
//   - a READER (discoverHostCapacity) takes explicit directories, explicit hosts, or a cold read of every live
//     registered host, verifies each record against ONE agreed registry block of an explicitly pinned, reviewed
//     registry, and keeps one record per host.
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { keccak256 } from "viem";
import { isBlockedHost } from "../net-guard.mjs";
import { directoryOrigins } from "./directory-client.mjs";
import { verifyHostCapacity, validateHostCapacityRecord, CapacityFloors, chooseRecord, aggregateCapacity, hostIdOf, hostCapacityHash } from "./host-capacity.mjs";
import { HOST_CAPACITY_PATH, DIRECTORY_CAPACITY_PATH, directoryJsonFetch } from "./host-capacity-producer.mjs";

// the host side (network/host-capacity-producer.mjs), re-exported for readers that want one import
export { HOST_CAPACITY_PATH, DIRECTORY_CAPACITY_PATH, directoryJsonFetch, createHostCapacityProducer } from "./host-capacity-producer.mjs";
const ENVELOPE_MAX = 64 * 1024;

// ---- the registry, at one agreed block ---------------------------------------------------------------------------------
// The DEPLOYED registry is schema 4 (EnclaveRegistry at b17db9a3: an 11-field struct). Every read checks, at the same
// agreed block, that the pinned address carries the reviewed runtime code and reports the reviewed schema; only then is
// a row decoded and used.
const ENCLAVE4 = [["endpoint", "string"], ["repo", "string"], ["measurement", "bytes32"], ["operator", "address"], ["registeredAt", "uint64"],
  ["lastSeen", "uint64"], ["active", "bool"], ["cpuPricePerSec6", "uint64"], ["gpuPricePerSec6", "uint64"], ["proofKey", "address"], ["payoutWallet", "address"]]
  .map(([name, type]) => ({ name, type }));
const REGISTRY4 = [
  { type: "function", name: "registrySchema", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: ENCLAVE4 }] },
  { type: "function", name: "getPage", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "tuple[]", components: ENCLAVE4 }] },
];
const reverted = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (["ContractFunctionRevertedError", "ContractFunctionZeroDataError"].includes(x.name)) return true; return false; };

/** The registry pin of a reviewed authority profile (network/authority-profile.mjs parseProfile). Schema 4 only. */
export function capacityRegistryBinding(profile) {
  const r = profile?.contracts?.registry;
  if (!r || !/^0x[0-9a-f]{40}$/.test(r.address || "") || !/^0x[0-9a-f]{64}$/.test(r.codeHash || "") || !Number.isSafeInteger(r.runtimeBytes))
    throw new Error("the authority profile has no registry pin");
  if (String(r.immutable?.registrySchema) !== "4") throw new Error(`the profile's registry is schema ${r.immutable?.registrySchema}; capacity records are read against the deployed schema 4 only`);
  return Object.freeze({ chainId: profile.chainId, address: r.address, codeHash: r.codeHash, runtimeBytes: r.runtimeBytes, schema: "4" });
}

/** reader: windows/node/host-identity.mjs quorumReader ({ agreed(fn) }) or cli/independent.mjs QuorumChain ({ snapshot(fn) }). */
export function agreedRead(reader) {
  if (typeof reader?.agreed === "function") return (fn) => reader.agreed(fn);
  if (typeof reader?.snapshot === "function") return (fn) => reader.snapshot(fn).then((s) => s.value);
  throw new Error("a quorum chain reader is required (agreed or snapshot)");
}
const row = (e) => ({ hostId: keccak256(new TextEncoder().encode(e.endpoint)), endpoint: String(e.endpoint), operator: String(e.operator).toLowerCase(), active: e.active === true,
  registeredAt: Number(e.registeredAt), lastSeen: Number(e.lastSeen), cpuPricePerSec6: String(e.cpuPricePerSec6), gpuPricePerSec6: String(e.gpuPricePerSec6),
  payoutWallet: String(e.payoutWallet).toLowerCase() });

/**
 * One agreed registry block: { blockNumber, blockHash, blockTime, entries: Map(hostId -> row) }. ids: the hosts to read,
 * or null for every registered host (a cold read; at most maxHosts). Throws on an outage (no quorum) or when the agreed
 * code or schema is not the reviewed binding (a refusal, with `refused: true`).
 */
export async function registrySnapshot(reader, binding, { ids = null, maxHosts = 4096 } = {}) {
  const agreed = agreedRead(reader);
  const facts = await agreed(async (c, blockNumber) => {
    const b = await c.getBlock({ blockNumber });
    const code = await c.getCode({ address: binding.address, blockNumber });
    const codeHash = code && code !== "0x" ? keccak256(code) : null, runtimeBytes = code ? (code.length - 2) / 2 : 0;
    let schema;
    try { schema = String(await c.readContract({ address: binding.address, abi: REGISTRY4, functionName: "registrySchema", blockNumber })); }
    catch (e) { if (!reverted(e)) throw e; schema = "!reverted"; }
    const out = { blockNumber: String(blockNumber), blockHash: String(b.hash).toLowerCase(), blockTime: Number(b.timestamp) * 1000, codeHash, runtimeBytes, schema, rows: [] };
    if (codeHash !== binding.codeHash || runtimeBytes !== binding.runtimeBytes || schema !== binding.schema) return out;
    const r = (fn, args = []) => c.readContract({ address: binding.address, abi: REGISTRY4, functionName: fn, args, blockNumber });
    if (ids) {
      for (let i = 0; i < ids.length; i += 16)
        for (const e of await Promise.all(ids.slice(i, i + 16).map((id) => r("get", [id])))) if (!/^0x0{40}$/i.test(e.operator)) out.rows.push(row(e));
    }
    else {
      const n = await r("count");
      if (n > BigInt(maxHosts)) return { ...out, tooMany: String(n) };
      for (let i = 0n; i < n; i += 50n) {
        const page = await r("getPage", [i, 50n]);
        if (page.length !== Number(n - i < 50n ? n - i : 50n)) throw new Error("incomplete registry page");
        out.rows.push(...page.map(row));
      }
    }
    return out;
  });
  if (facts.codeHash !== binding.codeHash || facts.runtimeBytes !== binding.runtimeBytes)
    throw Object.assign(new Error(`the pinned registry ${binding.address} does not carry the reviewed code at block ${facts.blockNumber}`), { refused: true });
  if (facts.schema !== binding.schema) throw Object.assign(new Error(`the pinned registry reports schema ${facts.schema}, not the reviewed ${binding.schema}`), { refused: true });
  if (facts.tooMany) throw new Error(`the registry lists ${facts.tooMany} hosts, more than the ${maxHosts} this read takes`);
  return { blockNumber: facts.blockNumber, blockHash: facts.blockHash, blockTime: facts.blockTime, entries: new Map(facts.rows.map((x) => [x.hostId, x])) };
}

// ---- guarded public fetch (a host endpoint is a permissionless registry string) ----------------------------------------
/**
 * GET/POST JSON over https to a PUBLIC host: no credentials, query or fragment, no redirects; the name is resolved once
 * and refused when ANY address is non-global (net-guard), and the connection is pinned to the checked address with TLS
 * verified for the name. -> { status, json }. `allowAddress` and `ca` are code-level test seams, never configuration.
 */
export function publicJsonFetch({ lookup = dns.promises.lookup, timeoutMs = 8000, maxBytes = ENVELOPE_MAX, allowAddress = (a) => !isBlockedHost(a), ca } = {}) {
  return async (url, { method = "GET", body } = {}) => {
    let u;
    try { u = new URL(url); } catch { throw new Error("not a URL"); }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error("host endpoints are https without credentials, query or fragment");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
    if (!addrs.length || addrs.some((a) => !allowAddress(a.address))) throw new Error(`${host} resolves to a non-public address; refused`);
    const pin = addrs[0];
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: host, port: u.port || 443, path: u.pathname, method, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}),
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) },
        // the connection may only reach the checked address (Node >= 20 asks for `all` when autoSelectFamily is on)
        lookup: (_h, o, cb) => (o?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)), timeout: timeoutMs, agent: false }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return reject(new Error("redirects are not followed")); }
        const chunks = []; let n = 0;
        res.on("data", (c) => { n += c.length; if (n > maxBytes) { res.destroy(); reject(new Error("reply too large")); } else chunks.push(c); });
        res.on("end", () => { try { resolve({ status: res.statusCode, json: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null }); } catch { reject(new Error("reply is not JSON")); } });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end(body);
    });
  };
}

// ---- verification against one agreed registry snapshot ----------------------------------------------------------------
async function verifyAgainst(envelope, snapshot, binding, floors, now) {
  const hostId = envelope?.record?.hostId;
  const v = await verifyHostCapacity(envelope, { pins: { chainId: binding.chainId, registry: binding.address }, entry: snapshot.entries.get(hostId) || null, now });
  floors?.check(v.record);
  return v;
}

// ---- a standalone directory: anyone's storage --------------------------------------------------------------------------
/**
 * createHostCapacityDirectory({ reader, binding, now, maxRecords, maxInflight })
 *   POST /v1/host-capacity  { record, signature }: verified against an agreed registry read for that host, then stored if
 *                           newer than what it holds for that host (floors per host and operator); 409 on equivocation
 *   GET  /v1/host-capacity  { records: [unexpired envelopes] }
 * -> { handle(req, res) -> boolean (true when it answered), records() }
 */
export function createHostCapacityDirectory({ reader, binding, now = Date.now, maxRecords = 256, maxInflight = 8, log = () => {} }) {
  const store = new Map(), floors = new CapacityFloors();
  let inflight = 0;
  const send = (res, code, body) => { if (res.headersSent || res.destroyed) return; res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
  const live = () => { const t = now(); for (const [k, e] of store) if (e.record.expiresAt <= t) store.delete(k); return [...store.values()]; };
  async function accept(envelope) {
    validateHostCapacityRecord(envelope?.record, now());
    const snapshot = await registrySnapshot(reader, binding, { ids: [envelope.record.hostId] });
    const v = await verifyAgainst(envelope, snapshot, binding, floors, now());
    const old = store.get(v.record.hostId);
    if (old && old.record.operator === v.record.operator && old.record.sequence >= v.record.sequence) {
      if (old.record.sequence === v.record.sequence && hostCapacityHash(old.record) === hostCapacityHash(v.record)) return false;
      throw Object.assign(new Error("an older record than this directory holds"), { status: 409 });
    }
    if (!old && live().length >= maxRecords) throw Object.assign(new Error("directory capacity reached"), { status: 503 });
    floors.record(v.record);
    store.set(v.record.hostId, { record: v.record, signature: envelope.signature });
    return true;
  }
  async function handle(req, res) {
    const path = new URL(req.url, "http://directory.local").pathname;
    if (path !== DIRECTORY_CAPACITY_PATH) return false;
    if (req.method === "GET") { send(res, 200, { records: live() }); return true; }
    if (req.method !== "POST") { req.resume(); send(res, 405, { error: "GET or POST" }); return true; }
    if (Number(req.headers["content-length"]) > ENVELOPE_MAX) { req.resume(); send(res, 413, { error: "record too large" }); return true; }
    if (inflight >= maxInflight) { req.resume(); res.setHeader("retry-after", "1"); send(res, 503, { error: "busy" }); return true; }
    inflight++;
    try {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > ENVELOPE_MAX) { send(res, 413, { error: "record too large" }); req.destroy(); return true; } chunks.push(c); }
      let env; try { env = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { send(res, 400, { error: "not JSON" }); return true; }
      try { send(res, 200, { ok: true, changed: await accept(env) }); }
      catch (e) { log(`capacity refused: ${String(e.message).slice(0, 200)}`); send(res, Number.isInteger(e.status) ? e.status : e.equivocation ? 409 : e.stale ? 409 : e.refused ? 503 : 400, { error: String(e.message).slice(0, 300) }); }
      return true;
    } finally { inflight--; }
  }
  return { handle, records: live };
}

// ---- discovery ---------------------------------------------------------------------------------------------------------
/** Live registered hosts at the agreed block: active and heartbeating within liveWithinSec (cli/independent.mjs liveHosts). */
export const liveRegistered = (entries, blockTime, liveWithinSec = 3600) =>
  [...entries.values()].filter((h) => h.active && h.lastSeen + liveWithinSec >= Math.floor(blockTime / 1000));

/**
 * discoverHostCapacity({ reader, binding, directories, hosts, cold, ... }) -> { quorum, sources, hosts, aggregate }
 *   directories: explicit origins (GET /v1/host-capacity); hosts: explicit registered endpoints or host ids
 *   (GET <endpoint>/v1/host/capacity); cold: every live registered host's endpoint (at most maxHosts).
 * Outages are reported, never turned into zero capacity: an unreachable host is "unreachable", a registry without a
 * quorum throws (nothing can be verified).
 */
export async function discoverHostCapacity({ reader, binding, directories = [], hosts = [], cold = false, maxHosts = 256, concurrency = 8, liveWithinSec = 3600,
                                             fetchHost = publicJsonFetch(), fetchDirectory = directoryJsonFetch(), floors = new CapacityFloors(), now = Date.now }) {
  if (!directories.length && !hosts.length && !cold) throw new Error("name at least one source: a directory, a host, or a cold read of the registry");
  const origins = directories.length ? directoryOrigins(directories) : [];
  const sources = [], candidates = new Map(), fetchErrors = new Map();
  const add = (env, source) => { const id = env?.record?.hostId; if (typeof id !== "string" || !/^0x[0-9a-f]{64}$/.test(id)) return; if (!candidates.has(id)) candidates.set(id, []); candidates.get(id).push({ envelope: env, source }); };
  // 1. directories
  await Promise.all(origins.map(async (o) => {
    try {
      const r = await fetchDirectory(o + DIRECTORY_CAPACITY_PATH);
      if (r.status !== 200 || !Array.isArray(r.json?.records)) throw new Error(`HTTP ${r.status}`);
      const list = r.json.records.slice(0, 4096);
      for (const env of list) add(env, o);
      sources.push({ source: o, kind: "directory", ok: true, records: list.length });
    } catch (e) { sources.push({ source: o, kind: "directory", ok: false, error: String(e.message).slice(0, 200) }); }
  }));
  // 2. the registry at one agreed block: every host for a cold read, else the hosts named or seen
  const named = [...new Set(hosts.map((h) => (/^0x[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : hostIdOf(String(h).replace(/\/+$/, "")))))];
  if (named.length > maxHosts) throw new Error(`${named.length} hosts named, more than --max-hosts ${maxHosts}`);
  // hosts seen only in directories: at most maxHosts in all (named first); the rest are reported, not silently read
  const seen = [...candidates.keys()].filter((id) => !named.includes(id)), room = Math.max(0, maxHosts - named.length);
  if (seen.length > room) {
    for (const id of seen.slice(room)) candidates.delete(id);
    sources.push({ source: "directories", kind: "limit", ok: false, error: `${seen.length - room} directory-listed host(s) beyond --max-hosts ${maxHosts} were not read` });
  }
  const snapshot = await registrySnapshot(reader, binding, cold ? { maxHosts: 4096 } : { ids: [...named, ...seen.slice(0, room)] });
  // 3. host endpoints
  const targets = new Map();
  for (const id of named) { const e = snapshot.entries.get(id); if (e) targets.set(id, e); else fetchErrors.set(id, "not a registered host"); }
  if (cold) for (const e of liveRegistered(snapshot.entries, snapshot.blockTime, liveWithinSec).slice(0, maxHosts)) targets.set(e.hostId, e);
  const queue = [...targets.values()];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let e; (e = queue.shift());) {
      try {
        const r = await fetchHost(e.endpoint.replace(/\/+$/, "") + HOST_CAPACITY_PATH);   // a registered endpoint may carry a path (/t/<name>)
        if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.json?.error ? ": " + String(r.json.error).slice(0, 120) : ""}`);
        add(r.json, e.endpoint);
        sources.push({ source: e.endpoint, kind: "host", ok: true });
      } catch (err) { fetchErrors.set(e.hostId, String(err.message).slice(0, 200)); sources.push({ source: e.endpoint, kind: "host", ok: false, error: String(err.message).slice(0, 200) }); }
    }
  }));
  // 4. verify, one record per host
  const t = now(), out = [], verifiedHosts = [];
  const ids = new Set([...candidates.keys(), ...targets.keys(), ...named]);
  for (const id of ids) {
    const entry = snapshot.entries.get(id) || null, reasons = [], good = [];
    for (const c of candidates.get(id) || []) {
      try { good.push({ envelope: c.envelope, source: c.source, verified: await verifyAgainst(c.envelope, snapshot, binding, floors, t) }); }
      catch (e) { reasons.push(`${c.source}: ${String(e.message).slice(0, 160)}`); }
    }
    let status, chosen = null;
    if (good.length) { chosen = chooseRecord(good); status = chosen.equivocation ? "equivocation" : "verified"; if (chosen.equivocation) chosen = null; }
    else if ((candidates.get(id) || []).length) status = reasons.every((r) => /expired/.test(r)) ? "expired" : reasons.every((r) => /replay/.test(r)) ? "stale" : "refused";
    else status = fetchErrors.has(id) ? "unreachable" : "none";
    if (fetchErrors.has(id)) reasons.push(`fetch: ${fetchErrors.get(id)}`);
    if (chosen) { floors.record(chosen.verified.record); verifiedHosts.push({ hostId: id, availability: chosen.verified.availability }); }
    out.push({ hostId: id, endpoint: entry?.endpoint ?? chosen?.verified.record.endpoint ?? null,
      registry: entry ? { active: entry.active, operator: entry.operator, cpuPricePerSec6: entry.cpuPricePerSec6, gpuPricePerSec6: entry.gpuPricePerSec6,
                          lastSeen: entry.lastSeen, postedPricesAreNotCapacity: true } : null,
      capacity: { status, ...(chosen ? { availability: chosen.verified.availability, issuedAt: chosen.verified.record.issuedAt, expiresAt: chosen.verified.record.expiresAt,
                  sequence: chosen.verified.record.sequence, operator: chosen.verified.record.operator,
                  sources: good.filter((g) => hostCapacityHash(g.verified.record) === hostCapacityHash(chosen.verified.record)).map((g) => g.source) } : {}),
                  reasons, selfReported: true } });
  }
  const liveIds = new Set((cold ? liveRegistered(snapshot.entries, snapshot.blockTime, liveWithinSec) : [...targets.values()]).map((e) => e.hostId));
  const unknown = [...liveIds].filter((id) => !verifiedHosts.some((h) => h.hostId === id)).length;
  return { quorum: { blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, blockTime: snapshot.blockTime, registry: binding.address },
           sources, hosts: out.sort((a, b) => a.hostId.localeCompare(b.hostId)), aggregate: aggregateCapacity(verifiedHosts, { unknown }) };
}
