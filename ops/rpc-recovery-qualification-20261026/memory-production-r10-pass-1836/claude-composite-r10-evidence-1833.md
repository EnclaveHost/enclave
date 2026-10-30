# 1833: composite-mdbx-validation-stage/r10 = r9 + review 1831 B1 ONLY (FROZEN, PREPARED ONLY: NOT run, NOT PASS, inactive)

**Scope:**
- **What I executed:** reading review 1831 (`fd4c132d…`) and the r6 `peer_snapshot`; copying r9's sources into a NEW r10; text edits; `ast`; `bash -n`; `sha256sum`.
- **Not done:** tests, queue jobs, production, mounts, network, installs, builds or commits.
- **Integrity:** r1–r9 re-verify unchanged. The shared r6 `common.sh`, the queue and frozen r9 are untouched. The active copy driver, the USB write pause and the originals are untouched.
- **Actual r9 evidence (root):** 15/15 PASS at `r9/runs/tests-20261027T050124Z-2786072` (2.232 s, 60 MiB peak, 256 MiB small lane). Review 1831's "no tests" title is stale.
- **Disclosure:** my first freeze of r10 accidentally kept r9's README text, because a failed edit step was chained with `;`. I unfroze my own, still unreported r10, replaced only `README.md`, and re-froze. **Valid: the SUMS below.**

## Frozen r10: `composite-mdbx-validation-stage/r10/SHA256SUMS` = **`e39bc67d5a74c0aab922ac3cc8d2450603d9dcd0c193f698825f063b3e7c5051`** (10 entries, read-only)
| file | sha256 | change vs r9 |
|---|---|---|
| `memory_gate.py` | `d5abdd20f74d2e9039278e9a8fd3033a4c4ad187d5bcc902c913122988dcce84` | `JOB_CHECKS` + `snapshotsOk`; `evidence()` requires receipt format r10; format and message labels r10. **No runtime, lifecycle, stop, guard, telemetry, gate or threshold change** |
| `jobs/collect-evidence.sh` (new) | `9f5322850d63711166b3d7c3d387a4efe5214d95e51d2fe7758dd8a2ec125f2c` | explicit evidence pipelines, `PIPESTATUS`, status file |
| `jobs/finish.sh` (new) | `613c4512e7777a0071a40a9f32cc9666064f76e02baead99db814d2c4ec39bf2` | after-collection, then receipt, then final status: the ONE post-runtime path (production + test 16) |
| `jobs/job-receipt.py` (new) | `c4e235b0a5c4d47faac5a880697af09201f75042de9cd7f45579569d98857038` | r9's inline generator, moved to a file, plus strict `snapshotsOk` |
| `jobs/root-composite-validate.sh` | `bf60a8a66f8e69573b5c927d540263cc25b69de90f969cd951c4206af83cb48f` | before-collection (refuse on failure) and `finish.sh`, both under `env -i PATH=/usr/bin:/bin`; r10 paths |
| `jobs/final-status.sh` | `a8e28585f271961d646f4fe7ab879b38ce157461e20eacd7fb327f199fff1f9b` | path r10 only (the decision logic is identical) |
| `jobs/stop-session.sh` | `18dad856e23b07d6ad8a1e9aa2e8d47db90df6f78e5deae774c3872c43c32913` | path r10 only |
| `jobs/tests.sh` | `00e207bd5b6839b9b3d6666da2aab8bafe757c7c2b94617b75766552aef3dce3` | r10; exactly `Ran 16 tests` (same strict gate) |
| `tests/test_memory_gate.py` (16) | `97aaa8be8c1a22056db54e6f0a06fee2b8a14cb541ec319c06203d8332c31362` | test 12 uses the receipt format r10; new test 16 |
| `README.md` | `e62c5e40c176a5cffd915b83534d7df4170f3e817e9de863a36517b729a509b6` | r10 section |

## The B1 fix
**`collect-evidence.sh before|after J`** (env: `EVID_O` run dir, `EVID_S6` r6 stage; `ulimit -f 1024`):
- **Pipelines:** the same commands as the qualified r6 `peer_snapshot`, written as **explicit pipelines** with `PIPESTATUS` captured on the very next line:
  1. `grep -E <fuse> /proc/self/mountinfo | awk | grep -v $S6/runs | sort > peers-MODE.txt`
  2. `pgrep -u UID -x -a 'qemu-nbd|nbdfuse|fuse2fs' | grep -v | sort >> peers-MODE.txt`

  After the run it also runs `grep -F $O mountinfo > mounts-left.txt` and `pgrep -a -f $O | grep -v pgrep > processes-left.txt`.
- **Accepted codes:**
  - grep/pgrep **0 or 1** (1 = an expected empty result, so healthy "nothing found" is not a failure);
  - awk/sort **0**;
  - anything else fails: 2 = error, 141 = SIGPIPE, **153 = SIGXFSZ (1 MiB cap hit)**, 126/127 = missing tool, a failed redirect.

  Every evidence file must also be a regular file, which catches a failed redirect that grep reports as 1.
