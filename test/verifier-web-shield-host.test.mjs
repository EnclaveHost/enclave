// verifier/web/shield-host.mjs: the Enclave Shield host (hv-node) verified in a browser, the credential minted by the page.
// The rules are relay/hvnode-core.mjs for both builds; what differs is who answers the crypto (node:crypto there, WebCrypto
// + noble here) and who walks the EK chain (X509Certificate there, verifier/web/tpm-certs.mjs here). So the claim tested is
// PARITY: on every real session (boot 68 in capture mode, d1's full-transcript capture, the retired boot-64 evidence) and
// every synthetic one, accepted or refused at any check, the two builds return the same checks (name, pass, skipped), the
// same verdict and the same boot record. Then the page's MakeCredential (Node's activateCredential and the boot-64 KAT),
// the two-request flow against a stand-in relay+node, and the BUNDLED build (esbuild, node:crypto aliased to the throwing
// shim, run in a context with no Node globals), so a pass resting on a leaked Node API fails here.
//   run: node --test test/verifier-web-shield-host.test.mjs   (the bundle test needs the `buffer` package; NODE_PATH may name it)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomBytes, createHash, sign as cryptoSign, generateKeyPairSync, X509Certificate, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyHvNodeEvidence, hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { loadTpmRoots, verifyEkChain, AMD_FTPM_ROOT_SHA256 } from "../relay/vbs-verify.mjs";
import { VBS_DEFAULT_EK_ROOTS } from "../relay/vbs-policy.mjs";
import { makeCredential, activateCredential, kdfa } from "../relay/vbs-credential.mjs";
import { verifyHvNodeEvidenceWeb, verifyShieldHostWith, groupChecks, SHIELD_CHECK_ORDER, SHIELD_CHECKS } from "../verifier/web/shield-host.mjs";
import { parseTpmCertificate, loadTpmRootsWeb, verifyEkChainWeb, TPM_EK_ROOTS_PEM, TPM_EK_ROOT_PINS } from "../verifier/web/tpm-certs.mjs";
import { makeCredentialWeb, kdfaSha256 } from "../verifier/web/tpm-credential.mjs";
import { verifyShieldHostWeb } from "../verifier/web/index.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote, tpmtPublicOf, nameOf } from "./fixtures/vbs-synthetic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "..");
const ROOTS = fs.readFileSync(VBS_DEFAULT_EK_ROOTS, "utf8");
const sha = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const b64 = (b) => Buffer.from(b).toString("base64");
const hex = (b) => Buffer.from(b).toString("hex");
const kv = (f) => Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => /^\S+ /.test(l)).map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
const flip = (s, i) => { const b = Buffer.from(s, "base64"); b[i % b.length] ^= 1; return b.toString("base64"); };
const fails = (r, re) => r.checks.some((c) => re.test(c.name) && !c.ok);

// the two builds on one input: equal checks (name, pass, skipped), verdict and boot record; returns both
const shape = (r) => ({ ok: r.ok, admissible: r.admissible, tier: r.tier, capture: r.capture, omissions: r.omissions, hostExcluded: r.hostExcluded, boot: r.boot,
                        hostStatement: r.hostStatement, checks: r.checks.map((c) => [c.name, c.ok, !!c.skipped]), reasons: r.reasons.length });
async function both(input, nodePolicy, webPolicy = nodePolicy) {
  const n = verifyHvNodeEvidence(input, nodePolicy), w = await verifyHvNodeEvidenceWeb(input, webPolicy);
  assert.deepEqual(shape(w), shape(n), "the browser build's verdict equals the relay's");
  // the detail text too, except where the certificate readers word a parse or chain failure their own way
  const own = /^1 ek: (certificate and chain parse|chains to a pinned TPM root)/;
  assert.deepEqual(w.checks.filter((c) => !own.test(c.name)).map((c) => c.detail), n.checks.filter((c) => !own.test(c.name)).map((c) => c.detail));
  return { n, w };
}

// ---- real sessions -------------------------------------------------------------------------------------------------------
const B68 = path.join(HERE, "fixtures", "hvnode", "boot68-2026-09-25");
function boot68() {
  const k = kv(path.join(B68, "keys.txt")), a = kv(path.join(B68, "activate.txt")), q = kv(path.join(B68, "quote.txt")), p0 = kv(path.join(B68, "pcr0.txt"));
  const sec = JSON.parse(fs.readFileSync(path.join(B68, "verifier-inputs-after-session.json"), "utf8"));
  const ev = { ek: { cert: b64(Buffer.from(k["ek-cert"], "hex")), chain: [] }, quote: { attest: b64(Buffer.from(q.attest, "hex")), sig: b64(Buffer.from(q.sig, "hex")), aikPub: b64(Buffer.from(q["aik-pub"], "hex")) },
               credential: b64(Buffer.from(a.credential, "hex")), log: b64(fs.readFileSync(path.join(B68, "measuredboot-0000000068.log"))), pcr0: String(p0.pcr).split(" ").pop() };
  return { ev, sec, ekDer: Buffer.from(k["ek-cert"], "hex"), aikName: Buffer.from(k["aik-name"], "hex") };
}
const in68 = (B, { ev = B.ev, sec = B.sec, mintedFor = { ekCert: B.ekDer, aikName: B.aikName } } = {}) =>
  ({ evidence: ev, capture: { quoteExtraData: Buffer.from(sec.nonce, "hex") }, expectedCredential: Buffer.from(sec.credential, "hex"), mintedFor });

