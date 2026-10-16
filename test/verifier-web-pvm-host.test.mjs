// The browser's pVM host verifier (verifier/web/pvm-host.mjs, verifier/web/avf.mjs) against the relay's own
// (relay/pvm-app-attest.mjs, relay/avf-verify.mjs), run unbundled under Node 22 as the other web suites are:
//   - parity: every real document the Node verifier accepts (the marketplace probe capture and a LIVE host answer from the
//     relay's fresh-attestation route) is accepted with the same result, field for field; every real AVF chain verifies
//     with the same measurement and components; the restated pins and AVF extension reader equal the relay's on every real
//     leaf, on every single-byte flip of a leaf, and on a malformed-DER corpus;
//   - mutations: a flipped byte in each certificate, another challenge, another nonce, another transport key, a flipped
//     instanceSig / appKeySig / tlsKeySig, another or restated identity, an unknown field, a code hash or authority off the
//     list, an unpinned root, an expired leaf - each refused by BOTH, with the same reasons;
//   - verifyPvmHostWeb end to end against a stub relay serving a fixture-derived answer (the stub's nonce is the fixture's,
//     injected through randomBytes): limited on the operator's lists, verified on the caller's pins, rejected for another
//     attach key, nonce, app or root, "error" (never a pass) for a failed fetch, a non-200, an oversized or thrown answer;
//   - the bundle: verifier/web/build.mjs's options (node:crypto shimmed to throw) bundle it with no Node module on the path,
//     and Chrome for Testing runs the bundle to the same verdicts (skipped, with the reason, where the `buffer` package or the
//     browser is absent; ENCLAVE_WEB_NODE_PATHS adds esbuild nodePaths for a checkout that lacks `buffer`).
//   run: node --test test/verifier-web-pvm-host.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { X509Certificate, generateKeyPairSync, createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "../relay/pvm-app-attest.mjs";
import * as nodeAvf from "../relay/avf-verify.mjs";
import * as webAvf from "../verifier/web/avf.mjs";
import { verifyPvmEvidenceWeb, reasonCheck, CHECK_LABELS, OMISSION_LABELS } from "../verifier/web/pvm-host.mjs";
import { verifyPvmHostWeb, APP_FROM_EVIDENCE, OPERATOR_STATED } from "../verifier/web/index.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8"));
const probe = read("test/fixtures/pvm-v4/probe-device.json"), live = read("test/fixtures/pvm-v4/host-live-20261016.json");
const CASES = [
  { name: "probe-device (marketplace capture)", fx: probe, nonce: probe.doc.nonce, rootPins: undefined },
  { name: "host-live-20261016 (the relay's route)", fx: live, nonce: live.nonce, rootPins: live.rootPins },
];
const expectOf = (c, over = {}) => ({ nonce: c.nonce, appId: c.fx.appSha256, allowedRuntimeIds: [c.fx.runtimeId], allowedCodeHashes: [c.fx.codeHash],
  allowedAuthorityHashes: [c.fx.authorityHash], ...(c.rootPins ? { rootPins: c.rootPins } : {}), now: Date.parse(c.fx.capturedAt), ...over });
const both = async (doc, expect) => ({ node: verifyPvmAppEvidence(doc, expect), web: await verifyPvmEvidenceWeb(doc, expect) });
const flipCert = (doc, i, at) => { const der = Buffer.from(doc.chain[i], "base64"); der[at(der)] ^= 1; return { ...doc, chain: doc.chain.map((c, j) => (j === i ? der.toString("base64") : c)) }; };
const flipHex = (s, i = 5) => { const b = Buffer.from(s, "hex"); b[i] ^= 1; return b.toString("hex"); };
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the restated root pins equal relay/avf-verify.mjs's", () => {
  assert.deepEqual([...webAvf.GOOGLE_ATTESTATION_ROOT_SHA256], [...nodeAvf.GOOGLE_ATTESTATION_ROOT_SHA256]);
  for (const k of ["AVF_ATTESTATION_EXTENSION_OID", "AVF_MAX_CERT_BYTES", "AVF_MAX_CHAIN_CERTS", "AVF_MAX_COMPONENTS"]) assert.equal(webAvf[k], nodeAvf[k], k);
});

