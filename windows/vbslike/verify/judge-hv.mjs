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
// The runtime half of the verdict is the Linux judge's own checkRuntime (isolation/m2/judge.mjs), which
// validates the stated identity through the contract mirror, judges the self-test (closed scope
// vocabulary) and computes the ABI/2 binding. One implementation for both verifiers: a Windows judge and
// a Linux judge that disagreed about what a clean scan means is the failure neither lab would catch.
import { checkRuntime } from "../../../isolation/m2/judge.mjs";
import { bootFormOfStatement, isStatedPartition } from "./boot-statements.mjs";

// THE RUNTIME'S W^X, PER GUEST IMAGE (enclave-87's ruling for v43, no flag day). From v43 the in-guest monitor scans the
// domain's cgroup at EACH attestation and names what it covered by role ("exec_pages=allowed wx=clean maps=3 runtime=1
// front=1 init=1 scope=cgroup:/dom1"); an image before that (v42) states one scan made at front start, before the
// runtime existed ("... wx=clean maps=2 scope=cgroup:/dom1"), which covers NO runtime. This judge requires the
// attest-time form - runtime >= 1, the role counts adding up to maps - for every image this table does not list, and
// accepts the legacy form only for a listed image, as "runtime W^X UNMEASURED", never clean. The image is the CALLER's
// (expectedImageSha256: the launcher's own record of what it put in the partition, from the manager's view), never the
// document's; no image named means no legacy. An entry goes when its image is retired from service.
//
// Who relies on it, and so enforces it through the verdict: the manager's readiness (manager/ready.mjs, server.mjs: a
// partition whose runtime W^X is not clean, or - on an image the table does not list - not covered, never becomes ready,
// so never serves; a listed image's legacy form is admitted, reported unmeasured), the node's certificate
// pass (windows/node/hvcert.mjs: no certificate for it), and the lab tools (verify/lab.mjs, isolation/m3/hvlab-*.mjs).
// The shared checkRuntime (isolation/m2/judge.mjs) judges wx=clean, maps and the scope; this adds the coverage, and
// passes the legacy label to it, so the same verdict comes from main's judge and from the per-release one.
export const LEGACY_WX_IMAGES = Object.freeze({
  "0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998": "v42 guest IGVM 0891c740 (digest A39E2F8C, guest 298924ae)",
});
// THE RUNTIME'S SECCOMP FILTER, PER IMAGE (enclave-87: positive evidence). From the guest after v43, domexec states the
// runtime's filter once installed (m2/app-seccomp.h: sha256 of the exact BPF program) on the monitor's fd 4, the monitor
// checks at each attestation that every runtime process is under a filter (Seccomp: 2) and carries seccomp=<hash>. An
// image built before that states none, and is accepted without it only when the caller's image is listed here - said,
// not counted as attested. Same rules as LEGACY_WX_IMAGES: the caller's image, never the document's; an entry goes
// at its image's retirement.
export const SECCOMP_UNSTATED_IMAGES = Object.freeze({
  ...LEGACY_WX_IMAGES,
  "4950052785daf26d9c712a710f118211c853a04e03c01b8d77d8ac44a50327ab": "v43 guest IGVM 49500527 (digest 61C61AD4): W^X at each attestation, no seccomp statement",
});
const WX_ROLES = ["runtime", "front", "init", "root", "other"];

