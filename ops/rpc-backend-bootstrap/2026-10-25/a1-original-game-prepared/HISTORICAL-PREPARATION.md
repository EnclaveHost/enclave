# A1 original-game re-check (prepared; tests PENDING)

## Status

| Item | State |
|---|---|
| Source and runbook | Prepared. |
| Tests | **Not run.** Both foreground attempts on the shared 256 MiB queue returned **rc 98 (NOT STARTED: small allocation held)** (`logs/tests.try{1,2}-rc98-not-started.*`). rc 98 is not a result. Per instruction, no further attempts and no background jobs. |
| Mutants | **Not run** (`mutants.sh` prepared). |
| Live run, SSH, commits, native builds, contract changes | None. A1 (`../l1-anchor-a1`, `source/.../l1-anchor-a1`) is read-only and unchanged. |

## Status update (unit repair)

- **Root's unit run 2136:** 26/27, rc 1 (`logs/root-unit-2136-FAILED-26of27.*`, preserved). The failure was the `not_fresh` **test fixture**: it lowered only Helios's finalized number, so `finalized_number_mismatch` fired first.
- **Repair (test only):** a dedicated `not_fresh` test keeps Helios and header numbers in agreement and moves the **INITIAL** receipt to the same, a newer, or the same-hash block. A control one block older passes. The separate `finalized_number_mismatch` case is kept. **The implementation is unchanged** (`a1-recheck.mjs` `f591f324…`).
- **Corrected unit run:** **PENDING**. The attempt returned rc 98 (NOT STARTED: small allocation held; `logs/tests.try3-repaired-rc98-not-started.*`). No pass is claimed.
- **Mutants (`mutants.sh`, strict):** **NOT RUN**; they require a passing unit run first.

## Purpose

During a long A2–A4 rebuild the ASR's **latest** anchor may advance. The bootstrap stays bound to the **original** game and the N and output root from the initial A1 receipt.

This re-check proves, at a **fresh** Helios-finalized L1 block, that the **original** game is still eligible with exactly the same root and N.
- **Never** accepted: the latest anchor or its descendants.
- **Never** changed: N.

**Original values** (from `live-1958/a1-evidence.json`, sha256 `b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c`):

| | Value |
|---|---|
| Game | `0x343b3a99527af07d2cfb2652747b9e37715e21ac` |
| N | **52,866,960** |
| Root | `0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700` |
| ASR | `0x909f6cf47ed12f010a796527f562bfc26c7f4e72` |
| Portal | `0x49048044d57e1c92a77f79988d21fa8faf74e97e` |
| Respected type | 621 |
| Initial L1 block | 26,271,848 |

## Reuse, not weaker semantics

The pinned A1 files are byte-identical copies; a test asserts their hashes against the read-only published package:

| File | sha256 | Provides |
|---|---|---|
| `a1-anchor.mjs` | `ec92b70f…` | `validateConfig`, ABI, `callData`, independent MPT `checkProofResponse`, EIP-1967 slots |
| `a1-read.mjs` | `a501a3ec…` | the bounded transport `rpc()`/`loopbackUrl` |
| `vendor/anchor-bootstrap.mjs` | `90a8afba…` | `headerHash` |

The new logic is only in `a1-recheck.mjs` (`f591f324…`) and its CLI `a1-recheck-read.mjs` (`41b83975…`).

## Rules (`runRecheck`): every refusal is a named code

**1. Bind the initial receipt.**
- The exact file bytes must match the configured sha256 (`initial_sha`).
- Only verdict `A1-authenticated` without `recheckOf` is accepted. **A recheck output is never initial evidence** (`not_initial_a1`).
- Read labels must be `helios-call`/`mpt-proof`, and the ASR candidate must record an authenticated match (`bad_initial`).
- The configured `originalGame`/`originalN`/`originalOutputRoot`/`asr` must equal the receipt (`binding_mismatch`).

**2. Fresh L1 block.**
- Helios-finalized. The EL header's recomputed hash must equal it (`header_mismatch`), with number/timestamp agreement.
- It must be **strictly newer** than the initial block (`not_fresh`).
- Age at most `maxFinalizedAgeSec`, future skew at most 15 s (`finalized_stale`/`finalized_future`).
- Every read is pinned to that one block hash, or `finalized-tag` mode refuses on `finality_moved`. No mixed blocks.

**3. Identity and eligibility** (all `helios-call`):
- the portal getter still returns the initial ASR (`asr_changed`);
- not `paused` (`asr_paused`);
- `respectedGameType` is unchanged (`respected_type_changed`: refuse pending operator review);
- for the **original** game: respected, finalized, not blacklisted, not retired, status DEFENDER_WINS;
- `rootClaim == initial root` (`root_changed`) and `l2SequenceNumber == initial N` (`number_changed`);
- `gameType == initial type` and `game.anchorStateRegistry == ASR`.

