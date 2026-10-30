# reader-runtime-composition-stage/r2: KVM reader v3 onto the qualified v2 tree (integration preparation)

**Status:** integration preparation only. There is no SNP, no positive Base derivation, no accepted image and no production activation. Writer and paid are **not** composed.

## Pins
| Item | Pin |
|---|---|
| base | `64156dcd91ff1e769e74f9c26a846be19254c716` (unchanged) |
| v2 tree | `1df125598825fb5278fe6af96a50a69b46679a1c` (stage sums 902786cd; unchanged) |
| KVM v3 | `34a3c0d6d4c5aebffffb2492437487c9de74fb66`, parent c66b087ac. Read from the existing shared object store; no fetch |
| **r2 tree** | **`9dd20e7615ca16f69417309664f95db96640399f`** |
| native v3 | `49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa`, result version 3. Agrees across `config.v3.example.json`, `native.mjs` `DERIVATION_V3_BUILDS` and `qualification.json` `nativeV3` |
| native v2 | `f1a6bb0e…` (kept) |
| helios | `cc962e2b…` |

**How the r2 tree is built.** It equals base + exactly 32 v3 blobs. It also equals the rebuilt v2 tree + exactly the 12 c66→34a3 deltas, all under `network/derived-reader/**` or `test/derived-reader*`:
- **Added:** COVERAGE.md, config.v3.example.json, coverage-store.mjs, coverage.mjs, coverage.test.mjs.
- **Modified:** README.md, native.mjs, proof.mjs, provider.mjs, qualification.json, derived-reader.test.mjs, provider.test.mjs.

**New outside imports.** These are `../lease-release-journal.mjs` (strictWriteFile) and `../runtime-lock.mjs`. Both blobs are identical in base and in v3, so they are reused, not added.

**Excluded.** The same 32 lifecycle-contract, deploy-default and test paths as v2 are excluded; they are listed in `COMPOSITION.json`.

## Files
- **`COMPOSITION.json`:** files (blob, mode, origin, role), `deltaFromV2` (v2 blob → r2 blob), excluded paths, pins, and tests (33 = provider 8 + boundaries 8 + coverage 13 + bridge 4).
- **`composition.patch`:** `git diff --binary --full-index 64156dcd 34a3c0d6d -- <32 paths>`. This is the combined final v3 reader closure, and it applies cleanly to 64156dcd.
- **`v2-to-r2.patch`:** the recorded delta from the v2 tree (12 files).
- **`jobs/compose-r2.py`:** the deterministic generator (git objects only).
- **`jobs/root-reader-v3-composition.sh`:** the ROOT job (prepared, not run).

## Root job
Shared queue 768, run only after the current paid-full job:
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh reader-v3-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/r2/jobs/root-reader-v3-composition.sh
```

**What it checks:**
1. The r2 and v2 stage sums.
2. The 34a3 lineage.
3. The r2 tree reproduces two ways, and both patches reproduce it from clean exports.
4. Nothing outside the composed set references the reader.
5. The v3 pins agree, and qualification claims no activation, positive derivation or accepted image.
6. Module closure, `node --check`, and a runtime import load of provider, coverage, coverage-store, lifecycle, api, bridge and journal.
7. **KVM's tests, 33/33 exact**, with no skip, todo or cancel. Three tests are also required to pass by title:
   - the real bridge callback making both coverage queries without a reentrant reader lock (`readDerivedLogs` inside the snapshot, no deadlock);
   - exact snapshot identity/range for logs;
   - full v3 runtime private coverage ownership and restart refusal.

**What it does not use:** no native binary, no network, no config or production path. node_modules are linked read-only from the candidate checkout (lock 9ada1611).
