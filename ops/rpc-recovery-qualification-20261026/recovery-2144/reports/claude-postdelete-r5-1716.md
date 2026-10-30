# postdelete-bitmap-stage/r5: focused NC6 fix (anchored last-live boundary). Source only - 2026-10-26

**Not done by me:** no tests, builds or live actions; only AST/`bash -n` syntax checks.

**Frozen stages preserved and verified:** r1 `f5c89089…`, r2 `51c393bf…`, r3 `5ecd6a6d…`, **r4 `0f1f81ef…`** (root actual run `r4/runs/tests-20261026T213628Z-2380611`: 21/22, NC6 FAIL).

## The cause (r4 runtime, confirmed against root's stderr)
- **How r4 chose P:** `iP = live[-1]`, the **last** old-generation image with links > 0 anywhere in the slot history.
- **What NC6 does:** it re-adds a live old-generation image at tid 15, after the coalesced reuse at 13.
- **What went wrong:** P moved to 15, so the boundary was reclassified (blockers "15/None differ from the prior finding 12/13" and "not the old inode unlinked"). The reuse-anchored "old generation seen again" check never ran.
- **Verdict vs reason:** the verdict was correctly BLOCKED, but for the wrong reason.

## The fix (`postdelete_bitmap.py`; the only runtime change)
- **The new rule:** P = the **end of the FIRST contiguous run** of live old-generation slot images. The rows are in tid order; the run starts at the first live old-generation image.
- **An explicit blocker:** any later live old-generation image gives "old generation live again at tid X after the end of its first live run at tid P". It can no longer move the boundary.
- **Unchanged:** the r4 check "old generation seen again after the slot was reused" (now reached), the comparison of P/S0 with the case expectation, and every other rule.
- **No verdict changes:** this only adds a blocker, so no existing BLOCKED or refusal outcome can become a pass.
- **No other cases move P:** in every other fixture, and in the real 1698 slot history as reported (old generation live up to 17169, a new generation from 17170 on), the first live run ends where `live[-1]` was, so P is unchanged.

## Tests (still 22; strengthened, not weakened)
- **NC6** (coalesced, old generation live again at 15):
  - rc 5 with "seen again" (as in r4);
  - **plus** boundary `mode coalesced`, `lastLiveTid 12`, `slotReuseTid 13`;
  - **plus** the blocker "live again at tid 15".
- **NC6b (new subtest, classic):** the old generation is live again at 15, between completion 14 and slot reuse 16. Expected: rc 5 with "live again at tid 15", and the boundary stays `classic`, P 12, S0 13, C 14.

## Stage: `postdelete-bitmap-stage/r5`, FROZEN
**`SHA256SUMS` = `8d5d35b2e21bdb97b9e4dcec73406388fd22b42d9a017e5e98a434be6bfe1cdf`.**

| file | sha256 |
|---|---|
| `postdelete_bitmap.py` | `3a433730503b09882f4e7eec81180da215c66a5ef3b9ca351d9c97d6a175052d` |
| `tests/test_postdelete_bitmap.py` (22) | `15e0afb7dea0c63942b40ff20f20a85ee74a8722361ae685e5c1dd055da8d8ae` |
| `jobs/tests.sh` | `0ea251e8736f68ee3e9b6baafad401c5444f57253a05a72e3f19ecf38e9a6783` |
| `jobs/root-check.sh` | `495b80beedf0fdb403c7ae1aaff0a76647379596e33870e4ca172ae959fdbb81` |
| `README.md` | `152334c0e58ec5c98bfa612bf32aa5fa5a304d8eff0b51812e34b12bc19e3a11` |
| runtime / case / real vectors | = r4 (`jbd2_verify.py` `d3cfa34e…` = r1) |

- **Jobs:** they differ from r4 only by the r5 names and receipt format, plus a check that **r4 is still frozen** (`PR4_SUMS`).

## Root jobs (queue 512, as the unprivileged owner)
```
bash jobs/q-exit-status.sh pdb-r5-tests 512 unshare -Urn bash postdelete-bitmap-stage/r5/jobs/tests.sh       # expect "## PASS (22)"
bash jobs/q-exit-status.sh pdb-r5-check 512 unshare -Urn bash postdelete-bitmap-stage/r5/jobs/root-check.sh  # needs the bound r5 receipt
```

## Not claimed
- **Not executed:** nothing has run.
- **Not acceptance:** the result covers journal history and current flags only, never acceptance.
- **Separate gates still required:** full MDBX, plain-vs-hashed/trie and canonical root.
