# Integration recipe, cold-proof-timeout-stage/r3 (for 50cf; PROPOSAL until root's tests + composition qualification + canary pass)
r3 supersedes r1/r2 (r1: no post-run budget check; r2: test spawnSync deadlock + fractional AbortSignal timeout). Base: r12-final, root qualification PASS, pushed cc30bb890e7f910e99d017f741917735dd3e2d56, NOT activated; never edited.

## 0. Order
1. root: `python3 -u ../claude-test-queue.py --mib 256 --log cold-proof-timeout-stage/r3/logs/root-cold-proof-tests.guard -- unshare -rn bash cold-proof-timeout-stage/r3/jobs/root-cold-proof-tests.sh` -> `PASS cold-proof-tests r3 transport 13 a1-anchor N/N a1-recheck M ...`.
2. 50cf: (r12-final qualification PASS; r12-final is never edited), compose a NEW stage from r12-final + this stage's readers.
3. root: that stage's own qualification job (its suites incl. capture-r10 / capture-closure / integration / reproof re-run on the new capture pins).
4. fill `canary/COMPOSED-STAGE-PINS.json` from the frozen composed stage, re-freeze this stage (SHA256SUMS changes), re-run step 1 (the canary gate requires a PASS RESULT for the CURRENT stage bytes), then the canary (queue 768):
   `python3 -u ../claude-test-queue.py --mib 768 --log cold-proof-timeout-stage/r3/canary/logs/root-cold-proof-canary.guard -- bash cold-proof-timeout-stage/r3/canary/jobs/root-cold-proof-canary.sh`
   Cold recovery is VERIFIED only if the receipt shows the capture flow passed AND `coldProof.exercised == true` (a proof request > 20 s
   succeeded through the relay). Even then it shows a > 20 s proof was survived, NOT that the OS page cache was cold. A pass with
   `exercised == false` (warm) does NOT prove the fix; re-run later after the finalized
   block has advanced with no other proof activity, or record it as unproven.

## 1. New origins (bundle-origin.json entries; origins = THIS stage, never source/)
| bundle entry | new origin | sha256 |
|---|---|---|
| bundle/a1-capture/l1-anchor-a1/a1-read.mjs | cold-proof-timeout-stage/r3/src/l1-anchor-a1/a1-read.mjs | da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274f85 |
| bundle/a1-capture/a1-original-game-prepared/a1-read.mjs | cold-proof-timeout-stage/r3/src/a1-original-game-prepared/a1-read.mjs | da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274f85 |
| bundle/a1-capture/a1-original-game-prepared/a1-recheck-read.mjs | cold-proof-timeout-stage/r3/src/a1-original-game-prepared/a1-recheck-read.mjs | 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825 |

