/* ============================================================
   Opt-in SHADOW verification: the Enclave-owned verifier
   (verifier/web, shipped same-origin as /vendor/enclave-verifier.js)
   run beside the primary verdict of site/js/core/verify.js, and
   RECORDED. It decides nothing:
     • the primary verdict (the @tinfoilsh/verifier document) is
       untouched, and every consumer keeps reading r.ok / r.doc;
     • the record carries acceptance:false and states that the
       transport binding is not claimed (a page cannot read its own
       TLS peer certificate; the served certificate comes from the
       enclave's well-known endpoint);
     • the trust roots are the verifier's own AMD ARK pins, and no
       primary root or pin is changed by this file.
   OFF unless a viewer opts in: ?verifier-shadow=1 on the URL, or
   localStorage "enclave.verifierShadow" = "1". Rollback is a revert
   of this file's caller; nothing else depends on it.
   Fetches: the enclave's two well-known paths (same host as the
   primary already reads, CORS-allowed for this origin) and AMD's
   collateral from Tinfoil's KDS proxy (CORS-allowed). The source is
   never a trust input: the pinned ARK and the VCEK's own extensions
   decide, and the record names every source.
   ============================================================ */
export const SHADOW_FLAG = "enclave.verifierShadow";
export const SHADOW_QUERY = "verifier-shadow";
export const SHADOW_VERIFIER_URL = "/vendor/enclave-verifier.js";
export const SHADOW_COLLATERAL_BASE = "https://kds-proxy.tinfoil.sh";
// Diagnostic TCB floors: the hosted fleet's measured level on 2026-09-24 (test/fixtures/verifier/genoa-tinfoil, AMD KDS
// query blSPL=10 teeSPL=0 snpSPL=23 ucodeSPL=84). A product without a floor verifies as "limited", never "verified"; a host
// below the floor is rejected in the record. This is a shadow policy, not an admission policy.
export const SHADOW_MIN_TCB = Object.freeze({ Genoa: Object.freeze({ bootloader: 10, tee: 0, snp: 23, microcode: 84 }) });

export function shadowEnabled({ search = globalThis.location && globalThis.location.search, storage = globalThis.localStorage } = {}) {
  try { if (new URLSearchParams(search || "").get(SHADOW_QUERY) === "1") return true; } catch (e) {}
  try { return !!storage && storage.getItem(SHADOW_FLAG) === "1"; } catch (e) { return false; }
}

// runShadow({ host, doc }) -> the record, or null when not opted in. Never throws; never touches `doc` or the primary result.
//   doc: the primary's verification document (codeMeasurement = the release's measurement from its Sigstore step, which is
//        provenance, not the enclave's claim; enclaveMeasurement = what the enclave reported; securityVerified = its verdict)
export async function runShadow({ host, doc, importer = (u) => import(u), enabled = shadowEnabled(), now = () => new Date(), fetchImpl = undefined, log = globalThis.console } = {}) {
  if (!enabled) return null;
  try {
    if (typeof host !== "string" || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("no host");
    const mod = await importer(SHADOW_VERIFIER_URL);
    const codeMeasurement = doc && doc.codeMeasurement && Array.isArray(doc.codeMeasurement.registers) ? doc.codeMeasurement.registers[0] : null;
    const enclaveMeasurement = doc && doc.enclaveMeasurement && doc.enclaveMeasurement.measurement && Array.isArray(doc.enclaveMeasurement.measurement.registers) ? doc.enclaveMeasurement.measurement.registers[0] : undefined;
    const shadow = mod.createShadow({ enabled: true, origin: `https://${host}`, collateralBase: SHADOW_COLLATERAL_BASE, now, ...(fetchImpl ? { fetchImpl } : {}) });
    const record = await shadow.run({ host, expected: { allowedMeasurements: codeMeasurement ? [codeMeasurement] : [], minTcb: SHADOW_MIN_TCB }, primary: { ok: !!(doc && doc.securityVerified === true), ...(enclaveMeasurement ? { measurement: enclaveMeasurement } : {}) } });
    record.expectedFrom = codeMeasurement ? "the primary's Sigstore step (codeMeasurement): release provenance, not the enclave's claim" : "none: the primary produced no code measurement, so no measurement is allowed";
    if (log && log.info) log.info("[verifier-shadow]", record.verdict ? record.verdict.status : "not run", record.comparison ? record.comparison.outcome : "", record);
    return record;
  } catch (e) {
    if (log && log.warn) log.warn("[verifier-shadow] did not run:", e && e.message ? e.message : e);
    return { shadow: true, acceptance: false, transportBindingClaimed: false, enabled: true, ran: false, reasonNotRun: `error: ${e && e.message ? e.message : e}` };
  }
}
