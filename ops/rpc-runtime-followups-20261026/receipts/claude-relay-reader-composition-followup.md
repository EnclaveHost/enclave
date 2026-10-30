# Relay reader composition follow-up: final-consumer-composition-stage/r3 (2026-10-26)

**Status:**
- Frozen and prepared. NOT run by Claude: no tests, queue, builds, live changes or commits.
- r1 (`320848ec`) and r2 (`2da987bd`) are unchanged.
- `consumer-package-inputs-stage` (da) was not edited. At the time of writing it has no report yet: only its task note `logs/consumer-package-inputs-1327.txt` exists.

## Corrections to my earlier reports
- **Evidence actually run:** only root package 1320 ran on `33e9cabc`. I wrongly said r1's integration/mutants evidence "applies"; neither was run on that tree.
- **Paid-v3 receipts do not carry over:** the 1297/1304 receipts are for `5037054a`. On the final trees, 4 paid files differ (`network/wg-provider/derived-runtime.mjs`, `main.mjs`, `network/onchain-qualification.mjs`, `test/paid-derived-adapter.test.mjs`); only `derived-submission.mjs` is bit-identical. The adapter (15), packaging (5 + nested 15) and the 12 mutants must run fresh on the final tree, and r3's job does that.
- **The r2 job must NOT run:**
  - it symlinks `node_modules`, so esbuild records outside-tree inputs and bundle bytes change (runtime `18f8fccb` vs pin `e12c5baf`);
  - it treated equal host-package failure on both sides as acceptable.
  - r3 replaces it.

## Independent review of r2's runtime import and test assertions
No defects found:
- the missing-bundle filter (`ERR_MODULE_NOT_FOUND` + file name) maps to the writer's own "not composed";
- KVM v3 `startDerivedReader`'s refusal order yields the asserted messages ("no qualified native derivation build configured" for an unqualified pin; checkpoint ENOENT for the v3 shape with absent image assets);
- the builder's in-tree vs fresh comparison is byte-stable with in-tree (bind-mounted) dependencies.

## The measured-image gap, fixed (r3)
- **Gap:** `metal/build-image.mjs` ships `platform-api.bundle.mjs` plus the manifest's SIDECARS into `/opt/metal/`. The relay's derived-reader runtime was only scp'd to the relay host, so in the guest the module-relative import would have been absent ("not composed").
- **Fix (minimal; uses the existing mechanism):**
  - `scripts/build-platform-api-guest-bundle.mjs` `SIDECARS` += `derived-reader-runtime.bundle.mjs` (← `relay/…`) and `schedule_reader.mjs` (← `relay/…`);
  - the guest manifest records their sha256;
  - `build-image.mjs` (unchanged) copies them beside the bundle, verifies them and records them in the image.
- **Transparent measurement change:** a new guest image, needing SNP/image qualification.
- **Release order:** `node relay/build-derived-reader-runtime.mjs` → `node scripts/build-platform-api-guest-bundle.mjs` (+ `--check`) → `metal/build-image.mjs`.
- **New 4th test:** the manifest sidecars and hashes; the guest bundle resolves the runtime beside itself and carries no reader code; an `/opt/metal` layout assembled as `build-image` does it loads the runtime; a missing pin refuses.

## Identity
| item | value |
|---|---|
| r3 tree | `7dc8f16281a0668f8773caa3d0652d54293bb30f` = r2 `20dbe573` + `patches/guest-sidecars-vs-r2.patch` (`4a4077fd…`, 2 files) = base + `patches/final-consumer-r3-vs-64156.patch` (`23f58898…`, 54 files). Both reproductions verified with git and patch only. |
| `r3/SHA256SUMS` | `79973859ef8d8f9d166336139612bef11763ccf2cfa18c111f92b2701f9cec66` |
| job `jobs/root-final-consumer-r3.sh` | `a2d07a1b…` |
| `README.md` | `7f65314c…` |

## Root commands (replace r2's job; `unshare -Urnm`)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh final-consumer-r3-package      768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh package
bash jobs/q-exit-status.sh final-consumer-r3-integration  768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh integration
bash jobs/q-exit-status.sh final-consumer-r3-relay       2560 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh relay
bash jobs/q-exit-status.sh final-consumer-r3-mutants      512 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh mutants
```

**Harness:**
- dependencies are bind-mounted read-only as real in-tree `node_modules` (never symlinks), and unmounted before cleanup;
- a read-only bind also means a cleanup can never delete the shared tree.

**Strict PASS** (details in the stage README):
- **package:** the shared runtime equals the committed pin `e12c5baf`; host-packages and MCP `--check` rc 0; the guest ships the reader runtime + pin; deploy-closure clean on both sides; `RELEASE.sha256`.
- **integration:** writer startups 3; relay reader test 4/4; writer 23; KVM 33; paid adapter 15 + packaging 5 + nested; 10 regressions.
- **relay:** 8 tests.
- **mutants:** 12/12.

**Coordination with da:** if da's frozen dependency recipe differs, root adopts it in this job without weakening any check. If base's committed generated artifacts are genuinely stale under in-tree dependencies, package mode FAILS until da's honest regeneration is composed. No pin is relaxed.

## Unchanged
- Admin controls and the writer's 120 s ceiling are unchanged; claims remain finalized-only.
- No public or RPC fallback.

## Pending
- **Writer:** derivation is unavailable in practice (L1-finalized anchors are older than 120 s). The recent-state / native branch is still open.
- **Not yet done:** a real Base derivation; the native v3 / helios / checkpoint assets inside the accepted image; SNP qualification of the new guest measurement; production activation.
