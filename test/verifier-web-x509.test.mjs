// The browser build's X.509 layer (verifier/web/x509.mjs) against the REAL AMD collateral and against Node's own certificate
// object, field by field. Proves: the reader agrees with node:crypto on names, serials, windows and key types for all three
// product lines; WebCrypto verifies every real AMD signature with the parameters the certificates state and refuses a wrong
// salt; and where this build is stricter than Node (non-canonical DER, a certificate honestly stating another PSS salt, a
// BIT STRING with unused bits) BOTH sides are asserted, so the divergence is a recorded fact, not an assumption.
//   run: node --test test/verifier-web-x509.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as X from "../verifier/web/x509.mjs";
import { WEB_CRYPTO, checkHostedCertificate as webHosted, checkCrlAuthentic as webCrlAuthentic } from "../verifier/web/provider.mjs";
import { parseReportStrict, checkCrlAuthentic as nodeCrlAuthentic, checkChain as nodeCheckChain, verifyReportSignature as nodeReportSignature } from "../verifier/snp.mjs";
import { checkHostedCertificate as nodeHosted } from "../verifier/tls-binding.mjs";
import { parseCrl, tlv, children } from "../verifier/der.mjs";
import { AMD_ARK_SHA256 } from "../relay/snp-verify.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const read = (u) => new Uint8Array(fs.readFileSync(u)), text = (u) => fs.readFileSync(u, "utf8");
const NOW = new Date("2026-09-24T05:00:00Z");
const cn = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;
const chains = Object.fromEntries(["Genoa", "Milan", "Turin"].map((p) => [p, text(new URL(`${p}-cert_chain.pem`, A))]));
const load = async (pem) => Promise.all(X.pemCertificates(pem).map(X.loadCertificate));

test("all three real AMD chains: the reader agrees with node:crypto field by field, and WebCrypto verifies ARK and ASK", async () => {
  for (const product of ["Genoa", "Milan", "Turin"]) {
    const [ask, ark] = await load(chains[product]);
    const [nAsk, nArk] = chains[product].split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));
    for (const [w, n] of [[ask, nAsk], [ark, nArk]]) {
      assert.equal(w.subjectCn, cn(n.subject)); assert.equal(w.issuerCn, cn(n.issuer));
      assert.equal(w.serialHex, n.serialNumber, "serial in OpenSSL's form");
      assert.equal(w.validFrom, n.validFrom); assert.equal(w.validTo, n.validTo);
      assert.equal(w.fp256, n.fingerprint256.replace(/:/g, "").toLowerCase());
      assert.deepEqual(w.key, { type: "rsa", bits: n.publicKey.asymmetricKeyDetails.modulusLength });
      assert.equal(X.amdSignatureProfileError(w), null, `${product} ${w.subjectCn} carries AMD's PSS profile`);
      assert.equal(w.keyUsage.keyCertSign, true); assert.equal(w.keyUsage.critical, true); assert.equal(w.isCA, true);
    }
    assert.equal(ark.fp256, AMD_ARK_SHA256.get(product), "the ARK is the pinned root");
    assert.deepEqual(await X.verifyCertificateSignature(ark, ark), { ok: true, why: null });
    assert.equal(X.issuedError(ask, ark), null); assert.deepEqual(await X.verifyCertificateSignature(ask, ark), { ok: true, why: null });
    assert.equal(nArk.verify(nArk.publicKey), true); assert.equal(nAsk.checkIssued(nArk) && nAsk.verify(nArk.publicKey), true, "Node agrees");
    // not issued: the ASK under the wrong ARK (another product's), and an issuer whose key usage lacks keyCertSign
    const other = (await load(chains[product === "Genoa" ? "Milan" : "Genoa"]))[1];
    assert.match(X.issuedError(ask, other), /issuer name is not/);
    assert.match(X.issuedError(ask, { ...ark, keyUsage: { keyCertSign: false, critical: true } }), /keyCertSign/);
    assert.equal((await X.verifyCertificateSignature(ask, other)).ok, false, "the wrong key does not verify");
  }
});