test("parity: every real document the Node verifier accepts, the browser accepts with the same result", async () => {
  for (const c of CASES) {
    const { node, web } = await both(c.fx.doc, expectOf(c));
    assert.equal(node.ok, true, `${c.name}: ${node.reasons.join(" | ")}`);
    assert.deepEqual(web, node, c.name);
    assert.equal(web.measurement, c.fx.codeHash); assert.equal(web.runtimeId, c.fx.runtimeId); assert.equal(web.appId, c.fx.appSha256);
    assert.equal(web.tlsSpkiSha256, sha(Buffer.from(c.fx.doc.tlsSpki, "hex")));
  }
});

test("parity: every real AVF chain verifies to the same measurement and components, and fails the same way", async () => {
  const chains = [...["pixel10-pvm-cpu-chain", "pixel10-pvm-cpu-cpuonly-v2"].map((f) => read(`test/fixtures/avf/${f}.json`))];
  for (const fx of chains) {
    const chain = fx.chain.map((c) => Buffer.from(c, "base64"));
    const verify = (prepared, over = {}, challenge = Buffer.from(fx.challenge, "hex")) => {
      const opts = { allowedCodeHashes: [fx.codeHash], allowedAuthorityHashes: [fx.authorityHash], now: Date.parse(fx.capturedAt), ...over };
      return { node: nodeAvf.verifyAvfEvidence({ chain, challenge }, opts), web: webAvf.avfVerifier(prepared)({ chain, challenge }, opts) };
    };
    const prepared = await webAvf.prepareAvfChain(fx.chain);
    const ok = verify(prepared);
    assert.equal(ok.node.ok, true, ok.node.reasons.join(" | "));
    assert.equal(ok.web.ok, true, ok.web.reasons.join(" | "));
    assert.equal(ok.web.measurement, ok.node.measurement);
    assert.deepEqual(ok.web.components, ok.node.components);
    assert.equal(ok.web.root.fp256, nodeAvf.GOOGLE_ATTESTATION_ROOT_SHA256.get("google-key-attestation-ca1-2025"));
    for (const [over, ch] of [[{ now: Date.parse(fx.validTo) + 60_000 }], [{}, Buffer.alloc(32)], [{ allowedCodeHashes: ["b".repeat(64)] }],
                              [{ allowedAuthorityHashes: ["c".repeat(96)] }], [{ rootPins: ["ab".repeat(32)] }]]) {
      const r = verify(prepared, over, ch);
      assert.equal(r.node.ok, false); assert.deepEqual(r.web.reasons, r.node.reasons, JSON.stringify(over));
    }
  }
});

// the extension reader: every real leaf, every single-byte flip of a real leaf, and a malformed-DER corpus (built like
// test/fixtures/avf-der-malformed.mjs) give the same parse or the same error in both copies
const leaves = [probe.doc.chain[0], live.doc.chain[0], ...["pixel10-pvm-cpu-chain", "pixel10-pvm-cpu-cpuonly-v2"].map((f) => read(`test/fixtures/avf/${f}.json`).chain[0])]
  .map((c) => Buffer.from(c, "base64"));
