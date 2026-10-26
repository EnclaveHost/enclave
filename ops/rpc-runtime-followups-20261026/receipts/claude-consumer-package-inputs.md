# consumer-package-inputs-stage: why root 1320's package run is not deployment-qualified, and the corrected harness (PREPARED; not run)

**Scope:**
- **Read:** `final-consumer-composition-stage/runs/20261026T130057Z-package-1764720/{verdict.json,logs/*}`, the frozen job, and the candidate tree's generators.
- **Not done:** no build, test, queue job, live action or commit.
- **Unchanged:** the frozen stage (SHA256SUMS **320848ec**) and its job (**3692b655**). The other agent's `final-consumer-composition-stage/r2` was not touched.

## 1. Root cause: symlinked `node_modules` escape the tree
- **The layout:** `rpc-final-candidate-20261026/tree/{node_modules,network/node_modules,relay/node_modules}` are themselves **symlinks** to `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/{,network/,relay/}node_modules`. The job then links each exported side to those links (`root-final-consumer.sh:65`).
- **What esbuild does:** it resolves real paths, so metafile inputs become `../../../../../enclave/node_modules/...`. Each generator records inputs relative to the builder root (`relay/build-network.mjs:9-12`; `scripts/locked-inputs.mjs:1-5`).
- **Three consequences, on both sides (so this is not a consumer change):**
  1. **`host-packages-check` rc 1 on pristine and final:** `locked-inputs.mjs:24` correctly refuses `bundle input outside the tree: ../../../../../enclave/node_modules/abitype/dist/esm/version.js`.
  2. **Runtime bundle `18f8fccb…` ≠ committed pin `e12c5baf…`:** the bundle bytes and manifest `inputs` embed the escaped paths. The pin is committed in `network/host-services/packages/route-dns.package.json:36` and `metal/guest/platform-api.bundle.mjs.manifest.json:489`.
  3. **`platform-api-check` rc 1 on pristine:** that bundle lists `relay/network-runtime.bundle.mjs` = e12c as an input, so the base itself looked "stale" only because the runtime bundle was built in the wrong layout.
- **Evidence that the pin expects real in-tree `node_modules`:**
  - The committed `route-dns.package.json` lists its inputs as `node_modules/@noble/curves/esm/...`, in-tree.
  - The pin was produced by `debbfb377` ("compose: regenerate generated bundles from the composed sources (r4 job, private)").
  - The earlier `composition-baseline-fixes-stage/jobs/root-baseline-fixes.sh:36` used real copies.
  - The real trees contain no package symlinks (searched to depth 3) and total about 151 MB (99 + 11 + 41), not gigabytes.
- **Consequence for 1320's release output:** its "regenerated" platform-api guest bundle `500e38e0…` (manifest `7b5a1bfa…`) was built from the layout-contaminated runtime bundle 18f8. **Do not use it as a release or measured-image artifact.**
- **Root 1320's own verdict was baseline equivalence:** `ok` required `host-packages pristine == final`, and also required platform-api final ≠ 0 (`root-final-consumer.sh:183,189`). So two failures compared equal and passed. That is exactly what must not qualify a deployment.

## 2. Corrected harness (new stage `consumer-package-inputs-stage/`, SHA256SUMS **9c60f5d7a5664461d40be6d7af56b28ca0bac44f5d1de5f1bc0f7c562be1d228**)
| File | sha256 (16) | Role |
|---|---|---|
| `patches/root-final-consumer.orig.sh` | 3692b6558160d759 | The frozen job, byte-identical |
| `patches/root-final-consumer.package-inputs.patch` | a0eb2a08af3faf96 | The only change (101 lines). It applies cleanly; checked here with `patch`, no build or test |
| `patches/root-final-consumer.package-inputs.sh` | 4ad09d4dff82a7fe | The patched derivative |
| `jobs/root-package-inputs.sh` | 3ee6e30c5e4069e8 | Root entrypoint |

**What the patch changes** (marked harness blocks only; the rest of package mode is untouched: P2 platform-api regeneration, P3–P5 consumers/provider/startup/API/relay-closure):
- **Dependencies:** `ln -s` is replaced by, per side, for `node_modules`, `network/node_modules` and `relay/node_modules`:
  - `mkdir`, then `mount --bind $(readlink -e $T/$d)`, then `mount -o remount,bind,ro`;
  - it then asserts the mount is `ro`, is not a symlink, and that `readlink -f` equals the in-tree path;
  - the binds are logged to `node-modules-binds.txt`.

  Nothing is copied. Mounts live only in the job's private namespace and are unmounted before the tree cleanup (`rm -rf --one-file-system`).
