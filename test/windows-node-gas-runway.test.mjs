// The Windows node's operator-gas runway (windows/node/host.mjs gasRunway): measured from the balance's fall, so a box
// whose proofs burn gas far faster than its renewals is warned in hours, not "200 renewals"; a top-up restarts the
// window; the tray reads it from GET /v1/local/hosting (gas.low).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fakeBaseRpc } from "./helpers/fake-base-rpc.mjs";

const rpc = await fakeBaseRpc();                     // BEFORE chain.mjs loads: it reads BASE_RPCS once
const { gasRunway } = await import("../windows/node/host.mjs");
after(() => rpc.close());

const H = 3600_000, gwei = (n) => BigInt(n) * 10n ** 9n, T0 = 1_790_000_000_000;

test("unmeasured: the renewal count decides, as before", () => {
  assert.equal(gasRunway([], gwei(1_000_000), T0).low, false, "1e15 wei = 2500 renewals");
  const r = gasRunway([], gwei(40_000), T0);
  assert.equal(r.hoursLeft, null); assert.equal(r.renews, 100n); assert.equal(r.low, true);
});

test("measured: plenty of renewals but a fast burn is LOW, and the hours are the balance over the burn", () => {
  const s = [];
  gasRunway(s, gwei(2_070_000), T0);                                  // 0.00207 ETH: ~5000 renewals
  const r = gasRunway(s, gwei(1_770_000), T0 + 2 * H);                // 0.0003 ETH gone in 2 h
  assert.equal(r.renews > 200n, true);
  assert.ok(Math.abs(r.hoursLeft - 11.8) < 0.01, String(r.hoursLeft)); assert.equal(r.low, true);
});

test("a slow burn is not low; under half an hour of samples is not a measurement", () => {
  const s = [];
  gasRunway(s, gwei(2_000_000), T0);
  assert.equal(gasRunway(s, gwei(1_990_000), T0 + 20 * 60_000).hoursLeft, null);
  const r = gasRunway(s, gwei(1_980_000), T0 + 2 * H);                // 0.00002 ETH in 2 h: ~198 h left
  assert.ok(r.hoursLeft > 190); assert.equal(r.low, false);
});

test("a top-up restarts the window; old samples age out past six hours", () => {
  const s = [];
  gasRunway(s, gwei(500_000), T0); gasRunway(s, gwei(100_000), T0 + 2 * H);
  const up = gasRunway(s, gwei(3_000_000), T0 + 3 * H);
  assert.equal(s.length, 1); assert.equal(up.hoursLeft, null); assert.equal(up.low, false);
  for (let h = 4; h <= 12; h++) gasRunway(s, gwei(3_000_000 - (h - 3) * 1000), T0 + h * H);
  assert.ok(T0 + 12 * H - s[1].at <= 6 * H, "the window keeps about six hours");
});
