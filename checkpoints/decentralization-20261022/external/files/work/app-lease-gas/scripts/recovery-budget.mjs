// Budget for the nine expired records (root's live queue) with app-funded lease gas: a MINIMAL bootstrap next to a 30-day
// option. LOCAL INTEGER ARITHMETIC from accepted evidence only - no network, nothing sent, no funding default; a
// proposal for the owner, not an authorization to spend.
//   - per-operation CHARGE (what the APP pays a relay) = the reserve's formula as charged in the accepted Base-fork
//     calibration (fixtures/base-fork-calibration-recalibrated.json, fork10): chargedGas x price + the charged L1 share;
//     where two samples of a kind exist the LARGER is used (release: 187,409 vs 220,632 charged gas);
//   - prices: the fork block's base fee + 0.001 gwei - a SNAPSHOT at that block, not a current fee - and the owner's
//     0.05 gwei cap (the most this owner's reserve ever pays per gas);
//   - renewals: the deployed ledger extends FROM leaseUntil (rev 16d): covering T seconds takes ceil(T / leaseSec) - 1
//     renewals for these rate-0 records (network/lease-gas-owner.mjs renewalsFor; 47 for one day, 1439 for 30 days).
// Per app: one claim, the renewals, one release. Which record of an operator key carries its one-time EIP-7702
// authorization is decided at run time (its FIRST sponsored lease), so EVERY app is sized with the first-claim charge:
// a per-app deposit that cannot fall short, whose sum over-counts by (apps - operator keys) x the authorization
// difference (stated below). Rounded within each app; totals are sums of the per-app integers.
//   usage (cwd work/app-lease-gas): node scripts/recovery-budget.mjs > plans/recovery-budget.json
import fs from "node:fs";
import { renewalsFor } from "../network/lease-gas-owner.mjs";

const cal = JSON.parse(fs.readFileSync("fixtures/base-fork-calibration-recalibrated.json", "utf8"));
const queue = JSON.parse(fs.readFileSync("../../outputs/storage-adapter-incident/live-queue-20261020.json", "utf8"));
const rows = queue.expiredRelevantDeployments;
const pick = (re) => cal.receipts.filter((r) => re.test(r.kind));
const maxOf = (rs) => rs.reduce((m, r) => (BigInt(r.chargedGas) > BigInt(m.chargedGas) ? r : m));
const op = { claimFirst: maxOf(pick(/first lease/)), claim: maxOf(pick(/already delegated/)), renew: maxOf(pick(/^renew/)), release: maxOf(pick(/^release/)) };
const SNAPSHOT = BigInt(cal.fork.baseFeePerGas) + 1_000_000n, OWNER_CAP = 50_000_000n;
const charge = (r, price) => BigInt(r.chargedGas) * price + BigInt(r.l1ChargedWei);
const LEASE_SEC = 1800;
const ethStr = (w) => { const s = w.toString().padStart(19, "0"); return `${s.slice(0, -18)}.${s.slice(-18)}`; };
const operatorKeys = new Map();
for (const r of rows) operatorKeys.set(r.runner, (operatorKeys.get(r.runner) || 0) + 1);

function option(days, price, label) {
  const renewals = renewalsFor(days * 86400, { leaseSec: LEASE_SEC });
  const perApp = charge(op.claimFirst, price) + renewals * charge(op.renew, price) + charge(op.release, price);
  const apps = rows.map((r) => ({ id: r.id, owner: r.owner, depositWei: perApp }));
  const total = apps.reduce((m, a) => m + a.depositWei, 0n);
  const overCount = BigInt(rows.length - operatorKeys.size) * (charge(op.claimFirst, price) - charge(op.claim, price));
  return { label, days, priceWeiPerGas: price, renewalsPerApp: renewals, perAppDepositWei: perApp, perAppDepositEth: ethStr(perApp),
    totalWei: total, totalEth: ethStr(total), overCountFromAuthorizationSizingWei: overCount, apps };
}
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const out = {
  title: "Minimal bootstrap vs 30-day budget for the nine expired records - LOCAL INTEGER ARITHMETIC from accepted evidence; a proposal for the owner, not an authorization to spend",
  inputs: { calibration: { file: "fixtures/base-fork-calibration-recalibrated.json", forkBlock: cal.fork.block, baseFeePerGas: cal.fork.baseFeePerGas, limits: cal.deployment.limits },
    liveQueue: { file: "outputs/storage-adapter-incident/live-queue-20261020.json", block: queue.block, records: rows.length }, leaseSec: LEASE_SEC,
    renewalRule: "rev 16d renew() extends FROM leaseUntil: T seconds need ceil(T / leaseSec) - 1 renewals after the claim (48 a day steady state); the renew window moves when, not how many",
    priceLabels: { snapshotWeiPerGas: SNAPSHOT, snapshot: `the fork block ${cal.fork.block} base fee + 0.001 gwei: a SNAPSHOT, not a current fee`, ownerCapWeiPerGas: OWNER_CAP } },
  operatorKeys: [...operatorKeys.entries()].map(([runner, records]) => ({ runner, records, note: "its FIRST sponsored lease carries the key's EIP-7702 authorization (charged once)" })),
  chargesPerOperationWei: Object.fromEntries(Object.entries(op).map(([k, r]) => [k, { sample: r.kind, chargedGas: r.chargedGas, l1ChargedWei: r.l1ChargedWei,
    atSnapshot: charge(r, SNAPSHOT), atOwnerCap: charge(r, OWNER_CAP) }])),
  options: {
    minimalBootstrap_1day_atSnapshot: option(1, SNAPSHOT, "MINIMAL BOOTSTRAP: claim + one day of renewals + one release per app, at the snapshot fee"),
    minimalBootstrap_1day_atOwnerCap: option(1, OWNER_CAP, "the same day if every operation were charged at the owner's 0.05 gwei cap"),
    thirtyDays_atSnapshot: option(30, SNAPSHOT, "30 DAYS: claim + 30 days of renewals + one release per app, at the snapshot fee"),
    thirtyDays_atOwnerCap: option(30, OWNER_CAP, "30 days at the owner's cap (the most the reserve can be charged)"),
  },
  notIncluded: {
    deployment: "reserve + executor + bindExecutor: root's preflight estimate 0.000022 ETH (0.000049 with a 20% gas margin and 2x base fee) - outputs/app-lease-gas-review/deployment-simulation-review.json",
    ownerRequests: "per app one deposit + one configure (the DNS app via its SessionVault ownerCall, plus setClaimant): the owner's own transactions",
    relayFloat: "working capital of whoever runs a relay: reimbursed in the same transaction when an operation lands; a REVERTED relay transaction is not reimbursed (bounded: one transaction at a time per relay key)",
  },
  limits: [
    "a budget, not a forecast: the fee at execution decides; the reserve never charges above the owner's cap or the platform ceiling, and an operation the balance cannot cover is refused (the lease then lapses; no host top-up)",
    "rate-0 records: full extensions. A partly funded PAID lease buys shorter extensions and renews more often (not these nine)",
    "the L1 component is the charged upper-bound share at the fork's oracle state; Base's L1 parameters move",
    "the existing admin wallet 0x0b2d held 0.004200638454756122 ETH at root's read-only preflight (block 52,866,343); no transfer is implied by this file",
  ],
};
console.log(JSON.stringify(out, big, 1));
