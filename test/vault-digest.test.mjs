// The credit vault's client-side gate (site/js/core/vault.js + keccak.js).
//
// A WebAuthn assertion signs 32 opaque bytes. EnclaveCreditVault checks that
// those bytes are the digest of the operation it is executing — it cannot check
// that they are the digest of the operation the CUSTOMER asked for, and the
// relay sits between the two. So the page recomputes the digest and compares
// the described operation against its own arguments before the passkey is ever
// prompted. These cases pin that recomputation to the CONTRACT's abi.encode
// (via viem, which is what the relay uses too) and drive the refusals a lying
// relay would trip — above all the publisher-fee one, where create()'s
// feeRecipient/feePerSec6 would divert most of a funding to a third party.
//
//   run: node --test test/vault-digest.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, encodeAbiParameters, encodeFunctionData, stringToBytes } from "viem";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { keccak256Hex, keccak256Utf8 } = await import(path.join(REPO, "site/js/core/keccak.js"));
const { opDigest, decodeCreateCall, expectedControlCall, verifyPrepare } =
  await import(path.join(REPO, "site/js/core/vault.js"));

// ---------- keccak256 itself --------------------------------------------------

test("keccak256: matches viem across block boundaries and unicode", () => {
  for (const n of [0, 1, 31, 32, 135, 136, 137, 271, 272, 1000]) {
    const hex = "0x" + "5a".repeat(n);
    assert.equal(keccak256Hex(hex), keccak256(hex), `${n} bytes`);
  }
  for (const s of ["", "EnclaveVault.deployAndFund.v1", "hello world", "🔐 unicode ✓", "a".repeat(200)])
    assert.equal(keccak256Utf8(s), keccak256(stringToBytes(s)), JSON.stringify(s.slice(0, 20)));
});

// ---------- the digest --------------------------------------------------------

const VAULT = "0x" + "a1".repeat(20);
const CHAIN = 8453;
const DEADLINE = 1_800_000_000;
const ID = "0x" + "7b".repeat(32);
const SPEC = { appRef: "catalog://0x" + "cc".repeat(32) + "/3", gpuMilli: 0, cpuMilli: 120,
               appPort: 8080, ports: "tcp:7777", isPublic: true };

