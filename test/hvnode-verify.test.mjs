// relay/hvnode-verify.mjs, the NucBox node's attach evidence "windows-hv-node/v1" (enclave-5d's frame at
// windows/node-hv-identity 852f3c1d; the contract docs/security/nucbox-custom-vm-verifier.md). On REAL bytes: enclave-d1's
// boot-68 tpmattest session (test/fixtures/hvnode/boot68-2026-09-25, from dbe615b0; Secure Boot ON, test signing off) in
// capture mode (its quote carries the raw nonce), with d1's seven negative controls; and the real boot-64 legacy enclave
// evidence re-presented as hv-node, refused on its boot state whatever policy flag is passed. On SYNTHETIC worlds
// (test/fixtures/vbs-synthetic.mjs: our own CA, EK, AK and IDKS): the full transcript, possession, domain separation from
// the retired VBS-enclave transcript, and every production-policy refusal. What a pass means is stated in every result:
// a host-attested boot state, no TEE claim, the host not excluded, the firmware not independently pinned.
//   run: node --test test/hvnode-verify.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyHvNodeEvidence, hvNodeBinding, retiredFormat, HVNODE_FORMAT, HVNODE_BIND_DOMAIN, HVNODE_OMISSIONS, HVNODE_SCOPE } from "../relay/hvnode-verify.mjs";
import { vbsBinding, VBS_FORMAT } from "../relay/vbs-verify.mjs";
import { VBS_DEFAULT_EK_ROOTS } from "../relay/vbs-policy.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote, modulusOf } from "./fixtures/vbs-synthetic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B68 = path.join(HERE, "fixtures", "hvnode", "boot68-2026-09-25");
const ROOTS = fs.readFileSync(VBS_DEFAULT_EK_ROOTS, "utf8");
const sha = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const b64 = (b) => Buffer.from(b).toString("base64");
const kv = (f) => Object.fromEntries(fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => /^\S+ /.test(l)).map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)]));
const fails = (r, re) => r.checks.some((c) => re.test(c.name) && !c.ok);

// ---- the real boot-68 session, as d1's quote-verify.mjs reads it
function boot68() {
  for (const [f, h] of Object.entries(JSON.parse(fs.readFileSync(path.join(B68, "SOURCE.json"), "utf8")).files)) assert.equal(sha(fs.readFileSync(path.join(B68, f))).toString("hex"), h, `fixture ${f} is the recorded bytes`);
  const k = kv(path.join(B68, "keys.txt")), a = kv(path.join(B68, "activate.txt")), q = kv(path.join(B68, "quote.txt")), p0 = kv(path.join(B68, "pcr0.txt"));
  const sec = JSON.parse(fs.readFileSync(path.join(B68, "verifier-inputs-after-session.json"), "utf8"));
  const log = fs.readFileSync(path.join(B68, "measuredboot-0000000068.log"));
  const ev = { ek: { cert: b64(Buffer.from(k["ek-cert"], "hex")), chain: [] }, quote: { attest: b64(Buffer.from(q.attest, "hex")), sig: b64(Buffer.from(q.sig, "hex")), aikPub: b64(Buffer.from(q["aik-pub"], "hex")) },
               credential: b64(Buffer.from(a.credential, "hex")), log: b64(log), pcr0: String(p0.pcr).split(" ").pop() };
  return { ev, sec, ekDer: Buffer.from(k["ek-cert"], "hex"), aikName: Buffer.from(k["aik-name"], "hex") };
}
const run68 = (B, { ev = B.ev, sec = B.sec, mintedFor = { ekCert: B.ekDer, aikName: B.aikName }, policy = { ekRoots: ROOTS } } = {}) =>
  verifyHvNodeEvidence({ evidence: ev, capture: { quoteExtraData: Buffer.from(sec.nonce, "hex") }, expectedCredential: Buffer.from(sec.credential, "hex"), mintedFor }, policy);

