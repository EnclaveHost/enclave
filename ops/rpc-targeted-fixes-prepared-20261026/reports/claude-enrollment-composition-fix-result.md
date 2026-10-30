# Enrollment composition fix: result (PREPARED; nothing run; no PASS claimed)

**Stage:** `enrollment-composition-fix-stage/` (`SHA256SUMS` sha256 `96281e46778d714a4ca5b8f4440788b76e816398df9c13ef02b732b7ed8c0cfa`).

| File | sha256 |
|---|---|
| `patches/network-enroll-rpcs.patch` (runtime) | `266be4414964703e69feb25ec0867273fece452b183ccb1f490523cadbd8c767` |
| `tests/network-enroll-chain-rpcs.test.mjs` (regression, 6) | `21c8a9c9201bed85d7940ec881ccb6233a9fc95f0a5a21b2abe41654fbd7d898` |
| `jobs/root-enrollment-fix.sh` | `f93cf7abca7f367b4a25e79f3d6af6e83ee69e938c1fb07c8698a60ff8e1f98b` |
| `README.md` (the files owned) | `c4a0cca2944b42ab1ff868b7795d13f9a05bd799ab085773c1cb59a7b12813ae` |

**What Claude did:** read git objects only (`--no-optional-locks`), wrote files, and ran static checks (`node --check`, `bash -n`, Python `ast.parse`, sha256).
- **Not done:** no tests, builds, queue jobs, network access, live actions or commits.
- **Untouched:** the active, frozen r12 tree and stage (r12 `SHA256SUMS` still verifies), and the real branches.

## The actual failure

r12 `RESULTS.tsv`: `REGRESS test/host-service-transport.test.mjs` had route baseline 14/0 and final 11 pass / 3 fail. Its receipt log shows `ReferenceError` in:
- **test 8:** hostServices opt-in;
- **test 9:** invalid block preserved;
- **test 14:** challenge replica / TLS.

## Cause (traced in the git objects)

At the candidate `debbfb377d90f4193ea9182f5cb67d714ffaa322`, `windows/node/network-enroll.mjs` (blob `d336f24d…`) uses `rpcs` at 238–244, but nothing declares it.

- **consumer-windows** `e4f507d6b` (blob `4c8d8e9d2`; ownercli identical) declares `const rpcs = Array.isArray(config.chainRpc) ? config.chainRpc.filter((u) => /^https:\/\//.test(String(u))) : [];` directly before its `agentChain()` authority block.
- **route** `b3fde181` (blob `5f5a8fc5d`) had moved it below its own `agentChainAuthority`/`verified` block.
- **The composition** kept consumer-windows' authority model and route's surrounding code, losing both copies.
- **Effect:** every legacy, non-fresh pass throws. That includes the adapted `test/windows-chain-authority.test.mjs`, whose legacy step (`await pass(common)`) runs the same branch; it was not yet run in r12 when I read the results.

## The fix (minimal; source only; the patched blob is `43c50a1f…`)

**What it changes:** it restores consumer-windows' exact declaration in consumer-windows' position, with a two-line comment.

**Behaviour after the fix:**
- **Verifier path:** a selected chain authority takes the first branch, and `agentChain()` (with an empty RPC list) yields exactly the local verifier, or `{addressBook}` only for an INVALID selection. `rpcs` is never consulted there, so there is **no public RPC fallback**.
- **Legacy configs:** unchanged. They follow the node's https list (at least 2, http dropped), are never emptied, and the verifier selection is removed when leaving it.
- **Operator opt-ins and invalid blocks:** the hostServices opt-in, invalid-block preservation, challengeReplica and policy carriers are untouched code. No test is weakened and no invalid config is deleted.

## Regression (`tests/network-enroll-chain-rpcs.test.mjs`, 6 tests, real `createNetworkEnroll`)

1. Legacy: the https list replaces the agent list (http dropped) with one restart; an unchanged list restarts nothing.
2. Fewer than two https RPCs never replace or empty the list.
3. Verifier authority: the chain is exactly the verifier, and the node's public `chainRpc` is never written beside it.
4. An INVALID selection configures no RPC at all.
5. Verifier → legacy: the selection is removed and the list restored.
6. The challengeReplica opt-in is kept byte-for-byte across an RPC switch.

On the **unpatched** candidate, exactly 1, 2, 5 and 6 fail, with `rpcs is not defined`.

## Root runner (`jobs/root-enrollment-fix.sh`)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/enrollment-composition-fix-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2048 --log $ST/logs/root-enrollment-fix.guard -- unshare -rn bash $ST/jobs/root-enrollment-fix.sh > $ST/logs/root-enrollment-fix.out 2>&1; echo $? > $ST/logs/root-enrollment-fix.rc
```

**Setup:**
1. It verifies the stage and r12 hashes and binds the candidate's exact blobs (`network-enroll.mjs` and all 7 test files).
2. It makes two private `git archive` exports from the r12 tree's objects (read only), with the dependency closures copied and checked against r12's `DEPS.txt` (r12's `deps-identity.py`) and the network runtime built.
3. It patches one export, checking the patched blob `43c50a1f…`.

**Exact expectations,** each with skip, todo and cancelled = 0:

| Run | Test file | Tests | Pass | Fail |
|---|---|---|---|---|
| unpatched | `host-service-transport` | 14 | 11 | 3 (tests 8, 9, 14) |
| unpatched | regression | 6 | 2 | 4 (tests 1, 2, 5, 6) |
| patched | `host-service-transport` (= route baseline) | 14 | 14 | 0 |
| patched | `host-services-carriers` (= recorded) | 9 | 9 | 0 |
| patched | `host-services-cold-start` | 12 | 12 | 0 |
| patched | `windows-chain-authority-runtime` (= recorded) | 12 | 12 | 0 |
| patched | `windows-chain-authority` | 10 | 10 | 0 |
| patched | `windows-node-network-enroll` | 12 | 12 | 0 |
| patched | `windows-node-wallet-enroll` | 1 | 1 | 0 |
| patched | regression | 6 | 6 | 0 |

**Rules:**
- The unpatched failures must show `rpcs is not defined`.
- Counts without a recorded result are the static top-level `test(` counts. Those files have no dynamic or skip-gated tests.
- PASS = `## enrollment-fix rc=0`.

## Limits

- **Unrun.** The cold-start, network-enroll, wallet-enroll and adapted chain-authority counts have never been observed in a root run with this candidate; they are static counts.
- **Excluded:** `windows-verifier.e2e` needs the Helios/reth rig, so it would skip.
- **Composition is root's next step:** with the provider-fixture fix, then the full suite. This stage does not run all 104 tests.
