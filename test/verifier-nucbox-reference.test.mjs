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

test("the pinned file is enclave-63's v37 (after the rollover, the G4 probe image, and the next candidate 1539 booted and served in its canary, still NOT eligible), by hash; only the G1 measured-VTL0 candidate is eligible, and every debug, control, stock and superseded image, the previous candidate included, is refused by its exact digest", () => {
  assert.equal(createHash("sha256").update(RAW).digest("hex"), SOURCES["nucbox-vbs-reference.json"].sha256);
  assert.equal(SOURCES["nucbox-vbs-reference.json"].origin.commit, "37673a05"); assert.equal(SOURCES["nucbox-vbs-reference.json"].origin.owner, "enclave-63"); assert.equal(REF.type, REFERENCE_TYPE);
  assert.deepEqual(SOURCES["nucbox-vbs-reference.json"].previous.map((x) => x.commit), ["adea692b", "75d4563e", "603f12d1", "fb1bb0e6", "e94fc756", "85d74c56", "840eb861"], "every previous pin is recorded");
  const G1 = "58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A", C567 = "A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244";
  const g1 = REF.images.find((i) => i.id === "vbs-linux-candidate-g1");
  assert.match(g1.booted, /^yes: BOOTED and SERVED/); assert.match(g1.reason, /PROSPECTIVE/, "eligibility stays prospective until report bytes verify");
  const { eligible, refused } = eligibleDigestsOf(REF);
  assert.deepEqual([...eligible.keys()], [G1]); assert.equal(eligible.get(G1).id, "vbs-linux-candidate-g1"); assert.equal(eligible.get(G1).imageSha256, "a44bb55a89bb0e6d2757287032070662041a0952eaf3713901cedc92404717e4");
  const refusedIds = Object.fromEntries([...refused.values()].map((r) => [r.id, r.class]));
  assert.deepEqual(refusedIds, { "vbs-linux-candidate-g1-debug-twin": "debug", "vbs-linux-candidate-1539": "candidate", "vbs-linux-candidate-1539-debug-twin": "debug", "g4-probe-72462737": "probe", "a7b0bd4-control": "control", "a7b0bd4-debug": "debug", "stock-2511-openhcl-cvm": "stock",
                                 "vbs-linux-candidate-c567e432": "superseded", "vbs-linux-candidate-debug-twin-c567e432": "superseded",
                                 "vbs-linux-candidate-v27": "superseded", "vbs-linux-candidate-debug-twin-v27": "superseded" });
  // the previous candidate, the only image that booted before G1, is now refused by its exact digest, with the reason naming its replacement
  assert.equal(refused.get(C567).class, "superseded"); assert.match(refused.get(C567).reason, /superseded in v31 by the G1 candidate/);
  assert.ok(refused.has("A650C020838049BA0C431E72E0744606C0D55246F9BA8031E0797F724A35157E"), "its confidential-debug twin, whose debugBuild is false");
  assert.ok(refused.has("2A93ED16DC7967A222FB791465E42E4EE84E969FD98349274C4B606D1CBAF533"), "the G1 twin (confidentialDebug, trusts the host's command line)");
  assert.ok(refused.has("246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0") && refused.has("0677F3C6B217794C0F70703C9C6E15EDAFE12E97DE1B5BAD520246E553E01698"), "the superseded pre-review pair");
  assert.equal(REF.images.length, 8); assert.equal(REF.superseded.length, 4);
  // v33: the G4 PROBE image (the G1 recipe with a probe initrd) is refused by its exact digest; its identity document says
  // debug_build false and it trusts nothing from the host, so ONLY the digest tells it from a candidate
  const probe = REF.images.find((i) => i.id === "g4-probe-72462737");
  assert.equal(refused.get("CF339BC5C89E5F160482553CFE61A2CD694B38EE7583A55B6B722DBA13271B0F").class, "probe");
  assert.equal(probe.confidentialDebug, false); assert.equal(probe.debugBuild, false); assert.equal(probe.eligible, false);
  // v35: the probe BOOTED once (d1's G4 run 082856) and that changes nothing: a boot is not eligibility, the digest still refuses it
  assert.match(probe.booted, /^yes, once/); assert.match(probe.booted, /never served/);
  // v36: the NEXT candidate is staged clean but NOT eligible (one eligible digest at a time; eligibility is a later
  // version's decision after its own canary), so it is refused by its exact digest like everything else; its twin is debug
  const c1539 = REF.images.find((i) => i.id === "vbs-linux-candidate-1539");
  assert.equal(c1539.class, "candidate"); assert.equal(c1539.confidentialDebug, false); assert.equal(c1539.trustsHostCommandLine, false); assert.equal(c1539.eligible, false);
  // v37: 1539 BOOTED and SERVED in its own canary (d1 093904), and that changes nothing here: a canary is not eligibility,
  // and the rollover is a later version that also supersedes a44bb55a (one eligible digest at a time)
  assert.match(c1539.booted, /^yes: BOOTED and SERVED/); assert.match(c1539.booted, /NOT established/);
  assert.match(c1539.reason, /^NOT YET ELIGIBLE/); assert.match(c1539.reason, /supersedes a44bb55a/);
  assert.equal(refused.get("56FBB27F363A7FEDC83FD56CB4FF39C5411140300BB8F8496C35893A061077E1").id, "vbs-linux-candidate-1539");
  assert.match(refused.get("56FBB27F363A7FEDC83FD56CB4FF39C5411140300BB8F8496C35893A061077E1").reason, /NOT YET ELIGIBLE/);
  assert.equal(refused.get("8E9D6ACBDAAD01F79AAB4EC6FA964068DA992C40B32D110025570C46BD682F9A").class, "debug");
});

