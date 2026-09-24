// verifier/web/shadow.mjs: an OPT-IN, same-origin shadow run of the browser verifier beside whatever a page's primary
// verifier decided, producing a RECORD of the comparison. Three rules, each enforced here rather than hoped for:
//   1. It never decides. The record carries `acceptance: false` and no field a caller could read as a release; there is no
//      hook into the primary, and nothing here is called by the site. A consumer that wants a decision has verifier/admission.mjs.
//   2. It fetches only what it is told, from where it is told: the attestation document and the served certificate from
//      the explicit `origin` (the two well-known paths only), AMD collateral from the explicit `collateralBase` (the three
//      KDS-shaped paths only), each bounded in time and size, no redirects, no credentials. It never fetches or runs code.
//   3. Its roots are explicit. The AMD ARK pins are the repository's Map (relay/snp-verify.mjs), or the Map the caller
//      passes; the record says which, and every collateral source is recorded as the adapter reports it.
// OFF by default: `enabled` must be true, or run() fetches nothing and says so.
//
// What the record can and cannot say: a hosted-format verdict here rests on the served certificate the well-known endpoint
// returned, not on the connection the page actually used (a page cannot read its own TLS peer certificate), so the record
// states `transportBindingClaimed: false`. The comparison with the primary is like the live differential's (verifier/
// live-differential.mjs): agree, agree-refuse, disagree, primary-missing, on the primary's ok flag and, when given, its measurement.
import { AMD_ARK_SHA256, snpProductHint, kdsVcekUrl } from "../../relay/snp-verify.mjs";
import { parseReportStrict } from "../snp.mjs";
import { decodeEnvelopeWeb, verifyEvidenceWeb } from "./index.mjs";   // hoisted function bindings: safe across the entry's re-export cycle
import { httpCollateral } from "./collateral.mjs";
import * as x509 from "./x509.mjs";

