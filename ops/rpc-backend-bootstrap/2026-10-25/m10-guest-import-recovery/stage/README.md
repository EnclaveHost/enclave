# M10 guest run 2: test-only import fix + repair bundle (PREPARED; nothing uploaded, built or run)

## Run 1 result (actual; `outputs/rpc-production-final-20261025/m10-guest-native-1/`, kept unchanged)

**FAILED, rc 1** (2026-10-25 23:08:38Z).
- **Engine:** the engine phase passed **152** tests (REBUILT `8fd6a7cc…`).
- **The compile error:** the node lib TEST build failed with a real compile error:

  ```
  error[E0433]: cannot find type `EngineError` in this scope
    --> crates/consensus/service/src/actors/engine/engine_request_processor.rs:2449:31
  help: consider importing this enum through its public re-export: 2416 + use crate::EngineError;
  ```

- **Resources:** peak 4486 MiB (rustc 4141); guest minimum 49508 MiB; disk minimum 19057 MiB; host minimum 21524 MiB.
  There was no OOM. The product and its dependencies compiled.

**Why it failed:** the new M10 nested test module `mod bootstrap_anchor` uses `use super::*`, and the parent `tests`
module only names `crate::EngineError::…` by full path. The other M10 test modules import `EngineError` explicitly.

**Run-1 receipts:**
- `run-1.out` `f88f4864`, `run-1.rc` `4355a46b`, `run-1.receipt.json` `745d2243`;
- `node.build.err` `c3380716`, `node.build.json` `100a7a33`, `engine.test.out` `5604891`, `result.json` `1ce80f26`.

**Unit stop:** the watcher's stop gave 5 ("unit not loaded"). This was expected: the unit had already ended, so it was
not an orphan.

## The fix (test-only; proven)

**`inputs/m10-bootstrap-anchor.patch` = `d97c31b591d41fa5d18ca628ea06eb8efdbccf196122b8e05b1d06c69bf2e0a3`**, from the
original `0a10cf86` via `tools/make-fixed-m10-patch.py` `fc44bf9b`. The patch delta is `proof/patch-delta.txt`, 3 lines:
- the `index` postimage blob `fb036e9` becomes `f076d81` (git hash-object of the fixed file);
- the hunk header `+2409,79` becomes `+2409,80`;
- one added line, `+        use crate::EngineError;`, as the first line of `mod bootstrap_anchor` (the exact rustc
  suggestion).

**Tree delta (`proof/tree-delta.txt`):** I applied pristine 5476069f+M7 + the original patch to one copy, and + the
fixed patch to another. They differ in **exactly that one line**, inside `#[cfg(test)] mod tests`. **No product code
changes.**
- The original patch's tree is identical to the host M10 `build/tree`.
- The control script and the expected control failure sets are unchanged. The added line is test-only and outside the
  3 disabled anchor-check lines.

## Run 2 (`bundle/`, `MANIFEST.sha256` = `1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29`; 15 files, 180K)

**What the bundle holds:**
- the fixed M10 patch (+ `.sha256`);
- the M7 patch `e9dfb8c6`, the control script `8c1b882f`, `artifact.py` `06677dae`, the original job `51ffbda2`;
- `runner/`.

**Not copied:** the toolchain and the base tar. They are taken from the OLD stage, which preflight re-verifies against
MANIFEST `dd9df0ab`.

