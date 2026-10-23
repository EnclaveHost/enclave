# Fee accounting used here (for the production-canary fee work, H): file-only coordination; no shared files edited

This repository (`custody-operator-fees-20261023`, from `custody-operator-proposal-20261023` 1ac9ad2) prices its one
type-2 transaction on Base as follows (`lib/proposer.mjs`):

1. **L2 cap:** gas limit × maxFeePerGas.
2. **L1 data fee:** `GasPriceOracle(0x4200…000F).getL1FeeUpperBound(argument)`.
   - `argument = max(unsigned, signedMax − 68)`, computed from the exact transaction, including its real nonce.
   - `signedMax` is the encoding with yParity 1 and r = s = 2^256−1.
   - The oracle treats the argument as unsigned and adds 68 bytes, so its size covers the signed maximum.
   - A transaction built with nonce 0 undercounts once the real nonce needs more bytes (23759 needs 2 more).
3. **Operator fee:** `isIsthmus()` must be true, and `getOperatorFee(gas limit)` is included (non-decreasing in gas
   used). If it is undetermined (not Isthmus, a revert, or RPC disagreement), the plan and the send refuse; there is no
   all-fee claim.

All three values are at one block both RPCs agree on, and are re-read at send. Tests: `test/proposer.test.mjs` 16–17. The
same accounting could apply to other single-transaction helpers; this note changes nothing outside this repository.
