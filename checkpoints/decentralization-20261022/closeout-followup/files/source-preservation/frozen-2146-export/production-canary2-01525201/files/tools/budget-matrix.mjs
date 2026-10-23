// Read-only budget arithmetic for ROOT-CLI-PREFLIGHT: the plan's aggregate worst case under fee-cap variants.
// No network, no keys. Uses the driver's own buildPlan/planBudget; only pins are varied.
//   node tools/budget-matrix.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan } from "../driver/plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "pins.example.json"), "utf8"));
const { source, ...image } = ex.imageCandidateFromChain;
const C1 = "0x" + "c1".repeat(32), C2 = "0x" + "c2".repeat(32);
const obs = Object.fromEntries(["read.vault", "read.committee", "read.protected4e62", "read.owner", "fees.bounded", "custodian.info", "recipient.runner",
  "recipient.billing", "relay.v2aware", "hw.oneGuest", "cli.pins", "deploy.C1", "deploy.C2"].map((k) => [k, { ok: true, stepId: "calc" }]));

// CLI operations re-derived from GAS assumptions at the fee cap (assumptions, not receipts, except create 411747 on Sep-24):
//   create operation = Deployments.create (cap 600k; Sep-24 gasUsed 411747) + fundWithAuthorization (cap 200k): 2 txs
//   lease configure (cap 250k), lease deposit tx (cap 100k; the deposit VALUE is budget.leaseDepositWei), stop setActive (cap 100k)
const CLI_GAS = { create: [600_000n, 200_000n], leaseConfigure: [250_000n], leaseDeposit: [100_000n], stop: [100_000n] };
const derivedCli = (fee, perTxFixed) => Object.fromEntries(Object.entries(CLI_GAS).map(([k, txs]) =>
  [k, String(txs.reduce((a, g) => a + g * fee + perTxFixed, 0n))]));

function row(label, feeWei, profile, cliMode) {
  const p = { ...structuredClone(ex), image, owner: { ...ex.owner, reuseScope: { statedBy: "calc", at: "calc", onlyPlanCreatedDeployments: true } } };
  p.fees.maxFeePerGasWei = String(feeWei);
  p.cases = { disabled: profile === "A" ? ["migration"] : [] };
  const perTx = BigInt(p.fees.l1FeeWei) + BigInt(p.fees.operatorFeeWei);
  if (cliMode === "derived") p.budget.cliWei = derivedCli(BigInt(feeWei), perTx);
  const b = buildPlan(p, obs, { C1, C2 }).budget;
  const custody = Object.entries(b.byStep).filter(([id]) => !/^D[12]\./.test(id)).reduce((a, [, v]) => a + BigInt(v), 0n);
  return { label, maxFeePerGasWei: String(feeWei), profile: profile === "A" ? "A (no migration)" : "full matrix", cli: cliMode,
    custodyWei: String(custody), cliAndDepositsWei: String(BigInt(b.worstCaseWei) - custody), worstCaseWei: b.worstCaseWei,
    fits55e12: b.fits, cleanupReserveWei: b.cleanupReserveWei, usdcUnits: b.usdcUnits };
}

const rows = [];
for (const [label, fee] of [["example 10 mwei", 10_000_000n], ["root 12 mwei", 12_000_000n], ["first handoff 20 mwei", 20_000_000n]])
  for (const profile of ["full", "A"]) for (const cli of ["literal", "derived"]) rows.push(row(label, fee, profile, cli));
// the highest fee cap at which the FULL matrix (derived CLI) still fits 5.5e13, by bisection on the same arithmetic
let lo = 1n, hi = 100_000_000n;
while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (row("", mid, "full", "derived").fits55e12) lo = mid; else hi = mid - 1n; }
console.log(JSON.stringify({ rows, fullMatrixDerivedMaxFeeThatFitsWei: String(lo),
  note: "worst cases at the pinned caps; NOT live affordability. maxFee = 2 x base + tip at send; a lower cap refuses (wait) when fees rise." }, null, 1));
