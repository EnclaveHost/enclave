# 1707: recovery-overlay-stage/r8, a separately authorized DIAGNOSTIC read-only exposure (FROZEN, NOT run)

**Status:** source frozen, NOT run.
- **Stage:** `recovery-overlay-stage/r8/`, **`SHA256SUMS` sha256 `6fcb7a6d0004a5a6a5eefaf61855dd948485b7b0b51890ceeada796f9642f007`** (15 files, read-only).
- **Preserved:** r1 through r7 all re-verify.
- **Executed by me:** reading receipts, logs and sources; text edits; `ast.parse`; `bash -n`; `sha256sum`.
- **Not done by me:** builds, tests, mounts, NBD/FUSE, USB, live actions, or reads of the original.
- **Claims:** **no data-integrity, recovery, history or acceptance claim.** This is not a GO receipt.

## Inputs read
| input | what it shows |
|---|---|
| root 1704 | r7 tests **20 PASS** (`peersUnchanged`, `noMountsLeft`, clean; peak tree RSS 167 MiB) |
| root 1706 | r7 offline plan PASS: `plan.json` **`c4e38213…`**, 30 patches, 119,040 bytes, 9001 extents |
| root 1698 | `postdelete-bitmap-stage/r2/runs/check-20261026T211719Z-2363068/result.json` **`25abe05e…`** = **BLOCKED**: the last live old-generation image is at 17169 and the new generation at 17170, with no committed intermediate unlinked/freed row |
| review 1701 | a valid coalesced unlink + free + inode reuse in one JBD2 transaction is possible; the checker model change belongs to root 37's separate work |
| MDBX validator r4 | stage `82394b02…`; root 1685 **20 PASS**; `mdbx_chk` `c228b462…` (libmdbx v0.13.12 `f619d43d`), `mk_fixture` `ca8d4192…`, wrapper `mdbx_check.py` `f0d27e40…` |

## What r8 adds (runtime preserved)
- **Byte-identical to r7:** `overlay_session.py` (`fe0bb752…`), `overlay_plan.py` (`78e573f6…`), `tests/test_recovery_overlay.py` (20), `fixture/make_fixture.py`, `fixture/make_jbd2_inputs.py`.
- **`jobs/root-expose-real.sh`, the strict acceptance GO path, is unchanged:** it is exactly r7's with only the stage path and label substituted, and test D10 enforces this.

**New files:**
| file | sha256 | role |
|---|---|---|
| `diagnostic_request.py` | `83f2f107…` | the diagnostic authorization (below) |
| `diag/run_validator.py` | `9633779c…` | the **only** `--exec`: copies the pinned `mdbx_check.py` into the run dir, verifies the copy, execs it on `dirname(RECOVERY_TARGET)` (the read-only `/data/db` view); timeout 60..84600 s |
| `jobs/root-diagnostic-expose.sh` | `338aa366…` | the diagnostic job |
| `fixture/make_mdbx_fixture.py` | `7989597f…` | a REAL MDBX DB (pinned `mk_fixture`) in ext4 with `mdbx.lck`; delete `mdbx.dat`; reuse its inode; `parent-mdbx.qcow2` |
| `tests/test_diagnostic.py` | `5c297d04…` | 13 tests |
| `jobs/common.sh` | `742712a6…` | + MDBX pins and `mdbx_guards` |
| `jobs/tests.sh` | `68cad488…` | runs **both** suites, each gated separately |
| `README.md` | `428a3ebb…` | |

### The diagnostic authorization (`recovery-overlay-diagnostic-request/v1`)
The request has **exact keys**, and it is refused unless all of the following hold:
- `purpose` is exactly `full-readonly-mdbx-validation`;
- **`recoveryAccepted` is JSON `false`** and **`productionUse` is JSON `false`**; `true`, `"false"`, `0`, `null` and `[]` are all refused;
- `planSha256` and `journalSha256` equal the job's pins;
- `history` names the pinned path and sha. The file is **re-hashed**, its own `verdict` is **re-read**, and it must be **"BLOCKED"** and equal the request's. **A PASSED history is refused here:** acceptance goes through the strict GO path, never a diagnostic one;
- `validator` equals the pinned `mdbx_chk` and wrapper;
- the request file's own sha256 equals the one root passes;
- `requestedBy` is 1..64 characters and `note` is ≤ 1000.

**A GO file is never a diagnostic request,** and the GO rule (`check_go`, the same meaning as the r7 inline check) refuses a diagnostic request (test D10).

