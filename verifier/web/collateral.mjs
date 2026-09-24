// verifier/web/collateral.mjs: the in-memory collateral adapter for the browser build (verifier/collateral.mjs's memoryCollateral
// without the node:fs neighbours). Bytes in, bytes out: a page that fetched the chain, the VCEK and the CRL itself, or holds
// them from the report's own certificate table, hands them here. Correctness never rests on the source (the chain and the
// VCEK's extensions decide), so this adapter says only where the bytes came from.
export function memoryCollateral({ chains = {}, vceks = {}, crls = {} } = {}, source = "memory") {
  return {
    kind: "memory",
    chain: (product) => { if (!chains[product]) throw new Error(`no AMD chain held for ${product}`); return { pem: chains[product], source }; },
    vcek: (product, chipIdHex, tcbHex) => { const d = vceks[`${product}-${chipIdHex}-${tcbHex}`] || vceks[product]; return d ? { der: d, source } : null; },
    crl: (product) => (crls[product] ? { der: crls[product], source } : null),
  };
}

// Network, for a page: AMD KDS's paths under an EXPLICIT base (a same-origin mirror; KDS itself sends no CORS headers, so a
// page cannot read it directly). Bounded like verifier/collateral.mjs httpCollateral: a hung or oversized answer is a
// failure, never a wait. Only the three KDS-shaped paths are ever requested, under the base given; nothing else.
export function httpCollateral({ base, fetchImpl = globalThis.fetch, timeoutMs = 8000, maxBytes = 256 * 1024 } = {}) {
  if (typeof base !== "string" || !/^https?:\/\/[^/?#]+$/.test(base)) throw new Error("httpCollateral: base must be an absolute http(s) origin with no path");
  async function get(url) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal, redirect: "error", credentials: "omit" });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const reader = r.body.getReader(); const chunks = []; let n = 0;
      for (;;) { const { value, done } = await reader.read(); if (done) break; n += value.length; if (n > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`${url}: body exceeds ${maxBytes} bytes`); } chunks.push(value); }
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch (e) { if (e && e.name === "AbortError") throw new Error(`${url}: timed out after ${timeoutMs} ms`); throw e; } finally { clearTimeout(t); }
  }
  const now = () => new Date().toISOString(), asBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const product = (p) => { if (!/^[A-Za-z]{2,16}$/.test(String(p))) throw new Error(`httpCollateral: not a product line: ${JSON.stringify(p)}`); return p; };
  return {
    kind: "http", base,
    async chain(p) { const url = `${base}/vcek/v1/${product(p)}/cert_chain`; return { pem: new TextDecoder().decode(await get(url)), source: url, fetchedAt: now() }; },
    async vcek(p, chipIdHex, tcbHex, kdsPath) { if (typeof kdsPath !== "string" || !kdsPath.startsWith(`vcek/v1/${product(p)}/`)) throw new Error("httpCollateral: the VCEK path is not a KDS path for this product"); const url = `${base}/${kdsPath}`; return { der: asBuf(await get(url)), source: url, fetchedAt: now() }; },
    async crl(p) { const url = `${base}/vcek/v1/${product(p)}/crl`; return { der: asBuf(await get(url)), source: url, fetchedAt: now() }; },
  };
}
