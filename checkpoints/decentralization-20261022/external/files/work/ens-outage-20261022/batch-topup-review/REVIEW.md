# Optional batch lease-gas top-up: source review (Claude; offline; no RPC, wallet, nonce or production action)

## Verdict
One transaction is SAFE to propose **if, and only if,** root first establishes three things. (1) The canonical
Multicall3 code hash, from independent reads. (2) Fresh agreeing current-owner and enabled reads for every row.
(3) The exact total, stated explicitly. The generator refuses otherwise. The proposal is 0.001 ETH for each of the 10
remaining reserves, 0.01 ETH (1e16 wei) in total. It carries no spending authority, and root executes nothing until
the user approves.

## reserve.deposit (contracts/EnclaveLeaseGasReserve.sol:301-306, production code hash 0xcc00efe9…)
- `deposit(bytes32 id) payable`: `require(0 < msg.value <= uint96.max)`, then `o = _ownerOf(id)`, which is
  `ledger.get(id).owner` and reverts "unknown" for an unknown id. It credits `_reserves[keccak(id, o)].balanceWei`.
  **It credits the CURRENT ledger owner of record at execution, whoever the payer is.** `msg.sender` (Multicall3 here)
  appears only as the `Deposited` event's payer.
- There's no paused, blocked or enabled check in deposit. A deposit into a disabled reserve sits unused until that owner
  configures it, and one for a blocked deployment can't pay leases. The generator therefore requires
  `enabled == true`, `blockedDeployment == false` and `paused == false` from fresh reads.
- `enabled == true` under key (id, currentOwner) proves the current owner itself called `configure` (which requires
  `_ownerOf(id) == msg.sender`). So that owner has a working call path to the reserve, and therefore to `withdraw`. The
  ETH can't be stranded. This covers 0x59f1273d. Its current owner is SessionVault 0xB794… (legacy factory, `owner()` =
  0x0b2d…, per enclavedns-stale-20261021/RELEASE-PLAN.txt), its reserve under the vault key is enabled
  (fleet-current-owner-reserves.json), and a withdrawal goes to the vault owner's wallet (lease-gas-owner.mjs header).
- No approvals, allowances, withdrawals, configure, claimant or ownership calls are encoded. `verifyProposal` decodes
  every call and accepts only `deposit(bytes32)` (selector 0xb214faa5, exactly 36 bytes) on the production reserve.

## Canonical Multicall3 aggregate3Value (address 0xcA11bde05977b3631167028862bE2a173976CA11, viem's Base definition)
Behavior per the published Multicall3 v3 source. Root must match it to the code hash it reads.
- For each call it does `valAccumulator += value` (unchecked), `target.call{value}(callData)`, and reverts
  "Multicall3: call failed" when `allowFailure == false` and the call failed. At the end,
  `require(msg.value == valAccumulator, "Multicall3: value mismatch")`.
- With allowFailure false on every call (enforced, and re-verified by decoding), any failing deposit reverts the
  whole transaction. That makes it all-or-nothing: no partial funding and no ETH left in Multicall3. With exact
  equality there's nothing to refund, and Multicall3 has no refund or withdraw logic anyway. ETH stranded in Multicall3
  would be takeable by anyone, which is why allowFailure true is refused. Accumulator overflow is impossible because the
  total is capped at 1e16.
- No deployment, account delegation, authority or ownership change. The sender's EOA calls an existing contract.
- **Code hash: deliberately NOT pinned here.** Root acquires it, e.g. `keccak256(eth_getCode(0xcA11…))` at one block from
  at least two independent Base RPCs, cross-checked against the same address on another chain (the keyless
  deterministic deployment gives identical runtime) or against verified source. Pass it as `--multicall3-codehash`.
  The generator refuses a missing value, the empty-code hash, or any mismatch with the fresh reads.
- If the hash can't be established, or the code differs: **do not batch.** No workaround is proposed. The existing
  reviewed per-deployment `deposit` path (lease-gas-owner.mjs `depositRequest`) remains the alternative. That would
  be one transaction per app, prepared only by root.

