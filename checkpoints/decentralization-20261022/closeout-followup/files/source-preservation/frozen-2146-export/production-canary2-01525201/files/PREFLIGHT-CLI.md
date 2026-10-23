# ROOT-CLI-PREFLIGHT: fee-cap budget and CLI transaction support (source review only)

> **Superseded pin:** the first version of this file named the ledger `0xF9e71385…` (the CLI's baked default). That was
> wrong. The ledger is `0xB1783B61…`; see `LEDGER-RECONCILIATION.md`.

Nothing here was signed, sent, simulated against Base, or run against production. The numbers come from
`tools/budget-matrix.mjs`, the driver's own `buildPlan`/`planBudget` with only the pins varied, in queue job c13. They are
WORST CASES at pinned caps. They are not live affordability: a snapshot from one block (base fee 5 mwei, tip 1 mwei) says
nothing about the block a step would land in.

## 1. A lower fee cap does NOT fit the full matrix into 5.5e13 wei

**Note on the starting point.** The current example pins already use maxFee **10 mwei**. 20 mwei was the FIRST
handoff's cap (7bcd501f). All three caps are shown below.

**What is held constant.** Gas caps (create 900k, rotate 300k, rules 250k), the L1 allowance (3e11 per tx), the operator
allowance (1e11 per tx), the lease deposit (8e12 per deployment), the cleanup steps and USDC (90000 units per
deployment) are unchanged.

**Two ways to count the CLI operations:**
- **"literal":** the pinned wei constants in `budget.cliWei`.
- **"derived":** the same CLI operations re-derived from GAS assumptions at the fee cap (see §2), with L1 and operator
  allowances per transaction.

The literal constants were set at 10 mwei and do not scale. The derived row is the honest one at any other cap.

| maxFee cap | profile | CLI | custody updates | CLI + deposits | worst case | fits 5.5e13 |
|---|---|---|---|---|---|---|
| 10 mwei (example) | full matrix | literal | 4.01e13 | 4.00e13 | 8.01e13 | NO |
| 10 mwei | full matrix | derived | 4.01e13 | 4.50e13 | 8.51e13 | NO |
| 10 mwei | A (no migration) | literal | 2.73e13 | 2.00e13 | 4.73e13 | yes |
| 10 mwei | A | derived | 2.73e13 | 2.25e13 | 4.98e13 | yes |
| **12 mwei (root)** | **full matrix** | literal | 4.74e13 | 4.00e13 | **8.74e13** | **NO** |
| **12 mwei** | **full matrix** | derived | 4.74e13 | 5.00e13 | **9.74e13** | **NO** |
| 12 mwei | A | literal | 3.22e13 | 2.00e13 | 5.22e13 | yes |
| 12 mwei | A | derived | 3.22e13 | 2.50e13 | 5.72e13 | NO |
| 20 mwei (first handoff) | full matrix | literal / derived | 7.66e13 | 4.00e13 / 7.00e13 | 1.17e14 / 1.47e14 | NO |
| 20 mwei | A | literal / derived | 5.18e13 | 2.00e13 / 3.50e13 | 7.18e13 / 8.68e13 | NO |

**What it would take to fit.**
- With these gas caps and allowances, the full matrix (derived) fits 5.5e13 only at maxFee ≤ **5.1 mwei** (5105691 wei,
  by bisection).
- Each send requires maxFee = 2 × base + tip, which was 2 × 5 + 1 = **11 mwei** at root's observed block. So at ≤ 5.1
  mwei every send would refuse.
- **The full matrix therefore does NOT fit the existing budget at any workable cap, and the shortfall stands.**
- At a 12 mwei cap, any block whose base fee is above (12 − tip) / 2 ≈ 5.5 mwei refuses or waits. That is by design:
  there is no fee bump.

**Where the worst case comes from (full matrix, 12 mwei, derived).**
- Custody updates: 4.74e13.
- The two lease deposits: 1.6e13 of value.
- Two create operations: about 2.1e13.
- Per-transaction L1 + operator allowances: 19 transactions × 4e11 = 7.6e12.

  Root's evidence shows an operator fee of 0 at that block, but the allowance stays, as instructed.

Changing any of these is root's budget decision; this review does not change them.

**New canary proof app: publishing cost, separate and admin-funded, NOT in the canary budget.**
- **Call:** `EnclaveAppCatalog` (`0x18419CA2b502D423A8de6269AEeE171a378626e3`, address-book value; the CLI refuses a
  catalog write unless the book was read) `.publishVersion` (or `publishVersionCfg`):
  `(slug, name, description, version, cid, res, ports, config[, configCid], feePerSec6)`, from the publisher.
  - On rev 9, the catalog owner's own publish is approved in the same transaction.
  - A different publisher needs a separate approval transaction by the catalog owner.
- **No receipt for a publish exists in these records.** As an ASSUMPTION for root to replace with a fresh two-RPC
  simulation: ≤ 1.5M gas per publish (string-heavy storage) → at 12 mwei ≈ 1.8e13 + 4e11 per transaction (worst case),
  plus an approval transaction if needed.
- **Off-chain costs on top:** the component upload and pin (IPFS), and the image measurement work.
- The app is built separately (M), and `CANARY-APP-PLAN.md` stays frozen.

## 2. CLI support for the canary's own transactions (create, lease-gas configure/deposit, stop)

**Source reviewed:** `work/enclave` working tree at `e762a9c5`.

| file | sha256 | state |
|---|---|---|
| `cli/enclave.mjs` | `f83cab274f9cd0fcac16182363ed4927c2495f5b82bafacbed70e896b8f0ca8e` | **uncommitted changes** vs HEAD: pin this file or re-derive |
| `cli/independent.mjs` | `a04d74768b2415ce84f505c2f925cfd58cd1efd4e25660531f3b39663cc7d9dd` | clean at HEAD |
| `cli/independent-signer.mjs` | `d6eb8771f0153a33557935df39696a0d211995bde9a5b84b4a2f9c9d14559303` | clean at HEAD |
| `cli/lease-gas.mjs` | `9f34e04ec59614f5be4bdefdc3f991833d8903051ef5bdedaa14f2877391bbdd` | clean at HEAD |
| `network/lease-gas-owner.mjs` | `92cc322a0eb201f3561dc0dd1c8a245459d907222c64f9073a112cdfb3d95988` | clean at HEAD |

**Pinned addresses (from source):**
- **CORRECTED (ROOT-LEDGER-REVIEW):** EnclaveDeployments ledger **`0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B`** (ledger
  rev16d). This is the ledger the original vault's book `0xab21…` names. The earlier `0xF9e71385…` was the CLI's baked
  default: a RETIRED ledger, and unsafe. See `LEDGER-RECONCILIATION.md`. Every CLI step must run as
  `enclave --independent --rpc A,B --contract-pins cli-pins/canary-contract-pins.json …`, after the driver's `S0.clipins`
  step has passed.
- USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Lease-gas reserve `0x12a3f873041dec436daa0085b766a399a6fa3639` (runtime `0xcc00efe9…`) and executor
  `0x8900baca2167873ba2f8a8bae8b4876e6396d343` (`work/lease-enrollment-signing/trust.mjs`).
- Owner `0x29479bf04ed889d46a7afb7f292b9bb26e12647c`.
- Old deployments, 0x4e62 and its canary siblings are never targets. Every call below takes the NEW canary id.

### What the current CLI can and cannot cap before signing

**Independent mode** (`enclave --independent --rpc A,B[,…] --contract-pins <pins> …`). Every write goes through
`cli/independent.mjs` `sendQuorumTx`:
- an agreed-block simulation;
- a pending-nonce agreement;
- gas = max estimate × 1.2, refused only above **15,000,000**: a fixed default with no CLI flag;
- maxFeePerGas refused above **`--max-fee-gwei`**. The default is **5 gwei**; root must pass `--max-fee-gwei 0.012`.
- It does NOT bound the Base L1 data fee or the operator fee, and has NO total-cost or aggregate cap.
- **So the CLI caps the fee per gas only, not gas tightly, not L1 or operator fees, and not total cost.**

**`--signer-mode handoff --from 0x29479…`** (independent mode, `cli/independent-signer.mjs`):
- It runs the same preflight with the same caps.
- It journals an intent and PRINTS the exact transaction (to, data, value, nonce, gas, maxFeePerGas,
  maxPriorityFeePerGas), then stops. Nothing is signed.
- Root signs with their own wallet. `signer attach <intent> <hash>` then checks the mined transaction against the intent
  (gas cap and fee cap).
- **Limitation:** handoff without a signer URL cannot sign typed data (`probe()` refuses). So `deploy --fund <usd>`, whose
  USDC funding needs an EIP-712 authorization, cannot complete in pure handoff. Fund it with a signer URL (a wallet
  endpoint), or use `--fund-eth` (a plain payable `fundEth`, which spends the scarce ETH).

**`--unsigned --from`:**
- It prints only `{chainId, from, to, data, value}`: no gas, nonce or fees.
- It exits after the FIRST transaction of a multi-transaction command.
- It cannot produce the USDC authorization.

### Operation by operation (exact calls from the source)

| operation | command (independent) | transactions | approval boundary |
|---|---|---|---|
| create C1/C2 | `deploy <hello-world ref> --cpu 0.1 --gpu 0 --max-rate <usd/h> --isolation snp-guest-per-app --public --fund <usd> --max-fee-gwei 0.012 [--signer-mode handoff --from 0x29479…]` | ① Deployments`.create(string appRef, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, string ports, bool isPublic, string configCid=envelope {"isolation":{"require":"snp-guest-per-app"}}, address feeRecipient, uint256 feePerSec6, uint256 maxRate6)`, value 0; the id comes from the `Created` event. ② Deployments`.fundWithAuthorization(bytes32 id, address from, uint256 value, 0, uint256 validBefore=now+3600, bytes32 nonce=id[0:16]‖random16, bytes sig)`, value 0 | the EIP-712 USDC `ReceiveWithAuthorization` (domain "USD Coin"/"2"/8453/USDC; `to` = Deployments; `value` = fund in 6 dp ≤ `budget.usdcFundUnits`; validBefore ≤ 1 h). It authorizes exactly that amount to the ledger, once; it is not an `approve`. ② cannot be prepared before ① is mined |
| lease-gas configure | `lease-gas configure <id> [policy flags] --lease-gas RECORD.json --lease-gas-digest sha256:… [--signer-mode handoff --from 0x29479…]` (without signer flags it only prints unsigned requests: `--format tx\|metamask\|safe`) | reserve`.configure(bytes32 id, policy tuple)`, value 0 | the policy (maxGasPrice, maxPerOp, epochCap, claimPolicy …) caps what the RESERVE pays for runner operations, not the owner's transaction |
| lease-gas deposit | `lease-gas deposit <id> --wei <budget.leaseDepositWei>` (same signer options) | reserve`.deposit(bytes32 id)`, **value = the deposit** | the only call with non-zero value: check value == `budget.leaseDepositWei` exactly |
| stop | `stop <id>` (same signer options) | Deployments`.setActive(bytes32 id, false)`, value 0 | none |

### Manual review path (NOT ready; the driver marks none of these steps ready)

1. Run `node driver/cli.mjs gate --pins … --step <D1.create|D1.leasegas|D1.stop|…>`. This is the aggregate pre-check
   with the cleanup reserve.
2. Run the CLI in independent handoff mode with `--max-fee-gwei 0.012`. Nothing is signed, and the exact transaction is
   printed and journaled.
3. Root reviews each printed transaction against this table:
   - `to` ∈ {Deployments `0xB1783B61…` (rev16d), reserve `0x12a3…`}. The `record` step re-checks each mined `to`;
   - the selector and decoded arguments, including the NEW canary id (never 0x4e62 or another old id);
   - `value` (non-zero only for the deposit, exactly the pinned amount);
   - `gas` ≤ the step's assumption (create 600k, fund 200k, configure 250k, deposit 100k, stop 100k);
   - `maxFeePerGas` ≤ 12 mwei.
4. Root computes the L1 data-fee and operator-fee bounds for THAT exact transaction at a fresh agreed block on two RPCs:
   - `GasPriceOracle.getL1FeeUpperBound(max(unsigned, signedMax − 68))`, with sizes from the printed nonce, gas, fees
     and data, as `driver/sender.mjs` `txSizes` does;
   - `isIsthmus()` must be true, and `getOperatorFee(gas)`;
   - check that gas × maxFee + L1 + operator fee ≤ that step's allowance and the remaining aggregate from `gate`.

   The driver has these functions, but no command prices an EXTERNAL transaction. A narrow "price this handoff tx"
   command would be a separate, reviewed addition; it is not built here, as instructed.
5. Sign exactly those fields with the owner's wallet, then run `signer attach`.
6. Run `node driver/cli.mjs record --step … --obs {txHashes, deploymentId?, usdcUnits?}`. This costs the receipts from
   both RPCs, and a step over its allowance or the aggregate FAILS and stops the run.

**Readiness.** Until each step has passed this review with real printed transactions, the CLI steps have only a
reviewed PATH, not bounded executable commands. Every C1/C2 step is also still blocked by the recipient
(`recipient.runner`: the metal0 control image lacks a measured `CUSTODY_VAULT_V2`).
