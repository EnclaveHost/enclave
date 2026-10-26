# Witness: placement r2 FROZEN + new producer r3 (output bound) FROZEN; both unqualified (source only; nothing run) - 2026-10-26

**Status:**
- **Preserved:** r1 is preserved (`1efa5c85…`). Placement r2 is still unfrozen. Its transport patch exists: tree `58c9b92e`, `patches/` in `witness-producer-service-stage/r2/`.
- **Tools:** stage files are written with the Write/Edit tools only.
- **Not done:** no install, enable, VM, network, test, build or USB action. **Nothing is claimed frozen without actual hashes.**

## Root 1589 (output bound): confirmed in source, and the upstream fetcher's files inspected first
- **r1 gap, confirmed:**
  - `run_fetch` uses `prlimit --as --cpu` only, and the size check runs only after exit;
  - stderr goes to an unbounded `stderr.txt` in the work dir.
- **Upstream fetcher file behaviour** (`base/crates/proof/zk/witness/src/fetcher.rs`, the build copy of combined-r1):
  - `HostConfig { …, data_dir: None }` (l.870), so there is **no on-disk key-value store** in this crate (no rocksdb/disk KV/tempdir in `src/`);
  - `fetch_and_save_rollup_config` writes `<l2_config_dir>/<l2_chain_id>.json` (l.390-398);
  - `fetch_and_save_l1_config` writes `<l1_config_dir>/<l1_chain_id>.json` (l.415-462);
  - with `l*_config_dir: None` and no `L1_CONFIG_DIR`/`L2_CONFIG_DIR` (the producer passes only `PATH`), these resolve to **`configs/L1`, `configs/L2` relative to the cwd** (l.91-104), i.e. the per-run work dir. They are small (pretty-printed configs, KB);
  - `witness_fetch.rs` writes `<out>.partial` (the whole JSON), then renames it.
- **A second r1 defect found the same way:** r1's cleanup removes only `witness.json`, `.partial` and `stderr.txt`. The `configs/` tree makes its `rmdir` fail, so **the run directory leaks**.
- **The choice:** `prlimit --fsize=<request cap>` is usable, because the only large file is the output and the config files are KB, far below any MiB cap.
  - **What it does:** RLIMIT_FSIZE is **per file, for every file the child writes**. A write past the cap fails (EFBIG), or kills a non-Python child with SIGXFSZ (`--core=0`, so no core file).
  - **Disk bound per run:** output ≤ cap, plus 2 config files < cap. stderr no longer touches disk.
  - **If a future fetcher wrote many or large temp files,** per-file limits would not suffice; a size-limited private tmpfs or quota would be needed. Not the case for the pinned source.

## Plan
1. **Finish placement r2,** independent of r3 so integration 50 can merge it once it's hashed. Files per `logs/claude-witness-placement-r2.md`:
   - forward `.socket`/`.service`;
   - `tests/test_forward_chain.py`, which uses the **frozen r1 producer** by path (no copy);
   - `jobs/tests.sh`, `README.md`;
   - then `SHA256SUMS` if hashing is allowed, otherwise root hashes.
2. **New `witness-producer-service-stage/r3`** (producer correction; r1 untouched):
   - `prlimit --fsize=<cap> --core=0` (plus the existing `--as`/`--cpu`);
   - stderr via a **pipe** drained into a bounded 4 KiB tail (never a file);
   - cleanup of exactly the fetcher's known files: the output, `.partial`, and `configs/L{1,2}/<digits>.json`, then their dirs; nothing else.
3. **New r3 tests:** **real child processes** under the real `prlimit`:
   - one tries to write above the cap: refused; no witness bytes; the observed on-disk size never exceeds the cap; the work dir is empty;
   - one writes 50 MB of stderr: producer memory bounded, tail ≤ 4 KiB;
   - one writes the upstream `configs/` files: cleaned;
   - plus the r1 regressions (argv, single flight, deadline).
4. **Report:** this file, updated at the end, says which stage is complete and which is unqualified.

