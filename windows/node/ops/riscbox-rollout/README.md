# DEFERRED - risc-box 4ba1f56 rollout on nucbox-k11 (NOT deployed, NOT run)

Old artifact: apps/risc-box64-aot-uart.wasm  sha256 05135d5a249556a0473984096c0bb167e86c630eef6d0181ce651faed32f6580
New artifact: not built (build stopped 2026-09-22 when the work was deferred)
Old snapshot key (untouched throughout): risc-perf-agent/warm960-palette-rt0.snap
Live-state key: risc-perf-agent/live-<UTC stamp>.snap

0. (done ahead, no disruption) upload new wasm; `node precomp2.mjs apps\risc-box64-aot-4ba1f56.wasm`.
1. BEFORE numbers, page emulated: `node rbpage.mjs 120` (optionally `... 120 lat` with a fork).
2. FREEZE: `powershell -File rbdetach.ps1 "node rbsnapnow.mjs risc-perf-agent/live-<stamp>.snap 1" rbsnapnow.out`
   - desktop + terminal frozen for serialize + upload (estimate 6-12 min), guest state captured incl. disk.
   - done when rbsnapnow.log shows HTTP 200 with snapshotMs/uploadMs. ssh sessions into the guest die.
3. SWITCH: `node rbswitch.mjs C:/Users/claude/vbs/node/apps/risc-box64-aot-4ba1f56.wasm <NEW> risc-perf-agent/live-<stamp>.snap`
4. RESTART node: `powershell -File rbstart.ps1` - all 5 tenants relaunch; risc-box re-downloads kernel+rootfs+
   the new snapshot from R2 (~11+ min) and RESUMES the captured state (restore itself ~0.5 s).
5. AFTER numbers: `node rbpage.mjs 120` (+ fork keylat), rbboot.mjs, rbsample.mjs.
ROLLBACK: `node rbswitch.mjs C:/Users/claude/vbs/node/apps/risc-box64-aot-uart.wasm 05135d5a...6f580 risc-perf-agent/live-<stamp>.snap`
   then rbstart.ps1 - the OLD build resumes the SAME captured state (snapshot format is unchanged by 4ba1f56).

## Status (2026-09-22)

DEFERRED by the user in favour of the native-isolation platform work (`isolation/DESIGN.md`). Nothing
here has been run against the live guest: no snapshot was taken, node-config.cmd was not changed, the
node was not restarted, and the new artifact was never built to completion. The live instance still
runs 05135d5a. The source fix is enclave-apps `4ba1f56` (tested, mutation-checked, pushed).

Read-only measurement tools (already used, safe): rbsample.mjs, rbping.mjs, rbboot.mjs, rbturns.mjs.
Native snapshot timing of the warm desktop (boot-bench, one core): level 2 2.11 s / 97.6 MB, level 1
0.96 s / 101.4 MB; the in-enclave freeze is an ESTIMATE (x200-380 interpreter factor), not measured.
