# 1867: the smallest executable path to run the r11 state helper on the recovered composite MDBX (SOURCE-ONLY PLAN; no runtime action authorized)

**Scope (what I read):**
- `composite-mdbx-validation-stage/r10` (`memory_gate.py`, `jobs/root-composite-validate.sh`) and `r6/composite_session.py`;
- `multipart-validation-view-stage/r6` (README; SUMS);
- `base-state-readonly-stage/r11`;
- `source/ops/rpc-recovery-qualification-20261026/canonical-state-input-inventory-1859/*`;
- the pinned reth 7134be3 `db/src/mdbx.rs`.

**What I did not do:** no mount, namespace, queue, test, build, network, install, VM, data/part/backup content read, commit or source implementation. Frozen stages are untouched. The queued r11 ns-test is untouched.

**What this plan is not:**
- **Not canonical proof.** A helper result is **self-consistency of the DB against its own header**, not canonical-chain proof.
- **Not a recovery acceptance.** The original reset still needs an actual acceptance.
- The paused fetch (122,742,112,256 bytes) is not touched by anything here.

## 1. What already exists, and the one gap
| need | existing qualified component (cite) | reuse as-is? |
|---|---|---|
| A single read-only logical `mdbx.dat` over the 265 parts | `multipart-validation-view-stage/r6` (SUMS sha `18bab7be…`), see notes | yes |
| Exposure + lifecycle | `composite-mdbx-validation-stage/r6/composite_session.py` (`407aa7e9…`), see notes | yes, except the validator argv |
| Memory, resources and evidence | `composite-mdbx-validation-stage/r10/memory_gate.py` (`d5abdd20…`, SUMS sha `e39bc67d…`), see notes | yes, except it execs **its own** runtime (`memory_gate.py:47` `THIS = realpath(__file__)`) |
| Helper binaries | `base-state-readonly-stage/r11` (SUMS `246ff06b…`), see notes | yes, after build + fixtures |
| Static headers | the verified compact backup, see notes | **needs one bounded extraction** (§3) |

**The multipart view:** `view_descriptor.py` (`23370c97…`) builds a VMDK FLAT descriptor, and `production_import.py` (`4d48f74e…`) provides:
- `load_view(production)` and `recheck`: every part's dev/ino/size/mtime/ctime against the r3 commit records, with all 265 CONFIRMED;
- `check-held`: QEMU holds exactly those inodes, `O_RDONLY`.

**The exposure and lifecycle (`composite_session.py`):**
- pinned `qemu-nbd --read-only` + `nbdfuse -r -o ro` → `<work>/db/mdbx.dat` (`:287-308`). It checks: ST_RDONLY, only `mdbx.dat`, the logical size, and that an `O_WRONLY` open is refused;
- `check-held` before the exec (`:334`); the exec in its own group with `CHILD_FSIZE`; timeout → group stop, orphan reap (`:345-365`);
- the post-use `held`/recheck (`:371`);
- ordered cleanup of ONLY our mount and children (`:455-456`);
- the receipt.

**What `memory_gate.py` adds:**
- `gate`:
  - 4096 MiB `memory.max` + MemoryHigh 3712 MiB on our own scope;
  - MemAvailable ≥ 16 GiB + 4096 + 256 MiB;
  - root free ≥ remaining + 40 GiB + 8 GiB native + the 208 MiB output budget;
  - /vm free ≥ remaining + 40 GiB;
  - the production view check;
  - the r4/r6/r7 qualification pins.
- `runtime`: replaces `C.Session` and `C.classify` (`:454-480`). It adds the tree-RSS (3840 MiB) / MemAvailable soft stop and the oom-counter downgrade.
- **The job (`jobs/root-composite-validate.sh`):** r6 `guards`, the live-gate guard, the before/after evidence (`collect-evidence.sh`), `ulimit -f`, `timeout -s TERM -k 600`, and `final-status.sh`.

**The helper binaries:** `base-state-readonly` + `mk_fixture`. They are used in place on /vm after `bsro_gate.py verify-binaries` (a verified r11 build receipt names the dir; the binaries hash as recorded).

**The static headers:** the verified compact backup `…/2026-10-26/my/work/tr004/preserved-images/base-origin.compact.qcow2`:
- 120,867,323,904 B, sha256 `a3b00e5f…`;
- root-reconciled 376-entry inventories (`compact-backup-reconciliation.json` sha `8db4b41b…`);
- **0 rocksdb entries**;
- it holds the 6 header files + `reth.toml`.

**The gap:** no production path runs the state helper. In r6 the production validator argv is hard-pinned to `mdbx_check.py` + `mdbx_chk` (`composite_session.py:341-343`), and `--fixture-exec` is fixture-only and refused by the r10 runtime (`memory_gate.py:460-462`).

## 2. The smallest new source: a new composite revision (r11), NOT a new framework
**A. `state_gate.py`:** `memory_gate.py` r10 copied, with only these deltas.
- **Argument and pin deltas:**
  - **(a)** new pins: the r11 stage SUMS (`246ff06b…`); its PASSED guard-tests / ns-tests receipts; the verified build receipt; the passed **positive 26/26** and **fixtures 6/6** receipts (all bound to those SUMS and to the binary sha256s); and the header-extraction receipt (§3);
  - **(b)** new args: `--helper-dir` (the verified /vm build out dir) and `--static-files` (the §3 dir).
