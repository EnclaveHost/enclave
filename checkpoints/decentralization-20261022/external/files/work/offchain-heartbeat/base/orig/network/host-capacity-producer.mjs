// The HOST side of host capacity records (network/host-capacity.mjs; docs/network/independent-capacity.md): serve this
// host's own signed /availability at GET <registered endpoint>/v1/host/capacity, and optionally POST it to directories
// its operator names. Kept apart from network/host-capacity-http.mjs (the reader and directory), and free of package
// imports, so a host ships only this file, host-capacity-record.mjs and canonical.mjs: the measured supervisor image
// COPYs them, and the Windows node's deploy-files.mjs refuses package imports outside windows/node.
import { buildCapacityRecord, signCapacityRecord, HOST_CAPACITY_MAX_MS } from "./host-capacity-record.mjs";

export const HOST_CAPACITY_PATH = "/v1/host/capacity";          // on a host's registered endpoint
export const DIRECTORY_CAPACITY_PATH = "/v1/host-capacity";     // on a directory
const DIRECTORY_REPLY_MAX = 16 * 1024 * 1024;

/** Explicit directory origins: the rules of network/directory-client.mjs directoryOrigins (1..8, http(s), bare origin). */
export function capacityDirectoryOrigins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) throw new Error("1..8 directory origins required");
  return [...new Set(values.map((v) => {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("directory origin required");
    return u.origin;
  }))];
}

/** Explicit directory origins: bounded JSON, no redirects. -> { status, json } */
export function directoryJsonFetch({ fetch = globalThis.fetch, timeoutMs = 8000, maxBytes = DIRECTORY_REPLY_MAX } = {}) {
  return async (url, { method = "GET", body } = {}) => {
    const r = await fetch(url, { method, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs),
      ...(body ? { headers: { "content-type": "application/json" }, body } : {}) });
    const length = Number(r.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) { await r.body?.cancel(); throw new Error("directory reply too large"); }
    const chunks = []; let n = 0;
    if (r.body) for await (const c of r.body) { n += c.length; if (n > maxBytes) throw new Error("directory reply too large"); chunks.push(c); }
    const text = Buffer.concat(chunks).toString("utf8");
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { throw new Error("directory reply is not JSON"); }
    return { status: r.status, json };
  };
}

/**
 * createHostCapacityProducer({ account, hostIdOf, chainId, identity | registry+endpoint, availability, lifetimeMs, now })
 *   account: the registry operator's account ({ address, signMessage }, a viem LocalAccount);
 *   hostIdOf: endpoint -> keccak256(endpoint), the host's own (viem keccak256(toBytes(e)), chain.enclaveIdOf);
 *   identity: () -> { endpoint, registry } while this host is confirmed registered there, else null: ONE gate, read on
 *             every request and again after signing, so a record is never served for an identity the host has lost;
 *   registry/endpoint: the same as two values or functions (null = not registered), for hosts that hold them apart;
 *   availability: async () -> the host's own /availability document, exactly.
 * -> { current() -> envelope, handle(req, res), frame() -> { status, headers, body }, publish(origins) }
 * A record is re-signed when half its lifetime has passed; its sequence only moves forward.
 */
export function createHostCapacityProducer({ account, hostIdOf, chainId = 8453, identity, registry, endpoint, availability, lifetimeMs = 5 * 60_000, now = Date.now, fetchJson = directoryJsonFetch() }) {
  if (!account?.address || typeof account.signMessage !== "function" || typeof availability !== "function" || typeof hostIdOf !== "function")
    throw new Error("a capacity producer needs the operator account, a keccak256 hostIdOf and its availability source");
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > HOST_CAPACITY_MAX_MS) throw new Error(`lifetimeMs must be 30 s..${HOST_CAPACITY_MAX_MS / 60000} min`);
  if (identity !== undefined && (typeof identity !== "function" || registry !== undefined || endpoint !== undefined))
    throw new Error("a capacity producer takes identity() or registry and endpoint, not both");
  const val = (x) => (typeof x === "function" ? x() : x);
  // -> { endpoint, registry (lowercase) } or null
  const who = () => { const id = identity ? identity() : { endpoint: val(endpoint), registry: val(registry) };
    return id && id.endpoint && id.registry ? { endpoint: String(id.endpoint), registry: String(id.registry).toLowerCase() } : null; };
  const unregistered = () => Object.assign(new Error("this host is not registered yet: no capacity record"), { status: 503 });
  const same = (r, id) => !!id && r.endpoint === id.endpoint && r.registry === id.registry;
  let cached = null, last = 0, inflight = null;
  async function make() {
    const id = who(), t = now();
    if (!id) throw unregistered();
    const ep = id.endpoint, reg = id.registry;
    const sequence = Math.max(last + 1, t);
    if (sequence > t) throw Object.assign(new Error("the clock moved backwards; capacity is re-signed once it passes the last record"), { status: 503 });
    const doc = await availability();
    const env = await signCapacityRecord(account, buildCapacityRecord({ availability: doc, chainId, registry: reg, endpoint: ep, hostId: hostIdOf(ep), operator: account.address, sequence, now: t, lifetimeMs }));
    last = sequence;
    if (!same(env.record, who())) throw unregistered();   // the identity changed while the document was read and signed
    cached = env;
    return env;
  }
  async function current() {
    const t = now(), id = who();   // no identity: never the cache (same() is false), and make() refuses
    if (cached && t >= cached.record.issuedAt && t < cached.record.issuedAt + lifetimeMs / 2 && same(cached.record, id)) return cached;
    inflight ||= make().finally(() => { inflight = null; });
    return inflight;
  }
  async function frame() {
    try { return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(await current()) }; }
    catch (e) { return { status: Number.isInteger(e?.status) ? e.status : 503, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ error: String(e?.message || e).slice(0, 300) }) }; }
  }
  async function handle(req, res) {
    if (req.method !== "GET") { res.writeHead(405, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "GET only" })); }
    const f = await frame(); res.writeHead(f.status, f.headers); res.end(f.body);
  }
  async function publish(origins) {
    const env = await current(), list = capacityDirectoryOrigins(origins), body = JSON.stringify(env);
    return Promise.all(list.map(async (o) => {
      try { const r = await fetchJson(o + DIRECTORY_CAPACITY_PATH, { method: "POST", body }); return { origin: o, ok: r.status === 200, status: r.status, error: r.json?.error }; }
      catch (e) { return { origin: o, ok: false, error: String(e.message).slice(0, 200) }; }
    }));
  }
  return { current, frame, handle, publish };
}
