# Windows node: serving-first pass ordering (RESULT, 2026-10-22)

**Status: source-only candidate, committed locally and tested offline.**
- NOT deployed, NOT activated, NOT pushed.
- No production action, SSH, contract, budget-gate or helper change.
- The frozen `adapter-admission-review/candidate` 2afa6733, helper 7ac1d873, the node-pair runner and the source
  checkpoint were not edited. Root owns activation.

## Source

| item | value |
|---|---|
| repo | `windows-serving-first/candidate`: `git clone --local --no-hardlinks` of the 2afa repo, branch `work/serving-first`, no remote; dependency trees hard-linked read-only |
| base | `2afa6733fd8a4f45d3049f56fc42c22301752127` (the final renewal keeper) |
| commit | **`829a881c3cd036287b79839b49d3bc3e0cda13b7`**, tree `d9e8cf2e600bceed43f082daf62eda75ac89dbc0`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `windows-serving-first.patch` = `git diff 2afa6733 829a881c`, sha256 `db9842bcfe8a019e8fa5a8ca78cb2a76211c9a1ad68725e2d7ac5705470f5514` (2 files, +247/−166) |
| `windows/node/host.mjs` | 2afa `4bebf7db…` → **`817389eca381b1ed9d298f9289780214643f83cc75480795a751bb5749d87149`** |
| `windows/node/chain.mjs` | unchanged, **`3e9fae0392497841f5c4e084c9d11f6c01243d339b0bdf3395b569f921a12938`** |
| `test/windows-node-lease-renewal-keeper.test.mjs` | `600b59802a2be325bbcb45c39982a8617600623db1ce32e001b8cb0d0146ff65` (+3 tests) |

`INITIAL.md` (`8ef01d80…`) was written before the change.

## The defect and the fix

**The defect.** 2afa's `#tickOnce` ran `scanLedger()` before the per-tracked loop. `scanLedger` is the queued-claim
sweep: per candidate, `consider()` does a claim gate, a claim send and a launch. The per-tracked loop is what reconciles
every deployment this box already serves, adopted or recovered:
- a fresh ledger row;
- the host wallet decision (refusal, unknown, grant);
- placement and admin/platform holds;
- renew-when-due through the shared `#renewTurn` and permit;
- the owner's edit and resize, and `ensureApp`/adoption;
- keeper eligibility (`#leaseSeen`) and the readiness row (`ready`).

So a slow sweep held back the readiness and keeper eligibility of every running app. The loop's own re-claim of a tracked
deployment this box no longer holds (`consider()`) also held back the apps after it.

**The fix, in `host.mjs` only:**
- The loop body moves **verbatim** into `#reconcileTracked(id, { deferClaim })`. The whitespace-insensitive diff shows
  only the 20 `continue` → `return` rewrites (the body has no nested loop) plus the deferral line.
- **Phase 1:** for every tracked id, BEFORE the sweep. The one difference is that a re-claim of a tracked deployment this
  box no longer holds returns `"deferred"`. Its `#walletRevoke` still happens at once; only `consider()` waits.
- **Then** `scanLedger()` and `retireForeignRecovered()`, unchanged, in their old relative order. The recovered-VM sweep
  must stay after the ledger sweep, because the ledger sweep re-tracks a live lease this box holds but no longer tracks,
  before its VM could be retired.
- **Phase 2:** the same body for the ids the sweep added (a resumed lease, a new claim) and for the deferred re-claims,
  each re-read fresh from the ledger. A deferred re-claim's `consider()` therefore runs after the sweep, exactly where the
  old loop ran it.

**Unchanged:**
- the tick single-flight (`tick()`), one renewal per deployment;
- the renewal permit and epoch, the release-journal holds and `chain.mjs`'s queue gate;
- never renewing an unserved app;
- every authorization check;
- `chain.mjs` and every bundle.

## Tests

