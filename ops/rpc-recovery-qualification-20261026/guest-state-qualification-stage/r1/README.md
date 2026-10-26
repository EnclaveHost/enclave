# guest-state-qualification-stage/r1: root-run real qualification Q1–Q3 for the guest state install (source only)

**PREPARED, NOT RUN.**
- Claude ran no test, build, network, sudo, SSH or live action. **No test or qualification result is claimed.**
- The RPC VM is off (its 64 GiB is unavailable), so everything here is for root to run later through the shared queue.
- Reference: `logs/claude-guest-state-install-review.md` Q1–Q3. The install candidate (`guest-state-install-stage`, r2 being fixed by Claude370) is **not edited and not imported**. Its frozen unit/drop-in bytes are consumed only via **root-supplied sha256 pins**.

| file | runs where | what it does |
|---|---|---|
| `host/make_fixtures.py` | host, root, no network | Writes 10 tiny deterministic `.tar.zst` fixtures and `fixtures.json` (sha256 of each, expected outcome, raw members). Needs Python ≥ 3.8 stdlib + the `zstd` CLI. It does **not** use 3.14's `compression.zstd`, so it is 3.12-compatible; the host has 3.14.8. No hashes are pre-computed: root pins `fixtures.json`'s sha256 after generating. |
| `guest/q1_b3sum.py` | guest, root, apt network | Q1: the b3sum `1.2.0-1` provenance + KAT workflow. |
| `guest/q2_extract_confinement.py` | guest, root, no network | Q2: the real pinned base binary under the candidate unit's identical sandbox, against hostile fixtures. |
| `guest/q3_guard_inspect.py` | guest, root, read-only | Q3: unit/drop-in pins, loaded `ExecStartPre` order, the guard run by hand. |
| `host/run_in_guest.sh` | host, root, VM on | Copies one guest script (plus the q2 fixtures) **file by file** with an in-guest sha256 check into `/var/lib/enclave-gsq/<id>` (root 0700), runs it under a hard timeout, and logs to `logs/<q>-<id>/`. |

All guest scripts:
- use stdlib only and are Python 3.12 compatible (guest);
- run as `/usr/bin/python3 -I`;
- do not override `HOME`;
- write only under their scratch or record path;
- **never start, stop or reload any unit and never install a package**.

## Q1: BLAKE3 tool (`q1_b3sum.py --scratch /var/lib/enclave-gsq/q1-<id>`)
1. **Candidate version:** `apt-cache policy b3sum` must have Candidate **exactly** `1.2.0-1`. Otherwise **stop** (rc 2, fail closed; no other version, no guessed hash).
2. **Stanza and download:** record the `apt-cache show b3sum=1.2.0-1` stanza, then `apt-get download` into scratch. apt verifies InRelease → Packages → `.deb`.
3. **Independent chain record:**
   - `gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg` on the apt InRelease;
   - the uncompressed Packages list holding the stanza must have its sha256 listed in that InRelease;
   - the `.deb` sha256 and size must equal the stanza.
   - Any gap means rc 1.
4. **No install:** `dpkg-deb -I`/`-c` recorded, then `dpkg-deb -x` only. The extracted `usr/bin/b3sum` sha256 is the **proposed** `GSI_B3SUM_SHA256`; root reviews it and writes `gsi.env`.
5. **KAT and version:** `--version` must start with `b3sum 1.2.0`; the KAT is BLAKE3("") = `af1349b9…3262` (the constant `guest_state.py` already pins).
6. **Official vectors:** only if the signed source package contains `test_vectors.json`, read **in memory**, never extracted to disk. Otherwise they are recorded as absent; no vectors are invented.
7. **Mount options:** `findmnt -no OPTIONS /srv/enclave-base-holder` must not include `noexec`.

**Bound:** run with `--timeout=1800`; apt calls have their own timeouts.

**Final native qualification remains install's own result:** all 4 outputs, including the 1.14 TB `mdbx.dat`, must equal the manifest pins (Q4).

## Q2: extract confinement with the REAL base binary under the IDENTICAL sandbox
1. **Choose the run name.** Root picks `RUN=/srv/enclave-base-holder/tmp/gsq-r1/<run>` (it must not exist yet).
2. **Generate fixtures** on the host: `python3 host/make_fixtures.py --out <host dir> --decoy $RUN/decoy`, then pin the printed `fixtures.json` sha256.
3. **Run in the guest:**
   ```
   q2_extract_confinement.py --candidate-unit <FROZEN candidate extract unit path in the guest>
                             --candidate-unit-sha256 <root pin of the frozen candidate unit>
                             --base-bin /opt/enclave-rpc/bin/base --base-bin-sha256 9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f
                             --fixtures-dir @REM@/fixtures --fixtures-json-sha256 <root pin> --scratch $RUN [--case-timeout 300]
   ```