const CAP = path.join(HERE, "fixtures", "hvnode", "capture-20260925-061116");
function capture() {
  const frame = JSON.parse(fs.readFileSync(path.join(CAP, "frame.json"), "utf8"));
  const minted = JSON.parse(fs.readFileSync(path.join(CAP, "minted-for.json"), "utf8"));
  return { frame, ev: JSON.parse(Buffer.from(frame.rad.body, "base64").toString("utf8")), spki: Buffer.from(frame.rad.transportKey, "base64"),
           nonce: Buffer.from(fs.readFileSync(path.join(CAP, "nonce.hex"), "utf8").trim(), "hex"), credential: Buffer.from(fs.readFileSync(path.join(CAP, "expected-credential.hex"), "utf8").trim(), "hex"),
           mintedFor: { ekCert: Buffer.from(minted.ekCert, "base64"), aikName: Buffer.from(minted.aikName, "hex") } };
}
const inCap = (C, o = {}) => ({ evidence: o.ev ?? C.ev, nonce: o.nonce ?? C.nonce, transportKeySpki: o.spki ?? C.spki, expectedCredential: o.credential ?? C.credential, mintedFor: o.mintedFor ?? C.mintedFor });

test("the embedded EK roots are relay/fixtures/tpm-roots.pem's certificates, byte for byte; the one pin is AMD's fTPM root; both readers agree on the bundle", async () => {
  const der = (pem) => pem.split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("BEGIN CERTIFICATE")).map((p) => new X509Certificate(p).raw);
  assert.deepEqual(der(TPM_EK_ROOTS_PEM).map(hex), der(ROOTS).map(hex));
  assert.deepEqual([...TPM_EK_ROOT_PINS], [AMD_FTPM_ROOT_SHA256]);
  const n = loadTpmRoots(ROOTS), w = await loadTpmRootsWeb(TPM_EK_ROOTS_PEM);
  assert.deepEqual(w.pins, n.pins); assert.equal(w.intermediates.length, n.intermediates.length);
  assert.equal(w.roots[0].subject, n.roots[0].subject.replace(/\n/g, ", ")); assert.equal(w.intermediates[0].subject, n.intermediates[0].subject.replace(/\n/g, ", "));
  assert.equal(w.intermediates[0].fp256, "1745706c9e0163b128166cfa3875c9b675423e7097d8eecd73a88d1b22950cd9");
  // the real AMD EK certificate: same fields as Node's reader, and the same chain
  const ek = boot68().ekDer, nc = new X509Certificate(ek), wc = parseTpmCertificate(new Uint8Array(ek));
  assert.equal(wc.serialHex, nc.serialNumber); assert.equal(wc.subject, nc.subject ?? "", "an empty subject (Node: undefined)"); assert.equal(wc.issuer, nc.issuer.replace(/\n/g, ", ")); assert.equal(wc.ca, nc.ca);
  assert.equal(wc.validFrom, nc.validFrom); assert.equal(wc.validTo, nc.validTo); assert.equal(wc.fp256, nc.fingerprint256.replace(/:/g, "").toLowerCase());
  const rn = verifyEkChain(nc, [], n, Date.now()), rw = await verifyEkChainWeb(wc, [], w, Date.now());
  assert.equal(rw.ok, true); assert.equal(rn.ok, true); assert.deepEqual(rw.path.map((c) => c.fp256), rn.path.map((c) => c.fingerprint256.replace(/:/g, "").toLowerCase()));
  const later = Date.parse("2051-01-01T00:00:00Z");
  assert.equal((await verifyEkChainWeb(wc, [], w, later)).reason, verifyEkChain(nc, [], n, later).reason, "an expired EK words the same");
});

