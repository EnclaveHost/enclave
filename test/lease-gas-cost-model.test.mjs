// The owner cost model's renewal count follows the DEPLOYED ledger (rev 16d, frozen source
// test/fixtures/ledger-rev16d-source/EnclaveDeployments.sol), where the two kinds of lease renew at different rates:
//   - _burnLease: until = (rate == 0 ? block.timestamp : from) + secs, and renew() passes from = leaseUntil. A rate-0
//     (self-hosted) renew therefore restarts the lease from its own block and gives up the lead it landed with: one renew
//     every leaseSec - lead. A paid renew extends from leaseUntil: one per extension, wherever it lands.
//   - the reserve sponsors a renew only inside [leaseUntil - renewWindow, leaseUntil] (NotInRenewWindow), so the window is
//     the conservative rate-0 lead. Measured on Base 2026-10-21 (458 renewals, renewWindow 300): free cycle 1520..1628 s.
// Pure arithmetic against an independent transcription of those rules; the ledger itself runs in
// test/lease-gas-cost-model-ledger.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renewalCadence, renewalsFor, renewsPerDay, budgetAmount, costModel, knownRate6, advise, OwnerRefusal } from "../network/lease-gas-owner.mjs";

/** The ledger's rule, transcribed: claim at 0 buys `ext`; while the lease ends inside the period, a renew lands `lead`
 *  before leaseUntil and sets leaseUntil = (rate 0 ? landing : leaseUntil) + ext. */
function ledger(seconds, { rate0, leaseSec, ext = leaseSec, lead }) {
  let until = ext, renewals = 0;
  const at = [];
  while (until < seconds) { const landing = until - lead; at.push(landing); until = (rate0 ? landing : until) + ext; renewals++; }
  return { renewals, at };
}
const L = 1800;

test("the frozen ledger source: a rate-0 lease restarts from the renew's block, a paid one extends from leaseUntil", () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/ledger-rev16d-source/EnclaveDeployments.sol"), "utf8");
  const renew = src.slice(src.indexOf("function renew(bytes32 id) external"), src.indexOf("function renew(bytes32 id) external") + 900);
  assert.match(renew, /_burnLease\(d, d\.leaseUntil\)/);
  const burn = src.slice(src.indexOf("function _burnLease("), src.indexOf("function _burnLease(") + 1600);
  assert.match(burn, /uint256 secs = rate == 0 \? leaseSec : d\.balance6 \/ rate;/);
  assert.match(burn, /until = \(rate == 0 \? uint64\(block\.timestamp\) : from\) \+ uint64\(secs\);/);
  // and the reserve's renew gate: no sponsored renew earlier than renewWindow before leaseUntil, none below minExtension
  const reserve = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../contracts/EnclaveLeaseGasReserve.sol"), "utf8");
  assert.match(reserve, /if \(block\.timestamp \+ r\.renewWindow < d\.leaseUntil\) return \(Status\.NotInRenewWindow, d\.owner\);/);
  assert.match(reserve, /if \(secs == 0 \|\| secs < r\.minExtension\) return \(Status\.ExtensionTooShort, d\.owner\);/);
});

test("31 days: a paid lease needs 48 a day whatever the lead; a rate-0 lease needs more, by its lead", () => {
  const T = 31 * 86400;
  for (const lead of [0, 15, 222, 260, 280, 285, 300]) {
    const free = ledger(T, { rate0: true, leaseSec: L, lead }), paid = ledger(T, { rate0: false, leaseSec: L, lead });
    assert.equal(renewalsFor(T, { leaseSec: L, rate6: 0n, renewLeadSec: lead }), BigInt(free.renewals), `rate 0, lead ${lead}`);
    assert.equal(renewalsFor(T, { leaseSec: L, rate6: 5n, renewWindow: 300 }), BigInt(paid.renewals), `paid, lead ${lead}`);
    assert.equal(paid.renewals, 31 * 48 - 1);
    for (let i = 1; i < free.at.length; i++) assert.equal(free.at[i] - free.at[i - 1], L - lead, "rate 0: one renew per leaseSec - lead");
    for (let i = 1; i < paid.at.length; i++) assert.equal(paid.at[i] - paid.at[i - 1], L, "paid: one renew per leaseSec");
    if (lead > 0) assert.ok(free.renewals > paid.renewals);
    else assert.equal(free.renewals, paid.renewals, "a renew landing exactly at leaseUntil loses nothing");
  }
});