/** wxCoverage(selfTest, legacy, seccompUnstated) -> { ok, coverage: "runtime-covered" | "runtime-unmeasured", why }. */
export function wxCoverage(selfTest, legacy, seccompUnstated = null) {
  if (typeof selfTest !== "string" || !selfTest) return { ok: false, why: "the document states no runtime self-test" };
  const f = Object.create(null);
  for (const part of selfTest.trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i <= 0 || Object.hasOwn(f, part.slice(0, i))) return { ok: false, why: `malformed runtime self-test ${JSON.stringify(selfTest)}` };
    f[part.slice(0, i)] = part.slice(i + 1);
  }
  const roles = WX_ROLES.filter((r) => Object.hasOwn(f, r));
  if (f.wx !== "clean") return { ok: false, why: `the runtime self-test says wx=${JSON.stringify(f.wx ?? null)}` };
  if (!roles.length && legacy) return { ok: true, coverage: "runtime-unmeasured",
    why: `the LEGACY runtime self-test, accepted only for ${legacy}: one scan at front start, before the runtime existed - runtime W^X UNMEASURED, not clean` };
  if (!Object.hasOwn(f, "runtime")) return { ok: false, why: `the runtime self-test names no runtime coverage (runtime=<n>): a scan made before the runtime ran${legacy ? "" : " (the legacy form is accepted only for a listed image)"}` };
  const counts = roles.map((r) => f[r]);
  if (!counts.every((n) => /^\d+$/.test(n))) return { ok: false, why: `the runtime self-test's role counts are not counts: ${JSON.stringify(selfTest)}` };
  if (counts.reduce((a, n) => a + Number(n), 0) !== Number(f.maps)) return { ok: false, why: `the runtime self-test's roles do not add up to maps=${f.maps}` };
  if (Number(f.runtime) < 1) return { ok: false, why: `the runtime self-test covered NO runtime process (runtime=${f.runtime})` };
  // the runtime's seccomp filter (SECCOMP_UNSTATED_IMAGES)
  let sc;
  if (Object.hasOwn(f, "seccomp")) {
    if (!/^[0-9a-f]{64}$/.test(f.seccomp)) return { ok: false, why: `the runtime self-test's seccomp=${JSON.stringify(f.seccomp)} is not a 64-hex filter hash` };
    sc = `; every runtime process under the seccomp filter with program sha256 ${f.seccomp.slice(0, 16)}…`;
  } else if (seccompUnstated) {
    sc = `; no seccomp statement, accepted only for ${seccompUnstated}: the runtime's filter is NOT positively attested`;
  } else {
    return { ok: false, why: "the runtime self-test states no seccomp filter (seccomp=<hash>): an image after v43 must (the image is not listed as predating it)" };
  }
  return { ok: true, coverage: "runtime-covered", why: `W^X measured at attestation over ${f.maps} processes (${roles.map((r) => `${r}=${f[r]}`).join(" ")})${sc}` };
}

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

/**
 * judge({ doc, spki, nonce, expectedAppSha256, launcherKey, expectedVmId?, expectedImageSha256?, expectedStatement?, expectAbi?, expectRuntime? })
 *   doc:   the attestation document the domain returned (the m2 front's shape)
 *   spki:  the SPKI DER the caller's OWN TLS handshake saw (never doc.transportKey)
 *   nonce: the 32 bytes the caller chose
 *   expectRuntime: the exact runtime identity the domain must state (ABI/2); given, a document that states
 *                  ABI/1 or another identity is rejected, never downgraded. Absent, ABI/1 is judged as before.
 * expectedStatement: { partition, guestImageKind }, the record's launcher statement (boot-statements.mjs). Given, the
 *                  pair must be a row of the fixed table AND the report's platform.partition must equal its
 *                  partition, and only then is the image compared. A report naming a WMI partition has its image
 *                  compared ONLY with a statement: the same 64 hex under the other partition or kind is another
 *                  claim (enclave-d1 + enclave-99, main ae6e9147). A statement, not identity either way.
 */
