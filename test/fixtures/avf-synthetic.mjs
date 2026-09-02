// A synthetic RKP-shaped AVF chain, built with openssl: root -> intermediate ->
// leaf carrying the AVF attestation extension. Shared by the verifier test and
// the tunnel handshake test. Nothing here is a real Google key; the tests pin
// the SYNTHETIC root where they want acceptance and the REAL pins where they
// want the refusal that matters.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { AVF_ATTESTATION_EXTENSION_OID } from "../../relay/avf-verify.mjs";

export const haveOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "pipe" }); return true; } catch { return false; } })();
export const tmpdir = (prefix = "avf-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const fp = (c) => c.fingerprint256.replace(/:/g, "").toLowerCase();

// minimal DER encoder, the mirror of the verifier's walker
const len = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const enc = (tag, b) => Buffer.concat([Buffer.from([tag]), len(b.length), b]);
export const seq = (...p) => enc(0x30, Buffer.concat(p)), octet = (b) => enc(0x04, b), bool = (v) => enc(0x01, Buffer.from([v ? 0xff : 0]));
export const utf8 = (s) => enc(0x0c, Buffer.from(s, "utf8")), integer = (n) => enc(0x02, Buffer.from([n]));

export const CHALLENGE = createHash("sha256").update("enclave-avf-test-challenge").digest();
export const CODE = createHash("sha256").update("anchor.apk v4 merkle root").digest();          // 32 B, like an APK codeHash
export const AUTH = createHash("sha512").update("Enclave APK signing certificate").digest();   // 64 B, like authorityHash
export const APEX_AUTH = createHash("sha512").update("Google apex").digest();
export function extension({ challenge = CHALLENGE, secure = true, code = CODE, auth = AUTH } = {}) {
  return seq(octet(challenge), bool(secure), seq(
    seq(utf8("apk:host.enclave.anchor.avf"), integer(1), octet(code), octet(auth)),
    seq(utf8("apex:com.android.virt"), integer(2), octet(createHash("sha256").update("virt apex").digest()), octet(APEX_AUTH)),
  ));
}

const ssl = (dir) => (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
const derOf = (dir, n) => new X509Certificate(fs.readFileSync(path.join(dir, `${n}.pem`))).raw;

// root + intermediate: independent of any challenge, so a test can pin the root
// BEFORE it knows the nonce the leaf will have to carry.
export function makeCa(dir) {
  const x = ssl(dir);
  fs.writeFileSync(path.join(dir, "ca.cnf"), "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  x("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key");
  x("req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "30", "-subj", "/CN=Synthetic RKP Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "root.pem");
  x("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "inter.key");
  x("req", "-new", "-key", "inter.key", "-subj", "/CN=Synthetic RKP Intermediate", "-out", "inter.csr");
  x("x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-sha256", "-extfile", "ca.cnf", "-extensions", "ca", "-out", "inter.pem");
  const root = derOf(dir, "root");
  return { root, inter: derOf(dir, "inter"), rootPin: fp(new X509Certificate(root)) };
}

let leafSeq = 0;
// a leaf under makeCa's intermediate, with the given extension; sign() uses its key
export function issueLeaf(dir, { ext = extension() } = {}) {
  const x = ssl(dir), n = `leaf-${++leafSeq}`;
  fs.writeFileSync(path.join(dir, `${n}.cnf`), `[leaf]\nbasicConstraints=CA:FALSE\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n${AVF_ATTESTATION_EXTENSION_OID}=DER:${ext.toString("hex")}\n`);
  x("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${n}.key`);
  x("req", "-new", "-key", `${n}.key`, "-subj", "/CN=Android Protected Virtual Machine Key", "-out", `${n}.csr`);
  x("x509", "-req", "-in", `${n}.csr`, "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-days", "1", "-sha256", "-extfile", `${n}.cnf`, "-extensions", "leaf", "-out", `${n}.pem`);
  const sign = (msg) => { fs.writeFileSync(path.join(dir, `${n}.msg`), msg); x("dgst", "-sha256", "-sign", `${n}.key`, "-out", `${n}.sig`, `${n}.msg`); return fs.readFileSync(path.join(dir, `${n}.sig`)); };
  return { leaf: derOf(dir, n), sign };
}

export function buildChain(dir, opts = {}) {
  const ca = makeCa(dir), l = issueLeaf(dir, opts);
  return { ...ca, ...l, chain: [l.leaf, ca.inter, ca.root] };
}
