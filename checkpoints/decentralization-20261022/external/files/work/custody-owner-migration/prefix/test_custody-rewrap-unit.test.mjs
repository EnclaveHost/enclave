// Units of the owner-authorized custody rewrap (custody/v2/rewrap.mjs, rewrap-host.mjs, rewrap-guest.mjs) without a chain:
// the authorization's binding of every field, every judge refusal, the destination seal (opens only under the destination
// committee's key and label), the result shape, the owner's plan/switch/rollback updates, and the host's narrow signer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { keccak256, hashTypedData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as v2 from "../custody/v2/protocol.mjs";
import { canonicalRules } from "../custody/rules.mjs";
import { makeUpdateV2 } from "../custody/v2/owner.mjs";
import { normalizeAuthorization, rewrapTypedData, rewrapDigest, judgeRewrap, sealForDestination, assertResultShape, planRewrap, checkResultAndSwitch,
  REWRAP_TYPES, REWRAP_RUNTIME_ID, MAX_AUTHORIZATION_SEC, ERC1271_MAGIC } from "../custody/v2/rewrap.mjs";
import { rewrapHostApi, qemuArgs } from "../custody/v2/rewrap-host.mjs";
import { main as guestMain } from "../custody/v2/rewrap-guest.mjs";

const CHAIN = 8453, VAULT = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const hex32 = () => "0x" + randomBytes(32).toString("hex");
const sha = (b) => "0x" + createHash("sha256").update(b).digest("hex");
const REWRAP_MEAS = "5e".repeat(48), APP_MEAS = "77".repeat(48);
const RULES = { v: 1, appId: "a7".repeat(32), images: [{ platform: "sev-snp", measurement: APP_MEAS, runtimeId: "29".repeat(32) }], minTcb: { Genoa: { bootloader: 10, tee: 0, snp: 23, microcode: 84 } }, vmpl: 0 };
const RULES_W = { ...RULES, images: [...RULES.images, { platform: "sev-snp", measurement: REWRAP_MEAS, runtimeId: REWRAP_RUNTIME_ID }] };
const rulesHex = (r) => "0x" + Buffer.from(canonicalRules(r)).toString("hex");

function world() {
  const owner = privateKeyToAccount(generatePrivateKey());
  const src = v2.genesis(), dst = v2.genesis();
  const id = hex32(), srcCid = hex32(), dstCid = hex32(), now = 1_800_000_000;
  const env = { A: "alpha-" + randomBytes(8).toString("hex"), B: "β-" + randomBytes(8).toString("hex") };
  const bundle = v2.encryptBundle({ Y: src.Y, label: v2.labelOf({ chainId: CHAIN, vault: VAULT, id, secretRev: 3n, committeeId: srcCid }), env, configSha256: "c".repeat(64) });
  const bundleHex = "0x" + Buffer.from(bundle).toString("hex"), dstY = "0x" + Buffer.from(dst.Y).toString("hex");
  const a = { id, sourcePolicyRev: "5", sourceSecretRev: "3", sourceCommitteeId: srcCid, sourceBundleHash: keccak256(bundleHex), destCommitteeId: dstCid,
    destKeyHash: keccak256(dstY), destCodeMeasurement: sha(Buffer.alloc(48, 0x9e)), destSecretRev: "4", leaseEndpoint: "https://app.host.test",
    rewrapMeasurement: sha(Buffer.from(REWRAP_MEAS, "hex")), rewrapRuntimeId: "0x" + REWRAP_RUNTIME_ID, expiry: String(now + 3600) };
  const facts = { blockNumber: 100n, blockHash: hex32(), blockTimestamp: now,
    policy: { owner: owner.address.toLowerCase(), policyRev: "5", secretRev: "3", committeeId: srcCid, paused: false, rules: rulesHex(RULES_W) },
    bundle: { committeeId: srcCid, secretRev: "3", data: bundleHex }, beneficialOwner: owner.address.toLowerCase(),
    source: { committeeId: srcCid, Y: "0x" + Buffer.from(src.Y).toString("hex"), epoch: 1, t: 1, W: 1, commitments: "0x", machines: [] },
    dest: { committeeId: dstCid, Y: dstY, epoch: 1, t: 1, W: 1, commitments: "0x", machines: [{ measurement: a.destCodeMeasurement }] },
    destCodeActiveAt: now - 10, ownerIsContract: false, erc1271: null };
  const self = { measurement: REWRAP_MEAS, hostData: id.slice(2) };
  return { owner, src, dst, id, a, facts, self, env, bundle };
}
const judge = async (w, over = {}) => {
  const a = over.a || w.a;
  const sig = over.sig || await w.owner.signTypedData(rewrapTypedData({ chainId: CHAIN, vault: VAULT, authorization: a }));
  return judgeRewrap({ chainId: CHAIN, vault: VAULT, authorization: a, signature: sig, facts: over.facts || w.facts, self: over.self || w.self });
};
const code = async (p) => { try { await p; return "admitted"; } catch (e) { return e.code || e.message; } };

