# Base full-node binary build (M7-patched), 2026-10-25: BUILD RUNNING, NO RESULTS

**Status: the RUN 1 build is RUNNING** (root foreground exec7707, since 19:22Z, shared queue 1792 MiB with the 16 GiB
floor, single worker, private production target).
- **No artifact, hash, smoke result or build log is published here, and none is claimed.**
- This is **NOT a production pin, image, deployment or activation.** It is a candidate input for future bootstrap-authority
  work.
- The native Helios image pin is unchanged.
- **Unsolved: host glibc and OpenSSL, and the target ABI.**
  - The binary will dynamically link the BUILD HOST's glibc and system OpenSSL (Arch: glibc 2.44, OpenSSL 3.6.5), through
    `openssl-sys`.
  - Whether, and how, it runs on a deployment target (different glibc or OpenSSL ABI) is **not established**.

## Inputs and provenance (verified before the build; `prechecks/`)

| item | value |
|---|---|
| pristine source | base/base `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42` (tree `19b29a15a53d035d839b76915a94af0581507df0`), committed epoch 1792689943 |
| patch | M7 `base-l1-verify.patch` `e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312` (tests validated and published in `../../rpc-client-integrity/2026-10-25/`) |
| patched source | == `git archive 5476069f` + `git apply` patch (re-derived and diffed, no other difference). Tree manifest `d8078bdf5dbab667478329f8e31dac7cac4c780404982cf535d93dd109ca6efb`. Provider `201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2`; CLI `DEFAULT_L1_TRUST_RPC = false` |
| lock | `Cargo.lock` `f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f`, `--locked` |
| toolchain | rustc 1.96.0 (`ac68faa20`), cargo 1.96.0 (`30a34c682`); host GCC 16.2.1, clang/libclang 23.1.3, cmake 4.4.4 |
| dependencies | `cargo build -p base` resolves `--offline --locked` from a private, pre-fetched cargo home (1427 packages; no Go fetch, no vendored OpenSSL). The build runs in `unshare -rn`, so a missing crate fails and nothing is fetched |
| embedded version data | `reth-node-core`'s vergen embeds the reth checkout SHA `7134be3b51cf9d9504f988bff3266a23085f0bd9` (tracked files clean; cargo's untracked `.cargo-ok` likely yields a deterministic `-dev` suffix), a build timestamp pinned by `SOURCE_DATE_EPOCH`, and the profile name |

## Recipe (`recipe/`)

- **`recipe/build.sh`:** sha256 **`2ee8b8dec0a64331e261f0fe2fcafed5c899554322a2a0a9bd9c236202d409ec`**, the EXACT executed
  script, as reviewed and fixed by root (`recipe/ROOT-REVIEW.txt`).
  - Root fixed the same-command export expansion, so `CXXFLAGS` now receives the new `CFLAGS`.
  - Root bounded `RUN` to 1 or 2 before any own path is created or removed.
  - All source, patch and input checks are unchanged.
- **Command:** `cargo build --locked --offline -p base --bin base --profile m7-release-nolto`.
- **Profile** `m7-release-nolto` (via `--config`, no source edit):
  - Base's `[profile.release]`: opt-level 3, debug none, strip symbols, codegen-units 16, panic unwind;
  - **except `lto=false`.** Upstream release uses thin LTO, expected to exceed the 1792 MiB cap.
  - **This is not upstream's release profile.** Expect somewhat lower performance (not measured) and different bytes.
- **Environment:**
  - `CARGO_BUILD_JOBS=1`; lld `--threads=1`;
  - `SOURCE_DATE_EPOCH=1792689943`;
  - `--remap-path-prefix` and `-ffile-prefix-map` (C and C++) for the source, cargo home and target;
  - `CARGO_INCREMENTAL=0`; offline; a separate private target dir; 12 h timeout.
- **After the build** (in the executed script): binary sha256 and ELF facts; bounded `--version`/`--help` smoke; the M7
  flag `--l1.trust-rpc` (`BASE_NODE_L1_TRUST_RPC`) present in some subcommand's help.
- **`recipe/dry-check.sh`:** sha256 `7a373ccbe8e56a0f323ab3198a8088e49941c2025b725ead38edc27242c08aee`, the offline
  resolution and provenance check (no compile).

## Prechecks (`prechecks/`): PRECHECKS ONLY, run BEFORE root's fix

| log | what | rc |
|---|---|---|
| `dry-check.{out,guard,rc}` | `dry-check.sh`: provenance diff, pins, offline `cargo metadata`/`cargo tree -p base`, build-script and vergen inventory (peak 331 MiB) | 0 |
| `build-dry.{out,guard,rc}` | the PRE-FIX `build.sh` (sha256 `552dac1bf148d804be53eb880d156f6e6b3a72408724d85b0f1c3cdc5eecaaf9`) with `DRY=1`. It stops after every pin, provenance and reth-checkout check, BEFORE the `CFLAGS`/`CXXFLAGS` exports root later fixed | 0 |

Both ran offline through the shared queue at 512 MiB. They are NOT build results.

## Not established

- the build outcome, artifact hash or smoke results (RUN 1 still running);
- a second independent build: **no byte-reproducibility claim** until RUN 2 (its own target) matches;
- deployment ABI compatibility (glibc, OpenSSL);
- performance;
- any production activation.
