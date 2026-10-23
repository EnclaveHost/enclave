// Pure fee arithmetic for the operator's ONE boot transaction (setProofKey or register), as the supervisor sends it:
// viem writeContract with its default fees (maxFeePerGas = ceil(baseFee x 1.2) + maxPriorityFeePerGas) and gas = the
// node's estimate. On Base the sender also pays the L1 data fee and, from Isthmus, the operator fee.
export const ORACLE_SIGNATURE_ALLOWANCE = 68;

export function viemDefaultMaxFee(baseFee, tip) {        // viem estimateFeesPerGas, baseFeeMultiplier 1.2, rounded up
  return (BigInt(baseFee) * 12n + 9n) / 10n + BigInt(tip);
}

// the L1 size argument that covers the largest signed form (yParity 1, r = s = 2^256-1) of the exact transaction
export function l1SizeArgument({ unsigned, signedMax }) {
  const argument = Math.max(unsigned, signedMax - ORACLE_SIGNATURE_ALLOWANCE);
  if (!(argument + ORACLE_SIGNATURE_ALLOWANCE >= signedMax)) throw new Error("L1 size undercounts the signed transaction");
  return argument;
}

// -> { fitsAsSent, worstCaseWei, minMaxFeeForBalance, landsAtBaseFee, ... } all bigint/strings; no decision is taken here
export function feeFit({ gas, baseFee, tip, l1FeeUpperBound, operatorFee, balance, maxFeePerGas = null }) {
  const g = BigInt(gas), b = BigInt(baseFee), t = BigInt(tip), l1 = BigInt(l1FeeUpperBound), op = BigInt(operatorFee), bal = BigInt(balance);
  const maxFee = maxFeePerGas === null ? viemDefaultMaxFee(b, t) : BigInt(maxFeePerGas);
  const worst = g * maxFee + l1 + op;
  const headroom = bal - l1 - op;
  const minMaxFeeForBalance = headroom > 0n ? headroom / g : 0n;    // the highest maxFeePerGas this balance can pre-pay
  return {
    gas: String(g), maxFeePerGas: String(maxFee), worstCaseWei: String(worst), balanceWei: String(bal),
    fitsAsSent: bal >= worst,                                        // the node's pre-check: gas x maxFee + L1 (+ operator fee)
    shortfallWei: String(bal >= worst ? 0n : worst - bal),
    maxAffordableMaxFeePerGas: String(minMaxFeeForBalance),
    landsAtCurrentBaseFee: minMaxFeeForBalance >= b + t,             // a capped fee the balance allows could still be included now
  };
}
