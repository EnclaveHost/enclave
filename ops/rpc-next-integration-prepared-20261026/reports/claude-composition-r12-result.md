# Composition r12: result (PREPARED; nothing run)

**What Claude did:** reads, writes and static checks only (`bash -n`, Python `ast.parse`, sha256, `git rev-parse` reads).
- **Not done:** no tests, builds, queue jobs, network or SSH access, live actions or branch commits. No scratch git was needed.
- **Untouched:** r11 (frozen; `SHA256SUMS` still verifies), its run directory, and its candidate `2d56a4b193a8f3e0be1b343a1e06970fc193d9f9` (immutable). No MCP and no product source change.

## Root's r11 preflight failure (`logs/root-composition-r11-pre-0305`, exit 9), traced

- **The failure:** `[FAIL] verifier: copied artifacts differ from closure d8b3d3125991`.
- **Which tree:** consumers was the first build and leaseRelay the independent second build of that closure, so verifier, the third, took the **copy** branch, r11 `jobs/r11-build-validate.sh` line 123.
- **What the copy did:** `find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {} $T/contracts/foundry/out/ \;` ran with **no destination `out/`**. The first entry, `out/PaymentRouter.sol`, was copied **as** `out/`.
- **The resulting shape:** against `ARTIFACTS-consumers.sha256`, the run's `ARTIFACTS-verifier.sha256` shows `out/PaymentRouter.sol/{IERC20,IERC20Permit,PaymentRouter}.json` replaced by `out/{IERC20,IERC20Permit,PaymentRouter}.json`. Both manifests have 33 lines.
- **Why nothing stopped it:** `find -exec … \;` does not return cp's status and `2>/dev/null` suppressed the error, so the `mkdir` fallback never ran. Only the final manifest compare caught it.

## r12 (`rpc-runtime-composition-stage/r12/`, `SHA256SUMS` sha256 `00d9a98f99bfe7891a75a19a943e82eb342332ba22e6d4498e45b930b5a5de22`, 35 files)

| File | sha256 |
|---|---|
| `jobs/r12-build-validate.sh` (r11's runner + the changes below) | `30da5baf206e70b4061ee6320744ac8507624bc7059c8abf3fe1bdd316322be2` |
| `tools/copy-artifacts.py` (new) | `e7c4890a33db973d4f270a24b58689406ecfc8f1f7b0b4a19c29ad576294c960` |
| `tools/test_copy_artifacts.py` (new, exactly 12) | `bdd3569b9086b78854eaa4d0650ddd0a60ab38b2499002db34f390a97e5a06cd` |
| `README.md` | `40d455492ef2250d5c25f936a63ba5c30934c1283456e9e595e1179edecb5342` |
| every other file | r11's, byte-identical (`REFS.txt`, `CONTRACT-ARTIFACTS.txt`, pins, tools, stack tests) |

**Changes:**
1. **The line-123 copy is replaced by `copy-artifacts.py`.** The helper:
   - **Destination:** requires that `out/` does not exist (never merged) and creates it **before** any copy.
   - **Paths:** copies only the reviewed manifest paths, the first build's `ARTIFACTS-<first>.sha256`. The path grammar is strict: no `..`, never `build-info`. The source must hold exactly those files.
   - **Bytes:** each source must be a regular, non-symlink file whose bytes equal the manifest sha256. Each destination is created with `O_EXCL|O_NOFOLLOW` and re-hashed, and the final set must equal the manifest exactly.
   - **Failure:** any deviation prints one `REFUSED:` line and the runner exits 9.

   The runner's independent manifest compare (r11 line 124) stays as a second check.
2. **`amanifest`** now exits 9 on a hashing failure or an empty manifest. In r11 its status was unchecked.
3. **Raw build-info is recorded:** `binfo` writes each forge build's raw `out/build-info/*.json` hashes as `BUILDINFO-<tree>.sha256`.
   - They are recorded, **not compared**, because they contain build ids and paths.
   - Artifact reuse still excludes the bookkeeping, and the contracts proof is unchanged (byte-identical contract artifacts, two-build identity, the bytecode presence check).
   - Reuse is logged in `ARTIFACT-REUSE.txt`.
4. **Remaining copies are checked:**
   - the stack-test copy exits 9 on failure;
   - the receipt reuse/store copies inside `run1`, which is evaluated in `$(…)` so an `exit` would only leave the subshell, return a **non-clean** result on failure. That can never count as a pass, and no `.rc` is written.
5. **Phase A additions:**
   - it requires r11's `SHA256SUMS`;
   - it reads r11's `src.git` (only `clone --shared` and `archive`; no writes);
   - it runs the regression with an exact count: `Ran 12 tests` + `OK`, no skips.

   Every other r11 guard is unchanged.

**Regression (`tools/test_copy_artifacts.py`, 12 tests, synthetic, nothing committed):**
- **The original failure:** r11's **actual** line-123 command flattens the first artifact directory into `out/` **and exits 0**.
- **The correct shape:** the helper produces the exact shape and bytes, with no `build-info`.
- **Refusals:** an existing `out/`; path-grammar violations (`..`, absolute, `build-info`, non-JSON), with nothing created; a source byte mismatch; extra or missing source files; a symlinked source; a malformed, empty or unsorted manifest; a symlinked destination; usage.
- **Static runner checks:** the runner uses the helper; there is no `find -exec cp` and no `2>/dev/null` in B2; `amanifest` and `binfo` fail closed; the stack and receipt copies are checked.

**Out of scope:** the strict semantic build-info comparison in `standalone-mcp-authority-stage/r4/SHARED-NOTE-artifact-comparison.md` is **not** adopted. Its own precondition, root's MCP r4 tests passing, is not met. r12 only records the raw build-info hashes.

## Root (same pattern and queue size as r11)

```
./jobs/q-exit-status.sh rpc-runtime-composition-r12-pre 2560 unshare -rn bash rpc-runtime-composition-stage/r12/jobs/r12-build-validate.sh --preflight
./jobs/q-exit-status.sh rpc-runtime-composition-r12-1 2560 unshare -rn bash rpc-runtime-composition-stage/r12/jobs/r12-build-validate.sh
```

- **Preflight PASS:** `## preflight rc=0`. It covers A (including both fixture regressions), B, B2 (every tree's artifacts either built or copied exactly, with the manifest equal to the closure's) and B3.
- **Full run:** r11's exact result rules, unchanged.

## Not established

- **Unrun:** the helper, the regression and the preflight.
- **Unknown until a run:** whether the remaining trees' rigs, regressions, stack and native tests pass.
- **Never claimed:** r11's other open items (the bundle and auditor manifests; da0's route regression) are not addressed here, and no PASS is claimed.
