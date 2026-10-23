# Normal-node operator fee fix: 5db2be3f (amended from 9b82acc8, comments/descriptions only; source only, NOT built). Written 2026-10-23T23:25:54Z

The commit is **5db2be3f4d4bed2c543e1e181c976ca9e26aa410** (amended from 9b82acc8 at root's 23:25Z correction: comments, the test title and the message only) on new branch `boot-normal-fee`, a single-parent child of 9f6d37bd
authored by SteveDeFacto. It equals 7dd3acd's reviewed tree plus the `sendOperatorTx` change and `test/operator-fee-path.test.mjs`
(git diff 7dd3acd 5db2be3f: supervisor.js +13/-2, the new test). Branch `boot-gpu-price` stays at 7dd3acd and no history was
rewritten. Neither kit 8bbd nor 7dd was edited.

## The change: supervisor.js sendOperatorTx, still inside the one _txChain
1. `chainClient.estimateFeesPerGas()` reads the latest block and `eth_maxPriorityFeePerGas`, giving ceil(1.2 x base) + tip. It does
   not fill (verified in viem 2.53.1 source and by test).
2. `chainClient.estimateContractGas({..., account, maxFeePerGas, maxPriorityFeePerGas})` is the node's own estimate FROM the operator
   AT those fees. Viem 2.53.1 asks via eth_fillTransaction (returning the node's filled gas) and otherwise via eth_estimateGas. These
   are exact SDK semantics: actions/public/estimateGas.js returns the filled gas when the node fills.
3. `wallet.writeContract({..., gas, maxFeePerGas, maxPriorityFeePerGas})`. Viem still asks the node to fill (for the nonce), but
   keeps the caller's gas and fees and does NOT apply its 1.2 multiplier (fillTransaction.js "Preference supplied fees").

A failed read or estimate (including a revert) rejects before signing. These are unchanged: the nonce source (fill or pending
count), the receipt queue, addresses, functions, args and the delegation. There is no constant, retry or fallback.

## Evidence: queue 512, logs/f5.out, exit 0, peak 251 MiB
- **Tests 44/44.** test/operator-fee-path.test.mjs runs real viem 2.53.1 wallet and public clients for Base over a recording stub
  node that fills a HIGHER fee (2 x base + tip) and gas:
  - the 7dd3acd baseline signs 13.2 mwei;
  - the fix signs 7 mwei, with the node's estimate at those fees;
  - every fill and estimate request is from the operator at the signed fees, and the fees are read before any fill;
  - it was tested with the node filling and with fill unsupported;
  - the signer is the operator; to, data and args are exact; nonce and chain are correct;
  - five failure modes send nothing;
  - the queue still serializes through receipts, a reverted receipt is reported as before, and the next transaction after a
    failure is sent.
  - The image's viem is 2.53.1 and these files are byte-identical to H's (logs/viem-image.out).
- **Mutants 30/30 killed**, controls passing:
  - fee 5/5 (../mutants-fee.sh): library-default fees, estimate not at the signed fees, estimate not from the operator, failed
    estimate falls back to a send, outside the queue. "gas left to the library" is omitted as an EQUIVALENT mutant under viem
    2.53.1;
  - price 14/14;
  - adoption 11/11.
- **Scans:** gitleaks on the diff vs 9f6d37bd and the key scan are clean.
- **Template:** dry-run of a340762 precheck.py (temporary approval in /tmp, read-only):
  PRECHECK-PASS (gsup REVIEWED; tests test/boot-gpu-price.test.mjs test/operator-fee-path.test.mjs
  test/registry-advertise-retry.test.mjs). **No new template is needed**: root writes APPROVED-COMMIT.txt with those three lines.

## Audit of normal operator writes
- **Covered:** all 14 sendOperatorTx callers: registry register/setProofKey/setPrices, claim txs, approve + postBond, proofs,
  settle, withdrawEarnings.
- **NOT covered, so the over-bid remains:**
  - `signAndSendRelease` (wallet.prepareTransactionRequest);
  - `fenceNonce` (wallet.sendTransaction).
  Both are reached only when app-funded lease gas is NOT configured; metal0 has it configured. Changing them touches the release
  fence/nonce semantics, so they are left for a separate reviewed change.
- **Tradeoff vs a boot-only option:** a boot-only fix would leave setPrices and every later registry/claim write exposed to the same
  fill re-multiplication WHERE the answering node fills (about 1.9x against a node filling 2 x base + tip; no change where no
  node fills). The queue-wide change is bounded to one function, keeps semantics, and is tested on the real SDK.

## Correct funding preflight: plan only, the kit is NOT modified
Reproduce the supervisor's EXACT sequence with the image's viem 2.53.1 (H node_modules, byte-identical):
- the same client construction (chain base, fallback over the supervisor's RPC order: BASE_RPC default mainnet.base.org, then
  publicnode, drpc, 1rpc);
- a `toAccount` with only the operator's public address, which throws on any signing request;
- `fees = estimateFeesPerGas()`, then `gas = estimateContractGas({to: registry, setProofKey(id, 0xff..ff), account, ...fees})`;
- then the bound:
  worst = gas x fees.maxFeePerGas + getL1FeeUpperBound(the signed-max serialization of THAT exact tx: type 2, nonce, gas, fees)
          + operator fee <= balance, with the reviewed headroom.
This is the same SDK path the fixed supervisor takes, not a hand-math model. Everything is read-only (fill and estimate never
broadcast). Run it close to the cutover; the fee follows the base fee. Expected at base 5 / tip 1: about 38.8k x 7 mwei + L1,
roughly 0.27e12, which passes with headroom against 0.376e12.

## Evidence status (root 23:25Z correction)
The 13.2 mwei figure is a reproducible SDK failure scenario, shown against a stub node that fills 2 x base + tip. It is the
SUSPECTED cause of metal0's 23:10Z "insufficient funds", NOT a confirmed production fee.
- Root's direct read-only unsigned probe (evidence/unsigned-fee-path.json, 23:19:59Z, mainnet.base.org only) saw
  eth_fillTransaction FAIL and fall back to 7 mwei / gas 38772.
- That probe did not use the image's fallback pool, so it does not rule out a filling node in production either.
- The logged shortMessage carries no fee or function.
- Root will verify the next normal send on the exact hardware by its receipt.
- The fix is unchanged in substance. It removes the dependency on whether the answering node fills.