const outcome = (parse, der) => { try { const e = parse(der); return { challenge: Buffer.from(e.challenge).toString("hex"), isVmSecure: e.isVmSecure, components: e.components }; } catch (x) { return { error: x.message }; } };
test("parity: the AVF extension reader equals relay/avf-verify.mjs's on every real leaf, every byte flip and a malformed corpus", () => {
  const enc = (tag, body) => { const n = body.length, len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]; return Buffer.concat([Buffer.from([tag, ...len]), body]); };
  const seq = (...p) => enc(0x30, Buffer.concat(p)), octet = (b) => enc(4, b), utf8 = (s) => enc(12, Buffer.from(s)), int = (b) => enc(2, Buffer.from(b));
  const yes = enc(1, Buffer.from([255])), no = enc(1, Buffer.from([0])), OIDX = Buffer.from("060b2b06010401d67902011d01", "hex");
  const comp = (...p) => seq(...(p.length ? p : [utf8("apk:anchor"), int([1]), octet(Buffer.alloc(32, 2)), octet(Buffer.alloc(64, 3))]));
  const value = (flag = yes, comps = seq(comp()), ...more) => seq(octet(Buffer.alloc(32, 1)), flag, comps, ...more);
  const wrapX = (...exts) => seq(seq(enc(0xa3, seq(...exts))), seq(), enc(3, Buffer.from([0])));
  const wrap = (v, id = OIDX) => wrapX(seq(id, octet(v)));
  const corpus = [wrap(value()), wrap(value(no)), wrap(value(yes, seq(), seq())), wrap(value(yes, seq(), octet(Buffer.alloc(0)))), wrap(value(yes, seq(), seq(int([1])))),
    ...[enc(1, Buffer.alloc(0)), enc(1, Buffer.from([0, 255])), enc(1, Buffer.from([1])), enc(0x21, Buffer.from([255]))].map((f) => wrap(value(f))),
    ...[[], [255], [128], [0, 1], [0, 0], [0, 128], [0, ...Array(32).fill(128)]].map((v) => wrap(value(yes, seq(comp(utf8("apk:anchor"), int(v), octet(Buffer.alloc(32)), octet(Buffer.alloc(64))))))),
    ...[Buffer.alloc(0), Buffer.from([0xc0, 0xaf]), Buffer.from("apk:\0a"), Buffer.alloc(1025, 97)].map((n) => wrap(value(yes, seq(comp(enc(12, n), int([1]), octet(Buffer.alloc(32)), octet(Buffer.alloc(64))))))),
    wrap(seq(octet(Buffer.alloc(32)), yes)), wrap(enc(0x31, value())), wrap(Buffer.concat([value(), Buffer.from([0])])), Buffer.concat([wrap(value()), Buffer.from([0])]),
    wrapX(seq(OIDX, octet(value())), seq(OIDX, octet(value(no)))), wrapX(seq(OIDX, no, octet(value()))), wrapX(seq(OIDX, yes, octet(value()))),
    ...["3080", "308100", "30810100", "3082008000", "3084ffffffff", "308480000000", "308401", "30850000000001"].map((h) => wrap(Buffer.from(h, "hex"))),
    seq(seq(Buffer.from([0xa3, 4, 0x30, 0])), seq(), enc(3, Buffer.from([0]))), wrap(value(), enc(6, Buffer.concat([OIDX.subarray(2), Buffer.from([0x80])]))),
    wrap(value(yes, seq(...Array.from({ length: 257 }, () => comp())))), Buffer.alloc(64 * 1024 + 1)];
  const good = wrap(value()); for (let n = 0; n < good.length; n++) corpus.push(good.subarray(0, n));
  let flips = 0;
  for (const leaf of leaves) {
    assert.deepEqual(outcome(webAvf.parseAvfExtension, leaf), outcome(nodeAvf.parseAvfExtension, leaf));
    assert.equal(outcome(webAvf.parseAvfExtension, leaf).error, undefined);
    for (let i = 0; i < leaf.length; i++) { const d = Buffer.from(leaf); d[i] ^= 0x41; corpus.push(d); flips++; }
  }
  for (const der of corpus) assert.deepEqual(outcome(webAvf.parseAvfExtension, der), outcome(nodeAvf.parseAvfExtension, der), der.toString("hex").slice(0, 80));
  assert.ok(flips > 2000 && corpus.length > flips);
});