test("the real VCEKs (Genoa, Turin): EC P-384, signed by the ASK, AMD extensions present, and the PSP's report signature verifies in WebCrypto", async () => {
  const cases = [
    ["Genoa", read(new URL("genoa-tinfoil/vcek-kds-amd.der", F)), gunzipSync(Buffer.from(JSON.parse(text(new URL("genoa-tinfoil/rad.json", F))).body, "base64"))],
    ["Turin", read(new URL("turin-m4a/vcek-kds-amd.der", F)), Buffer.from((JSON.parse(text(new URL("turin-m4a/doc.json", F))).doc ?? JSON.parse(text(new URL("turin-m4a/doc.json", F)))).report, "base64")],
  ];
  for (const [product, vcekDer, report] of cases) {
    const [ask] = await load(chains[product]), vcek = await X.loadCertificate(vcekDer), n = new X509Certificate(Buffer.from(vcekDer));
    assert.deepEqual(vcek.key, { type: "ec", curve: "P-384", curveOid: X.OID.secp384r1 });
    assert.equal(vcek.subjectCn, "SEV-VCEK"); assert.equal(vcek.issuerCn, `SEV-${product}`); assert.equal(vcek.validFrom, n.validFrom); assert.equal(vcek.validTo, n.validTo);
    assert.equal(X.issuedError(vcek, ask), null); assert.deepEqual(await X.verifyCertificateSignature(vcek, ask), { ok: true, why: null });
    for (const o of ["1.3.6.1.4.1.3704.1.3.1", "1.3.6.1.4.1.3704.1.3.3", "1.3.6.1.4.1.3704.1.4"]) assert.ok(vcek.extensions.has(o), `extension ${o}`);
    const p = parseReportStrict(report);
    assert.deepEqual(await X.verifyReportSignature(p, vcek), { ok: true, why: null });
    const flipped = Buffer.from(report); flipped[0x2a0] ^= 1;
    assert.equal((await X.verifyReportSignature(parseReportStrict(flipped), vcek)).why, "VCEK signature over the report is invalid");
    const big = Buffer.from(report); big.fill(0xff, 0x2a0, 0x2a0 + 48);
    assert.equal((await X.verifyReportSignature(parseReportStrict(big), vcek)).why, "signature r or s is out of range for P-384");
    // a key of the wrong type as the signer (the ASK, RSA-4096): both builds refuse before any curve is asked, same words
    const [askW] = await load(chains[product]), askN = new X509Certificate(chains[product].split(/(?=-----BEGIN CERTIFICATE-----)/).filter((x) => x.includes("CERTIFICATE"))[0]);
    assert.equal((await X.verifyReportSignature(p, askW)).why, "VCEK public key is not EC P-384"); assert.equal(nodeReportSignature(p, askN).why, "VCEK public key is not EC P-384");
    // the WHOLE chain through the provider, against Node's checkChain: same outcome, same words
    const w = await WEB_CRYPTO.checkChain({ vcekDer, chainPem: chains[product], product, now: NOW, roots: AMD_ARK_SHA256 });
    const nd = nodeCheckChain({ vcekDer: Buffer.from(vcekDer), chainPem: chains[product], product, now: NOW, roots: AMD_ARK_SHA256 });
    assert.equal(w.ok, true, w.why); assert.deepEqual(w.reasons, nd.reasons); assert.equal(WEB_CRYPTO.certFp(w.vcek), nd.vcek.fingerprint256.replace(/:/g, "").toLowerCase());
    const wrong = await WEB_CRYPTO.checkChain({ vcekDer, chainPem: chains[product === "Genoa" ? "Turin" : "Genoa"], product, now: NOW, roots: AMD_ARK_SHA256 });
    const nWrong = nodeCheckChain({ vcekDer: Buffer.from(vcekDer), chainPem: chains[product === "Genoa" ? "Turin" : "Genoa"], product, now: NOW, roots: AMD_ARK_SHA256 });
    assert.equal(wrong.ok, false); assert.equal(wrong.why, nWrong.why);
  }
});

