// verifier/collateral.mjs: where the AMD chain, the VCEK and the CRL come from. Every adapter has the same
// shape, and the verifier does not care which one it was given, because correctness never rests on the
// source: the ARK is pinned by fingerprint, the ASK must be signed by it, the VCEK by the ASK, and the
// VCEK's extensions must name the report's chip and TCB. A mirror, a proxy, a file or AMD itself are
// interchangeable; what differs is availability and freshness, which each adapter reports honestly.
//
//   adapter.chain(product)                 -> { pem, source, fetchedAt? }
//   adapter.vcek(product, chipIdHex, tcbHex, kdsUrl) -> { der, source, fetchedAt? } | null
//   adapter.crl(product)                   -> { der, source, fetchedAt? } | null
import fs from "node:fs";
import path from "node:path";

// Files, laid out like test/fixtures: <dir>/amd/<Product>-cert_chain.pem, <dir>/amd/<Product>-crl.der,
// <dir>/vcek/<Product>-<chipIdHex>-<tcbHex>.der (or any explicit map passed in).
export function fileCollateral(dir, { vceks = {}, chains = {}, crls = {} } = {}) {
  const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const stamp = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } };
  return {
    kind: "file",
    chain(product) {
      const p = chains[product] || path.join(dir, "amd", `${product}-cert_chain.pem`);
      const b = read(p); if (!b) throw new Error(`no AMD chain on file for ${product} (${p})`);
      return { pem: b.toString("utf8"), source: `file:${p}`, fetchedAt: stamp(p) };
    },
    vcek(product, chipIdHex, tcbHex) {
      const key = `${product}-${chipIdHex}-${tcbHex}`;
      const p = vceks[key] || vceks[product] || path.join(dir, "vcek", `${key}.der`);
      const b = read(p); return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    },
    crl(product) {
      const p = crls[product] || path.join(dir, "amd", `${product}-crl.der`);
      const b = read(p); return b ? { der: b, source: `file:${p}`, fetchedAt: stamp(p) } : null;
    },
  };
}

// In-memory, for tests and for a caller that already holds the bytes (the report's own certificate table).
export function memoryCollateral({ chains = {}, vceks = {}, crls = {} } = {}) {
  return {
    kind: "memory",
    chain: (product) => { if (!chains[product]) throw new Error(`no AMD chain held for ${product}`); return { pem: chains[product], source: "memory" }; },
    vcek: (product, chipIdHex, tcbHex) => { const d = vceks[`${product}-${chipIdHex}-${tcbHex}`] || vceks[product]; return d ? { der: d, source: "memory" } : null; },
    crl: (product) => crls[product] ? { der: crls[product], source: "memory" } : null,
  };
}

// Network: AMD KDS (default) or any mirror with the same paths. Bounded like relay/snp-verify.mjs fetchBuf:
// a hung or oversized answer is a failure, never a wait. KDS rate-limits (HTTP 429), so callers should
// front this with a cache keyed by (product, chip, TCB); the verifier caches nothing itself.
export const AMD_KDS = "https://kdsintf.amd.com";
export function httpCollateral({ base = AMD_KDS, timeoutMs = 8000, maxBytes = 256 * 1024, fetchImpl = globalThis.fetch } = {}) {
  async function get(url) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const chunks = []; let seen = 0;
      for await (const c of r.body ?? []) { seen += c.length; if (seen > maxBytes) { ctrl.abort(); throw new Error(`${url}: body exceeds ${maxBytes} bytes`); } chunks.push(Buffer.from(c)); }
      return Buffer.concat(chunks);
    } finally { clearTimeout(t); }
  }
  const now = () => new Date().toISOString();
  return {
    kind: "http", base,
    async chain(product) { return { pem: (await get(`${base}/vcek/v1/${product}/cert_chain`)).toString("utf8"), source: `${base}/vcek/v1/${product}/cert_chain`, fetchedAt: now() }; },
    async vcek(product, chipIdHex, tcbHex, kdsPath) { const url = `${base}/${kdsPath}`; return { der: await get(url), source: url, fetchedAt: now() }; },
    async crl(product) { const url = `${base}/vcek/v1/${product}/crl`; return { der: await get(url), source: url, fetchedAt: now() }; },
  };
}

// Layered: try each adapter in order (auxblob first, then a file cache, then a network source).
export function layeredCollateral(...adapters) {
  const first = async (fn) => { let last = null; for (const a of adapters) { try { const r = await fn(a); if (r) return r; } catch (e) { last = e; } } if (last) throw last; return null; };
  return {
    kind: "layered",
    chain: (product) => first((a) => a.chain(product)),
    vcek: (product, chip, tcb, kdsPath) => first((a) => a.vcek(product, chip, tcb, kdsPath)),
    crl: (product) => first((a) => a.crl(product)),
  };
}
