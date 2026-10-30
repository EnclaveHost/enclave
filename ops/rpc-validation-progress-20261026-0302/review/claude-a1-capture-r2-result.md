# A1 capture binding r2: result (PREPARED; source only; nothing run; NOT enabled)

**What Claude did:** reads, writes and static checks only (`bash -n`, Python `ast.parse`, `node --check` on the two changed stubs).
- **Runtime identities:** observed by hashing the files and querying the pacman database and `readelf`. No node or python program was run for them.
- **Not done:** no tests, builds, queue jobs, network or SSH access, live actions or commits.
- **Untested:** the r2 tests have never run.

**Untouched (checked):**
- the frozen `a1-capture-binding-stage` (`SHA256SUMS` `0a5c0bd1…` still verifies);
- its run log `logs/root-capture-tests-20261026T023019Z-595581`;
- root's `logs/root-a1-capture-0232.*` (25 ran, 24 PASS, 1 ERROR).

**HOLD flags are still False:** `FINALITY_PROOF_REVIEWED` and `LAUNCH_PRODUCER_REVIEWED` (launcher r3), and `FINALITY_PROTOTYPE_REVIEWED` (the prototype and its r2).

**No malicious-root resistance is claimed.**

## Manifest: `a1-capture-binding-stage/r2/` (`SHA256SUMS` sha256 `100eb666ea019d0c85172f546f22bc20698e4edbcd86b5c148b9c71267618979`, 23 files)

| File | sha256 |
|---|---|
| `src/a1_capture.py` | `2352df7b27c39299011038bab9aace681756c2eaef5cf216c665d82f9149d277` |
| `tests/test_a1_capture.py` (exactly 36 tests) | `2f5c65d66b4f27464bf676ab4c6055d4ef49c7ff72e77f2f5986d1800c9954fc` |
| `jobs/root-capture-tests.sh` | `4eec905288edf4230989b00904c40dc49736b4bbff61c08fc14ce61aaa5842a2` |
| `R2-CHANGES.md` (change note and **8505 interface**) | `f7804e113e50f6d070810f6cd002a9f4b310bfa647039d97e4f91137b734d2ba` |
| `tests/stubs/initial/a1-read.mjs`, `tests/stubs/recheck/a1-recheck-read.mjs` (changed stubs) | `2494b7bf…`, `ff26ca36…` |
| `README.md` (r1 text, unchanged; superseded by R2-CHANGES where they differ), `a1gate/*` (pins unchanged), other stubs | in `SHA256SUMS` |

## Changes, by root's review points

1. **Fixture defect (root ERROR), fixed without relaxing the verifier.**
   - The test recomputed the "reviewed" pins from swapped sources; the verifier correctly refused with `code_pin`.
   - r2 freezes the pins at capture time and verifies against them.
   - The test now also asserts that pins taken from the swapped sources are **refused**.
2. **Runtime identity.** Recording at capture time is no longer treated as pinning. There is now an **accepted-runtime policy**, enforced at capture and at verify:

   | Runtime | sha256 |
   |---|---|
   | node `/usr/bin/node` | `7af789e5…` (nodejs-lts-jod 22.23.3-2) |
   | Python executable `/usr/bin/python3.14` | `375532f8…` |
   | the libpython actually **mapped** into the running interpreter (`libpython3.14.so.1.0`) | `0a5be42f…` (python 3.14.8-1) |

   - The Python executable is 14 KB and links libpython, so it alone does not identify the interpreter.
   - **Provenance, marked in source:** *operator-observed 2026-10-25 (sha256 of the file; pacman owner); NOT upstream-verified; pending root review*.
   - **Shared libraries are NOT pinned** (node's libuv, OpenSSL, ICU and others; Python's stdlib and extension modules), so this is not a pinned runtime.
   - **How node runs:** the verifier's gate runs node only from an fd it hashed and accepted (`/proc/self/fd`, the `l1_authority` technique). The capture runs only its private 0500 copy.
   - **Refusal tests:**
     - an unaccepted node or interpreter refuses before anything executes;
     - `verify` refuses a capture whose runtime is no longer accepted;
     - the gate refuses an unaccepted node;
     - the production policy contains this host's observed runtimes, each carrying the provenance marking.

     If root's host differs, that test FAILS, by intent.