test("MEASURED strictness: three non-canonical encodings of the genuine Genoa ARK that Node's OpenSSL accepts are refused here", async () => {
  const [, ark] = X.pemCertificates(chains.Genoa);
  const top = tlv(ark, 0), len = top.end - top.start;
  const nonMinimal = X.concatBytes(new Uint8Array([0x30, 0x83, (len >> 16) & 255, (len >> 8) & 255, len & 255]), ark.subarray(top.start));
  const indefinite = X.concatBytes(new Uint8Array([0x30, 0x80]), ark.subarray(top.start), new Uint8Array([0, 0]));
  const trailing = X.concatBytes(ark, new Uint8Array([0]));
  for (const [name, der, re] of [["non-minimal length", nonMinimal, /non-minimal/], ["indefinite length", indefinite, /indefinite/], ["trailing byte", trailing, /trailing/]]) {
    const n = new X509Certificate(Buffer.from(der)); assert.equal(n.verify(n.publicKey), true, `Node accepts and verifies the ${name} encoding (measured)`);
    assert.throws(() => X.parseCertificate(der), re, `the browser build refuses the ${name} encoding`);
  }
  const bits = Uint8Array.from(ark); { const [, , sv] = children(ark, top); bits[sv.start] = 1; }
  assert.throws(() => X.parseCertificate(bits), /unused bits/);
});

