# platform-bundle-closure-stage (PREPARED; not run by Claude; no source edits)

**Purpose:** prove that the generated artifacts depending on the lease seams are complete and consistent: the full closure, built by the real builders in dependency order. It makes no image, SNP or live claim.

## Files

| File | Role |
|---|---|
| `jobs/root-platform-bundle-closure.sh` | The root job. Its header documents every gate. |
| `lib/closure.py` | Helpers: dependency lock and tree digests, the r4 receipt, staleness, manifest pins, git status, and the strict verdict. |
| `expected/generated-artifacts.txt` | The exact 16 generated paths, with builder and kind, in dependency order. The runner refuses to start if its builder table differs. |
| `composition/consumer-1bdf-r4.env` | `MODE=apply` on `1bdf5c432`. **Superseded:** root integrated the 15 paths as `aebf4c932`. Kept for the record; not recommended to run. |
| `SHA256SUMS` | Pins every file above. The runner checks it first. |

## Dependency order (real builders, traced at `1bdf5c432`)

1. **`relay/build-network.mjs`** writes `relay/network-runtime.bundle.mjs` (+ manifest).
   - The output is untracked and gitignored (`.gitignore:115-116`), so it is **always regenerated**.
   - The builder sets no `--check`, no `preserveSymlinks` and no `absWorkingDir`. Its input paths are relative to the working directory, and the platform-api bundle embeds this file.
   - So each clone gets **real copies** of the three dependency roots (digest-verified). The checkout's own untracked copy (`5432bacf…`, with `../../enclave/` paths) is never used.
2. **The two lease bundles:**
   - `scripts/build-windows-lease-runtime.mjs` builds `windows/node/lease-gas-runtime.bundle.mjs` (+ manifest);
   - `scripts/build-metal-lease-gas.mjs` builds `metal/guest/lease-gas-conduit.bundle.mjs` (+ manifest).
3. **`scripts/build-host-admission.mjs`** builds `windows/node/host-admission.bundle.mjs` and `metal/guest/host-policy.bundle.mjs`. These have no manifest; `--check` compares bytes.
4. **`scripts/build-mcp-guest-bundle.mjs`** builds `metal/guest/mcp-server.bundle.mjs` (+ manifest). Its manifest pins the host-admission bundle.
5. **`scripts/build-platform-api-guest-bundle.mjs`** builds `metal/guest/platform-api.bundle.mjs` (+ manifest). It pins the conduit bundle, `measured-control.mjs` and the network runtime.
6. **Check-only, never regenerated here:** `site/vendor/host-policy.js` and `site/vendor/management.js` (+ their `MANIFEST.json`). Their sources are outside the seams, and their builders refuse uncommitted sources.

**Consumers that are NOT built here:** `metal/build-image.mjs` copies and pins these bundles. `relay/deploy.sh` and `scripts/build-host-service-packages.mjs` ship the network runtime. These are release and image steps, out of scope.

## Root command (the proposed default)

Run it **once, on the composed final tree**. Do not run it on `1bdf` or `aebf` (see the report).

1. Write `composition/<name>.env`:
   - copy the `consumer-1bdf-r4.env` fields;
   - set `MODE=integrated` and `BASE=<the composed final commit, full id>`;
   - set `SRC_REPO=<repo holding it>` if that is not relay-consumer-source;
   - keep `R4_RECEIPT` and the pins.
2. Re-pin `SHA256SUMS`.
3. Run:
   ```
   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/platform-bundle-closure-stage
   R4RUN=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r4/runs/20261026T013321Z-385794
   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2048 --log $ST/root-closure.guard -- unshare -rn env R4RUN=$R4RUN TIER=closure COMPOSITION=$ST/composition/<name>.env bash $ST/jobs/root-platform-bundle-closure.sh > $ST/root-closure.out 2>&1; echo $? > $ST/root-closure.rc
   ```

`TIER=full` adds the 7 anvil-backed lease consumers. Use it only if the composition's own test plan does not already run them.
