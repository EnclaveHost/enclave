// verifier/collateral-cache.mjs: an AUTHENTICATED, freshness-aware disk cache in front of any collateral adapter
// (verifier/collateral.mjs). The verifier re-verifies everything it is handed, so a cache can never make invalid
// collateral accepted; what this adapter adds is that a cache can never make VALID collateral unavailable either, and
// that nothing unauthenticated is stored or served:
//   - every entry is authenticated against the pinned AMD roots BEFORE it is served (the chain by parseAmdChain: the
//     pinned ARK, the ASK signed by it, both valid now; the VCEK by its subject, issuer, validity, the ASK's signature AND
//     its AMD extensions naming exactly the chip id and TCB the slot is keyed by (vcekMatchesReport, the verifier's own
//     matcher), so an authentic certificate for another chip or TCB can never occupy a slot and shadow a healthy upstream
//     (a finding of Codex's review, 2026-09-24); the CRL by checkCrlAuthentic: RSASSA-PSS, the pinned ARK as issuer and
//     signer, not from the future). An entry that fails is quarantined (renamed aside, never served) and the next source
//     is tried;
//   - only bytes that passed that authentication are written, atomically (temp + rename) with a sidecar of sha256,
//     source, fetchedAt; a poisoned or garbage upstream answer is refused and not cached;
//   - a CRL past its nextUpdate is not served while an upstream can answer: the upstream is tried first; only when no
//     upstream answers is the stale CRL served, and then flagged `stale: true` so the verifier's CRL policy decides
//     (required: rejected; stale-ok: limited within its bound). Staleness and revocation are never hidden: a genuine CRL
//     that revokes the ASK is authentic and is served, so the verifier can reject;
//   - a warm cache answers with no network at all; a cache write failure is reported, never fatal (the bytes still go to
//     the verifier), and never mistaken for a hit.
//   cachedCollateral({ dir, upstream, now, roots }) -> adapter { chain, vcek, crl, events, stats, kind: "cache" }
import fs from "node:fs";
import path from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { AMD_ARK_SHA256, vcekMatchesReport } from "../relay/snp-verify.mjs";
import { parseAmdChain, checkCrlAuthentic } from "./snp.mjs";
import { parseCrl } from "./der.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const cn = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