const createCallFor = ({ feeRecipient = "0x0000000000000000000000000000000000000000", feePerSec6 = 0n, spec = SPEC } = {}) =>
  encodeFunctionData({
    abi: [{ type: "function", name: "create", stateMutability: "nonpayable", outputs: [{ type: "bytes32" }], inputs: [
      { name: "appRef", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" },
      { name: "appPort", type: "uint32" }, { name: "ports", type: "string" }, { name: "isPublic", type: "bool" },
      { name: "configCid", type: "string" }, { name: "feeRecipient", type: "address" }, { name: "feePerSec6", type: "uint256" }] }],
    functionName: "create",
    args: [spec.appRef, spec.gpuMilli, spec.cpuMilli, spec.appPort, spec.ports, spec.isPublic, spec.configCid ?? "",
           feeRecipient, feePerSec6],
  });

// EnclaveCreditVault._auth's own abi.encode, spelled out per op
const B32 = { type: "bytes32" }, U256 = { type: "uint256" }, ADDR = { type: "address" };
const contractDigest = (op, p) => {
  const tag = keccak256(toHex({ deploy: "EnclaveVault.deployAndFund.v1", fund: "EnclaveVault.fundDeployment.v1",
                                control: "EnclaveVault.controlDeployment.v1", refund: "EnclaveVault.refundToTreasury.v1" }[op]));
  const head = [tag, p.vault, BigInt(p.chainId), BigInt(p.nonce)];
  const t = [B32, ADDR, U256, U256];
  if (op === "deploy")  return keccak256(encodeAbiParameters([...t, B32, U256, U256], [...head, keccak256(p.createCall), BigInt(p.fund6), BigInt(p.deadline)]));
  if (op === "fund")    return keccak256(encodeAbiParameters([...t, B32, U256, U256], [...head, p.id, BigInt(p.fund6), BigInt(p.deadline)]));
  if (op === "control") return keccak256(encodeAbiParameters([...t, B32, U256], [...head, keccak256(p.callData), BigInt(p.deadline)]));
  return keccak256(encodeAbiParameters([...t, U256, U256], [...head, BigInt(p.amount6), BigInt(p.deadline)]));
};

test("opDigest: every op matches the contract's abi.encode, at every nonce", () => {
  const createCall = createCallFor();
  for (const nonce of [0, 1, 7, 2n ** 40n]) {
    const cases = {
      deploy:  { vault: VAULT, chainId: CHAIN, nonce, deadline: DEADLINE, createCall, fund6: "12340000" },
      fund:    { vault: VAULT, chainId: CHAIN, nonce, deadline: DEADLINE, id: ID, fund6: "500000" },
      control: { vault: VAULT, chainId: CHAIN, nonce, deadline: DEADLINE, callData: expectedControlCall({ id: ID, action: "suspend" }) },
      refund:  { vault: VAULT, chainId: CHAIN, nonce, deadline: DEADLINE, amount6: "999999" },
    };
    for (const [op, p] of Object.entries(cases))
      assert.equal(opDigest(op, p), contractDigest(op, p), `${op} @ nonce ${nonce}`);
  }
});

// ---------- reading create() back ---------------------------------------------

test("decodeCreateCall: round-trips viem's encoding, fee arguments included", () => {
  const evil = "0x" + "ba".repeat(20);
  const d = decodeCreateCall(createCallFor({ feeRecipient: evil, feePerSec6: 1389n }));
  assert.equal(d.appRef, SPEC.appRef);
  assert.equal(d.gpuMilli, 0);
  assert.equal(d.cpuMilli, 120);
  assert.equal(d.appPort, 8080);
  assert.equal(d.ports, "tcp:7777");
  assert.equal(d.isPublic, true);
  assert.equal(d.configCid, "");
  assert.equal(d.feeRecipient, evil);
  assert.equal(d.feePerSec6, 1389n);
  // an encoding this side cannot account for is a refusal, not a shrug
  assert.throws(() => decodeCreateCall("0xdeadbeef" + "00".repeat(64)), /not a create\(\)/);
});

// ---------- control calldata --------------------------------------------------

const depCall = (name, inputs, args) => encodeFunctionData({
  abi: [{ type: "function", name, stateMutability: "nonpayable", inputs, outputs: [] }], functionName: name, args });
const B = { name: "id", type: "bytes32" };

test("expectedControlCall: each action rebuilds byte-identical to viem", () => {
  const ref = "catalog://0x" + "cc".repeat(32) + "/4";
  assert.equal(expectedControlCall({ id: ID, action: "suspend" }),
    depCall("setActive", [B, { type: "bool" }], [ID, false]));
  assert.equal(expectedControlCall({ id: ID, action: "resume" }),
    depCall("setActive", [B, { type: "bool" }], [ID, true]));
  assert.equal(expectedControlCall({ id: ID, action: "version", ref }),
    depCall("setAppRef", [B, { type: "string" }], [ID, ref]));
  assert.equal(expectedControlCall({ id: ID, action: "options", envelope: '{"waf":{"rps":10}}' }),
    depCall("setConfig", [B, { type: "string" }], [ID, '{"waf":{"rps":10}}']));
  assert.equal(expectedControlCall({ id: ID, action: "resize", gpuMilli: 250, cpuMilli: 200 }),
    depCall("setShares", [B, { type: "uint16" }, { type: "uint16" }], [ID, 250, 200]));
  // version + resize ride one signature as a multicall
  assert.equal(expectedControlCall({ id: ID, action: "resize", gpuMilli: 250, cpuMilli: 200, ref }),
    encodeFunctionData({ abi: [{ type: "function", name: "multicall", stateMutability: "nonpayable",
      inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] }], functionName: "multicall",
      args: [[depCall("setAppRef", [B, { type: "string" }], [ID, ref]),
              depCall("setShares", [B, { type: "uint16" }, { type: "uint16" }], [ID, 250, 200])]] }));
});

// ---------- the gate ----------------------------------------------------------

const prepFor = (op, p) => ({ ...p, vault: VAULT, chainId: CHAIN, nonce: 3, deadline: DEADLINE,
                              digest: opDigest(op, { ...p, vault: VAULT, chainId: CHAIN, nonce: 3, deadline: DEADLINE }) });

