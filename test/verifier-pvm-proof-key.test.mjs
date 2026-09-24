// test/verifier-pvm-proof-key.test.mjs: the lease proof-key statement and the ProofOfTime checkpoints (PROOF-KEY.md, agreed
// 2026-09-24), judged by verifier/pvm-proof-key.mjs over the pVM owner's canonical verifiers at the pvm-app-attest pin
// (relay/pvm-app-attest.mjs verifyPvmProofKey, relay/pvm-checkpoint.mjs) on the owner's Pixel 10 DEVICE fixtures
// (test/fixtures/pvm-proof-key/fixtures.json at the pin: a real v3 envelope under Google's roots, 25 statement negatives with
// their exact reasons, 2 device-signed checkpoints and 5 negatives), never restated here. Proves:
//   - the owner's own replay passes against the pinned tree (their exact reasons, their claims);
//   - this gate gives the fixtures' outcomes (verified iff the owner recorded ok), and its claims are the owner's;
//   - the 271-byte message rebuilt here from the spec equals the owner's builder's bytes, and the device signature verifies under
//     the transport SPKI this branch's re-verification returned;
//   - the consumer's PINS refuse what the owner's verifier does not compare: another chain (Base's 8453 against the device's
//     local 31337), another proofOfTime or registry, another operator or runner, malformed or missing pins;
//   - the checkpoint digest computed here from EnclaveProofOfTime.sol's own strings equals the device fixtures' and the
//     owner's; the contract source carries exactly those strings; and the checkpoint negatives beyond the owner's list
//     (another chain, a non-canonical upto, an uppercase anchor, no claims) are refused.
//   run: node --test test/verifier-pvm-proof-key.test.mjs   (strict: ENCLAVE_PVM_MODULE must point at the pin, 047f7739 or later)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyProofKey, verifyCheckpoint, proofKeyMessage, proofOfTimeDigest, loadProofKeyModules, canonicalChainId, canonicalU64,
         PROOF_KEY_MESSAGE_BYTES, PROOF_OF_TIME_TYPE, PROOF_OF_TIME_DOMAIN, EIP712_DOMAIN_TYPE } from "../verifier/pvm-proof-key.mjs";

const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
const modPath = process.env.ENCLAVE_PVM_MODULE || null;
if (STRICT && !modPath) throw new Error("strict integration: ENCLAVE_PVM_MODULE (the pinned relay/pvm-app-attest.mjs) is not set");
const pinRoot = modPath ? path.dirname(path.dirname(modPath)) : new URL("..", import.meta.url).pathname;
const FIX = path.join(pinRoot, "test", "fixtures", "pvm-proof-key", "fixtures.json"), OWNER_TEST = path.join(pinRoot, "test", "pvm-proof-key-fixtures.test.mjs");
const skip = !fs.existsSync(FIX) && "the owner's proof-key fixtures are not pinned here (pvm-app-attest at 047f7739 or later) and not in this tree";
if (STRICT && skip) throw new Error("strict integration: " + skip);
const F = skip ? null : JSON.parse(fs.readFileSync(FIX, "utf8"));
const mods = skip ? null : await loadProofKeyModules();
const positive = () => F.statements.find((c) => c.name === "device-statement");
// the consumer's pins for a fixture case: the lease's values, and the deployment the case selected (absent = fail closed)
const pinsFor = (c) => ({ chainId: F.lease.pins.chainId, proofOfTime: F.lease.pins.proofOfTime, registry: F.lease.pins.registry, ...(c.expect.deployment !== undefined ? { deployment: c.expect.deployment } : {}) });
const NINE = ["proofKey", "chainId", "proofOfTime", "registry", "deployment", "enclaveId", "operator", "instanceId", "appId"];
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));

test("the owner's own replay passes against the pinned tree (their exact reasons and claims)", { skip }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;      // a child of node --test would otherwise speak the runner's protocol, not TAP
  const r = spawnSync(process.execPath, ["--test", OWNER_TEST], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-500));
  const n = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, "m")) || [])[1]);
  assert.equal(n("fail"), 0); assert.equal(n("skipped"), 0);
  assert.equal(n("pass"), 1 + F.statements.length + F.checkpoints.length, "one test per fixture case plus the shape test");
  assert.equal(F.type, "enclave-pvm-proof-key-fixtures/1");
  assert.ok(F.statements.length >= 26 && F.checkpoints.length >= 7);
});