test("mutations: each is refused by BOTH verifiers, with the same reasons, under the check it belongs to", async () => {
  const [c] = CASES.slice(1), d = c.fx.doc;   // the live document; the probe document is run through the same list below
  const otherEd = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("hex");
  const otherP256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" });
  const nonce2 = "11".repeat(32);
  const id = JSON.parse(d.identity), restated = JSON.stringify({ ...id, version: "49.0.1" }, Object.keys(id).sort());
  const mutations = (c, d) => [
    ...d.chain.flatMap((_, i) => [
      [`cert ${i}: a signature byte`, flipCert(d, i, (der) => der.length - 3), {}, "googleChain"],
      [`cert ${i}: a TBS byte`, flipCert(d, i, () => 40), {}, "googleChain"],
    ]),
    ["the leaf's challenge byte (inside the signed certificate)", flipCert(d, 0, (der) => der.indexOf(Buffer.from("2b06010401d67902011d01", "hex")) + 25), {}, "googleChain"],
    ["another challenge: the document and the caller both on another nonce", { ...d, nonce: nonce2 }, { nonce: nonce2 }, "challenge"],
    ["another nonce than the caller's", d, { nonce: nonce2 }, "nonce"],
    ["another transport key (spki)", { ...d, spki: otherEd }, {}, "challenge"],
    ["instanceSig flipped", { ...d, instanceSig: flipHex(d.instanceSig) }, {}, "instance"],
    ["appKeySig flipped", { ...d, appKeySig: flipHex(d.appKeySig) }, {}, "appKey"],
    ["tlsKeySig flipped", { ...d, tlsKeySig: flipHex(d.tlsKeySig) }, {}, "tlsKey"],
    ["another TLS key, restated consistently", { ...d, tlsSpki: otherP256.toString("hex"), transportKey: otherP256.toString("base64") }, {}, "tlsKey"],
    ["a TLS key off the curve", { ...d, tlsSpki: d.tlsSpki.slice(0, -2) + (d.tlsSpki.endsWith("00") ? "01" : "00"), transportKey: Buffer.from(d.tlsSpki.slice(0, -2) + (d.tlsSpki.endsWith("00") ? "01" : "00"), "hex").toString("base64") }, {}, null],
    ["transportKey not base64 of tlsSpki", { ...d, transportKey: otherP256.toString("base64") }, {}, "document"],
    ["appSha256 not app", { ...d, appSha256: "00".repeat(32) }, {}, "document"],
    ["another identity (version restated)", { ...d, identity: restated }, {}, "runtime"],
    ["another identity, admitted: the challenge no longer matches", { ...d, identity: restated }, { allowedRuntimeIds: [c.fx.runtimeId, sha(restated)] }, "challenge"],
    ["a non-canonical identity", { ...d, identity: d.identity.replace(",", ", ") }, {}, "runtime"],
    ["a dirty self-test", { ...d, selftest: d.selftest.replace("wx=clean", "wx=dirty") }, {}, "runtime"],
    ["an unknown extra field", { ...d, extra: 1 }, {}, "document"],
    ["v3 named on a v4 document", { ...d, format: "enclave-pvm-app-evidence/v3" }, {}, "document"],
    ["a code hash off the list", d, { allowedCodeHashes: ["b".repeat(64)] }, "release"],
    ["an authority off the list", d, { allowedAuthorityHashes: ["c".repeat(128)] }, "release"],
    ["a root not pinned", d, { rootPins: ["ab".repeat(32)] }, "googleChain"],
    ["the leaf expired", d, { now: Date.parse("2026-10-18T00:00:00Z") }, "googleChain"],
    ["the caller expects another app", d, { appId: "22".repeat(32) }, "app"],
  ];
  let n = 0;
  for (const cc of CASES) for (const [what, doc, over, check] of mutations(cc, cc.fx.doc)) {
    const { node, web } = await both(doc, expectOf(cc, over));
    assert.equal(node.ok, false, `${cc.name} / ${what}: Node accepted`);
    assert.equal(web.ok, false, `${cc.name} / ${what}: the browser accepted`);
    assert.deepEqual(web.reasons, node.reasons, `${cc.name} / ${what}`);
    if (check) assert.equal(reasonCheck(node.reasons.at(-1)), check, `${cc.name} / ${what}: ${node.reasons.at(-1)}`);
    n++;
  }
  assert.ok(n >= 2 * 30);
});

// ---- verifyPvmHostWeb against a stub relay ----
const answerOf = (fx, over = {}) => ({ name: "pixel10-pvm-cpu", mode: "avf", nonce: fx.doc.nonce, fetchedAt: fx.capturedAt, document: fx.doc,
  attachTransportKey: Buffer.from(fx.doc.spki, "hex").toString("base64"),
  operatorAllowlist: { source: "PVM_CPU_CODE_HASHES, PVM_CPU_AUTHORITY_HASHES, PVM_CPU_RUNTIME_IDS", codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash], runtimeIds: [fx.runtimeId] }, ...over });
