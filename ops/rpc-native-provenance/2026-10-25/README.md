# Native provenance audit of the 7 pinned chain-verifier natives (READ-ONLY RESULT)

## Scope and method

- **Owned:** `native-provenance-audit-stage/` (with `NATIVE-PROVENANCE.json` and this report as `PLAN.md`) and this log.
- **Not done:** no build, download, image or VM work, no SSH, keys or source edits, no commit or push.
- **Method, lightweight reads only:**
  - sha256 of the pinned files;
  - `readelf -n` / `.comment`;
  - counts and directory prefixes of embedded path strings (never contents);
  - `git log`, `git status` and `git diff --stat`;
  - `pacman -Qo` / `-Qkk`, `bsdtar -xO` of single files from cached packages, and `pacman-key --verify`;
  - the existing receipts.
- **Not used:** no queue job was needed.
- **The pins** (`linux-rpc-runtime-launch/chain-verifier-inputs/PINS.sha256`, equal to `metal/chain-verifier-image.json`
  at `0235e7d96`):
  - `helios` `cc962e2b`;
  - `witness-check` `4fe0cd3b`;
  - `enclave-base-head-listener` `9ca75047`;
  - `ld-linux-x86-64.so.2` `f5e11cc6`, `libc.so.6` `02c8c3d0`, `libm.so.6` `96510670`, `libgcc_s.so.1` `e618cb9c`.

**Audit result.**
- **Libraries:** the 4 libraries are proven to be **upstream, signed distribution bytes**.
- **Rust binaries:** the 3 are **our own builds, each built once and never reproduced**.
  - The release listener has a complete recorded recipe and remapped paths.
  - **Helios and the helper were built from UNCOMMITTED working trees.** Their exact source bytes are not recorded, and
    their debug builds embed absolute build paths.
- **The hash pins prove only byte identity with these files, not how they were built.**

## Map: binary → source → build