test("REAL boot 68 (capture mode) and d1's seven negative controls: the browser build gives the relay's verdict on each", async () => {
  const B = boot68(), P = { ekRoots: ROOTS }, PW = { ekRoots: TPM_EK_ROOTS_PEM };
  const { w } = await both(in68(B), P, PW);
  assert.equal(w.ok, true, w.reasons.join("\n")); assert.equal(w.admissible, false); assert.match(w.boot.idksModulusSha256, /^402f2281[0-9a-f]{52}01a9$/);
  const clone = () => JSON.parse(JSON.stringify(B.ev));
  const controls = [
    [in68(B, { sec: { ...B.sec, nonce: randomBytes(32).toString("hex") } }), /^4 quote: extraData == challenge/],
    [(() => { const e = clone(); e.quote.attest = flip(e.quote.attest, 40); return in68(B, { ev: e }); })(), /^4 quote: (signature|TPMS_ATTEST)/],
    [(() => { const e = clone(); e.quote.sig = flip(e.quote.sig, 7); return in68(B, { ev: e }); })(), /^4 quote: signature/],
    [in68(B, { sec: { ...B.sec, credential: randomBytes(32).toString("hex") } }), /^3 credential/],
    [(() => { const n = Buffer.from(B.aikName); n[5] ^= 1; return in68(B, { mintedFor: { ekCert: B.ekDer, aikName: n } }); })(), /^2 aik: name/],
    [(() => { const e = clone(); const b = Buffer.from(e.log, "base64"); const k = b.indexOf(Buffer.from([0x23, 0x00, 0x05, 0x00])); b[k + 40] ^= 1; e.log = b.toString("base64"); return in68(B, { ev: e }); })(), /^5 log: every SIPA record|^4 quote: PCR digest/],
    [in68(B, { mintedFor: null }), /minted for/],
  ];
  for (const [input, re] of controls) { const r = await both(input, P, PW); assert.equal(r.w.ok, false); assert.ok(fails(r.w, re), `${re}: ${r.w.reasons.join(" | ")}`); }
  const unpinned = await both(in68(B), { ekRoots: "" }, { ekRoots: "" }); assert.ok(fails(unpinned.w, /^1 ek: chains to a pinned/));
  const legacy = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "vbs", "boot64-evidence.json"), "utf8"));
  const lr = await both({ evidence: legacy.body, capture: { quoteExtraData: Buffer.from(legacy.capture.quoteExtraData, "hex") }, expectedCredential: randomBytes(32), mintedFor: { ekCert: Buffer.from(legacy.body.ek.cert, "base64"), aikName: Buffer.alloc(34) } },
                        { ekRoots: ROOTS, allowTestSigning: true }, { ekRoots: TPM_EK_ROOTS_PEM, allowTestSigning: true });
  assert.ok(fails(lr.w, /^5 log: Secure Boot on/) && fails(lr.w, /^5 log: TESTSIGNING == 0/), "the retired boot-64 box refused on its boot state in both builds");
});

test("REAL full transcript (d1's capture, the node's own frame): all 31 checks pass in the browser build as in the relay's; d1's six negatives refuse in both", async () => {
  const C = capture(), P = { ekRoots: ROOTS }, PW = { ekRoots: TPM_EK_ROOTS_PEM, ekRootPins: [...TPM_EK_ROOT_PINS] };
  const { w } = await both(inCap(C), P, PW);
  assert.equal(w.ok, true, w.reasons.join("\n")); assert.equal(w.admissible, true); assert.equal(w.checks.length, 31); assert.equal(w.hostExcluded, false);
  const recorded = JSON.parse(fs.readFileSync(path.join(CAP, "verdict.json"), "utf8"));
  assert.deepEqual(w.checks.map((c) => [c.name, c.ok]), recorded.checks.map((c) => [c.name, c.ok]), "the same 31 verdicts enclave-d1 recorded on the box");
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  for (const [input, re] of [
    [inCap(C, { nonce: randomBytes(32) }), /^4 quote: extraData == challenge/],
    [inCap(C, { ev: { ...C.ev, quote: { ...C.ev.quote, attest: flip(C.ev.quote.attest, 40) } } }), /^4 quote: (signature|TPMS_ATTEST)/],
    [inCap(C, { ev: { ...C.ev, signature: flip(C.ev.signature, 5) } }), /^8 possession/],
    [inCap(C, { spki: other }), /^4 quote: extraData == challenge|^8 possession/],
    [inCap(C, { credential: randomBytes(32) }), /^3 credential/],
    [inCap(C, { ev: { ...C.ev, statement: b64(Buffer.from(JSON.stringify({ stated: true, hostExcluded: true }))) } }), /^4 quote: extraData == challenge/],
  ]) { const r = await both(input, P, PW); assert.equal(r.w.ok, false); assert.ok(fails(r.w, re), `${re}: ${r.w.reasons.join(" | ")}`); }
});

// ---- synthetic worlds: every refusal the brief names, in both builds -------------------------------------------------------
const world = haveOpenssl ? makeVbsWorld(tmpdir("vweb-shield-")) : null;
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
// the node's evidence for (nonce, credential), as relay/hvnode-verify.mjs receives it; hooks bend one input
function frame(w, { nonce = randomBytes(32), statement = STATEMENT, log = {}, quote = {}, signer = w.transport.privateKey, credential = randomBytes(32), aikPub = w.aik.tpmtPublic, ek = w.ek } = {}) {
  const bound = hvNodeBinding(w.transport.spki, nonce, statement);
  const L = buildLog({ idksPub: w.idks.publicKey, ...log });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: nameOf(aikPub), pcrs: L.pcrs, pcr0: w.pcr0, extraData: sha(bound), ...quote });
  const ev = { statement: b64(statement), signature: b64(cryptoSign(null, bound, signer)), log: b64(L.log), quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(aikPub) },
               credential: b64(credential), ek: { cert: b64(ek.cert), chain: [b64(w.ca.inter)] }, pcr0: w.pcr0.toString("hex"), platform: {} };
  return { ev, nonce, credential, L };
}
const inFrame = (w, f, extra = {}) => ({ evidence: f.ev, nonce: f.nonce, transportKeySpki: w.transport.spki, expectedCredential: f.credential, mintedFor: { ekCert: w.ek.cert, aikName: w.aik.name }, ...extra });