test("renewals a day: 57.6 at the 300 s window bound, ~56 at the measured lead, 48 paid; the old one-argument shape refuses", () => {
  assert.equal(renewsPerDay({ leaseSec: L, rate6: 0n, renewWindow: 300 }), 57.6);
  assert.equal(renewsPerDay({ leaseSec: L, rate6: 0n, renewWindow: 300, renewLeadSec: 262 }), 86400 / 1538);   // the measured median cycle
  assert.equal(renewsPerDay({ leaseSec: L, rate6: 2n, renewWindow: 300 }), 48);
  assert.equal(renewsPerDay({ leaseSec: L, renewWindow: 300 }), 57.6, "rate unknown: the more frequent");
  // the window bound is never below what the chain showed: the fastest measured free cycle was 1520 s
  assert.ok(renewsPerDay({ leaseSec: L, rate6: 0n, renewWindow: 300 }) >= 86400 / 1520);
  assert.throws(() => renewsPerDay(1800), /different rates/);
  assert.throws(() => renewalsFor(86400), /different rates/);
  assert.throws(() => renewalsFor(86400, { leaseSec: L }), /name the renew window/, "the old shape counts no rate-0 lease silently");
  assert.throws(() => renewalsFor(86400, { leaseSec: L, rate6: 0n }), /name the renew window/);
  assert.equal(renewalsFor(86400, { leaseSec: L, rate6: 1n }), 47n, "a paid count needs no lead");
});

test("boundaries: the claim's own quantum, one second past it, one cycle past it", () => {
  const free = { leaseSec: L, rate6: 0n, renewWindow: 300 }, paid = { leaseSec: L, rate6: 1n };
  for (const o of [free, paid]) { assert.equal(renewalsFor(0, o), 0n); assert.equal(renewalsFor(L, o), 0n); assert.equal(renewalsFor(L + 1, o), 1n); }
  assert.equal(renewalsFor(L + 1500, free), 1n); assert.equal(renewalsFor(L + 1501, free), 2n);
  assert.equal(renewalsFor(2 * L, paid), 1n); assert.equal(renewalsFor(2 * L + 1, paid), 2n);
  assert.equal(renewalsFor(L + 1500, paid), 1n);
  // the result of renewalCadence is itself an input (budgets pass the cost model's cadence)
  assert.equal(renewalsFor(31 * 86400, renewalCadence(free)), renewalsFor(31 * 86400, free));
});