## Residual risks (cannot be removed without a new contract, which is out of scope)
1. **Owner change between the fresh read and inclusion.** The deposit then credits the NEW owner's reserve. Neither
   Multicall3, the reserve nor the ledger offers an on-chain "owner == X" assertion. Mitigation: the evidence must be
   at most 600 s old at generation, and root re-reads immediately before preparing. Both current owners (0x0b2d… and
   its vault 0xB794…) belong to the same admin wallet.
2. **Wallet readability.** The wallet shows a 0.01 ETH call to Multicall3, not to the reserve. Root's page must show
   the decoded rows (`proposal.rows`, which list the credited owner and amount per id) and `dataSha256`.
3. Gas: about 10 deposits, each doing an external `ledger.get` (large struct with strings), plus Multicall3 overhead.
   Root's own estimate at prepare time decides. The generator emits no gas or fee fields.

## Files
- `batch-topup.mjs`: generator and verifier. Inputs: manifest `{id, currentOwner, amountWei}` (format
  enclave-reserve-batch-topup-manifest/v1, 1–10 rows, unique ids, amount exactly 1e15, adapter 0x7ae476a3 excluded
  because root's single deposit covers it); evidence (enclave-reserve-batch-evidence/v1, at least two distinct RPC
  hosts, identical answers at one block, at most 600 s old, pinned reserve 0xcc00efe9… and ledger 0x71d50076… code
  hashes, root-supplied Multicall3 hash, each row's ledger id/owner/active/enabled/not blocked, reserve not paused);
  and `--expect-total-wei` equal to the exact sum (at most 1e16). Output: `{chainId, to: Multicall3, value, data,
  dataSha256, evidence, rows}`. It never contains from, nonce, gas, fee or authorization fields.
- `collect-evidence.mjs`: the READ-ONLY reader for root. Reads at min(head)-2 on every RPC and reads `reserveOf`
  under the CURRENT ledger owner. It has never been run against a chain.
- `proposed-manifest.json`: 10 rows, owners from root's three-RPC read at block 52927799. They must be re-read.
- `batch-topup.test.mjs`: offline encode/decode and refusal tests. FAKE_MC3 is a test-only stand-in.

## Root sequence (only after user approval)
1. `node collect-evidence.mjs proposed-manifest.json <rpcA> <rpcB> [<rpcC>] > evidence-<ts>.json`
2. Establish the Multicall3 code hash independently (see above).
3. `node batch-topup.mjs --manifest proposed-manifest.json --evidence evidence-<ts>.json --multicall3-codehash 0x… --expect-total-wei 10000000000000000`
4. Root's own wallet preparation (sender balance, simulation from the sender at the agreed block, nonce) and the user's
   signature are outside this package. After inclusion, re-read the reserves to confirm each balance rose by exactly 1e15.

## Test evidence (offline, shared queue 256 MiB)
- attempt1/ (20261022T050032Z): 6/7, exit 1. A test defect: the tamper case swapped a trailing ABI-padding byte 00 for 00, so nothing changed. Fixed in the test only; no generator change.
- tests-20261022T050120Z.out + queue-batch-topup-20261022T050120Z.log: **7/7 pass, queue EXIT 0**, peak 148 MiB.

## Inventory (sha256)
    aee7bd99fd4a9ab4d2ed657f9260765ae221df241656a4086ef9351344a766b0  batch-topup.mjs
    f3ee29b272428543291ab0cf7518a62890a0e9d283094904632c4013f3de045c  collect-evidence.mjs
    f34f835c64a2cd3760acfb4e40867ccb6c8a4d0854515b091a0902c7994f14f7  proposed-manifest.json
    bbd1806d39609c4fcdbd6ed39f66521dac7d7bcad4b3da5da25329dbf5e81cc8  batch-topup.test.mjs
    ed33f9a15f6c2e937d99bdf8829d89d4243f12924fa87031dcfe1e0bdd250cf0  run-tests.sh
