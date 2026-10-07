// The deployments panel builds raw EnclaveDeployments calldata; for a row a
// SessionVault holds, js/core/sessions.js decodes it and replays it as a session
// action. A mis-decode would act on the wrong thing, so pin the decoder against
// viem's encoder for every owner call the panel sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { decodeLedgerCall } from "../site/js/core/ledger-calls.js";

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
