# 1889: state-fixture-capture-stage/r3, binding acceptance r3 and correcting the 1886 test false positive (SOURCE ONLY; nothing run)

## Status
- **Created:** `state-fixture-capture-stage/r3` only.
- **No execution by me:** no test, queue job, build, mount, namespace, network access, or data/original/backup read. The only checks were static: `ast.parse`, `bash -n`, `sha256sum -c`. No commits.
- **Results:** **no r3 test has run, and nothing is qualified.** Every receipt in the tests is SYNTHETIC: none is a compiled-fixture qualification, a state result, canonical proof, a recovery acceptance or reset authority.
- **Untouched and re-verified clean:**
  - capture r2: SUMS `f07bd6da5f0c4be3ed092a6318fcd3ec10a2fd87767469a838e2853c25030836`;
  - bsro r12: `2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea`;
  - acceptance r3: `1e7eb6367e2cfbbf38c0f6debb92492421f3b9086dc3f8fd8236ce55319faadd`.

  The 1881 extractor was not touched.

## Files (frozen, read-only)
| file | sha256 |
|---|---|
| `SHA256SUMS` | `f5424d11fd3e7ee0251eaa55a177f6a3affa6e4b9b04b5e10c3e2f496b0488c2` |
| `capture.py` | `81ddd643f41e91a16b6bda76d60873dda1d79ab066862b47c199958c072cc3e7` |
| `tests/test_capture.py` (**18 tests**) | `037f5dcd3fb6bcdd15f082340ff9c4cfb96e2ca26c74cb225ce334af982d9450` |
| `jobs/tests.sh` (requires exactly `Ran 18 tests`; receipt format r3) | `1b1a22595839ea1f6dc26f357a8812ece6ab6f9e3b582e6cc32e711c5dc272b1` |
| `jobs/inner.sh` | `51bc15a946275082303e9dc4a5e51e7746868d5cf6f9a6ac6f72e8ed5dc03414` |
| `jobs/run.sh` | `822788a255d1e85a1b761e7d2e152886cfeff61c8dc15c1a92dbfff0d72146e8` |
| `README.md` | `359987a97b3fd4f775cc79addfe87f0e67dd2f997a5130b068165896509059e5` |

## Pins (rehashed from the actual files on 2026-10-27)
- **Acceptance r3:**
  - `state-helper-qualification-stage/r3/SHA256SUMS` = `1e7eb636…faadd`;
  - `acceptance.py` = `b2c10534ac349a3233da06aed60374ae20762d2b1b8527bbb799e74078cfd0ec` (equal to its SUMS entry);
  - root's actual receipt `runs/tests-20261027T103556Z-3089837/receipt.json` = `e2361fbb5e49d14f7493f49e27346dcedeaf4b1b13d876f1fa985dff03ac6d29`. Its content: format `state-acceptance-test-receipt/r3`, pass, expected 46, ran `["46"]`, rc 0, 5 checks true, stageSums `1e7eb636…`.
- **r12, unchanged from r2:** SUMS `2911943d…`, `bsro_gate.py` `0641637a…`, `ns.sh` `b8b4560c…`, `positive.sh` `3ba41117…`, `fixtures.sh` `4cf3d582…`.
- **/vm:** 253:1, UUID `aaae081c-f829-4484-a50f-a9bbb87d31f9`. Source: the multipart manifest `f94807f7…` `targets.vm` (`majmin`, `uuid`).

## Changes (r2 → r3)
1. **Parser bound (review 1884 B5):** `ACCEPTANCE` = acceptance r3 SUMS / module / the actual receipt.
   - **`gates`** now also requires:
     - the acceptance SUMS entry for `acceptance.py` equals the module pin;
     - the receipt bytes equal their pin;
     - `acceptance_receipt_ok`: exact format r3, pass, expected 46, `ran == ["46"]`, rc 0, the exact 5 check keys all true, and stageSums equal to the pin.
   - **The capture still refuses whenever any pin differs.**
   - **New early refusal:** `run` and `precheck` now check the argument shape (`out_dir_ok`) right after `parser_binding`, before any read.
2. **Positive `## outputs` line exactly `<run dir>/work/out` (B4):**
   - `outputs_line_errors` requires exactly one `## outputs` line equal to `## outputs <runDir>/work/out` for positive, and none for fixtures.
   - The result goes in the receipt as `outputsLine {want, errors}` and its errors become failure reasons.
   - **Why it is needed:** acceptance r3's `OUTPUTS_LINE` accepts any absolute path. Test 16 shows the pinned parser accepting `/vm/other/out`, `…/out/`, `…/trees` and `…/work` while the capture rejects them.
3. **Evidence manifest (B3):** `evidence_manifest(work/out)` records name, size and sha256.
   - **Allowed:** regular nlink-1 files only, opened without following links. Symlinks and subdirs refuse. Limits: ≤ 256 files, each ≤ 1 MiB + 4 KiB.
   - **`evidence_errors`:**
     - the name set must equal the one derived from the pinned acceptance labels/cases. Positive: `binaries.sha256` + 26 × {`mk.txt`, `helper.txt`, `expected.json`}, with `result.json` optional for refused cases. Fixtures: the 6 `<case>.out` files;
     - the positive `binaries.sha256` must be exactly `<helper>  <BD>/base-state-readonly\n<mk>  <BD>/mk_fixture\n`.
   - **Receipt:** `evidence {manifest, errors}`; `receipt_errors` requires it clean and non-empty.
4. **/vm binding (B2):** `vm_binding` requires all of the following:
   - BD's `st_dev` is 253:1;
   - the deepest visible covering mount (in mountinfo) is maj:min 253:1, and its fstype is not tmpfs, ramfs, overlay, fuse*, nfs, cifs or 9p;
   - `stat(/dev/disk/by-uuid/aaae081c…).st_rdev` is 253:1.

   It is checked in `gates` (outside and inside the namespace) and recorded in the receipt with the mount source.
