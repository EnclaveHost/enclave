# reader-runtime-composition-stage/r2: KVM reader v3 composed onto the v2 tree. READY for root (offline composition only; NOT run; no positive claim)

**Stage:** `reader-runtime-composition-stage/r2/`, `SHA256SUMS` **`1c75125e58cf0db9753a038214759ff4d3eab8ec302c58fef654d04431743402`**. The private `git/` (alternates only) and `logs/` are excluded from the sums.

**Immutable inputs, verified unchanged:**
- the v2 stage (sums `902786cd`, tree `1df12559`);
- base `64156dcd`;
- the candidate checkout;
- KVM's commit `34a3c0d6d`, read from the existing shared object store (no fetch).

`/home/steven/Projects/enclave` was only read; its HEAD is now `5ca9e61dd`. Its working tree shows one modified `.githooks/scan-crypto-keys.py`. That change is **not mine**: I wrote no file there.

## Exact pins
| Item | Pin |
|---|---|
| KVM v3 commit | `34a3c0d6d4c5aebffffb2492437487c9de74fb66` (parent c66b087ac; chain 64156dcd → 903f107b1 → cc8c9bd4f → c66b087ac → 34a3c0d6d) |
| **r2 composed tree** | **`9dd20e7615ca16f69417309664f95db96640399f`**. Equals base + exactly 32 v3 blobs, and equals v2 `1df12559` + exactly 12 deltas (both routes checked) |
| `composition.patch` (sha `83ba0858…`) | `git diff --binary --full-index 64156dcd 34a3c0d6d -- <32 paths>`. **`git apply --cached` onto 64156dcd gave exactly 9dd20e76** (checked here, private index) |
| `v2-to-r2.patch` (sha `76191d5f…`) | The recorded delta from the v2 tree: 12 files |
| native v3 | `49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa`, `resultVersion` 3, path `/opt/enclave/bin/derivation_harness_lease_v3`. Agrees across `config.v3.example.json`, `native.mjs` `DERIVATION_V3_BUILDS` and `qualification.json` `nativeV3` (source bundle `c990e671…`, 14 native checks) |
| native v2 / helios | `f1a6bb0e…` (kept) / `cc962e2b…` |
| KVM docs (blobs) | `COVERAGE.md` d9855b73, `config.v3.example.json` f0778f94, `qualification.json` 1de28993 |

## What changed versus v2
All 12 changes are under the reader:
- **Added:** `COVERAGE.md`, `config.v3.example.json`, `coverage-store.mjs`, `coverage.mjs`, `test/derived-reader/coverage.test.mjs`.
- **Modified:** `README.md`, `native.mjs` (v3 build pin; output bound 1 MiB → 16 MiB), `proof.mjs` (`bindNativeV3` + `validateCoverage`), `provider.mjs`, `qualification.json`, `test/derived-reader.test.mjs` (+coverage import), `test/derived-reader/provider.test.mjs` (one error regex relaxed to `/closed|failed/`).

**Minimal closure:**
- The new outside imports are `../lease-release-journal.mjs` (strictWriteFile) and `../runtime-lock.mjs`. Both blobs are **identical in base and in v3**, so they are reused, not added.
- The lifecycle closure files from v2 (bridge, deployment-lifecycle-journal, restart-policy, bridge test) are unchanged from c66 to 34a3.
- **Excluded:** the same 32 lifecycle contracts, deploy defaults and tests as v2 (listed in `COMPOSITION.json`). No node_modules copy, binary or operator config.

**Policy guards:** I did not edit any composed file; every file is KVM's committed blob. The guards are therefore exactly KVM's.

## Root job (prepared; NOT run: root's paid-full job holds the lane; no queue job was started)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh reader-v3-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/r2/jobs/root-reader-v3-composition.sh
```

**What it proves, from the read-only objects:**
1. The r2 and v2 stage sums.
2. The 34a3 lineage.
3. The r2 tree reproduces two ways, and the r2 file set equals the v2 files plus the v3 delta.
4. `composition.patch` on a clean base export, and `v2-to-r2.patch` on a clean v2 export, each reproduce the tree.
5. Nothing outside the composed set references the reader, so defaults are unchanged.
6. The v3 pins agree. Qualification says `productionActivated`, `livePositiveBaseDerivation` and `acceptedImageQualified` are all false. The example config has `initializeState: false`.
7. Module closure over all composed `.mjs` files (bare imports are only `node:*`/viem), `node --check`, and a runtime import of provider, coverage, coverage-store, lifecycle, api, bridge and journal.
8. **KVM's 33 tests, exact**: provider 8 + boundaries 8 + coverage 13 + bridge 4, with no skip, todo or cancel. Three tests are also **required by title**:
   - "a real bridge callback can make both coverage queries without a reentrant reader lock" (`readDerivedLogs` inside the snapshot, no deadlock);
   - "logs require exact snapshot identity and covered range…";
   - "full v3 runtime opens private coverage under its ownership and refuses missing history on restart".

**Checked here without tests:** bash syntax, the title regex, and the pin step run against KVM's three files (output: `v3 pins agree`).

## Requirements for activating writer/paid on the next combined candidate (NOT composed here)
1. **Tree:** compose the writer (Claude50) and paid (Claude370) blobs on top of **r2 `9dd20e76`**, by the same mechanism: base + listed blobs, a full-index patch from 64156dcd, and a delta from r2. Their imports must resolve to the **r2** reader modules (provider/`readDerivedLogs`/coverage), not to v2.
2. **Generated bundles:** none contains the reader today; step 5 proves it. The manifests record the exact sha256 of every input, so if any bundle entry's import closure reaches a reader, writer or paid module, that bundle must be **regenerated from the combined tree** and its manifest must list those inputs at their combined-tree sha256. Following the debbfb377 precedent (a private regeneration job):
   - **Guest bundles:** `metal/guest/{platform-api,mcp-server,lease-gas-conduit,host-policy}.bundle.mjs` and `.manifest.json`. Regenerate with `scripts/build-platform-api-guest-bundle.mjs` / `scripts/build-mcp-guest-bundle.mjs`, then run `--check`, which refuses a stale bundle.
   - **Host-service packages:** `network/host-services/packages/*.mjs` and `.package.json` (`enclave-host-service-package/v1`, `bundleSha256`). Regenerate with `scripts/build-lease-relay-host-package.mjs` and `network/host-services/roles.mjs`.
   - Any new writer/paid host role needs its own package entry in that format.
   - **Not checked here:** which of these bundles writer/paid actually reach. That depends on their entry points, which are not composed.
3. **Host role only:** the reader uses `node:fs`, a private state dir, and spawns the native 49f4 binary and helios. It must be packaged as a **host role**, never inlined into a guest/wasm bundle.
4. **Deploy inputs** (root/deploy, not source):
   - `config.v3` values (`stateDir /var/lib/enclave/derived-reader-v3`, `initializeState` false, ports 18760/18761, `historyMaximumBytes` 4 GiB);
   - the native binary at the pinned path with sha 49f4;
   - helios cc96 and the checkpoint policy file.
   - The v2 config cannot silently enable history; the v3 startup test enforces this.

## Not claimed / remaining
- Root runs the r2 job (33/33), then reviews, materialises and commits it (root's decision).
- Compose writer/paid after root qualifies them.
- Live positive Base derivation, accepted-image/SNP qualification and production activation all remain open; qualification.json says so itself.

No SSH, network, live, production, resource-config, commit or queue/test job. No Claude background process is left running.
