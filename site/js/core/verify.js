/* ============================================================
   Live in-browser enclave verification with THIS repository's
   own verifier (verifier/web, bundled to /vendor/enclave-verifier.js
   by scripts/build-vendor.mjs and served same-origin). Shared core
   for the Overview attest widget (<c-live-verify>) and the Deploy
   page's per-deployment badge.

   What runs in the browser (verifier/metal-box.mjs has the rules):
   the attached SEV-SNP box is challenged with a nonce THIS page
   draws (through the relay, which forwards it over the box's tunnel
   and hands back the box's own document); the report must be
   AMD-signed (VCEK -> the AMD root pinned in the bundle, collateral
   through the relay's KDS mirror: bytes only), meet the published TCB
   floor, refuse debug/migration, and bind the box's transport key
   together with OUR nonce. The launch measurement is compared with
   the relay operator's allowlist - which is the operator's word, so
   the best result here is "limited" with that reason, never a
   silent green. Nothing on this path is Tinfoil's.
   ============================================================ */
// Same-origin, version-pinned (sha256 in verifier/web/dist/MANIFEST.json). Deliberately not a CDN import: a third party
// that could serve this file could report anything it liked.
export const LV_VERIFIER_URL = "/vendor/enclave-verifier.js";
export const API_ORIGIN = "https://api.enclave.host";

// verification pointers: new shape (verification) with fallback to the pre-selfCheck field name (verify)
export const vspecOf = (att) => (att && (att.verification || att.verify)) || null;

// the box a deployment runs on, from its attestation pointer (https://api.enclave.host/t/<box>/...)
export const boxOfEndpoint = (ep) => { try { return (new URL(ep).pathname.match(/^\/t\/([A-Za-z0-9_-]{1,64})\//) || [])[1] || null; } catch (e) { return null; } };

// the checks the verdict reports (verifier/snp.mjs), in the order a reader follows the chain, with what each one means
export const CHECK_ORDER = ["report shape", "product line", "chain", "crl", "vcek identity", "signature", "tcb policy", "guest policy", "vmpl", "binding", "measurement"];
export const CHECK_LABELS = {
  "report shape": "well-formed AMD SEV-SNP attestation report",
  "product line": "product line named by the report and confirmed by its chain",
  "chain":        "VCEK → ASK → AMD root of trust (the ARK pinned in this page's verifier)",
  "crl":          "AMD revocation list checked (no revoked certificate in the chain)",
  "vcek identity":"the VCEK belongs to this chip at this TCB",
  "signature":    "the report is signed by that VCEK",
  "tcb policy":   "firmware TCB at or above the published floor",
  "guest policy": "guest policy forbids debug and migration",
  "vmpl":         "report produced at VMPL 0",
  "binding":      "report binds the box's transport key and this page's fresh nonce",
  "measurement":  "launch measurement is on the expected list",
};
export const OMISSION_LABELS = {
  "expected-measurement-operator-stated": "the expected measurement comes from the relay operator's own allowlist, not an independent reproduction",
  "tcb-floor-unjudged": "no TCB floor is published for this product line",
  "freshness-unbound": "no fresh nonce was bound",
};

// one run per box at a time; a finished result is reused for 60 s (every run draws a new nonce, so this only spares the box)
const _cache = new Map();   // name -> { at, promise }
export function verifyBoxInBrowser(name, { apiOrigin = API_ORIGIN } = {}) {
  const hit = _cache.get(name);
  if (hit && (Date.now() - hit.at < 60_000 || !hit.done)) return hit.promise;
  const entry = { at: Date.now(), done: false };
  entry.promise = (async () => {
    const mod = await import(LV_VERIFIER_URL);
    if (typeof mod.verifyMetalBoxWeb !== "function") throw new Error("the verifier bundle on this page has no verifyMetalBoxWeb");
    return mod.verifyMetalBoxWeb({ apiBase: apiOrigin, name });
  })().finally(() => { entry.done = true; entry.at = Date.now(); });
  entry.promise.catch(() => _cache.delete(name));
  _cache.set(name, entry);
  return entry.promise;
}

// the attested SEV-SNP boxes the relay holds right now (the boxes tenant apps run on)
export async function snpBoxes({ apiOrigin = API_ORIGIN } = {}) {
  const r = await fetch(apiOrigin + "/enclaves", { credentials: "omit" });
  if (!r.ok) throw new Error("GET /enclaves -> " + r.status);
  return ((await r.json()).enclaves || []).filter((e) => e.mode === "snp" && e.name).map((e) => e.name);
}

// a one-line summary of a verdict for a badge: { cls: ok|warn|bad, text, title }
export function verdictBadge(r) {
  if (!r) return { cls: "bad", text: "✗ not verified", title: "" };
  if (r.status === "verified") return { cls: "ok", text: "✓ verified in your browser", title: "AMD SEV-SNP report verified here: chain to AMD's root, TCB floor, fresh nonce binding, and an expected measurement." };
  if (r.status === "limited") return { cls: "warn", text: "◐ genuine and fresh (measurement: operator-stated)",
    title: "Verified in your browser: a genuine AMD SEV-SNP report, fresh for this page's nonce. Not judged independently: "
      + (r.omissions || []).map((o) => OMISSION_LABELS[o] || o).join("; ") + "." };
  const last = (r.reasons || []).at(-1) || r.status;
  return { cls: "bad", text: "✗ not verified: " + String(last).replace(/^(REJECT|UNSUPPORTED|OMITTED)[^:]*:\s*/, ""), title: (r.reasons || []).join("\n") };
}