const stub = (answer, { status = 200, seen = [] } = {}) => function (url, init) {   // a plain function: `this` must be undefined (unbound)
  if (this !== undefined) throw new TypeError("Illegal invocation");
  seen.push({ url, init });
  return Promise.resolve(new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status, headers: { "content-type": "application/json" } }));
};
const host = (fx, { answer = answerOf(fx), ...opts } = {}) => verifyPvmHostWeb({ name: "pixel10-pvm-cpu", fetchImpl: stub(answer), randomBytes: () => Uint8Array.from(Buffer.from(fx.doc.nonce, "hex")),
  now: () => new Date(fx.capturedAt), ...opts });
const pinsOf = (fx) => ({ codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash], runtimeIds: [fx.runtimeId], appId: fx.appSha256, source: "test pins" });
const shapeOk = (v) => {
  assert.deepEqual(Object.keys(v).sort(), ["checkLabels", "checkOrder", "checks", "facts", "name", "omissionLabels", "omissions", "reasons", "status", "summary", "technology"]);
  assert.equal(v.technology, "android-avf-pvm");
  assert.deepEqual(Object.keys(v.checkLabels), v.checkOrder); assert.deepEqual(Object.keys(v.checks), v.checkOrder);
  for (const o of v.omissions) assert.equal(v.omissionLabels[o], OMISSION_LABELS[o]);
  assert.ok(v.facts.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === "string" && typeof f[1] === "string"));
  assert.equal(typeof v.summary, "string");
  // never a pass with a check that did not hold
  if (v.status === "verified" || v.status === "limited") assert.ok(v.checkOrder.every((k) => v.checks[k] === true) && v.reasons.length === 0);
  if (v.status === "rejected") assert.ok(v.checkOrder.some((k) => v.checks[k] === false) && v.reasons.length > 0);
  if (v.status === "error") assert.ok(v.reasons.length === 1 && v.checkOrder.every((k) => v.checks[k] === undefined));
};
const fact = (v, k) => (v.facts.find(([x]) => x === k) || [])[1];

