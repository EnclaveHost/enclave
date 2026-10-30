# rig-artifact-closure r2: runner correction (PREPARED; nothing run)

**What Claude did:** reads, writes and static checks only (`bash -n`, Python `ast.parse` of all 4 embedded blocks, sha256).
- **Not done:** no tests, builds, queue jobs, network or SSH access, or commits. No product code.
- **Untouched:** the original rig stage (`SHA256SUMS` sha256 `bdc8ae2a…`, still verifies; runner `18ee590f…`), MCP r6, the active r12 job, and the queued lease-fixture job 29692 (not duplicated: r2 selects only MockFeed-ENOENT rows).

## r2 (`rig-artifact-closure-stage/r2/`, `SHA256SUMS` sha256 `aaea7dfa2a7f9fbfde8322ba41b72ea5df2a606298fbb65c8b3cefce37ab7c9a`)

| File | sha256 |
|---|---|
| `jobs/root-r12-impacted-rerun.sh` | `7f35384685ec8a7ca0cd665419b0f66b802e986afc989747feca0144d8f87a38` |
| `runner-r1-to-r2.diff` (41 changed lines) | `de261131b5d8086f250bcb1f93592e80f4c94973e8462866a58098e76e2af301` |
| `README.md` | `503e6c74f51f80f053e9ea39754dee31e1a53034b4c39bc93023ffd6bd4710bf` |

## Corrections (and why the original would not work)

1. **The heartbeat negative control would still skip.**
   - `test/offchain-heartbeat-writers.test.mjs` test 2 needs `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR` (test lines 25 and 86). The original never set it, so even with MockFeed built, its own rerun gate (`skipped == 0`, `tests == pass == 3`) could not pass.
   - **The fix applies only in each PRIVATE COPIED tree that reruns this test:**
     - verify that `6f2c7da466dc26e5f7aac88c574a6b807e1a03df^:supervisor.js` is blob `3ad766906ea1dc34dc6b8010370b15ee7d47b6da` (it resolves in the r12 tree repository);
     - write that exact blob (`git cat-file blob`) as `supervisor.base-6f2c7da46.js` at the copy root, after the build and tracked-file gates;
     - check it with `git hash-object`;
     - set the env var for that one test command.
   - **Unchanged requirements:** the same 3/3 and 0 skips against the r12 receipt's `# tests`. Production source is never altered. The base files are listed in `HB-BASE.txt` and in `RECEIPTS.sha256`.
2. **Row shapes.** r12 writes component and REGRESS rows with 5 fields (`r12-build-validate.sh:254, :260`), and STACK and NATIVE rows with 3 (`:262, :265`; `NATIVE\t<test>\trc <rc> <last line>`).
   - **The original's faults:** its selector treated every non-STACK, non-REGRESS row as a component row, so it would crash (IndexError at `r[3]`) on a NATIVE row. Its amend step would also count a clean NATIVE row as not ok.
   - **r2:** parses each shape exactly. NATIVE rows are never artifact rows and are kept: `ok` only for `rc 0 OK` (a skip there remains a separate r12 `[FAIL]` line, counted). An unknown shape is HOLD. An adapted `ok (…)` row counts as ok (the original compared `== 'ok'`).
   - **Checked against the actual run:** the current `RESULTS.tsv` (123 rows when read: 95 REGRESS and 28 component, all 5 fields) and `receipts/RECEIPTS.tsv` (5 fields: key, tree, test, test blob, log sha). The STACK and NATIVE rows are not written yet; the job is still in E2.
3. **PATH.** It is set to `/home/steven/.foundry/bin:/usr/bin:/bin`, with assertions that `command -v forge` is the pinned forge (`4f77da08…`, 1.7.1 `4072e487`) and that anvil is the pinned one (`10c1c727…`). These are the binaries the rigs use for their runtime forge builds and chains.

**Unchanged:**
- **The finite selection:** not ok, AND statically reaching the derived missing set (= `map/r12-missing.txt`, MockFeed), AND that ENOENT in the actual receipt;
- **The copy, identity and bytecode gates**, the offline build of the one missing source, and the reruns of only unclean pairs with r12's command and counts;
- **The amended table:** every r12 row is carried through to `RESULTS-AMENDED.tsv`;
- **The exit codes:**

  | Exit | Meaning |
  |---|---|
  | 0 | all ok |
  | 3 | impacted rows fixed, others remain (not a pass) |
  | 1 | a rerun failed |
  | 20 | setup/HOLD |

  Exit 0 is impossible while r12's other `[FAIL]` lines exist.

## Expected impacted rows (from the actual receipts; MockFeed ENOENT)

| Row | Trees | Tests |
|---|---|---|
| lease-relay-host-policy | leaseRelay + final | 9 |
| cli-combined-independent | ownercli + final | 4 |
| cli-independent-sessions | ownercli + final | 13 |
| offchain-heartbeat-writers | ownercli + final | 3, now with the base supervisor |

The selector derives these itself. This list is only what the receipts imply.

**Not selected:**
- the `windows-lease-runtime-fixture` rows: the lease-fixture job 29692 covers them;
- `rpcs` and G5: the enrollment and provider stages cover them;
- the browser tests that deliberately fork public Base inside the offline namespace. These stay **unqualified**: they must later run against our own historical backend. Nothing about them is changed or waived.

## Root (after r12 finishes)

```
./jobs/q-exit-status.sh r12-impacted-rerun-r2 2560 unshare -rn bash rig-artifact-closure-stage/r2/jobs/root-r12-impacted-rerun.sh
```

Outputs go to `rig-artifact-closure-stage/r2/run/<UTC>/`.

## Not established

- **Unrun.** In particular, whether the base supervisor at the copy root resolves its sibling imports against the candidate's modules is what the test's design implies; it has not been run.
- **The late rows' format** is taken from r12's source lines, not yet observed in this run.