const ORIGIN = /^https?:\/\/[^/?#]+$/;
export const WELL_KNOWN = Object.freeze({ document: "/.well-known/tinfoil-attestation", certificate: "/.well-known/tinfoil-certificate" });

export function createShadow({ enabled = false, origin = null, collateralBase = null, fetchImpl = globalThis.fetch, roots = null, timeoutMs = 8000, maxBytes = 256 * 1024, now = () => new Date() } = {}) {
  if (enabled) {
    if (typeof origin !== "string" || !ORIGIN.test(origin)) throw new Error("shadow: origin must be an absolute http(s) origin with no path (the page's own, normally)");
    if (typeof collateralBase !== "string" || !ORIGIN.test(collateralBase)) throw new Error("shadow: collateralBase must be an absolute http(s) origin with no path (a same-origin mirror of AMD KDS)");
    if (roots !== null && !(roots instanceof Map)) throw new Error("shadow: roots must be a Map of product line -> ARK sha256, or null for the repository's pins");
  }
  const rootsSource = roots ? "caller" : "pinned: relay/snp-verify.mjs AMD_ARK_SHA256";
  async function getText(url) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal, redirect: "error", credentials: "omit" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader(); const chunks = []; let n = 0;
      for (;;) { const { value, done } = await reader.read(); if (done) break; n += value.length; if (n > maxBytes) { await reader.cancel().catch(() => {}); throw new Error(`body exceeds ${maxBytes} bytes`); } chunks.push(value); }
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return new TextDecoder().decode(out);
    } catch (e) { throw new Error(`${url}: ${e && e.name === "AbortError" ? `timed out after ${timeoutMs} ms` : e.message}`); } finally { clearTimeout(t); }
  }
  const record = (fields) => ({ shadow: true, acceptance: false, enabled, transportBindingClaimed: false, rootsSource, ...fields });
  const refused = (what, message, sources, t0) => record({ ran: true, verdict: { status: "rejected", admissionSafe: false, omissions: [], technology: null, reasons: [`REJECT: ${what}: ${message}`], checks: { [what]: false }, claims: null }, comparison: null, sources, tookMs: Date.now() - t0 });

  // run({ host, expected: { allowedMeasurements, minTcb, product?, crl?, crlMaxStaleDays? }, primary?: { ok, measurement? } })
  async function run({ host, expected = {}, primary = null } = {}) {
    const t0 = Date.now();
    if (!enabled) return record({ ran: false, reasonNotRun: "shadow is disabled (opt-in): nothing was fetched", sources: {}, tookMs: 0 });
    if (typeof host !== "string" || !host) return record({ ran: false, reasonNotRun: "no host given: the served certificate cannot be judged", sources: {}, tookMs: 0 });
    const sources = { roots: rootsSource };
    let doc; try { const url = origin + WELL_KNOWN.document; sources.document = { url, fetchedAt: now().toISOString() }; doc = JSON.parse(await getText(url)); } catch (e) { return refused("document", e.message, sources, t0); }
    let certPem; try { const url = origin + WELL_KNOWN.certificate; sources.certificate = { url, fetchedAt: now().toISOString() }; const j = JSON.parse(await getText(url)); certPem = j && typeof j.certificate === "string" ? j.certificate : null; if (!certPem) throw new Error("no certificate field"); } catch (e) { return refused("certificate", e.message, sources, t0); }
    // the envelope first (its refusal is the verdict), then what the report names, so only that product's collateral is asked for
    const d = await decodeEnvelopeWeb(doc); if (d.verdict) return record({ ran: true, verdict: d.verdict, comparison: compare(d.verdict, primary), sources, tookMs: Date.now() - t0 });
    let p; try { p = parseReportStrict(d.env.body); } catch (e) { return refused("report shape", e.message, sources, t0); }
    const product = snpProductHint(p) || expected.product || null;
    if (!product) return refused("product line", "the report names no product line and none was expected", sources, t0);
    let spki; try { spki = x509.parseCertificate(x509.pemToDer(certPem)).spki; } catch (e) { return refused("certificate", `served certificate unparseable: ${e.message}`, sources, t0); }
    const collateral = httpCollateral({ base: collateralBase, fetchImpl, timeoutMs, maxBytes });
    const policy = { snp: { allowedMeasurements: expected.allowedMeasurements || [], ...(expected.minTcb ? { minTcb: expected.minTcb } : {}), ...(expected.crl ? { crl: expected.crl } : {}), ...(expected.crlMaxStaleDays !== undefined ? { crlMaxStaleDays: expected.crlMaxStaleDays } : {}), ...(roots ? { roots } : {}), ...(p.version < 3 ? { product } : {}) } };
    const verdict = await verifyEvidenceWeb(doc, { policy, context: { transportKeySpki: spki, certPem, host, now: now().toISOString() }, collateral });
    if (verdict.claims && verdict.claims.collateral) sources.collateral = verdict.claims.collateral;
    sources.vcekPath = kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, "");
    return record({ ran: true, verdict, comparison: compare(verdict, primary), sources, tookMs: Date.now() - t0 });
  }
  return Object.freeze({ enabled, run, rootsSource });
}

// The comparison, like verifier/live-differential.mjs: both green -> agree; both refuse -> agree-refuse; one each -> disagree;
// no primary -> primary-missing. "Green" for ours is `verified` only (limited is a refusal to accept). The primary's
// measurement, when given, is compared to the report's claimed measurement as a separate fact.
export function compare(verdict, primary) {
  if (!primary || typeof primary !== "object") return { outcome: "primary-missing", oursVerified: verdict.status === "verified", primaryOk: null, sameMeasurement: null };
  const ours = verdict.status === "verified", theirs = primary.ok === true;
  const sameMeasurement = typeof primary.measurement === "string" && verdict.claims && verdict.claims.measurement ? primary.measurement.toLowerCase() === verdict.claims.measurement : null;
  return { outcome: ours && theirs ? "agree" : !ours && !theirs ? "agree-refuse" : "disagree", oursVerified: ours, primaryOk: theirs, sameMeasurement };
}
