# M10 native tests on the private RPC guest (Ubuntu): sources, safeguards and receipts (2026-10-25)

## Status (authoritative)

| item | state | receipt |
|---|---|---|
| disk guard (`source/runner/disk-guard.py` `40e6d0cc`) | **TESTED: 9/9 pass**, rc 0 (pin, missing path → 2, floor at start → 97, child rc 0/7, SIGTERM → 143 and SIGINT → 130 with grandchild cleanup, early exit with leftover grandchild, floor during run → 97, unrelated process survives) | `receipts/root-guest-disk-guard-2243.*` |
| host outer watcher (`host-jobs/guest-build-watch.py` `31264eb0`) | **TESTED: 6 fixture controls pass**, rc 0 (success, remote failure, pre-start floor, active floor, cancellation, observer error) | `receipts/root-guest-watch-tests-2239.*` |
| stage build on the host (`source/build-stage.sh` `67923e13`) | **rc 0**: 8/8 frozen inputs pinned; runner == generator(job `51ffbda2`); base tar `a92160eb`; every locked dependency verified offline (including `git fsck --full --strict` of the bare dbs); no credential-like names; **5630 files, 1.5G, `MANIFEST.sha256` = `dd9df0ab82e9f8b53a90063808bdd2199b873eafcf037fb6313d4406d4fb49ee`** | `receipts/root-m10-guest-stage-2243.*` |
| transfer + guest preflight (`host-jobs/transfer-m10-guest-stage.sh` `b52eeb0c`) | **rc 0. Transfer SHA verified on the guest:** MANIFEST == `dd9df0ab`, all 5630 files match, no unlisted files, 0 symlinks; staged rustc/cargo 1.96.0 run; tools present; uid 993; stage not writable; disk 25001 MiB free; MemAvailable 53381 MiB | `receipts/root-m10-guest-transfer-2244.*` |
| **native run 1** (`guest-build-watch.py 1 dd9df0ab…`) | **RUNNING, NOT PASSED.** The precheck passed: empty output, then launched. **Engine 152/152 passed, zero ignored** (`engine.test.out`). Node compilation is running; no node, CLI or control result exists yet. | `receipts/m10-guest-native-1/precheck.out` (empty, `e3b0c442`) |

**Not included here:**
- the stage itself (`stage-1`: the toolchain, crate archives and git dbs);
- any binary, cache or package;
- `remote.out` and the root-job output of the running attempt.

## Environment (guest; values from the receipts)

**Guest OS and tools:** Ubuntu 24.04, gcc/g++ 13.3.0, clang 18.1.3 (`libclang` llvm-18), cmake 3.28.3, make 4.3,
pkg-config 1.8.1, git 2.43.0, Python 3.12.3, node 18.19.1.

**Libraries:**
- **OpenSSL 3.0.13** (the system copy; openssl-sys links it);
- **no zlib dev files:** libz-sys builds its vendored zlib, because `zlib1g-dev` would upgrade the running zlib;
- **no system libgit2:** libgit2-sys builds its vendored copy.

**apt:** the final plan and the install were **0 upgraded, 70 newly installed, 0 to remove** (17 not upgraded). The
first plan (`guest-build-apt-plan-2232.out`) would have upgraded 3, and was revised before install.

**Isolation:** the private dedicated user `m10build` (**uid 993**, nologin) runs a transient unit with:
- **`CPUQuota=200%`, `MemoryMax=12G`**, `MemorySwapMax=0`, `Nice=10`;
- `RuntimeMaxSec=3h`, `KillMode=control-group`, `TimeoutStopSec=30`;
- `PrivateNetwork` (offline), `ProtectSystem=strict`;
- writable only in `/srv/m10-guest-validation/runs/run-N`.

**Guards:**

| level | limit | enforced by |
|---|---|---|
| guest memory floor | **16 GiB** | root's general memory guard, copied unchanged (`cdd00af7`) |
| guest tree cap | 12288 MiB | the same guard |
| guest disk floor | **8 GiB** | `disk-guard.py` |
| outer host floor | **16 GiB** | `guest-build-watch.py`; on the floor, a cancel or a remote failure it runs only `systemctl stop m10-guest-validation-N` |

**Live chains:** no live chain or service was changed. Root reported its own EL/CL/downloader PIDs unchanged; this
package did not verify that itself.

