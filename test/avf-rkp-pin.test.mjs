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
// The rest of the verifier is exercised on a SYNTHETIC chain built here with
// openssl (root -> intermediate -> leaf carrying the AVF extension), pinned to
// the synthetic root for the positive case and to the real pins for the case
// that matters most: a well-formed chain to the wrong root is refused.
//
//   run: node --test test/avf-rkp-pin.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GOOGLE_ATTESTATION_ROOT_SHA256, isPinnedGoogleRoot, parseAvfExtension, orderChain, verifyAvfEvidence,
         evidenceFromLog, AVF_ATTESTATION_EXTENSION_OID } from "../relay/avf-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "google");
const fp = (c) => c.fingerprint256.replace(/:/g, "").toLowerCase();

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

// ---- a synthetic RKP-shaped chain ------------------------------------------
const haveOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "pipe" }); return true; } catch { return false; } })();

// minimal DER encoder, the mirror of the verifier's walker
const len = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const enc = (tag, b) => Buffer.concat([Buffer.from([tag]), len(b.length), b]);
const seq = (...p) => enc(0x30, Buffer.concat(p)), octet = (b) => enc(0x04, b), bool = (v) => enc(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => enc(0x0c, Buffer.from(s, "utf8")), integer = (n) => enc(0x02, Buffer.from([n]));

const CHALLENGE = createHash("sha256").update("enclave-avf-test-challenge").digest();
const CODE = createHash("sha256").update("anchor.apk v4 merkle root").digest();          // 32 B, like an APK codeHash
const AUTH = createHash("sha512").update("Enclave APK signing certificate").digest();   // 64 B, like authorityHash
const APEX_AUTH = createHash("sha512").update("Google apex").digest();
function extension({ challenge = CHALLENGE, secure = true, code = CODE, auth = AUTH } = {}) {
  return seq(octet(challenge), bool(secure), seq(
    seq(utf8("apk:host.enclave.anchor.avf"), integer(1), octet(code), octet(auth)),
    seq(utf8("apex:com.android.virt"), integer(2), octet(createHash("sha256").update("virt apex").digest()), octet(APEX_AUTH)),
  ));
}

function buildChain(dir, { ext = extension() } = {}) {
  const ssl = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  const key = (n) => ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
  fs.writeFileSync(path.join(dir, "ca.cnf"), "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  fs.writeFileSync(path.join(dir, "leaf.cnf"), `[leaf]\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n${AVF_ATTESTATION_EXTENSION_OID}=DER:${ext.toString("hex")}\n`);
  key("root"); ssl("req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "30", "-subj", "/CN=Synthetic RKP Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "root.pem");
  key("inter"); ssl("req", "-new", "-key", "inter.key", "-subj", "/CN=Synthetic RKP Intermediate", "-out", "inter.csr");
  ssl("x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-sha256", "-extfile", "ca.cnf", "-extensions", "ca", "-out", "inter.pem");
  key("leaf"); ssl("req", "-new", "-key", "leaf.key", "-subj", "/CN=Android Protected Virtual Machine Key", "-out", "leaf.csr");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-days", "1", "-sha256", "-extfile", "leaf.cnf", "-extensions", "leaf", "-out", "leaf.pem");
  const der = (n) => new X509Certificate(fs.readFileSync(path.join(dir, `${n}.pem`))).raw;
  const sign = (msg) => { fs.writeFileSync(path.join(dir, "msg.bin"), msg); ssl("dgst", "-sha256", "-sign", "leaf.key", "-out", "sig.der", "msg.bin"); return fs.readFileSync(path.join(dir, "sig.der")); };
  return { leaf: der("leaf"), inter: der("inter"), root: der("root"), rootPin: fp(new X509Certificate(der("root"))), sign };
}

test("synthetic chain: the whole policy accepts, and every refusal refuses", { skip: !haveOpenssl && "openssl not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avf-"));
  try {
    const ch = buildChain(dir);
    const good = { chain: [ch.leaf, ch.inter, ch.root], challenge: CHALLENGE, signature: ch.sign(CHALLENGE), signedMessage: CHALLENGE };
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
    const insecure = buildChain(fs.mkdtempSync(path.join(os.tmpdir(), "avf-insecure-")), { ext: extension({ secure: false }) });
    const ins = verifyAvfEvidence({ chain: [insecure.leaf, insecure.inter, insecure.root], challenge: CHALLENGE }, { ...policy, rootPins: [insecure.rootPin] });
    assert.equal(ins.ok, false); assert.match(ins.reasons.at(-1), /isVmSecure=false/);

    // the log reader reassembles what the payload prints in 512-byte chunks
    const hex = (b) => b.toString("hex");
    const lines = [`CONTROL challenge=${hex(CHALLENGE)} plan sent`];
    [ch.leaf, ch.inter, ch.root].forEach((d, i) => { const h = hex(d); for (let o = 0, k = 0; o < h.length; o += 1024, k++) lines.push(`VSOCK CERT${i}[${k}] ${h.slice(o, o + 1024)}`); });
    lines.push(`VSOCK SIG[0] ${hex(good.signature)}`);
    const ev = evidenceFromLog(lines.join("\n"));
    assert.equal(ev.chain.length, 3); assert.equal(ev.challenge, hex(CHALLENGE));
    assert.equal(verifyAvfEvidence({ ...ev, signedMessage: CHALLENGE }, policy).ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