test("the authorization: strict shape, and the digest binds every field, the chain and the vault", () => {
  const w = world();
  const d0 = rewrapDigest({ chainId: CHAIN, vault: VAULT, authorization: w.a });
  for (const { name, type } of REWRAP_TYPES.Rewrap) {
    const v = type === "bytes32" ? hex32() : type === "uint64" ? String(BigInt(w.a[name]) + 1n) : "https://other.host.test";
    let a = { ...w.a, [name]: v };
    if (name === "sourceSecretRev") a.destSecretRev = String(BigInt(v) + 1n);
    if (name === "destSecretRev") a = { ...a, sourceSecretRev: String(BigInt(v) - 1n) };
    if (name === "rewrapRuntimeId") { assert.throws(() => normalizeAuthorization(a), /runtime/); continue; }
    assert.notEqual(rewrapDigest({ chainId: CHAIN, vault: VAULT, authorization: a }), d0, `${name} is signed`);
  }
  assert.notEqual(rewrapDigest({ chainId: 1, vault: VAULT, authorization: w.a }), d0, "the chain is signed");
  assert.notEqual(rewrapDigest({ chainId: CHAIN, vault: "0x" + "11".repeat(20), authorization: w.a }), d0, "the vault is signed");
  assert.equal(d0, hashTypedData(rewrapTypedData({ chainId: CHAIN, vault: VAULT, authorization: w.a })));
  for (const [bad, re] of [[{ ...w.a, extra: 1 }, /unknown field/], [{ ...w.a, destSecretRev: "9" }, /sourceSecretRev \+ 1/], [{ ...w.a, destCommitteeId: w.a.sourceCommitteeId }, /destination is the source/],
    [{ ...w.a, leaseEndpoint: "http://app.host.test" }, /https/], [{ ...w.a, expiry: "-1" }, /non-negative/], [{ ...w.a, id: "0x12" }, /32 bytes/]])
    assert.throws(() => normalizeAuthorization(bad), re);
});