test("synthetic: the full transcript accepted by both; then each refusal (pinned root, on-die, aikName, AIK attributes, credential, quote signature, extraData, PCR selection, PCR digest, an edited SIPA record, TESTSIGNING, Secure Boot, possession, statement) refused by BOTH at the named check", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const P = { ekRoots: world.ca.bundlePem };
  const ok = await both(inFrame(world, frame(world)), P);
  assert.equal(ok.w.ok, true, ok.w.reasons.join("\n")); assert.equal(ok.w.admissible, true); assert.equal(ok.w.checks.length, 31);
  const stm = makeVbsWorld(tmpdir("vweb-shield-stm-"), { manufacturer: "53544D20" });   // STMicro: a discrete TPM, not on-die
  const attrsAik = tpmtPublicOf(world.aik.publicKey, { attributes: 0x00070072 });       // + decrypt
  const f = frame(world);
  const edited = (() => { const g = frame(world); const b = Buffer.from(g.ev.log, "base64"); const o = g.L.offsets.find((x) => x.pcr === 12); b[o.dataAt + 20] ^= 1; return { ...g, ev: { ...g.ev, log: b.toString("base64") } }; })();
  const cases = [
    ["EK not chaining to a pinned root", inFrame(world, f), /^1 ek: chains to a pinned TPM root/, { ekRoots: ROOTS }, { ekRoots: TPM_EK_ROOTS_PEM }],
    ["a pinned bundle whose root the pins exclude", inFrame(world, f), /^1 ek: chains to a pinned TPM root/, { ekRoots: world.ca.bundlePem, ekRootPins: ["00".repeat(32)] }],
    ["a non-on-die manufacturer", (() => { const g = frame(stm, { ek: stm.ek }); return { ...inFrame(stm, g), mintedFor: { ekCert: stm.ek.cert, aikName: stm.aik.name } }; })(), /^1 ek: on-die/, { ekRoots: stm.ca.bundlePem }],
    ["aikName not the minted name", inFrame(world, f, { mintedFor: { ekCert: world.ek.cert, aikName: Buffer.concat([Buffer.from([0, 0x0b]), randomBytes(32)]) } }), /^2 aik: name/],
    ["AIK attributes with decrypt", (() => { const g = frame(world, { aikPub: attrsAik }); return inFrame(world, g, { mintedFor: { ekCert: world.ek.cert, aikName: nameOf(attrsAik) } }); })(), /^2 aik: attributes/],
    ["a credential never minted", inFrame(world, f, { expectedCredential: randomBytes(32) }), /^3 credential/],
    ["a quote signature byte flipped", inFrame(world, { ...f, ev: { ...f.ev, quote: { ...f.ev.quote, sig: flip(f.ev.quote.sig, 9) } } }), /^4 quote: signature/],
    ["extraData != challenge (another nonce)", inFrame(world, f, { nonce: randomBytes(32) }), /^4 quote: extraData == challenge/],
    ["a PCR selection without PCR 0", inFrame(world, frame(world, { quote: { select: [7, 12, 13, 14] } })), /^4 quote: PCR selection is exactly/],
    ["a PCR digest mismatch (another PCR 0)", inFrame(world, { ...f, ev: { ...f.ev, pcr0: "ab".repeat(32) } }), /^4 quote: PCR digest/],
    ["an edited SIPA record", inFrame(world, edited), /^5 log: every SIPA record|^4 quote: PCR digest/],
    ["TESTSIGNING=1", inFrame(world, frame(world, { log: { fields: { TESTSIGNING: 1 } } })), /^5 log: TESTSIGNING == 0/],
    ["Secure Boot off", inFrame(world, frame(world, { log: { secureBoot: 0 } })), /^5 log: Secure Boot on/],
    ["HVCI off", inFrame(world, frame(world, { log: { fields: { VBS_HVCI_POLICY: 0 } } })), /^5 log: VBS_HVCI_POLICY == 1/],
    ["the transport signature invalid", inFrame(world, { ...f, ev: { ...f.ev, signature: flip(f.ev.signature, 3) } }), /^8 possession/],
    ["signed by another key", inFrame(world, frame(world, { signer: generateKeyPairSync("ed25519").privateKey })), /^8 possession/],
    ["the statement altered", inFrame(world, { ...f, ev: { ...f.ev, statement: b64(Buffer.from(JSON.stringify({ stated: true, tier: "edited" }))) } }), /^4 quote: extraData == challenge/],
    ["no statement", inFrame(world, { ...f, ev: { ...f.ev, statement: "" } }), /^8 binding/],
    ["a truncated log", inFrame(world, { ...f, ev: { ...f.ev, log: b64(Buffer.from(f.ev.log, "base64").subarray(0, 200)) } }), /^5 log: parses/],
    ["no mint record", inFrame(world, f, { mintedFor: null }), /minted for/],
    ["an unparseable EK", inFrame(world, { ...f, ev: { ...f.ev, ek: { cert: b64(randomBytes(300)), chain: [] } } }), /^1 ek: certificate and chain parse/],
  ];
  for (const [why, input, re, np = P, wp = np] of cases) {
    const r = await both(input, np, wp);
    assert.equal(r.n.ok, false, `${why}: the relay refuses`); assert.equal(r.w.ok, false, `${why}: the browser refuses`);
    assert.ok(fails(r.w, re), `${why}: refused at ${re}; failed: ${r.w.reasons.join(" | ")}`);
  }
  const relaxed = await both(inFrame(world, frame(world, { log: { fields: { TESTSIGNING: 1 }, secureBoot: 0 } })), { ekRoots: world.ca.bundlePem, allowTestSigning: true });
  assert.equal(relaxed.w.ok, false, "allowTestSigning is not honoured by either build");
});