test("REAL boot 68 (capture mode): every TPM and boot check passes; the result is a host-attested boot state, not admissible from a recording, host not excluded, firmware not pinned; the IDKS of that boot is recorded", () => {
  const B = boot68(); const r = run68(B);
  assert.equal(r.ok, true, r.reasons.join("\n")); assert.equal(r.capture, true); assert.equal(r.admissible, false, "a recording is never an admission");
  assert.equal(r.format, HVNODE_FORMAT); assert.equal(r.tier, "hv-node"); assert.equal(r.technology, "windows-tpm-host"); assert.equal(r.hostExcluded, false); assert.equal(r.teeCpu, null); assert.equal(r.measurement, null);
  assert.deepEqual(r.omissions, ["platform-firmware-unpinned"]);
  assert.equal(r.boot.secureBoot, 1); assert.ok(r.boot.testSigning.length && r.boot.testSigning.every((v) => v === 0));
  assert.match(r.boot.idksModulusSha256, /^402f2281[0-9a-f]{52}01a9$/, "the boot-68 IDKS enclave-d1 measured (402f2281...01a9)");
  assert.equal(r.boot.ekCertSha256, B.sec.ekCertSha256); assert.equal(r.boot.akName, B.sec.aikName); assert.equal(r.hostStatement, null);
  assert.ok(r.checks.some((c) => /^8 binding: capture mode/.test(c.name) && c.ok)); assert.ok(!r.checks.some((c) => /^8 possession/.test(c.name)), "possession is not exercised on a recording");
});

test("REAL boot 68: enclave-d1's seven negative controls, each refused at the named check; a policy flag asking for test signing changes nothing", () => {
  const B = boot68();
  const clone = () => JSON.parse(JSON.stringify(B.ev));
  const flip = (s, i) => { const b = Buffer.from(s, "base64"); b[i % b.length] ^= 1; return b.toString("base64"); };
  const controls = [
    ["replay: the same quote against a new nonce", () => run68(B, { sec: { ...B.sec, nonce: randomBytes(32).toString("hex") } }), /^4 quote: extraData == challenge/],
    ["one bit of the quote body", () => { const e = clone(); e.quote.attest = flip(e.quote.attest, 40); return run68(B, { ev: e }); }, /^4 quote: (signature|TPMS_ATTEST)/],
    ["one bit of the quote signature", () => { const e = clone(); e.quote.sig = flip(e.quote.sig, 7); return run68(B, { ev: e }); }, /^4 quote: signature/],
    ["a credential this verifier never minted", () => run68(B, { sec: { ...B.sec, credential: randomBytes(32).toString("hex") } }), /^3 credential/],
    ["minted for a different AK name", () => { const n = Buffer.from(B.aikName); n[5] ^= 1; return run68(B, { mintedFor: { ekCert: B.ekDer, aikName: n } }); }, /^2 aik: name/],
    ["one byte of a PCR 12 record", () => { const e = clone(); const b = Buffer.from(e.log, "base64"); const k = b.indexOf(Buffer.from([0x23, 0x00, 0x05, 0x00])); assert.ok(k > 0); b[k + 40] ^= 1; e.log = b.toString("base64"); return run68(B, { ev: e }); }, /^5 log: every SIPA record|^4 quote: PCR digest/],
    ["an unpinned EK root", () => run68(B, { policy: { ekRoots: "" } }), /^1 ek: chains to a pinned/],
  ];
  for (const [name, f, re] of controls) { const r = f(); assert.equal(r.ok, false, name); assert.ok(fails(r, re), `${name}: refused at ${re} (failed: ${r.reasons.join(" | ")})`); assert.equal(r.tier, null); assert.equal(r.boot, null); }
  const relaxed = run68(B, { policy: { ekRoots: ROOTS, allowTestSigning: true, measurements: ["00".repeat(32)], pcr0: ["11".repeat(32)] } });
  assert.deepEqual(relaxed.checks, run68(B).checks, "no policy key other than the EK roots is read");
  // no mint record at all: fail closed
  const unminted = run68(B, { mintedFor: null }); assert.equal(unminted.ok, false); assert.ok(fails(unminted, /^1 ek: the certificate the credential was minted for/) && fails(unminted, /^2 aik: name/));
});

test("REAL boot-64 legacy enclave evidence re-presented as hv-node: refused on its boot state (Secure Boot off, test signing on) even with a test-signing flag; the legacy format itself is retired", () => {
  const FIX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "vbs", "boot64-evidence.json"), "utf8"));
  const r = verifyHvNodeEvidence({ evidence: FIX.body, capture: { quoteExtraData: Buffer.from(FIX.capture.quoteExtraData, "hex") }, expectedCredential: randomBytes(32), mintedFor: { ekCert: Buffer.from(FIX.body.ek.cert, "base64"), aikName: Buffer.alloc(34) } }, { ekRoots: ROOTS, allowTestSigning: true });
  assert.equal(r.ok, false); assert.ok(fails(r, /^5 log: Secure Boot on/), r.reasons.join(" | ")); assert.ok(fails(r, /^5 log: TESTSIGNING == 0/));
  assert.match(retiredFormat(VBS_FORMAT), /retired \(Steven, 2026-09-25\).*never stands in for a custom-VM report/); assert.equal(retiredFormat(HVNODE_FORMAT), null); assert.equal(retiredFormat("anything-else/v1"), null);
});

