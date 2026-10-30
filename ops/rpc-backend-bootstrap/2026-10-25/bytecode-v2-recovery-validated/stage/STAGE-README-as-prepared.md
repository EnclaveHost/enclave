# Bytecode checker v2: memory recovery (PREPARED; not built, not run)

## The failure (original stage `../bytecode-v2-validation`, kept untouched; pins in `evidence/ORIGINAL-PINS.txt`)

**What happened** in root's 1792 MiB run (`logs/root-bytecode-v2-native-2249.*`):
- the test binary compiled (`29df9018…`) and **20 of 23 tests printed `ok`**;
- then the **kernel cgroup OOM** hit `run-p49545-i37834870.scope` at 22:51:55Z (1.7G peak);
- queue `EXIT -15`, outer rc 143;
- **no guard receipt, no aggregate result, no controls run.** **It is not a pass.**

**Cause: test fixture only.**
- `make_db` used `DatabaseArguments::default()`: 8 TB max and a **4 GiB growth step**. Every fixture `mdbx.dat` is
  therefore a 4 GiB sparse file: the original's `build/tmp/.../v2bytes/db/mdbx.dat` is **4294967296 bytes** (72
  blocks allocated).
- `v2_scan_leaves_every_byte_of_mdbx_dat_unchanged` does `std::fs::read` of it twice, which is 2 × 4 GiB of heap.
- **The product scanner never reads the file into memory:** it opens MDBX read-only.

## The fix (`crate/src/tests.rs` `f1bd5c1c…` = `jobs/make-tests-fix.py` applied to the original `072a23a8`)

**Fixture changes:**
- `fixture_args()` = `DatabaseArguments::default().with_geometry_max_size(Some(64 MiB)).with_growth_step(Some(4 MiB))`,
  using the pinned reth-db `7134be3` API. It is used for fixture creation and for the read-write reopen in the mutation
  test.
- `assert_bounded()`: every fixture `mdbx.dat` must be `> 0` and `≤ 64 MiB`. It is asserted in `make_db_with`, after the
  mutation reopen, and in the byte test before reading. The byte test also asserts that the whole file was read.

**Kept:** all 23 tests and every original assertion, **including the full byte-for-byte `before == after` comparison**.
No skip, no new dependency, no lock change.

**Unchanged and byte-identical to the original:** `lib.rs` `ed9870e7`, `main.rs` `05dd717e`, `Cargo.toml` `e398c4f9`, the
control script, the closure manifest, the lock helpers and the artifact helper. The precheck verifies each by `cmp` and
by pin.

## Resume job (`jobs/root-build-test-recovery.sh` `24bc6d5a…` = `jobs/make-recovery-job.py`(original job `7c95ec5b`))

**3 counted insertions; everything else is byte-identical to the original job:**
1. `jobs/recovery-precheck.sh` `4adf225b`, read-only. It refuses unless:
   - the original stage sums (`051e8fcc`), the failure receipt (`2a5aca4e`, rc 143, `29df9018`, `EXIT -15`, no
     aggregate), the absence of a guard receipt, and the original 20-ok log (`ea787c2b`) are all as pinned;
   - the 4294967296-byte fixture evidence and the journal oom-kill line are present;
   - the original job has ended;
   - the product, inputs and helpers are identical, and both derivations check;
   - the recovery `build/` is new.
2. **A COPY of the ended original target** (`cp -a --reflink=auto`, read-only source) becomes the NEW recovery target, to
   reuse dependencies. The member lives in a NEW fresh tree (`git archive 5476069f` + the copied member), so its test
   binary must still be **REBUILT** (fresh=false), and every control is rebuilt and must differ.
   - **Reuse is best-effort only:** build scripts may re-run because the cargo home is a fresh verified copy at a new
     path. Correctness does not depend on reuse.
3. A label on the patched step.

**Kept from the original job:**
- **Build:** a fresh private cargo home copy with closure verification; the lock pin plus the single inserted entry;
  the `cargo tree` closure check; one compiler job; offline.
- **Pass criteria:** **all 23 named tests `ok` with `test result: ok. 23 passed; 0 failed`**, and **17 controls each
  failing exactly their expected set** (rc 101, binary ≠ patched, `lib.rs` restored and sha-checked).

## Memory audit of the other tests (static)

- **Whole-file reads:** only the byte test reads whole files. It is now ≤ 2 × 64 MiB; the expected fixture size is a
  few MiB, and it is asserted ≤ 64 MiB.
- **Other MDBX fixtures** (about 14 `make_db` DBs): MDBX is mmapped, not read into the heap. Each had been a 4 GiB
  sparse file plus an 8 TB map reservation, and is now bounded at 64 MiB.
- **`pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails`:** 1500 codes of ≤ 300 bytes. This is CPU-bound
  with tiny allocations.
- **Concurrency:** `--test-threads=2` (unchanged) means at most two fixtures at once.
- **Cap:** the job keeps the same **1792 MiB** cap. The host floor is unchanged.

## Root command (foreground, same cap as the original)

```sh
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-v2-recovery
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1792 --log $S/logs/root-build-test.guard -- unshare -rn bash $S/jobs/root-build-test-recovery.sh > $S/logs/root-build-test.out 2>&1; echo $? > $S/logs/root-build-test.rc
```

**Outcomes:**
- **Pass:** only `## aggregate rc=0`.
- **98:** not started.
- **Any refusal or OOM:** stop and review. Do not enlarge the cap.

## Not established / risks

- **Nothing compiled or run.** Static checks only: both derivations re-checked, `bash -n` passes, and 23 `#[test]`
  remain.
- **Untested risk:** the product scan opens the fixture read-only with its default arguments (8 TB/4 GiB) against a DB
  created with the 64 MiB geometry. MDBX is expected to adopt the file's geometry read-only. If it does not, the tests
  FAIL visibly; a pass cannot result from it.
- **Not run:** whether the fixture change alters any control outcome. The expected sets are unchanged.
- **Release prep (50cf):** it was based on the old stage pins. `tests.rs`, the stage sums and the job differ here, and a
  release binary built from this tree path may embed different paths. 50cf's stage was **not** edited; it must update
  its pins after root's receipt.