// ---- the page's MakeCredential ------------------------------------------------------------------------------------------
test("MakeCredential in the browser build: Node's activateCredential recovers it; the blob is byte-identical to the relay's for the same seed; the boot-64 KAT holds; KDFa equals the relay's", async () => {
  const ek = generateKeyPairSync("rsa", { modulusLength: 2048 }), spki = new Uint8Array(ek.publicKey.export({ type: "spki", format: "der" }));
  for (const len of [1, 20, 32]) {
    const name = Buffer.concat([Buffer.from([0, 0x0b]), randomBytes(32)]), credential = randomBytes(len), seed = randomBytes(32);
    const w = await makeCredentialWeb(spki, new Uint8Array(name), new Uint8Array(credential), new Uint8Array(seed));
    assert.ok(activateCredential(ek.privateKey, name, Buffer.from(w.credentialBlob), Buffer.from(w.secret)).equals(credential), "the EK holder recovers the page's credential");
    assert.equal(hex(w.credentialBlob), hex(makeCredential(ek.publicKey, name, credential, { seed }).credentialBlob));
    const other = Buffer.from(name); other[9] ^= 1;
    assert.throws(() => activateCredential(ek.privateKey, other, Buffer.from(w.credentialBlob), Buffer.from(w.secret)), /integrity/, "only for the key it was minted for");
  }
  const kat = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "vbs", "make-credential-kat.json"), "utf8"));
  const katSpki = parseTpmCertificate(new Uint8Array(Buffer.from(kat.ekPublic, "hex"))).spki;
  const r = await makeCredentialWeb(katSpki, new Uint8Array(Buffer.from(kat.aikName, "hex")), new Uint8Array(Buffer.from(kat.credential, "hex")), new Uint8Array(Buffer.from(kat.seed, "hex")));
  assert.equal(hex(r.credentialBlob), kat.credentialBlob); assert.equal(hex(r.encIdentity), kat.encIdentity); assert.equal(hex(r.integrityHMAC), kat.integrityHMAC); assert.equal(r.secret.length, 256);
  assert.equal(hex(kdfaSha256(Buffer.alloc(32, 7), "STORAGE", Buffer.alloc(34, 1), new Uint8Array(0), 392)), hex(kdfa("sha256", Buffer.alloc(32, 7), "STORAGE", Buffer.alloc(34, 1), Buffer.alloc(0), 392)));
  await assert.rejects(makeCredentialWeb(spki, new Uint8Array(33), new Uint8Array(32), new Uint8Array(32)), /aikName must be 34 bytes/);
});

