// verifier/nucbox-reference.mjs on the PINNED reference file (verifier/pins/nucbox-vbs-reference.json, enclave-63's
// windows/vbslike-pkg; the commit and every previous pin are in verifier/pins/SOURCES.json): the exact-digest allowlist for the NucBox paravisor report (V3/V4 of
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

test("the pinned file is v42 (enclave-53 in enclave-63's lane), THE ROLLOVER to the fixed guest aaad1d37 (0891c740), by hash: only A39E2F8C is eligible, and PROSPECTIVE; b7ba7731 and its twin, and v41's failed 252602c8 and its twin, are superseded; every debug, control, probe, stock and superseded image is refused by its exact digest", () => {
  const S = SOURCES["nucbox-vbs-reference.json"];
  assert.equal(createHash("sha256").update(RAW).digest("hex"), S.sha256);
  assert.equal(S.origin.commit, "3c2fc939"); assert.equal(S.origin.packageVersion, "v42"); assert.equal(REF.type, REFERENCE_TYPE);
  assert.deepEqual(S.previous.map((x) => x.commit), ["7e979b38", "37673a05", "adea692b", "75d4563e", "603f12d1", "fb1bb0e6", "e94fc756", "85d74c56", "840eb861"], "every previous pin is recorded, v39 first");
  assert.equal(S.previous[0].sha256, "b4d6675dd9b78eafceb10461a228bd8e039c8534b5b958a5fadc3a479cb97d29");
  assert.equal(S.rollback.sha256, "3bb33297206197852cab99e8bfbf96766d9dbf7aff7f085ceffdd0373eb2a4ea", "the rollback target is v41's file, re-pinned, never an edit");
  assert.match(S.rollback.how, /or restore the previous pin b4d6675d/);
  const CNEW = "A39E2F8CB71BEB3DC2A7BF1F41C60FBB76168CACAE11F8002E3C37ADFA94C817", C1539 = "56FBB27F363A7FEDC83FD56CB4FF39C5411140300BB8F8496C35893A061077E1";
  const C252 = "231D1AB7EE9C3BA1A4046DD26AC911BC247230F5C7FAD79895E9405F3E51A82C", G1 = "58DFEBFE5F46E5C0E371CE94C2AB947735EA618CF51F973FBBB58048D9C7343A";
  const C567 = "A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244";
  // the ONE eligible image: clean, its canary passed BOTH paths, and PROSPECTIVE (no report verified; it grants nothing)
  const cn = REF.images.find((i) => i.id === "vbs-linux-candidate-aaad1d37");
  assert.equal(cn.class, "candidate"); assert.equal(cn.confidentialDebug, false); assert.equal(cn.trustsHostCommandLine, false); assert.equal(cn.eligible, true);
  assert.match(cn.booted, /^yes: BOOTED AND SERVED on BOTH paths/); assert.match(cn.booted, /THE MANAGER PATH/); assert.match(cn.booted, /NOT established/);
  assert.match(cn.reason, /^ELIGIBLE from v42, and PROSPECTIVE/); assert.match(cn.reason, /No report has been verified for it/); assert.match(cn.reason, /no production app capacity/);
  const { eligible, refused } = eligibleDigestsOf(REF);
  assert.deepEqual([...eligible.keys()], [CNEW]); assert.equal(eligible.get(CNEW).id, "vbs-linux-candidate-aaad1d37"); assert.equal(eligible.get(CNEW).imageSha256, "0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998");
  const refusedIds = Object.fromEntries([...refused.values()].map((r) => [r.id, r.class]));
  assert.deepEqual(refusedIds, { "vbs-linux-candidate-aaad1d37-debug-twin": "debug", "g4-probe-72462737": "probe", "a7b0bd4-control": "control", "a7b0bd4-debug": "debug", "stock-2511-openhcl-cvm": "stock",
                                 "vbs-linux-candidate-1539": "superseded", "vbs-linux-candidate-1539-debug-twin": "superseded",
                                 "vbs-linux-candidate-41cacbc8": "superseded", "vbs-linux-candidate-41cacbc8-debug-twin": "superseded",
                                 "vbs-linux-candidate-g1": "superseded", "vbs-linux-candidate-g1-debug-twin": "superseded",
                                 "vbs-linux-candidate-c567e432": "superseded", "vbs-linux-candidate-debug-twin-c567e432": "superseded",
                                 "vbs-linux-candidate-v27": "superseded", "vbs-linux-candidate-debug-twin-v27": "superseded" });
  assert.equal(eligible.size + refused.size, 16, "1 eligible, 15 refused");
  // the previous eligible image (v39-v41) and its twin: refused by their exact digests, the reasons naming the replacement
  assert.equal(refused.get(C1539).class, "superseded"); assert.match(refused.get(C1539).reason, /superseded in v42 by vbs-linux-candidate-aaad1d37/);
  assert.equal(REF.superseded.find((x) => x.id === "vbs-linux-candidate-1539").imageSha256, "b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748");
  assert.match(refused.get("8E9D6ACBDAAD01F79AAB4EC6FA964068DA992C40B32D110025570C46BD682F9A").reason, /superseded with it in v42/);
  // v41's pending candidate FAILED its canary: refused, never eligible
  assert.equal(refused.get(C252).class, "superseded"); assert.match(refused.get(C252).reason, /failed its canary/); assert.match(refused.get(C252).reason, /Never eligible/);
  assert.equal(refused.get("25E0E2C6706957BF65F888FB6E41933A398C2426CD29249737BB59767E85EEA7").class, "superseded");
  // the older candidates, still refused
  assert.equal(refused.get(G1).class, "superseded"); assert.match(refused.get(G1).reason, /superseded in v39 by vbs-linux-candidate-1539/);
  assert.equal(refused.get(C567).class, "superseded"); assert.match(refused.get(C567).reason, /superseded in v31 by the G1 candidate/);
  assert.ok(refused.has("A650C020838049BA0C431E72E0744606C0D55246F9BA8031E0797F724A35157E"), "its confidential-debug twin, whose debugBuild is false");
  assert.ok(refused.has("246DEE1B6F2057F504EF3B0C422E081CB365B121E7D0C7BFE420B1A8946A89F0") && refused.has("0677F3C6B217794C0F70703C9C6E15EDAFE12E97DE1B5BAD520246E553E01698"), "the superseded pre-review pair");
  assert.equal(REF.images.length, 6); assert.equal(REF.superseded.length, 10);
  // the file itself says what eligibility does NOT grant
  assert.match(REF.eligible, /PROSPECTIVE/); assert.match(REF.eligible, /no verdict uses this allowlist/); assert.match(REF.eligible, /no production app capacity/);
  assert.match(REF.notAClaim, /host_excluded=no/); assert.match(REF.notAClaim, /production attach OFF/);
  // v33/v35: the G4 PROBE image is refused by its exact digest; it booted once and never served
  const probe = REF.images.find((i) => i.id === "g4-probe-72462737");
  assert.equal(refused.get("CF339BC5C89E5F160482553CFE61A2CD694B38EE7583A55B6B722DBA13271B0F").class, "probe");
  assert.equal(probe.confidentialDebug, false); assert.equal(probe.debugBuild, false); assert.equal(probe.eligible, false);
  assert.match(probe.booted, /^yes, once/); assert.match(probe.booted, /never served/);
  // the new candidate's confidential-debug twin: refused
  assert.equal(refused.get("DB5A0402949062412B8828FDD3E4C1F90D4C251106D71FA1DF94088208F09F40").class, "debug");
});
test("debugBuild is never read; a file that marks a debug, host-trusting, control or superseded image eligible, repeats a digest, or has another type is refused outright", () => {
  const flipped = clone(); for (const i of flipped.images) i.debugBuild = !i.debugBuild;
  assert.deepEqual([...eligibleDigestsOf(flipped).eligible.keys()], [...eligibleDigestsOf(REF).eligible.keys()], "debugBuild changes nothing");
  const host = clone(); Object.assign(host.images.find((i) => i.id === "vbs-linux-candidate-aaad1d37"), { trustsHostCommandLine: true });
  assert.throws(() => eligibleDigestsOf(host), /trusting the host's command line/);
  // a second clean candidate marked eligible beside aaad1d37 is two eligible digests, refused outright
  const two = clone(); const c = two.images.find((i) => i.id === "vbs-linux-candidate-aaad1d37");
  two.images.push({ ...c, id: "another-candidate", imageSha256: "ab".repeat(32), vbsBootDigest: "CD".repeat(32) });
  assert.throws(() => eligibleDigestsOf(two), /2 images are marked eligible .*exactly one at a time/);
  // ROLLBACK is a re-pin of v41's file (SOURCES rollback), never an edit: an older candidate restored as eligible beside aaad1d37 is refused
  const g1back = clone(); const sg = g1back.superseded.find((x) => x.id === "vbs-linux-candidate-g1");
  g1back.superseded = g1back.superseded.filter((x) => x !== sg);
  g1back.images.push({ id: "vbs-linux-candidate-g1", class: "candidate", imageSha256: sg.imageSha256, vbsBootDigest: sg.vbsBootDigest, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: true, reason: "restored" });
  assert.throws(() => eligibleDigestsOf(g1back), /2 images are marked eligible .*exactly one at a time/, "G1 restored beside aaad1d37 is two eligible");
  const b7back = clone(); const sb = b7back.superseded.find((x) => x.id === "vbs-linux-candidate-1539");
  b7back.superseded = b7back.superseded.filter((x) => x !== sb);
  b7back.images.push({ id: "vbs-linux-candidate-1539", class: "candidate", imageSha256: sb.imageSha256, vbsBootDigest: sb.vbsBootDigest, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: true, reason: "restored by edit" });
  assert.throws(() => eligibleDigestsOf(b7back), /2 images are marked eligible .*exactly one at a time/, "b7ba7731 restored by EDIT beside aaad1d37 is two eligible: a rollback re-pins v41's file");
  const twn = clone(); twn.images.find((i) => i.id === "vbs-linux-candidate-aaad1d37-debug-twin").eligible = true;
  assert.throws(() => eligibleDigestsOf(twn), /marked eligible but is debug, confidential-debug, trusting the host's command line/);
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
  // the rollover rule agreed with enclave-63: an older candidate cannot come back beside the eligible one as eligible
  // (two eligible), nor as an image while it is superseded (the digest twice), nor as an eligible superseded entry
  const C567 = "A0FDAC0FC1EFB7B702D6DE1FACFAD8EB4E738DD35F3D3EE39AA0F5416BBCA244";
  const back = clone(); const sc = back.superseded.find((x) => x.id === "vbs-linux-candidate-c567e432");
  back.superseded = back.superseded.filter((x) => x !== sc);
  back.images.push({ id: "vbs-linux-candidate", class: "candidate", imageSha256: sc.imageSha256, vbsBootDigest: C567, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: true, reason: "restored" });
  assert.throws(() => eligibleDigestsOf(back), /2 images are marked eligible .*exactly one at a time/, "restoring the old candidate as eligible beside the eligible one is refused");
  const twice = clone(); twice.images.push({ id: "vbs-linux-candidate", class: "candidate", imageSha256: "c567e432".padEnd(64, "0"), vbsBootDigest: C567, debugBuild: false, confidentialDebug: false, trustsHostCommandLine: false, eligible: false, reason: "listed again" });
  assert.throws(() => eligibleDigestsOf(twice), /appears twice/, "a superseded digest cannot also be listed as an image");
  const unsup = clone(); unsup.superseded.find((x) => x.id === "vbs-linux-candidate-c567e432").eligible = true;
  assert.throws(() => eligibleDigestsOf(unsup), /superseded vbs-linux-candidate-c567e432 must say eligible:false/);
});
