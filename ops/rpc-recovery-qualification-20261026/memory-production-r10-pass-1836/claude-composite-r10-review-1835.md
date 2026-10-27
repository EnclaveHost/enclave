# 1835: independent narrow review of composite-mdbx-validation-stage/r10 (the B1 fix only; author 1833). r10 tests NOT asserted; root is running them

**Scope:** read-only.
- **What I read:**
  - the new `jobs/collect-evidence.sh`, `jobs/job-receipt.py` and `jobs/finish.sh`;
  - the evidence part of `jobs/root-composite-validate.sh`;
  - test 16;
  - the `memory_gate.py` diff (format strings plus `snapshotsOk` in `JOB_CHECKS` only);
  - the `final-status.sh` diff (paths only).
- **Not re-reviewed:** the unchanged lifecycle, memory policy, gate, stop and guard.
- **Not done:** tests, mounts, scope, queue, data, original, network or edits.

| item | sha256 |
|---|---|
| r10 `SHA256SUMS` (10 entries, `sha256sum -c` OK; r9 unchanged) | `e39bc67d5a74c0aab922ac3cc8d2450603d9dcd0c193f698825f063b3e7c5051` |
| `jobs/collect-evidence.sh` | `9f5322850d63711166b3d7c3d387a4efe5214d95e51d2fe7758dd8a2ec125f2c` |
| `jobs/job-receipt.py` | `c4e235b0a5c4d47faac5a880697af09201f75042de9cd7f45579569d98857038` |
| `jobs/finish.sh` | `613c4512e7777a0071a40a9f32cc9666064f76e02baead99db814d2c4ec39bf2` |
| `jobs/root-composite-validate.sh` | `bf60a8a66f8e69573b5c927d540263cc25b69de90f969cd951c4206af83cb48f` |
| `jobs/final-status.sh` (= r9 except the stage path) | `a8e28585f271961d646f4fe7ab879b38ce157461e20eacd7fb327f199fff1f9b` |
| `memory_gate.py` | `d5abdd20f74d2e9039278e9a8fd3033a4c4ad187d5bcc902c913122988dcce84` |
| `tests/test_memory_gate.py` (16 `test_` methods; `jobs/tests.sh` gate `Ran 16`) | `97aaa8be8c1a22056db54e6f0a06fee2b8a14cb541ec319c06203d8332c31362` |

## Does it resolve 1831 B1? Yes: no concrete blocker remains for owned, private, fresh job dirs
**Statuses are captured immediately.** In `collect-evidence.sh`, each pipeline is followed directly by `X="${PIPESTATUS[*]}"`:
- the mountinfo FUSE pipeline (4 statuses);
- the `pgrep` peer pipeline (3);
- after the run: the single `grep -F "$O" mountinfo` (1) and `pgrep -f "$O" | grep -v pgrep` (2).

They are written as `key=codes` lines plus a final `end=1` (or the script exits 3).

**Expected no-match is accepted; errors are rejected.**
- **The rules:** `g` (grep/pgrep) accepts {0, 1} and `z` (awk/sort) accepts {0} only.
- **Rejected codes:** 2, 3, 141 SIGPIPE, 153 SIGXFSZ (the 1 MiB `ulimit -f` hit), 126/127 (missing tool), and any count mismatch.
- **A failed redirection of the final command** shows as status 1: rejected for awk/sort. For the single-command `grep -F`, the rule accepts the code, but the file is then missing or not regular, and the `[ -f ] && [ ! -L ]` check, which `job-receipt.py` repeats, fails it.

**A failed BEFORE collection prevents the runtime.** `root-composite-validate.sh` runs `collect-evidence.sh before` under `env -i PATH=/usr/bin:/bin`, after the guards and before the gate, with `|| die …: nothing started`.

