// The AGGREGATE canary budget (pure). Every spending step has a worst-case ETH allowance; the plan's total
// (all enabled spending steps, the cleanup stops included) must fit pins.budget.totalWei and its USDC must fit
// pins.budget.usdcUnits, or every spending step is BLOCKED. At run time a step may spend only while
//   spent (journal, from receipts) + this step's worst case + the cleanup steps still owed <= totalWei,
// and the live balance covers this step plus that reserve. Allowances:
//   custody update  gasCap x maxFeePerGas + l1FeeWei + operatorFeeWei   (the sender also enforces the live bounds)
//   CLI operation   pins.budget.cliWei[kind] per operation (all its transactions: gas, L1 data fee, operator fee)
//   lease deposit   pins.budget.leaseDepositWei (the value) on top of its CLI transactions
export function allowanceOf(step, pins) {
  const b = pins.budget, f = pins.fees;
  if (step.mutation) return BigInt(step.mutation.gasCap) * BigInt(f.maxFeePerGasWei) + BigInt(f.l1FeeWei) + BigInt(f.operatorFeeWei);
  if (!step.spend) return 0n;
  const cli = (k) => { const v = b.cliWei?.[k]; if (v === undefined) throw new Error(`budget.cliWei.${k} is not pinned`); return BigInt(v); };
  return step.spend.txs.reduce((a, k) => a + cli(k), 0n) + (step.spend.depositWei ? BigInt(b.leaseDepositWei) : 0n);
}
export const usdcOf = (step, pins) => (step.spend?.usdc ? BigInt(pins.budget.usdcFundUnits) : 0n);
export const spends = (step) => !!(step.mutation || step.spend);

export function planBudget(steps, pins) {
  const live = steps.filter((s) => s.status !== "skipped" && spends(s));
  const worstCaseWei = live.reduce((a, s) => a + allowanceOf(s, pins), 0n);
  const cleanupWei = live.filter((s) => s.spend?.cleanup).reduce((a, s) => a + allowanceOf(s, pins), 0n);
  const usdcUnits = live.reduce((a, s) => a + usdcOf(s, pins), 0n);
  const totalWei = BigInt(pins.budget.totalWei), usdcCap = BigInt(pins.budget.usdcUnits);
  const reasons = [];
  if (worstCaseWei > totalWei) reasons.push(`aggregate worst case ${worstCaseWei} wei > budget ${totalWei} wei: disable optional cases or lower caps`);
  if (usdcUnits > usdcCap) reasons.push(`USDC ${usdcUnits} units > budget ${usdcCap}`);
  return { fits: reasons.length === 0, reasons, worstCaseWei: String(worstCaseWei), cleanupReserveWei: String(cleanupWei), usdcUnits: String(usdcUnits),
    totalWei: String(totalWei), usdcCap: String(usdcCap), spendingSteps: live.length,
    byStep: Object.fromEntries(live.map((s) => [s.id, String(allowanceOf(s, pins))])) };
}

// spent so far: the journal's recorded costWei for every spending entry (pass, fail or aborted: a reverted or unknown
// transaction may still have cost); an entry of a spending step without a costWei counts its FULL allowance.
export function spentOf(entries, steps, pins) {
  let spent = 0n;
  for (const e of entries) {
    const s = steps.find((x) => x.id === e.stepId);
    if (!s || !spends(s)) continue;
    spent += /^[0-9]+$/.test(String(e.evidence?.costWei ?? "")) ? BigInt(e.evidence.costWei) : allowanceOf(s, pins);
  }
  return spent;
}

// the gate before ANY spending step (the driver's own update, or root's CLI transaction)
export function gate({ steps, pins, entries, done, step, balanceWei = null }) {
  if (!spends(step)) return { ok: true, allowanceWei: "0" };
  const spent = spentOf(entries, steps, pins);
  const owed = steps.filter((s) => s.spend?.cleanup && s.status !== "skipped" && !done.has(s.id) && s.id !== step.id).reduce((a, s) => a + allowanceOf(s, pins), 0n);
  const allowance = allowanceOf(step, pins);
  const total = BigInt(pins.budget.totalWei);
  const remainingWei = total - spent - owed;
  const reasons = [];
  if (allowance > remainingWei) reasons.push(`step worst case ${allowance} > remaining ${remainingWei} (budget ${total} - spent ${spent} - cleanup owed ${owed})`);
  if (balanceWei !== null && BigInt(balanceWei) < allowance + owed) reasons.push(`balance ${balanceWei} < step ${allowance} + cleanup owed ${owed}`);
  return { ok: reasons.length === 0, reasons, allowanceWei: String(allowance), spentWei: String(spent), cleanupOwedWei: String(owed), remainingWei: String(remainingWei) };
}