## 2. Exact pin cascade (output of `python3 -I tools/cascade_plan.py`, read-only, over r12-final at SHA256SUMS 9de0d8d7...)
Re-pin in this order; each edited file's NEW sha replaces its old sha in every later file. Historical `integration*/` patch files of
r10/r11 are RECORDS: do not edit them; add new `integration-<new>/` patches for the new edits (as r12-final did). Installer
qualification strings change to the new stage name (as in r12-final). No other product logic changes.
```
 1. bundle-origin.json  [current sha 3b4f5ad66aafeb05]
      names a501a3ec56ebd56e... (a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274) at lines [7, 35]
      names 41b83975e96fc816... (a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825) at lines [27]
 2. capture/a1_capture.py  [current sha 47c49b114e6d596a]
      names a501a3ec56ebd56e... (a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274) at lines [56, 61]
      names 41b83975e96fc816... (a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825) at lines [54]
 3. harness/a2a4.py  [current sha 6c1d0b1bf767aceb]
      names a501a3ec56ebd56e... (a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274) at lines [76]
      names 41b83975e96fc816... (a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825) at lines [74]
 4. harness-first/a2a4.py  [current sha dbd4cbe37f9f3e43]
      names a501a3ec56ebd56e... (a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274) at lines [75]
      names 41b83975e96fc816... (a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825) at lines [73]
 5. install/MANIFEST.json  [current sha c8da92df2cb6eb9a]
      names a501a3ec56ebd56e... (a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274) at lines [259, 301]
      names 41b83975e96fc816... (a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825) at lines [289]
 6. CANARY-R3-RECIPE.md  [current sha 5cf1b7363547db1d]
      names 47c49b114e6d596a... (capture/a1_capture.py (re-pinned)) at lines [3]
 7. COMPOSITION.tsv  [current sha 3e48b7dcb6f1c660]
      names 3b4f5ad66aafeb05... (bundle-origin.json (re-pinned)) at lines [8]
      names 47c49b114e6d596a... (capture/a1_capture.py (re-pinned)) at lines [9]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [12]
      names dbd4cbe37f9f3e43... (harness-first/a2a4.py (re-pinned)) at lines [10]
      names c8da92df2cb6eb9a... (install/MANIFEST.json (re-pinned)) at lines [14]
 8. SHA256SUMS  [current sha 9de0d8d7664516fa]
      names 3b4f5ad66aafeb05... (bundle-origin.json (re-pinned)) at lines [8]
      names 47c49b114e6d596a... (capture/a1_capture.py (re-pinned)) at lines [9]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [12]
      names dbd4cbe37f9f3e43... (harness-first/a2a4.py (re-pinned)) at lines [10]
      names c8da92df2cb6eb9a... (install/MANIFEST.json (re-pinned)) at lines [14]
 9. integration/harness_a2a4.py-r10.patch  [current sha ab30f7afbd1b9538]
      names 47c49b114e6d596a... (capture/a1_capture.py (re-pinned)) at lines [8]
10. integration/install_MANIFEST.json-r10.patch  [current sha 4da0b5774b67ba9a]
      names 47c49b114e6d596a... (capture/a1_capture.py (re-pinned)) at lines [61]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [25]
11. integration/producer_base_launch.py-r10.patch  [current sha 2aa3b0b76d6db531]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [8]
12. integration/recovery_forward_sync.py-r10.patch  [current sha 2f642c6fb0771684]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [8]
13. integration/tool-runtime-pin-harness-pin.patch  [current sha 390f36bdc994df15]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [8]
14. producer/base_launch.py  [current sha 2f9450cd5c73de3c]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [34]
      names dbd4cbe37f9f3e43... (harness-first/a2a4.py (re-pinned)) at lines [30]
15. recovery/forward_sync.py  [current sha b41e71a30140bf2b]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [443]
16. src/finality_state.py  [current sha 218bbfe56caec03e]
      names 6c1d0b1bf767aceb... (harness/a2a4.py (re-pinned)) at lines [70]
17. integration/src_reproof.py-r10.patch  [current sha 27f7f714e5bec49a]
      names 2f9450cd5c73de3c... (producer/base_launch.py (re-pinned)) at lines [10]
      names 218bbfe56caec03e... (src/finality_state.py (re-pinned)) at lines [9]
18. integration-r11/install_MANIFEST.json-r11.patch  [current sha 1af9a24527544b07]
      names b41e71a30140bf2b... (recovery/forward_sync.py (re-pinned)) at lines [8]
19. src/reproof.py  [current sha cc9ff0b41dc04a5c]
      names 2f9450cd5c73de3c... (producer/base_launch.py (re-pinned)) at lines [26]
      names 218bbfe56caec03e... (src/finality_state.py (re-pinned)) at lines [25]

19 files to re-pin in a composition derived from r12-final; new reader shas:
  a501a3ec56ebd56e... a1-read.mjs (both copies) -> da9a9e9c6eff2dcaae344a2311a7d4824efc3d0895aba766805787067f274f85
  41b83975e96fc816... a1-recheck-read.mjs -> 78df2211342fd73e180f3f771af8078b76888b2687cd993edff081b118f18825
```
Core chain: a1-read/a1-recheck-read -> capture/a1_capture.py MODULES (initial/recheck reader pins) -> A1_CAPTURE_SHA256 + reader pins in
harness/a2a4.py and harness-first/a2a4.py -> HARNESS pins in src/finality_state.py, producer/base_launch.py, recovery/forward_sync.py ->
src/reproof.py (tool/producer pins) -> install/MANIFEST.json (dest shas) + bundle-origin.json -> COMPOSITION.tsv, SHA256SUMS, recipe docs.

## 3. Outer deadlines (inspected; NOT changed here)
- capture(): `a1_timeout=240` is the HARD kill. The reader's monotonic READ_BUDGET 200 s caps each request at dispatch AND is checked
  again after the last request/parse/crypto/evaluation, right before evidence is emitted (finishRead), then the wall-clock age rule.
- capture(): `helios_timeout=90` (Helios first status). Reproof calls capture() with defaults. On the guest, a FRESH Helios datadir
  bootstrapped from the pinned checkpoint took ~120 s (canary r2/r3, which passed 900); the diagnostic's Helios with an existing datadir was
  ready in ~3 s. Production uses a persistent l1-authority datadir, so 90 s is likely sufficient, but a cold/first start can exceed it: a
  separate reviewed decision (measured first-start bound) - not part of this fix.
- Freshness downstream is unchanged: finality_state FRESH_A1_MAX_AGE_SEC 600 / A1_APPEND_MAX_AGE_SEC 1800 still apply to the evidence.
