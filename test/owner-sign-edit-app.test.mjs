// rpc/snp/owner-sign/edit-app.mjs: the catalog's displayed text is changed only against the text the plan was
// written for, and text the catalog would refuse is refused before a plan exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedText, editAppStatus, MAX_DESC, MAX_NAME } from "../rpc/snp/owner-sign/edit-app.mjs";

test("text the catalog would refuse is refused, counted in bytes", () => {
  assert.deepEqual(checkedText("Enclave RPC", ""), { name: "Enclave RPC", description: "" });
  assert.deepEqual(checkedText("n".repeat(MAX_NAME), "d".repeat(MAX_DESC)), { name: "n".repeat(MAX_NAME), description: "d".repeat(MAX_DESC) });
  assert.throws(() => checkedText("", "x"), /name must be/);
  assert.throws(() => checkedText("n".repeat(MAX_NAME + 1), "x"), /name must be/);
  assert.throws(() => checkedText("Enclave RPC", "d".repeat(MAX_DESC + 1)), /at most 500/);
  assert.throws(() => checkedText("Enclave RPC", "é".repeat(MAX_DESC / 2 + 1)), /502 bytes/);
  assert.throws(() => checkedText("Enclave RPC", undefined), /must be text/);
});

const plan = { owner: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", steps: [{ id: "edit", to: "0xca", data: "0x01" }],
  status: { catalog: "0xca", appId: "0x" + "0f".repeat(32), oldName: "Enclave RPC", oldDescription: "old", newName: "Enclave RPC", newDescription: "new" } };
function chain(row, { revert = false } = {}) {
  const calls = [];
  return { calls, call: async (c) => { calls.push(c); if (revert) throw new Error("execution reverted"); },
    readContract: async () => ({ name: "Enclave RPC", description: "old", ...row }) };
}

test("ready against the text the plan was written for, done on the new text, blocked on any other", async () => {
  let c = chain({}), st = await editAppStatus(plan, c);
  assert.equal(st.edit, false);
  assert.deepEqual(st.ready, { edit: true });
  assert.deepEqual(c.calls, [{ account: plan.owner, to: "0xca", data: "0x01" }]);

  st = await editAppStatus(plan, chain({}, { revert: true }));
  assert.deepEqual(st.ready, { edit: false });
  assert.match(st.blocked.edit, /would revert/);

  c = chain({ description: "new" }); st = await editAppStatus(plan, c);
  assert.equal(st.edit, true);
  assert.deepEqual(st.ready, { edit: false });
  assert.deepEqual(c.calls, []);

  for (const row of [{ description: "someone else's" }, { name: "Other" }]) {
    c = chain(row); st = await editAppStatus(plan, c);
    assert.equal(st.edit, false);
    assert.deepEqual(st.ready, { edit: false });
    assert.match(st.blocked.edit, /changed after this page was prepared/);
    assert.deepEqual(c.calls, []);
  }
});