5. **More read-only paths (B1):**
   - `inner.sh` adds `/var/tmp`, `/dev/shm` and `/run/user/$OUID` (each that exists; a symlink refuses, rc 9) to the pinned r12 `ns_harden`.
   - `capture.ro_paths(uid)` builds the same set. The pinned r12 `ns_checks(mi, [*set, R12, HERE], [BD], set)` verifies it before and after the run (read_only + ro_tree_ok over every root). `roStillOk` also requires that the set has not changed.
6. **The 1886 test false positive:** test 11 now uses `shell_code`, which strips comments quote-aware.
   - A `#` starts a comment only outside quotes and at a word start, so `$#`, `${#x}`, `${v#p}` and quoted `#` stay code.
   - Here-document bodies are kept verbatim, so they are still inspected.
   - **New test 15 (regression):**
     - the 1886 line `T=$WORK/trees; O=$WORK/out   # … no /tmp …` no longer triggers;
     - quoted and here-doc `/tmp` are still seen;
     - **12 executable forms are still rejected:** `O=/tmp/out`, `mkdir -p /tmp/x # …`, `> "/tmp/y"`, `${TMPDIR:-/tmp}`, `cd /tmp#x`, `"$(echo "/tmp")"`, a `/tmp` before a comment, `mktemp`, `"$S/runs/x"`, `${2:-…}`, `\#/tmp`, `a=1;/tmp/x`.
   - I checked the r12 scripts by grep for this: the only `/tmp` in either script is in comments, and the here-doc bodies contain no forbidden token.
7. **Receipt format:** `bsro-fixture-capture-receipt/r3`, adding the keys `roPaths`, `vmBinding`, `outputsLine` and `evidence`.

**Preserved:**
- the r12 `run_capture` lifecycle;
- every r2 gate (512 MiB lane, 16 GiB host floor, root floor, /vm 40 GiB + 256 MiB budget, `qualified`, `live_completion` 265, `no_live_sessions`, `verify_binaries` before and after, exactly one verified build receipt, identities, cleanup/confinement);
- precheck outside the namespace, then `unshare -Urnm`;
- the NVMe-only run-dir layout.

## Tests (18; `jobs/tests.sh`, under `unshare -Urn`, small lane)
- **Updated from r2's 14:**
  - **1:** adds the acceptance pins, the SUMS entry, the acceptance R12 constants equal to the capture pins, and 26 labels / 6 cases;
  - **2:** the parser is bound, and bad arguments refuse before any read;
  - **8:** the receipt predicate covers the new keys;
  - **10:** `inner.sh` order and path set;
  - **11:** quote-aware.
- **New:**
  - **15:** the comment regression (as above);
  - **16:** the exact outputs line versus the pinned parser;
  - **17:** the evidence manifest (extra, missing, symlink, subdir, hardlink and oversize refused; `binaries.sha256` exact);
  - **18:** `vm_binding` (wrong dev, wrong uuid device, wrong maj:min, a deeper tmpfs, no mount, fuse), `ro_paths`, and `acceptance_receipt_ok` on root's actual receipt plus 9 mutations.

## Unverified / limits (explicit)
- **U1. Extra read-only binds in the namespace are untested here.** `/dev/shm` (tmpfs) and `/run/user/<uid>` (may hold FUSE submounts, such as the doc portal or gvfs) need `mount --rbind -o ro=recursive` inside a user namespace.
  - If that fails, `inner.sh` refuses with rc 9 and nothing runs: fail-closed, but it would block captures.
  - The r12 ns-tests cover only `/home/steven` and `/tmp`. **A namespace test of the r3 path set is required** before the production capture. I did not prepare a separate ns-test job.
- **U2. B1 is not exhaustive:** `/dev/mqueue`, abstract sockets and any other uid-writable path outside `/vm`, `/home/steven`, `/tmp`, `/var/tmp`, `/dev/shm` and `/run/user` stay writable. Review 1884's alternative (a writable-probe over all paths outside BD) was not implemented.
- **U3. /vm identity, not media type:** `vm_binding` proves the pinned dm device 253:1 / UUID, not "NVMe" as a media type. The mount source is recorded, not pinned.
- **U4. Known parser limit:** `shell_code` tracks double quotes nested inside `"$( … )"` as plain toggles. Only a ` #` inside such a nested inner string could be stripped. The frozen r12 scripts have none.
- **U5. Unverified assumptions in tests 16–18:**
  - acceptance r3 `check_fixture_capture` returns `{"outputValid": …}` (as r2's code assumes);
  - loading `acceptance.py` via `load_pinned` has no side effects.
- **U6. Availability risk:** the acceptance receipt lives in a writable `runs/` dir. It is sha-pinned, so a change refuses (integrity is kept; availability is not).
- **Not changed (owned by r12):** review 1884 S1 (r12 creates WORK before its own checks; fail-closed via `evidenceKept`), S2 (the full helper JSON is deleted; only the ≤ 1 MiB copies are kept, which is the evidence boundary), B6 (failed-run trees need a manual, ownership-checked removal, never automatic), B7 (residual TOCTOU, accepted).

## Root order (no claims)
1. `bash jobs/q-exit-status.sh sfc-r3-tests 256 unshare -Urn bash state-fixture-capture-stage/r3/jobs/tests.sh`. Expect `Ran 18 tests` / OK and receipt pass.
2. A namespace test for U1.
3. r12 guard + ns PASS.
4. All 265 parts CONFIRMED.
5. A verified r12 build receipt.
6. `sfc-r3-positive` / `sfc-r3-fixtures` (512 lane) via `jobs/run.sh`.
