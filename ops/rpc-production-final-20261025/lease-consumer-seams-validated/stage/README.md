# lease-consumer-seams r4 (PREPARED; not run by Claude)

**What this is:** r3 (FROZEN, untouched; `SHA256SUMS` `eef006ef…`) with only the shared loader fixture corrected. The r3 failure was root job 61747, run `20261026T012004Z-358345`.

**Trace of the actual legacy value:**
- `client/lease-executor-authority.mjs:50` sets `authority = "rpc-quorum"` by default.
- Only a `LOCAL_VERIFIER` client sets `"local-verifier"` (`:51-54`).
- `leaseRpcSet` returns `authority` (`:99`).
- `network/lease-gas-runtime.mjs:99` returns `authority: peers.authority`.
- With no chain authority, `chainAuthorityFromEnv` returns `null` (`network/chain-authority.mjs:104-106`), so the RPCS quorum is used (`lease-gas-runtime.mjs:59-60`).
- The fixture now asserts `plain.authority === "rpc-quorum"`. The key list and every other assertion are unchanged.

**Files:**
- `fixtures.patch`: shared by base and candidate. It differs from r3's only in that assertion, its comment, and the hunk count. The `measured-control` part is byte-identical.
- `candidate-tests.patch`, `test/lease-seams-windows.test.mjs` and `work/c`: byte-identical to r3.
- `work/a`: the REV originals. `work/b`: the expected fixture outputs.
- `jobs/root-seams-test-r4.sh`: the runner root reviewed. It is the r3 runner plus these changes:
  - r4 paths;
  - `r4/SHA256SUMS`;
  - a cmp of both sides' fixture outputs against `work/b`;
  - exactly 66 tests (base 57 pass + exactly the 9 expected failures; candidate 66/66, 0 skip, todo or cancelled);
  - integration hashes.
- Unchanged from r3: the product `seams.patch` (`26393ac5…`), `DEPS`/depcheck, strict rc, and `EXPECTED_BASE_FAIL` (9).
- `INTEGRATION-MANIFEST.md` and `integration/`: the transplant list. `PENDING-platform-api-bundle.md` is a separate pending artifact.

**Source head drift:** `relay-consumer-source` has moved to `920a5911d`, and a mode fix is pending; it includes an independent 3-file deep-CLI patch. r4 does **not** follow it.
- The runner clones `$SRC` and checks out `81ba668531d17151db810e14562c77a672d742e4` explicitly; it asserts HEAD equals that commit.
- The 15 before-pins, the patches and the expected failures are all against `81ba`. No r4 input was changed for the drift.
- Moving onto `920a5911d` (or later) is a separate step after r4 passes: re-derive the before-pins at the new head and confirm the deep-CLI files are disjoint from the 15 paths (and from the platform-api inputs).

**Root command (foreground):**
```
R4=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r4
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $R4/root-seams-test-r4.guard -- unshare -rn bash $R4/jobs/root-seams-test-r4.sh > $R4/root-seams-test-r4.out 2>&1; echo $? > $R4/root-seams-test-r4.rc
```
