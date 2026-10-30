# A1 capture binding and prototype r2: result (PREPARED; source only; nothing run; nothing enabled)

**What Claude did:** reads, writes and static checks only: `bash -n`, Python `ast.parse` and `node --check`. No tests, builds, queue jobs, network or SSH access, live actions or commits.

One read-only computation imported `src/a1_capture.py`, whose module level only defines constants, to recompute the dependency digests with its own `read_package`/`tree_rows`. No capture ran.

**The tests have never been executed.** Root's run is the first evidence.

**Untouched:**
- the frozen `base-finality-proof-stage` (`SHA256SUMS` `e21761c2…`) and `restart-review` (`b451861f…`), both of which still verify;
- root's run `logs/root-finality-prototype-0211.*` (JS 20/20 PASS, Python 26/27 FAIL) and its run directory;
- launcher r3, the harness and M10 (read only).

**HOLD flags are still False:** `FINALITY_PROOF_REVIEWED` and `LAUNCH_PRODUCER_REVIEWED` (launcher r3), and `FINALITY_PROTOTYPE_REVIEWED` (the prototype and r2).

**R-A** is prepared only as a conservative recovery path. Its unwind/rebuild downtime is **unmeasured** and acknowledged; it is **not enabled**.

## 1. `a1-capture-binding-stage/` (`SHA256SUMS` sha256 `0a5c0bd1788cf2b761dc6f2803df5451b0c8df95a9a066cf248029a91d7196aa`, 22 files)

| File | sha256 |
|---|---|
| `src/a1_capture.py` (runner + verifier + replay ledger) | `f1c9ca5cb5e54653ef93c50600eb6ae86d2439cecf739c30fcfbcb4949b3b6b5` |
| `tests/test_a1_capture.py` (25 tests) | `5a14d524d15ed60e74417e4ac600f313573a57ef9dbd8b0f8cb72e3970fdedf6` |
| `jobs/root-capture-tests.sh` | `549eced34c20de0e3bad3c8f710ce6778fa81837e0d626f4a03448be022dbccf` |
| `README.md` | `5d6013d0a30640cb8bb4836e1c52666d4be53ffc8cf8ce33f9b6c1b5bc5b66da` |
| `a1gate/` (byte-identical pins) | `06cc2961…`, `f591f324…`, `ec92b70f…` |
| `tests/stubs/` (15 files) | listed in `SHA256SUMS` |

**Reused unchanged.** There is no new authority and no new verification logic.
- **A1 modules,** at their published pins:
  - initial: `a1-read.mjs` `a501a3ec…`, `a1-anchor.mjs` `ec92b70f…`, `vendor/anchor-bootstrap.mjs` `90a8afba…`, `test/deps.mjs` `b7b08e8e…`;
  - recheck: those plus `a1-recheck-read.mjs` `41b83975…` and `a1-recheck.mjs` `f591f324…`.
- **`l1_authority.py`** `f4a5160b…`. It already execs Helios `cc962e2b…` from the hashed file descriptor, so that step had no swap gap.
- **The pinned A1 gate.**
- **Config derivation:** identical to `run.py` and `run-recheck.py`. Original-game recheck keeps the pinned initial `b9a90847…` and the original game/N/root.

**Capture-time binding (restart-review §4, gaps G1–G7):**
- **Exclusive output:** an exclusive `mkdir OUT`; everything is built in `OUT/.partial-<pid>` and published by a rename to `OUT/capture`.
- **One read, then copies:** every input is read once and hashed in memory. Code is compared with the reviewed pins, then written as 0400 `O_EXCL` copies:
  - the modules, `l1_authority.py` and the node binary;
  - `package-lock.json` (`9ada1611…`) and the 13-package closure of `@noble/hashes` and `viem`, each checked by version and content digest;
  - the l1-authority config **plus its checkpoint**, `portal-result.json`, and the A1 template or the initial receipt.
- **Derived configs:** produced from the copies only (the l1-authority config changes only `checkpointFile`, asserted).
- **Record first:** `capture.json` (`O_EXCL`, fsync) is written **before** execution. It holds the random capture id, every file's sha/size/source/role, the exact argv and env, the Python interpreter's sha and version, and `outPath`.
- **Only copies execute:** Helios goes through the copied launcher, and A1 through the copied node, modules and dependency root. All copies are re-hashed before exec and after the run.
- **Exclusive results:** evidence, stderr, the Helios log and `result.json` (which binds the sha of `capture.json`) are all `O_EXCL`.

