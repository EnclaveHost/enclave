// verifier/nucbox-reference.mjs on enclave-53's PINNED reference file (verifier/pins/nucbox-vbs-reference.json from
// windows/vbslike-pkg 840eb861): the exact-digest allowlist for the NucBox paravisor report (V3/V4 of
// docs/security/nucbox-custom-vm-verifier.md). Only the measured-VTL0 candidate is eligible; its confidential-debug twin,
// the control, the old debug image, the stock image and the superseded pair are refused; debugBuild is never read; an
// inconsistent file is refused outright. No verdict uses this until report bytes exist.
//   run: node --test test/verifier-nucbox-reference.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { eligibleDigestsOf, REFERENCE_TYPE } from "../verifier/nucbox-reference.mjs";

const RAW = fs.readFileSync(new URL("../verifier/pins/nucbox-vbs-reference.json", import.meta.url));
const SOURCES = JSON.parse(fs.readFileSync(new URL("../verifier/pins/SOURCES.json", import.meta.url), "utf8"));
const REF = JSON.parse(RAW.toString("utf8"));
const clone = () => JSON.parse(RAW.toString("utf8"));

test("the pinned file is enclave-53's, by hash; only the measured-VTL0 candidate is eligible, and every debug, control, stock and superseded image is refused by its exact digest", () => {
  assert.equal(createHash("sha256").update(RAW).digest("hex"), SOURCES["nucbox-vbs-reference.json"].sha256);
  assert.equal(SOURCES["nucbox-vbs-reference.json"].origin.commit, "85d74c56"); assert.equal(SOURCES["nucbox-vbs-reference.json"].origin.owner, "enclave-63"); assert.equal(REF.type, REFERENCE_TYPE);
  assert.deepEqual(SOURCES["nucbox-vbs-reference.json"].previous.map((x) => x.commit), ["840eb861"], "the previous pin is recorded");
  assert.match(REF.images.find((i) => i.id === "vbs-linux-candidate").booted, /^yes: BOOTED/, "v29 records the boot; eligibility did not change with it");
  const { eligible, refused } = eligibleDigestsOf(REF);
  assert.deepEqual([...eligible.keys()], ["A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244"]);
  assert.equal(eligible.get("A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244").id, "vbs-linux-candidate");
  const refusedIds = Object.fromEntries([...refused.values()].map((r) => [r.id, r.class]));
  assert.deepEqual(refusedIds, { "vbs-linux-candidate-debug-twin": "debug", "a7b0bd4-control": "control", "a7b0bd4-debug": "debug", "stock-2511-openhcl-cvm": "stock",
                                 "vbs-linux-candidate-v27": "superseded", "vbs-linux-candidate-debug-twin-v27": "superseded" });
  assert.ok(refused.has("A650C020838049BA0C431E72E0744606C0D55246F9BA8031E0797F724A35157E"), "the confidential-debug twin, whose debugBuild is false");
  assert.ok(refused.has("246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0") && refused.has("0677F3C6B217794C0F70703C9C6E15EDAFE12E97DE1B5BAD520246E553E01698"), "the superseded pre-review pair");
});

test("debugBuild is never read; a file that marks a debug, host-trusting, control or superseded image eligible, repeats a digest, or has another type is refused outright", () => {
  const flipped = clone(); for (const i of flipped.images) i.debugBuild = !i.debugBuild;
  assert.deepEqual([...eligibleDigestsOf(flipped).eligible.keys()], [...eligibleDigestsOf(REF).eligible.keys()], "debugBuild changes nothing");
  const twin = clone(); twin.images.find((i) => i.id === "vbs-linux-candidate-debug-twin").eligible = true;
  assert.throws(() => eligibleDigestsOf(twin), /marked eligible but is debug, confidential-debug, trusting the host's command line/);
  const host = clone(); Object.assign(host.images.find((i) => i.id === "vbs-linux-candidate"), { trustsHostCommandLine: true });
  assert.throws(() => eligibleDigestsOf(host), /trusting the host's command line/);
  const ctl = clone(); ctl.images.find((i) => i.id === "a7b0bd4-control").eligible = true;
  assert.throws(() => eligibleDigestsOf(ctl), /marked eligible but is control/);
  const sup = clone(); sup.superseded[0].eligible = true;
  assert.throws(() => eligibleDigestsOf(sup), /superseded .* must say eligible:false/);
  const dup = clone(); dup.images[1].vbsBootDigest = dup.images[0].vbsBootDigest.toLowerCase();
  assert.throws(() => eligibleDigestsOf(dup), /appears twice/);
  assert.throws(() => eligibleDigestsOf({ ...clone(), type: "other/1" }), /type must be/);
  const bad = clone(); bad.images[0].vbsBootDigest = "A0FD"; assert.throws(() => eligibleDigestsOf(bad), /not 32 bytes of hex/);
  // the rollover rule agreed with enclave-63: exactly one eligible digest; a clean new candidate may wait as eligible:false
  const next = { id: "vbs-linux-candidate-g1", class: "candidate", imageSha256: "a44bb55a".padEnd(64, "0"), vbsBootDigest: "58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A",
                 debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: false, reason: "not booted yet" };
  const staged = clone(); staged.images.push(next);
  const st = eligibleDigestsOf(staged); assert.deepEqual([...st.eligible.keys()], ["A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244"]); assert.equal(st.refused.get(next.vbsBootDigest).reason, "not booted yet");
  const both = clone(); both.images.push({ ...next, eligible: true });
  assert.throws(() => eligibleDigestsOf(both), /2 images are marked eligible .*exactly one at a time/);
  const flipped2 = clone(); const old = flipped2.images.find((i) => i.id === "vbs-linux-candidate");
  flipped2.images = flipped2.images.filter((i) => i !== old); flipped2.images.push({ ...next, eligible: true });
  flipped2.superseded.push({ id: old.id, vbsBootDigest: old.vbsBootDigest, imageSha256: old.imageSha256, eligible: false, reason: "superseded by the G1 candidate" });
  assert.deepEqual([...eligibleDigestsOf(flipped2).eligible.keys()], [next.vbsBootDigest], "the flip and the supersession in one version");
});
