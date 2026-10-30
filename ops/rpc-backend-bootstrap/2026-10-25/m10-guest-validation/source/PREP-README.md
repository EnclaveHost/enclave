# M10 tests: fresh Ubuntu-native run on the private RPC guest (PREPARED; nothing built, transferred or run)

**Purpose:** run the M10 native tests in a FRESH Ubuntu build on the RPC guest. The guest has about 53.9 GiB available
and 27 GiB of free OS disk.
- **No host target is reused** (a fresh Ubuntu ABI); same pinned sources, toolchain, crate cache, phases and negative
  controls.
- **Not done:** no SSH, transfer, compile, test or queue action. The 6144 host proposal stays a prepared, untested
  fallback.

**What this proves and does not:**
- **Proves:** a pass is a test result for these pinned sources on the guest.
- **Does not prove:** it is **not** a reproducible-binary claim. Ubuntu GCC 13/clang 18 and OpenSSL 3.0 differ from
  the host's GCC 16/clang 22/OpenSSL 3.6, and the paths differ.

## Files (this directory)

| file | sha256 | role |
|---|---|---|
| `build-stage.sh` | `67923e13…` | HOST: assembles the stage from frozen inputs (read-only on them) plus MANIFEST |
| `make-guest-runner.py` | `3e8a0b75…` | derives the runner from the pinned job `root-test-m10.sh` `51ffbda2` |
| `runner/m10-guest-test.sh` | `6b72c8f9…` | the guest job (generated; see below) |
| `runner/guest-env.sh` | `fd0669c1…` | guest paths; the same build settings as host `env.sh` |
| `runner/verify-deps.py` | `7d4394a9…` | offline check of every locked dependency (crate sha == lock checksum; git commit present in a staged bare db) **plus `git fsck --full --strict` of every staged bare db**; any git command error is a failure |
| `runner/disk-guard.py` | `40e6d0cc…` | own process group only: missing path → 2 before any child; below floor → 97; SIGTERM/SIGINT → stops the group, 143/130; child exit → leftover group members stopped, child rc returned; stop = SIGTERM, 5 s, SIGKILL; deletes nothing |
| `test-disk-guard.py` | `d1871300…` | 9 tiny isolated cases: pin, missing path, floor at start, child rc 0/7, SIGTERM and SIGINT with grandchild, early exit with leftover grandchild, floor during run (fixture clone), unrelated process survives. PREPARED, NOT RUN |
| `runner/verify-stage.sh` | `d0ed4b17…` | GUEST preflight: refuses unless everything is exact and present |
| `runner/run-guest.sh` | `b67fcec1…` | GUEST launcher: one attempt, systemd unit, guards, receipt |
| `runner/memory-guard.mjs` (copied by the builder) | `cdd00af7…` | root's existing general guard, unchanged |

## The guest job (`runner/m10-guest-test.sh`)

**Generated** from the pinned original by 6 counted substitutions in step 0 only.

**From `phase()` onward it is byte-identical to the original:**
- every phase: engine (152), node `actors::engine::`, sequencer, SafeDB, derivation, CLI `node::`;
- the filters, `--test-threads=2`, every named M10 test;
- the **exact negative-control failure sets**;
- per-package `cargo clean -p` and **fresh=false**;
- the control != patched checks.

**Step 0 keeps the original FRESH semantics:** `[ ! -e $B ]`, a new tree, a new control, the 3-line control diff, and
a new private cargo home. It differs as follows:

| original | guest |
|---|---|
| `git -C $BASE_REPO archive 5476069f` | `tar -x` of the staged tar, whose sha `a92160eb` must match (the same git archive, pinned) |
| `cp` of the host M7 cargo home | `cp` of the staged cache, then **`verify-deps.py`**: every locked package present and checksummed, offline |
| `env.sh` (host paths, rustup) | `guest-env.sh`: guest paths; `PATH` = the staged toolchain first. It checks `rustc 1.96.0 (ac68faa20 …)`, `cargo 1.96.0 (30a34c682 …)`, that both are resolved from the stage, and `CARGO_BUILD_JOBS=1` + `RUSTFLAGS='-C link-arg=-Wl,--threads=1'` (one compiler and linker; debug 0, incremental 0, as on the host) |
| logs in `$M/logs` | logs in `$RUN/logs` (the stage stays read-only) |