export function cachedCollateral({ dir, upstream = null, now = () => new Date(), roots = AMD_ARK_SHA256 } = {}) {
  if (!dir) throw new Error("cachedCollateral needs a directory");
  const events = [], stats = { hits: 0, misses: 0, fetches: 0, quarantined: 0, writeFailures: 0, staleServed: 0 };
  const note = (kind, key, why) => events.push({ kind, key, why });
  const file = (product, name) => path.join(dir, safe(product), name);
  const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
  const meta = (f) => { try { return JSON.parse(fs.readFileSync(`${f}.meta.json`, "utf8")); } catch { return null; } };
  const quarantine = (f, why) => { stats.quarantined++; note("quarantined", f, why); try { fs.renameSync(f, `${f}.rejected-${Date.now()}`); } catch {} try { fs.rmSync(`${f}.meta.json`, { force: true }); } catch {} };
  const write = (f, bytes, m) => {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
      fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, f);
      fs.writeFileSync(`${f}.meta.json`, JSON.stringify({ sha256: sha256(bytes), ...m, validatedAt: now().toISOString() }) + "\n");
      return true;
    } catch (e) { stats.writeFailures++; note("cache-write-failed", f, e.message); return false; }
  };
  const chainMemo = new Map();   // product -> { ask, ark } of the chain served in this instance (authenticated)

  async function chain(product) {
    const f = file(product, "chain.pem");
    const cached = read(f);
    if (cached) {
      const m = meta(f), c = parseAmdChain({ chainPem: cached.toString("utf8"), product, now: now(), roots });
      if (c.ok && m && m.sha256 === sha256(cached)) { stats.hits++; chainMemo.set(product, c); return { pem: cached.toString("utf8"), source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true }; }
      quarantine(f, c.ok ? "sidecar missing or its sha256 does not match the bytes" : c.why);
    } else stats.misses++;
    if (!upstream) throw new Error(`no AMD chain for ${product}: not cached and no upstream source`);
    stats.fetches++;
    const r = await upstream.chain(product);
    if (!r || typeof r.pem !== "string") throw new Error(`no AMD chain for ${product} from ${upstream.kind || "upstream"}`);
    const c = parseAmdChain({ chainPem: r.pem, product, now: now(), roots });
    if (!c.ok) { note("upstream-refused", `${product} chain from ${r.source}`, c.why); throw new Error(`AMD chain from ${r.source} failed authentication: ${c.why}`); }
    chainMemo.set(product, c);
    write(f, Buffer.from(r.pem, "utf8"), { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString() });
    return { pem: r.pem, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function askOf(product) { if (!chainMemo.has(product)) await chain(product); return chainMemo.get(product); }
  // a VCEK is authentic for a SLOT only if it is AMD's for this product AND its extensions name the slot's chip id and TCB
  const vcekWhy = (der, product, ask, chipIdHex, tcbHex) => {
    let v; try { v = new X509Certificate(der); } catch (e) { return `VCEK unparseable: ${e.message}`; }
    if (cn(v.subject) !== "SEV-VCEK") return `VCEK subject CN is ${cn(v.subject)}`;
    if (cn(v.issuer) !== `SEV-${product}`) return `VCEK issuer CN is ${cn(v.issuer)}, expected SEV-${product}`;
    const t = now(); if (t < new Date(v.validFrom) || t > new Date(v.validTo)) return `VCEK not valid at ${t.toISOString()}`;
    if (v.publicKey.asymmetricKeyType !== "ec" || v.publicKey.asymmetricKeyDetails?.namedCurve !== "secp384r1") return "VCEK key is not EC P-384";
    if (!v.checkIssued(ask) || !v.verify(ask.publicKey)) return "VCEK is not signed by the ASK";
    const mismatch = vcekMatchesReport(der, product, { chipId: Buffer.from(chipIdHex, "hex"), reportedTcb: Buffer.from(tcbHex, "hex") });
    if (mismatch) return `${mismatch} (the slot ${chipIdHex.slice(0, 16)}.../${tcbHex}: an authentic certificate for another chip or TCB is not this slot's)`;
    return null;
  };
  async function vcek(product, chipIdHex, tcbHex, kdsPath) {
    if (!/^[0-9a-f]{128}$/.test(chipIdHex || "") || !/^[0-9a-f]{16}$/.test(tcbHex || "")) throw new Error(`VCEK slot key malformed (chip id ${JSON.stringify(chipIdHex)}, TCB ${JSON.stringify(tcbHex)}): 64-byte and 8-byte lowercase hex are required`);
    const f = file(product, path.join("vcek", `${safe(chipIdHex)}-${safe(tcbHex)}.der`));
    const { ask } = await askOf(product);
    const cached = read(f);
    if (cached) {
      const m = meta(f), why = vcekWhy(cached, product, ask, chipIdHex, tcbHex);
      if (!why && m && m.sha256 === sha256(cached)) { stats.hits++; return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true }; }
      quarantine(f, why || "sidecar missing or its sha256 does not match the bytes");
    } else stats.misses++;
    if (!upstream) return null;
    stats.fetches++;
    const r = await upstream.vcek(product, chipIdHex, tcbHex, kdsPath);
    if (!r) return null;
    if (!Buffer.isBuffer(r.der)) throw new Error(`VCEK from ${r.source} is not bytes`);
    const why = vcekWhy(r.der, product, ask, chipIdHex, tcbHex);
    if (why) { note("upstream-refused", `${product} VCEK ${chipIdHex.slice(0, 16)} from ${r.source}`, why); throw new Error(`VCEK from ${r.source} failed authentication: ${why}`); }
    write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? now().toISOString(), chipId: chipIdHex, tcb: tcbHex });
    return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false };
  }
  async function crl(product) {
    const f = file(product, "crl.der");
    const { ark } = await askOf(product);
    const t = now();
    let staleCached = null;
    const cached = read(f);
    if (cached) {
      const m = meta(f), a = checkCrlAuthentic({ crlDer: cached, ark, now: t });
      if (a.ok && m && m.sha256 === sha256(cached)) {
        const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null;
        if (!a.crl.nextUpdate || t <= a.crl.nextUpdate) { stats.hits++; return { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: false, nextUpdate }; }
        staleCached = { der: cached, source: `cache:${f}`, fetchedAt: m.fetchedAt ?? null, cached: true, stale: true, nextUpdate };   // past nextUpdate: refresh first
        note("stale", f, `CRL nextUpdate ${nextUpdate} is past; trying the upstream before serving it stale`);
      } else quarantine(f, a.ok ? "sidecar missing or its sha256 does not match the bytes" : a.why);
    } else stats.misses++;
    if (upstream) {
      stats.fetches++;
      let r = null, err = null;
      try { r = await upstream.crl(product); } catch (e) { err = e; }
      if (r && Buffer.isBuffer(r.der)) {
        const a = checkCrlAuthentic({ crlDer: r.der, ark, now: t });
        if (!a.ok) { note("upstream-refused", `${product} CRL from ${r.source}`, a.why); if (!staleCached) throw new Error(`CRL from ${r.source} failed authentication: ${a.why}`); }
        else {
          const nextUpdate = a.crl.nextUpdate ? a.crl.nextUpdate.toISOString() : null, stale = !!(a.crl.nextUpdate && t > a.crl.nextUpdate);
          write(f, r.der, { source: r.source ?? null, fetchedAt: r.fetchedAt ?? t.toISOString() });
          if (stale) stats.staleServed++;
          return { der: r.der, source: r.source ?? "upstream", fetchedAt: r.fetchedAt ?? null, cached: false, stale, nextUpdate };
        }
      } else if (err) note("upstream-failed", `${product} CRL`, err.message);
    }
    if (staleCached) { stats.staleServed++; note("stale-served", f, "no fresher CRL available; served stale for the policy to judge"); return staleCached; }
    return null;
  }
  return { kind: "cache", dir, events, stats, chain, vcek, crl };
}

/** What a cache directory holds, for diagnosis: every entry with its sidecar and whether the sidecar's sha256 matches. */
export function inspectCache(dir) {
  const out = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!/\.meta\.json$|\.tmp$|\.rejected-\d+$/.test(e.name)) { let m = null; try { m = JSON.parse(fs.readFileSync(`${p}.meta.json`, "utf8")); } catch {} out.push({ file: p, bytes: fs.statSync(p).size, meta: m, sidecarMatches: !!m && m.sha256 === sha256(fs.readFileSync(p)) }); } } };
  walk(dir); return out;
}
export { parseCrl };