test("verifyPvmHostWeb: limited on the operator's lists, the app named by the evidence; our nonce reaches the relay", async () => {
  for (const fx of [probe, live]) {
    const seen = [];
    const v = await verifyPvmHostWeb({ name: "pixel10-pvm-cpu", fetchImpl: stub(answerOf(fx), { seen }), randomBytes: () => Uint8Array.from(Buffer.from(fx.doc.nonce, "hex")), now: () => new Date(fx.capturedAt) });
    shapeOk(v);
    assert.equal(v.status, "limited", v.reasons.join(" | "));
    assert.deepEqual(v.omissions, [APP_FROM_EVIDENCE, OPERATOR_STATED]);
    assert.deepEqual(v.checkOrder, ["document", "googleChain", "secureVm", "release", "runtime", "nonce", "app", "challenge", "instance", "appKey", "tlsKey", "transportKey"]);
    for (const k of v.checkOrder) assert.equal(v.checkLabels[k], CHECK_LABELS[k]);
    assert.equal(seen[0].url, `https://api.enclave.host/v1/enclaves/pixel10-pvm-cpu/attestation?nonce=${fx.doc.nonce}`);
    assert.equal(seen[0].init.redirect, "error"); assert.equal(seen[0].init.credentials, "omit");
    assert.equal(fact(v, "code hash"), fx.codeHash); assert.equal(fact(v, "runtime id"), fx.runtimeId);
    assert.match(fact(v, "app"), new RegExp(`^${fx.appSha256} \\(named by the evidence\\)$`));
    assert.equal(fact(v, "transport key"), `sha256:${sha(Buffer.from(fx.doc.spki, "hex"))}`);
    assert.equal(fact(v, "TLS key"), `sha256:${sha(Buffer.from(fx.doc.tlsSpki, "hex"))}`);
    assert.equal(fact(v, "nonce"), `${fx.doc.nonce.slice(0, 32)}… (drawn by this page)`);
    assert.match(fact(v, "expected from"), /^relay operator: PVM_CPU_CODE_HASHES/);
    assert.match(v.summary, /relay operator's list/);
  }
});

test("verifyPvmHostWeb: the caller's own pins replace the operator's and a full pass is verified; a partial pin stays limited", async () => {
  const v = await host(live, { expected: pinsOf(live) });
  shapeOk(v); assert.equal(v.status, "verified", v.reasons.join(" | ")); assert.deepEqual(v.omissions, []);
  assert.equal(fact(v, "expected from"), "test pins");
  // the caller's pins win even where the operator lists nothing
  const bare = await host(live, { expected: pinsOf(live), answer: answerOf(live, { operatorAllowlist: undefined }) });
  assert.equal(bare.status, "verified");
  const { appId: _a, ...noApp } = pinsOf(live);
  assert.deepEqual((await host(live, { expected: noApp })).omissions, [APP_FROM_EVIDENCE]);
  const partial = await host(live, { expected: { appId: live.appSha256, codeHashes: [live.codeHash] } });
  assert.equal(partial.status, "limited"); assert.deepEqual(partial.omissions, [OPERATOR_STATED]);
  // the caller's code hash replaces the operator's: a pin that is not this release refuses, though the operator lists it
  const wrong = await host(live, { expected: { ...pinsOf(live), codeHashes: ["b".repeat(64)] } });
  shapeOk(wrong); assert.equal(wrong.status, "rejected"); assert.equal(wrong.checks.release, false);
  assert.equal(wrong.checks.googleChain, true); assert.equal(wrong.checks.instance, undefined);
  // roots only narrow: CA1 alone still verifies, a non-Google root is refused before any certificate is read
  assert.equal((await host(live, { expected: { ...pinsOf(live), rootPins: [live.rootPins[1]] } })).status, "verified");
  const narrowed = await host(live, { answer: answerOf(live, { operatorAllowlist: { ...answerOf(live).operatorAllowlist, rootPins: [live.rootPins[0]] } }) });
  assert.equal(narrowed.status, "rejected"); assert.equal(narrowed.checks.googleChain, false);   // the 2022 root is not this chain's
  const foreign = await host(live, { answer: answerOf(live, { operatorAllowlist: { ...answerOf(live).operatorAllowlist, rootPins: ["ab".repeat(32)] } }) });
  assert.equal(foreign.status, "rejected"); assert.match(foreign.reasons.at(-1), /may only narrow/);
});

test("verifyPvmHostWeb: another attach key, nonce, app or document is rejected, with the check that failed", async () => {
  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const k = await host(live, { answer: answerOf(live, { attachTransportKey: otherKey }) });
  shapeOk(k); assert.equal(k.status, "rejected"); assert.equal(k.checks.transportKey, false); assert.equal(k.checks.challenge, true);
  assert.match(k.reasons.at(-1), /not the key the relay verified when the box attached/);
  // the evidence's own transportKey field (base64 of the v4 TLS key) is not the attach key
  const tls = await host(live, { answer: answerOf(live, { attachTransportKey: live.doc.transportKey }) });
  assert.equal(tls.status, "rejected"); assert.equal(tls.checks.transportKey, false);
  const none = await host(live, { answer: answerOf(live, { attachTransportKey: undefined }) });
  assert.equal(none.status, "rejected"); assert.match(none.reasons.at(-1), /stated no attach transport key/);
  // a page's own random nonce: the fixture answers another, so it is a replay
  const fresh = await host(live, { randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) });
  shapeOk(fresh); assert.equal(fresh.status, "rejected"); assert.equal(fresh.checks.nonce, false); assert.match(fresh.reasons.at(-1), /another nonce/);
  const echo = await host(live, { answer: answerOf(live, { nonce: "22".repeat(32) }) });
  assert.equal(echo.status, "rejected"); assert.equal(echo.checks.nonce, false); assert.match(echo.reasons.join(), /relay answered for another nonce/);
  const app = await host(live, { expected: { ...pinsOf(live), appId: "33".repeat(32) } });
  assert.equal(app.status, "rejected"); assert.equal(app.checks.app, false);
  const sig = await host(live, { answer: answerOf(live, { document: { ...live.doc, tlsKeySig: flipHex(live.doc.tlsKeySig) } }) });
  shapeOk(sig); assert.equal(sig.status, "rejected"); assert.equal(sig.checks.tlsKey, false); assert.equal(sig.checks.appKey, true);
  const cert = await host(live, { answer: answerOf(live, { document: flipCert(live.doc, 2, (d) => d.length - 3) }) });
  shapeOk(cert); assert.equal(cert.checks.googleChain, false); assert.equal(cert.checks.runtime, true); assert.equal(cert.checks.challenge, undefined);
  const extra = await host(live, { answer: answerOf(live, { document: { ...live.doc, extra: 1 } }) });
  assert.equal(extra.checks.document, false);
  const { tlsSpki: _t, tlsKeySig: _s, appSha256: _p, transportKey: _k, ...v3body } = live.doc;
  const v3 = await host(live, { answer: answerOf(live, { document: { ...v3body, format: "enclave-pvm-app-evidence/v3" } }) });
  // v3 is the same binding without the TLS key (the challenge, instanceSig and appKeySig do not cover it): it verifies, as v3
  shapeOk(v3); assert.equal(v3.status, "limited", v3.reasons.join(" | ")); assert.ok(!v3.checkOrder.includes("tlsKey")); assert.equal(fact(v3, "TLS key"), undefined);
  const v1 = await host(live, { answer: answerOf(live, { document: { ...live.doc, format: "enclave-pvm-app-evidence/v1" } }) });
  assert.equal(v1.status, "rejected"); assert.equal(v1.checks.document, false); assert.match(v1.reasons.at(-1), /unbound format/);
  const noLists = await host(live, { answer: answerOf(live, { operatorAllowlist: {} }) });
  assert.equal(noLists.status, "rejected"); assert.equal(noLists.checks.release, false); assert.match(noLists.reasons.at(-1), /fail closed/);
});