// ---- the two-request flow against a stand-in relay + node ------------------------------------------------------------------
// The stub plays the relay and the node's TPM: request 1 answers the host's keys for our nonce; request 2 activates OUR
// credential with the EK's private key (the TPM's job) and returns the node's document. It refuses to be called with a
// `this` (a browser's fetch throws "Illegal invocation" then).
function standIn(w, { mutate = {}, ...o } = {}) {
  const calls = [];
  let nonce = null;
  async function fetchStub(url, init) {
    "use strict";
    if (this !== undefined) throw new TypeError("Illegal invocation");
    calls.push({ url, init, body: JSON.parse(init.body) });
    const answer = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
    if (o.status1 && url.endsWith("/attestation")) return answer(o.status1, { error: "no_host", message: "not attached" });
    if (url.endsWith("/attestation")) {
      nonce = Buffer.from(calls.at(-1).body.nonce, "hex");
      const keys = { ek: b64(w.ek.cert), ekChain: [b64(w.ca.inter)], aikPub: b64(w.aik.tpmtPublic), aikName: b64(w.aik.name), ...(mutate.keys || {}) };
      return answer(200, { name: "nucbox-test", mode: mutate.mode ?? "hv-node", session: "ab12".repeat(8), nonce: mutate.nonce ?? hex(nonce), keys });
    }
    if (url.endsWith("/attestation/credential")) {
      const b = calls.at(-1).body;
      assert.equal(b.session, "ab12".repeat(8));
      const credential = mutate.credential ?? activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(b.credentialBlob, "base64"), Buffer.from(b.secret, "base64"));
      const f = frame(w, { nonce, credential, ...(mutate.frame || {}) });
      const ev = mutate.evidence ? mutate.evidence(f.ev) : f.ev;
      return answer(200, { name: "nucbox-test", mode: "hv-node", nonce: hex(nonce), fetchedAt: "2026-10-15T12:00:00.000Z",
                           document: { format: "windows-hv-node/v1", body: b64(Buffer.from(JSON.stringify(ev))), transportKey: b64(w.transport.spki), padKey: "ignored" } });
    }
    return answer(404, { error: "not_found" });
  }
  return { fetchImpl: fetchStub, calls };
}
const rnd = (n) => webcrypto.getRandomValues(new Uint8Array(n));
const runFlow = (w, s, deps = {}, opts = {}) => verifyShieldHostWith({ fetchImpl: s.fetchImpl, randomBytes: rnd, now: () => new Date(), ekRoots: w.ca.bundlePem, ekRootPins: [w.ca.rootPin], ...deps },
                                                                  { apiBase: "https://api.test", name: "nucbox-test", ...opts });

test("the flow: our nonce reaches the relay, our credential is minted here and recovered by that TPM, and a full pass is LIMITED with both omissions stated, every check true, the facts filled", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const s = standIn(world);
  const v = await runFlow(world, s);
  assert.equal(v.status, "limited", v.reasons.join("\n")); assert.equal(v.technology, "windows-tpm-host"); assert.equal(v.name, "nucbox-test");
  assert.deepEqual(v.checkOrder, [...SHIELD_CHECK_ORDER]); for (const k of v.checkOrder) { assert.equal(v.checks[k], true, k); assert.ok(v.checkLabels[k].length > 20, k); }
  assert.deepEqual(v.omissions, ["platform-firmware-unpinned", "host-not-excluded"]);
  assert.match(v.omissionLabels["host-not-excluded"], /host OS and its operator remain trusted.*Enclave Shield isolates apps from each other.*does not exclude the host/);
  assert.match(v.summary, /does not exclude the host/); assert.doesNotMatch(JSON.stringify(v), /vbs-like/i);
  const facts = Object.fromEntries(v.facts);
  assert.equal(facts.Box, "nucbox-test"); assert.match(facts["TPM manufacturer"], /^AMD \(id:414D4400\)$/); assert.equal(facts["PCR 0 (platform firmware, unpinned)"], hex(world.pcr0));
  assert.equal(facts["Transport key sha256"], hex(sha(world.transport.spki))); assert.equal(facts["Boot counter (measured-boot log)"], "228"); assert.equal(facts["Quoting key name"], hex(world.aik.name));
  assert.equal(facts["Nonce (drawn by this page)"], `${s.calls[0].body.nonce.slice(0, 32)}…`); assert.match(s.calls[0].body.nonce, /^[0-9a-f]{64}$/);
  assert.match(facts["EK root (pinned)"], new RegExp(`CN=Synthetic TPM Root sha256:${world.ca.rootPin}`));
  assert.equal(s.calls.length, 2); assert.equal(s.calls[0].url, "https://api.test/v1/enclaves/nucbox-test/attestation"); assert.equal(s.calls[1].url, "https://api.test/v1/enclaves/nucbox-test/attestation/credential");
  assert.equal(s.calls[0].init.method, "POST"); assert.equal(s.calls[0].init.credentials, "omit"); assert.equal(s.calls[0].init.redirect, "error");
  // groupChecks covers every check the relay names: none falls outside a key
  const n = verifyHvNodeEvidence(inFrame(world, frame(world)), { ekRoots: world.ca.bundlePem });
  for (const c of n.checks) assert.ok(SHIELD_CHECKS.some((g) => g.re.test(c.name)), `${c.name} maps to a site key`);
  assert.deepEqual(Object.values(groupChecks(n.checks)), SHIELD_CHECK_ORDER.map(() => true));
});