**rc:** the job's `## aggregate rc` is its exit code. The launcher additionally requires **0 ignored** across all
`test result:` lines. That check is outside the job, so the job's semantics are unchanged.

## Stage (built on the host by `build-stage.sh OUT`; about 1.8 GB)

**Layout:**
- `inputs/base-l1-verify.patch` (M7, `e9dfb8c6`);
- `m10-bootstrap-anchor.patch` (+ `.sha256`, `0a10cf86`);
- `control/disable-anchor-checks.py` (`8c1b882f`);
- `jobs/{artifact.py, root-test-m10.sh, env.sh}` (all from the frozen pins `ead48b1d`);
- `src/base-5476069f….tar` (66 MB);
- `cargo-home/registry/{cache,index}` and `cargo-home/git/db` (bare repositories) ONLY (about 0.8 GB);
- `toolchain/rust-1.96.0` (615 MB, the official dist);
- `runner/`.

**Excluded:**
- `registry/src`: cargo re-extracts it from the checksummed `.crate` archives, which is stronger than trusting
  extracted trees;
- **`git/checkouts`**: cargo rebuilds checkouts offline from the pinned commits in the bare dbs. Every bare db must
  pass `git fsck --full --strict`, and every locked commit must exist in one; a mutable checkout is never trusted;
- cargo's `.global-cache` and `.package-cache`;
- any cargo config or credentials (the builder refuses if present);
- any host target.

**The builder refuses** any key or credential-like file name anywhere in the stage. There is no exception, and no
checkouts are staged.

**`MANIFEST.sha256`** covers every file. **`MANIFEST.symlinks`** lists every symlink. **`MANIFEST.json`** records:
- the pins and toolchain versions;
- the derived Cargo.lock sha;
- the offline dependency verification, including fsck results;
- a refs hash for every git db.

Any git error while building the manifest aborts the builder.

## Native build requirements (from the M10 host target's actual build scripts; read-only)

**Observed C/C++ builds:**
- aws-lc-sys, blst, bzip2-sys, c-kzg, lz4-sys, reth-mdbx-sys, ring, secp256k1-sys, zstd-sys (vendored, static);
- librocksdb-sys (static rocksdb + snappy, links `stdc++`, uses **bindgen → libclang**);
- libz-sys (one static and one system `z` build);
- **openssl-sys (system OpenSSL via pkg-config)**;
- **libgit2-sys (system libgit2 on the host)**.

**Toolchain linker:** rust-lld, self-contained in the staged toolchain, driven by `cc`.

**Ubuntu packages for root to install (apt, separately):**
- `build-essential` (gcc, g++, make, libc6-dev), `clang`, `libclang-dev`;
- `pkg-config`, `cmake`, `libssl-dev`;
- **not** `zlib1g-dev`: installing it would upgrade the guest's running zlib. The pinned libz-sys build script falls back to its
  vendored zlib, built from the checksummed crate. Preflight therefore requires the openssl pkg-config module, and
  only REPORTS whether zlib is present.
- `git` (for `git apply`), `python3` (≥ 3.11), `nodejs` (the memory guard).

**Environment differences to record, not hide:**
- **OpenSSL:** on the host, openssl-sys enabled `ossl300`…`ossl350` cfgs (OpenSSL 3.6). On the guest, 3.0.13 enables
  only up to `ossl300`.
- **libgit2:** Ubuntu's libgit2 is older than libgit2-sys 0.18.5 accepts for system use, so it is expected (not
  verified) to build its **vendored** copy. Don't install `libgit2-dev`; preflight reports which applies.