### The job (`root-diagnostic-expose.sh REQUEST REQUEST_SHA256 [VALIDATOR_TIMEOUT]`)
**Checks before anything starts:**
- the r7 guards: stage SUMS, the checker, the pinned `fuse2fs`/qemu/`nbdfuse`, FUSE, no bytecode, never root;
- the MDBX r4 stage SUMS and the `mdbx_chk`/wrapper pins;
- the pinned plan `c4e38213…` and `cmp` of `overlay_plan.py` against r7;
- **the original's mount is `ro`** and the original is not writable;
- the request is authorized.

**Then the r7 session runs unchanged:**
- `--require-ro-mount` (`ST_RDONLY` before and after);
- the hard **64 MiB** overlay with **`RLIMIT_FSIZE`** on every child;
- the parent identity re-checked;
- the read-only `qemu-nbd -r` / `nbdfuse -r -C 1` / `fuse2fs ro,norecovery` chain, plus write-refusal checks;
- process groups, the subreaper, `PDEATHSIG`, signal cleanup;
- `--exec-timeout 86400` and the job's `timeout -k 300 90000`;
- the peer snapshot before and after.

**Output:** `diagnostic-summary.json` with `kind: "DIAGNOSTIC"`, `recoveryAccepted: false`, `productionUse: false`, the BLOCKED history, the session rc, cleanup and parent results, the MDBX report fields, and **"meaning"**: `structurallyClean=true` means only that the pinned `mdbx_chk` found no structural problem in the read-only view. The history stays BLOCKED, and value bytes, chain state and recovery are **not** established.

**rc:**

| rc | meaning |
|---|---|
| 0 | `mdbx_chk` structurally clean (**DIAGNOSTIC ONLY**) |
| 6 | validator not clean, timed out or refused |
| 1 | a view check failed |
| 3 | refused |
| 4 | cleanup or peer problem: STOP |
| 5 | interrupted (e.g. by the memory guard) |

### Tests (`jobs/tests.sh`: both suites mandatory, 20 + 13)
| test | covers |
|---|---|
| D1 | a bound request authorizes a diagnostic view only (`recoveryAccepted` false, label) |
| D2/D3 | `recoveryAccepted`/`productionUse` must be exactly JSON false |
| D4 | exact purpose/format |
| D5 | exact keys |
| D6 | plan/journal binding (in the request and in the pins) |
| D7 | a wrong history path; a request verdict of PASS; a **PASSED** history file (refused, since that is the GO path); the history file changed after pinning |
| D8 | validator pins |
| D9 | the request's own sha |
| D10 | GO and diagnostic are mutually exclusive, and the GO job is r7's exactly |
| E1 | the REAL MDBX fixture, restored and judged structurally clean by the **pinned** `mdbx_chk` through the real wrapper on the read-only `fuse2fs` view: session rc 0, report rc 0, `targetExact`, identity unchanged, cleanup complete, parent unchanged |
| E2 | a non-MDBX target is not clean (rc 6) |
| E3 | a tampered validator wrapper is refused (rc 6, no report) |

## Root commands
**1. Tests** (queue 512):
```
bash jobs/q-exit-status.sh rov-r8-tests 512 bash recovery-overlay-stage/r8/jobs/tests.sh
```
Expect `## PASS (20 + 13)`.

**2. The request**, written by root (fill `requestedBy` and `note`; keep everything else exactly as below), then its sha256:
```json
{"format": "recovery-overlay-diagnostic-request/v1", "purpose": "full-readonly-mdbx-validation",
 "recoveryAccepted": false, "productionUse": false,
 "planSha256": "c4e38213847793d5c0868825fe454c5702b4499a6b25315078037b073a4f35a9",
 "journalSha256": "d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073",
 "history": {"path": "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/postdelete-bitmap-stage/r2/runs/check-20261026T211719Z-2363068/result.json",
             "sha256": "25abe05e6eb9e7bc7183552ad22bf7a466e080ed69437b33e0630f01d11196a7", "verdict": "BLOCKED"},
 "validator": {"chkSha256": "c228b462c3c71c87b0fd2e9cfa6b3e6bccb2d793dd545bc6a18bef7113187981",
               "wrapperSha256": "f0d27e40c29271b94d2b48b9d4ab70a84de1f946709db4e9361cdfba00bac131"},
 "requestedBy": "root", "note": "diagnostic read-only MDBX structure check while the post-deletion history is BLOCKED; no acceptance"}
```