test("the flow refuses: a relay standing in for the TPM (a credential it made up), our keys check before minting, another nonce, the boot state, the embedded roots against a foreign EK; and errors are errors, never a pass", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const run = (mutate, deps, opts) => { const s = standIn(world, { mutate }); return runFlow(world, s, deps, opts).then((v) => ({ v, s })); };
  let { v, s } = await run({ credential: randomBytes(32) });
  assert.equal(v.status, "rejected"); assert.equal(v.checks.credential, false); assert.equal(v.checks["ek-chain"], true);
  ({ v, s } = await run({ keys: { aikName: b64(Buffer.concat([Buffer.from([0, 0x0b]), randomBytes(32)])) } }));
  assert.equal(v.status, "rejected"); assert.equal(v.checks.aik, false); assert.equal(s.calls.length, 1, "nothing is minted for keys that do not check"); assert.match(v.reasons.join(), /aikName is not 0x000B/);
  ({ v, s } = await run({ keys: { aikPub: b64(tpmtPublicOf(world.aik.publicKey, { attributes: 0x00070072 })) } }));
  assert.equal(v.status, "rejected"); assert.equal(v.checks.aik, false); assert.equal(s.calls.length, 1);
  ({ v } = await run({ keys: { ek: b64(randomBytes(400)) } })); assert.equal(v.status, "rejected"); assert.equal(v.checks["ek-chain"], false);
  ({ v } = await run({ nonce: "00".repeat(32) })); assert.equal(v.status, "rejected"); assert.match(v.reasons.join(), /another nonce/);
  ({ v } = await run({ frame: { log: { fields: { TESTSIGNING: 1 } } } })); assert.equal(v.status, "rejected"); assert.equal(v.checks["boot-state"], false);
  ({ v } = await run({ frame: { log: { secureBoot: 0 } } })); assert.equal(v.status, "rejected"); assert.equal(v.checks["boot-state"], false);
  ({ v } = await run({ evidence: (ev) => ({ ...ev, signature: flip(ev.signature, 1) }) })); assert.equal(v.status, "rejected"); assert.equal(v.checks.possession, false);
  // the site's own pins (the default) refuse the synthetic CA
  ({ v } = await run({}, { ekRoots: undefined, ekRootPins: undefined })); assert.equal(v.status, "rejected"); assert.equal(v.checks["ek-chain"], false);
  // errors
  ({ v } = await run({ mode: "metal" })); assert.equal(v.status, "error"); assert.match(v.reasons.join(), /not an Enclave Shield host/);
  ({ v } = await (async () => { const s2 = standIn(world, { status1: 404 }); return { v: await runFlow(world, s2) }; })()); assert.equal(v.status, "error"); assert.match(v.reasons.join(), /HTTP 404: not attached/);
  const big = await verifyShieldHostWith({ fetchImpl: async () => ({ status: 200, text: async () => "x".repeat(300 * 1024) }), randomBytes: rnd }, { name: "n1" });
  assert.equal(big.status, "error"); assert.match(big.reasons.join(), /exceeds/);
  const thrown = await verifyShieldHostWith({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, randomBytes: rnd }, { name: "n1" });
  assert.equal(thrown.status, "error"); assert.match(thrown.reasons.join(), /Failed to fetch/);
  const slow = await verifyShieldHostWith({ fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), randomBytes: rnd }, { name: "n1", timeoutMs: 50 });
  assert.equal(slow.status, "error"); assert.match(slow.reasons.join(), /no answer within 50 ms/);
  const broken = await verifyShieldHostWith({ fetchImpl: s.fetchImpl, randomBytes: () => { throw new Error("no entropy"); } }, { name: "n1" });
  assert.equal(broken.status, "error"); assert.match(broken.reasons.join(), /no entropy/);
  assert.equal((await verifyShieldHostWith({ fetchImpl: s.fetchImpl, randomBytes: rnd }, { name: "../x" })).status, "error");
});

// The real capture through the flow: the page's randomness replays the session's nonce and credential, the stand-in returns
// the node's recorded keys and document, and the default (embedded) roots verify it. verifyShieldHostWeb, the export itself.
function replayCapture() {
  const C = capture(), queue = [C.nonce, C.credential, randomBytes(32)];
  const calls = [];
  async function fetchImpl(url, init) {
    "use strict";
    if (this !== undefined) throw new TypeError("Illegal invocation");
    calls.push({ url, body: JSON.parse(init.body) });
    const answer = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
    if (url.endsWith("/attestation")) return answer({ name: "nucbox-k11-4", mode: "hv-node", session: "s1", nonce: calls[0].body.nonce,
                                                     keys: { ek: b64(C.mintedFor.ekCert), ekChain: [], aikPub: C.ev.quote.aikPub, aikName: b64(C.mintedFor.aikName) } });
    return answer({ name: "nucbox-k11-4", mode: "hv-node", nonce: calls[0].body.nonce, fetchedAt: "2026-09-25T06:11:16Z", document: { format: "windows-hv-node/v1", body: C.frame.rad.body, transportKey: C.frame.rad.transportKey } });
  }
  return { C, queue, calls, fetchImpl, getRandomValues: (a) => { a.set(queue.shift()); return a; } };
}
test("REAL capture through verifyShieldHostWeb with the embedded AMD roots: LIMITED, every check true, the AMD facts", async () => {
  const R = replayCapture();
  const real = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = R.getRandomValues;
  let v; try { v = await verifyShieldHostWeb({ apiBase: "https://api.test", name: "nucbox-k11-4", fetchImpl: R.fetchImpl }); } finally { globalThis.crypto.getRandomValues = real; }
  assert.equal(v.status, "limited", v.reasons.join("\n")); for (const k of v.checkOrder) assert.equal(v.checks[k], true, k);
  const facts = Object.fromEntries(v.facts);
  assert.equal(facts["TPM manufacturer"], "AMD (id:414D4400)"); assert.equal(facts["EK certificate serial"], "0E94D37CF2ADD0DAAF76224C2D3C57E2"); assert.equal(facts["EK certificate subject"], "(empty)");
  assert.equal(facts["EK root (pinned)"], `CN=AMDTPM sha256:${AMD_FTPM_ROOT_SHA256}`); assert.match(facts["IDKS modulus sha256"], /^402f2281[0-9a-f]{52}01a9$/);
  assert.equal(R.calls[0].body.nonce, hex(R.C.nonce));
});