**4. Latest anchor: observation only.**
- It is recorded as `{game, N, root, advanced, accepted: false}`.
- The recheck refuses if the anchor's N is **below** the initial N (`anchor_regressed`), or if the anchor names the original game with a different root or N (`anchor_inconsistent`).

**5. Code and proxy pins.**
- Fresh `eth_getProof` from our untrusted reth is verified **locally** against the fresh stateRoot.
- Compared against the **initial observations:** codeHash plus every initially observed slot (default the two EIP-1967 implementation/admin slots; `pinSlots` must equal the initial slot set exactly).
- Any change gives `code_or_proxy_changed`: **refuse pending operator review**.
- **This is NOT an approved-version comparison:** the initial pins were authenticated observations, not audited versions. It gives no claim of security or upgrade protection, only "unchanged since the initial A1".

**6. Output.**
- Verdict **`A1-original-game-recheck-passed`**, frozen.
- `recheckOf {sha256, verdict, game, N, outputRoot, asr, l1}` binds the initial receipt. `N`/`outputRoot` are always the initial values.
- A2 integration is for later root review.

**Not touched:** no contract is called with a state-changing method, and platform administrator rights are untouched (reads only).

## Tests (prepared; run by root when the small lane is free)

**`test/a1-recheck.test.mjs`** (`632a8262…`):

- **Real data:**
  - the live initial receipt binds (sha, game, N, root, ASR, type, L1 block), the production config validates, and 5 binding refusals;
  - the Helios upstream mainnet proof (block `0x14e8d38`) is the untrusted-EL proof source.
- **Mocked:** all Helios `eth_call` answers, as a stand-in for the verifier. The deposit-contract address stands in for portal = ASR = game. Nothing here is evidence about Base.
- **Cases:**
  - pinned-reuse hash checks;
  - initial-receipt refusals (wrong sha, tampered byte, recheck substituted, plain-rpc label, no authenticated ASR match);
  - pass: unchanged;
  - pass: anchor **advanced** (observation only; N/root unchanged; `accepted: false`);
  - 19 named refusals, plus game-ASR, code/proxy pin changes (codeHash, slot), stale/future, finality-tag move and a mixed-block attempt.

**Commands** (shared queue, foreground only):
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/a1-original-game
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/tests.guard -- unshare -rn sh run-tests.sh > logs/tests.out 2>&1; echo $? > logs/tests.rc
python3 -u ../../../claude-test-queue.py --mib 256 --log logs/mutants.guard -- unshare -rn sh mutants.sh > logs/mutants.out 2>&1; echo $? > logs/mutants.rc
```

**`mutants.sh`** (baseline must pass first; 10 mutants): initial verdict, initial sha, freshness, root unchanged, N unchanged, respected type, codeHash pin, anchor regressed, **use-latest-N** (output N from the latest anchor must be caught), config binding.

## Root live runbook (read-only; existing bounded own-Helios harness; no public RPC, no fallback)

1. **Preconditions:**
   - the own L1 is synced and non-optimistic, with the reth proof window 256 (as at 19:56);
   - the l1-authority checkpoint is within its 7-day / Helios 14-day bound;
   - the shared small lane is free.
2. **Run:**
   ```
   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log <OUT>.guard -- \
     python3 -I /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/a1-original-game/run-recheck.py <OUT>
   ```
   - `<OUT>` is a NEW directory, e.g. `outputs/rpc-production-final-20261025/l1-a1-recheck-HHMM`.
   - `run-recheck.py` (`373b8635…`) asserts the initial receipt sha, starts the pinned Helios through `l1_authority.py run` with `outputs/.../l1-authority-live-1941/config.json`, waits for a fresh status, runs `a1-recheck-read.mjs` once, stops Helios, and writes `recheck-config.json`, `recheck.json`, `recheck.stderr`, `helios.out` and `run-result.json` (with input pins).
3. **Accept only:**
   - `recheck.json` `verdict == "A1-original-game-recheck-passed"`;
   - `recheckOf.sha256 == b9a90847…`;
   - `N == "52866960"`.

   Any refusal code stops the A2–A4 bootstrap until root review. Pin changes in particular need operator review before any decision.

## Open limitations

- **Unvalidated:** tests and mutants are **pending** (rc 98 twice); no claim of passing.
- **Unproven live behaviour:** real Helios on these exact calls at a later block. The original A1 run used the same calls.
- **Trust level:** light-client-relative; not SNP or attested.
- **Pins:** observations, not approvals.
- **Anchor-advance policy:** pinned at "refuse on regression or inconsistency; otherwise observe".
