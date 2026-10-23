# Boot-price release: build template (ROOT-BOOT-PRICE-BUILD.txt)

This is a source-only template, prepared 2026-10-23. **Nothing was built.** Root runs it after reviewing H's commit, a child of
9f6d37bd in `work/custody-boot-registration-20261023/repo`, and writing `APPROVED-COMMIT.txt` here.

**The approval file** must be exactly these three lines:

```
commit <40 hex>
gsup REVIEWED            (or: gsup UNCHANGED)
tests test/<a> test/<b>  (or: tests NONE)
```

**Run:** `./q.sh 1024 build-price-1 bash ./build-price.sh`. The 9f build peaked at 301 MiB.

## What it refuses, and what it proves

| Step | Check |
|---|---|
| 0 `precheck.py` | Approval format. The commit has exactly ONE parent, 9f6d37bd. Its delta is exactly `supervisor.js` + the named tests, + `metal/guest/gsup.mjs` only with `gsup REVIEWED` (and then gsup must change). The builder is unchanged. The base, production, a6 and root-built 08d1 images match their pins (the restore stage-approved copy, and `~/enclave-prod/dist-leasegas-9f6d37bd8` when present). |
| export | `stage/<short>-on-9f6d37bd.patch` is a parent-anchored `git format-patch`, never the parent tree. Hunk-header function context is off. It is full context if that is free of the rewritten provider literal, else zero context (`git apply --unidiff-zero`). It refuses if a changed line carries the literal: the parent `supervisor.js` contains it once. |
| 1 control | 9f6d37bd rebuilt from H's repo must equal the 08d1f838 image byte for byte. |
| 2 candidate | Built twice, byte-identical. |
| 3 `verify.py` | **Manifest vs 08d1:** only `controlOverlay.commit`, the approved image-file records (no record added or removed; builder, base, supervisorClosure and duplicates unchanged) and `initramfs` may differ. **Entries:** vs 08d1, exactly those files + manifest.json; vs production, + gsup.mjs. **Every other entry is byte-identical,** including every crypto, storage, lease and verifier module. The changed files and gsup.mjs in the image must equal the commit's bytes. vmlinuz and cmdline are unchanged. |
| 4 measure | The recipe reproduces ed918e4b, ee5df6b8 and 08d1f838 first. The candidate must be none of them. |
| record | `stage/build-record.json`: commit, parent, delta, tests, gsup flag, patch sha and form, inventory, measurement. `stage/INVENTORY.sha256`. |

The builder reads only git objects plus the base image, so H's working tree cannot leak in. Image binaries in `stage/` are
gitignored.

## Tests

`logs/tests-3.out`, 512 lane, peak 29 MiB:
- **`tests/test_precheck.py` 7/7.** These run on real commits made on a shared bare clone of H's repo (`tests/.fixture-repo`,
  gitignored); H's repo is never written. They cover:
  - a good child, where each exported patch applied to 9f6d37bd reproduces the commit's exact tree;
  - gsup accepted only with REVIEWED, and REVIEWED refused when gsup did not change;
  - other files refused: agent, lease client, verifier, builder, helper;
  - tests not matching the approval;
  - a grandchild, a merge, 9f itself, an unknown commit;
  - a change beside the literal giving a zero-context patch, and a changed line carrying it being refused;
  - 9 approval-format errors.
- **`tests/test_verify.py` 3/3,** on root's real 08d1 manifest: exact supervisor and gsup deltas pass; a lease record changed,
  records added or removed, the builder, the closure, the kernel, another commit, and extra or missing entries all refuse.
- **`refusal-tests/run.sh` 5/5:** build-price.sh against H's real repo refuses before any build when there is no file, a
  two-line file, 9f itself, an unknown commit, or a6.

**Not done:**
- no mutation run;
- `verify.py`'s image-bytes check is the same code root's 9f build exercised, but has no offline test here.

The early review of H's fix, before any build, is in `review-progress.txt`.