| pinned file | kind | source and build (evidence) | status |
|---|---|---|---|
| `ld-linux-x86-64.so.2`, `libc.so.6`, `libm.so.6` | **upstream distribution bytes** | Arch `glibc 2.44+r50+g1848099f063e-1`. Each pinned file == the same path extracted from the cached package `/var/cache/pacman/pkg/glibc-2.44+r50…pkg.tar.zst`; **package signature Good** (Frederik Schwan, Arch packager key); installed copies == pins; `pacman -Qkk glibc` 0 altered | **PROVEN** (package bytes; not a source rebuild of glibc) |
| `libgcc_s.so.1` | **upstream distribution bytes** | Arch **`libgcc` 16.2.1+r23+gd564253eb6c8-1** (split package; the recipe's "gcc-libs" label is inaccurate: gcc-libs contains no such file). The pin == the file extracted from the cached `libgcc-16.2.1+r23…pkg.tar.zst`; host file owned by `libgcc` | **PROVEN** (bytes; `libgcc` package signature Good) |
| `enclave-base-head-listener` `9ca75047` | **our release build** | `rpc-runtime-composition/closure/build-listener-r2/BUILD.json`: `build-binaries.sh` profile **release**, rustc 1.96.0 (`ac68faa20`), listener commit **`5e178676`** (tree `00e3a61d`, repo `rpc-gossip-bridge/listener`, clean now), base/base tarball `5476069f` **`9784e20a…`** (present, hash OK), `Cargo.lock` `5ad182d7…`, `--locked --offline`, RUSTFLAGS `--remap-path-prefix` (work→`/build`, cargo home→`/cargo`), single-threaded link. Log `rpc-runtime-composition/jobs/rel-listener2.out`. ELF: build-id `f524a2cc…`, **0 home-path strings**, `/cargo/registry/src` prefixes (remapped). Built once 2026-10-23T06:02Z | **recipe complete; reproducibility UNTESTED** (`closure.json` `reproducedTwice: false`) |
| `helios` `cc962e2b` | **our debug build** | `witness-failover/PROVENANCE.json` says "copy of `rpc-priority/helios-target-base/debug/helios` (eeffcc9 r4 build)", and the file there still == `cc962e2b`. **That label is not supported by the logs:** the r4 log (`rpc-priority/jobs/base-evm-build-test-r4.out`, ended 18:51:25) shows HEAD `3416a24` **with uncommitted `opstack/src/config.rs`, `consensus.rs`** and records no hash. The binary's mtime **18:57:45** is after `b93fcfd` (18:51:50) and before the commit `eeffcc9` (18:58:29). **No log records the build that produced `cc962e2b`.** Flags (r4 script): `RUSTUP_TOOLCHAIN=1.96.0`, dev profile, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=1`, offline, RUSTFLAGS `-C link-arg=-Wl,--threads=1`, `cargo build --offline -p helios-cli --bin helios`, `CARGO_TARGET_DIR=rpc-priority/helios-target-base`, `CARGO_HOME=rpc-priority/cargo-home`. Upstream base `a16z/helios 2af9b418` + 4 enclave-base-evm patches. ELF: rustc 1.96.0, LLD 22.1.2, GCC 16.2.1; build-id `7f15da75…`; **2634 absolute strings under `…/rpc-priority`** (not remapped) | **source NOT recorded** (an uncommitted tree between `b93fcfd` and `eeffcc9`); **never reproduced** |
| `witness-check` `4fe0cd3b` | **our debug build** | Built by `witness-failover/jobs/helper-build-test-r5.sh` (log `logs/helper-build-test-r5b.out`); the binary is still at `witness-failover/target/debug/witness-check` (== pin). **The log shows HEAD `aca8176` with uncommitted `opstack/bin/witness-check.rs` and `opstack/src/witness_check.rs`**; the build finished 21:28:11, and **`ef320298` was committed 21:43:40** (it changes exactly those 2 files vs aca8176). `closure.json`'s "built by P from ef320298" is therefore an inference, not a record. Flags as above (`CARGO_HOME`/`CARGO_TARGET_DIR` under `witness-failover`), `-p helios-opstack --bin witness-check`. ELF build-id `921ff544…`; **297 absolute strings under `…/witness-failover`** | **source equal to `ef320298` UNPROVEN** (15-min gap); **never reproduced** |

**Related, not in the image:**
- `reth-v2.8.0` `8cdd1f35`: an **upstream release**. `rpc-l1-source-package/RESULT.md` records the official tarball
  `809bfe0f…` == the GitHub asset digest. The binary self-reports commit `05ba4812`, built with Ubuntu clang
  22.1.8 / GCC 13.3 / rustc 1.99.1 (an upstream CI toolchain, unlike our host builds).
- `helios-compat-0a02256` and `opstack-server` are test-only.
- `enclave-base-head-listener` `ebd045b4` is the debug listener (test-only).

**Recorded-claim corrections:**
1. "`cc962e2b` = eeffcc9 r4 build" (witness-failover `PROVENANCE.json`) is unsupported: no log, and the r4 tree was dirty.
2. "`4fe0cd3b` built from `ef320298`" (`closure.json`) is an inference: it was built from a dirty `aca8176` before
   `ef320298` existed.
3. `closure.json` says Helios `ef320298` changes "only the helper" relative to `aca81764`. That is true, but relative to
   **`eeffcc9`** it also adds a `witness_check` module to the opstack **library** the CLI links, a `serde_json`
   dependency, and a visibility change in `consensus.rs`. So **a CLI built at the pinned `ef320298` is not expected to
   reproduce `cc962e2b`'s bytes**, even if behaviour is the same.
4. The `libgcc_s` package is `libgcc`, not `gcc-libs`.

**Existing reproducible-build tooling:**
- `rpc-runtime-final-integration/repo/scripts/rpc-runtime/build-binaries.sh` (`d5bb17e8…`) with `closure.json`
  (`92ff59d1…`):
  - offline, `--locked`, from a base tarball, a lock-derived `CARGO_HOME` and exact git trees;
  - remapped paths; dev, release and check modes;
  - its `check` mode passed in final-integration (the inputs resolve).
- **But:** it pins Helios at `ef320298`, and was used only for the release listener. It never reproduced `cc962e2b` or
  `4fe0cd3b`, and it has no reproduction or compare mode.

## Plan: bounded build reproduction (NOT run; no download needed — all inputs are local)

Ordered by value and cost. Each step runs through the shared queue, offline (`unshare -r -n`), with
`CARGO_BUILD_JOBS=1`.

**R1. Release listener, twice, cheapest and closest to proof.**
- **Inputs:** `build-binaries.sh <fresh work A> <listener repo> 5e178676 <tarball 9784e20a> <cargo-home-listener>
  release`, and again with a different work dir B.
- **Pass:** A == B == `9ca75047`. Paths are remapped, so the work dir should not matter.
- **Cost:** peak ~745 MiB (recorded), so a 1024 cap.

**R2. witness-check at `ef320298`, in its original paths.**
- **Setup:** a fresh clone at `ef320298`, bind-mounted at the original path `…/witness-failover/helios` inside a
  private mount namespace (`unshare -rm`, so the original tree is untouched). Use the original `cargo-home` and a
  target dir at the original path, also bind-mounted.
- **Build:** the r5 flags and command.
- **Result:** if it equals `4fe0cd3b`, the source is proven to be `ef320298`. If not, the existing binary remains unproven: source differences, build environment, or nondeterminism could explain
  the mismatch. Diagnose before re-pinning a reproducible build.
- **Cost:** recorded peaks about 1.5 GiB for the release helper; debug is lower. Cap 1408–1536, which needs root's
  allocation decision.

**R3. Helios CLI `cc962e2b`.**
- **Candidates:** build `b93fcfd` and `eeffcc9` the same way (the original paths via bind mounts, the r4 flags,
  `rpc-priority/cargo-home`, `CARGO_TARGET_DIR` at `…/helios-target-base`), and compare each with `cc962e2b`.
  - `eeffcc9`'s last change is opstack-server only, so the CLI is likely identical between the two.
- **If either matches:** provenance is proven.
- **If neither matches:** `cc962e2b` stays unreproducible. The recommended fix is then to **re-pin** Helios to a
  reproducible build of a committed tree. Note this changes the image measurement, so it needs a new image.
- **Cost:** a debug Helios build within 1536 MiB (r4 ran under 1536). Each attempt is a long compile.

**R4. libgcc signature:** DONE in this audit (Good signature, Arch packager key).

**Long-term, beyond these bounded steps (root's call):**
- release-profile, path-remapped builds of all three via `build-binaries.sh`, each twice on separate paths;
- a `--compare` mode in that script;
- an independent second builder host;
- a larger allocation for release Helios (it exceeded 1536 MiB earlier).

None of this is needed to read the gaps above.

## Remaining (explicit)

- **No Rust native is reproduced.** Helios's and the helper's exact source trees are not recorded.
- **Hash pins prove identity, not origin.**
- The glibc and libgcc bytes are distribution binaries trusted via the Arch signature. glibc was not rebuilt from source.
- **No claims are made about hardware, attestation, activation, finality or readiness.**
