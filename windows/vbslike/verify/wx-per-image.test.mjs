// The runtime's W^X, per guest image (judge-hv LEGACY_WX_IMAGES; enclave-87's ruling for v43): an image the table does
// not list must state the attest-time scan (runtime >= 1, the roles adding up to maps); v42's image may state the legacy
// start-time form, accepted only as "runtime W^X UNMEASURED". The image is the caller's (the launcher's record), never
// the document's. Against real launcher-signed ABI/2 reports, judged by the real judge-hv.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, canonical, SIGN_DOMAIN, LEGACY_WX_IMAGES, wxCoverage } from "./judge-hv.mjs";
import { ABI2, bind2, runtimeId } from "../../../isolation/contract/runtime.mjs";

const CONTRACT_RS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../host/src/contract.rs"), "utf8");
const FORMAT = CONTRACT_RS.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1];
const TIER = CONTRACT_RS.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1];
const V42 = "0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998";   // listed: the legacy form, as unmeasured
const V43 = "49".repeat(32);                                                       // any image the table does not list
const APP = "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782";
const JIT = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const launcherKey = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
const spki = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
const ATTEST_TIME = "exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1";
const LEGACY = "exec_pages=allowed wx=clean maps=2 scope=cgroup:/dom1";

// an ABI/2 document as the m2 front returns it on the NucBox: the launcher-signed report binds the runtime's identity
function judged(selfTest, { image, expectedImageSha256 = image } = {}) {
  const nonce = crypto.randomBytes(32);
  const binding = bind2(spki, nonce, runtimeId(JIT));
  const report = { format: FORMAT, tier: TIER, reportData: Buffer.concat([binding, Buffer.from(APP, "hex")]).toString("hex"),
    domain: { appSha256: APP }, partition: { vmId: "3f1c0f6e-0000-4000-8000-000000000001", guestImageSha256: image },
    launcher: { key: launcherKey }, platform: { hostExcluded: false },
    boundary: "tier=T0-hv partition=hyperv-vm host_excluded=no" };
  const sig = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), privateKey).toString("base64");
  const doc = { format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP, abi: ABI2, runtime: JIT, runtimeSelfTest: selfTest,
                report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") };
  return judge({ doc, spki, nonce, expectedAppSha256: APP, launcherKey, expectedImageSha256, expectRuntime: JIT });
}

test("an image the table does not list (v43 and later) must state the attest-time scan", () => {
  const ok = judged(ATTEST_TIME, { image: V43 });
  assert.equal(ok.verdict, "monitor-signed", ok.reasons.join("; "));
  assert.equal(ok.wxCoverage, "runtime-covered");
  for (const [st, why] of [[LEGACY, /names no runtime coverage/],                                   // enclave-87's mutant: legacy for v43
    ["exec_pages=allowed wx=clean maps=2 runtime=0 front=2 scope=cgroup:/dom1", /covered NO runtime process|covered NO runtime/],
    ["exec_pages=allowed wx=clean maps=4 runtime=1 front=1 scope=cgroup:/dom1", /do not add up|add up/],
    ["exec_pages=allowed wx=found maps=2 runtime=1 front=1 scope=cgroup:/dom1", /wx=/],
    [undefined, /no runtime self-test|self-test/]]) {
    const v = judged(st, { image: V43 });
    assert.equal(v.verdict, "reject", `${st} was accepted for an unlisted image`);
    assert.match(v.reasons.join("; "), why);
  }
});

test("v42's image may state the legacy form, and it is judged UNMEASURED, never clean; its attest-time form is judged in full", () => {
  const v = judged(LEGACY, { image: V42 });
  assert.equal(v.verdict, "monitor-signed", v.reasons.join("; "));
  assert.equal(v.wxCoverage, "runtime-unmeasured");
  assert.match(v.wxWhy, /UNMEASURED, not clean/);
  assert.equal(judged(ATTEST_TIME, { image: V42 }).wxCoverage, "runtime-covered");
  assert.equal(judged("exec_pages=allowed wx=clean maps=1 runtime=0 front=1 scope=cgroup:/dom1", { image: V42 }).verdict, "reject",
    "a listed image never excuses a scan that covered no runtime");
});

test("the image is the CALLER's: a document claiming v42's image, or a caller naming none, gets no legacy", () => {
  const claims = judged(LEGACY, { image: V42, expectedImageSha256: V43 });   // the report says v42; the launcher's record says v43
  assert.equal(claims.verdict, "reject");
  assert.match(claims.reasons.join("; "), /names no runtime coverage/);
  const none = judged(LEGACY, { image: V42, expectedImageSha256: null });   // e.g. the HCS lab's records: no image
  assert.equal(none.verdict, "reject");
  assert.equal(judged(ATTEST_TIME, { image: V42, expectedImageSha256: null }).verdict, "monitor-signed");
});

test("the table: frozen, full image hashes, v42 listed, nothing later", () => {
  assert.ok(Object.isFrozen(LEGACY_WX_IMAGES));
  assert.deepEqual(Object.keys(LEGACY_WX_IMAGES), [V42]);
  assert.equal(wxCoverage(LEGACY, null).ok, false);
  assert.equal(wxCoverage(LEGACY, "x").coverage, "runtime-unmeasured");
  // a listed image's legacy form still has to be clean (enclave-5d): never "unmeasured" for a dirty scan
  assert.equal(wxCoverage("exec_pages=allowed wx=DIRTY maps=2 scope=cgroup:/dom1", "x").ok, false);
  assert.equal(wxCoverage("exec_pages=allowed wx=clean toString=1 maps=2 scope=cgroup:/dom1", "x").coverage, "runtime-unmeasured", "a prototype key name is just a field");
});

// ABI/1 (no runtime, no self-test): refused on any image the table does not list WHATEVER the caller pins - with the
// manager's ENCLAVE_RUNTIME_IDENTITY set (expectRuntime) and unset (none) alike; v42's image keeps today's handling.
test("an ABI/1 document on an unlisted image is refused whether or not the caller pins the runtime; v42's keeps today's handling", () => {
  function abi1(image, pinned) {
    const nonce = crypto.randomBytes(32);
    const binding = crypto.createHash("sha256").update(spki).update(nonce).digest();
    const report = { format: FORMAT, tier: TIER, reportData: Buffer.concat([binding, Buffer.from(APP, "hex")]).toString("hex"),
      domain: { appSha256: APP }, partition: { vmId: "3f1c0f6e-0000-4000-8000-000000000001", guestImageSha256: image },
      launcher: { key: launcherKey }, platform: { hostExcluded: false }, boundary: "tier=T0-hv partition=hyperv-vm host_excluded=no" };
    const sig = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), privateKey).toString("base64");
    const doc = { format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP, report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") };
    return judge({ doc, spki, nonce, expectedAppSha256: APP, launcherKey, expectedImageSha256: image, ...(pinned ? { expectRuntime: JIT } : {}) });
  }
  for (const pinned of [true, false]) {
    const v = abi1(V43, pinned);
    assert.equal(v.verdict, "reject", `ABI/1 on an unlisted image was accepted (runtime ${pinned ? "pinned" : "not pinned"})`);
    assert.match(v.reasons.join("; "), /states no runtime self-test/);
  }
  assert.equal(abi1(V42, false).verdict, "monitor-signed", "v42's image, runtime not pinned: today's handling admits ABI/1");
  assert.equal(abi1(V42, true).verdict, "reject", "v42's image, runtime pinned: today's handling refuses ABI/1");
});
