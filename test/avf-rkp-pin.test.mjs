// The Google root of trust behind a phone-anchored host is PINNED, and the
// policy on top of it fails closed.
//
// An AVF protected-VM attestation is an X.509 chain whose leaf key exists only
// inside the pVM and whose root is Google's. "The chain verifies" proves that
// it hangs together; whoever gets to be the root gets to be the device, which
// is exactly the bypass snp-ark-pin.test.mjs closes for AMD. So the root is
// matched against pins taken from Google's own publication
// (https://android.googleapis.com/attestation/root, mirrored on
// developer.android.com/privacy-and-security/security-key-attestation), and the
// fixtures under test/fixtures/google/ are those bytes.
//
// The rest of the verifier is exercised on a SYNTHETIC chain
// (test/fixtures/avf-synthetic.mjs, built with openssl), pinned to the
// synthetic root for the positive case and to the real pins for the case that
// matters most: a well-formed chain to the wrong root is refused.
//
//   run: node --test test/avf-rkp-pin.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GOOGLE_ATTESTATION_ROOT_SHA256, isPinnedGoogleRoot, parseAvfExtension, orderChain, verifyAvfEvidence,
         evidenceFromLog } from "../relay/avf-verify.mjs";
import { haveOpenssl, tmpdir, fp, buildChain, extension, CHALLENGE, CODE, AUTH } from "./fixtures/avf-synthetic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "google");

test("the pins are the roots Google publishes, and each is a self-signed CA", () => {
  const files = { "google-hardware-attestation-root-2022": "hardware-attestation-root-2022.pem", "google-key-attestation-ca1-2025": "key-attestation-ca1-2025.pem" };
  for (const [name, want] of GOOGLE_ATTESTATION_ROOT_SHA256) {
    const c = new X509Certificate(fs.readFileSync(path.join(FIX, files[name])));
    assert.equal(fp(c), want, `${name}: fixture fingerprint must equal the pin`);
    assert.ok(c.checkIssued(c) && c.verify(c.publicKey), `${name}: self-signed`);
    assert.ok(c.ca, `${name}: CA`);
    assert.ok(isPinnedGoogleRoot(c), `${name}: isPinnedGoogleRoot`);
  }
});

test("synthetic chain: the whole policy accepts, and every refusal refuses", { skip: !haveOpenssl && "openssl not installed" }, () => {
  const dir = tmpdir();
  try {
    const ch = buildChain(dir);
    const good = { chain: ch.chain, challenge: CHALLENGE, signature: ch.sign(CHALLENGE), signedMessage: CHALLENGE };
    const policy = { allowedCodeHashes: [CODE.toString("hex")], allowedAuthorityHashes: [AUTH.toString("hex")], rootPins: [ch.rootPin] };

    // the extension parses to what we encoded
    const e = parseAvfExtension(ch.leaf);
    assert.deepEqual(e.challenge, CHALLENGE); assert.equal(e.isVmSecure, true);
    assert.equal(e.components[0].name, "apk:host.enclave.anchor.avf"); assert.equal(e.components[0].codeHash, CODE.toString("hex"));
    assert.equal(e.components[0].authorityHash, AUTH.toString("hex")); assert.equal(e.components[1].securityVersion, 2n);

    const ok = verifyAvfEvidence(good, policy);
    assert.equal(ok.ok, true, ok.reasons.join("; "));
    assert.equal(ok.measurement, CODE.toString("hex"), "the measurement a badge carries is the anchor's codeHash");
    assert.equal(ok.rootVerified, true);

    // order does not matter: the phone may hand the chain root-first
    assert.equal(verifyAvfEvidence({ ...good, chain: [ch.root, ch.inter, ch.leaf] }, policy).ok, true);
    assert.equal(orderChain([ch.root, ch.leaf, ch.inter].map((d) => new X509Certificate(d)))[0].subject.includes("Virtual Machine"), true);

    // THE one that matters: a well-formed chain to a root that is not Google's
    const wrongRoot = verifyAvfEvidence(good, { ...policy, rootPins: undefined });
    assert.equal(wrongRoot.ok, false); assert.match(wrongRoot.reasons.at(-1), /not a pinned Google attestation root/);

    const r = (ev, pol = policy) => verifyAvfEvidence(ev, pol).reasons.at(-1);
    assert.match(r({ ...good, challenge: Buffer.alloc(32, 7) }), /attestationChallenge does not match/);
    assert.match(r(good, { ...policy, allowedCodeHashes: ["00".repeat(32)] }), /no APK component with an allowlisted codeHash/);
    assert.match(r(good, { ...policy, allowedAuthorityHashes: ["00".repeat(64)] }), /unpinned authority/);
    assert.match(r(good, { ...policy, allowedCodeHashes: [] }), /fail closed/);
    const bad = Buffer.from(good.signature); bad[bad.length - 1] ^= 1;
    assert.match(r({ ...good, signature: bad }), /attested-key signature does not verify/);
    assert.match(r({ ...good, signedMessage: Buffer.from("other") }), /attested-key signature does not verify/);
    assert.match(r({ ...good, chain: [ch.leaf, ch.root] }), /not issued by|leaves|link up/);
    assert.match(r({ ...good, chain: [ch.leaf] }), /at least a leaf and a root/);
    assert.match(r(good, { ...policy, now: Date.now() + 3 * 86400e3 }), /expired/);

    // a debuggable VM (any DICE link not in normal mode) is refused even with everything else right
    const insecure = buildChain(tmpdir("avf-insecure-"), { ext: extension({ secure: false }) });
    const ins = verifyAvfEvidence({ chain: insecure.chain, challenge: CHALLENGE }, { ...policy, rootPins: [insecure.rootPin] });
    assert.equal(ins.ok, false); assert.match(ins.reasons.at(-1), /isVmSecure=false/);

    // the log reader reassembles what the payload prints in 512-byte chunks
    const hex = (b) => b.toString("hex");
    const lines = [`CONTROL challenge=${hex(CHALLENGE)} plan sent`];
    ch.chain.forEach((d, i) => { const h = hex(d); for (let o = 0, k = 0; o < h.length; o += 1024, k++) lines.push(`VSOCK CERT${i}[${k}] ${h.slice(o, o + 1024)}`); });
    lines.push(`VSOCK SIG[0] ${hex(good.signature)}`);
    const ev = evidenceFromLog(lines.join("\n"));
    assert.equal(ev.chain.length, 3); assert.equal(ev.challenge, hex(CHALLENGE));
    assert.equal(verifyAvfEvidence({ ...ev, signedMessage: CHALLENGE }, policy).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
