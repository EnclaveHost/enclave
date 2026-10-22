# Optional queued-app recovery: 10-reserve lease-gas batch top-up (wallet handoff), prepared for root review

**Status: SOURCE + OFFLINE TESTS ONLY.** Nothing has been read from the chain by this package, no intent has been
prepared, no server started, no wallet asked, nothing signed, broadcast or funded. Root has not authorized funds or a
wallet request. Root reviews this source and runs the actual `--prepare` before asking the user for approval.

## What it would do (only after root's review and the user's approval)
- **One transaction** from `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`: canonical Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
  `.aggregate3Value` with **10** `deposit(bytes32)` calls on the production lease-gas reserve `0x12A3f873041Dec436DaA0085B766a399A6fA3639`.
  - `allowFailure: false` on every call: all-or-nothing.
  - **0.001 ETH each, 0.01 ETH total** (`10000000000000000` wei), plus Base gas.
- **The adapter `0x7ae476a3` is excluded.** It is refused by the reviewed generator, and its own completed intent
  (`tx-mvj25nmj-5f8b7eb1`, confirmed, in `ens-outage-20261022/deposit-journal`) is neither reused nor touched.
- **Rows** (`manifest.json`): the same 10 ids as `ens-outage-20261022/batch-topup-review/proposed-manifest.json`.
  - Current owners come from root's fresh 2-RPC read `root-fleet-health-20261022T1405/fleet.json` (block 52944294).
    `0x59f1273d` is owned by SessionVault `0xB794…`; the other 9 are owned by `0x0b2d…`.
  - Labels are the current appRefs, with no renewal counts.
  - The page shows each row's **live catalog name and version**, read at the agreed block.
- **What the reads showed** (root's snapshot): six are expired and unaffordable (`d9798e4c` publisher, `e64f7cba`, `a77d0c57`,
  `a69dcbba`, `38f368d6`, `ef514ed3` sia-s3); `c13d4b6a` is still leased but unaffordable. The other three
  (`da09d0f2`, `9eb4e600`, `59f1273d`) are affordable today.

## Reused, unchanged (imported, never copied or edited)
- **Generator and verifier:** `ens-outage-20261022/batch-topup-review/batch-topup.mjs` (`parseManifest`, `buildProposal`, `verifyProposal`, the
  `EXCLUDED` adapter, pinned reserve/ledger code hashes, the 600 s freshness rule and the exact-total rule).
- **Bridge:** `ens-outage-20261022/deposit-ui/bridge.mjs` and its page.
  - One journaled intent through the durable external signer: quorum simulation, gas estimate, agreed pending nonce, fee caps.
  - A fresh recheck at prepare AND immediately before the single wallet request, with an exclusive claim file, so the
    wallet is asked once per intent, ever.
  - The page reports back only a hash or an explicit 4001 rejection.
- **Chain and journal:** `wallet-handoff-bridge/tree/cli/independent.mjs` (`QuorumChain`, 2 of 3 RPCs, 2 confirmations) and
  `independent-signer.mjs` (journal, `attachHash` → quorum receipt confirmation).

## New in this package
- `batch-plan.mjs`: the bridge step.
  - **Fresh reads** at one agreed block (recorded per RPC host, bound to the agreed block hash):
    - Multicall3, reserve and ledger code;
    - `paused()`;
    - per row: `ledger.get` (id, CURRENT owner, active, appRef), `reserveOf(id, current owner)` (enabled, balance) and
      `blockedDeployment`;
    - the live catalog label;
    - the sender's balance.
  - **Proposal:** those reads become an `enclave-reserve-batch-evidence/v1` document passed to the reviewed `buildProposal`.
    It needs ≥2 distinct agreeing hosts, ≤600 s, and the root-supplied Multicall3 code hash. `verifyProposal`
    decodes every call (atomic, exact amounts, ids, no double pay).
  - **Done** only when a confirmed intent of this plan exists AND its receipt, read by the quorum, is successful, from the
    sender, to Multicall3, and carries exactly one reserve `Deposited(id, currentOwner, Multicall3, 0.001 ETH)` per row
    and nothing else from the reserve.
  - **Never paid twice:** a confirmed intent whose receipt does not prove that is **blocked**. So is any open, confirmed or
    mismatched intent of another batch plan. A batch never becomes "ready" twice.
- `serve.mjs`: root's entry point (below).
  - Its own journal is `./journal`.
  - It refuses while `ens-outage-20261022/deposit-journal` holds an unresolved intent for the same account. That check is
    a read-only scan.
- `test/batch-plan.test.mjs`: 7 offline tests against a fake RPC quorum shaped like `QuorumChain`.
  - Code hashes come through an explicit `codeHashOf` test seam; production always hashes the code it read.
- `mutants.sh`: mutation controls.

## Startup (root; queue policies apply to anything you choose to queue)
Root first establishes the Multicall3 runtime code hash independently, as in `batch-topup-review/REVIEW.md`. Root's own
`root-fleet-health-20261022T1405/batch-evidence.out` shows the observed value from two RPCs at block 52944340. This
package does not pin or assume it.
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/root-queued-recovery-20261022
node serve.mjs --multicall3-codehash 0x<root-established> --expect-total-wei 10000000000000000 --state     # read-only verdict -> state.json
node serve.mjs --multicall3-codehash 0x<root-established> --expect-total-wei 10000000000000000 --prepare   # ONE journaled intent -> request.json; nothing sent
node serve.mjs --multicall3-codehash 0x<root-established> --expect-total-wei 10000000000000000 --serve [--port 39692]
```
`--serve` listens on 127.0.0.1 only and writes the tokenized page URL to `local-url.txt` (0600). The user opens it in
the browser with MetaMask, connects `0x0b2d…`, reviews the rows and the exact parameters, and clicks
**Review in MetaMask**. The bridge then rechecks at a fresh block, simulates the exact transaction, checks the nonce
and pending nonce, writes the claim file, and releases the parameters once.

**Page API** (same-origin, `x-handoff-token`; reviewed bridge):
- `GET /api/state`
- `POST /api/prepare {step}`
- `POST /api/claim {intent}`
- `POST /api/attach {intent, ticket, hash}`
- `POST /api/rejected {intent, ticket, code: 4001}`
- `POST /api/resolve {intent}`
- `POST /api/discard {intent}` (never-handed only)

**CLI settlement for lost answers:** the existing signer `resolve` / `attach` / `abandon` on `./journal`, as the page
text describes.

## After inclusion
The step shows **done** only after the quorum-read receipt proves all 10 deposits to their planned owners. Runtime
recovery is separate: each host must claim again, and the publisher's seq-0 startup hazard applies
(`ens-public-site-20261021/publisher/recovery-plan.txt`).

## Residual risks (unchanged from the review)
- An owner transfer between the fresh read and inclusion credits the new owner. No on-chain assertion exists for that;
  the window is bounded by the recheck immediately before the wallet request.
- MetaMask shows a 0.01 ETH call to Multicall3, not to the reserve. The page shows the decoded rows and the call-data
  sha256 (`effects`).
- Gas is the signer's quorum estimate under the ceilings `gasCap` 1,200,000 and `maxFeeGwei` 0.1. The sender balance must
  cover 0.01 ETH plus a 1.2e14 wei fee allowance.
