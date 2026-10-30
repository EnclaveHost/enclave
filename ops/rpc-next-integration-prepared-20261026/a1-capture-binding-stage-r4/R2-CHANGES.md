# a1-capture-binding-stage/r2 (PREPARED; source only; NOT run; NOT enabled)

`README.md` in this directory is r1's text, copied unchanged; where they differ, this file supersedes it (r2: 36 tests, the runtime
policy, durability, `recheck-capture`).

The original stage is **FROZEN**: `SHA256SUMS` `0a5c0bd1…`, and its run log `logs/root-capture-tests-20261026T023019Z-595581` and
root's `logs/root-a1-capture-0232.*` (25 ran, 24 PASS, 1 ERROR) are untouched.

## 1. The fixture defect, fixed (the verifier is NOT relaxed)

`test_source_swap_after_hashing_executes_only_the_bound_copy` called `verify` with pins **recomputed from the swapped
sources**. The verifier correctly refused with `code_pin`.

r2 freezes the reviewed pins at capture time (`Case.reviewed`), and `verify` uses those. The test now also asserts that pins
taken from the swapped sources **are refused**.

## 2. Accepted-runtime policy

The node that executes and the interpreter running the capture (its executable **and** the libpython mapped into the
process) must be among these entries, at capture **and** at verify:

| Runtime | File | sha256 | Package |
|---|---|---|---|
| node | `/usr/bin/node` | `7af789e5…` | nodejs-lts-jod 22.23.3-2 |
| Python | `/usr/bin/python3.14` | `375532f8…` | python 3.14.8-1 |
| libpython | `libpython3.14.so.1.0` | `0a5be42f…` | python 3.14.8-1 |

- **Provenance, marked in source:** *operator-observed 2026-10-25 (sha256 of the file; pacman owner); NOT upstream-verified;
  pending root review*.
- **Not pinned:** shared libraries (node's libuv, OpenSSL, ICU and others; Python's stdlib and extension modules). This is
  **not** a pinned runtime.
- **Node execution:** the verifier's gate runs node only from an fd whose bytes it hashed and accepted
  (`/proc/self/fd`, the `l1_authority` technique). The capture runs only its private 0500 copy.

## 3. Durability (audited, made explicit)

r1 wrote its own files with fsync. But it only `chmod`+hashed the child-written `evidence.json`, `a1.stderr` and
`helios.out`, and it set file modes after their fsync.

r2 does the following:
- `write_new`: content, `fchmod`, `fsync`.
- `seal`: child-written files get `fchmod` + `fsync` **before** they are hashed into `result.json`.
- Directories are fsynced:
  - OUT's parent after the exclusive `mkdir`;
  - OUT after the stage `mkdir`;
  - the stage after `capture.json`;
  - every directory bottom-up before publication;
  - OUT after the single publishing rename.

**Crash semantics (honest):**
- Until the rename is durable, OUT holds only `.partial-<pid>`, which never verifies.
- A crashed OUT is never reused (exclusive `mkdir`), so a new capture needs a new OUT.
- These properties are assumed from POSIX/ext4 semantics; they were **not** tested by crash injection.

## 4. `recheck-capture`: rechecking a NEWLY captured initial receipt

**Mode `recheck`** is unchanged: it uses the one pinned initial receipt `b9a90847…`.

**New mode `recheck-capture OUT INITIAL_OUT`** behaves as follows:
- **At capture:** it verifies `INITIAL_OUT` with this module (mode `initial`, clean, pinned gate), then copies its evidence.
  The original game, N and root come from the initial's **gate-normalized** receipt, never from config. It records
  `initialCapture {outPath, captureId, captureSha256, evidenceSha256, original}`.
- **At verify,** the **consumer** must pass `INITIAL_OUT` and the expected initial `capture.json` sha256 **from its own
  reviewed record**. The verifier:
  - re-verifies the initial capture;
  - requires `expected == the initial's capture sha == the recheck's recorded binding`;
  - requires that the evidence the recheck read is exactly the initial's evidence;
  - requires the same original values;
  - requires that the initial finished before the recheck started.
- **Gate:** finally, the pinned gate's original-game-recheck mode runs with that initial's sha.

## 5. Interface for 8505 (integration; nothing here calls it)

- **Producer side:** after A2 accepts an initial capture, record its `capture.json` sha256 (`verify()['captureSha256']`) and
  its `outPath` in the reviewed record (for example the launch record's `a1` binding). Never take that value from a recheck
  or from config.
- **Consumer side:**
  - call `verify(RECHECK_OUT, initial_out=<recorded outPath>, expected_initial_capture_sha256=<recorded sha>)`;
  - then call `admit(summary, ledger)` against a durable ledger;
  - apply the freshness policy (for example the harness's `a1MaxAgeSec`) to `summary['finishedAt']` and to the gate's L1
    age.
- **Return fields:** `captureId`, `captureSha256`, `mode`, `evidenceSha256`, `startedAt`, `finishedAt`, `node`, `python`,
  `runtimePolicy`, `boundInputs`, `gate`, and `initialCapture` (recheck-capture).

## Limits

- **Trust:** root and the host are trusted to run this honestly; there is **no** malicious-root resistance.
- **Unproven:** no capture has run, and these tests have never run.
- **No anchor claim:** whether a newer finalized anchor game exists is **not** asserted.
- **HOLD flags:** all stay False.

## Root command

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r2
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-capture-tests.guard -- unshare -rn bash $ST/jobs/root-capture-tests.sh > $ST/logs/root-capture-tests.out 2>&1; echo $? > $ST/logs/root-capture-tests.rc
```

A pass requires exactly `Ran 36 tests` + `OK`, no skips, rc 0, and `## capture rc=0`.