- **Output:** `J/status-MODE.txt` (`key=c1,c2,…` lines plus a final `end=1`); exit 0 only if everything is acceptable.
- **No self-match:** the run dir is passed in the **environment**, so the script's own command line never matches `pgrep -f RUN_DIR`.

**The production job:**
1. **Before the gate/runtime:** `env -i PATH=/usr/bin:/bin … collect-evidence.sh before J || die …` — **a failed before collection refuses; nothing starts.**
2. **After it:** `env -i … finish.sh J rc`, whose result is the job's exit.

**`finish.sh`:**
1. `collect-evidence.sh after` → `arc`.
2. `job-receipt.py O J rc arc` (≤ 1 MiB) → `jrc`.
3. `final-status.sh rc jrc receipt J`.

**`job-receipt.py`: `snapshotsOk` requires all of:**
- `arc == 0`;
- **both** status files are regular, ≤ 4 KiB, complete (`end=1` and the final newline), with exactly the expected keys and per-command code counts and values;
- every evidence file is regular.

`peersUnchanged`, `noMountLeft` and `noProcessLeft` are true **only if** `snapshotsOk`. Missing, malformed or truncated status or evidence can never be clean.

**`memory_gate.py evidence`** requires all seven checks (now including `snapshotsOk`) and receipt format r10. So **a runtime 0 with any failed or incomplete evidence becomes 10 plus `FINAL-EVIDENCE-FAILED`**, while a nonzero runtime rc is preserved exactly (r9's `final-status.sh` logic is unchanged).

## Test 16 (new; runs the ACTUAL production scripts, with no mount or FUSE)
- **The setup:** a tmp `J` and a fake run dir `O` containing a CLEAN runtime receipt, with **a simulated runtime rc 0**. Tools are injected **only through the test's PATH**; production always uses `env -i PATH=/usr/bin:/bin`.
- **Healthy, real tools:** before 0, then `finish.sh` 0 with `snapshotsOk` true and no mark. Empty results (no FUSE peer, no leftovers) pass. The status file ends with `end=1`.
- **After failures with runtime 0, each giving `finish.sh` = 10, the mark, and `snapshotsOk` false:**
  - a failing `pgrep` (3), `awk` (2), `sort` (2) or `grep` (2);
  - a `sort` writing 2 MB past the 1 MiB cap (SIGXFSZ);
  - an unwritable evidence file (`processes-left.txt` is a directory);
  - the before status missing;
  - a malformed before status (a non-numeric code);
  - a truncated before status (no `end=1`).
- **A failed before collection** (failing `pgrep`) gives a nonzero exit, which production uses to refuse before the runtime.
- **A nonzero runtime rc (7)** with a failing after collection stays 7.
- **Tests 1–15 are retained.** Test 12's `good` receipt now uses format r10, and it takes its checks from `G.JOB_CHECKS`, so `snapshotsOk` is required.

## Budget
- **The job's own files:** `peers-before`/`after`, `status-before`/`after`, `mounts-left`, `processes-left`, `receipt.json` and `FINAL-EVIDENCE-FAILED`. That is **8 files ≤ 1 MiB each = 8 MiB**, inside the existing 16 MiB small-files allowance.
- **The 208 MiB output budget, the full remaining recovery reservation, the 40 GiB floors and the 8 GiB native reservation are unchanged.** The current root margin is about 815 MB beyond all reservations.
- **External, not bounded by r10:** the queue's own logs. The job prints only the ≤ 1 MiB receipt plus status lines.

## Prepared test command (root; normal queue)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r10-tests 256 bash composite-mdbx-validation-stage/r10/jobs/tests.sh      # expect "## PASS (16)"
```
**Production** (unchanged conditions: root review, all 265 parts confirmed, the production view, a 4096 lane window):
```
bash jobs/q-exit-status.sh cmv-r10-prod 4096 bash composite-mdbx-validation-stage/r10/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS
```

## Risks and notes
1. **Possible false failure in test 16's healthy case:** it compares real peer snapshots taken about 1 s apart. If a preservation batch's overlay session (qemu-nbd/nbdfuse/fuse2fs, or a FUSE mount) starts or ends in that window, `peersUnchanged` is false and test 16 fails. That is fail-closed and only possible at a batch boundary; rerun in that case.
2. **The redirect corner:** a failed redirect for a grep/pgrep pipeline's last command reports status 1, which looks like "no match". It is caught only by the regular-file check. A redirect target that exists as a regular file but could not be opened is not producible here, because J is our own 0700 dir.
3. **The "before" collection uses the same commands as the qualified r6 `peer_snapshot`** (copied verbatim, not sourced), so a future change to r6's function would not propagate. r6 is frozen, so none can happen.
4. **Unchanged accepted limits (r8/r9):** MemoryHigh is not a ceiling and throttles the whole scope; the OOM victim is not guaranteed; the soft stop races the outer guard; production memory figures are estimates; a wrapper KILL skips ordered cleanup; D-state has no bound; CLEAN is structural only; the canonical build is deferred.
5. **r10 is inactive until root reviews it and runs the actual tests.**
