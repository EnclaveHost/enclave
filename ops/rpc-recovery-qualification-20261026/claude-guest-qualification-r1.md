# guest-state-qualification-stage/r1: root-run real qualification scripts for Q1–Q3 (source only)

**Status: PREPARED, NOT RUN.**
- **No tests are claimed** and no qualification is claimed.
- I ran no tests, build, network, sudo, SSH or live action. The only checks were `py_compile` under host Python 3.14.8 and `bash -n`, plus a scan for syntax newer than 3.12. **Guest Python 3.12 compatibility is by construction, not proven.**
- The RPC VM is off and its 64 GiB is unavailable, so the stage has no live effects.
- `guest-state-install-stage` (r1 frozen `f7a92e47…`, re-verified; r2 being fixed by Claude370) was **not edited and not imported**. The candidate's units are consumed only through root-supplied sha256 pins.

**Stage:** `guest-state-qualification-stage/r1/`, **SHA256SUMS sha256 `39be4e626027bac1026876d7b8d9aaa295654c08527ee9f1a7f2948b2466d1d9`** (6 files, read-only).

| file | role |
|---|---|
| `host/make_fixtures.py` | Host: 10 deterministic tiny `.tar.zst` fixtures + `fixtures.json`. Stdlib `tarfile` + the `zstd` CLI. **Requirement: Python ≥ 3.8 and `zstd`**; it does not use 3.14's `compression.zstd`. Root pins `fixtures.json` after generation; no hashes are pre-computed. |
| `guest/q1_b3sum.py` | Q1, b3sum provenance/KAT (see below). |
| `guest/q2_extract_confinement.py` | Q2: the real base binary under the candidate's identical sandbox; scratch decoy. |
| `guest/q3_guard_inspect.py` | Q3: read-only unit inspection plus the manual guard run. Never starts retention. |
| `host/run_in_guest.sh` | Shared-queue wrapper. Copies files **one by one** with an in-guest sha256 check (no tar for the transfer), runs under a hard timeout, and logs to `logs/<q>-<id>/`. |
| `README.md` | Procedure, bounds, pins, coverage. |

## Q1 (b3sum 1.2.0-1, Ubuntu noble)
1. **Fail closed** unless the apt Candidate is exactly `1.2.0-1`. There is no fallback version and no guessed hash.
2. **Download and chain record:**
   - record the Packages stanza, then `apt-get download` into a new root 0700 scratch dir (apt's signed chain);
   - an independent record: `gpgv` on the InRelease with `ubuntu-archive-keyring`, the uncompressed Packages list's sha256 listed in that InRelease, and the `.deb` sha256/size equal to the stanza.
3. **No install:** `dpkg-deb -x` only. The extracted binary's sha256 is the **proposed** `GSI_B3SUM_SHA256`; root writes `gsi.env`.
4. **Checks:**
   - `--version` starts with `b3sum 1.2.0`;
   - KAT BLAKE3("") = `af1349b9…3262` (the existing constant);
   - official vectors only if the **signed source package** contains `test_vectors.json` (read in memory; otherwise recorded as absent);
   - the holder mount is not `noexec`.
5. **Remains Q4:** the native qualification is install's own BLAKE3 equality on all 4 outputs, including the 1.14 TB `mdbx.dat`.

## Q2 (extract confinement)
- **Fixtures** target a **scratch decoy** (`/srv/enclave-base-holder/tmp/gsq-r1/<run>/decoy`), never `data/`:
  - `good` (positive control);
  - an absolute path;
  - `../`;
  - a symlink then a write through it (absolute and relative);
  - a hardlink (absolute and relative);
  - an extra file;
  - a device node;
  - a file outside `db/`.
- **Each case runs** the **pinned base binary** (`9c44836d…5e53f`, reth 7134be3 legacy `--url file://` → tar 0.4.46 `unpack`) via `systemd-run`, with **every `[Service]` property of the frozen candidate extract unit passed verbatim**. The only exceptions:
  - `ExecStart` becomes guest_state.py's exact argv;
  - `ReadWritePaths` becomes the scratch stage and x-home;
  - plus one added bound, `RuntimeMaxSec`.
  - It refuses if the candidate lacks the reviewed core sandbox settings.
- **Pass rule:**
  - `good` gives rc 0 and an exact staging;
  - hostile cases are refused, or the staging is not exact;
  - **always:** the decoy and the rest of the scratch dir are byte-identical, and the datadir metadata is unchanged. Any change = escape = FAIL.
- **Recorded:** `systemd-analyze verify`, `base --version` and refusal evidence.
- **No unconfined tar anywhere.**

## Q3 (guard ordering, read-only)
- **Precondition**, a separate reviewed root action that is not done here: install the frozen drop-in and run `daemon-reload`.
- **Pin checks:** the installed retention unit equals `f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee` (computed from the stage file), and the drop-in equals the root pin.
- **Loaded-state checks:**
  - `NeedDaemonReload=no`, `FragmentPath`, `DropInPaths`;
  - `ExecStartPre` order: mountpoint → `retention_guard.py pre` → state guard, **last** and `privileged`;
  - `systemd-analyze verify`.
- **The guard by hand:** run exactly as systemd will run it, with a 300 s timeout, expecting rc 2 "no state-installed.json". After install (Q4) the same script with `--expect-guard-rc 0` is the gate.
- **Afterwards:** retention not running, InvocationID unchanged. **It never starts retention**, and it refuses if retention or the holder is running.

## Run bounds and logs
- **Run bounds:**
  - q1: runner `--timeout=1800` (apt calls bounded individually);
  - q2: 10 × (`--case-timeout` 300 + 60) s, runner `--timeout=7200`, memory = the candidate's `MemoryMax`;
  - q3: runner `--timeout=900`.
- **Logs:**
  - host `logs/<q>-<id>/` (`out.txt`, `copied.sha256`);
  - guest `/var/lib/enclave-gsq/<id>/` (q1 `q1-result.json`), `$RUN/q2-result.json` + `$RUN/logs/*`, and the q3 record path.
  - Guest dirs are kept as evidence; root removes them after review.

## Exact inputs root must provide (not invented)
- The **frozen** candidate extract unit path and sha256 (r1 was `0f807e13…bc856`; r2 may differ).
- The candidate drop-in sha256 (r1 `9d0a0e7f…cf09`).
- The `fixtures.json` sha256 after generation, and the Q2 run name (`--decoy` must equal `--scratch/decoy`).
- The Q1 output reviewed into `gsi.env`.
- Lane admissions (q1/q3 small; q2 at the candidate's 4 GiB `MemoryMax`), with the VM on and admitted.

## Not covered
- **Q4**, the real run.
- **Q2b:** the candidate's own `guest_state.py extract-stage` inside its real unit, after the candidate is frozen.
- **The VM:** whether every candidate property is accepted by `systemd-run -p`. If one is rejected, the `good` control fails and Q2 FAILs; there is no silent weakening.
- **Real guest results of any kind.**
