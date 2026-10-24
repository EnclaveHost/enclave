# Funding metal0's operator C9 through standard EIP-7702 account maintenance: source-only preparation

Written 2026-10-23.

Root reviewed the first assessment (76ab248) and authorized SOURCE-ONLY preparation and tests. This is that
preparation:
- an unsigned plan builder, a read-only prepare that root runs, and tests on real EIP-7702 processing with throwaway
  keys;
- **no signer, no sender, no key read, no delegation change, no network send.**

The actual change, and the use of the canary sponsor's funds, need human approval after root's review and a fresh
read-only prepare. Nothing here asks for or claims that approval.

It is NOT the rejected route: there is no new contract, no SELFDESTRUCT or forced-funding helper, no manual proof-key
helper, no generic execute path, and no contract or admin change.

## The maintenance (C9 and the same executor only)

| tx | sponsor S `0x29479bf0…647c`, nonce | authorization (C9's key signs) | call | after |
|---|---|---|---|---|
| A | s | `{8453, 0x0, N}` | `to C9, value 5,000,000,000,000 wei, data 0x`, gas 50,000 | code empty, nonce N+1, balance + V; storage untouched |
| B | s+1 | `{8453, 0x8900baca…d343, N+1}` | `to S, value 0`, gas 47,000 (never into C9) | code `0xef0100‖executor` (hash `e2f1317f…`), nonce N+2 |

- N is C9's nonce, which must be settled (agreed = latest = pending on both providers). s is the sponsor's.
- The nonce rule for a separate sponsor: an authorization's nonce is the authority's CURRENT nonce, and each applied
  authorization bumps it. B therefore carries N+1. It would be +1 only if C9 sent the transaction itself.
- Fees: the aggregate outer fees of A + B (L2 cap + L1 upper bound for the maximum signed size + Isthmus operator fee)
  are capped at **2,000,000,000,000 wei**. Over the cap, the plan **refuses**; nothing is raised.
  - With 0 L1/operator fee, the cap holds up to a base fee of 9,809,278 wei at a 0.001 gwei tip. That is computed in
    `test/plan.test.mjs`. Base was about 0.005 gwei.
  - The synthetic example bounds A + B at 1.167e12 wei.

## Corrections to the assessment (root review)

1. **Front-running is not always a revert.** If a third party applied A's authorization first, C9 is codeless at N+1.
   Our A's authorization is then skipped as stale, but **its value call to the codeless C9 succeeds**, so C9 is funded
   anyway, and B (N+1) restores it.
   - If the lease client re-delegated C9 in between, our A reverts and our B is skipped: C9 ends delegated and
     unfunded, and a new plan is needed.
   - All of these run on revm (`test/protocol.test.mjs`).
2. **The lease client signs its own authorization when C9 is not delegated.** Verified in
   `client/lease-executor-client.mjs`: lines 463-464 on the signing path and 573-574 on the preflight. So **every C9
   signer (control, lease keepers and relays, boot/funding tools) and every pending sponsored Lease TTL must quiesce**
   before A, until B is verified. The prepare requires root's `quiesce.json` and refuses without it.

## Files

- **`lib/maintenance.mjs`**:
  - the production pins: C9, executor and code hashes, reserve and code hash, sponsor, V, cap, gas, ERC-7201 slots,
    quiesce margins;
  - `buildPlan`, which is pure, plus `checkQuiesce`, `RECOVERY` and `LIMITS`;
  - a read-only `createPreparer`: two providers at one agreed block, using the vendored reviewed paced transport
    (`vendor/publish.mjs` = custody-proof-app ad81dd5, sha256 `d255587b…`).
  - The CLI path accepts only the production pins; test fixtures must say so explicitly.
- **`bin/prepare.mjs`**, which root runs: `node bin/prepare.mjs --quiesce <root quiesce.json>` writes `plans/<sha256>.json`
  (unsigned). Exit 3 means a refusal, and it gives the code.
- **`config/quiesce.example.json`**, the shape of root's facts. Lease expiries, the last outstanding sponsored Lease
  deadline and the stopped signers are root-provided; nothing is assumed.
- **`evidence/plan-shape-SYNTHETIC.json`**: the exact plan shape with production pins and SYNTHETIC facts. It is NOT
  for signing.
- **Tests:** `test/protocol.test.mjs` (anvil, revm), `test/plan.test.mjs` (pure), `test/mutants.sh`.
- **Builds and fixtures:**
  - `test/compile.mjs` builds the reviewed `EnclaveLeaseExecutor.sol` (sha256 `dc605ffa…`) plus `test/ReserveStub.sol`
    offline (solc 0.8.35);
  - `test/env.mjs` holds the fixtures. All keys there are generated per run and thrown away.

## What the read-only prepare reads (two providers, one agreed block)

- **Chain and codes:** the chain id; C9's code = `0xef0100‖0x8900baca…`; the executor runtime `dd893cd4…`; the reserve
  runtime `cc00efe9…`, with `reserve.executor()` and `delegationCodeHash()` matching.
- **Sponsor:** has no code, and it is not C9.
- **Accounts:** C9's and S's nonces (agreed = latest = pending), and both balances.
- **Executor state:**
  - C9's executor storage read RAW (the authorized slot, and each listed lease id's nonce slot), so it is comparable
    even while C9 is codeless;
  - the same through the executor's views (`authorizationCharged()`, `nonceOf(id)`).