- **In-tree inputs:** after each `relay/build-network.mjs`, every manifest input must be inside the tree (no `../` or absolute path), recorded in `runtime-inputs--<side>.json`. Otherwise the job dies.
- **Genuinely stale host-service packages on final:**
  - keep the committed copy;
  - regenerate with the tree's own `scripts/build-host-service-packages.mjs`;
  - `--check` must then pass;
  - keep the exact `host-packages-regenerated.diff`;
  - copy the packages to `release/host-packages`.
- **Verdict (actual success, no equivalence):**
  - runtime bundle on pristine **and** final == **e12c** (`matchesCommittedPin`), identical on both sides, zero out-of-tree inputs;
  - **host-packages pristine == 0**, and final == 0 or (stale and regenerated `--check` == 0);
  - **mcp pristine == 0 and final == 0**;
  - **platform-api pristine == 0**, and the regenerated check == 0;
  - every regenerated release output is listed in `reviewRequired` (host packages, platform-api guest bundle and manifest);
  - `harness` names the derivative.

  No outside-tree check is silenced and no pin is relaxed. `locked-inputs.mjs` and all generators run unmodified.
- **Outputs** go to `consumer-package-inputs-stage/runs/`. The frozen stage is only read, and its own `sha256sum -c` still runs at the end.

**Root command** (bounded: the shared queue, the frozen package mode's 768 MiB, and a private user+net+**mount** namespace):
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
bash jobs/q-exit-status.sh consumer-package-inputs-1 768 unshare -Urnm bash consumer-package-inputs-stage/jobs/root-package-inputs.sh
```

**What the entrypoint checks before running anything:**
- this stage's SUMS;
- the frozen stage's SUMS == 320848ec and every entry;
- the frozen job == 3692b655 == `orig.sh`;
- that the patch applied to a private copy gives exactly 4ad09d4d (and equals `package-inputs.sh`);
- that the private mount namespace works (a probe bind).

It then prints the harness identity and runs `package`.

## 3. What the result will and will not show (no claim made now)
- **If the runtime pin e12c reproduces on both sides** and every pristine check passes, the committed generated artifacts are proven against a real in-tree, lock-checked dependency tree. Then the consumer's real staleness (if any) is visible, regenerated and listed for review. That is actual package validation.
- **If e12c still does not reproduce** under in-tree inputs, the verdict fails (no relaxation). The remaining suspects would be content drift between `work/enclave/**/node_modules` and the tree used at `debbfb377` (the lock is the same 9ada1611, and `locked-inputs` checks installed versions), or an esbuild/node version difference. The next step would be a read-only comparison of the regenerated runtime manifest `inputs` against the version pins recorded at `debbfb377`, not a new pin.
- **Not proven by any outcome:** fresh-state authority, feature availability or production. The frozen verdict's scope string is unchanged.

## 4. Patch recipe for the other relay/reader owners (adopt in their own stages; not applied here)
The same `ln -s` pattern exists, and has the same defect, in:
- `final-consumer-composition-stage/r2/jobs/root-relay-reader-r2.sh:50` (owned by Claude370; **not edited**);
- `paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh:60-61`.

**Recipe:**
1. Run under `unshare -Urnm` (add `m`).
2. Replace each `ln -s $T/<d> $OUT/$side/<d>` with:
   ```
   src=$(readlink -e $T/<d>) && [ -d "$src" ] || die "no real <d>"
   mkdir $OUT/$side/<d> && mount --bind "$src" $OUT/$side/<d> && mount -o remount,bind,ro $OUT/$side/<d> || die "ro bind <d>"
   findmnt -no VFS-OPTIONS $OUT/$side/<d> | grep -qE '(^|,)ro(,|$)' && [ "$(readlink -f $OUT/$side/<d>)" = $OUT/$side/<d> ] || die "<d> not in-tree ro"
   ```
3. After any esbuild generator, refuse manifest inputs that start with `../` or `/`.
4. Unmount before removing the exported trees.
5. In verdicts, require committed-pin matches and actual check success. Never accept pristine-failure == final-failure.
6. The exact text is in `consumer-package-inputs-stage/patches/root-final-consumer.package-inputs.patch`:
   - hunk 3 (`@@ -62,10`): the ro binds and the in-tree input check;
   - hunk 5 (`@@ -175,18`): the verdict rules;
   - hunk 6 (`@@ -227,5`): unmount before cleanup.