4. **What it records first:**
   - `systemd-analyze verify` of the candidate unit;
   - `base --version`;
   - the property list passed verbatim.
5. **Sandbox used:** every `[Service]` property of the candidate unit is passed to `systemd-run --wait --pipe --collect` **verbatim**, except:
   - `ExecStart`: replaced by guest_state.py's exact extractor argv;
   - `ReadWritePaths`: becomes `$RUN/stage $RUN/x-home`;
   - plus one added bound, `RuntimeMaxSec`.
   - The child environment equals guest_state.py's (`PATH`, `HOME`/`TMPDIR` = x-home, `LC_ALL`).
   - It refuses unless the candidate has `ProtectSystem=strict`, `PrivateNetwork=yes`, `NoNewPrivileges=yes`, an empty `CapabilityBoundingSet`, `User=root` and `PrivateDevices=yes`.
6. **Cases:**
   - `good` (positive control: staging exactly the declared bytes);
   - an absolute path, `../` traversal, a symlink then a write through it (absolute and relative), a hardlink (absolute and relative linkname), an extra file, a device node, and a file outside `db/`.
7. **Expected per case:**
   - `good`: rc 0 and exact;
   - hostile: the extractor refuses **or** staging is not exact (install's exact-set check would refuse);
   - **always:** the decoy and every other `$RUN` file byte-identical (content sha256 + metadata), and the datadir metadata fingerprint unchanged. Any change is an **escape**: FAIL.
   - Refusal evidence (EROFS/EACCES/EPERM/tar-rs messages) is extracted into the record.
   - The record is `$RUN/q2-result.json`; per-case logs go to `$RUN/logs/`.
8. **No unconfined tar:** the only unpacking of fixtures is the base binary inside the candidate sandbox. `make_fixtures.py` only **writes** tars; `q1` reads a source tarball member in memory.

**Bound:** 10 cases × `--case-timeout` (default 300 s) + 60 s each; runner `--timeout=7200`. Memory follows the candidate's `MemoryMax`.

## Q3: guard ordering, live config, read-only
- **Precondition, a separate reviewed root action NOT done by this stage:** install the frozen candidate drop-in, then `daemon-reload`.
- **Command:**
  ```
  q3_guard_inspect.py --unit-sha256 f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee
                      --dropin-sha256 <root pin of the FROZEN candidate drop-in>
                      --expect-guard-rc 2 --expect-guard-reason 'no state-installed.json' --record /var/lib/enclave-gsq/q3-<id>.json
  ```
- **It refuses** if retention or the holder is running.
- **Checks:**
  - the installed unit equals the reviewed unit (sha above, computed from `base-retention-stage/activation-r2/enclave-base-retention.service`);
  - the drop-in equals the root pin;
  - `NeedDaemonReload=no`; `FragmentPath`; `DropInPaths` includes the drop-in;
  - `ExecStartPre` order: mountpoint, `retention_guard.py pre`, then the state guard, **last** and `privileged` (`ExecStartPreEx` flags);
  - `systemd-analyze verify`.
- **The guard by hand:** it runs the guard argv **exactly as systemd will**, with a 300 s timeout, and expects rc 2 "no state-installed.json". After a real install (Q4), the same script with `--expect-guard-rc 0` is the pre-start gate.
- **Afterwards:** retention must still not be running, with its InvocationID unchanged.
- **It never starts retention.**

**Bound:** runner `--timeout=900`.

## Exact runtime pins (root inputs; nothing here is invented)
| pin | value / source |
|---|---|
| retention unit | `f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee` (stage file) |
| base binary | `9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f` (pinned in the install r1 unit / retention guard) |
| manifest | `1f0c4e6c…` (inside the candidate unit's argv) |
| candidate extract unit sha256 | **root input**, from the FROZEN install candidate. r1 was `0f807e13…bc856`; r2 may differ. |
| candidate drop-in sha256 | **root input** (r1 `9d0a0e7f…cf09`) |
| `fixtures.json` sha256 | **root input**, after generation |
| b3sum | **Q1 output, root-reviewed** |

## Not covered
- **Q4,** the real run: provenance → transfer → import-verify → extract-stage → install (BLAKE3 of all 4 outputs) → guard rc 0 → only then root starts retention.
- **The candidate's own `guest_state.py extract-stage` under its real unit** (Q2b). Run it after the candidate is frozen, with the same fixtures and scratch layout. Not prepared here, to keep the candidate isolated.