- **The premise:** a plain transfer of V to C9 reverts today. Where providers allow state overrides, it also records
  that the transfer to a codeless C9 succeeds.
- **Fees:** base fee, tips, and the GasPriceOracle values (`isIsthmus`, `getL1FeeUpperBound(size)`,
  `getOperatorFee(gas)`).

**Refusals:**
- `operator_code` (C9 not delegated, or delegated elsewhere);
- `sponsor_code`, `executor_code`, `reserve_code`, `reserve_binding`;
- `nonce` (anything in flight);
- `premise`;
- `quiesce`: not from root, no signers listed, stale, or a Lease deadline not yet past on chain plus 60 s;
- `lease_window` (a listed lease has under 1,800 s left);
- `operator_fee` (not Isthmus);
- `fee_cap`, `sponsor_balance` (below V plus bounded fees);
- `rpc_disagree`, `rpc_budget`, `rpc_rate_limited`.

## The plan's own requirements (in the JSON)

- **Before broadcasting:**
  - both authorizations and both transactions are signed;
  - both raw transactions are written to a private 0600 journal (fsynced, exclusive) and never logged.
- **Order:** broadcast A, then B immediately; the sponsor's nonces s, s+1 enforce the order.
- **`verifyAfterA`:** code `0x`, nonce N+1, balance + V, raw storage unchanged.
- **`verifyAfterB`:**
  - the designator and its code hash `e2f1317f`, nonce N+2;
  - raw storage and the executor's views unchanged, and the reserve's binding unchanged;
  - 2 confirmations on 2 providers.
- **`recovery`:** one row per state (below).

## Tests (unchanged queue; throwaway keys only)

| suite | lane | result |
|---|---|---|
| `./q.sh 512 protocol-N ./run-tests.sh protocol` (anvil, `--hardfork prague`: real revm 7702 processing) | 512 | 12/12, peak 194 MiB |
| `./q.sh 256 plan-N ./run-tests.sh plan` | 256 | 6/6 |
| `./q.sh 512 mutants-N test/mutants.sh` | 512 | 11/11 killed, peak 203 MiB |

**Protocol paths, each actually processed on anvil:**
- **Prepare:** exact tuples, nonces and digests; the throwaway signature recovers to O; storage and views observed; the
  premise; fees within the cap.
- **Happy path:** after A, code `0x`, N+1, exactly + V, every storage slot (lease nonces, authorized flag, an unrelated
  slot) unchanged. After B, the designator and its hash, N+2, `nonceOf` 7/3, `authorizationCharged` true, and the
  reserve binding.
- **The hazard:** between A and B, a relayed `lease()` call to the codeless C9 returns **status 1 with no logs and no
  storage change**. The same B then restores.