test("debugBuild is never read; a file that marks a debug, host-trusting, control or superseded image eligible, repeats a digest, or has another type is refused outright", () => {
  const flipped = clone(); for (const i of flipped.images) i.debugBuild = !i.debugBuild;
  assert.deepEqual([...eligibleDigestsOf(flipped).eligible.keys()], [...eligibleDigestsOf(REF).eligible.keys()], "debugBuild changes nothing");
  const twin = clone(); twin.images.find((i) => i.id === "vbs-linux-candidate-g1-debug-twin").eligible = true;
  assert.throws(() => eligibleDigestsOf(twin), /marked eligible but is debug, confidential-debug, trusting the host's command line/);
  const host = clone(); Object.assign(host.images.find((i) => i.id === "vbs-linux-candidate-g1"), { trustsHostCommandLine: true });
  assert.throws(() => eligibleDigestsOf(host), /trusting the host's command line/);
  // a half-done rollover: the staged 1539 candidate marked eligible beside G1 is two eligible digests, refused outright
  const two = clone(); two.images.find((i) => i.id === "vbs-linux-candidate-1539").eligible = true;
  assert.throws(() => eligibleDigestsOf(two), /2 images are marked eligible .*exactly one at a time/);
  const tw1539 = clone(); tw1539.images.find((i) => i.id === "vbs-linux-candidate-1539-debug-twin").eligible = true;
  assert.throws(() => eligibleDigestsOf(tw1539), /marked eligible but is debug, confidential-debug, trusting the host's command line/);
  const prb = clone(); prb.images.find((i) => i.id === "g4-probe-72462737").eligible = true;
  assert.throws(() => eligibleDigestsOf(prb), /marked eligible but is probe/, "a probe image can never be eligible, whatever its flags say");
  const ctl = clone(); ctl.images.find((i) => i.id === "a7b0bd4-control").eligible = true;
  assert.throws(() => eligibleDigestsOf(ctl), /marked eligible but is control/);
  const sup = clone(); sup.superseded[0].eligible = true;
  assert.throws(() => eligibleDigestsOf(sup), /superseded .* must say eligible:false/);
  const dup = clone(); dup.images[1].vbsBootDigest = dup.images[0].vbsBootDigest.toLowerCase();
  assert.throws(() => eligibleDigestsOf(dup), /appears twice/);
  assert.throws(() => eligibleDigestsOf({ ...clone(), type: "other/1" }), /type must be/);
  const bad = clone(); bad.images[0].vbsBootDigest = "58DF"; assert.throws(() => eligibleDigestsOf(bad), /not 32 bytes of hex/);
  // the rollover rule agreed with enclave-63, on the REAL v31: the old candidate cannot come back beside G1 as eligible
  // (two eligible), nor as an image while it is superseded (the digest twice), nor as an eligible superseded entry
  const C567 = "A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244";
  const back = clone(); const sc = back.superseded.find((x) => x.id === "vbs-linux-candidate-c567e432");
  back.superseded = back.superseded.filter((x) => x !== sc);
  back.images.push({ id: "vbs-linux-candidate", class: "candidate", imageSha256: sc.imageSha256, vbsBootDigest: C567, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: true, reason: "restored" });
  assert.throws(() => eligibleDigestsOf(back), /2 images are marked eligible .*exactly one at a time/, "restoring the old candidate as eligible beside G1 is refused");
  const twice = clone(); twice.images.push({ id: "vbs-linux-candidate", class: "candidate", imageSha256: "c567e432".padEnd(64, "0"), vbsBootDigest: C567, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: false, reason: "listed again" });
  assert.throws(() => eligibleDigestsOf(twice), /appears twice/, "a superseded digest cannot also be listed as an image");
  const unsup = clone(); unsup.superseded.find((x) => x.id === "vbs-linux-candidate-c567e432").eligible = true;
  assert.throws(() => eligibleDigestsOf(unsup), /superseded vbs-linux-candidate-c567e432 must say eligible:false/);
});
