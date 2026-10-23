# frozen-1726 export: how to rebuild

"1726" is this batch's identifier: its actual start, 2026-10-23T17:26Z (`date -u`). It is not a publication time.

This is the resource-repair batch only. It is SOURCE + EVIDENCE: nothing here is merged into the normal tree, imaged or deployed by
this capture. **The whole CPU resource fix is NOT complete.** The node coupled-share accounting is active on the NucBox (root's
operation, recorded in node-report). The CPU manager/guest rollout is pending, and guest cgroup enforcement is not yet native.

Every side was exported from Git objects only, as a FIRST-PARENT series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- there are no merges and no source-only derivatives in this batch;
- hunk headers carry no function context (a `diff=nofunc` attribute). This is cosmetic, and `git apply` ignores it.

Each changed file is also stored at its head blob under `files/`. `INVENTORY.json` records, per commit, its hash, parent, tree,
author and committer (all SteveDeFacto / noreply), its time and its subject.

## Exact trees

| Side | Base | Commits → head (tree) |
|---|---|---|
| node-shares | d281007c (pushed in 1219a988: `rpc-native-codec-export` side c, 6th commit, tree a9eeada5) | 0f1ef848 installed baseline (ab399272) → 14b24592 (933292a5) → **a5e155ec** (609d98c8) |
| cpu-enforce | 0f1ef848 (node-shares' 1st commit; the same commit object in both repositories) | 670a753e manager (39648435) → bf376363 test seam (9395b5cd) → **ea6717d2** guest (5b1d4b5a) |
| cpu-oldguest | 670a753e (cpu-enforce's 1st commit) | **15ad0042** old-guest-b (bdf8cee3) |
| node-report | empty tree (root commit) | d10a78cb (ab82a09b) → **33ba0fc3** (f7cd0dd7) |
| root-cpu-canary | empty tree (root commit) | **c516049c** (777366f2) |

To rebuild node-shares:
1. `git read-tree` the `rpc-native-codec-export` side c base (f58e03ec).
2. `git apply --cached` its first 6 stored patches; `git write-tree` must be a9eeada5 (= d281007c).
3. Apply this side's patches in order; each `git write-tree` must equal the recorded tree.

cpu-enforce continues after node-shares' first patch, and cpu-oldguest after cpu-enforce's first patch. The two report repositories
start from the empty tree. `verify-frozen-1726-export.py` does all of this offline from 1219a988's stored patches and this export's
own patches; its output is in `REPRODUCE-CHECK.txt`.

## Native canary kit

`work/coupled-cpu-enforcement-20261023/native-canary/` is captured as frozen source:
- the raw source runner `run-cpu-canary.ps1`;
- `KIT-MANIFEST.json`, `KIT-EXPECTED.json` and `NATIVE-CANARY.txt`.

No prebuilt binary is captured. The seven `kit/` files are not stored a second time. The export asserts that each is byte-identical to its repository blob at both 15ad0042 and ea6717d2 and to its `KIT-MANIFEST.json` sha256. INVENTORY `nativeKit` lists them, and they are restored from the cpu-oldguest or cpu-enforce tree.

## Test results (as reviewed by root; NOT re-run by D)

- **Node source:**
  - new 14/14;
  - defect 6/6 (0/6 on the baseline);
  - client 27/27, memory 1/1, hosting 25/25, isolation 15/15, preclaim 5/5, scan 13/13.
  - The broad suite is 222/233: the same 11 pre-existing baseline fixture failures. These are documented and are **not** called green.
- **CPU:**
  - call chain 11/11 (2/11 on the baseline);
  - guest real-load seam 3/3 (1/3 on the baseline).
- **Native:** root-cpu-canary is a real root-run Hyper-V type-1 canary on the current image.
  - Exact WMI limit and reservation at 1%, 21% and 13%; all guest VPs online; cleanup 0.
  - The 12 original VM IDs and states, and manager PID 2376, are unchanged.
  - No production manager or image was updated. Guest cgroup enforcement is **not** yet native.

## Not archived

- The CPU worker's new build workspace and its outer build and progress files: `build/`, `freeze/`, `scratch/`, `seam-tree/`,
  `baseline-tree/`, `BUILD-*.txt`, the progress files, `run-*.sh` and `logs/`. Also any binary, and its `ROOT-*.txt` coordination notes.
- Untracked files in the node report repository and in root-validation (installed copies, delivery files, rollback copies, job
  logs, root notes, live-read scripts).
