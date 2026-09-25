// relay/reverify.mjs: re-verification of DIALED fleet rows with the repository's own verifier
// (docs/security/independent-verifier-plan.md, section 9 stage 6). Today a dialed row is eligible on its own word:
// availability.teeCpu, read by the measured image from its RAD, which the relay never checks. This module checks it:
// one capture of the row's attestation document over the relay's OWN TLS connection to the row's endpoint, the expected
// measurements from the release's verified provenance (the pinned Sigstore root inside the vendored bundle), AMD's chain
// and CRL from KDS through the authenticated disk cache, and the verdict of verifier/snp.mjs. The Tinfoil reference is not
// run here (the relay does not carry it; the bundle reports installed:false and nothing pretends otherwise).
//
// Modes (RELAY_REVERIFY):
//   shadow (default): rows are annotated with `reverify` (status, matched release, measurement, failed checks, omissions,
//                     when); eligibility is UNCHANGED; a row whose verdict is not `verified` is logged. Data for the
//                     cutover decision, nothing else.
//   enforce:          a dialed row is eligible only when its last re-verification is `verified` (stage 7 for this consumer);
//                     tunnel rows are untouched (their evidence is the attach gate's).
//   off:              the fallback: nothing runs, rows carry no `reverify`, eligibility is exactly as before.
// One row at a time, on a timer, never inside the availability poll: KDS rate-limits, and a slow enclave must not delay the
// fleet view. Every failure is a status on the row; nothing throws out of run().
import fs from "node:fs";

export const MODES = Object.freeze(["off", "shadow", "enforce"]);
export const modeOf = (raw) => (MODES.includes(String(raw || "")) ? String(raw) : "shadow");
const brief = (r) => ({ status: r.status, at: r.at, release: r.matched ?? null, measurement: r.measurement ?? null, failedChecks: r.failedChecks ?? [], omissions: r.omissions ?? [],
                        expected: r.expected ?? [], reasons: (r.reasons ?? []).slice(-3) });