3. **fsync audit.** r1 fsynced its own files, but set their modes after the fsync. It did **not** fsync the child-written `evidence.json`, `a1.stderr` and `helios.out` before hashing them into the durable `result.json`. r2 adds:
   - `write_new`: content, then `fchmod`, then `fsync`;
   - `seal`: `fchmod` + `fsync` of each child-written file **before** hashing;
   - directory fsyncs: OUT's parent after the exclusive `mkdir`, OUT after the stage `mkdir`, the stage after `capture.json`, every directory bottom-up before publication, and OUT after the single publishing rename.

   **Crash semantics (honest):**
   - Before the rename is durable, OUT holds only `.partial-<pid>`, and that **never verifies** (tested).
   - A failure after execution is published with its error and never verifies (tested).
   - OUT is never reused, so a new capture needs a new OUT.
   - Actual durability across power loss relies on POSIX/ext4 fsync/rename semantics. It was **not** tested by crash injection.
4. **Rechecking a NEWLY captured initial: `recheck-capture OUT INITIAL_OUT`.** Mode `recheck` (the one pinned initial `b9a90847…`) is preserved unchanged.
   - **No config-supplied receipt hash.** At capture, the initial capture is **verified** by this module: it must be clean, `initial` mode and pass the pinned gate. Its evidence is copied, and the original game/N/root come from its **gate-normalized** receipt.
   - **At verify, the consumer must pass `INITIAL_OUT` and the expected initial `capture.json` sha256 from its own reviewed record.** The verifier then:
     - re-verifies the initial;
     - requires `expected == initial's capture sha == the recheck's recorded binding`;
     - requires that the evidence read equals the initial's evidence, with the same originals;
     - requires that the initial finished before the recheck started;
     - finally runs the pinned original-game-recheck gate with that initial's sha.
   - **Tests:**
     - binding to the consumer's reviewed capture;
     - refusals without, or with a wrong, expected sha;
     - refusal for another genuine initial capture;
     - refusal for an initial tampered after the recheck;
     - only a clean **initial** capture can be rechecked (a recheck capture, an unclean initial, or none all refuse);
     - the real gate refuses a recheck against another initial sha.

## Interface for 8505 (report-only coordination; nothing here calls it)

- **Producer side:** when A2 accepts an initial capture, store `verify()['captureSha256']` and its `outPath` in the **reviewed** record (for example the launch record's `a1` binding). Never derive them from a recheck or from config.
- **Consumer side:**
  1. call `verify(RECHECK_OUT, initial_out=<recorded outPath>, expected_initial_capture_sha256=<recorded sha>)`;
  2. call `admit(summary, ledger)` against a durable ledger;
  3. apply freshness (for example `a1MaxAgeSec`) to `finishedAt` and to the gate's L1 age.
- **Returned fields:** `captureId`, `captureSha256`, `mode`, `evidenceSha256`, `startedAt`, `finishedAt`, `node`, `python`, `runtimePolicy`, `boundInputs`, `gate`, and `initialCapture` (recheck-capture).
- **Runtime changes:** root must review the accepted-runtime entries. A node or python upgrade **requires** a reviewed policy change, otherwise captures refuse.

## Root command (local, offline, exact)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r2
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```

- **PASS requires all of:**
  - `SHA256SUMS` verifies before and after;
  - no network route;
  - exactly `Ran 36 tests` + final `OK`, **no skips**, rc 0;
  - the three HOLD flags False;
  - `## capture rc=0`.
- **Anything else fails,** including a timeout or an unknown exit. Queue exit 98 means the job did not start.
- **Disk:** `TMPDIR` is placed on disk, since each capture copies the 56 MB node binary.

## Limits and missing steps

1. **Unrun.** First-run risks sit in the new real paths:
   - `/proc/self/maps` libpython detection under `unshare -rn`;
   - `run_node_fd` exec through `/proc/self/fd` with `pass_fds`;
   - the recursive verify inside `recheck-capture`;
   - `fchmod`/`fsync` on read-only descriptors.
2. **Trust and coverage limits:**
   - root and the host are trusted to run this honestly;
   - runtime acceptance covers executable images only;
   - configs and the checkpoint are bound and validated, but not reviewed constants;
   - the dependency digests are observations of the installed tree.
3. **Not integrated.** No harness, producer or prototype consumes `verify`/`admit`. R-A's source changes belong to 8505 and root, and its unwind/rebuild downtime is unmeasured.
4. **No capture has run,** so no fresh newer A1 receipt has been captured here. Whether a newer finalized game exists is **not** asserted: root's 21:53Z recheck recorded only an observation (`accepted: false`).
