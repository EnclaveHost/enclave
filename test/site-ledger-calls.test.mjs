// The deployments panel builds raw EnclaveDeployments calldata; for a row a
// SessionVault holds, js/core/sessions.js decodes it and replays it as a session
// action. A mis-decode would act on the wrong thing, so pin the decoder against
// viem's encoder for every owner call the panel sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { decodeLedgerCall, walletRecordPlan, needsCap } from "../site/js/core/ledger-calls.js";

const abi = parseAbi([
  "function setAppRef(bytes32 id, string appRef)", "function setConfig(bytes32 id, string configCid)",
  "function setShares(bytes32 id, uint16 gpuMilli, uint16 cpuMilli)", "function setActive(bytes32 id, bool active)",
  "function setMaxRate(bytes32 id, uint256 maxRate6)", "function refund(bytes32 id)",
  "function transferDeployment(bytes32 id, address to)", "function multicall(bytes[] calls)",
]);
const id = "0x" + "ab".repeat(32);
const enc = (functionName, args) => encodeFunctionData({ abi, functionName, args });

test("every single owner call decodes to its fields", () => {
  assert.deepEqual(decodeLedgerCall(enc("setActive", [id, false])), { fn: "setActive", id, active: false });
  assert.deepEqual(decodeLedgerCall(enc("setActive", [id, true])), { fn: "setActive", id, active: true });
  assert.deepEqual(decodeLedgerCall(enc("setShares", [id, 250, 1000])), { fn: "setShares", id, gpuMilli: 250, cpuMilli: 1000 });
  assert.deepEqual(decodeLedgerCall(enc("setMaxRate", [id, 123456789n])), { fn: "setMaxRate", id, maxRate6: 123456789n });
  assert.deepEqual(decodeLedgerCall(enc("refund", [id])), { fn: "refund", id });
  const ref = "catalog://0x" + "cd".repeat(32) + "/42";
  assert.deepEqual(decodeLedgerCall(enc("setAppRef", [id, ref])), { fn: "setAppRef", id, appRef: ref });
  const cfg = JSON.stringify({ waf: { rps: 50 }, config: { model: "näive ✓ unicode" } });
  assert.deepEqual(decodeLedgerCall(enc("setConfig", [id, cfg])), { fn: "setConfig", id, configCid: cfg });
  assert.deepEqual(decodeLedgerCall(enc("setConfig", [id, ""])), { fn: "setConfig", id, configCid: "" });
  const to = "0x" + "12".repeat(20);
  assert.deepEqual(decodeLedgerCall(enc("transferDeployment", [id, to])), { fn: "transferDeployment", id, to });
});

test("multicall (version + shares in one confirmation) decodes each inner call", () => {
  const ref = "catalog://0x" + "ef".repeat(32) + "/7";
  const inner = [enc("setAppRef", [id, ref]), enc("setShares", [id, 0, 500]), enc("setConfig", [id, "{}"])];
  const out = decodeLedgerCall(enc("multicall", [inner]));
  assert.equal(out.fn, "multicall");
  assert.equal(out.id, id);
  assert.deepEqual(out.calls, [
    { fn: "setAppRef", id, appRef: ref }, { fn: "setShares", id, gpuMilli: 0, cpuMilli: 500 }, { fn: "setConfig", id, configCid: "{}" }]);
});

test("anything else is 'unknown' (the caller then sends the plain wallet tx)", () => {
  assert.equal(decodeLedgerCall("0xdeadbeef" + "00".repeat(32)).fn, "unknown");
});

// A record the connected WALLET holds goes through the session only once the owner has let its vault act
// for it (ledger rev 15d), and only as PRODUCTION: suspend/resume, resize, cancel, a LOWER cap. Anything
// else is the wallet's own transaction (null).
const plan = (data, cap) => walletRecordPlan(decodeLedgerCall(data), cap);

test("wallet record: suspend/resume, resize and cancel become the matching session actions", () => {
  assert.deepEqual(plan(enc("setActive", [id, false])), [{ action: "deploy.setActive", args: { id, active: false } }]);
  assert.deepEqual(plan(enc("setActive", [id, true])), [{ action: "deploy.setActive", args: { id, active: true } }]);
  assert.deepEqual(plan(enc("setShares", [id, 0, 500])), [{ action: "deploy.setShares", args: { id, gpuMilli: 0, cpuMilli: 500 } }]);
  assert.deepEqual(plan(enc("refund", [id])), [{ action: "deploy.refund", args: { id } }]);
  assert.equal(needsCap(decodeLedgerCall(enc("setActive", [id, false]))), false);
});

test("wallet record: a cap only ever goes down (or stays); a raise, or no known cap, is the wallet's", () => {
  assert.equal(needsCap(decodeLedgerCall(enc("setMaxRate", [id, 800n]))), true);
  assert.deepEqual(plan(enc("setMaxRate", [id, 800n]), 1000n), [{ action: "deploy.setMaxRate", args: { id, maxRate6: 800n } }]);
  assert.deepEqual(plan(enc("setMaxRate", [id, 1000n]), 1000n), [{ action: "deploy.setMaxRate", args: { id, maxRate6: 1000n } }]);
  assert.equal(plan(enc("setMaxRate", [id, 1001n]), 1000n), null);
  assert.equal(plan(enc("setMaxRate", [id, 800n])), null, "unknown cap: never guess");
  assert.equal(plan(enc("setMaxRate", [id, 800n]), null), null);
});

test("wallet record: never the version, the config or a transfer - alone or inside a batch", () => {
  assert.equal(plan(enc("setAppRef", [id, "catalog://0x" + "cd".repeat(32) + "/1"])), null);
  assert.equal(plan(enc("setConfig", [id, "{}"])), null);
  assert.equal(plan(enc("transferDeployment", [id, "0x" + "12".repeat(20)])), null);
  assert.equal(plan("0xdeadbeef" + "00".repeat(32)), null);
  assert.equal(plan(enc("multicall", [[enc("setShares", [id, 0, 500]), enc("setAppRef", [id, "catalog://0x" + "cd".repeat(32) + "/1"])]])), null);
  assert.equal(plan(enc("multicall", [[enc("setActive", [id, false]), enc("transferDeployment", [id, "0x" + "12".repeat(20)])]])), null);
  // a nested batch is not unpacked
  assert.equal(plan(enc("multicall", [[enc("multicall", [[enc("setActive", [id, false])]])]])), null);
});

test("wallet record: a batch of allowed calls on ONE record goes call by call; another record in it is the wallet's", () => {
  const out = plan(enc("multicall", [[enc("setActive", [id, false]), enc("setShares", [id, 0, 250]), enc("setMaxRate", [id, 900n]),
    enc("setMaxRate", [id, 700n]), enc("setActive", [id, true])]]), 1000n);
  assert.deepEqual(out.map((p) => p.action), ["deploy.setActive", "deploy.setShares", "deploy.setMaxRate", "deploy.setMaxRate", "deploy.setActive"]);
  assert.deepEqual(out[3].args, { id, maxRate6: 700n });
  // each lowering is judged against the cap the previous one left
  assert.equal(plan(enc("multicall", [[enc("setMaxRate", [id, 700n]), enc("setMaxRate", [id, 900n])]]), 1000n), null);
  const other = "0x" + "cd".repeat(32);
  assert.equal(plan(enc("multicall", [[enc("setActive", [id, false]), enc("setActive", [other, false])]])), null);
  assert.equal(plan(enc("multicall", [[]])), null, "an empty batch");
});