// bundle: the vendored verifier module (relay/vendor/enclave-verifier-node.mjs), or anything with the same exports (tests).
// verify: an override for verifyHost (tests); expectationsFor: an override for releaseExpectations (tests, offline).
// indexMemoryFile: where the highest verified signed release index is remembered (verifier/index-memory.mjs), so a
// replayed or equivocating index is refused and the fallback never accepts below the remembered floor; requireIndex:
// RELAY_REQUIRE_INDEX=1, the strict switch (no verified, fresh index = no expected measurement = nothing verifies).
export function createReverifier({ mode = "shadow", bundle = null, repo = "EnclaveHost/enclave", minTcb = undefined, cacheDir = null, expectationsTtlMs = 60 * 60 * 1000,
                                   timeoutMs = 20000, releaseIndex = null, verify = null, expectationsFor = null, indexMemoryFile = null, requireIndex = false, log = () => {}, now = () => new Date() } = {}) {
  mode = modeOf(mode);
  const byEndpoint = new Map();          // endpoint -> brief verdict
  let expectations = null, expectationsAt = 0, loading = null, collateral = null, running = false, indexMemory = null;
  const stats = { runs: 0, rows: 0, verified: 0, other: 0, lastRunAt: null, lastError: null };

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      if (!bundle) { try { bundle = await import("./vendor/enclave-verifier-node.mjs"); } catch (e) { throw new Error(`the vendored verifier is missing: ${e.message}`); } }
      if (!indexMemory && indexMemoryFile && typeof bundle.createIndexMemory === "function") indexMemory = bundle.createIndexMemory({ file: indexMemoryFile, log });
      if (!collateral) {
        if (cacheDir) { try { fs.mkdirSync(cacheDir, { recursive: true }); collateral = bundle.cachedCollateral({ dir: cacheDir, upstream: bundle.httpCollateral({ timeoutMs: 8000 }) }); } catch (e) { log(`collateral cache unusable (${e.message}); KDS without a cache`); collateral = bundle.httpCollateral({ timeoutMs: 8000 }); } }
        else collateral = bundle.httpCollateral({ timeoutMs: 8000 });
      }
      return bundle;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function refreshExpectations() {
    const t = now().getTime();
    if (expectations && expectations.ok && t - expectationsAt < expectationsTtlMs) return expectations;
    const B = await load();
    const e = expectationsFor ? await expectationsFor({ indexMemory, requireIndex }) : await B.releaseExpectations({ repo, timeoutMs, indexMemory, requireIndex, ...(releaseIndex ? { apiBase: releaseIndex.apiBase, downloadBase: releaseIndex.downloadBase ?? releaseIndex.apiBase } : {}) });
    if (e.ok || !expectations) { expectations = e; expectationsAt = t; }    // a failed refresh keeps the last good set, and says so on the row
    else log(`release provenance refresh failed (${e.indexError || e.reasons.at(-1)}); keeping the set from ${new Date(expectationsAt).toISOString()}`);
    return expectations;
  }
  const isDialed = (e) => !!e && !e.tunnel && !e.relay && typeof e.endpoint === "string" && /^https:\/\//.test(e.endpoint);

  // Re-verify each dialed row, one after another. Returns the briefs it wrote (by endpoint).
  async function run(rows) {
    if (mode === "off" || running) return new Map();
    running = true; stats.runs++; stats.lastRunAt = now().toISOString();
    const done = new Map();
    try {
      const targets = (rows || []).filter(isDialed);
      if (!targets.length) return done;
      let B, exp;
      try { B = await load(); exp = await refreshExpectations(); }
      catch (e) { stats.lastError = e.message; log(`re-verification cannot run: ${e.message}`); for (const r of targets) { const b = { status: "unavailable", at: now().toISOString(), release: null, measurement: null, failedChecks: [], omissions: [], expected: [], reasons: [e.message] }; byEndpoint.set(r.endpoint, b); done.set(r.endpoint, b); } return done; }
      for (const row of targets) {
        const u = new URL(row.endpoint); const host = u.hostname, port = u.port ? Number(u.port) : 443;
        let b;
        try {
          const r = verify ? await verify({ host, port, expectations: exp, minTcb, collateral, timeoutMs }) : await B.verifyHost({ host, port, repo, expectations: exp, reference: false, minTcb, collateral, timeoutMs });
          b = brief(r.enclave ?? r);
        } catch (e) { b = { status: "unavailable", at: now().toISOString(), release: null, measurement: null, failedChecks: [], omissions: [], expected: exp.allowed.map((a) => a.tag), reasons: [`verifier: ${e.message}`] }; }
        if (!exp.ok) b.reasons = [...b.reasons, "no release's provenance verified: there is no expected measurement"];
        byEndpoint.set(row.endpoint, b); done.set(row.endpoint, b); stats.rows++;
        if (b.status === "verified") stats.verified++; else { stats.other++; log(`${host}: ${b.status}${b.failedChecks.length ? ` (${b.failedChecks.join(", ")})` : ""}${b.omissions.length ? ` omitted ${b.omissions.join(", ")}` : ""}: ${b.reasons.at(-1) || ""}`); }
      }
      for (const k of [...byEndpoint.keys()]) if (!targets.some((r) => r.endpoint === k)) byEndpoint.delete(k);   // rows that left the registry
      return done;
    } finally { running = false; }
  }
  // The row as the fleet view and the eligibility rule see it.
  const annotate = (row) => (mode === "off" || !isDialed(row) ? row : { ...row, reverify: byEndpoint.get(row.endpoint) ?? { status: "pending", at: null, release: null, measurement: null, failedChecks: [], omissions: [], expected: [], reasons: ["not re-verified yet"] } });
  // enforce: a dialed row must have verified; shadow/off: the base rule alone. Tunnel rows are never touched here.
  const eligible = (row, base) => (mode !== "enforce" || !isDialed(row) ? base : base && byEndpoint.get(row.endpoint)?.status === "verified");
  const ineligibleReason = (row) => (mode === "enforce" && isDialed(row) && byEndpoint.get(row.endpoint)?.status !== "verified"
    ? `its attestation did not re-verify here (${byEndpoint.get(row.endpoint)?.status ?? "pending"}${byEndpoint.get(row.endpoint)?.failedChecks?.length ? `: ${byEndpoint.get(row.endpoint).failedChecks.join(", ")}` : ""})` : null);
  return { mode, run, annotate, eligible, ineligibleReason, verdictOf: (endpoint) => byEndpoint.get(endpoint) ?? null,
           stats: () => ({ ...stats, requireIndex, expectationsAt: expectationsAt ? new Date(expectationsAt).toISOString() : null,
                           expectations: expectations ? { ok: expectations.ok, latestTag: expectations.latestTag ?? null, allowed: expectations.allowed.map((a) => a.tag), index: expectations.index ?? null, ...(expectations.indexError ? { indexError: expectations.indexError } : {}) } : null,
                           indexMemory: indexMemory ? { file: indexMemory.file, remembered: indexMemory.record() } : null }) };
}