All runs used `work/claude-test-queue.py` and `job-tests.sh`: the copy of root's immutable `job-tests-r2.sh`, where only
`HERE` differs. It runs with ssh/scp/sftp denial stubs, a private net + pid namespace (`--kill-child`), `--test-timeout`
and an outer `timeout -k`. Logs are in `logs/`.

| run | tree | result | peak |
|---|---|---|---|
| **base-keeper-1** (512) | 2afa `host.mjs` + the new test bytes | **12 pass / 2 fail**: the 11 original keeper cases and the refusal case pass; "slow sweep" FAILS ("the existing app reads ready while the claim sweep is still blocked"), "sweep resumes / deferred re-claim" FAILS ("A ready before the sweep finished") | 171 MiB |
| **cand-keeper-1** (512) | candidate | **14 / 14** | 172 |
| **cand-regA-1** (256) | candidate | **67 / 67**: capacity-boundary, giveup-once, hosting-caps, norenew, owner-set, stopapp-tick, tick-single-flight | 179 |
| **cand-regB-1** (256) | candidate | **29 / 29**: wallet-grant-refresh, wallet-network-hold, wallet-policy, offchain-heartbeat-writers | 195 |
| **cand-readiness-1** (512) | candidate, with PWSH (`/home/steven/enclave-bench/tools/pwsh-7.6.6/pwsh`) and a copied `cutover/` fixture | **9 / 9**, including the pwsh cutover-gate integration | 284 |
| m-no-defer (512) | candidate with the deferral removed | 13/1: killed on "no re-claim before the sweep" | — |
| m-no-phase2 (512) | candidate with phase 2 removed | 13/1: killed on "the deferred re-claim ran once, after the sweep" | — |

The three new tests, on the real Host, the real `chain.mjs` and the scripted sender (gated `scanLedger`):
1. **A slow sweep does not delay an existing app.**
   - While the sweep is blocked (pass `inFlight`), the existing app is `ready`.
   - The keeper renews its lease when due, with no operator ETH.
2. **What the sweep resumes is still reconciled.**
   - A lease the sweep resumes reads `ready` in the same pass.
   - A tracked re-claim (`consider`) runs once, only after the sweep.
3. **Refusals still block during a slow sweep.** A wallet ban, an unknown wallet policy, a transfer to an owner this box
   does not serve, and a platform suspension never read `ready` and are never renewed, before or after the sweep.

Not run here (unchanged scope from the 2afa RESULT): live-edit, hv-attach-relay (it needs the gitignored relay bundle),
and the remaining windows-node and windows-shield suites. None of them exercises this ordering beyond the ones above.

## Activation implications (no native timing guessed)

- **The swap.** Activation remains a two-file control swap: `windows/node/host.mjs` `817389ec` (replaces 2afa's
  `4bebf7db` as the candidate; the installed file is still `9634cb40`) and `windows/node/chain.mjs` `3e9fae03`. Helper
  7ac1's params must name these shas.
- **The budget.** With this ordering, the existing apps' `ready` rows and keeper eligibility appear after phase 1, before
  the claim sweep. They do not wait for a whole pass (the measured 602 s).
  - How long phase 1 takes natively (per-app quorum reads plus adoption) is **not measured here**.
  - 7ac1's `MIN_START_NODE` floor and the 1550-s apply budget stay as they are. Lowering them needs a fresh native
    measurement of time-to-ready under this candidate, and a reviewed helper change. No budget gate was weakened.
- **Behaviour differences to note:**
  - **(a) Same-pass re-claim.** A lease that phase 1 retires as expired can be re-claimed by the same pass's sweep.
    Before, that happened a pass later. `consider()` still applies the funding and hosting policy.
  - **(b) Foreign-VM capacity.** Phase 1 runs before the recovered-VM sweep. A tracked app that needs a fresh LAUNCH (not
    an adoption) while a foreign recovered VM still holds capacity may launch one pass later than before.
- **Rollback.** Swap back the two files (2afa or the installed pair).
