// relay/pvm-app-attest.mjs: a pVM app's ABI/2 evidence. RuntimeID and Bind2 must agree with the isolation contract to the
// byte (vectors copied from isolation/contract/vectors.json at fb5e466c), the identity and self-test rules must refuse
// what the contract and the shared judge refuse, and the AVF certificate must carry Bind2(spki, nonce, runtime) || app.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { abi2FromLog, bind2, canonical, checkRuntimeSelfTest, runtimeId, validateRuntimeIdentity, verifyPvmAppAbi2 } from "../relay/pvm-app-attest.mjs";
import { haveOpenssl, tmpdir, makeCa, issueLeaf, extension, AUTH } from "./fixtures/avf-synthetic.mjs";
import { verifyPvmAppEvidence, PVM_APP_EVIDENCE_FORMAT } from "../relay/pvm-app-attest.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";

// isolation/contract/vectors.json at fb5e466c: "bind"[0] inputs and the "runtime" vectors
const SPKI = Buffer.from("00191e172c253a334841465f546d627b70898e879c95aaa3b8b1b6cfc4ddd2ebe0f9fef70c051a132821263f344d425b50696e677c758a83989196afa4bdb2cbc0d9ded7ece5faf30801061f142d223b30494e475c556a63787176", "hex");
const NONCE = Buffer.from("0009161f242d2a3338414e575c65626b7079868f949d9aa3a8b1bec7ccd5d2db", "hex");
const id = (o) => ({ name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64", cpuFeatures: "baseline", wx: "enforced", cache: "none", ...o });
const VALID = [
  [id({}), "36437283a1a5310c7e2513313b8b5a6cbad44a86f1d8420947f7052ea8c51414", "a9bf3e3af7cc7f7fe2092e64a64926048b108715e8bb0ccc8019b5f6abcb5551"],
  [id({ targetIsa: "aarch64", hostIsa: "aarch64" }), "14b93dce01f72b1441a27212604f31a5e398270ec80d53933c7b5eb78f50d013", "b6b0d83f9f290f741ba078e52b1612c441247ca97f64fad127e77ef1d86e65f1"],
  [id({ cpuFeatures: "+sse4.2,+avx2" }), "82c0609742ec9adc25466b67ee40a2cf2fe49ceba93fa657d68fa0a1f76621bb", "54c017884de8a6e709266acd3fa86ea763d76c1992def2cd8a59272e25b5f119"],
  [id({ execution: "interpreter", targetIsa: "pulley64", hostIsa: "aarch64" }), "0ad15c8390e5e5305e8d5e386597fe48feefa79da4508ca2a752a172508fe302", "dc3b611a9491af49602cb98a4034c32d423f270fd83792582d928f4eae6da77f"],
];
const INVALID = [id({ wx: "best-effort" }), id({ cache: "unauthenticated" }), id({ targetIsa: "riscv64", hostIsa: "riscv64" }),
  id({ targetIsa: "pulley64", hostIsa: "aarch64" }), id({ execution: "interpreter", targetIsa: "aarch64", hostIsa: "aarch64" }),
  id({ targetIsa: "aarch64" }), id({ execution: "" })];

// the Pixel pVM's actual identity (runtime/pvm-rt pvmrt_identity(): canonical JSON, wasmtime 49.0.0)
const PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}';
const PIXEL_RID = createHash("sha256").update(PIXEL).digest("hex");
const TUPLE = "exec_pages=refused:EACCES wx=clean maps=1 scope=self";
const APP = Buffer.alloc(32, 7);

test("RuntimeID and Bind2 agree with the isolation contract's vectors", () => {
  for (const [r, rid, b2] of VALID) {
    assert.equal(validateRuntimeIdentity(r), null);
    assert.equal(runtimeId(r).toString("hex"), rid);
    assert.equal(bind2(SPKI, NONCE, runtimeId(r)).toString("hex"), b2);
  }
  for (const r of INVALID) { assert.notEqual(validateRuntimeIdentity(r), null, JSON.stringify(r)); assert.throws(() => runtimeId(r)); }
  assert.notEqual(validateRuntimeIdentity({ ...id({}), extra: "x" }), null, "an unknown field is a different identity");
  // the payload hashes the printed string; for the Pixel identity that string IS the canonical form
  assert.equal(canonical(JSON.parse(PIXEL)).toString(), PIXEL);
  assert.equal(runtimeId(JSON.parse(PIXEL)).toString("hex"), PIXEL_RID);
});

test("the runtime self-test tuple: the shared judge's rules, the exec_pages grammar", () => {
  const pix = JSON.parse(PIXEL), jit = id({});
  assert.equal(checkRuntimeSelfTest(TUPLE, pix).ok, true);
  assert.equal(checkRuntimeSelfTest("exec_pages=allowed wx=clean maps=3 scope=cgroup:/dom1", jit).ok, true);
  for (const [t, who] of [["", pix], ["exec_pages=refused:EACCES wx=dirty maps=1 scope=self", pix], ["exec_pages=refused:EACCES wx=clean maps=0 scope=self", pix],
    ["exec_pages=refused:EACCES wx=clean maps=2 scope=self", pix], ["exec_pages=refused:EACCES wx=clean maps=1 scope=everything", pix],
    ["exec_pages=refused:EACCES wx=clean maps=1", pix], ["exec_pages=refused:EACCES wx=clean maps=1 scope=self scope=self", pix],
    ["exec_pages=refused:EACCES wx=clean maps=1 scope=self extra=1", pix], ["exec_pages=maybe wx=clean maps=1 scope=self", pix],
    ["exec_pages=refused:EACCES wx=clean maps=1.5 scope=self", pix], ["exec_pages=refused:EACCES wx=clean maps=1 scope=all-processes", jit]])
    assert.equal(checkRuntimeSelfTest(t, who).ok, false, t);
});

const good = () => ({ chain: [Buffer.from("leaf"), Buffer.from("root")], identity: PIXEL, selftest: TUPLE, spki: SPKI, nonce: NONCE, appId: APP });
const stubAvf = (seen) => (ev, opts) => { seen.push({ challenge: Buffer.from(ev.challenge), opts }); return { ok: true, measurement: "code", reasons: [] }; };

test("the certificate must carry Bind2(spki, nonce, runtime) || app; every input is bound", () => {
  const seen = [];
  const r = verifyPvmAppAbi2(good(), { allowedRuntimeIds: [PIXEL_RID], verifyAvf: stubAvf(seen), allowedCodeHashes: ["c"], allowedAuthorityHashes: ["a"] });
  assert.equal(r.ok, true, r.reasons.join("\n"));
  const want = Buffer.concat([bind2(SPKI, NONCE, Buffer.from(PIXEL_RID, "hex")), APP]);
  assert.deepEqual(seen[0].challenge, want);
  assert.equal(seen[0].challenge.length, 64, "the AVF challenge limit");
  assert.equal(seen[0].opts.allowedCodeHashes[0], "c", "the chain is judged against the caller's pins");
  // a different nonce, key or app asks the chain for a different challenge
  for (const o of [{ nonce: Buffer.alloc(32, 1) }, { spki: Buffer.from(SPKI).fill(3, 20, 21) }, { appId: Buffer.alloc(32, 8) }]) {
    const s = []; verifyPvmAppAbi2({ ...good(), ...o }, { allowedRuntimeIds: [PIXEL_RID], verifyAvf: stubAvf(s) });
    assert.notDeepEqual(s[0].challenge, want);
  }
});

test("refusals before the chain is even looked at", () => {
  const never = () => { throw new Error("the chain was consulted"); };
  const o = { allowedRuntimeIds: [PIXEL_RID], verifyAvf: never };
  const restated = PIXEL.replace("49.0.0", "48.0.1");
  for (const [ev, opts, why] of [
    [{ ...good(), identity: restated }, o, /not an admitted runtime/],
    [{ ...good(), identity: PIXEL.replace('"interpreter"', '"jit"') }, o, /not admissible/],
    [{ ...good(), identity: JSON.stringify(JSON.parse(PIXEL), null, 1) }, o, /canonical/],
    [{ ...good(), identity: "not json" }, o, /not JSON/],
    [{ ...good(), selftest: "exec_pages=refused:EACCES wx=dirty maps=1 scope=self" }, o, /W\^X/],
    [{ ...good(), selftest: undefined }, o, /no runtime self-test/],
    [{ ...good(), nonce: Buffer.alloc(31) }, o, /nonce/],
    [{ ...good(), appId: "zz" }, o, /appId/],
    [{ ...good(), spki: undefined }, o, /SPKI/],
    [good(), { verifyAvf: never }, /no pinned runtime IDs/],
  ]) {
    const r = verifyPvmAppAbi2(ev, opts);
    assert.equal(r.ok, false);
    assert.match(r.reasons.at(-1), why);
  }
  // and a chain that does not verify is a refusal
  const r = verifyPvmAppAbi2(good(), { allowedRuntimeIds: [PIXEL_RID], verifyAvf: () => ({ ok: false, reasons: ["attestationChallenge does not match ours"] }) });
  assert.equal(r.ok, false); assert.match(r.reasons.at(-1), /attestationChallenge/);
});

test("the capture's ABI2 lines are read apart from the attach chain", () => {
  const log = ["VSOCK CERT0[0] aa", "VSOCK ABI2 selftest " + TUPLE, "VSOCK ABI2 runtime " + PIXEL,
    `VSOCK ABI2 binding nonce=${NONCE.toString("hex")} (owner challenge only) runtime_id=${PIXEL_RID} bind2=${"b".repeat(64)} app=${APP.toString("hex")}`,
    "VSOCK ABI2_LINK0 bytes=3 chunks=1", "VSOCK ABI2_LINK0[0] 010203", "VSOCK ABI2_LINK1[0] 0405"].join("\n");
  const e = abi2FromLog(log);
  assert.equal(e.identity, PIXEL); assert.equal(e.selftest, TUPLE);
  assert.deepEqual(e.chain.map((c) => c.toString("hex")), ["010203", "0405"]);
  assert.equal(e.binding.runtimeId, PIXEL_RID); assert.equal(e.binding.app, APP.toString("hex"));
});

// A CLIENT's own verification of an evidence envelope (verifyPvmAppEvidence): real chains from the synthetic CA, the
// client's own nonce and pins; everything the carrier could change is refused.

test("client-verified evidence: the client's nonce, app and pins decide; substitution, staleness and relabelling are refused",
     { skip: !haveOpenssl && "openssl not installed" }, () => {
  const dir = tmpdir("pvm-evidence-");
  const ca = makeCa(dir);
  const CODE = createHash("sha256").update("pvm-cpu protected build").digest();
  const APP_ID = createHash("sha256").update("ggml-probe").digest("hex");
  const vmKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const relayKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  // the VM's answer to a nonce: a certificate over Bind2(spki, nonce, RID) || app
  const answer = ({ nonce, spki = vmKey, app = APP_ID, identity = PIXEL, code = CODE }) => {
    const challenge = Buffer.concat([bind2(spki, nonce, createHash("sha256").update(identity).digest()), Buffer.from(app, "hex")]);
    const leaf = issueLeaf(dir, { ext: extension({ challenge, code }) });
    return { format: PVM_APP_EVIDENCE_FORMAT, nonce: nonce.toString("hex"), app, spki: spki.toString("hex"), identity, selftest: TUPLE,
             chain: [leaf.leaf, ca.inter, ca.root].map((d) => d.toString("base64")) };
  };
  const pins = (nonce, over = {}) => ({ nonce, appId: APP_ID, allowedRuntimeIds: [PIXEL_RID], allowedCodeHashes: [CODE.toString("hex")],
                                        allowedAuthorityHashes: [AUTH.toString("hex")], rootPins: [ca.rootPin], ...over });
  const n1 = randomBytes(32), n2 = randomBytes(32);
  const good = answer({ nonce: n1 });
  const r = verifyPvmAppEvidence(good, pins(n1));
  assert.equal(r.ok, true, r.reasons.join(" | "));
  assert.equal(r.transportSpki, vmKey.toString("hex"), "the key to pin is the attested one");
  const refused = (env, p, why) => { const v = verifyPvmAppEvidence(env, p); assert.equal(v.ok, false, why); assert.equal(v.transportSpki, null); return v.reasons.join(" "); };
  // a malicious carrier puts ITS key in the envelope: the challenge no longer matches
  assert.match(refused({ ...good, spki: relayKey.toString("hex") }, pins(n1), "key swap"), /attestationChallenge/);
  // ...or has a genuine-looking certificate over its own key (it cannot: only a VM running the pinned build attests) -- modelled by a leaf with another code hash
  assert.match(refused(answer({ nonce: n1, spki: relayKey, code: createHash("sha256").update("not our build").digest() }), pins(n1), "other build"), /allowlisted codeHash/);
  // stale: the previous session's evidence against a new nonce, as is and with the nonce field rewritten
  assert.match(refused(good, pins(n2), "stale"), /another nonce/);
  assert.match(refused({ ...good, nonce: n2.toString("hex") }, pins(n2), "stale relabelled"), /attestationChallenge/);
  // wrong app: as is, and with the app field rewritten to the expected one
  const other = answer({ nonce: n1, app: "e".repeat(64) });
  assert.match(refused(other, pins(n1), "wrong app"), /another app/);
  assert.match(refused({ ...other, app: APP_ID }, pins(n1), "app relabelled"), /attestationChallenge/);
  // wrong runtime: a restated identity is not an admitted runtime; a client pinning another runtime refuses the real one
  const restated = PIXEL.replace("49.0.0", "48.0.1");
  assert.match(refused(answer({ nonce: n1, identity: restated }), pins(n1), "restated runtime"), /not an admitted runtime/);
  assert.match(refused(good, pins(n1, { allowedRuntimeIds: ["a".repeat(64)] }), "other runtime pinned"), /not an admitted runtime/);
  // freshness of the certificate itself, malformed envelopes, and a caller without pins
  assert.match(refused(good, pins(n1, { now: Date.now() + 3 * 24 * 3600 * 1000 }), "expired"), /expired/);
  assert.match(refused({ ...good, format: "x" }, pins(n1), "format"), /format/);
  assert.match(refused({ ...good, spki: "00" }, pins(n1), "spki"), /Ed25519 SPKI/);
  assert.match(refused(good, pins(n1, { allowedCodeHashes: [] }), "no code pins"), /fail closed/);
  for (const k of ["allowedRuntimeIds", "allowedAuthorityHashes", "rootPins"]) assert.match(refused(good, pins(n1, { [k]: [] }), k), /fail closed/);
  // a closed shape: an extra field, a padded chain entry, an uppercase nonce, a long identity -- each refused
  assert.match(refused({ ...good, note: "x" }, pins(n1), "extra field"), /exactly/);
  assert.match(refused({ ...good, chain: [good.chain[0] + "AA", ...good.chain.slice(1)] }, pins(n1), "padded der"), /canonical base64|attestation|DER/);
  assert.match(refused({ ...good, nonce: good.nonce.toUpperCase() }, pins(n1), "uppercase"), /64 lowercase hex/);
  assert.match(refused({ ...good, identity: " ".repeat(1025) }, pins(n1), "long identity"), /1024/);
  assert.equal(r.freshness, "client-nonce");
  assert.equal(r.appId, APP_ID, "the app compared is the caller's");
});