**`verify OUT`** refuses anything but a clean, in-place binding. It checks:
1. ownership, symlinks, writability and the exact file set;
2. that `result.json` binds `capture.json`, and that every copy re-hashes;
3. the code and dependency pins, with no unpinned package;
4. a clean run, with a pinned, fresh-finalized Helios;
5. the evidence, stderr and log shas;
6. the re-derivation of both configs;
7. the exact argv and env, and `outPath`;
8. the receipt time inside the capture window;
9. the **pinned gate** (fresh-initial, or original-game-recheck).

`admit()` is the consumer's replay ledger: a capture id, evidence or record is admitted at most once.

**Tests (25; prepared, NOT run):**
- **Captures run for real** (real processes, the real node, real exclusive files) over stubs pinned to their actual bytes:
  - **binding and preservation:** initial and recheck capture, bind and verify, and original-game recheck behaviour is preserved;
  - **refusals at capture:** an existing `OUT` is never reused; an unreviewed module refuses before anything executes;
  - **swaps and tampering:** a source swapped after hashing still runs only the copy; a copy changed before exec fails the run;
  - **wrong sources:** a wrong portal source (another ASR, a failed read); a recheck against another initial receipt; another Helios pin; dependency content or version drift;
  - **unclean runs:** a non-zero exit is published but never verifies; a non-fresh Helios; a receipt outside the window.
- **Post-capture tampering is refused:** copies, bound inputs, the evidence, the record, extra, missing, symlinked or writable files, a partial leftover, a moved capture, and code or dependency pins other than the reviewed ones.
- **Replay** is refused by the ledger.
- **Production and real-receipt checks:**
  - the production pins equal the real reviewed sources (modules, launcher, template, initial receipt, lock, all 13 dependency digests, gate);
  - the **real pinned gate** accepts root's real `live-1958` and `recheck-retry-2152` receipts;
  - the gate refuses them once a `reads` label is changed to `plain-rpc`. Both replaced tokens were confirmed to lie inside `reads`.

**Root command (local, offline):**
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```
- **PASS requires:** `SHA256SUMS` verifies before and after; no network route; exactly `Ran 25 tests` + `OK`, no skips, rc 0; all three HOLD flags False; `## capture rc=0`.
- **Anything else fails,** including a timeout or an unknown exit. Queue exit 98 means the job did not start.
- **Disk:** `TMPDIR` is placed on disk because each capture copies the 56 MB node binary.

## 2. `base-finality-proof-stage/r2/` (`SHA256SUMS` sha256 `5f14e2c02656a0bb14128e623e96f751f427893429fe3874648a3f5c70a7b5e0`, 13 files)

- **Fixture fix only:**
  - `make_a1` now gives each fixture run its own valid identity (`startedAt = at - (60 + seq)` s), so the `not_newer` branch is reached by a distinct run;
  - the product's replay check is **unchanged**; it was correct in root's run;
  - `tests/test_finality_state.py` is now `36b4ad20…`.
- **Runner paths:** `jobs/root-finality-tests.sh` (`05fef695…`) now points at r2.
- **Everything else** is byte-identical to the frozen stage, including the core `686cbc22…` and the tool `cc337417…`.
- **Change note:** `R2-CHANGES.md` (`ad09c6a7…`) gives the change and the root command. A pass requires JS 20/20 and Python `Ran 27 tests` + `OK`.

## 3. Limits and missing steps (exact)

1. **Untested.** Both suites are unrun.
   - **Capture suite:** most first-run risk is in the real subprocess and timing paths (the stub launcher, `killpg`, and node exec from a private copy under `unshare -rn`).
   - **Real-gate tests:** these assume the pinned gate's normalized `N`/`mode` fields, as the harness uses them.
2. **Trust model.** Root and the host are trusted to run this runner, and there is no attestation, so a malicious root could forge records.
   - **Not pinned:** node's shared libraries, and the Helios `dataDir`/`homeDir`.
   - **Recorded but not pinned:** the Python interpreter.
   - **Bound and validated, not pinned:** the configs and the checkpoint. A consumer must choose which config hashes it accepts.
3. **Dependency digests** are observations of the installed tree at `source/node_modules` (→ `work/enclave/node_modules`) on 2026-10-25, consistent with the pinned lock versions. They are not a review of upstream package contents.
4. **Not integrated.** No consumer uses `verify()`/`admit()` yet. The R-A source changes in the harness N bound and `gate_download`, the producer A1 pin and the launch-record predecessor fields belong to 8505 and root. Integrated restart qualification **does not exist**.
5. **No capture has run,** so no fresh newer A1 receipt has been captured here. **Whether a newer finalized anchor game exists is not asserted.** Root's 2026-10-25T21:53Z recheck recorded only a latest-anchor *observation* (game `0x27d5e3b9…`, N 52,869,960, `accepted: false`).
6. **The prototype in r2 still qualifies only the same running process.** It is not restart qualification (`restart-review/DESIGN.md`).