test("verifyPrepare: an honest prepare passes for every op", () => {
  verifyPrepare("deploy", prepFor("deploy", { createCall: createCallFor(), fund6: "10000000" }),
    { spec: SPEC, fundUsd: 10 });
  verifyPrepare("fund", prepFor("fund", { id: ID, fund6: "5000000" }), { id: ID, amountUsd: 5 });
  verifyPrepare("refund", prepFor("refund", { amount6: "5000000" }), { amountUsd: 5 });
  verifyPrepare("control", prepFor("control", { callData: expectedControlCall({ id: ID, action: "suspend" }) }),
    { id: ID, action: "suspend" });
});

test("verifyPrepare: a publisher fee smuggled into create() is refused", () => {
  const createCall = createCallFor({ feeRecipient: "0x" + "ba".repeat(20), feePerSec6: 1389n });
  assert.throws(() => verifyPrepare("deploy", prepFor("deploy", { createCall, fund6: "10000000" }),
    { spec: SPEC, fundUsd: 10 }), /publisher fee to a third party/);
  // …even at a fee of zero to a non-zero wallet, and vice versa
  for (const bad of [{ feeRecipient: "0x" + "ba".repeat(20), feePerSec6: 0n }, { feePerSec6: 7n }])
    assert.throws(() => verifyPrepare("deploy", prepFor("deploy", { createCall: createCallFor(bad), fund6: "1" }),
      { spec: SPEC, fundUsd: 10 }), /publisher fee/);
});

test("verifyPrepare: a swapped app, share, port, visibility or config is refused", () => {
  const cases = [
    [{ ...SPEC, appRef: "catalog://0x" + "ee".repeat(32) + "/1" }, /different app/],
    [{ ...SPEC, cpuMilli: 900 }, /different shares/],
    [{ ...SPEC, gpuMilli: 500 }, /different shares/],
    [{ ...SPEC, appPort: 9999 }, /different port/],
    [{ ...SPEC, ports: "tcp:22" }, /different declared ports/],
    [{ ...SPEC, isPublic: false }, /different visibility/],
    [{ ...SPEC, configCid: '{"waf":{"rps":1}}' }, /different config/],
  ];
  for (const [spec, re] of cases)
    assert.throws(() => verifyPrepare("deploy", prepFor("deploy", { createCall: createCallFor({ spec }), fund6: "1" }),
      { spec: SPEC, fundUsd: 10 }), re, JSON.stringify(spec).slice(0, 60));
});

test("verifyPrepare: no op may take more than the amount that was entered", () => {
  assert.throws(() => verifyPrepare("deploy", prepFor("deploy", { createCall: createCallFor(), fund6: "10000001" }),
    { spec: SPEC, fundUsd: 10 }), /larger amount/);
  assert.throws(() => verifyPrepare("fund", prepFor("fund", { id: ID, fund6: "5000001" }),
    { id: ID, amountUsd: 5 }), /larger amount/);
  assert.throws(() => verifyPrepare("refund", prepFor("refund", { amount6: "5000001" }),
    { amountUsd: 5 }), /larger amount/);
  // rounding down is fine — the relay converts dollars to whole seconds
  verifyPrepare("fund", prepFor("fund", { id: ID, fund6: "4999997" }), { id: ID, amountUsd: 5 });
});

test("verifyPrepare: funding somebody else's deployment, or a different change, is refused", () => {
  assert.throws(() => verifyPrepare("fund", prepFor("fund", { id: "0x" + "99".repeat(32), fund6: "1" }),
    { id: ID, amountUsd: 5 }), /different deployment/);
  assert.throws(() => verifyPrepare("control", prepFor("control", { callData: expectedControlCall({ id: ID, action: "suspend" }) }),
    { id: ID, action: "resume" }), /different change/);
  assert.throws(() => verifyPrepare("control",
    prepFor("control", { callData: expectedControlCall({ id: "0x" + "99".repeat(32), action: "resume" }) }),
    { id: ID, action: "resume" }), /different change/);
});

test("verifyPrepare: a digest that is not the digest of its own fields is refused", () => {
  const good = prepFor("fund", { id: ID, fund6: "5000000" });
  assert.throws(() => verifyPrepare("fund", { ...good, digest: "0x" + "11".repeat(32) },
    { id: ID, amountUsd: 5 }), /does not match the operation/);
  // the classic: correct fields, digest computed at a DIFFERENT nonce, so the
  // signature would authorize whatever else the relay has queued at nonce 3
  assert.throws(() => verifyPrepare("fund", { ...good, digest: opDigest("fund", { ...good, nonce: 4 }) },
    { id: ID, amountUsd: 5 }), /does not match the operation/);
});
