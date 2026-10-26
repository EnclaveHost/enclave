# Guest state install r2: guest-state-install-stage/r2 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, queue jobs, live actions or commits, and wrote nothing outside the new stage.
- **Checks I made:**
  - `ast` parse; `guest_state.py` parsed with the **Python 3.12 grammar** (the guest's interpreter);
  - `bash -n`;
  - `sha256sum -c` of r2, and of r1, which is unchanged and frozen (`f7a92e47…`).
- **Input:** the independent review `logs/claude-guest-state-install-review.md`, B1/B2, the low-priority `same()` item, and Q1-Q4.

## Stage
`guest-state-install-stage/r2/`, `SHA256SUMS` = **`248f2e9524bb1f7e148ea4e2852744c1351e7c506b8760738d3c707a119e4acc`** (frozen, read-only)

| file | sha256 | vs r1 |
|---|---|---|
| `guest_state.py` | `b9c07db6425a3545f30703852031e15057e629971e3acd4d11be66a28fcd9de4` | B1, B2, mtime, record mode (19 changed lines) |
| `test/test_guest_state.py` (16) | `834579fc17e03cd29d74c073c24d397cb563a8c0272a9c325c320e8e45322229` | +3 regressions; the stub applies header modes |
| `jobs/root-gsi-r2-tests.sh` | `93666a5a992da80247a90ec7a51035a272b2b7579dbcbf08347b443e4bfc6cc9` | discover harness |
| `units/enclave-base-state-extract-gsi.service` | `95f0eb79284465dad0c116e804e342133f465cf8c807560d993f0b9f161155d2` | paths `state-install-r2` only (diff-checked) |
| `units/enclave-base-state-install-gsi.service` | `c2f9d2c97a5cf4878684a6aa2c6107cc1ae9d3f6ee88369fd5ab00d08f4d4a6e` | paths only |
| `units/enclave-base-retention.service.d/60-state-install-guard.conf` | `dae4744fb7f3ed256f65e184158432b43ab3199f1c2f224f9b11c38abcd34268` | paths only |
| `units/gsi.env.example` | `aa9348341fd974471edf81efb872f3c6f2e3ff901a14afdba9a42e55dca8c2db` | path |
| `host/archive_provenance.py` | `b6e4f61e…` | unchanged |
| `host/transfer_to_guest.sh` | `3f12d332…` | unchanged |
| `README.md` | `aad655a16f2d7205f8355ea1641c5cd651744480fa1ed4a996070c948c82ac9b` | |

## Fixes
**B1 (tar header modes):**
- `staged_set` no longer refuses group/other bits. tar-rs 0.4.46 applies `header mode & 0o777` and the unit's UMask does not apply, so those bits in the root-0700 stage are archive metadata. Setuid/setgid/sticky still refuse.
- `install` calls `os.fchmod(fd, 0o600)` beside `fchown`, in both modes. That changes neither the content (BLAKE3) nor the mtime (guard, reth reuse).
- `state-installed.json` records each file's `mode`.

**B2 (extract after a partial install):** `extract-stage` refuses (rc 2) once `install-intent.json` exists, **before** emptying anything. Only `install` may continue.

**Resume identity:** `same()` compares size, inode, dev **and mtime**. BLAKE3 is not repeated on resume, and `fchown`/`fchmod`/`rename` never change the mtime.

**Stub correction:** r1's labelled stub extracted with `tarfile` `filter='data'`, which itself clears group/other write bits and so hid B1. r2's stub uses `filter='fully_trusted'` on its own fixture archive, applying header modes as-is like tar-rs (labelled in the stub).

**Harness:**
- **The problem:** `python3 -I` puts neither the cwd nor the test dir on `sys.path`, so `-m unittest test_guest_state` from `test/` is fragile.
- **r2 runs** `python3 -I -m unittest discover -s <ABSOLUTE test dir> -p test_guest_state.py -t <same> -v`.
- **Also:** no HOME override; `TMPDIR` only for the test command; and r1's sums are checked, so r1 must stay frozen.

## New regression tests (labelled stubs)
1. **Header modes:** `HeaderModes` (headers `mdbx.dat` 0444, `lock` 0664, `database.version` 0666, `mdbx.lck` 0640).
   - The stub's staged files really carry those modes (asserted).
   - Extract and install succeed; r1 refused here.
   - Every installed file is 0600 with exact bytes; the record says `0o600`; the guard is OK.
2. **Partial install then extract:** `PartialInstall.test_extract_after_partial_install_refuses_preserves_bytes_then_resume_succeeds`.
   - The install crashes after 2 renames (rc 77).
   - `extract-stage` gives rc 2 naming `install-intent.json`.
   - The staged and data trees (content sha256, mode, size, mtime, inode per file) are **identical** before and after; r1 emptied `stage/`.
   - `install` then resumes to the exact 4 files, and the guard is OK.
3. **Resume mtime:** `PartialInstall.test_resume_refuses_a_changed_mtime_on_a_staged_or_installed_file`. A +1 ns mtime on a remaining staged file, or on an already-installed file, makes the resume refuse (rc 2).

**Retained from r1 (13):** import refusals; clean extractor env; hostile staging (symlink, hardlink, fifo, extra file or dir, missing, wrong size, setuid) refused with data untouched; extractor failure then clean retry; changed archive or unpinned binary; install, record and archive kept; wrong digest and `db` problems; staged change; tool pin and KAT; crash or resume; guard cases; unit-text confinement and drop-in order.

## Root command (not run)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh gsi-r2 256 unshare -Urn bash guest-state-install-stage/r2/jobs/root-gsi-r2-tests.sh
```
PASS = `Ran 16 tests` + `OK` + the r2 sums unchanged + the r1 sums intact. The tests need host Python ≥ 3.14 (`tarfile` zstd). The VM can stay off: nothing touches the guest or production.

## Unchanged and still root's (the stubs never count)
- **Q1, the BLAKE3 tool:**
  - the signed `apt-get download b3sum` chain, the `.deb` sha256 + `Packages` stanza, `dpkg-deb -x`;
  - pin `GSI_B3SUM_SHA256`;
  - the KAT;
  - `findmnt -no OPTIONS /srv/enclave-base-holder`, which must not be `noexec`, because the tool runs from its work-dir copy;
  - the final qualification: all 4 outputs equal to the manifest pins at install.
- **Q2, confinement in the guest:** `systemd-analyze verify`, then the real binary on a small hostile `.tar.zst` under identical sandbox properties against a scratch decoy, with the decoy and `data/` byte-identical afterwards.
- **Q3, guard ordering:** the installed retention unit is `f0238826…`; `systemctl show -p ExecStartPre` shows the guard last; the guard by hand gives rc 2 before install. **Never start retention to test it.**
- **Q4, the real run, each step recorded:** provenance, transfer, import-verify, extract-stage, install, guard rc 0, and only then retention.
- **Low-priority items, unchanged:**
  - retention capacity with the 761 GB guest copy present (it may be removed after a successful install; the host original is kept);
  - `dev` in the record (fails closed on a renumbered device).