test("the guest's judgement: admitted only on the exact authenticated state; every substitution has its own refusal", async () => {
  const w = world();
  assert.equal(await code(judge(w)), "admitted");
  const F = (patch) => ({ ...w.facts, ...patch });
  const cases = [
    ["expired", { facts: F({ blockTimestamp: Number(w.a.expiry) }) }],
    ["bad_authorization", { a: { ...w.a, expiry: String(w.facts.blockTimestamp + MAX_AUTHORIZATION_SEC + 10) } }],
    ["stale_revision", { facts: F({ policy: { ...w.facts.policy, policyRev: "6" } }) }],
    ["stale_revision", { facts: F({ policy: { ...w.facts.policy, secretRev: "4" } }) }],
    ["wrong_committee", { facts: F({ policy: { ...w.facts.policy, committeeId: hex32() } }) }],
    ["paused", { facts: F({ policy: { ...w.facts.policy, paused: true } }) }],
    ["owner_mismatch", { facts: F({ beneficialOwner: "0x" + "22".repeat(20) }) }],
    ["bundle_mismatch", { facts: F({ bundle: { ...w.facts.bundle, data: w.facts.bundle.data.slice(0, -2) + "00" } }) }],
    ["no_bundle", { facts: F({ bundle: { ...w.facts.bundle, data: "0x" } }) }],
    ["bad_signature", { sig: await privateKeyToAccount(generatePrivateKey()).signTypedData(rewrapTypedData({ chainId: CHAIN, vault: VAULT, authorization: w.a })) }],
    ["bad_signature", { facts: F({ ownerIsContract: true, erc1271: "0xffffffff" }) }],
    ["bad_signature", { facts: F({ ownerIsContract: true, erc1271: "revert" }) }],
    ["wrong_image", { self: { ...w.self, measurement: "6f".repeat(48) } }],
    ["wrong_deployment", { self: { ...w.self, hostData: "00".repeat(32) } }],
    ["not_admitted", { facts: F({ policy: { ...w.facts.policy, rules: rulesHex(RULES) } }) }],
    ["bad_rules", { facts: F({ policy: { ...w.facts.policy, rules: "0x7b7d" } }) }],
    ["no_destination", { facts: F({ dest: null }) }],
    ["destination_key", { facts: F({ dest: { ...w.facts.dest, Y: "0x" + Buffer.from(v2.genesis().Y).toString("hex") } }) }],
    ["destination_code", { facts: F({ destCodeActiveAt: 0 }) }],
    ["destination_code", { facts: F({ destCodeActiveAt: w.facts.blockTimestamp + 100 }) }],
    ["destination_code", { facts: F({ dest: { ...w.facts.dest, machines: [{ measurement: hex32() }] } }) }],
    ["no_source", { facts: F({ source: null }) }],
  ];
  for (const [want, over] of cases) assert.equal(await code(judge(w, over)), want, JSON.stringify(Object.keys(over)));
  assert.equal(await code(judge(w, { facts: F({ ownerIsContract: true, erc1271: ERC1271_MAGIC }), sig: "0x" + "00".repeat(65) })), "admitted", "a contract owner's ERC-1271 answer decides");
});

test("the destination seal: the same payload, openable ONLY by the destination committee for the destination label; the source ciphertext is not", () => {
  const w = world(), a = normalizeAuthorization(w.a);
  const payload = { env: w.env, configSha256: "c".repeat(64) };
  const { bundle, label } = sealForDestination({ chainId: CHAIN, vault: VAULT, a, destY: Buffer.from(w.facts.dest.Y.slice(2), "hex"), payload });
  const R = v2.parseBundle(bundle).Rp;
  const open = (secret, lab, b) => v2.decryptBundle({ S: v2.parseBundle(b).Rp.multiply(secret), label: lab, bundle: b });
  assert.deepEqual(open(w.dst.shares[0].x, label, bundle), payload, "the destination committee opens it (t = 1)");
  assert.throws(() => open(w.src.shares[0].x, label, bundle), "the source committee cannot");
  assert.equal(v2.verifyLabelProof(bundle, label), true);
  assert.equal(v2.verifyLabelProof(bundle, v2.labelOf({ chainId: CHAIN, vault: VAULT, id: a.id, secretRev: 3n, committeeId: a.destCommitteeId })), false, "bound to secretRev + 1");
  assert.equal(v2.verifyLabelProof(w.bundle, label), false, "the old ciphertext fails the destination's label proof");
  assert.ok(R);
  assert.throws(() => sealForDestination({ chainId: CHAIN, vault: VAULT, a, destY: Buffer.from(w.facts.dest.Y.slice(2), "hex"), payload: { env: { "BAD NAME": "x" }, configSha256: "c".repeat(64) } }), /env-var name/);
});

