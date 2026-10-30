# final-consumer-composition-stage/r3: the relay reader runtime in the MEASURED guest + a strict package harness (prepared; NOT run)

**Tree `7dc8f16281a0668f8773caa3d0652d54293bb30f`** (`FINAL-TREE`):
- = r2 `20dbe573` + `patches/guest-sidecars-vs-r2.patch` (2 files);
- = base `64156dcd` + `patches/final-consumer-r3-vs-64156.patch`;
- blobs in `R3-BLOBS.txt` (54 files). r1 and r2 stay frozen (`inputs/`).

## Changes vs r2
1. **`scripts/build-platform-api-guest-bundle.mjs`:** `SIDECARS` gains `derived-reader-runtime.bundle.mjs` ← `relay/derived-reader-runtime.bundle.mjs` and `schedule_reader.mjs` ← `relay/schedule_reader.mjs`.
   - The guest manifest records their sha256.
   - The unchanged `metal/build-image.mjs` copies every manifest sidecar beside `/opt/metal/platform-api.bundle.mjs`, verifies its hash and records it in the image's measured content.
   - In the guest, `api-relay.js` resolves its module-relative URL to `/opt/metal/derived-reader-runtime.bundle.mjs`, which now ships.
   - This is a transparent MEASUREMENT CHANGE: a new guest image, which needs SNP/image qualification.
   - Release order: `relay/build-derived-reader-runtime.mjs` runs BEFORE the guest bundle builder, because the sidecars are generated.
2. **`test/relay-derived-reader-runtime.test.mjs`:** 4th test.
   - The regenerated guest manifest names both sidecars with their hashes, and the guest bundle carries no reader code but resolves the runtime beside itself.
   - An `/opt/metal` layout assembled exactly as `build-image` does it loads the runtime (3 functions).
   - Removing `schedule_reader.mjs` refuses.

## Root's corrections, adopted
- **Harness (root 1320):**
  - dependencies are BIND-MOUNTED read-only as in-tree `node_modules` (`unshare -Urnm`), never symlinked;
  - host-service-package and MCP `--check` must be rc 0;
  - the shared relay runtime must equal its committed pin `e12c5baf` (package mode);
  - no baseline-failure equality anywhere;
  - if `consumer-package-inputs-stage` (da) freezes a different recipe, root adopts that one;
  - if base's committed generated artifacts are genuinely stale, this job FAILS until they are honestly regenerated (da's scope).
- **Evidence:** only package 1320 ran on `33e9cabc`. Paid-v3 `5037054a` receipts do not cover this tree: 4 paid files differ (`derived-runtime.mjs`, `main.mjs`, `onchain-qualification.mjs`, the adapter test; `derived-submission.mjs` is identical). So `integration` and `mutants` rerun the adapter (15), packaging (5 + nested 15) and the 12 mutants FRESH on this tree.

## Root job: `jobs/root-final-consumer-r3.sh`
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh final-consumer-r3-package      768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh package
bash jobs/q-exit-status.sh final-consumer-r3-integration  768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh integration
bash jobs/q-exit-status.sh final-consumer-r3-relay       2560 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh relay
bash jobs/q-exit-status.sh final-consumer-r3-mutants      512 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh mutants
```

**Every mode first:**
- checks the sums of r1, r2, r3, writer r3 and paid r4;
- reproduces the tree two ways;
- checks blobs, the Windows path unchanged, and the shared runtime sources (`relay/network-runtime.mjs`, `network/onchain-qualification.mjs`) = base;
- checks a clean `64156dcd` checkout with lock 9ada1611;
- bind-mounts the dependencies read-only;
- builds the shared relay runtime on base and final, which must be identical;
- runs `build-derived-reader-runtime`;
- requires the guest bundle stale before regeneration and `--check` rc 0 after.

| mode | PASS requires |
|---|---|
| package | runtime = committed pin `e12c5baf`; host-packages and MCP `--check` rc 0 (strict); `build-consumers`; `node --check relay/api-relay.js`; the guest manifest ships the reader runtime + pin (hashes = the relay release copies); `relay-deploy-closure` clean on both sides; `RELEASE.sha256` (relay runtime pair, reader runtime trio, guest bundle + manifest, provider consumers) |
| integration | the writer's 3 startup cases; the relay reader test 4/4; writer 23; KVM 33; paid adapter 15; packaging 5 + nested 15; 10 regression files base == final, all clean |
| relay | the 8 `api-relay.js`-dependent tests, base == final, with `TESTS.tsv` counts |
| mutants | 15/15 baseline, then 12/12 killed |

## Unchanged and pending
- Admin controls and the writer's 120 s ceiling are unchanged; claims remain finalized-only.
- The reader now loads in both the relay host and the measured guest. Writer derivation is still unavailable in practice, because L1-finalized anchors are older than 120 s.
- Still pending: the recent-state / native branch; a real Base derivation; the native v3 / helios / checkpoint assets inside the accepted image; SNP qualification of the new guest measurement; activation.