- **Compilers:** the C compiler and libclang versions differ from the host's.

## Can root match the absolute host paths?

**Not needed, and not recommended.** The M10 job applies no path remapping, and its result is test outcomes, not
binary bytes. So a NEW private guest path keeps provenance explicit, and every build is fresh:
- `/srv/m10-guest-validation/stage`: root-owned, read-only to the build user;
- `/srv/m10-guest-validation/runs/run-<N>`: owned by `m10build`;
- `/srv/m10-guest-validation/receipts`: root-owned.

## Installation and execution plan (root; guest steps need root's reviewed access)

1. **Host:** `bash build-stage.sh /path/NEW-stage-dir`. It prints `MANIFEST.sha256 <sha>`; keep that value.
   - Optionally create a tarball: `tar -C /path/NEW-stage-dir -cf m10-stage.tar .` and record its sha256.
2. **Guest:** install the apt packages above.
   - Create the user: `useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin m10build`.
   - `install -d -m 0755 /srv/m10-guest-validation`.
   - Transfer and extract the stage to `/srv/m10-guest-validation/stage`, root-owned, modes preserved. Delete the tar
     afterwards to keep the disk headroom.
3. **Guest:** `bash /srv/m10-guest-validation/stage/runner/run-guest.sh 1 <MANIFEST sha>`. This is one foreground
   attempt. The launcher:
   - refuses existing run or receipt names;
   - runs `verify-stage.sh` and refuses if anything fails:
     - every file and symlink equals the MANIFEST, with no extra file;
     - the staged rustc/cargo run and are 1.96.0;
     - all the tools above are present, along with libclang and the openssl pkg-config module (zlib: info only);
     - the user exists and cannot write the stage;
     - disk ≥ 22528 MiB free (the 8192 floor + 14336 estimate);
     - MemAvailable ≥ 28672 MiB (the 16384 floor + 12288 cap);
   - then runs the job as `m10build` in a transient systemd unit:
     - `MemoryMax=12G`, `MemorySwapMax=0`, `CPUQuota=200%`, `Nice=10`;
     - `PrivateNetwork=yes` (offline), `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`,
       `NoNewPrivileges=yes`;
     - writable only in `runs/run-<N>`;
     - **`RuntimeMaxSec=3h`, `TimeoutStartSec=3h`, `KillMode=control-group`, `TimeoutStopSec=30`**, so a cancel or timeout
       leaves nothing detached;
   - wraps the job in the copied memory guard (tree 12288 MiB, guest floor 16384 MiB) and the disk guard (root-disk
     floor 8192 MiB). Each stops **only** its own tree or unit, never the RPC services; partial build and logs are kept;
   - writes `receipts/run-<N>.{out,rc,receipt.json,preflight.out}` with the real `systemd-run --wait` exit code, the unit
     result, the guard lines, the aggregate line and the ignored total. `pass` = rc 0 AND `## aggregate rc=0` AND 0
     ignored.
4. **NOT implemented here; root's OUTER launcher handles it:** the host 16 GiB floor guard watching the VM, and cleanup
   after an SSH disconnect (for example, stopping unit `m10-guest-validation-<N>`).

**Outcomes:**
- **97:** the disk floor was hit.
- **99:** the memory guard stopped the job.
- **1:** a check or test failed.
- **2:** refused before start.
- Any other non-zero value is the job's own failure.

**Never** re-run into an existing run directory; use the next N.

## Not established

- **Not executed:** nothing here has been run: not the builder, the preflight, the launcher or the job. Only syntax
  checks (`bash -n`, `py_compile`) and the deterministic runner generation were done.
- **Not compiled:** whether the Ubuntu toolchain packages compile every native crate is unknown until the run.
- **Disk:** the 14 GiB build-size figure is an estimate. Host M10 used 3.5 GB of target before its node build stopped.
- **Memory:** whether 12 GiB is enough is unknown. The host node build exceeded 4262 MiB, and its peak was never
  observed.