test("explicit inputs are checked: lead within the window and below leaseSec, extension within leaseSec and minExtension", () => {
  assert.throws(() => renewalCadence({ leaseSec: L, rate6: 0n, renewWindow: 300, renewLeadSec: 301 }), /cannot land 301 s/);
  const e = (() => { try { renewalCadence({ leaseSec: L, rate6: 0n, renewWindow: 1800 }); } catch (x) { return x; } })();
  assert.ok(e instanceof OwnerRefusal && e.unbounded, "a window of leaseSec or more bounds nothing");
  assert.throws(() => renewalCadence({ leaseSec: L, renewLeadSec: 1800 }), /not below leaseSec/);
  assert.doesNotThrow(() => renewalCadence({ leaseSec: L, rate6: 3n, renewWindow: 1800 }), "a paid lease does not depend on the lead");
  for (const bad of [{ leaseSec: 0, rate6: 1n }, { leaseSec: L, rate6: -1n }, { leaseSec: L, rate6: 1n, extensionSec: 0 }, { leaseSec: L, rate6: 1n, extensionSec: L + 1 },
    { leaseSec: L, rate6: 0n, renewLeadSec: -1 }, { leaseSec: L, rate6: 0n, renewLeadSec: 1.5 }, { leaseSec: "x", rate6: 1n }])
    assert.throws(() => renewalCadence(bad), OwnerRefusal, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.throws(() => renewalCadence({ leaseSec: L, rate6: 1n, extensionSec: 599, minExtension: 600 }), /minimum extension is 600 s/);
  assert.equal(renewalCadence({ leaseSec: L, rate6: 1n, extensionSec: 600, minExtension: 600 }).cycleSec, 600);
  assert.match(renewalCadence({ leaseSec: L, rate6: 0n, renewWindow: 300, minExtension: 1801 }).refused, /^ExtensionTooShort/);
  assert.equal(renewalCadence({ leaseSec: L, rate6: 0n, renewWindow: 300, minExtension: 600 }).refused, null);
});

test("an unknown rate counts the more frequent of rate 0 and paid, at every period", () => {
  for (const extensionSec of [undefined, 600, 1499, 1500, 1501]) for (const T of [1, 1800, 1801, 3300, 3301, 86400, 31 * 86400]) {
    const free = renewalsFor(T, { leaseSec: L, rate6: 0n, renewWindow: 300 }), paid = renewalsFor(T, { leaseSec: L, rate6: 1n, extensionSec });
    assert.equal(renewalsFor(T, { leaseSec: L, renewWindow: 300, extensionSec }), free > paid ? free : paid, `T ${T}, extension ${extensionSec}`);
  }
  assert.equal(renewalCadence({ leaseSec: L, renewWindow: 300, extensionSec: 600 }).cycleSec, 600, "a short paid extension renews more often than rate 0");
  assert.equal(renewalCadence({ leaseSec: L, renewWindow: 300 }).model, "rate-unknown");
});

test("the rate is known only for a live lease held by a runner (the next claim snapshots a new one)", () => {
  const st = (leaseLive, runnerOperator, rate6) => ({ ledger: { leaseLive, runnerOperator, rate6 } });
  const op = "0x1A01194c34Fe3577C6d0a54feB78af6253e494e0";
  assert.equal(knownRate6(st(true, op, 0n)), 0n);
  assert.equal(knownRate6(st(true, op, 2n)), 2n);
  assert.equal(knownRate6(st(false, op, 2n)), null, "expired: the next claim decides");
  assert.equal(knownRate6(st(true, "0x0000000000000000000000000000000000000000", 0n)), null);
  assert.equal(knownRate6(undefined), null);
});

// a cost model at a fixed fee (the limits shape appStatus reads)
const LIMITS = { maxGasPriceCeiling: 10n ** 9n, overhead: { claim: 29_500n, renew: 24_000n, release: 7_000n }, minClaimInterval: 60n, l1Bps: 0n };
const POLICY = { maxGasPrice: 50_000_000n, renewWindow: 300, minExtension: 600 };
const model = (o = {}) => costModel({ limits: LIMITS, policy: POLICY, effectiveFee: 6_000_000n, l1UpperWei: 0n, leaseSec: L, ...o });

test("costModel: per-day renewals and wei by the lease's rate; an unconfigured reserve uses the default window and says so", () => {
  const free = model({ rate6: 0n }), paid = model({ rate6: 2n }), unknown = model(), measured = model({ rate6: 0n, renewLeadSec: 260 });
  const renew = free.perOp.renew.wei;
  assert.equal(free.renewsPerDay, 57.6); assert.equal(free.renewPerDayWei, (renew * 86400n + 1499n) / 1500n);
  assert.equal(paid.renewsPerDay, 48); assert.equal(paid.renewPerDayWei, renew * 48n);
  assert.equal(unknown.renewsPerDay, 57.6); assert.equal(unknown.renewal.model, "rate-unknown");
  assert.equal(measured.renewal.cycleSec, 1540); assert.equal(measured.renewal.renewLeadFrom, "given");
  assert.match(free.renewalModel, /restarts the lease from its own block/); assert.match(paid.renewalModel, /extends from leaseUntil/);
  const unconfigured = model({ policy: { maxGasPrice: 0n, renewWindow: 0, minExtension: 0 }, rate6: 0n });
  assert.equal(unconfigured.renewal.renewWindow, 300); assert.match(unconfigured.renewalModel, /not configured: the default policy's 300 s window/);
  assert.throws(() => model({ rate6: 0n, renewLeadSec: 301 }), /cannot land 301 s/, "an explicit lead the reserve would refuse is an error, not a figure");
});

test("costModel: a window of leaseSec or more is reported unbounded, not counted; advise warns", () => {
  const c = model({ policy: { ...POLICY, renewWindow: 1800 }, rate6: 0n });
  assert.equal(c.renewsPerDay, null); assert.equal(c.renewPerDayWei, null); assert.match(c.renewal.unbounded, /nothing bounds how often/);
  assert.equal(model({ policy: { ...POLICY, renewWindow: 1800 }, rate6: 2n }).renewsPerDay, 48, "a paid lease is still bounded");
  const st = { reserve: { configured: true, enabled: true, balanceWei: 10n ** 14n, maxGasPrice: 50_000_000n, maxPerOpWei: 10n ** 15n }, gates: { claimBond6: 0n }, runner: null, ledger: { rate6: 0n } };
  assert.ok(advise(st, { cost: c }).some((x) => x.level === "warn" && /nothing bounds/.test(x.text)));
  const refused = model({ policy: { ...POLICY, minExtension: 1801 }, rate6: 0n });
  assert.ok(advise(st, { cost: refused }).some((x) => x.level === "warn" && /ExtensionTooShort/.test(x.text)));
});

test("advise: the reserve's runway uses the corrected per-day figure", () => {
  const free = model({ rate6: 0n });
  const days = (cost) => Number(/covers about ([\d.]+) days/.exec(advise({ reserve: { configured: true, enabled: true, balanceWei: cost.renewPerDayWei * 2n,
    maxGasPrice: 50_000_000n, maxPerOpWei: 10n ** 15n }, gates: { claimBond6: 0n }, runner: null, ledger: { rate6: 0n } }, { cost: free }).find((x) => /covers about/.test(x.text)).text)[1]);
  assert.equal(days(free), 2);
  // the same balance under the old 48-a-day figure would have read 2.4 days
  assert.ok(free.renewPerDayWei > model({ rate6: 2n }).renewPerDayWei);
});

test("--days budgets are exact integer wei: claim + renewals + release, counted by the lease's rate", () => {
  const per = { claim: { wei: 2_105_297_625_249n }, renew: { wei: 1_272_191_893_751n }, release: { wei: 1_135_457_893_750n } };
  const cost = (rate6) => ({ leaseSec: L, price: 6_000_000n, perOp: per, renewal: renewalCadence({ leaseSec: L, rate6, renewWindow: 300 }) });
  for (const [rate6, n] of [[0n, 1727n], [2n, 1439n], [null, 1727n]]) {
    const a = budgetAmount({ days: 30 }, cost(rate6));
    assert.equal(a.renewals, n, `rate ${rate6}`);
    assert.equal(a.wei, per.claim.wei + n * per.renew.wei + per.release.wei);
    assert.match(a.basis, new RegExp(`one claim \\+ ${n} renewals \\(30 days, leaseSec 1800; `));
  }
  assert.equal(budgetAmount({ days: 30 }, cost(0n)).renewals, BigInt(ledger(30 * 86400, { rate0: true, leaseSec: L, lead: 300 }).renewals));
  assert.throws(() => budgetAmount({}, cost(0n)), /no default amount/);
  assert.throws(() => budgetAmount({ days: 30 }, { leaseSec: L, price: 1n, perOp: per }), /renewal cadence/, "an old cost object is refused, not counted at 48 a day");
  assert.throws(() => budgetAmount({ days: 30 }, model({ policy: { ...POLICY, renewWindow: 1800 }, rate6: 0n })), /cannot be counted/);
  assert.throws(() => budgetAmount({ days: 30 }, model({ policy: { ...POLICY, minExtension: 1801 }, rate6: 0n })), /would buy nothing: ExtensionTooShort/);
  assert.equal(budgetAmount({ perAppWei: "12345" }, null).wei, 12345n, "a fixed amount needs no cost model");
});