test("verifyPvmHostWeb: a failed fetch, a non-200, an oversized, thrown or odd answer is an error, never a pass", async () => {
  const cases = [
    ["a non-200", { fetchImpl: stub({ error: "box_offline", message: "pixel10-pvm-cpu is not attached" }, { status: 503 }) }, /HTTP 503: pixel10-pvm-cpu is not attached/],
    ["fetch throws", { fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) }, /Failed to fetch/],
    ["not JSON", { fetchImpl: stub("<html>") }, /not JSON/],
    ["oversized", { fetchImpl: stub(JSON.stringify({ pad: "x".repeat(600 * 1024) })) }, /exceeds 512 KiB/],
    ["a body that throws", { fetchImpl: async () => ({ status: 200, body: null, text: async () => { throw new Error("stream broke"); } }) }, /stream broke/],
    ["a timeout", { fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), timeoutMs: 50 }, /no answer within 50 ms/],
    ["a metal box", { fetchImpl: stub({ ...answerOf(live), mode: "snp" }) }, /not a pVM host/],
    ["another box", { fetchImpl: stub({ ...answerOf(live), name: "metal0" }) }, /another box/],
    ["no document", { fetchImpl: stub({ ...answerOf(live), document: null }) }, /no pVM evidence document/],
    ["no name", { name: "" }, /no box name/],
    ["a malformed pin", { expected: { codeHashes: ["zz"] } }, /expected.codeHashes/],
    ["a bad random source", { randomBytes: () => new Uint8Array(4) }, /32 random bytes/],
    ["a verifier that throws", { now: () => { throw new Error("clock gone"); } }, /clock gone/],
  ];
  for (const [what, opts, re] of cases) {
    const v = await host(live, opts);
    shapeOk(v);
    assert.equal(v.status, "error", `${what}: ${v.status} ${v.reasons.join(" | ")}`);
    assert.match(v.reasons[0], re, what);
  }
});