## Pins (metadata only; nothing large is published)

- **Toolchain:** the official rust **1.96.0** dist, rustc `ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`, cargo
  `30a34c682`, 615 MB, staged unchanged.
- **Dependency archives:** the M7 cargo home's `registry/cache` and `registry/index`, plus the bare `git/db` only.
  `registry/src` and `git/checkouts` are excluded; cargo re-extracts and rebuilds them offline from the checksummed
  archives and pinned commits.
- **Source:** `git archive 5476069f` = `a92160eb…`; M7 patch `e9dfb8c6`; M10 patch `0a10cf86`; control script
  `8c1b882f`; original job `51ffbda2`; frozen inputs `ead48b1d`.
- **Stage:** `MANIFEST.sha256` `dd9df0ab…` (5630 files).

## What runs on the guest (`source/runner/m10-guest-test.sh` `6b72c8f9`)

**How it is made:** `make-guest-runner.py` derives it from the pinned `root-test-m10.sh` (`51ffbda2`) with 6 counted
substitutions in step 0 only (environment, staged source and cache, toolchain checks, offline dependency verification).

**From `phase()` onward it is byte-identical to the original:**
- engine (152), node, sequencer, SafeDB, derivation, CLI;
- the exact negative-control failure sets;
- per-package `cargo clean -p` and fresh=false;
- `CARGO_BUILD_JOBS=1` and `RUSTFLAGS='-C link-arg=-Wl,--threads=1'`.

**Pass rule:** the launcher additionally requires 0 ignored tests, and records the real `systemd-run --wait` exit code.

## Reproduce (root)

```sh
# host: tests of the safeguards (shared 256 MiB queue), then the stage
python3 work/claude-test-queue.py --mib 256 --log G.guard -- python3 source/test-disk-guard.py
python3 work/claude-test-queue.py --mib 256 --log W.guard -- python3 host-jobs/test-guest-build-watch.py
bash source/build-stage.sh NEW_STAGE_DIR            # prints MANIFEST.sha256 (expected dd9df0ab… for these inputs)
# host -> guest: transfer + guest preflight (host-jobs/transfer-m10-guest-stage.sh; it pins the manifest sha)
# guest run, coordinated from the host with the outer 16 GiB floor:
python3 host-jobs/guest-build-watch.py <N> dd9df0ab82e9f8b53a90063808bdd2199b873eafcf037fb6313d4406d4fb49ee OUT_DIR
```

**Path dependencies:** the scripts hardcode this build host's paths (frozen inputs, toolchain, cargo home) and the
guest paths `/srv/m10-guest-validation/{stage,runs,receipts}`. The host jobs use root's existing SSH config by path;
no key material is included.

## Host history (by reference to committed evidence)

**Already committed** in `ops/rpc-client-integrity/2026-10-25/m10-prepared/` (`failed-native-runs/`, `recovery-2560/`,
`recovery-4096/`):
- 1792 cap stop, 1818 MiB;
- 2560 cap stop, 2566;
- 4096 **host-floor** stop at 3932 (`root-m10-resume4096-2155`).

**The untested 6144 proposal:** `ops/rpc-backend-bootstrap/2026-10-25/host-6144-proposal-not-installed/`.

**Additional failure receipt preserved here:** `host-evidence-not-previously-committed/root-m10-resume4096-2-2215.*`, the
4096 **cap** stop at 4262 MiB (rustc 3993).

**In every host attempt:** the engine passed 152 tests and the node test build did not finish.

## Limitations

- **Native run 1 is RUNNING, not passed.** Engine tests passed; nothing here is a node, sequencer, SafeDB, derivation, CLI or control result.
- **No reproducible-binary claim:** the compilers (GCC 13, clang 18), OpenSSL 3.0 cfgs, vendored zlib/libgit2 and the
  paths all differ from the host.
- **What the guards prove:** the safeguard tests use fixtures and tiny processes. They prove the guard logic, not
  behaviour under a real 12 GiB build.
- **Transfer integrity:** it is established by the guest's per-file MANIFEST check, not by a hash of the transferred
  tar stream.
- **`source/PREP-SHA256SUMS.txt`** is the preparation directory's own list. Its `README.md` entry refers to the file
  published here as `source/PREP-README.md`, and that README describes the pre-run plan. **This README is
  authoritative.**
