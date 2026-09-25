# U1: three serving partitions at once on one node (run 120744)

**What was checked.** enclave-63's multi-partition functional harness (windows/isolation-manager `0513ced0`,
`multi-accept.mjs` `16368fb6…`), from READINESS.md §4 U1. It runs the package's pinned hello-world as N=3 deployments
at once on the real manager and real Hyper-V. The names differ, and the small policies differ so the AppIDs differ.

**Scope: functional serving only.** There is no in-guest probe, probe domain or customer app, and nothing touches the
parked probe, report or memory work. This is not an isolation or host-exclusion result; `host_excluded=no`. The
data plane's refusals are routing hygiene against the manager's own record, not a verifier (READINESS.md §1.7).

- Box: nucbox-k11, Secure Boot ON.
- Box clock: harness start 12:07:44Z, result 12:09:04Z, 2026-09-25.
- Evidence directory on the box: `C:\Users\claude\vbs-evidence\mgraccept-20260925-120744`.
- **Result: MULTI-ACCEPT ALL PASS.** Driver exit 0, harness exit 0. The setting was restored to Absent and the 9001
  service removed, both verified. Afterwards: 0 VMs, no node or vbslike-host process (12:09:50Z).

| Check | Result |
|---|---|
| M0 | Inventory empty, no manager-owned VM; 100363 MiB free of 114508. |
| M1 | 3×201; distinct ids and AppIDs (`9c3d10f1`, `07f5cbd3`, `7fc1fbd9`) at memMiB 128/144/160. |
| M2 | All 3 running on 3 distinct VMs, with 3 distinct launcher keys and 3 distinct transport keys; 93919 MiB free with 3 running (about 2.1 GiB each). |
| M3 | Each answers through its own data-plane route: TLS on exactly the manager's verified key, then `200 "Hello World!\n"`. The body sha256 equals the package's pin `03ba204e…`. |
| M4 | A's key on B's route: "NO the instance's verified transport key is not that key". A's id with B's app: "NO the instance is not that app". |
| M5 | DELETE A: 404, 0 VMs, route "NO no such instance". B and C still answer 200 on their keys. |
| M6 | B's VM turned Off from the host: B failed by the liveness sweep, route "NO the instance is failed". C still answers 200. |
| M7 | Teardown: 0 manager-owned VMs; 100277 MiB free. |

## What ran

- **Tree:** `C:\Users\claude\d1-m1-62965126\control`, the same tree as run 115938 (v39's staged control/ plus
  `62965126`'s six manager files).
  - Hashes at use: `tree-hashes-120744.txt`, 12491 files, list sha256 `745d80f3…`.
  - It differs from 115938's list in ONE file: `windows\node\__pycache__\ipfs_fetch.cpython-314.pyc`, which the
    manager's fetcher (Python) wrote into the tree during run 115938. See the finding below.
- **Harness, outside the package** (`C:\Users\claude\d1-multi-0513ced0\`): `manager-accept.ps1` `e39478eb…`
  (`0513ced0`), `multi-accept.mjs` `16368fb6…`, `restart-accept.mjs` `8d3bdf82…`, `-DataPort 18092`, no phase 1.
- **Guest and launcher:** IGVM `b7ba7731`, launcher `435717de`, runtime.json `ccadb38a`, spawn.json `523983d7`,
  hello-world `9c3d10f1`, master `4f051697`, `hyperv.psm1` `17ca4352`.
- **Before the box run:** the manager, ops, verify and test/windows-* suites pass 416/416 locally at `0513ced0`.

## Finding: the fetcher writes into the control tree

Python writes `__pycache__\ipfs_fetch.cpython-314.pyc` beside the fetcher on first use. Run 094631 ran the manager
directly from v36's staged `pkg\3384e097aa024b73\control`, so it left that file there (written 09:48:34Z). That is a
file v36's manifest does not name. The staged v38 and v39 directories are clean (checked read-only at 12:09:50Z).

Fix: run the fetcher with `PYTHONDONTWRITEBYTECODE=1` or `python -B`. The stray file in v36 is d1's run artifact;
whether to remove it is enclave-63's call, since the package directory is theirs.