## RESULT: which stage is complete / unqualified
| stage | state | `SHA256SUMS` sha256 | qualified? |
|---|---|---|---|
| producer **r1** | frozen, unchanged (re-verified) | `1efa5c8557fad0cd409f4106cbbbb7505c3e43564b3ac9c12d711d5bf43e81c2` | **No:** its output-bound defect (1589) and config-file run-dir leak make it **not for production** |
| placement **r2** | **COMPLETE and FROZEN** (hashed with `sha256sum`; files `a-w`) | **`07084e7a5a9310c8d4b42c787647472b161d6f61c6010c5e96297f74186678c0`** | **No.** Its tests are not run. Integration 50 may consume it now (it is frozen). |
| producer **r3** | **COMPLETE and FROZEN** (hashed; files `a-w`) | **`816417f4e4cf09b2bf3acbcf5418e43596c3732d937f718da9b008cf8d3e14fe`** | **No.** Its tests are not run. |

**Placement r2 files:**

| file | sha256 |
|---|---|
| `patches/witness-placement-r2-vs-writer-integrated-r1.patch` | `5459ebe853887b4271318e3cb21f3f36bc0cd443678ae7e1d8db70898bfec04a` |
| `patches/RESULT-TREE.txt` | `f2fd9ed4…` |
| `patches/RESULT-FILES.sha256` | `d7760b21…` |
| `systemd/enclave-witness-forward.socket` | `1f77cfd4…` |
| `systemd/enclave-witness-forward.service` | `16e19fe2…` |
| `proposal/witness-route.json` | `a2e4dd2f…` |
| `tests/test_forward_chain.py` (6 tests) | `a818ce10…` |
| `jobs/tests.sh` | `7a6f7ac9…` |
| `README.md` | `19abd1d7…` |

- **The patch:** `f473e41d` → tree **`58c9b92e2f4c311c63d4fe11d226d40f7b8a2f20`**. It carries both r1-test adjustments (verified by grep: `boundWitnessUrl: url`; `10.0.2.2:9000/w` removed from the must-refuse list).
- **No producer copy:** the harness uses frozen r1 by path, with its sha checked (`b61a981d…`).

**Producer r3 files:**

| file | sha256 |
|---|---|
| `producer/witness_producer.py` | `133eed31a4be91f944447ed9f91e9fb667c91ef2ef18fcc01b2f8811e5c1df0e` |
| `tests/test_witness_producer_r3.py` (10 tests) | `edf46e3e118fe337c2275bf9cb7acf5ae4434177db28913ef42adc89ef660406` |
| `jobs/tests.sh` | `4fc42300…` |
| `README.md` | `994dbbc6…` |

**Root commands** (offline, queue 512, `unshare -Urn`; nothing here was run by me):
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-placement-r2 512 unshare -Urn bash witness-producer-service-stage/r2/jobs/tests.sh   # Ran 6, OK
bash jobs/q-exit-status.sh witness-producer-r3  512 unshare -Urn bash witness-producer-service-stage/r3/jobs/tests.sh   # Ran 10, OK
```
- **The patch's node tests** run in the merged composition: `test/witness-placement.test.mjs` 5 and `test/derived-reader-driver-integration.test.mjs` 8, with 10.0.2.2 on the namespace lo. Then rebuild the runtime bundle.

**Desk checks (not runs):** `ast`, `bash -n`, `json` parse, test counts by grep. I re-traced the r3 exact-cap test: one 64 KiB write is served at cap 65536; at cap 65535 the kernel's short write is followed by EFBIG.

**Still measured / unqualified (none claimed):**
- witness sizes and durations vs caps (now also the `--fsize` cap);
- the real Rust fetcher under `--fsize` (SIGXFSZ, then 502, as tested with the SIG_DFL child);
- bridge method coverage;
- the end-to-end QEMU path SNP guest → `10.0.2.2:28747` → host → RPC VM `10.0.2.15:28747` → `127.0.0.1:18747`;
- systemd `IPAddressAllow` enforcement;
- the native accepting a served witness;
- the release build / image pin.

**Production pairing:** placement r2's forward plus **producer r3** at `127.0.0.1:18747` (r1's unit template). r1 is not to be activated.
