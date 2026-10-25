# Combined M7+M10 release: ACTUAL status (root receipts; the build is RUNNING, NOT built)

**As of 2026-10-25 23:53:41Z:** the guest unit `m7-m10-release-1` (MainPID 41714) is **ACTIVE**, compiling. Root's foreground
watcher (65970) is still running.
- **No artifact yet:** no binary, artifact hash, smoke or `release-1` receipt exists.
- **Not established:** nothing is **built, reproduced or deployed**. This file adds receipts only; it claims no release
  result.

## What actually passed (root)

| step | receipt (in `actual-running/`) | result |
|---|---|---|
| preparation tests (`root-combined-release-tests-2352`) | `tests/root-combined-release-tests-2352.{out,guard,rc}` | **rc 0**: stage `SHA256SUMS` verified; `make-watcher.py --check`; **24 compound-gate cases** (P1, N1–N18, and R1–R5 on the ACTUAL evidence) with `failed=0`; **6 watcher monitor controls** PASS; peak 67 MiB |
| test harness | `tests/test-compound-gate.py` `92624ea6…` (root-tightened: every negative must give rc 1 + `[REFUSE]` + empty stderr) | stage `SHA256SUMS` `9f0de11e…`; bundle unchanged `9c9b2e83…` |
| transfer + guest pins (`root-combined-release-guest-2352`) | `transfer/root-combined-release-guest-pins-2352.out` | release stage transferred and verified. The guest's `cli-child-1.{compound.json, launcher.json, out}` equal the collected `79a0beb9`/`09621f4e`/`356466e8`, and the supplement manifest equals `cf75de68…` (99 files) |
| guest preflight | `start/preflight.out` | **rc 0**: bundle `9c9b2e83`; OLD stage `dd9df0ab`; units inactive; **compound gate ACCEPTS** (pinned checker re-run; run 2 stays pass:false); disk **17508 MiB** ≥ 17408; memory 53506 MiB |
| job pre-build checks | `start/release-start.out` | toolchain and pins OK; **source manifest `58c572cb…` (2533 files) == expected == run-2 tested tree**; `Cargo.lock` `f122da76`; M7/M10 gates OK; reused cargo home **1535 registry + 110 git, fsck True**; build started **23:51:53Z**, one job |
| unit status snapshot | `start/status.out` | 23:53:41Z ActiveState=active, MemoryCurrent about 913 MiB, guest available 53105 MiB, disk free 17026 MiB |
| precheck | `start/precheck.out` | empty: the watcher's no-prior-attempt precheck passed |
| root scripts | `root-scripts/root-combined-release-{tests,after-tests,launch}-2352.sh` | as run by root |

**Isolation, unchanged:** the same 12G cap, CPU 200%, guest 16 GiB and host 16 GiB floors, 8 GiB disk floor and offline
build.

## Not included (still changing or not yet existing)

- **Still changing:** `logs/root-combined-release-guest-2352.out`, the live watcher log of the active build (it has no
  `.rc` yet), and `outputs/…/m7-m10-release-1/remote.out`.
- **Not yet existing:** the build output, the binary, and any release receipt.

## Which files are which in this publication

- **Byte-identical copy of the FROZEN stage** `finality-stage/m7-m10-combined-release/` (unchanged while the build runs):
  every file listed in `SHA256SUMS` (`9f0de11e…`, 42 files). That covers `README.md`, `bundle/` (`9c9b2e83`), `host/`,
  `tests/`, `tools/`, `proof/`, `superseded-v1/` and `superseded-v2/`.
- **Root-added (actual receipts and scripts), not part of the stage:** `actual-running/**` (11 files).
- **Publication-only:** `ACTUAL-STATUS.md` (this file) and `PUBLICATION-SHA256SUMS`, which covers every file here.