- **Order:** B submitted before A still runs after A in the same block.
- **Reorg:** after a revert, the same signed bytes give the same hashes and the same final state.
- **Stale A** (C9's nonce moved, still delegated): A reverts, not out of gas, and V stays with S. B, now valid, only
  re-delegates the same executor.
- **Front-run:** our stale A still funds the codeless C9, and B restores.
- **Front-run + the lease client's authorization:** A reverts, B is skipped; C9 ends delegated and unfunded.
- **A mined, then C9's nonce moves:** B is stale and C9 stays codeless. Recovery: C9 self-sends a restore with
  authorization nonce = current + 1, and everything is preserved.
- **Wrong-chain authorization:** skipped; A reverts and nothing moves. Chain id 0 is refused by config.
- **Prepare refusals** on the live local chain.
- **Gas measured:**

| path | gas used | limit |
|---|---|---|
| A valid (transfer) | 36,800 (46,000 before refund) | 50,000 |
| A skipped, delegated (revert) | 46,043 | 50,000 |
| A skipped, codeless (transfer) | 46,000 | 50,000 |
| B (restore) | 36,800 (46,000 before refund) | 47,000 |

**Mutants killed:**
- B at nonce N;
- chain id 0;
- no fee cap, no sponsor-balance check;
- no operator-code or sponsor-code check;
- unsettled nonce;
- Lease deadline ignored, lease window ignored;
- L1 sized from the unsigned bytes;
- restore to another address.

## Recovery and restore (no interrupted state left implicit)

| observed | meaning | action |
|---|---|---|
| A reverted, C9 delegated | A's authorization was stale and V never moved | stop; re-read; new plan (new nonces and signatures) |
| A succeeded, but C9's nonce is still N+1 and the authorization was not ours | a third party cleared C9 first; C9 is funded anyway | broadcast B (valid at N+1) |
| A mined, B pending, dropped or crashed | C9 is a funded plain account. The reserve refuses it, and `lease()` calls are SILENT no-ops. | re-broadcast the SAME journaled B while C9's nonce is N+1; keep every signer stopped |
| A mined, C9's nonce moved | B is stale | read the code. The exact designator means a restore already happened (verify the storage). Otherwise a NEW restore (C9 self-sends with nonce = current + 1, or a new sponsored B) after fresh review. |
| a reorg | both transactions are re-includable as the same bytes | re-broadcast the journaled bytes; verify only at 2 confirmations on 2 providers |
| B verified | done | resume the signers |

There is no "rollback" of the funds: V is C9's, movable only by C9's key.

## Limits (also in the plan JSON)

- **No live simulation of the signed transactions:** an unsigned prepare cannot eth_call them, because no
  authorization signature exists yet.
  - Its live checks are the plain-transfer revert (the premise) and, where supported, a state-override simulation of
    the codeless transfer.
  - The actual 7702 processing is exercised only on anvil (revm, Prague) with throwaway keys.
- **Source, not deployed bytes:** the storage-preservation test runs the reviewed executor SOURCE rebuilt locally. The
  deployed runtime `dd893cd4…` is pinned by hash but not rebuilt.
- **Txpool rules unverified:** Base's sequencer txpool rules for type-4 transactions are not verified. A refused
  submission is a no-op, not a partial state.
- **Root-provided facts:** lease expiries and the last sponsored Lease deadline come only from root.
- **Sponsor key path:** not named here; the sponsor's signer is root-provided. C9's authorizations need the root-only
  registry key (`metal/config.json` `registryKey`); this tool reads neither.

## Approvals the real change would need (stated, not requested)

1. Root: review this preparation, then run `node bin/prepare.mjs --quiesce <quiesce.json>` at a fresh, quiesced moment.
2. The C9 key holder: two authorizations exactly as in the plan.
3. The owner of the canary sponsor `0x29479bf0…647c`: V = 5,000,000,000,000 wei plus at most 2,000,000,000,000 wei of
   fees, and the two sponsor transactions.
4. A separately reviewed signer/sender. It is not written here.
