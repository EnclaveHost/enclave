// isolation/restore/owner-payloads.mjs: the decisions around the owner's setConfig signature, without a chain
// (enclave-d1's review of 41afeb14). A synthetic transaction and receipt for a synthetic payload must pass txReasons,
// and each way a signed transaction can differ from its reviewed payload must be named. payloadHeaderReasons guards
// what the signer copies into the Trezor (to, from, value, chainId).
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters } from "viem";
import { OWNER, DEP_ABI, txReasons, payloadHeaderReasons, withIsolation, parseEnvelope, fundingOf } from "../isolation/restore/owner-payloads.mjs";

const LEDGER = "0xF9e71385C5cB49844F2457ba6567De0742f8B89a";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const ID = "0x" + "ab".repeat(32);
const before = '{"configCid":"bafkreisyntheticenvelope","waf":{"rps":10}}';
const after = withIsolation(before, parseEnvelope(before));
const data = encodeFunctionData({ abi: DEP_ABI, functionName: "setConfig", args: [ID, after] });
const preserved = { owner: OWNER, appRef: "catalog://0x" + "cd".repeat(32) + "/0", rate: "1", cap6: "9" };
const payload = { deployment: ID, short: "abababab", chainId: 8453, from: OWNER, to: LEDGER, value: "0", data,
                  envelopeBefore: before, envelopeAfter: after, preserved };
const configSet = ({ address = LEDGER, id = ID, env = after } = {}) => ({ address,
  topics: encodeEventTopics({ abi: DEP_ABI, eventName: "ConfigSet", args: { id } }),
  data: encodeAbiParameters([{ type: "string" }], [env]) });
const good = () => ({ tx: { input: data, to: LEDGER, from: OWNER, value: 0n },
                      receipt: { status: "success", logs: [configSet()] },
                      post: { configCid: after, preserved: { ...preserved } } });
const run = (mutate = () => {}) => {
  const g = good(); mutate(g);
  return txReasons({ tx: g.tx, tx2: g.tx2 || g.tx, receipt: g.receipt, receipt2: g.receipt2 || g.receipt,
                     payload, ledger: LEDGER, post: g.post });
};

test("the envelope is the old bytes with isolation spliced in, and nothing else", () => {
  assert.ok(after.startsWith(before.slice(0, -1) + ","));
  assert.deepEqual(JSON.parse(after), { ...JSON.parse(before), isolation: { require: "snp-guest-per-app" } });
});

test("a transaction that IS its payload passes", () => {
  assert.deepEqual(run(), []);
});

test("every way a signed transaction can differ from its payload is named", () => {
  const otherData = encodeFunctionData({ abi: DEP_ABI, functionName: "setConfig", args: [ID, before] });
  const cases = [
    ["another input", (g) => { g.tx.input = otherData; }, "NOT the reviewed calldata"],
    ["another contract", (g) => { g.tx.to = OTHER; }, "not the ledger"],
    ["another sender", (g) => { g.tx.from = OTHER; }, "not the owner"],
    ["value carried", (g) => { g.tx.value = 1n; }, "carried value"],
    ["a reverted receipt", (g) => { g.receipt.status = "reverted"; }, "receipt says reverted"],
    ["no ConfigSet", (g) => { g.receipt.logs = []; }, "0 ConfigSet"],
    ["two ConfigSets", (g) => { g.receipt.logs = [configSet(), configSet()]; }, "2 ConfigSet"],
    ["a ConfigSet from another contract", (g) => { g.receipt.logs = [configSet({ address: OTHER })]; }, "0 ConfigSet"],
    ["a ConfigSet for another id", (g) => { g.receipt.logs = [configSet({ id: "0x" + "ef".repeat(32) })]; }, "not exactly one for this id"],
    ["a ConfigSet with another envelope", (g) => { g.receipt.logs = [configSet({ env: before })]; }, "not exactly one for this id"],
    ["the RPCs disagree on the input", (g) => { g.tx2 = { ...g.tx, input: otherData }; }, "disagree"],
    ["the RPCs disagree on the status", (g) => { g.receipt2 = { ...g.receipt, status: "reverted" }; }, "disagree"],
    ["the envelope afterwards", (g) => { g.post.configCid = before; }, "envelope now is not the signed one"],
    ["a preserved field afterwards", (g) => { g.post.preserved.rate = "2"; }, "preserved fields changed: rate"],
  ];
  for (const [what, mutate, want] of cases) {
    const why = run(mutate);
    assert.ok(why.some((r) => r.includes(want)), `${what}: got ${JSON.stringify(why)}`);
  }
});

test("a payload is refused if it would send the signature anywhere but the ledger, from the owner, with no value, on Base", () => {
  assert.deepEqual(payloadHeaderReasons(payload, LEDGER), []);
  for (const [what, edit, want] of [
    ["to", { to: OTHER }, `"to" is`],
    ["from", { from: OTHER }, `"from" is`],
    ["value", { value: "1" }, "value is"],
    ["chainId", { chainId: 1 }, "chainId is"],
    ["a malformed to", { to: "not an address" }, `"to" is`],
  ]) {
    const why = payloadHeaderReasons({ ...payload, ...edit }, LEDGER);
    assert.ok(why.some((r) => r.includes(want)), `${what}: got ${JSON.stringify(why)}`);
  }
  // and txReasons applies the same header rules
  assert.ok(txReasons({ tx: good().tx, tx2: good().tx, receipt: good().receipt, receipt2: good().receipt,
    payload: { ...payload, to: OTHER }, ledger: LEDGER, post: good().post }).some((r) => r.includes(`"to" is`)));
});

test("funding: the claim's rule as the host applies it (price rounded UP, cap, one second), and the runtime it buys", () => {
  // metal-iso0 on 09-25: 834 µUSDC/s for the full node; 1% = ceil(8.34) = 9, exactly the owners' cap of 9
  const at = (o) => fundingOf({ askCpu6: 834, cpuMilli: 10, cap6: 9, balance6: 129400, ...o });
  assert.deepEqual(at({}), { mine6: 9, total6: 9, refusal: null, runtimeS: 14377 });
  assert.equal(at({ askCpu6: 801 }).refusal, null);                                  // ceil(8.01) = 9: still within the cap
  assert.equal(at({ askCpu6: 900 }).refusal, null);                                  // 9.00: the last ask the cap admits
  assert.match(at({ askCpu6: 901 }).refusal, /above the owner's cap of 9/);
  assert.match(at({ fee6: 1 }).refusal, /above the owner's cap/);                     // the publisher fee counts toward the cap
  assert.equal(at({ cap6: 0, askCpu6: 5000 }).refusal, null);                         // 0 = uncapped (grandfathered)
  assert.match(at({ balance6: 8 }).refusal, /less than one second/);
  assert.deepEqual(at({ waived: true }), { mine6: 0, total6: 0, refusal: null, runtimeS: null });   // free self-hosting, no fee
  assert.equal(at({ waived: true, fee6: 2 }).runtimeS, 64700);
});
