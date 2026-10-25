# M7 production-candidate Base binary: build evidence (resumed RUN 1; 2026-10-25)

**Status: ONE completed build of the M7 candidate.**
- **What it is:** RUN 1, resumed twice in its retained target after memory failures.
- **What it is not:** an independent reproduction (RUN 2 is still pending), a deployment, an activation, or a complete
  anchored bootstrap. M7 alone does not anchor the bootstrap; see "Next".
- **Not committed:** the 290 MB binary, the cargo home, the source tree and `target-1/` stay on the build host.

## Artifact

| item | value |
|---|---|
| file (build host) | `finality-stage/client-integrity-next/production-build/out-1/base` |
| **sha256** | `5aa7b2919870950f1dd90249d3900730184e3ce6b5a54048b3dbca2a72ef430c` |
| size | 290309776 bytes |
| ELF build-id | `5e1a4a3293c3961b1ce7ae63bdf890d869384f90` |
| toolchain (`.comment`) | rustc 1.96.0 (`ac68faa20`), LLD 22.1.2, GCC 16.2.1, clang 22.1.0-rc2 |
| interpreter / NEEDED | `/lib64/ld-linux-x86-64.so.2`; `libstdc++.so.6 libc.so.6 ld-linux-x86-64.so.2 libssl.so.3 libcrypto.so.3 libgcc_s.so.1 libm.so.6`; no RPATH/RUNPATH |
| build-path strings | 0 (build log) |
| finished | `## cargo build rc=0 (2026-10-25T20:54:16Z)`; queue exit 0 |
| resource guard | cap 4096 MiB (`memory.max 4294967296`); **peak tree RSS 4072 MiB** (rustc 3760, cargo 306); host minimum 17541 MiB (floor 16384) |

**Margin warning:** the peak came within 24 MiB of the cap. A rebuild under the same cap may be stopped by the guard.

## Recipe and inputs (pinned; the build re-checked them before compiling, `logs/build-1r8.out`)

| item | value |
|---|---|
| script | `production-build/build.sh` `2ee8b8de…` (unchanged), run through `recovery-4096/resume-4096.sh` `0321879a…` and `resume-body-4096.sh` `09fda204…` (counted substitutions only; see `ops/rpc-base-build/2026-10-25/recovery-4096/`) |
| source | base `5476069f…` (`SOURCE_DATE_EPOCH` 1792689943) + M7 patch `e9dfb8c6…`; `build/src` == `git archive` + patch; source manifest `d8078bdf…`; provider `201d9b8c…`; `Cargo.lock` `f122da76…`; reth checkout `7134be3b…` |
| build | `cargo build --locked --offline -p base --bin base`, profile `m7-release-nolto` (release with `lto=false`), `CARGO_BUILD_JOBS=1`, `--threads=1` link, path remaps for src, cargo home and target |
| CLI smoke on the BUILD HOST (Arch, system libraries) | `base 1.5.1`; `--help` rc 0; the M7 flag `--l1-trust-rpc` (env `BASE_NODE_L1_TRUST_RPC`, default false) present in `rpc`, `follow`, `sequencer` |

## Attempts (all kept; `logs/` and `earlier-failures/`)

| attempt | cap | outcome |
|---|---|---|
| RUN 1 (`build-1`) | 1792 | **kernel OOM** (root journal, `oom-kill`, 1.7G peak); rc 143; no guard receipt |
| resume 1 (`build-1r1`) | 2560 | **guard stop**, rc 99: tree 2565 > 2560 MiB (rustc 2252) on `base-node-core` |
| resume 2–7 (`build-1r2`…`r7`) | 4096 | **not started**, rc 98: four on capacity (available 18507–20533 < 20736), two yielding to a small allocation |
| **resume 8 (`build-1r8`)** | 4096 | **rc 0**: the artifact above |

**What resumes 1 and 8 recompiled:** only what was unfinished. `base-node-core` and later units were built; the 1303
units completed before the OOM were reused.

**Consequence:** the binary's objects come from **three sessions** in one target. It is NOT a fresh build.

## Independent verification (this publication)

**Done directly** (read-only; executes nothing from the artifact):
- the artifact sha256 equals `5aa7b291…`;
- `out-1/SHA256SUMS` names it;
- the build-log lines, guard line and rc files are as above.

**Root verification passed at 21:34 UTC.** `logs/root-m7-verify-2134.*` records exit 0, re-derived input/source pins, artifact and smoke hashes, and ELF/library metadata. Peak RSS was 49 MiB and minimum host available memory was 20221 MiB. The earlier four queue refusals remain recorded. This verifies the existing resumed build; it is not independent byte reproduction.

## Not established

- **Reproducibility:** this needs RUN 2, a fresh target with the same recipe, matching `5aa7b291…`. With a 4072 MiB
  peak, RUN 2 needs at least the 4096 allocation, and may need more.
- **Runtime behavior:** bounded host and Ubuntu guest CLI/library smoke passed; TLS, P2P, database operation and synchronization remain untested for this artifact. See `ops/rpc-backend-bootstrap/2026-10-25/base-runtime-abi-prepared/`.
- **Deployment and bootstrap:** no client deployment, no service change, no activation.
  - The installed launcher still pins its existing `binaries.base`.
  - A combined M7+M10 build is **not prepared**: M10 is still being validated in its frozen workspace, and nothing here
    touches it.
  - **Next, only after M10 passes:** root decides a combined source (M7 patch + M10 patch on base `5476069f`). It
    needs a new build recipe and pins and a fresh build, then an independent RUN 2. Only then comes the runtime-ABI
    smoke on the guest.
