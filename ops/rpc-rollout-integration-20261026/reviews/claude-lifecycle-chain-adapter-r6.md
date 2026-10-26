# lifecycle-chain-adapter-stage/r6: r5 + local-anvil polling fix + exact KVM runtime-lock closure + per-suite session cleanup

**Status: PREPARED, NOT TESTED.**
- I ran no tests, build, queue, network, live action or commit. The only checks were `node --check`, `bash -n`, JSON writes and git-blob checks.
- There is no production claim.
- **Stage:** `lifecycle-chain-adapter-stage/r6/`. **SHA256SUMS sha256 `39a80c03a406f6a20dbb749afc67808cae80b3fefa7419e04ad3d72e0ab0d969`** (30 files, read-only).
- r1–r5 are unmodified and re-verified.
- The r6 adapter, all four test files and the doubles are **byte-identical to r5**. Only the fixture client line and the job change, plus the added closure file.

## Root 1386 (r5) result this builds on (preserved in place; sha256 index in `r6/PRIOR-EVIDENCE.txt`)

Run: `r5/logs/run-20261026T144333Z-1917184`.

| suite | result | cause |
|---|---|---|
| r5-abi | **5/5 PASS** | |
| r5-policy | 6 PASS + 1 **cancelled** | The file hit `--test-timeout` 600 s, so F5–F7 never ran. viem's default 4000 ms receipt polling meets anvil's asynchronous sealing (`logs/claude-lifecycle-test-latency.md`). |
| r5-proof | **10/10 PASS**, 0 skipped | The exact receipt/transaction proof ran green on real anvil blocks. That is preserved, not re-claimed. |
| kvm-host-admission | 26 PASS + 1 file failure (`ERR_MODULE_NOT_FOUND network/runtime-lock.mjs`, imported by `deployment-journal-owner.mjs`), so only 27 of 35 reported | missing closure file |
| runtime-expiry | **7/7 PASS** | |

## Changes (diffs: `patches/r5-to-r6-fixture.diff`, `patches/r5-to-r6-job.diff`)

1. **Fixture:** in `test/fixtures/r5-world.mjs`, the local-anvil public client gets `pollingInterval: 25`.
   - A receipt missed by viem's single immediate check now waits 25 ms instead of 4000 ms.
   - Nothing else changes: no assertion, authority double, freshness gate, adapter code or timeout.
2. **Exact KVM closure:** `closure-b7dcf5af9/network/runtime-lock.mjs` is taken from `git show b7dcf5af9:network/runtime-lock.mjs` (blob `76b1e636…`, sha256 `256aeca3…`).
   - The job pins it, re-compares it with the KVM commit, and adds it without overwriting anything.
   - It uses `/usr/bin/flock`, which the job checks exists.
   - **Audit:** I computed the full relative-import closure of every composed suite plus the adapter at b7dcf5af9 (31 modules). `runtime-lock.mjs` was the **only** file missing from the r5 tree. Its own imports are Node built-ins only.
   - Its blob is identical at 34a3c0d6.
3. **Strong cleanup, own children only:**
   - Each suite runs under `setsid`, in its own session, and the job waits on it. Session id = the suite's pid, kept through `exec timeout … node`.
   - When a suite ends (pass, fail or timeout), any process still in that session is recorded in `cleanup.txt` with `pgrep -a -s`. It is then sent TERM, and KILL after 5 s. This catches, for example, an anvil whose `test.after` never ran (r5 left PID 1917493).
   - On **any** job exit (EXIT trap; TERM, INT and HUP map to exit), every not-yet-reaped session is reaped the same way.
   - A reaped session id is removed from the list, so no pid-reuse signalling can occur.
   - Only sessions the job created are touched.

**Unchanged:**
- **Counts:** abi 5, policy 9, proof 10, kvm-host-admission 35, runtime-expiry 7, total 66.
- **Timeouts:** `timeout -k 10 1200` per suite, `--test-timeout=600000`.
- **Composition and verification:** source-r1 → runtime-expiry-r1 → the exact `host-admission.patch` → byte-equality with the delivered files and `git show b7dcf5af9` for all 8 changed files → the 34a3 closure (git ls-tree) → the KVM-commit closure → r6 files. All pins: dependencies-r1, R4-BLOBS, closure stage, node_modules, anvil.

## Root job (prepared; foreground, offline, 1536 MiB)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
jobs/q-exit-status.sh root-lifecycle-chain-adapter-r6-1 1536 unshare -Urn bash lifecycle-chain-adapter-stage/r6/jobs/root-chain-adapter-r6-tests.sh
```

- PASS requires every suite at its exact count with fail/cancelled/skipped/todo all 0 and rc 0.
- Outputs go to `r6/logs/run-*`: per-suite TAP, `summary.txt`, `RESULT` and `cleanup.txt` (present only if leftovers were reaped).

**Expectation, not a claim:**
- With 25 ms polling, each lost receipt race costs ≤ 25 ms, so the policy file should fit well inside 600 s.
- With `runtime-lock.mjs` present, the boundary file should load, and KVM's suite should report all 35.
- Whether both actually pass is decided only by root's terminal run.

**Still outstanding** (unchanged; see `logs/claude-lifecycle-chain-adapter-r5.md`):
- the integration blockers: proof-qualified authority, Base raw-transaction/receipt and header sources, post-migration pins, ProofOfTime variant, custody variant, `hostOwnership` governance, host-policy store, the production `hostAdmissionRefusal(version, version)` bug, KVM's own stop-relay and boundary-qualification gaps, fee cap and relay, and live/SNP evidence;
- the orphan anvil 1917493 from r5, which root is checking.
