# Lease-consumer seams r2: corrected dependency resolution (PREPARED; NOT run; no product verdict yet)

**The original stage, run 0114 and source are FROZEN and untouched.** r2 only reads them:
- the stage `SHA256SUMS` must be `8f27b16c…`;
- `seams.patch` must be `26393ac5…` (the same candidate);
- `candidate/` and `test/` are verified by those sums.

## Run 0114 failure (root's evidence)

`candidate-bundles.out`: `ERR_MODULE_NOT_FOUND esbuild`; all 7 baseline test files failed to load (missing dependencies). **No product verdict.**

**Cause (verified read-only):** `relay-consumer-source/node_modules` is a **relative** symlink `../control-source/node_modules`, a chain whose real root is `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules` (143 MB). `cp -a` copied the relative link itself, which dangles inside `runs/…/work/<side>/`.

## Fix (only this; root's strengthening preserved byte-for-byte)

Root's strengthening is kept as-is:
- `npm_config_offline` and `lo` up;
- the no-route check;
- process exit codes (base 1, candidate 0);
- the exact failing set;
- zero cancelled, skipped and todo.

| Step | r2 |
|---|---|
| Dependency root | `DEPS=$(realpath -e $SRC/node_modules)` must equal `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules` |
| Closure check (before **and** after the run) | Every applicable top-level package of the `REV` `package-lock.json` must be present at `DEPS` with the **locked version**. Other-OS/CPU and absent optional/peer packages are skipped. `esbuild`, `@esbuild/linux-x64` (and its binary), `viem`, `@noble/hashes` and `@noble/curves` are required explicitly. The manifest (name, version, package.json sha256, esbuild binary sha256) must be identical after the run: the root is read-only. |
| Static pre-check (read-only, done now) | 135 packages OK, 0 missing, 0 version mismatches, 59 skipped. esbuild 0.28.1, @esbuild/linux-x64 0.28.1 and viem 2.53.1 are present (= the lock). |
| Clone `node_modules` | an **absolute** symlink to `DEPS` (no relative chain, no copy) |
| Resolution proof per clone | `createRequire(<clone>/package.json).resolve("esbuild"/"viem")` must lie inside `DEPS`, before any build or test |
| Base bundle discrepancy | **Reported, not waived:** the base Windows `--check` must **fail** (the known staleness: the manifest has `lease-gas-runtime.mjs` `91b5e357`, the source `eb78a2e6`). The metal check rc is recorded as found. Both are in `verdict.json` `baseBundleCheck`. |
| Outputs | a new `r2/runs/<UTC>-<pid>/`, refused if it exists |

## Root command (foreground; shared queue)

```
R2=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r2
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $R2/root-seams-test-r2.guard -- unshare -rn bash $R2/jobs/root-seams-test-r2.sh > $R2/root-seams-test-r2.out 2>&1; echo $? > $R2/root-seams-test-r2.rc
```

**Accept** only `## seams rc=0` with `verdict.json` `ok: true`.

## Remaining (unchanged by r2)

- **Strict failing set:** root's runner compares the TAP failing set exactly. If `node --test` also emits per-file `not ok` lines, the set differs. That fails visibly; it is never a pass.
- **Deep receipts:** a landed lease receipt more than 256 blocks deep under a sole verifier is still not verifiable (`canonical-consumer-depth-audit/ROOT-REVIEW.md`).
- **No claims:** no finality or production claim. HOLD stays.