// ---- the REAL full-transcript capture (enclave-d1, c54eea70): the node's frame as the relay receives it
const CAP = path.join(HERE, "fixtures", "hvnode", "capture-20260925-061116");
function capture() {
  for (const [f, h] of Object.entries(JSON.parse(fs.readFileSync(path.join(CAP, "SOURCE.json"), "utf8")).files)) assert.equal(sha(fs.readFileSync(path.join(CAP, f))).toString("hex"), h, `fixture ${f} is the recorded bytes`);
  const frame = JSON.parse(fs.readFileSync(path.join(CAP, "frame.json"), "utf8"));
  const minted = JSON.parse(fs.readFileSync(path.join(CAP, "minted-for.json"), "utf8"));
  return { frame, ev: JSON.parse(Buffer.from(frame.rad.body, "base64").toString("utf8")), spki: Buffer.from(frame.rad.transportKey, "base64"),
           nonce: Buffer.from(fs.readFileSync(path.join(CAP, "nonce.hex"), "utf8").trim(), "hex"), credential: Buffer.from(fs.readFileSync(path.join(CAP, "expected-credential.hex"), "utf8").trim(), "hex"),
           mintedFor: { ekCert: Buffer.from(minted.ekCert, "base64"), aikName: Buffer.from(minted.aikName, "hex") } };
}
const runCap = (C, o = {}) => verifyHvNodeEvidence({ evidence: o.ev ?? C.ev, nonce: o.nonce ?? C.nonce, transportKeySpki: o.spki ?? C.spki, expectedCredential: o.credential ?? C.credential, mintedFor: o.mintedFor ?? C.mintedFor }, { ekRoots: ROOTS });

test("REAL full transcript (enclave-d1's boot-68 capture, the node's own frame): verified end to end, every check passing, the scope stated: host attach only", () => {
  const C = capture();
  assert.equal(C.frame.rad.format, HVNODE_FORMAT); assert.ok(C.spki.equals(Buffer.from(fs.readFileSync(path.join(CAP, "capture-spki.b64"), "utf8").trim(), "base64")));
  const r = runCap(C);
  assert.equal(r.ok, true, r.reasons.join("\n")); assert.equal(r.capture, false); assert.equal(r.admissible, true);
  assert.equal(r.scope, HVNODE_SCOPE); assert.match(r.scope, /never tenant capacity, never an isolation or TEE label/);
  assert.equal(r.tier, "hv-node"); assert.equal(r.technology, "windows-tpm-host"); assert.equal(r.hostExcluded, false); assert.equal(r.teeCpu, null); assert.equal(r.measurement, null);
  assert.deepEqual(r.omissions, ["platform-firmware-unpinned"]); assert.equal(r.checks.length, 31, "all 31 checks run"); assert.ok(r.checks.every((c) => c.ok));
  assert.match(r.boot.idksModulusSha256, /^402f2281[0-9a-f]{52}01a9$/, "the same boot-68 IDKS as the independent session");
  assert.equal(r.boot.akName, "000bab98d6b8990b16ff1e7cbbc5ecc2a51dc7f26db1cb9501052813f03cc563134c", "the NULL-hierarchy AK: the same name as the 05:39 session, same boot");
  assert.ok(r.hostStatement && r.hostStatement.sha256);
  const recorded = JSON.parse(fs.readFileSync(path.join(CAP, "verdict.json"), "utf8"));
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), recorded.checks.map((c) => [c.name, c.ok]), "the same 31 verdicts enclave-d1 recorded on the box");
});

