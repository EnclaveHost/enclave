// judge-hv.mjs: the verdict on an app domain's attestation document when the domain is a Hyper-V child
// partition under windows/vbslike (tier T0-hv). PORTABLE and separate from the launcher. It is the T0
// branch of isolation/m2/judge.mjs with one more thing checked: the launcher's signature over the
// document, and the launcher's own record of what it put in the partition.
//
// The 64 bytes judged are the contract's (isolation/contract/report.go): [0:32] = sha256(SPKI || nonce)
// computed in the domain, [32:64] = the app ID the in-guest monitor loaded. The launcher's document
// carries them as `reportData`; the same rule that reads an SNP report's report_data reads this.
//
//   monitor-signed  signed by the launcher key the caller trusts; binds the key the caller's OWN
//                   handshake saw with the caller's OWN nonce; names the expected app and partition.
//                   Nothing about the host: this tier has no hardware root, and whoever controls the
//                   launcher controls the verdict. As strong as m2's `not-attested` T0 verdict plus a
//                   pinned software identity, and no stronger.
//   unsigned        the field checks pass but the signature does not verify with the trusted key
//   reject          anything else
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
// the contract's JavaScript mirror (driven by isolation/contract/vectors.json): the ABI/2 binding folds
// the runtime identity the domain states into report_data[0:32]
import { ABI1, ABI2, EXEC_JIT, bind2, runtimeId, validateRuntimeIdentity } from "../../../isolation/contract/runtime.mjs";

export const FORMAT = "hyperv-partition-domain/v1";
export const TIER = "T0-hv";
export const SIGN_DOMAIN = Buffer.from("vbslike-report-v1\n");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const sha256 = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const eq = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);

// Canonical JSON: compact, keys sorted at every level (isolation/contract Canonical; report.rs canonical()).
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

export function verifyLauncherSignature(keyB64, signed) {
  try {
    const raw = Buffer.from(keyB64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(signed.doc))]), key, Buffer.from(signed.sig, "base64"));
  } catch { return false; }
}

// The front's document carries the signed report base64-encoded in `report` (the same field that holds
// the PSP's bytes on SNP). Decode it here; a document without one is judged on what it says.
export function signedReportOf(doc) {
  try { return JSON.parse(Buffer.from(doc.report, "base64").toString("utf8")); } catch { return null; }
}

// The front's runtime self-test line, "exec_pages=allowed wx=clean maps=7 scope=cgroup:/dom1": what the
// domain checked about itself before stating its identity (isolation/m2/front/runtime.go; the reference
// check is isolation/m2/judge.mjs checkRuntimeSelfTest). A JIT identity needs exec_pages=allowed; every
// identity needs wx=clean over at least one mapping.
export function checkRuntimeSelfTest(selfTest, identity) {
  if (typeof selfTest !== "string" || !selfTest) return "no runtime self-test in the document";
  const kv = Object.fromEntries(selfTest.split(/\s+/).map((t) => { const i = t.indexOf("="); return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + 1)]; }));
  if (identity.execution === EXEC_JIT && kv.exec_pages !== "allowed") return `execution=jit but exec_pages=${kv.exec_pages}: no JIT can run where no executable page is obtainable`;
  if (kv.wx !== "clean") return `wx=${kv.wx}: a writable and executable mapping was found`;
  if (!(Number(kv.maps) >= 1)) return `maps=${kv.maps}: the W^X scan covered no mapping`;
  if (!kv.scope) return "the self-test names no scope";
  return null;
}

/**
 * judge({ doc, spki, nonce, expectedAppSha256, launcherKey, expectedVmId?, expectedImageSha256?, expectAbi?, expectRuntime? })
 *   doc:   the attestation document the domain returned (the m2 front's shape)
 *   spki:  the SPKI DER the caller's OWN TLS handshake saw (never doc.transportKey)
 *   nonce: the 32 bytes the caller chose
 *   expectAbi: ABI1 (default) or ABI2; a document stating another ABI is rejected, never downgraded
 *   expectRuntime: fields the stated runtime identity must have (e.g. { execution: "jit", cache: "none" })
 */