test("the contract's own strings are the ones this gate hashes (EnclaveProofOfTime.sol)", () => {
  const sol = fs.readFileSync(new URL("../contracts/EnclaveProofOfTime.sol", import.meta.url), "utf8");
  assert.ok(sol.includes(`"${PROOF_OF_TIME_TYPE}"`), "the ProofOfTime type string");
  assert.ok(sol.includes(`keccak256("${EIP712_DOMAIN_TYPE}")`), "the EIP712Domain type string");
  assert.ok(sol.includes(`keccak256("${PROOF_OF_TIME_DOMAIN.name}")`) && sol.includes(`keccak256("${PROOF_OF_TIME_DOMAIN.version}")`), "the domain name and version");
  assert.ok(sol.includes('abi.encodePacked("\\x19\\x01", domainSeparator()'), "the digest prefix");
  for (const [s, want] of [["1", 1n], ["31337", 31337n], ["8453", 8453n], ["18446744073709551615", (1n << 64n) - 1n]]) assert.equal(canonicalChainId(s), want);
  for (const s of ["0", "01", "-1", "0x7a69", "18446744073709551616", " 1", "1.0", 1, null]) assert.equal(canonicalChainId(s), null, JSON.stringify(s));
  assert.equal(canonicalU64("0"), 0n); assert.equal(canonicalU64("00"), null);
});

test("every statement fixture gives its recorded outcome through this gate, and the positive's claims are the owner's", { skip }, async () => {
  for (const c of F.statements) {
    const v = await verifyProofKey(c.statement, { expect: c.expect, pins: pinsFor(c), now: c.expect.now, modules: mods });
    assert.equal(v.status === "verified", c.want.ok, `${c.name}: ${v.reasons.at(-1)}`);
    assert.equal(v.admissionSafe, false, `${c.name}: a proof-key verdict admits nothing`);
    if (c.want.ok) {
      assert.deepEqual(pick(v.claims, NINE), c.want.claims, c.name);
      assert.equal(v.claims.evidenceFormat, "enclave-pvm-app-evidence/v3");
      assert.match(v.claims.transportSpkiSha256, /^[0-9a-f]{64}$/);
      for (const k of ["statement shape", "pins", "evidence", "signature", "owner"]) assert.equal(v.checks[k], true, `${c.name}: check ${k}`);
    } else {
      assert.equal(v.claims, null, c.name);
      assert.ok(Object.values(v.checks).includes(false), `${c.name}: a named check refused`);
    }
  }
});

test("the 271-byte message rebuilt here equals the owner's builder's bytes; the device signature verifies under the re-verified transport key", { skip }, async () => {
  const c = positive(), s = c.statement, cl = c.want.claims;
  const mine = proofKeyMessage({ nonce: c.expect.nonce, appId: cl.appId, instanceId: cl.instanceId, proofKey: cl.proofKey, chainId: cl.chainId, proofOfTime: cl.proofOfTime, registry: cl.registry, deployment: cl.deployment, enclaveId: cl.enclaveId, operator: cl.operator });
  const theirs = mods.statement.proofKeyMessage({ nonce: c.expect.nonce, appId: cl.appId, instanceType: mods.statement.INSTANCE_TYPES["pvm-instance-id"], instanceValue: cl.instanceId, sigAlg: mods.statement.SIG_ALGS.ed25519,
    proofKey: cl.proofKey, chainId: cl.chainId, proofOfTime: cl.proofOfTime, registry: cl.registry, deployment: cl.deployment, enclaveId: cl.enclaveId, operator: cl.operator });
  assert.equal(mine.length, PROOF_KEY_MESSAGE_BYTES); assert.ok(mine.equals(theirs), "two readings of PROOF-KEY.md give the same bytes");
  assert.equal(mine.subarray(0, 21).toString("latin1"), "enclave-proof-key-v1\n"); assert.equal(mine[85], 0x01, "instance type byte"); assert.equal(mine[118], 0x01, "sigAlg byte");
  assert.equal(mine.subarray(139, 147).readBigUInt64BE(), BigInt(cl.chainId), "chainId big-endian at its offset");
  const v = await verifyProofKey(s, { expect: c.expect, pins: pinsFor(c), now: c.expect.now, modules: mods });
  assert.equal(v.status, "verified", v.reasons.at(-1));
  // the signature is over THESE bytes: one flipped bit anywhere in the signed fields is refused at the signature, and the
  // statement carries no other field a signature could be over
  const flipped = { ...s, enclaveId: s.enclaveId.slice(0, 65) + (s.enclaveId.slice(65) === "0" ? "1" : "0") };
  const f = await verifyProofKey(flipped, { expect: c.expect, pins: pinsFor(c), now: c.expect.now, modules: mods });
  assert.equal(f.status, "rejected"); assert.equal(f.checks.signature, false, f.reasons.at(-1));
  assert.throws(() => proofKeyMessage({ nonce: c.expect.nonce, appId: cl.appId, instanceId: cl.instanceId, proofKey: cl.proofKey, chainId: "0x7a69", proofOfTime: cl.proofOfTime, registry: cl.registry, deployment: cl.deployment, enclaveId: cl.enclaveId, operator: cl.operator }), /canonical/);
});