**An AFTER failure or an invalid status can never give final 0, even with runtime rc 0.**
- **`finish.sh`** runs: `collect after` (`arc`), then `job-receipt.py O J rc arc` (`jrc`; under `ulimit -f 1024`), then `final-status.sh rc jrc receipt J`.
- **`job-receipt.py`:** `snapshotsOk = arc == 0 and status_ok(before) and status_ok(after)`. `status_ok` requires:
  - a regular file of ≤ 4 KiB, ending in `end=1\n`;
  - exactly the expected keys, numeric codes satisfying the same g/z rules;
  - every evidence file regular.

  `peersUnchanged`, `noMountLeft` and `noProcessLeft` are each **conjoined with `snapshotsOk`**. Any false check gives `jrc` 1.
- **`memory_gate.py evidence`** now requires exactly the 7 `JOB_CHECKS` (including `snapshotsOk`), format r10, `jrc == 0`, rc 0 and outcome CLEAN.
- **`final-status.sh`:** a nonzero runtime rc is preserved; otherwise 10 plus `FINAL-EVIDENCE-FAILED`.
- **Also fail-closed:** a receipt over 1 MiB, a missing or empty `EVID_O` (the runtime receipt is then not found), or an unexecutable step.

**No self-match in `processes-left`.**
- The run dir reaches the collector only via `EVID_O` in the environment. The collector's argv carries only `after J`, and `finish.sh`'s carries `J rc`; `J` (`runs/job-ID`) does not contain `O` (`runs/prod-ID`).
- The `env -i … EVID_O=…` wrapper has already exec'd bash before collection runs, and `job-receipt.py` (whose argv names O) runs after collection.

**Test 16 exercises the actual production helpers.**
- **What it runs:** the same `collect-evidence.sh before` → `finish.sh` (→ `collect after`, `job-receipt.py`, `final-status.sh`) with a CLEAN runtime receipt and runtime rc 0.
- **Fault injection:** done only through the test's PATH (production uses `env -i PATH=/usr/bin:/bin`). The injected faults:
  - pgrep 3, awk 2, sort 2, grep 2;
  - a `sort` that writes > 1 MiB (SIGXFSZ 153);
  - an unwritable evidence file (a directory);
  - a missing, malformed or truncated `status-before.txt`.
- **Each must give final 10, the mark, and `snapshotsOk` false.**
- **Also asserted:** the healthy path gives final 0 with `end=1`; a failed BEFORE collection is nonzero; runtime rc 7 is preserved through a failing after-collection.

## Remaining limitations (plain)
- **Snapshot scope is r6's:** the FUSE mounts in mountinfo and this user's qemu-nbd/nbdfuse/fuse2fs processes, excluding only `r6/runs`. Other kinds of peer change are not observed.
- **Test 16's healthy case depends on the host being quiet between its before and after snapshots.** On the 256 small lane, a concurrent preservation session that mounts or unmounts a FUSE view, or starts or ends qemu-nbd/nbdfuse, in that short window makes `peersUnchanged` false. The test then fails. That is spurious but fail-closed, so re-run it. The production run cannot overlap preservation (the 4096 main lane is exclusive).
- **Fail-closed false positives (as before):** any process of this user whose cmdline names the run dir (for example a monitor or `ls` naming `runs/prod-ID`) makes `processes-left` non-empty, so final 10.
- **Unexecutable helpers:** an unexecutable `final-status.sh` returns bash 126/127. That is nonzero, but it replaces a nonzero runtime classification code.
- **Unchanged r8/r9 limits** (not re-reviewed; not claimed as guaranteed): MemoryHigh is not a ceiling and throttles the whole scope; the OOM victim is not guaranteed; the soft stop races the outer guard; production memory figures are estimates; CLEAN is structural only.

## Verdict
**B1 is resolved in source.** No concrete blocker was found for owned, private, fresh job dirs. The final status cannot be 0 unless the before and after evidence was actually collected with acceptable statuses and validated, and a failed before-collection stops the job before the runtime.

Production stays gated on root's actual `cmv-r10-tests` evidence, the 265 verified parts, the production view and explicit permission. **No test result is asserted here.**