| file | sha256 | derivation |
|---|---|---|
| `runner/m10-guest-test-2.sh` | `9313e510…` | original job `51ffbda2`, counted step-0 substitutions; **from `phase()` onward byte-identical**: all phases, filters, `--test-threads=2`, named tests, exact negative controls, per-package `cargo clean -p`, fresh=false |
| `runner/guest-env-2.sh` | `49e1885b…` | the same build settings (`CARGO_BUILD_JOBS=1`, the same `RUSTFLAGS`, debug 0, incremental 0) |
| `runner/run-guest-2.sh` | `be5cec34…` | reviewed `run-guest.sh` `b67fcec1` with 6 substitutions: repair-stage paths, attempts 2-9, `verify-stage-2.sh`, `ReadWritePaths=` run-2 **plus only** run-1 `cargo-home` and `target`, the extra env, the job path. **Unchanged:** `MemoryMax=12G`, `CPUQuota=200%`, `Nice=10`, no swap, `PrivateNetwork`, `ProtectSystem=strict`, 3h bound, `KillMode=control-group`, uid 993 `m10build`, memory guard 12288/16384, disk guard 8192 |
| `runner/verify-stage-2.sh` | `6586407f…` | preflight (below) |
| `runner/{verify-deps.py, disk-guard.py, memory-guard.mjs}` | `7d4394a9`, `40e6d0cc`, `cdd00af7` | unchanged reviewed copies |
| `runner/{make-run2-files.py, make-fixed-m10-patch.py}` | `9d8b760c`, `fc44bf9b` | the generators (`--check` re-derives everything) |

**How run 2 builds:**
- **Fresh tree:** a NEW `runs/run-2/build/{tree,control}`, from the OLD stage's tar + M7 + the **fixed** M10 patch.
- **Reused caches:** the **ENDED run-1 `cargo-home` and `target` are reused in place as mutable caches** (no recopy).
  The reused cargo home is re-verified offline (`verify-deps.py`: every crate checksum, `git fsck --full --strict` of
  every db).
- **New paths:** logs go to `runs/run-2/logs`, receipts to `receipts/run-2.*`, unit `m10-guest-validation-2`.
- **Not written:** run-1 source, logs and receipts. Only its two cache directories are writable for run 2.

**Preflight `verify-stage-2.sh` refuses unless all of these hold:**
- the repair stage == its MANIFEST and the given sha, with no extra files or symlinks;
- the fixed patch is `d97c31b5`;
- the OLD stage == `dd9df0ab` (full check);
- the staged rustc/cargo are 1.96.0;
- **run 1 has ended:** receipt rc 1, unit inactive;
- the caches exist and belong to `m10build`;
- `runs/run-2` is new;
- the tools, libclang and openssl are present;
- the stages are not writable by `m10build`;
- disk ≥ 16384 MiB free;
- MemAvailable ≥ 28672 MiB.

**Host watcher `host/guest-build-watch-2.py` `5668ee1e`:** the reviewed watcher `31264eb0` with 3 substitutions:
attempts 2-9, a precheck that also requires the run-1 receipt and an inactive run-1 unit, and the new launcher path.
- **Outer host floor:** 16 GiB, unchanged.
- **Test:** `host/test-guest-build-watch-2.py` `8a5f9af3` (the 6 reviewed monitor controls, pointed at the -2 copy). NOT
  run.

## Root commands (in order; none run by me)

```sh
X=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-guest-import-recovery
python3 $X/tools/make-run2-files.py --check $X && echo derived-ok          # re-derive all four run-2 files from their pins
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $X/logs/watch2-tests.guard -- python3 $X/host/test-guest-build-watch-2.py
bash $X/host/transfer-import-recovery.sh                                    # upload + guest preflight-2 (must end "## preflight-2 rc=0")
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
python3 $X/host/guest-build-watch-2.py 2 1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29 /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m10-guest-native-2
```

The last command runs foreground under root's usual small-queue wrapper. A pass is the receipt `run-2.receipt.json`
with `"pass": true`.

## Remaining risks

- **Possible further compile errors:** rustc stopped at name resolution, so **type or borrow errors in the M10 node and
  CLI test code can still appear**. That code has never compiled anywhere: the host attempts stopped earlier, in
  `base-node-core`. Static review found no other unresolved name in that module, and the sequencer, validator and
  SafeDB test modules import `EngineError` explicitly.
- **Rebuild cost:** the new run-2 tree path means every workspace crate rebuilds, including `base-node-core`, at about
  4.1 GiB rustc peak (that is within the 12 GiB cap). Only the registry and git dependencies are reused from the run-1
  target and cargo home.
- **Cache mutation:** run 2 mutates the run-1 caches (per-package `cargo clean -p`, new units). That is authorized;
  run-1 source, logs and receipts are not touched.
- **Not run:** the watcher -2 test, the transfer and the preflight.