test("the consumer's pins refuse what the owner's verifier does not compare: another chain, contract, operator or runner; malformed or missing pins", { skip }, async () => {
  const c = positive(), s = c.statement, base = pinsFor(c);
  const run = (pins) => verifyProofKey(s, { expect: c.expect, pins, now: c.expect.now, modules: mods });
  assert.equal((await run(base)).status, "verified");
  const cases = [
    ["Base's chain against the device's local one", { ...base, chainId: "8453" }, /names chain 31337, not the consumer's 8453/],
    ["another proofOfTime", { ...base, proofOfTime: "0x" + "ab".repeat(20) }, /proofOfTime .* is not the address book's/],
    ["another registry", { ...base, registry: "0x" + "cd".repeat(20) }, /registry .* is not the address book's/],
    ["another operator (ledger row)", { ...base, operator: "0x" + "ef".repeat(20) }, /operator .* is not the ledger row's/],
    ["another runner (ledger row)", { ...base, enclaveId: "0x" + "12".repeat(32) }, /enclaveId .* is not the ledger row's/],
    ["another deployment", { ...base, deployment: "0x" + "34".repeat(32) }, /is for deployment .* not the selected/],
    ["no deployment", { chainId: base.chainId, proofOfTime: base.proofOfTime, registry: base.registry }, /pins\.deployment/],
    ["an uppercase deployment", { ...base, deployment: base.deployment.toUpperCase() }, /pins\.deployment/],
    ["a non-canonical chain id", { ...base, chainId: "031337" }, /pins\.chainId/],
    ["a checksummed proofOfTime", { ...base, proofOfTime: base.proofOfTime.slice(0, 10).toUpperCase() + base.proofOfTime.slice(10) }, /pins\.proofOfTime/],
    ["no pins at all", null, /no consumer pins/],
  ];
  for (const [name, pins, re] of cases) {
    const v = await run(pins);
    assert.equal(v.status, "rejected", name); assert.equal(v.checks.pins, false, `${name}: refused at the pins`); assert.match(v.reasons.at(-1), re, name);
  }
  // the same operator and runner as the lease's row: accepted, and named in the reasons
  const full = await run({ ...base, operator: F.lease.pins.operator, enclaveId: F.lease.pins.enclaveId });
  assert.equal(full.status, "verified"); assert.match(full.reasons.find((r) => r.includes("consumer's chain")), /operator, runner/);
  // an unsupported instance type, an ecdsa sigAlg and an uppercase sig are refused at the shape, before any evidence is read
  for (const [name, doc] of [["snp instance type", { ...s, instance: { type: "snp-host-data", value: s.instance.value } }], ["ecdsa sigAlg", { ...s, sigAlg: "ecdsa-p256-sha256" }], ["uppercase sig", { ...s, sig: s.sig.toUpperCase() }], ["a 0x sig", { ...s, sig: "0x" + s.sig.slice(2) }]]) {
    const v = await verifyProofKey(doc, { expect: c.expect, pins: base, now: c.expect.now, modules: mods });
    assert.equal(v.status, "rejected", name); assert.equal(v.checks["statement shape"], false, name);
  }
});

test("every checkpoint fixture gives its recorded outcome; the digest computed from the contract's strings is the device's and the owner's", { skip }, async () => {
  for (const c of F.checkpoints) {
    const claims = { ...c.pins, proofKey: c.proofKey };
    const v = await verifyCheckpoint(c.checkpoint, { claims, modules: mods });
    assert.equal(v.status === "verified", c.want.ok, `${c.name}: ${v.reasons.at(-1)}`);
    assert.equal(v.admissionSafe, false);
    if (c.want.ok) {
      assert.equal(v.checkpoint.digest, c.want.digest, `${c.name}: the digest`);
      assert.equal(v.checkpoint.signer, c.proofKey); assert.equal(v.checkpoint.id, c.checkpoint.deployment);
      assert.equal(v.checkpoint.upto, c.checkpoint.upto); assert.equal(v.checkpoint.anchorBlock, c.checkpoint.anchorBlock);
      assert.equal(proofOfTimeDigest({ chainId: c.pins.chainId, proofOfTime: c.pins.proofOfTime, id: c.checkpoint.deployment, enclaveId: c.checkpoint.enclaveId, operator: c.checkpoint.operator, upto: c.checkpoint.upto, anchorBlock: c.checkpoint.anchorBlock, anchorHash: c.checkpoint.anchorHash }), c.want.digest);
      // and the owner's typedDataOf hashes to the same digest through viem's EIP-712 path (two encodings, one digest)
      const { hashTypedData } = await import("viem");
      assert.equal(hashTypedData(mods.checkpoint.typedDataOf(c.pins, { upto: c.checkpoint.upto, anchorBlock: c.checkpoint.anchorBlock, anchorHash: c.checkpoint.anchorHash })), c.want.digest);
    } else {
      assert.equal(v.checkpoint, undefined);
    }
  }
  const good = F.checkpoints.find((c) => c.want.ok);
  assert.ok(good.checkpoint.upto !== F.checkpoints.filter((c) => c.want.ok)[1].checkpoint.upto, "the two device checkpoints advance upto");
});

test("checkpoint negatives beyond the owner's list: another chain, a non-canonical upto, an uppercase anchor, wrong or missing claims", { skip }, async () => {
  const c = F.checkpoints.find((x) => x.want.ok), claims = { ...c.pins, proofKey: c.proofKey }, ck = c.checkpoint;
  const run = (doc, cl = claims) => verifyCheckpoint(doc, { claims: cl, modules: mods });
  assert.equal((await run(ck)).status, "verified");
  const cases = [
    ["another chain in the claims", ck, { ...claims, chainId: "8453" }, "pins", /names chain 31337, not the statement's 8453/],
    ["another chain in the checkpoint", { ...ck, chainId: "8453" }, claims, "pins", /names chain 8453/],
    ["a leading-zero upto", { ...ck, upto: "0" + ck.upto }, claims, "checkpoint shape", /canonical u64/],
    ["an upto of 2^64", { ...ck, upto: "18446744073709551616" }, claims, "checkpoint shape", /canonical u64/],
    ["an uppercase anchor hash", { ...ck, anchorHash: ck.anchorHash.toUpperCase() }, claims, "checkpoint shape", /anchorHash/],
    ["an extra field", { ...ck, note: "x" }, claims, "checkpoint shape", /exactly/],
    ["a signature without 0x", { ...ck, sig: ck.sig.slice(2) }, claims, "checkpoint shape", /0x \+ 65 bytes/],
    ["the zero proof key in the claims", ck, { ...claims, proofKey: "0x" + "0".repeat(40) }, "pins", /malformed/],
    ["no claims", ck, null, "pins", /no verified proof-key claims/],
  ];
  for (const [name, doc, cl, check, re] of cases) {
    const v = await run(doc, cl);
    assert.equal(v.status, "rejected", name); assert.equal(v.checks[check], false, `${name}: refused at ${check}`); assert.match(v.reasons.at(-1), re, name);
  }
  // an edited anchor hash recovers another signer: refused at the signature, by this gate and by the owner's checker alike
  const edited = { ...ck, anchorHash: ck.anchorHash.slice(0, 65) + (ck.anchorHash.slice(65) === "0" ? "1" : "0") };
  const v = await run(edited);
  assert.equal(v.status, "rejected"); assert.equal(v.checks.signature, false); assert.match(v.reasons.at(-1), /signed by 0x[0-9a-f]{40}, not the attested proof key/);
  const o = await mods.checkpoint.verifyPvmCheckpoint(edited, { pins: c.pins, proofKey: c.proofKey });
  assert.equal(o.ok, false);
});