test("the result carries only ciphertext and public facts; the owner's switch checks it and restores the original rules", () => {
  const w = world(), a = normalizeAuthorization(w.a);
  const { bundle } = sealForDestination({ chainId: CHAIN, vault: VAULT, a, destY: Buffer.from(w.facts.dest.Y.slice(2), "hex"), payload: { env: w.env, configSha256: "c".repeat(64) } });
  const bundleHex = "0x" + Buffer.from(bundle).toString("hex");
  const result = { format: "enclave-custody-rewrap/1", chainId: CHAIN, vault: VAULT, authorizationDigest: rewrapDigest({ chainId: CHAIN, vault: VAULT, authorization: w.a }),
    authorization: w.a, checkedAtBlock: { number: "1", hash: hex32() }, destination: { committeeId: a.destCommitteeId, secretRev: "4", label: "0x" }, bundle: bundleHex,
    bundleHash: keccak256(bundleHex), bundleBytes: bundle.length };
  assert.equal(assertResultShape(result), result);
  assert.throws(() => assertResultShape({ ...result, env: w.env }), /unexpected result fields/, "a payload field is refused");
  assert.throws(() => assertResultShape({ ...result, bundleHash: hex32() }), /malformed/);
  const { switchUpdate } = checkResultAndSwitch({ chainId: CHAIN, vault: VAULT, authorization: w.a, result, originalRules: RULES });
  assert.deepEqual([switchUpdate.expectPolicyRev, switchUpdate.setPolicy, switchUpdate.committeeId, switchUpdate.setBundle, switchUpdate.rules],
                   [5n, true, a.destCommitteeId, true, rulesHex(RULES)], "one atomic update: expect the authorized revision, destination, original rules, new bundle");
  const other = sealForDestination({ chainId: CHAIN, vault: VAULT, a: { ...a, destCommitteeId: hex32() }, destY: Buffer.from(w.facts.dest.Y.slice(2), "hex"), payload: { env: w.env, configSha256: "c".repeat(64) } });
  const otherHex = "0x" + Buffer.from(other.bundle).toString("hex");
  assert.throws(() => checkResultAndSwitch({ chainId: CHAIN, vault: VAULT, authorization: w.a, result: { ...result, bundle: otherHex, bundleHash: keccak256(otherHex) }, originalRules: RULES }), /not labelled/);
  assert.throws(() => checkResultAndSwitch({ chainId: 1, vault: VAULT, authorization: w.a, result, originalRules: RULES }), /another authorization|another chain/);
});

test("the owner's plan: admit adds exactly the rewrap image; rollback restores the original bytes; unsafe rules are refused", () => {
  const w = world();
  const policy = { id: w.id, policyRev: 4n, secretRev: 3n, committeeId: w.a.sourceCommitteeId, paused: false, rules: rulesHex(RULES) };
  const p = planRewrap({ policy, bundle: { data: w.facts.bundle.data }, dest: { committeeId: w.a.destCommitteeId, Y: w.facts.dest.Y }, destCodeMeasurement: w.a.destCodeMeasurement,
    leaseEndpoint: "https://app.host.test", rewrapMeasurement: REWRAP_MEAS, expiry: 1_800_003_600 });
  assert.deepEqual([p.admit.expectPolicyRev, p.admit.committeeId, p.admit.setBundle, p.admit.clear, p.admit.rules], [4n, w.a.sourceCommitteeId, false, false, rulesHex(RULES_W)]);
  assert.deepEqual([p.rollback.expectPolicyRev, p.rollback.rules, p.rollback.setBundle], [5n, rulesHex(RULES), false]);
  assert.deepEqual(normalizeAuthorization(p.authorization), normalizeAuthorization({ ...w.a, expiry: "1800003600" }));
  const base = { bundle: { data: w.facts.bundle.data }, dest: { committeeId: w.a.destCommitteeId, Y: w.facts.dest.Y }, destCodeMeasurement: w.a.destCodeMeasurement, leaseEndpoint: "https://app.host.test", rewrapMeasurement: REWRAP_MEAS, expiry: 1 };
  assert.throws(() => planRewrap({ ...base, policy: { ...policy, rules: rulesHex({ ...RULES, ownerRead: true }) } }), /ownerRead/, "the original image cannot parse ownerRead");
  assert.throws(() => planRewrap({ ...base, policy: { ...policy, rules: "0x" + Buffer.from(JSON.stringify(RULES)).toString("hex") } }), /re-encode/);
  assert.throws(() => planRewrap({ ...base, policy: { ...policy, rules: rulesHex(RULES_W) } }), /already admitted/);
  assert.ok(makeUpdateV2);
});

