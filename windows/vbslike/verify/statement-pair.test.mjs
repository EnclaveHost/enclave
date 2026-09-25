// The (partition, guestImageKind) statement is compared BEFORE the image, and a WMI partition's image never alone
// (enclave-d1 + enclave-99, main ae6e9147): judge-hv against a real launcher-signed report, and the data plane's admit()
// against a manager record. The case each must refuse: the SAME 64 hex under the other partition or kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, canonical, SIGN_DOMAIN } from "./judge-hv.mjs";
import { BOOT_STATEMENTS, bootFormOfStatement, isStatedPartition } from "./boot-statements.mjs";
import { admit } from "../datapath/datapath.mjs";

// The report's format and tier as the RUST launcher defines them (host/src/contract.rs), never as the judge does: a
// fixture that took the judge's own names would agree with the judge while the binary disagreed, which is how run 081904
// failed on the box with every JS test green (enclave-d1's format-drift finding).
const CONTRACT_RS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../host/src/contract.rs"), "utf8");
const FORMAT = CONTRACT_RS.match(/pub const FORMAT_HYPERV: &str = "([^"]+)";/)[1];
const TIER = CONTRACT_RS.match(/pub const TIER_HYPERV: &str = "([^"]+)";/)[1];
const LD = BOOT_STATEMENTS["linux-direct"], UEFI = BOOT_STATEMENTS["uefi-medium"];
const IMG = "7c".repeat(32);                                         // one 64-hex value, stated under different pairs
const APP = "708e640945d196df5829aa4ea490774c18ef6876a0d9239f574986ad18ae3782";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const launcherKey = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
const spki = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });

// a document as the m2 front returns it, carrying a report the launcher signed (ABI/1: binding = sha256(spki || nonce))
function documentFor({ partition, image = IMG }) {
  const nonce = crypto.randomBytes(32);
  const binding = crypto.createHash("sha256").update(spki).update(nonce).digest();
  const report = { format: FORMAT, tier: TIER, reportData: Buffer.concat([binding, Buffer.from(APP, "hex")]).toString("hex"),
    domain: { appSha256: APP }, partition: { vmId: "3f1c0f6e-0000-4000-8000-000000000001", guestImageSha256: image },
    launcher: { key: launcherKey }, platform: { hostExcluded: false, partition },
    boundary: "tier=T0-hv partition=hyperv-vm host_excluded=no" };
  const sig = crypto.sign(null, Buffer.concat([SIGN_DOMAIN, Buffer.from(canonical(report))]), privateKey).toString("base64");
  const doc = { format: FORMAT, tier: TIER, nonce: nonce.toString("hex"), appSha256: APP,
                report: Buffer.from(JSON.stringify({ doc: report, sig })).toString("base64") };
  return { doc, nonce };
}
const judged = (partition, opts) => { const { doc, nonce } = documentFor({ partition }); return judge({ doc, spki, nonce, expectedAppSha256: APP, launcherKey, ...opts }); };

test("the table: exactly two rows, exact matching only, and it knows its partitions", () => {
  assert.equal(bootFormOfStatement(LD.partition, LD.guestImageKind), "linux-direct");
  assert.equal(bootFormOfStatement(UEFI.partition, UEFI.guestImageKind), "uefi-medium");
  for (const [p, k] of [[LD.partition, UEFI.guestImageKind], [UEFI.partition, LD.guestImageKind], [LD.partition.toUpperCase(), LD.guestImageKind],
                        [LD.partition + "-x", LD.guestImageKind], ["hcs-child", LD.guestImageKind], [undefined, undefined]])
    assert.equal(bootFormOfStatement(p, k), null, `${p} / ${k}`);
  assert.equal(isStatedPartition(LD.partition), true); assert.equal(isStatedPartition("hcs-child"), false);
});

test("judge-hv: the linux-direct pair and its image are admitted (monitor-signed)", () => {
  const v = judged(LD.partition, { expectedStatement: LD, expectedImageSha256: IMG });
  assert.equal(v.verdict, "monitor-signed", v.reasons.join("; "));
});

test("judge-hv: the SAME 64 hex under the other partition is refused", () => {
  const v = judged(UEFI.partition, { expectedStatement: LD, expectedImageSha256: IMG });
  assert.equal(v.verdict, "reject"); assert.ok(v.reasons.some((r) => /states partition "wmi-openhcl-gen2"/.test(r)), v.reasons.join("; "));
});

test("judge-hv: the SAME 64 hex under a crossed kind (not a row of the table) is refused", () => {
  const v = judged(LD.partition, { expectedStatement: { partition: LD.partition, guestImageKind: UEFI.guestImageKind }, expectedImageSha256: IMG });
  assert.equal(v.verdict, "reject"); assert.ok(v.reasons.some((r) => /no known pair/.test(r)), v.reasons.join("; "));
});

test("judge-hv: a WMI report's image is never compared alone, and a statement needs an image", () => {
  assert.equal(judged(LD.partition, { expectedImageSha256: IMG }).verdict, "reject");
  assert.equal(judged(LD.partition, { expectedStatement: LD }).verdict, "reject");
});

test("judge-hv: a report outside the table (the HCS lab) is still compared on its image as before", () => {
  assert.equal(judged("hcs-child", { expectedImageSha256: IMG }).verdict, "monitor-signed");
  assert.equal(judged("hcs-child", {}).verdict, "monitor-signed");
});

// ---- the data plane: the record's statement, then the image ----
const KEY = "ab".repeat(32), RT = "cd".repeat(32);
const want = { id: "hv1", app: APP, image: IMG, runtime: RT, key: KEY };
const record = (over = {}) => ({ status: "running", appId: APP, image: IMG, runtimeId: RT, transportKeySha256: KEY,
  relay: { host: "127.0.0.1", port: 19001 }, boundary: { tier: "t0-hv", partition: LD.partition, hostExcluded: false },
  guestIdentity: { partition: LD.partition, guestImageKind: LD.guestImageKind }, ...over });

test("datapath: a record stating the linux-direct pair, with that image, is admitted", () => {
  assert.deepEqual(admit(record(), want), ["", ""]);
});

test("datapath: the SAME image under a crossed kind, or under the other partition's boundary, is refused", () => {
  assert.equal(admit(record({ guestIdentity: { partition: LD.partition, guestImageKind: UEFI.guestImageKind } }), want)[0], "refused:identity");
  assert.equal(admit(record({ boundary: { tier: "t0-hv", partition: UEFI.partition, hostExcluded: false } }), want)[0], "refused:identity");
  assert.equal(admit(record({ guestIdentity: { partition: UEFI.partition, guestImageKind: UEFI.guestImageKind } }), want)[0], "refused:identity",
    "a uefi statement under a linux-direct boundary");
});

test("datapath: a record whose boundary names a WMI partition but states no pair is refused; the HCS lab's is not", () => {
  assert.equal(admit(record({ guestIdentity: undefined }), want)[0], "refused:identity");
  assert.deepEqual(admit(record({ guestIdentity: undefined, boundary: { tier: "t0-hv", partition: "hcs-child", hostExcluded: false } }), want), ["", ""]);
});