**3. A bounded PROBE first** (recommended; not the full scan). 30 minutes:
```
bash jobs/q-exit-status.sh rov-r8-diag-probe 4096 bash recovery-overlay-stage/r8/jobs/root-diagnostic-expose.sh /ABS/request.json <REQ_SHA256> 1800
```
**What the probe shows:**
- the real view opens (libmdbx without-lck on the read-only `fuse2fs` mount);
- the memory guard's tree RSS under the `mdbx_chk` mmap;
- the throughput: watch `read_bytes` in the session's `qemu-nbd` `/proc/PID/io` (the PID is in the run's `receipt.json` `children`).

**The expected result is `timedOut` → rc 6** (not clean, diagnostic incomplete), with cleanup complete.

**4. The FULL diagnostic validation** (only after the probe; 23.5 h validator deadline):
```
bash jobs/q-exit-status.sh rov-r8-diag 4096 bash recovery-overlay-stage/r8/jobs/root-diagnostic-expose.sh /ABS/request.json <REQ_SHA256> 84600
```

## Resource estimate (unmeasured; the probe is the measurement)
**Data:**
- **The file:** `mdbx.dat` logical size 1,138,166,333,440 B. Mapped data is 1,134,426,345,472 B (276,959,557 blocks); the 3.74 GB sparse tail reads as holes with no I/O.
- **What `mdbx_chk` reads:** it traverses every used B-tree page (the validator README estimates about 1.13 TB), single-threaded.
- **The read path:** USB NTFS (`ntfs-3g`) → qcow2 (`qemu-nbd`; decompression if the clusters are compressed) → `nbdfuse` → `fuse2fs` → page cache → `mdbx_chk` mmap. That is three FUSE layers.

**Time:**

| case | throughput | full read |
|---|---|---|
| sequential best case | 100–200 MB/s | **1.6–3.2 h** |
| B-tree order is not physical order (mostly scattered 4 KiB reads) | 5–30 MB/s | **10–63 h** |

**The session's hard exec cap is 24 h** (86400 s), and the validator's is 84,600 s. A slow scan therefore ends as `timedOut` (rc 6, incomplete, cleanup complete). The wrapper allows 7 days, but the r7/r8 session does not; extending that would need a reviewed r9.

**Memory:**
- **Anonymous:** the `mdbx_chk` pagemap, about **556 MB** (int16 × 277.87 M pages); `fuse2fs` cache 64 MiB; `qemu-nbd`/`nbdfuse`/Python at tens of MB.
- **The mmap of the 1.13 TB file is file-backed and reclaimable,** but it **counts in the guard's VmRSS sum**. The cgroup `MemoryMax` (the lane cap) forces reclaim, so the RSS should stay below the cap.
- **Lane:** use the **4096 MiB** lane (the queue maximum), which gives about 3.4 GiB of headroom above the anonymous total. 2560 is the minimum. Admission needs host `MemAvailable` ≥ **16384 + 4096 + 256 = 20,736 MiB** (root 1704 saw about 24.2 GiB).
- **If the guard stops the job** (RSS > cap, or host < 16 GiB): rc 5, cleanup complete, diagnostic incomplete.

**Disk:**
- the overlay ≤ 64 MiB (2–5 MiB expected);
- each child's files ≤ 64 MiB (`RLIMIT_FSIZE`);
- `mdbx_chk` output capped at 16 MiB;
- **no copy** of the 1.14 TB file.

**CPU:** `mdbx_chk` uses one core; `qemu-nbd` uses one core if decompressing.

## Candid limits
- **Not run.** E1 is the first execution of the full chain with a real MDBX DB on the `fuse2fs` view. libmdbx's without-lck path on a read-only FUSE mount is expected (the wrapper's design), but not yet observed here.
- **Stale directory entries:** the restored **old** `/data/db` directory block may name other entries (e.g. `mdbx.lck`) whose inodes are **current**, possibly reused by unrelated files. The view is read-only, so anything libmdbx does with them can only produce an error (rc 3, not clean), never a write. The real `mdbx.lck` situation is unknown until the probe.
- **A clean result proves only structure:** `structurallyClean` checks B-tree structure only. MDBX has no page checksums, so data bytes inside valid pages are not checked.
- **What the BLOCKED history leaves open:** intra-transaction reuse at 17170 and cross-commit reuse remain **unexcluded** for this diagnostic. A clean structure can coexist with overwritten value bytes.
- **Not established:** chain/state/trie verification, `static_files` and production acceptance.
- **The 24 h cap** may stop a slow scan.
- **The guard's VmRSS accounting of mmap pages** is a stop risk, measured by the probe.
- **Throughput figures are estimates only.**
- **Root's request and approval are required:** nothing here creates a request or approves a run. The strict GO path stays closed until a history PASS exists.
