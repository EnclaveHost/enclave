# Enrollment r9: the unenrolled-startup tree check (EARLY; source-only, not run by Claude)

**Evidence:** root 1464, full r8 `check`, terminal: `accepted-image-enrollment-stage/r8/runs/20261026T164255Z-check-2039391`.
- **Everything passed:** all 234 tests, the native owner check, the 5 startup checks, build and bundles.
- **The only false item:** `writerStartup.unenrolledCreatedNoState`.

The "unenrolled" relay startup (the real `api-relay.js` with a role-composed config and NO enrollment) correctly exited with `fatal: writer authority: derived journal missing; explicit enrollment/recovery required`. Its tree (`logs/unenrolled-after.txt`):
```
drwx------ .
-rw-r--r-- ./DERIVED-READER-IMAGE.json          (the stage helper's record copy)
drwx------ ./derived-reader
-rw------- ./derived-reader/derived-reader-v3.json   (the role-composed config)
drwx------ ./derived-reader-v3
-rw------- ./derived-reader-v3/derived-state.lock    (empty)
drwx------ ./derived-reader-v3/runs                 (empty)
```

## Contractual intent (from the actual frozen KVM r3 source; KVM files not modified)
- **The directories:** `network/derived-reader/provider.mjs` `startDerivedReader` first runs `for (const dir of [journalDir, runs]) { fs.mkdirSync(dir, {recursive: true, mode: 0o700}); privateDirectory(dir); }`. This creates and **checks privacy** of both directories BEFORE `openDerivedJournal`.
- **The lock file:** `openDerivedJournal` takes `takeRuntimeLock(journalDir/derived-state.lock)` (`network/runtime-lock.mjs`: `O_CREAT|O_RDWR|O_NOFOLLOW`, mode 0600, never written, never unlinked).
- **The refusal:** with `initializeState: false` and no journal, it then refuses.
- **Never reached:** `runs/runs.lock`, the coverage store, the reader run directories, the bridge journal and every journal file.
- **Why the r3 check failed now:** it rejected any path containing `/runs`. That was written against the older KVM, which created `runs` only after the journal opened. KVM r3 moved the privacy-checked `mkdir` earlier.
- **Conclusion:** an EMPTY private `runs/` and an EMPTY never-unlinked lock file are intended, harmless locking metadata. They carry no authority, floor, journal or coverage. The contract (no silent initialization, no state without enrollment) is met. **No implementation change and no KVM coordination is needed.**

## r9 change (harness only; the source tree is unchanged: still r8's `68245755`)
**New checker:** `jobs/check-unenrolled-tree.py` replaces the substring test with an **exact allowed tree** checked through `lstat`:
- exactly the 7 entries above, with their types (directory/file);
- **no symlink anywhere**;
- the role/KVM entries private (no group/other permission bits);
- `derived-state.lock` **empty**;
- `runs/` **empty**.

**Self-test:** `--self-test` with 13 declared fixtures (1 positive, 12 negative), every one exercised by the job before the real check. Each negative must be REFUSED:
- a reader journal;
- a coverage directory;
- an anchor journal;
- a `runs/run-*` directory;
- `runs/runs.lock`;
- the lock replaced by a symlink;
- an unknown root file;
- a split `journal/` directory;
- a non-empty lock;
- `runs` mode 0755;
- `runs` replaced by a symlink;
- `runs` missing (exactness).

**Verdict:** `unenrolledCreatedNoState` = the real tree passes AND the self-test passed with exactly 13 fixtures. Both receipts are in the verdict. The 234 test counts are unchanged; the checker is declared as an additional check.

## r9 PREPARED (final; source-only, not run)
**Stage:** `accepted-image-enrollment-stage/r9/`, `SHA256SUMS` sha256 **528ff8e8b91c5e563c640c7aed77d6662e82331c7923cfbe916514adbc08b2ec**.

| file | sha256 |
|---|---|
| `jobs/check-unenrolled-tree.py` | `863ba504…` |
| `jobs/root-accepted-image-enrollment-r9.sh` | `d67adb2a…` |

- **Source tree:** r8's **`68245755`**, unchanged (no patch).
- **Left alone:** r8 (`6cd2cdde…`) and its full receipt are untouched; root 1464's verdict, `unenrolled-after.txt`, startup log and compose output are copied into `r9/inputs/root-1464/`.
- **Not run:** I did not execute the checker or its self-test. Root runs it.

**Verdict fields:**
- `writerStartup.unenrolledCreatedNoState` = self-test ok with exactly 13 fixtures AND the actual tree exact.
- The new `unenrolledTreeChecker` receipt lists every fixture's expected and actual outcome, plus the actual tree's entries and violations.

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll9-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/r9/jobs/root-accepted-image-enrollment-r9.sh check
```

**Targeted check, before the full run:** run the checker's self-test alone (no build, no network):
```
python3 -I accepted-image-enrollment-stage/r9/jobs/check-unenrolled-tree.py --self-test
```

**Still open (unchanged):**
- the never-enrolled restored group's admin recovery path;
- writer authority refused under the fixed 120 s ceiling;
- co-located replicas are not a quorum;
- no live reader start and no SNP.