// ---- the bundle: built as verifier/web/build.mjs builds it, run where no Node global exists ----------------------------------
test("BUNDLED (esbuild, node:crypto aliased to the throwing shim, Buffer from the `buffer` package) and run in a context with no process, require or Buffer: the real capture verifies through verifyShieldHostWeb; a synthetic session agrees with the relay; the bundled MakeCredential is recovered by Node", async (t) => {
  const { build } = await import("esbuild");
  const { OPTIONS } = await import("../verifier/web/build.mjs");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vweb-shield-bundle-")), "bundle.js");
  try {
    await build({ entryPoints: [path.join(REPO, OPTIONS.entry)], outfile: out, bundle: true, format: "iife", globalName: "EnclaveVerifier", platform: OPTIONS.platform, target: [OPTIONS.target],
                  absWorkingDir: REPO, logLevel: "silent", nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
                  alias: Object.fromEntries(Object.entries(OPTIONS.alias).map(([k, v]) => [k, path.join(REPO, v)])), inject: OPTIONS.inject.map((p) => path.join(REPO, p)) });
  } catch (e) {
    if (/Could not resolve "buffer"/.test(e.message)) return t.skip("the `buffer` package is not installed (npm ci, or NODE_PATH naming a node_modules that has it)");
    throw e;
  }
  const R = replayCapture();
  const ctx = { crypto: { subtle: webcrypto.subtle, getRandomValues: R.getRandomValues }, TextEncoder, TextDecoder, atob, btoa, AbortController, setTimeout, clearTimeout, console, URL };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(out, "utf8"), ctx, { filename: "bundle.js" });
  for (const g of ["process", "require", "Buffer", "global"]) assert.equal(vm.runInContext(`typeof ${g}`, ctx), "undefined", `${g} is not reachable in the context`);
  const W = ctx.EnclaveVerifier;
  const v = await W.verifyShieldHostWeb({ apiBase: "https://api.test", name: "nucbox-k11-4", fetchImpl: R.fetchImpl });
  assert.equal(v.status, "limited", v.reasons.join("\n")); for (const k of v.checkOrder) assert.equal(v.checks[k], true, k);
  if (world) {
    ctx.crypto.getRandomValues = (a) => webcrypto.getRandomValues(a);
    const input = inFrame(world, frame(world)), n = verifyHvNodeEvidence(input, { ekRoots: world.ca.bundlePem });
    const inner = vm.runInContext("(a) => new Uint8Array(a)", ctx), toU8 = (b) => inner(Array.from(b));   // bytes of the page's own realm
    const wIn = { evidence: JSON.parse(JSON.stringify(input.evidence)), nonce: toU8(input.nonce), transportKeySpki: toU8(input.transportKeySpki), expectedCredential: toU8(input.expectedCredential),
                  mintedFor: { ekCert: toU8(input.mintedFor.ekCert), aikName: toU8(input.mintedFor.aikName) } };
    const w = await W.verifyHvNodeEvidenceWeb(wIn, { ekRoots: world.ca.bundlePem });
    assert.equal(w.ok, true, w.reasons.join("\n")); assert.deepEqual(JSON.parse(JSON.stringify(w.checks.map((c) => [c.name, c.ok]))), n.checks.map((c) => [c.name, c.ok]), "the page realm's verdict, read back");
    const bad = await W.verifyHvNodeEvidenceWeb({ ...wIn, evidence: { ...wIn.evidence, signature: flip(wIn.evidence.signature, 2) } }, { ekRoots: world.ca.bundlePem });
    assert.equal(bad.ok, false); assert.ok(fails(bad, /^8 possession/));
    const ek = generateKeyPairSync("rsa", { modulusLength: 2048 }), name = Buffer.concat([Buffer.from([0, 0x0b]), randomBytes(32)]), cred = randomBytes(32);
    const m = await W.makeCredentialWeb(toU8(ek.publicKey.export({ type: "spki", format: "der" })), toU8(name), toU8(cred), toU8(randomBytes(32)));
    assert.ok(activateCredential(ek.privateKey, name, Buffer.from(m.credentialBlob), Buffer.from(m.secret)).equals(cred));
  }
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});
