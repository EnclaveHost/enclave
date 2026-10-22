// The owner cost model's renewal count follows the DEPLOYED ledger (rev 16d): claim() buys one extension, renew()
// extends FROM leaseUntil (frozen source forge/src/live/EnclaveDeployments.sol renew -> _burnLease(d, d.leaseUntil)).
// A host renews renewWindow - 15 s before leaseUntil; that moves WHEN, never HOW MANY. Pure arithmetic, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { renewalsFor, renewsPerDay, budgetAmount } from "../network/lease-gas-owner.mjs";

/** Simulate the ledger: claim at 0; while the lease would end inside the period, renew `lead` before leaseUntil. */
function simulate(seconds, { ext, lead }) {
  let until = ext, renewals = 0;
  const at = [];
  while (until < seconds) { at.push(until - lead); until += ext; renewals++; }
  return { renewals, at };
}

test("the frozen ledger source extends a renew FROM leaseUntil (the premise of the model)", () => {
  const src = fs.readFileSync("forge/src/live/EnclaveDeployments.sol", "utf8");
  const renew = src.slice(src.indexOf("function renew(bytes32 id) external"), src.indexOf("function renew(bytes32 id) external") + 900);
  assert.match(renew, /_burnLease\(d, d\.leaseUntil\)/);
});

test("31 days at several renew windows: the count is the recurrence's, independent of the window; 48 a day steady", () => {
  const T = 31 * 86400, leaseSec = 1800;
  for (const renewWindow of [30, 300, 900, 1799]) {
    const sim = simulate(T, { ext: leaseSec, lead: renewWindow - 15 });
    assert.equal(renewalsFor(T, { leaseSec }), BigInt(sim.renewals), `window ${renewWindow}`);
    // every renewal is inside its window and one leaseSec apart (no drift from the window)
    for (let i = 1; i < sim.at.length; i++) assert.equal(sim.at[i] - sim.at[i - 1], leaseSec);
  }
  assert.equal(renewalsFor(T, { leaseSec }), BigInt(31 * 48 - 1));
  assert.equal(renewsPerDay(1800), 48);
  assert.equal(renewalsFor(86400, { leaseSec }), 47n, "one day: the claim covers the first half hour");
  assert.equal(renewalsFor(1800, { leaseSec }), 0n);
  assert.equal(renewalsFor(1801, { leaseSec }), 1n);
});

test("a partly funded paid lease (shorter extensions) renews more often: bounded by the shorter extension", () => {
  const T = 31 * 86400;
  for (const ext of [600, 1200, 1799]) assert.equal(renewalsFor(T, { leaseSec: 1800, extensionSec: ext }), BigInt(simulate(T, { ext, lead: 285 }).renewals));
  assert.ok(renewalsFor(T, { leaseSec: 1800, extensionSec: 600 }) > renewalsFor(T, { leaseSec: 1800 }));
});

test("--days budgets are exact integer wei: claim + renewals + release, no Number rounding", () => {
  const cost = { leaseSec: 1800, price: 6_000_000n, perOp: { claim: { wei: 2_105_297_625_249n }, renew: { wei: 1_272_191_893_751n }, release: { wei: 1_135_457_893_750n } } };
  const a = budgetAmount({ days: 30 }, cost);
  assert.equal(a.renewals, 1439n);
  assert.equal(a.wei, 2_105_297_625_249n + 1439n * 1_272_191_893_751n + 1_135_457_893_750n);
  assert.throws(() => budgetAmount({}, cost), /no default amount/);
});