test("the host signs ONLY this deployment's release message with a short expiry; results are shape-checked; QEMU binds HOST_DATA", async () => {
  const op = privateKeyToAccount(generatePrivateKey()), got = [];
  const id = hex32(), endpoint = "https://app.host.test", now = Date.now();
  const api = rewrapHostApi({ chainId: CHAIN, vault: VAULT, id, endpoint, operator: op, onResult: async (b) => got.push(b), now: () => now });
  const srv = http.createServer(api); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const binding = randomBytes(32).toString("hex"), expiry = Math.floor(now / 1000) + 300;
    const message = v2.operatorMessage({ chainId: CHAIN, vault: VAULT, id, endpoint, binding: Buffer.from(binding, "hex"), expiry });
    const ok = await post("/operator-sign", { message, expiry, binding });
    assert.equal(ok.status, 200); assert.equal((await op.signMessage({ message })), ok.body.sig);
    const other = v2.operatorMessage({ chainId: CHAIN, vault: VAULT, id: hex32(), endpoint, binding: Buffer.from(binding, "hex"), expiry });
    assert.deepEqual((await post("/operator-sign", { message: other, expiry, binding })).body.error, "not_this_release");
    assert.deepEqual((await post("/operator-sign", { message, expiry: expiry + 3600, binding })).body.error, "bad_expiry");
    assert.deepEqual((await post("/operator-sign", { message, expiry, binding: "zz" })).body.error, "bad_binding");
    assert.equal((await post("/result", { result: { env: { A: "x" } } })).status, 422, "a result carrying anything else is refused");
    assert.equal((await post("/result", { error: { code: "expired", message: "m" } })).status, 200);
    assert.deepEqual(got, [{ error: { code: "expired", message: "m" } }]);
  } finally { await new Promise((r) => srv.close(r)); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewrap-dist-"));
  fs.writeFileSync(path.join(dir, "cmdline"), "console=ttyS0\n");
  const args = qemuArgs({ dist: dir, ovmf: "/x/OVMF.fd", fwCfgFile: "/x/fw.json", deploymentId: id }).join(" ");
  assert.match(args, new RegExp(`host-data=${Buffer.from(id.slice(2), "hex").toString("base64").replace(/[+/]/g, "\\$&")}`));
  assert.match(args, /kernel-hashes=on/); assert.match(args, /name=opt\/org\.enclave\.rewrap,file=\/x\/fw\.json/);
  fs.rmSync(dir, { recursive: true });
});

test("an unbuilt guest (no measured rewrap configuration) refuses and tells the host only a code", async () => {
  const posted = [];
  await assert.rejects(guestMain({ cfg: { hostUrl: "http://127.0.0.1:1" }, measured: { chainId: CHAIN }, io: { hostPost: async (p, b) => posted.push([p, b]), log: () => {} } }), /no measured rewrap configuration/);
  const lines = [];
  await assert.rejects(guestMain({ cfg: { hostUrl: "x" }, measured: { role: "enclave-custody-rewrap", chainId: CHAIN, vault: VAULT }, io: { hostPost: async (p, b) => { posted.push([p, b]); return {}; }, log: (m) => lines.push(m) } }), /fw_cfg/);
  assert.deepEqual(posted, [["/result", { error: { code: "bad_input", message: "fw_cfg must carry { hostUrl, authorization, signature }" } }]]);
  assert.match(lines.join("\n"), /REFUSED bad_input/);
});
