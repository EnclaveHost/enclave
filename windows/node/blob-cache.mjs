// windows/node/blob-cache.mjs -- the host-side cache for PUBLIC, PINNED content a Shield app fetches
// (docs/design/shield-blob-cache.md).
//
// A Shield app reaches the internet through its own Enclave-network circuits. For a public object whose sha256 the
// app already pins (risc-box's ~1 GB disk image), that buys no privacy and costs it again on every start.
// shield-egress dials the reserved name blobs.enclave.internal:80 to this service instead of the app's route:
//
//   GET /sha256/<64 hex>?src=<url-encoded https URL>      (Range: bytes=N- / N-M honoured once cached)
//
// - cached: served from disk (the file is named by its sha256), at local speed, with Range;
// - not cached: the source is fetched ONCE, straight from this host, streamed to the requester while it is hashed to a
//   temp file, and committed only if the sha256 matches (concurrent requests for the same hash wait for that one
//   download, then read the cache);
// - the source must be https, without userinfo or a query string (a presigned URL is a credential: the host must never
//   be handed one), and every address it resolves to must be public (the connection is pinned to a checked address);
// - objects over maxObjectBytes are refused; the cache stays under maxBytes, least recently used out first.
// The guest verifies the sha256 of what it receives regardless: the host can delay or refuse a blob, never substitute one.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";

export const BLOB_HOST = "blobs.enclave.internal";
const HEX = /^[0-9a-f]{64}$/;

/** Is `ip` a public unicast address (never loopback, private, link-local, CGNAT, multicast, documentation...)? */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT
    if (a === 169 && b === 254) return false;                    // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")) || (b === 0 && ip.startsWith("192.0.2.")))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && ip.startsWith("198.51.100.")))) return false;
    if (a === 203 && ip.startsWith("203.0.113.")) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return false;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicAddress(m[1]);
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("2001:db8")) return false;
    return /^[23]/.test(v);                                        // global unicast only
  }
  return false;
}

/** Why `src` may not be fetched by the host ("" = it may). */
export function refuseSource(src) {
  let u;
  try { u = new URL(src); } catch { return "src is not a URL"; }
  if (u.protocol !== "https:") return "src must be https";
  if (u.username || u.password) return "src must not carry credentials";
  if (u.search || src.includes("?")) return "src must not have a query string (a presigned URL is a credential)";
  const host = u.hostname.replace(/^\[|\]$/g, "");          // an IPv6 literal keeps its brackets in URL.hostname
  if (net.isIP(host) && !isPublicAddress(host)) return "src must be a public address";
  return "";
}

/** The real source fetch: https, every resolved address public, the connection pinned to a checked one. */
export function httpsSource({ timeoutMs = 30_000, lookup = dns.promises.lookup } = {}) {
  return async (src) => {
    const u = new URL(src);
    const hostname = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, { all: true });
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new Error(`${u.hostname} resolves to a non-public address`);
    const pick = addrs[0];
    return await new Promise((resolve, reject) => {
      const req = https.get(src, { servername: u.hostname, timeout: timeoutMs,
        lookup: (_h, _o, cb) => cb(null, pick.address, pick.family) }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }));
      req.on("timeout", () => req.destroy(new Error("source timed out")));
      req.on("error", reject);
    });
  };
}