export function judge({ doc, spki, nonce, expectedAppSha256, launcherKey, expectedVmId, expectedImageSha256, expectAbi = ABI1, expectRuntime }) {
  const checks = {}, reasons = [];
  const c = (name, ok, why) => { checks[name] = !!ok; if (!ok) reasons.push(why || name); return !!ok; };
  if (!doc || typeof doc !== "object") return { verdict: "reject", reasons: ["no document"], checks };
  c("format", doc.format === FORMAT, `format ${doc.format}`);
  c("tier", doc.tier === TIER, `tier ${doc.tier}`);
  c("nonce echoed", doc.nonce === Buffer.from(nonce).toString("hex"), "document nonce is not ours");
  const rep = signedReportOf(doc);
  if (!c("report present", rep && rep.doc && rep.sig, doc.reason || "no signed report")) return { verdict: "reject", reasons, checks };
  const d = rep.doc;
  c("report format", d.format === FORMAT && d.tier === TIER, "report format/tier");
  const rd = Buffer.from(String(d.reportData || ""), "hex");
  c("report_data is 64 bytes", rd.length === 64);
  // the binding: ABI/1 is key || nonce; ABI/2 folds in the runtime identity the document states, so a
  // document naming another runtime, version, execution mode, ISA or feature policy does not verify
  const abi = doc.abi ?? ABI1;
  c(`document states the expected ABI (${expectAbi})`, abi === expectAbi, `document states ${abi}`);
  let bind = null;
  if (abi === ABI2) {
    const why = validateRuntimeIdentity(doc.runtime);
    c("runtime identity is admissible", why === null, why || "");
    if (why === null) {
      bind = bind2(spki, nonce, runtimeId(doc.runtime));
      const st = checkRuntimeSelfTest(doc.runtimeSelfTest, doc.runtime);
      c("runtime self-test coherent with the identity", st === null, st || "");
      for (const [k, v] of Object.entries(expectRuntime || {})) c(`runtime.${k} == ${v}`, doc.runtime[k] === v, `runtime.${k} is ${doc.runtime[k]}`);
    }
  } else if (abi === ABI1) {
    bind = sha256(spki, nonce);
  }
  c("report_data[0:32] == the binding recomputed from the handshake key, our nonce and the stated runtime", bind !== null && rd.length === 64 && eq(rd.subarray(0, 32), bind), "binding does not match the handshake");
  const expApp = Buffer.from(expectedAppSha256, "hex");
  c("report_data[32:64] == expected app", rd.length === 64 && eq(rd.subarray(32, 64), expApp), "the report names a different app");
  c("domain.appSha256 == report_data[32:64]", rd.length === 64 && d.domain && d.domain.appSha256 === rd.subarray(32, 64).toString("hex"));
  c("document appSha256 agrees", doc.appSha256 === expectedAppSha256, "the domain's own claim differs from the expected app (informational field)");
  if (expectedVmId) c("partition.vmId == expected partition", d.partition && d.partition.vmId === expectedVmId, "report names another partition");
  if (expectedImageSha256) c("partition.guestImageSha256 == the image we shipped", d.partition && d.partition.guestImageSha256 === expectedImageSha256, "another guest image");
  c("launcher key is the trusted one", d.launcher && d.launcher.key === launcherKey, "report carries a different launcher key");
  c("platform states host_excluded=false", d.platform && d.platform.hostExcluded === false, "a T0-hv report must not claim host exclusion");
  c("boundary tuple says t0-hv and host_excluded=no", typeof d.boundary === "string" && d.boundary.includes("tier=T0-hv") && d.boundary.includes("host_excluded=no"), d.boundary);
  const sigOk = c("launcher signature verifies", verifyLauncherSignature(launcherKey, rep), "signature does not verify");
  checks.abi = abi;
  const structural = Object.entries(checks).every(([k, v]) => k === "abi" || v || k === "launcher signature verifies");
  const verdict = structural && sigOk ? "monitor-signed" : structural ? "unsigned" : "reject";
  return { verdict, reasons, checks };
}
