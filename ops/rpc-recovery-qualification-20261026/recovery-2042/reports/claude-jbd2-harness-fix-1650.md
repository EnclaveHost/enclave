# 1650: journal-recovery-verifier-stage/r2, a HARNESS/FIXTURE-ONLY fix of r1 (frozen, NOT run)

**Stage:** `journal-recovery-verifier-stage/r2/`, **SHA256SUMS sha256 `2e40e9a9b8f4990f1873273a20e25b890d5062a5f0de1ddf32d37e80b78e1932`** (files read-only).
- **Unchanged:** r1 (`1a7bcc31…`), which re-verifies.
- **What I did:** text edits, `ast.parse` and `bash -n` only. No tests, builds, live actions, USB or journal reads.

## Cause (root 1646, confirmed from r1's run log `runs/tests-20261026T203136Z-2317436/tests.txt`)
- **The tests themselves passed:** `Ran 9 tests … OK`.
- **The false FAIL:** the wrapper's last-line gate failed because the verifier's **buffered stdout** lines (`{"written": …}` from `V.main` inside the tests) were flushed **after** unittest's `OK` into the same file.
- **The 26 ResourceWarnings** come only from four **test fixture** lines (`test_jbd2_verify.py:107`, `139`, `211`, `213`: `json.load(open(out))` and `open(out,"rb").read()`).
- **None comes from `jbd2_verify.py`.** Its `open_ro`, `read_targets`, `verify` and `write_out` close every fd and file.

## r2 changes (runtime untouched)
| file | r1 → r2 | change |
|---|---|---|
| `jbd2_verify.py` | `d3cfa34e…` = `d3cfa34e…` | **byte-identical** (the harness enforces it with `cmp` against r1) |
| `jobs/root-verify.sh`, `targets/`, `upstream/`, real-superblock vector | identical | |
| `tests/test_jbd2_verify.py` | `7fc11e00…` → `806719f9…` | `vmain()` captures `V.main`'s stdout and stderr; `read_json` and `read_bytes` use `with open`; all 8 `V.main` calls go through `vmain`; still **9** tests with the same assertions |
| `jobs/tests.sh` | `15076b7f…` → `b27dd496…` | see below |
| `README.md` | `42ac71cb…` → `851534e6…` | an r2 header |

**`jobs/tests.sh`:**
- **Before running:** it verifies the r2 SUMS, the **frozen r1 SUMS** (`1a7bcc31…`) and `cmp`s the runtime files against r1. No bytecode is allowed.
- **The run:** `python3 -I -B -u -W always::ResourceWarning`, with stdout and stderr in **separate** files.
- **The gate (`receipt.json`):** all of the following must hold:
  - rc 0;
  - exactly one `Ran 9 tests` in stderr;
  - the last non-empty stderr line is exactly `OK`;
  - **stdout is empty**;
  - no `ResourceWarning`, `skipped`, `FAIL`, `ERROR` or `Traceback` in either stream.
- **The receipt also records:** the stage and r1 SUMS, the verifier sha, the Python version, the libext2fs realpath and sha256, and the stdout/stderr sha256.

**Root:**
```
bash jobs/q-exit-status.sh jrv-r2-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r2/jobs/tests.sh
```
Expect `## PASS (9)`, `"pass": true` and `## jrv-r2-tests rc=0`. This gives the clean wrapper receipt required for r1's investigative actual run (1649), which uses byte-identical verifier bytes.

## Reading root 1649's actual result (no change needed; reminders)
- **Required for each of the 30 metadata targets** (`targets-all-metadata.json`): a **proven** image whose `imageJournalBlock` equals the candidate's journal position. In particular:
  - the inode-table block 499122230 at journal 118422, sequence 17169;
  - the index block 499155449 at journal 109295, sequence 16490;
  - each of the 27 leaf blocks.

  A position that is only in `unverifiedReferences`/`unverifiedMappings`, or `NO PROVEN UNREVOKED IMAGE`, is not authenticated.
- **Mixed ages:** the candidates come from **different transactions** (17169 vs 16490). For each block, check `newerOrUnprovenReferenceSequences` and `revokedByProvenSequence`.
  - A newer proven or unproven version of the index or a leaf after its chosen sequence means the extent map may not be the one the inode at 17169 referenced.
  - `newerOrUnprovenComplete` must be true.
- **No current-state claim:** this holds even with every target proven.
  - Proven means "as logged in that committed transaction", older than `s_sequence` 17671.
  - The inode's old `i_size` (1,138,166,333,440) versus the counted physical extent bytes (1,134,426,460,160 including 28 metadata blocks) is a coverage question for the allocation/extent comparison. It is not established by the journal.
  - The data blocks themselves are not journaled (`data=ordered`), so their content is **not** authenticated by any JBD2 checksum.
