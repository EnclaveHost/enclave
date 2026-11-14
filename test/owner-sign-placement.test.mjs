// rpc/snp/owner-sign/placement.mjs: pinning a deployment to one host changes the option's placement key and nothing
// else, and the transaction is offered only against the option the plan was written for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placedOption, placementStatus } from "../rpc/snp/owner-sign/placement.mjs";

const HOST = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", OTHER = "0x" + "4d".repeat(32);
const OLD = '{"isolation":{"cpuTee":false,"gpuTee":false}}', NEW = `{"isolation":{"cpuTee":false,"gpuTee":false},"placement":{"hostId":"${HOST}"}}`;

test("the pin is added, replaced or removed and the rest of the option is kept as it is", () => {
  assert.equal(placedOption(OLD, HOST), NEW);
  assert.equal(placedOption("", HOST), `{"placement":{"hostId":"${HOST}"}}`);
  assert.equal(placedOption(`{"placement":{"hostId":"${OTHER}"},"network":{"relay":"us-west"}}`, HOST), `{"placement":{"hostId":"${HOST}"},"network":{"relay":"us-west"}}`);
  assert.equal(placedOption(NEW, null), OLD);
  assert.equal(placedOption(OLD, null), OLD);
});

test("an option hosts would not read a pin from, or a malformed host id, is refused", () => {
  for (const bad of ["bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey", "[]", "null", '"x"']) assert.throws(() => placedOption(bad, HOST), /not JSON|not a JSON object/);
  for (const bad of ["0x2FCE" + "0".repeat(60), "0x12", undefined, ""]) assert.throws(() => placedOption(OLD, bad), /host id/);
});

const soon = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const plan = { owner: "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61", steps: [{ id: "place", to: "0xle", data: "0x01" }],
  status: { ledger: "0xle", deployment: "0x" + "ef".repeat(32), hostId: HOST, oldOption: OLD, newOption: NEW } };
function chain(row, { revert = false } = {}) {
  const calls = [];
  return { calls, call: async (c) => { calls.push(c); if (revert) throw new Error("execution reverted"); },
    readContract: async () => ({ configCid: OLD, runner: OTHER, leaseUntil: soon(), ...row }) };
}

test("ready against the option the plan was written for, done on the new one, blocked on any other", async () => {
  let c = chain({}), st = await placementStatus(plan, c);
  assert.equal(st.place, false);
  assert.deepEqual(st.ready, { place: true });
  assert.deepEqual(c.calls, [{ account: plan.owner, to: "0xle", data: "0x01" }]);
  assert.match(st.note.place, /^Host 0x4d4d4d4d… runs it now \(lease until \d\d:\d\d:\d\dZ\)\.$/);

  st = await placementStatus(plan, chain({}, { revert: true }));
  assert.deepEqual(st.ready, { place: false });
  assert.match(st.blocked.place, /it would revert/);

  c = chain({ configCid: '{"isolation":{"cpuTee":true,"gpuTee":false}}' }); st = await placementStatus(plan, c);
  assert.deepEqual([st.place, st.ready.place, c.calls.length], [false, false, 0]);
  assert.match(st.blocked.place, /changed after this page was prepared/);

  c = chain({ configCid: NEW }); st = await placementStatus(plan, c);
  assert.deepEqual([st.place, st.ready.place, st.blocked.place, c.calls.length], [true, false, null, 0]);
  assert.match(st.note.place, /it stops it and releases the lease before that time/);
  st = await placementStatus(plan, chain({ configCid: NEW, runner: HOST }));
  assert.match(st.note.place, /^The pinned host runs it now/);
  st = await placementStatus(plan, chain({ configCid: NEW, runner: "0x" + "0".repeat(64), leaseUntil: 0n }));
  assert.equal(st.note.place, "No host holds its lease now.");
});
