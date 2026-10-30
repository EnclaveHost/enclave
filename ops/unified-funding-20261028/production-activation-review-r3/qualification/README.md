# production-activation-qualification-r2 (SOURCE ONLY, NOT RUN)

The author ran nothing: no command, no test, no network, no build or install, no signer or wallet. Every result below is what the source is meant to produce. Root still has to run it and verify that. No file outside this directory was changed. Nothing here approves, activates, grants, migrates a budget or funds the relayer.

| file | what |
|---|---|
| `generate-preparation-inputs.mjs` | Offline generator. Writes `DRAFT-decisions.json`, `DRAFT-pins.json` and `DRAFT-NOTES.json` (status `DRAFT_NOT_APPROVED`). |
| `capture-observation.candidate.mjs` | Minimal capture patch: header number/field validation and two provider walks in parallel. See `CAPTURE-PATCH.md`. |
| `test/fixture.mjs` | TEST fixture. The pinned inputs are the actual files; the chain reads are scripted. The observation it writes is marked `test: true` and is not a live observation. |
| `test/prepare.test.mjs` | The FULL actual `production-activation-prep-r1/prepare()` with the actual staged parsers and `loadFundingActivation`: one happy path plus mutations. |
| `test/capture.test.mjs` | The capture candidate against a scripted fetch: header checks, parallel walks, pacing. |

## Exact commands (root, from `unified-funding-20261028`)

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028

# 1. tests (offline; write only under os.tmpdir())
node --test --test-concurrency=1 production-activation-qualification-r2/test/prepare.test.mjs production-activation-qualification-r2/test/capture.test.mjs

# 1b. the same with the pinned runtime code. This enables the happy path and the 10 chain-walk mutations.
PUBLIC_CODE_BUNDLE=/absolute/path/to/code-bundle.json \
  node --test --test-concurrency=1 production-activation-qualification-r2/test/prepare.test.mjs production-activation-qualification-r2/test/capture.test.mjs

# 2. draft preparation inputs (offline)
node production-activation-qualification-r2/generate-preparation-inputs.mjs --out /absolute/new/draft-dir

# 3. after root review: fill the draft, then run the read-only live capture and the unchanged preparer
node production-activation-qualification-r2/capture-observation.candidate.mjs --pins <PINS.json> \
  --rpc https://mainnet.base.org --rpc https://base-mainnet.public.blastapi.io --out /absolute/new/observation.json
node production-activation-prep-r1/prepare-activation.mjs --pins <PINS.json> --out /absolute/new/prepared-dir
```

Expected test outcome:

- **Without `PUBLIC_CODE_BUNDLE`:** 39 tests pass and 11 are skipped. The skipped tests print the reason, "pinned runtime code cannot be synthesized (keccak preimage)".
- **With a valid bundle:** all 50 tests pass.

Every bundle entry is keccak-checked against its pin. A wrong entry fails the run rather than being skipped. Two bundle formats are accepted:

- a `capture-observation` output, of which only the `code|<address>` reads are used;
- `{ "<address>": "0x<runtime>" }` with the 11 pinned addresses: the 4 receipt contracts, the implementation, the oracle proxy and its implementation, the feed proxy and its aggregator, and the sequencer proxy and its aggregator.

## Generator: values and sources (each one is checked; a difference refuses)

- **Paths:** the receipts at `../source/ops/unified-funding-20261028/production-deployment-20261028/receipts.json`, plus `production-deployment-observation-r1.json`, `production-session-config-2128.json`, `deployment-r1/UNSIGNED-PROPOSAL-r1.json` and `production-fee-observation-r6.json`. The sha256 of each is computed when the generator runs.
- **Modules:** the five staged modules must equal `relay-prestage-r1/STAGED-MANIFEST.json` (`staged_drift`).
- **Host queue:** `maxAttempts 5` and `maxTipWei 10000000`, regex-read from the staged `sessions.mjs` (the `TxQueue` constructor and `createSessionsService`) and compared with the explicit constants.
- **Fee policy:** compared with `production-fee-observation-r6.json`, which must be read-only and from two providers at block 53217886:
  - `tx.maxAttempts 3`, tip `2000000`, `gasLimit 1000000`, `maxFeePerGas 20000000`
  - `maxFee6 80000` (0.08 USDC), `marginBps 2000`
  - `maxBlockAgeSec 180`, `quoteTtlSec 300`, sequencer `"checked"` with grace 3600
  - `changesFromReviewedObservation: []`
- **Intake:**
  - tiers 100/500/3000, `maxSlippageBps 100`, `deadlineSec 300`, `maxBlockAgeSec 180`
  - quoter `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
  - intake and fee `notAfter` = generation time + 86400 s
- **Relayer:** taken from the session config; the minimum balance is `100000000000000` wei (1e14).
- **`measuredExecuteGasUsed 631198`:** the largest of the historical fork CALL-trace figures 625399/609472/631198. `measuredEvidence` says these are not receipts and exclude intrinsic and cold-state gas. The actual queue estimate at quote time is mandatory.
- **What makes it a draft:** `reviewedBy`/`reviewRef` are null, so the preparer refuses with `decision_missing`. The decisions and observation pins are null, so it refuses with `pin_missing`. Root has to review, fill in and re-pin these.

## Limitations

- **Not run.** The syntax, the regexes (`stagedQueueDefaults`) and the 39/11/50 counts are unverified until root runs the commands above.
- **The happy path needs real code bytes.** Pinned code hashes cannot be met by synthetic code. With no bundle, the happy path and every check after the first code read are skipped (and reported as skipped), not passed. The checks that run without a bundle all happen before or at the first code read.
- **The fixture's chain is scripted.** The legacy implementation, the pools, the nonce (42) and the balance (2e14) are TEST values, and the TEST block is 53300000. Unpinned addresses (USDC, WETH, DEX, quoter, ledger and so on) get synthetic code. The fixture therefore cannot show that any live value is correct.
- **`prepare()` does not refuse a `test: true` observation.** It only accepts what is pinned. Root must never pin a fixture observation; the generator leaves the observation pin null. A small hardening for root to consider: refuse `observation.test`.
- **The quoter check is partial.** The preparer checks only `quoter.factory()` and `WETH9()` against the adapter, plus that the code exists, and it records the observed code hash. Root still has to verify the quoter's runtime against the official Base deployment.
- **The tip cap can be overridden.** `SESSIONS_MAX_TIP_WEI` overrides the host tip cap. The generator cannot read env, so root has to confirm it is unset (or exactly 10000000).
- **The validity window starts at generation.** If root prepares more than 86400 − 600 s after generating, `notAfter` is outside the window and the preparer refuses. Regenerate in that case.
- **Capture candidate behaviour:**
  - It requires strictly lowercase hex quantities and hashes. A non-conforming provider is refused (fail-closed).
  - The pending nonce is still read at the tip.
  - On a refusal, `allSettled` waits for the other walk to finish.
  - Equal nonces do not prove the in-memory queue is idle.