test("REAL full transcript: enclave-d1's six negatives, each refused: replay, a quote-body bit, a possession-signature bit, a different transport key, a never-minted credential, a substituted statement", () => {
  const C = capture();
  const flip = (s, i) => { const b = Buffer.from(s, "base64"); b[i % b.length] ^= 1; return b.toString("base64"); };
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const cases = [
    ["replay: a new nonce", runCap(C, { nonce: randomBytes(32) }), /^4 quote: extraData == challenge/],
    ["a quote-body bit", runCap(C, { ev: { ...C.ev, quote: { ...C.ev.quote, attest: flip(C.ev.quote.attest, 40) } } }), /^4 quote: (signature|TPMS_ATTEST)/],
    ["a possession-signature bit", runCap(C, { ev: { ...C.ev, signature: flip(C.ev.signature, 5) } }), /^8 possession/],
    ["a different transport key", runCap(C, { spki: other }), /^4 quote: extraData == challenge|^8 possession/],
    ["a credential never minted", runCap(C, { credential: randomBytes(32) }), /^3 credential/],
    ["a substituted statement", runCap(C, { ev: { ...C.ev, statement: b64(Buffer.from(JSON.stringify({ stated: true, hostExcluded: true }))) } }), /^4 quote: extraData == challenge/],
  ];
  for (const [name, r, re] of cases) { assert.equal(r.ok, false, name); assert.equal(r.admissible, false, name); assert.ok(fails(r, re), `${name}: refused at ${re}; failed: ${r.reasons.join(" | ")}`); }
});

// ---- synthetic worlds: the full transcript
const world = haveOpenssl ? makeVbsWorld(tmpdir("hvnode-")) : null;
const STATEMENT = Buffer.from(JSON.stringify({ stated: true, backend: "custom-type1", tier: "t0-hv", hostExcluded: false, derivations: [] }));
function frame(w, { nonce = randomBytes(32), statement = STATEMENT, log = {}, quote = {}, signer = w.transport.privateKey, spki = w.transport.spki, bound: boundOverride = null, credential = randomBytes(32) } = {}) {
  const bound = boundOverride || hvNodeBinding(spki, nonce, statement);
  const L = buildLog({ idksPub: w.idks.publicKey, ...log });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: sha(bound), ...quote });
  const ev = { proves: "an admin-level process on this TPM's host, in this measured boot state, chose and holds this transport key; it proves nothing about isolation or host exclusion",
               statement: b64(statement), signature: b64(cryptoSign(null, bound, signer)), log: b64(L.log), quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(w.aik.tpmtPublic) },
               credential: b64(credential), ek: { cert: b64(w.ek.cert), chain: [b64(w.ca.inter)] }, pcr0: w.pcr0.toString("hex"), platform: {} };
  return { ev, nonce, credential, bound, L };
}
const verifyFrame = (w, f, extra = {}) => verifyHvNodeEvidence({ evidence: f.ev, nonce: f.nonce, transportKeySpki: w.transport.spki, expectedCredential: f.credential, mintedFor: { ekCert: w.ek.cert, aikName: w.aik.name }, ...extra }, { ekRoots: w.ca.bundlePem });

test("synthetic, the full transcript: verified and admissible, the statement bound and recorded (never read), the IDKS recorded; the 4-byte statement \"null\" is accepted as the node's 'manager unavailable'", { skip: !haveOpenssl && "openssl absent" }, () => {
  const f = frame(world); const r = verifyFrame(world, f);
  assert.equal(r.ok, true, r.reasons.join("\n")); assert.equal(r.admissible, true); assert.equal(r.capture, false); assert.equal(r.tier, "hv-node"); assert.equal(r.hostExcluded, false); assert.equal(r.measurement, null);
  assert.deepEqual(r.omissions, [...HVNODE_OMISSIONS]); assert.equal(r.boot.idksModulusSha256, sha(modulusOf(world.idks.publicKey)).toString("hex"));
  assert.equal(r.hostStatement.sha256, sha(STATEMENT).toString("hex")); assert.equal(r.hostStatement.json.hostExcluded, false); assert.match(r.hostStatement.note, /never read for admission/);
  assert.ok(r.checks.some((c) => /^8 possession/.test(c.name) && c.ok));
  // the binding layout: domain || spki(44) || nonce(32) || sha256(statement)(32), 24 + 108 bytes
  assert.equal(f.bound.length, HVNODE_BIND_DOMAIN.length + 44 + 32 + 32); assert.ok(f.bound.subarray(0, HVNODE_BIND_DOMAIN.length).equals(Buffer.from("enclave-hv-node-bind-v1\n")));
  const n = frame(world, { statement: Buffer.from("null") }); const rn = verifyFrame(world, n); assert.equal(rn.ok, true, rn.reasons.join("\n")); assert.equal(rn.hostStatement.json, null);
  // even a "stated" hostExcluded:true in the statement changes nothing: the relay sets false
  const lie = frame(world, { statement: Buffer.from(JSON.stringify({ stated: true, hostExcluded: true, tier: "t3" })) }); const rl = verifyFrame(world, lie);
  assert.equal(rl.ok, true); assert.equal(rl.hostExcluded, false); assert.equal(rl.tier, "hv-node");
});