export function judge({ doc, spki, nonce, expectedAppSha256, launcherKey, expectedVmId, expectedImageSha256, expectedStatement, expectRuntime }) {
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
  // document naming another runtime, version, execution mode, ISA or feature policy does not verify.
  // checkRuntime (shared) decides the ABI, the identity, the self-test and the binding; null means ABI/1.
  const legacy = expectedImageSha256 && Object.hasOwn(LEGACY_WX_IMAGES, String(expectedImageSha256).toLowerCase())
    ? LEGACY_WX_IMAGES[String(expectedImageSha256).toLowerCase()] : null;
  const seccompUnstated = expectedImageSha256 && Object.hasOwn(SECCOMP_UNSTATED_IMAGES, String(expectedImageSha256).toLowerCase())
    ? SECCOMP_UNSTATED_IMAGES[String(expectedImageSha256).toLowerCase()] : null;
  const rt = checkRuntime(doc, spki, nonce, { ...(expectRuntime !== undefined ? { runtime: expectRuntime } : {}), legacyWx: legacy, seccompUnstated });
  c("ABI, runtime identity and self-test admissible (shared checkRuntime)", rt.ok, rt.reasons.filter((r) => r.startsWith("REJECT")).join("; "));
  // the runtime's W^X, per image (above), for every ABI/2 document - and for an ABI/1 one on any image the table does NOT
  // list, which states no runtime and no self-test and so is REFUSED, whether or not the caller pins the runtime (enclave-5d,
  // enclave-87: a manager started without ENCLAVE_RUNTIME_IDENTITY would otherwise admit a v43 partition stating no W^X).
  // A listed image keeps today's ABI handling (the caller's expectRuntime decides ABI/1).
  const wx = doc.runtime !== undefined || !legacy ? wxCoverage(doc.runtimeSelfTest, legacy, seccompUnstated) : null;
  if (wx) c("the runtime's W^X measured at attestation (or a listed image's legacy form, as unmeasured)", wx.ok, wx.why);
  const bind = rt.ok ? (rt.binding ?? sha256(spki, nonce)) : null;
  c("report_data[0:32] == the binding recomputed from the handshake key, our nonce and the stated runtime", bind !== null && rd.length === 64 && eq(rd.subarray(0, 32), bind), "binding does not match the handshake");
  const expApp = Buffer.from(expectedAppSha256, "hex");
  c("report_data[32:64] == expected app", rd.length === 64 && eq(rd.subarray(32, 64), expApp), "the report names a different app");
  c("domain.appSha256 == report_data[32:64]", rd.length === 64 && d.domain && d.domain.appSha256 === rd.subarray(32, 64).toString("hex"));
  c("document appSha256 agrees", doc.appSha256 === expectedAppSha256, "the domain's own claim differs from the expected app (informational field)");
  if (expectedVmId) c("partition.vmId == expected partition", d.partition && d.partition.vmId === expectedVmId, "report names another partition");
  // THE PAIR BEFORE THE IMAGE, never the image alone for a WMI partition
  const statedPartition = d.platform && d.platform.partition;
  if (expectedStatement) {
    c("the expected (partition, guestImageKind) is a row of the fixed table",
      bootFormOfStatement(expectedStatement.partition, expectedStatement.guestImageKind) !== null,
      `the record states ${JSON.stringify(expectedStatement)}, which is no known pair`);
    c("platform.partition == the expected statement's partition", statedPartition === expectedStatement.partition,
      `the report states partition ${JSON.stringify(statedPartition ?? null)}, not ${JSON.stringify(expectedStatement.partition)}`);
    c("an image is compared with the statement", !!expectedImageSha256, "a statement with no image to compare names nothing");
  } else if (expectedImageSha256 && isStatedPartition(statedPartition)) {
    c("a WMI partition's image is compared only with its statement", false,
      `the report names partition ${statedPartition}, and its image is never compared alone`);
  }
  if (expectedImageSha256) c("partition.guestImageSha256 == the image we shipped", d.partition && d.partition.guestImageSha256 === expectedImageSha256, "another guest image");
  c("launcher key is the trusted one", d.launcher && d.launcher.key === launcherKey, "report carries a different launcher key");
  c("platform states host_excluded=false", d.platform && d.platform.hostExcluded === false, "a T0-hv report must not claim host exclusion");
  c("boundary tuple says t0-hv and host_excluded=no", typeof d.boundary === "string" && d.boundary.includes("tier=T0-hv") && d.boundary.includes("host_excluded=no"), d.boundary);
  const sigOk = c("launcher signature verifies", verifyLauncherSignature(launcherKey, rep), "signature does not verify");
  checks.abi = doc.abi ?? "enclave-domain-abi/1";
  checks.runtimeReasons = rt.reasons;
  const structural = Object.entries(checks).every(([k, v]) => k === "abi" || k === "runtimeReasons" || v || k === "launcher signature verifies");
  const verdict = structural && sigOk ? "monitor-signed" : structural ? "unsigned" : "reject";
  return { verdict, reasons, checks, ...(wx && wx.ok ? { wxCoverage: wx.coverage, wxWhy: wx.why } : {}) };
}