test("PSS parameters come from the certificate, under AMD's profile: an honest salt-32 certificate verifies in Node and is refused here; a patched outer AlgorithmIdentifier is refused by both", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-x509-")), o = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  o(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k.pem", "-out", "s32.pem", "-days", "30", "-subj", "/CN=SALT32", "-sha384", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:32"]);
  o(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "k2.pem", "-out", "s48.pem", "-days", "30", "-subj", "/CN=SALT48", "-sha384", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:48"]);
  const s32 = X.pemToDer(fs.readFileSync(path.join(dir, "s32.pem"), "utf8")), s48 = X.pemToDer(fs.readFileSync(path.join(dir, "s48.pem"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  const n32 = new X509Certificate(Buffer.from(s32)); assert.equal(n32.verify(n32.publicKey), true, "Node verifies the honest salt-32 certificate (measured)");
  const w32 = X.parseCertificate(s32); assert.equal(X.amdSignatureProfileError(w32), "PSS salt length is not 48"); assert.equal((await X.verifyCertificateSignature(w32, w32)).ok, false);
  const w48 = X.parseCertificate(s48); assert.equal(X.amdSignatureProfileError(w48), null, "OpenSSL's encoding (trailer field absent) is the same profile"); assert.equal((await X.verifyCertificateSignature(w48, w48)).ok, true);
  const [, ark] = X.pemCertificates(chains.Genoa), patched = Uint8Array.from(ark);
  const outer = X.parseCertificate(ark).sigAlg, idx = Buffer.from(ark).indexOf(Buffer.from(outer)), rel = Buffer.from(outer).indexOf(Buffer.from([0xa2, 0x03, 0x02, 0x01, 0x30]));
  patched[idx + rel + 4] = 0x20;
  const nP = new X509Certificate(Buffer.from(patched)); assert.equal(nP.verify(nP.publicKey), false, "Node refuses (the two AlgorithmIdentifiers differ)");
  assert.match(X.amdSignatureProfileError(X.parseCertificate(patched)), /two AlgorithmIdentifiers differ/);
});

test("the three real CRLs: profile, ARK signature and the revoked serial agree with Node; a flipped byte or the wrong ARK is refused", async () => {
  for (const product of ["Genoa", "Milan", "Turin"]) {
    const [, ark] = await load(chains[product]), crlDer = read(new URL(`amd/${product}-crl.der`, F)), crl = parseCrl(crlDer);
    assert.equal(X.amdPssProfileError(crl.sigAlgDer), null); assert.deepEqual(await X.verifyCrlSignature(crl, ark), { ok: true, why: null });
    const w = await webCrlAuthentic({ crlDer, ark, now: NOW }), n = nodeCrlAuthentic({ crlDer: Buffer.from(crlDer), ark: new X509Certificate(chains[product].split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE"))[1]), now: NOW });
    assert.equal(w.ok, true, w.why); assert.equal(n.ok, true); assert.deepEqual(w.crl.revoked, n.crl.revoked);
    if (product === "Genoa") assert.ok(crl.revoked.some((e) => e.serial === "020001"), "Genoa's CRL revokes serial 020001");
    const flipped = Uint8Array.from(crlDer); flipped[crlDer.length - 1] ^= 1;
    assert.equal((await webCrlAuthentic({ crlDer: flipped, ark, now: NOW })).why, "CRL signature does not verify with the pinned ARK");
    const otherArk = (await load(chains[product === "Genoa" ? "Milan" : "Genoa"]))[1];
    assert.equal((await webCrlAuthentic({ crlDer, ark: otherArk, now: NOW })).why, "CRL issuer is not the pinned ARK");
  }
});

test("the served (hosted-format) certificate: DNS SANs, the host rule, and the hpke/hatt binding agree with Node's tls-binding", async () => {
  const certPem = text(new URL("genoa-tinfoil/tls-cert.pem", F)), rad = JSON.parse(text(new URL("genoa-tinfoil/rad.json", F)));
  const report = gunzipSync(Buffer.from(rad.body, "base64")), hpke = report.subarray(0x70, 0x90).toString("hex");
  const cert = await X.loadCertificate(X.pemToDer(certPem)), sans = X.dnsSans(cert), n = new X509Certificate(certPem);
  assert.ok(sans.includes("inference.tinfoil.sh")); assert.equal(n.checkHost("inference.tinfoil.sh"), "inference.tinfoil.sh");
  assert.equal(X.hostMatches(sans, "inference.tinfoil.sh"), true); assert.equal(X.hostMatches(sans, "INFERENCE.tinfoil.sh"), true);
  assert.equal(X.hostMatches(sans, "other.tinfoil.sh"), false); assert.equal(X.hostMatches(sans, ""), false); assert.equal(X.hostMatches(sans, "inference.tinfoil.sh."), false);
  assert.equal(X.hostMatches(["*.example.com"], "a.example.com"), true); assert.equal(X.hostMatches(["*.example.com"], "a.b.example.com"), false);
  assert.equal(X.hostMatches(["*.com"], "example.com"), false); assert.equal(X.hostMatches(["f*o.example.com"], "foo.example.com"), false, "no partial wildcards (stricter than OpenSSL)");
  for (const [host, doc, key] of [["inference.tinfoil.sh", rad, hpke], ["other.tinfoil.sh", rad, hpke], ["inference.tinfoil.sh", { ...rad, body: rad.body.slice(0, -4) + "AAAA" }, hpke], ["inference.tinfoil.sh", rad, "00".repeat(32)]]) {
    const w = await webHosted({ certPem, host, doc, hpkeKeyHex: key, now: NOW }), nd = nodeHosted({ certPem, host, doc, hpkeKeyHex: key, now: NOW });
    assert.deepEqual(w, nd, `host=${host}`);
  }
  assert.equal((await webHosted({ certPem, host: "inference.tinfoil.sh", doc: rad, hpkeKeyHex: hpke, now: new Date("2030-01-01T00:00:00Z") })).reasons.at(-1),
    nodeHosted({ certPem, host: "inference.tinfoil.sh", doc: rad, hpkeKeyHex: hpke, now: new Date("2030-01-01T00:00:00Z") }).reasons.at(-1));
});
