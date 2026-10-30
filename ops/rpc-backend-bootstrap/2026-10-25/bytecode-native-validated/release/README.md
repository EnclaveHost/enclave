# Release-only build of base-bytecode-check (PREPARED; NOT run; root reviews and runs it at 2560)

`root-release.sh` reuses the verified private `build/` from root run `root-bytecode-native-2202` without changing it.
It only adds `build/target/release`.

## Refuses unless all pins hold
- **Toolchain:** `rustc 1.96.0 (ac68faa20 2026-05-25)` and `cargo 1.96.0 (30a34c682 2026-05-25)`.
- **Stage files:** `inputs/STAGE-SHA256SUMS` matches, and the file itself is `9effed77…`.
- **Test receipts:** `PASSED-TEST-RECEIPTS.sha256` matches. This covers the root `.out`, `.guard` and `.rc`; the patched and
  control test outputs; `cargo-tree`; the closure manifest; and the patched build JSON. The `.out` must say
  `## aggregate rc=0`, and the `.rc` must be 0.
- **Source restored after the controls:** the member `lib.rs` and `build/lib.rs.orig` both hash to `739c3245…`, and
  `build/tree` equals `crate/`.
- **Tree:** `Cargo.lock` is `91a9e762…`, and `build/tree` equals `git archive 5476069f` (`tar --compare`). The only
  allowed differences are `Cargo.lock` and file owner. Run it under `unshare -rn`, as the test run was.
- **Inputs:** the closure manifest is re-verified against the private cargo home.
- **Clean state:** no `CARGO_PROFILE_RELEASE_*` override, no preset `RUSTFLAGS`, and no pre-existing `build/target/release`.
- **Not reused:** `release/logs` must not exist yet.

## Build and checks
- **Command:** `cargo build --offline --locked --release -p base-bytecode-check --bin base-bytecode-check`.
- **Settings:**
  - `CARGO_BUILD_JOBS=1`;
  - `RUSTFLAGS='-C link-arg=-Wl,--threads=1'`: one lld thread; the tested build's linker was `Linker: LLD 22.1.2`;
  - the workspace release profile, unchanged: opt-level 3, `lto = "thin"`, codegen-units 16, panic unwind, strip symbols.
- **The run must produce exactly one bin artifact,** with `fresh=false`, opt-level 3, and a path under `target/release`.
  The lock, source and stage sums must be unchanged afterwards.
- **Usage smoke:** with no argument, the binary must refuse with its usage text. It does not touch any datadir.
- **Output:** `logs/release-manifest.json`, recording the artifact sha256, size, fresh flag, toolchain, flags and every pin.

## Command
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-native-validation
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $S/release/root-release.guard -- unshare -rn bash $S/release/root-release.sh > $S/release/root-release.out 2>&1
```
- **Pass:** the output ends with `## release rc=0`.
- **Exit 98:** not started, which is not a pass.
- **Estimate:** thin-LTO at `-j1` is about 1.0–2.2 GiB (the debug test run peaked at 684 MiB) and takes 20–50 min.
- **Retry:** move `release/logs` and `build/target/release` aside; keep them as evidence.

This binary is a **live-run candidate only**.
- **Not tested:** it has never been run on any datadir; the 13 tests ran the debug test profile.
- **Next:** a live run with clients stopped, under root review.
- **OPEN_GAPS and the published A2 are unchanged.**