test("synthetic refusals: replay, foreign key, missing or wrong possession signature, statement swapped after binding, the retired VBS transcript (domain separation), and the production boot policy with no dev tier", { skip: !haveOpenssl && "openssl absent" }, () => {
  const refused = (r, re, why) => { assert.equal(r.ok, false, why); assert.equal(r.admissible, false); assert.ok(fails(r, re), `${why}: expected a failure at ${re}; failed: ${r.reasons.join(" | ")}`); };
  const f = frame(world);
  refused(verifyFrame(world, f, { nonce: randomBytes(32) }), /^4 quote: extraData == challenge/, "another nonce (replay)");
  const other = generateKeyPairSync("ed25519"), otherSpki = other.publicKey.export({ type: "spki", format: "der" });
  refused(verifyFrame(world, f, { transportKeySpki: otherSpki }), /^4 quote: extraData == challenge|^8 possession/, "a foreign transport key presented");
  refused(verifyFrame(world, { ...f, ev: { ...f.ev, signature: undefined } }), /^8 possession/, "no possession signature");
  refused(verifyFrame(world, frame(world, { signer: other.privateKey })), /^8 possession/, "signed by another key over the same transcript");
  refused(verifyFrame(world, { ...f, ev: { ...f.ev, statement: b64(Buffer.from(JSON.stringify({ stated: true, hostExcluded: false, tier: "edited" }))) } }), /^4 quote: extraData == challenge/, "the statement swapped after binding");
  refused(verifyFrame(world, { ...f, ev: { ...f.ev, statement: "" } }), /^8 binding/, "an empty statement");
  refused(verifyFrame(world, { ...f, ev: { ...f.ev, statement: b64(Buffer.alloc(16 * 1024 + 1, 0x20)) } }), /^8 binding/, "a statement over the cap");
  // domain separation: a quote over the RETIRED VBS-enclave transcript for the same key and nonce is not an hv-node quote
  const vb = vbsBinding(world.transport.spki, world.padKey, f.nonce);
  refused(verifyFrame(world, { ...frame(world, { nonce: f.nonce, bound: vb }), nonce: f.nonce }), /^4 quote: extraData == challenge|^8 possession/, "the retired VBS transcript");
  // production boot policy, no dev tier
  refused(verifyFrame(world, frame(world, { log: { secureBoot: 0 } })), /^5 log: Secure Boot on/, "Secure Boot off");
  refused(verifyFrame(world, frame(world, { log: { fields: { TESTSIGNING: 1 } } })), /^5 log: TESTSIGNING == 0/, "test signing on");
  refused(verifyFrame(world, frame(world, { log: { fields: { OSKERNELDEBUG: 1 } } })), /^5 log: OSKERNELDEBUG == 0/, "kernel debugging");
  refused(verifyFrame(world, frame(world, { log: { fields: { VBS_HVCI_POLICY: 0 } } })), /^5 log: VBS_HVCI_POLICY == 1/, "HVCI off");
  refused(verifyFrame(world, frame(world, { quote: { select: [7, 12, 13, 14] } })), /^4 quote: PCR selection is exactly/, "a quote without PCR 0");
  const t = frame(world); refused(verifyFrame(world, { ...t, ev: { ...t.ev, log: b64(Buffer.from(t.ev.log, "base64").subarray(0, 200)) } }), /^5 log: parses/, "a truncated log");
  refused(verifyHvNodeEvidence({ evidence: f.ev, nonce: f.nonce, transportKeySpki: world.transport.spki, expectedCredential: f.credential, mintedFor: null }, { ekRoots: world.ca.bundlePem }), /minted for/, "no mint record");
  const ts = frame(world, { log: { fields: { TESTSIGNING: 1 }, secureBoot: 0 } });
  const tsr = verifyHvNodeEvidence({ evidence: ts.ev, nonce: ts.nonce, transportKeySpki: world.transport.spki, expectedCredential: ts.credential, mintedFor: { ekCert: world.ek.cert, aikName: world.aik.name } }, { ekRoots: world.ca.bundlePem, allowTestSigning: true });
  refused(tsr, /^5 log: TESTSIGNING == 0/, "allowTestSigning is not honoured");
});