- **Session subclass delta (c):** the runtime installs a Session subclass whose `use()` only sets the exec argv. The r6 `use()` machinery is reused verbatim: check-held, exec, own group, timeout, orphan reap, post-use held/recheck. The argv:
  ```
  <helper-dir>/base-state-readonly --db <work>/db --static-files <SF> --rocksdb <run_dir>/rocksdb-absent --out <run_dir>/state-report.json --plain-hashed
  ```
  - `<run_dir>/rocksdb-absent` is verified **absent** before the exec and after it. **CURRENT is never created**; the helper's ABSENT classification then requires the 3 index checkpoints to be present and 0, else it refuses.
  - `--plain-hashed` yields `NOT_APPLICABLE_V2` on v2; it is kept so the report records the plain entry counts.
  - **Implementation detail:** the simplest route sets the r6 exec slot internally rather than editing r6. It must be **recorded in the receipt as `stateHelperExec`**, never as a fixture exec. The reviewer decides between that and a small override of `use()`.
- **(d) `state_classify` replaces `classify`.** The helper rc and the r6 lifecycle codes collide (r6: 3 REFUSED, 4 CLEANUP-INCOMPLETE, 5 CANCELLED), so the helper outcome gets **distinct job codes**:

  | helper rc | condition | job rc | outcome |
  |---|---|---|---|
  | 3 | — | 30 | STATE-REFUSED |
  | 4 | — | 34 | STATE-FAILED |
  | 5 | report checks pass (see below) | 35 | STATE-PARTIAL-V2 |
  | 5 | any report check fails | 7 | INCONCLUSIVE |
  | 0 | — | 7 | INCONCLUSIVE (unexpected for v2; needs review) |
  | anything else (1 eyre, 101 panic, signal, timeout, truncated or unparseable report) | — | 7 | INCONCLUSIVE |

  The report checks for rc 5: a regular `state-report.json` ≤ 16 MiB, format `base-state-readonly/r11`, v2, `fullStateIntegrity:false`, the RocksDB classification `ABSENT…`, `finishFrontier:"none"`, `rocksdbOpened:false`, and the post-use recheck OK.

  **Other codes:**
  - The r6 lifecycle codes stay for lifecycle failures.
  - The oom-counter downgrade applies to 35 as well (→ 7).
  - `final-status.sh` keeps a nonzero rc. **Only 35 is a usable outcome, and it still means self-consistency only.**

**B. `jobs/root-state-validate.sh`:** `root-composite-validate.sh` r10 with labels, the extra args, and the state receipt checks. It keeps:
- the same guards and before/after evidence;
- `ulimit -f` (gate/runtime 32 MiB; children 16 MiB; job files 1 MiB; 208 MiB budget);
- `MAX_HOURS` 1..168, with `timeout -s TERM -k 600 (H*3600+1800)`;
- the stop helper.

**C. Tests:** r10's 16 with the stage label, plus:
- the state argv;
- rocksdb-absent before/after;
- each `state_classify` row (stub exec, test-only);
- the refusal of a missing or mismatched r11 receipt.

**The run itself** (only after everything in §5):
```
bash jobs/q-exit-status.sh cmv-r11-state 4096 bash composite-mdbx-validation-stage/r11/jobs/root-state-validate.sh VIEW_DIR MAX_HOURS HELPER_DIR STATIC_DIR
```

## 3. Header input: one bounded, reviewed extraction from the compact backup to /vm (NOT run now; no 136 GB copy)
**The files** (from the reconciled inventory; 362,898,295 B total ≈ 346 MiB):

| file | bytes |
|---|---|
| `static_file_headers_52500000_52999999` | 318,751,407 |
| `static_file_headers_52500000_52999999.conf` | 75 |
| `static_file_headers_52500000_52999999.off` | 12,000,009 |
| `static_file_headers_53000000_53499999` | 30,982,072 |
| `static_file_headers_53000000_53499999.conf` | 75 |
| `static_file_headers_53000000_53499999.off` | 1,164,657 |
| `data/reth.toml` | 2,590 (kept for later CLI use; not needed by the helper) |

**The two segments have different jobs:**
- the 53000000 segment holds the Finish header (block 53048526 is expected; Finish is not yet read);
- the 52500000 segment holds the A1 anchor block 52866960, needed for the later G8 chain only.

**The job:**
- **Map the backup read-only:** the same pinned `qemu-nbd --read-only` + `nbdfuse -r` pattern as r6, on the compact qcow2.
- **Copy out the files:** `debugfs` without `-w` (read-only), as in root's 1502 metadata job `jobs/root-base-deleted-metadata-1502.py`. **I did not re-read that job here.**
- **Destination:** a NEW 0700 dir on **/vm** under the guard. It is bounded by its file count, by exact expected sizes (`ulimit -f` ≥ the largest file), and by `/vm free ≥ remaining + 40 GiB + 346 MiB` checked before the copy.
- **Receipt:** size equality with the inventory, plus a sha256 of each file. Then the files are made 0444 and the dir 0555.
- **Cleanup:** only our nbdfuse/qemu-nbd.

