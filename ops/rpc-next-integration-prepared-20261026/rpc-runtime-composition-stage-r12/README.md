# r12: r11 with the B2 artifact-copy fix ONLY (PREPARED; nothing run; same immutable candidate)

- **Candidate:** `2d56a4b193a8f3e0be1b343a1e06970fc193d9f9` (`refs/r11/candidate`), read from **r11's private `src.git`**,
  read only. There is no new candidate, no MCP and no product change.
- **Frozen:** r11's stage files, which r12's phase A re-checks against r11's `SHA256SUMS`.
- **Copies:** every other file is r11's, byte-identical (`REFS.txt`, `CONTRACT-ARTIFACTS.txt`, pins, tools, stack tests).

## Root's r11 preflight (`logs/root-composition-r11-pre-0305`, exit 9)

**The failure:** `[FAIL] verifier: copied artifacts differ from closure d8b3d3125991`.

- **Which tree:** verifier was the THIRD tree of that contract closure. consumers was built first and leaseRelay was the
  independent second build, so verifier took the copy branch at r11 line 123.
- **What the copy did:** `find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {} $T/contracts/foundry/out/ \;`
  ran with **no `out/`**, so the first entry, `out/PaymentRouter.sol`, was copied **as** `out/`.
- **The resulting diff:** against `ARTIFACTS-consumers.sha256`, `out/PaymentRouter.sol/{IERC20,IERC20Permit,PaymentRouter}.json`
  appear flattened as `out/{IERC20,IERC20Permit,PaymentRouter}.json`.
- **Why the fallback never ran:** `find -exec … \;` does not return cp's status, and `2>/dev/null` hid the error. Only the
  final manifest compare caught it.

## The fix

1. **`tools/copy-artifacts.py`** replaces line 123:
   - the destination `out/` must not exist, and it is created **before** any copy;
   - it copies only the reviewed manifest paths (strict grammar, no `..`, never `build-info`), and the source must hold
     exactly those files;
   - every source is a regular non-symlink file whose bytes equal the manifest hash; every destination is created exclusively
     and re-hashed;
   - the final set is checked;
   - any deviation exits 9 in the runner. The caller's independent manifest compare (r11 line 124) is unchanged.
2. **`amanifest`** now fails with exit 9 on a hashing failure or an empty manifest.
3. **`binfo`** records each forge build's raw `out/build-info` hashes as `BUILDINFO-<tree>.sha256`.
   - They are recorded, not compared: they contain build ids and paths.
   - Artifact reuse still excludes the bookkeeping and still compares the contract artifacts byte for byte (the contracts
     proof is unchanged).
   - Copied trees are listed in `ARTIFACT-REUSE.txt` with their source build.
4. **Other copies:** the stack-test copy exits 9 on failure. The receipt reuse/store copies inside `run1`, which runs in
   `$(…)`, make a failed copy return a **non-clean** result, never a pass, and no `.rc` is written.
5. **Phase A** runs `tools/test_copy_artifacts.py`: exactly 12 tests, no skips.
   - It reproduces r11's actual line-123 command, showing the flattened shape with exit status 0.
   - It then shows the helper's exact shape and every refusal (an existing `out/`, path grammar, byte mismatch, extra or
     missing files, a symlinked source or destination, a malformed or unsorted manifest, usage).
   - It statically checks that the runner uses the helper, has no `2>/dev/null` in B2, and checks the copies.

**Every other r11 guard is unchanged:** the pins, refs, closures, forge and solc identity, the two-build identity, the bytecode
presence check, the overlays, receipts, auditor and native inputs.

**Semantic build-info comparison:** the strict method in `standalone-mcp-authority-stage/r4/SHARED-NOTE-artifact-comparison.md`
is **not** adopted here. Its own condition, root's MCP r4 tests passing, is not met.

## Root (same pattern as r11)

```
./jobs/q-exit-status.sh rpc-runtime-composition-r12-pre 2560 unshare -rn bash rpc-runtime-composition-stage/r12/jobs/r12-build-validate.sh --preflight
./jobs/q-exit-status.sh rpc-runtime-composition-r12-1 2560 unshare -rn bash rpc-runtime-composition-stage/r12/jobs/r12-build-validate.sh
```