export function createBlobCache({ dir, maxBytes = 32 * 2 ** 30, maxObjectBytes = 4 * 2 ** 30, fetchSource = httpsSource(), log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const inflight = new Map();      // sha256 -> Promise<void> of the one download filling the cache for it
  const file = (h) => path.join(dir, h);

  async function evict(keep) {
    const items = [];
    for (const name of await fsp.readdir(dir)) {
      if (!HEX.test(name)) continue;
      const st = await fsp.stat(file(name)).catch(() => null);
      if (st) items.push({ name, size: st.size, used: st.mtimeMs });
    }
    let total = items.reduce((n, i) => n + i.size, 0);
    for (const i of items.sort((a, b) => a.used - b.used)) {
      if (total <= maxBytes) break;
      if (i.name === keep) continue;
      await fsp.rm(file(i.name), { force: true });
      total -= i.size;
      log(`blob cache: evicted ${i.name.slice(0, 12)} (${i.size} B) to stay under ${maxBytes} B`);
    }
  }

  async function serveCached(h, req, res) {
    const st = await fsp.stat(file(h));
    const now = new Date();
    fsp.utimes(file(h), now, now).catch(() => {});          // recency for the LRU
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ""));
    if (m) {
      const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || end < start) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-type": "application/octet-stream", "x-enclave-blob": "hit" });
      return fs.createReadStream(file(h), { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-length": st.size, "content-type": "application/octet-stream", "x-enclave-blob": "hit",
      "accept-ranges": "bytes" });
    fs.createReadStream(file(h)).pipe(res);
  }

  /** Fetch `src` once into the cache, streaming it to `res` (if given) as it arrives. Resolves when it is committed. */
  async function fill(h, src, res) {
    const r = await fetchSource(src);
    if (r.status !== 200) { r.stream?.resume?.(); throw Object.assign(new Error(`source answered ${r.status}`), { status: 502 }); }
    const len = Number(r.headers?.["content-length"]);
    if (Number.isFinite(len) && len > maxObjectBytes) { r.stream.destroy(); throw Object.assign(new Error(`object is ${len} B, over ${maxObjectBytes}`), { status: 413 }); }
    const tmp = path.join(dir, `.tmp-${h}-${randomBytes(4).toString("hex")}`);
    const out = fs.createWriteStream(tmp);
    const hash = createHash("sha256");
    let got = 0, failed = null, held = null;   // the latest chunk is held back until the hash is checked: a wrong object never arrives whole
    if (res && !res.headersSent) res.writeHead(200, { ...(Number.isFinite(len) ? { "content-length": len } : {}),
      "content-type": "application/octet-stream", "x-enclave-blob": "miss" });
    try {
      for await (const chunk of r.stream) {
        got += chunk.length;
        if (got > maxObjectBytes) throw Object.assign(new Error(`object passed ${maxObjectBytes} B`), { status: 413 });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((ok) => out.once("drain", ok));
        if (held && res && !res.destroyed && !res.write(held)) await new Promise((ok) => res.once("drain", ok));
        held = chunk;
      }
    } catch (e) { failed = e; }
    await new Promise((ok) => out.end(ok));
    const digest = hash.digest("hex");
    if (failed || digest !== h) {
      await fsp.rm(tmp, { force: true });
      const why = failed ? failed.message : `sha256 ${digest.slice(0, 12)}… is not the pinned ${h.slice(0, 12)}…`;
      log(`blob cache: ${h.slice(0, 12)} from ${new URL(src).host} NOT cached (${why})`);
      if (res && !res.destroyed) res.destroy();                 // the requester sees a cut body; its own check refuses it
      throw Object.assign(new Error(why), { status: failed?.status || 502, streamed: !!res });
    }
    await fsp.rename(tmp, file(h));
    log(`blob cache: ${h.slice(0, 12)} cached (${got} B from ${new URL(src).host})`);
    await evict(h).catch((e) => log(`blob cache: evict: ${e.message}`));
    if (res && !res.destroyed) res.end(held || undefined);
  }

  async function handle(req, res) {
    const u = new URL(req.url, "http://x");
    const m = /^\/sha256\/([0-9a-f]{64})$/.exec(u.pathname);
    const fail = (status, message) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain" }); res.end(message + "\n"); } };
    if (req.method !== "GET" || !m) return fail(400, "GET /sha256/<64 hex>?src=<https URL>");
    const h = m[1];
    try {
      if (fs.existsSync(file(h))) return await serveCached(h, req, res);
      const src = u.searchParams.get("src") || "";
      const why = refuseSource(src);
      if (why) return fail(403, why);
      if (inflight.has(h)) {                                      // someone is filling it: wait, then read the cache
        await inflight.get(h).catch(() => {});
        if (fs.existsSync(file(h))) return await serveCached(h, req, res);
        return fail(502, "the download for this object failed");
      }
      const p = fill(h, src, res).finally(() => inflight.delete(h));
      inflight.set(h, p);
      await p;
    } catch (e) {
      if (!e.streamed) fail(e.status || 502, e.message);
    }
  }

  return { handle, file, has: (h) => fs.existsSync(file(h)) };
}

/** The loopback HTTP server shield-egress dials blobs.enclave.internal:80 to. -> the listening server. */
export function startBlobService({ port, host = "127.0.0.1", ...opts }) {
  const cache = createBlobCache(opts);
  const server = http.createServer((req, res) => { void cache.handle(req, res); });
  server.listen(port, host);
  return Object.assign(server, { cache });
}