**Optional:** a BLAKE3 check against the pinned manifest's header chunk outputs, if the manifest lists them (`offline-b3sum-bundle-stage`). That proves only "same as the snapshot publisher's files", not canonical.

**Unknowns:**
- whether ext4 starts at offset 0 in the compact image (1502 used the original's mapping);
- the exact debugfs path syntax for this image;
- whether a backup view already exists. **Do not touch** the peer's `base-backup-view`.

## 4. Inputs, provenance and evidence for the state run
- **Inputs bound by sha or identity:**
  - the view dir (r6 `load_view(production)`, all 265 CONFIRMED, manifest sha);
  - the helper binary + build receipt + passed fixture receipts (r11 SUMS);
  - the extraction receipt (6 sha256s + inventory sha `df104422…`);
  - the gate pins as in r10.
- **Read-only open:**
  - MDBX: `open_db_read_only` → `DatabaseEnvKind::RO` (`reth db/src/mdbx.rs:140-147`). **No `database.version` check** (FUSE `db/` holds only `mdbx.dat`). The FUSE mount is ST_RDONLY and an `O_WRONLY` open is refused.
  - Static files: `StaticFileProviderBuilder::read_only` (1695).
- **Before/after evidence:**
  - parts: r6 recheck (identities incl. ctime) + check-held before the exec and post-use;
  - static files: (dev, ino, size, mtime, **ctime**, sha256) before and after, which **detects** a write (it does not prevent one);
  - `rocksdb-absent` absent before and after;
  - mounts and processes left: r10's `collect-evidence.sh after`.
- **Memory:** the 4096 MiB exclusive main lane, MemoryHigh 3712, soft stop 3840 MiB tree VmRSS / MemAvailable < 16.5 GiB, the 16 GiB host floor.
  - **I do not promise a full hashed-state + Verifier scan fits.** mmap'd file pages count in VmRSS and the r4 mechanism measured only `mdbx_chk` on 8 GiB.
  - A soft stop is CANCELLED (5); an oom counter change → INCONCLUSIVE.
- **Disk:** root free ≥ remaining + 40 GiB + 8 GiB native + 208 MiB; /vm ≥ remaining + 40 GiB. Both are checked by the gate at run time; the §3 files then sit on /vm.

## 5. Order (each step needs its own reviewed, actual PASS)
1. All 265 parts preserved and CONFIRMED.
2. r11 guard-tests (10+6+16) and ns-tests (5) actual PASS.
3. r11 preflight/build on 4096; the verified build receipt.
4. r11 `positive.sh` 26/26 and `fixtures.sh` 6/6 actual PASS.
5. cmv-r10 tests: **status not verified by me** (r9 15/15 PASS is recorded).
6. The new composite r11 source + review + tests PASS.
7. The §3 extraction.
8. **Optionally first:** the r10 structural `mdbx_chk` run.
9. The state run.

## 6. After a 35 (STATE-PARTIAL-V2): exactly what G8 still needs (no redesign)
- **(i)** Authenticate header **52866960** from the extracted 52500000 segment against A1 receipt `b9a90847…` (outputRoot `0xa996c517…`) with the pinned `authenticateAnchor` (`anchor-bootstrap.mjs` `90a8afba…`; withdrawalsRoot = message-passer root).
- **(ii)** A parentHash chain from Finish back to 52866960 over the two extracted segments. That proves **ancestry only**.
- **(iii) THE MISSING INPUT:** an A1-authenticated output root for some L2 block **M ≥ Finish (53048526 expected)**, plus headers (Finish, M]. They are authenticated only by M's header reproducing that output root and the parentHash chain down to Finish (headers beyond Finish are not in the snapshot), or an L1 derivation of Finish.
  - Fresh network/anchor reads are already user-authorized and need only the resource gates.
  - Only (i)+(ii)+(iii) together, plus the helper's 35, support "this DB state is canonical Base state at Finish".

## 7. Unknowns (called out, not filled)
- **The real `Finish` / `Metadata` / index checkpoints / progress are unread.** Expected per `config_gen.rs`: the 3 index checkpoints = 0 → ABSENT. Otherwise the helper refuses (30).
- **No fixture covers static files that start at 52.5M** with only header segments (fixtures start at 0). A failure there is a refusal (30, "tip header … missing"); this needs a compiled fixture or acceptance of the risk.
- **MDBX RO without `mdbx.lck` on the FUSE mount:** the fixtures cover a ro bind without lck (`positive.sh:29`; `mk_fixture.rs` removes `mdbx.lck`), not FUSE. The r6/r10 `mdbx_chk` path uses the same FUSE exposure.
- **Runtime duration and memory** of a full scan over FUSE→nbd→VMDK; `MAX_HOURS` is root's choice.
- **The §3 tooling details;** the cmv-r10 test status; whether the manifest carries per-file blake3 for header outputs.
- **The paused-fetch location** is not identified here. Nothing in this plan writes near it, and the reservations must not count it as free.