// ---- the bundle ----
const ESM = path.join(REPO, "node_modules", "esbuild");
const nodePaths = (process.env.ENCLAVE_WEB_NODE_PATHS || "").split(":").filter(Boolean);
const bufferPresent = fs.existsSync(path.join(REPO, "node_modules", "buffer", "package.json")) || nodePaths.some((p) => fs.existsSync(path.join(p, "buffer", "package.json")));
const noBundle = !fs.existsSync(ESM) ? "esbuild absent" : !bufferPresent && "the `buffer` package is absent (set ENCLAVE_WEB_NODE_PATHS to a node_modules that has it)";
async function bundle(outfile) {
  const { build } = await import("esbuild");
  const { OPTIONS } = await import("../verifier/web/build.mjs");
  const r = await build({ entryPoints: [path.join(REPO, OPTIONS.entry)], outfile, bundle: true, format: OPTIONS.format, platform: OPTIONS.platform, target: [OPTIONS.target],
    minify: OPTIONS.minify, absWorkingDir: REPO, logLevel: "silent", metafile: true, nodePaths,
    alias: Object.fromEntries(Object.entries(OPTIONS.alias).map(([k, v]) => [k, path.join(REPO, v)])), inject: OPTIONS.inject.map((p) => path.join(REPO, p)) });
  return Object.keys(r.metafile.inputs);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vweb-pvm-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the module bundles for the browser with node:crypto shimmed: no Node module on its path", { skip: noBundle }, async () => {
  const inputs = await bundle(path.join(tmp, "bundle.js"));
  for (const p of ["relay/pvm-evidence-core.mjs", "verifier/web/avf.mjs", "verifier/web/pvm-host.mjs", "verifier/web/shims/node-crypto.mjs"]) assert.ok(inputs.includes(p), p);
  assert.deepEqual(inputs.filter((p) => /^node:|(^|\/)relay\/(avf-verify|pvm-app-attest)\.mjs$/.test(p)), [], "no Node builtin, and neither Node verifier, is bundled");
  const js = fs.readFileSync(path.join(tmp, "bundle.js"), "utf8");
  assert.doesNotMatch(js, /require\(|process\.argv/);
});

const CFT = process.env.CHROME_FOR_TESTING || path.join(os.homedir(), ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
test("Chrome for Testing runs the bundle: the live document verifies against a stand-in relay, and refusals match Node's", { skip: noBundle || (!fs.existsSync(CFT) && "Chrome for Testing absent") }, async () => {
  const { chromium } = await import("playwright");
  await bundle(path.join(tmp, "bundle.js"));
  const page = `<!doctype html><meta charset="utf-8"><title>pvm host harness</title><script type="module">
import { verifyPvmHostWeb, verifyPvmEvidenceWeb } from "./bundle.js";
const hex = (s) => Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
window.run = async (fx, cases) => {
  const fixed = { name: "pixel10-pvm-cpu", apiBase: location.origin, randomBytes: () => hex(fx.doc.nonce), now: () => new Date(fx.capturedAt) };
  return { hasBuffer: typeof Buffer, limited: await verifyPvmHostWeb(fixed), fresh: await verifyPvmHostWeb({ ...fixed, randomBytes: undefined }),
           evidence: await Promise.all(cases.map(([doc, expect]) => verifyPvmEvidenceWeb(doc, expect))) };
};
window.ready = true;
</script>`;
  fs.writeFileSync(path.join(tmp, "index.html"), page);
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v1/enclaves/pixel10-pvm-cpu/attestation") {
      seen.push(u.searchParams.get("nonce")); res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(answerOf(live, { nonce: u.searchParams.get("nonce") })));
    }
    const f = path.join(tmp, path.basename(u.pathname) || "index.html");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: CFT, headless: true });
  try {
    const p = await browser.newPage();
    await p.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await p.waitForFunction(() => window.ready === true);
    const c = CASES[1], cases = [[c.fx.doc, expectOf(c)], [{ ...c.fx.doc, appKeySig: flipHex(c.fx.doc.appKeySig) }, expectOf(c)],
      [flipCert(c.fx.doc, 4, (d) => d.length - 3), expectOf(c)], [c.fx.doc, expectOf(c, { allowedCodeHashes: ["b".repeat(64)] })]];
    const r = await p.evaluate(([fx, cs]) => window.run(fx, cs), [live, cases]);
    assert.equal(r.hasBuffer, "undefined", "no global Buffer leaks into the page");
    assert.equal(r.limited.status, "limited", r.limited.reasons.join(" | "));
    assert.equal(r.fresh.status, "rejected"); assert.equal(r.fresh.checks.nonce, false);
    assert.match(seen[1], /^[0-9a-f]{64}$/); assert.notEqual(seen[1], live.doc.nonce, "the page drew its own nonce and sent it");
    for (const [i, [doc, expect]] of cases.entries()) assert.deepEqual(r.evidence[i], verifyPvmAppEvidence(doc, expect), `case ${i}`);
  } finally { await browser.close(); server.close(); }
});
