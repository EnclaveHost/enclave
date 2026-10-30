# Read-only review: `guest-state-install-stage/r1` (prepared by Claude370)

## Reviewed bytes
- **Stage:** `r1/SHA256SUMS` sha256 `f7a92e4703910bf2637986db81a2e917ab8bbf2d57df50a9a7ce7a28b1120cec`. **`sha256sum -c` passed at 2026-10-26T16:28:05Z** for all 10 listed files; nothing else is in the stage.
  - `guest_state.py` `eddd2d6c…23a1`
  - `units/enclave-base-state-extract-gsi.service` `0f807e13…bc856`
  - `units/enclave-base-state-install-gsi.service` `54d5b615…664d`
  - `units/enclave-base-retention.service.d/60-state-install-guard.conf` `9d0a0e7f…cf09`
  - `host/archive_provenance.py` `b6e4f61e…49af2`
  - `host/transfer_to_guest.sh` `3f12d332…9af31`
  - `test/test_guest_state.py` `63e49363…365e` (stubs and unit-text checks only, as labelled)
  - `README.md`, `gsi.env.example`, `jobs/root-gsi-r1-tests.sh`
- **Context read:**
  - the retention unit `base-retention-stage/activation-r2/enclave-base-retention.service` `f0238826…ceee` (= `source/ops/…/candidate`);
  - `retention_guard.py` `3eff725f…5897` (`pre` writes nothing; `post` writes `retention-complete`);
  - reth 7134be3 `download/mod.rs:487-536` (legacy `--url`), `:560-663`, and `extract.rs:120-128`, `:335-360`, `:549-559`;
  - tar 0.4.46 `entry.rs:784-821`, `archive.rs:58-63`;
  - the pinned manifest (`1f0c4e6c…`) state `output_files`: `db/database.version` 1 B, `db/lock` 12 B, `db/mdbx.dat` 1,138,166,333,440 B, `db/mdbx.lck` 1,028,096 B. Their sum is **1,138,167,361,549** = `decompressed_size` = `transfer_to_guest.sh:19`.
- **Not done:** no test, build, queue job, network, VM or live access, and no edits. **Nothing here is a test result or a qualification.**
- **The stage's 13 tests:** they use a Python `tarfile` stub extractor and a SHA-256 "BLAKE3" stub. The confinement and ordering tests (`test_guest_state.py:215-237`) parse unit text only. **They are not a qualification of BLAKE3, extraction, systemd confinement or drop-in ordering.**

## Verdict
**The design is right:**
- import is checked by sha256 against host provenance;
- extraction is **OS-confined before** the untrusted tar is unpacked;
- install is a separate step that never extracts and checks the exact set plus pinned BLAKE3 **before** any rename;
- install resumes after a crash;
- the retention `ExecStartPre=+` guard runs before reth.

**Source-verified ordering facts:**
- The legacy `--url file://` path does only `create_dir_all` + `archive.unpack(target_dir)` (mod.rs:503-534 → extract.rs:559 → `:127`): no config, no DB.
- The modular retention run opens the DB **only** in `finalize_modular_download` (`init_db`, mod.rs:663), **after** `partition_reusable` (`:560`).
- `retention_guard.py pre` writes nothing (its docstring and code `:160-208`).
- So the drop-in guard runs after `pre` and before anything reth could delete.

**Blockers:** two concrete code fixes (B1, B2) plus the documented real qualification (Q1-Q4). Nothing else blocks.

## Blockers (each with file, line and minimal fix)
**B1. Valid archives can be falsely refused, or installed unusable, because of tar header modes.**
- **Cause:** tar 0.4.46 `Archive::unpack` applies the **header mode `& 0o777`**, with mask 0 by default (`entry.rs:813-815`, `archive.rs:58-60`). The unit's `UMask=0077` does not apply.
- **Effect:**
  - `guest_state.py:120` refuses any staged file with group or other write (`mode & 0o022`). An archive packed with 0664/0666 headers would therefore be refused **after hours of extraction**.
  - Conversely, a 0444 header would install a `mdbx.dat` that rpcbase cannot open read-write at finalize.
  - The archive's header modes are unknown to me; I do not guess them.
- **Minimal fix:**
  - drop `| 0o022` from `:120`, keeping the setuid/setgid/sticky refusal (tar already strips those);
  - in `cmd_install`, call `os.fchmod(fd, 0o600)` next to the `fchown` at `:241`, for both modes.
- **Why it is safe:** the stage is root 0700, so group/other bits there are not exploitable. A mode change alters neither content (BLAKE3) nor mtime, so reth reuse and the guard are unaffected.

**B2. Re-running extract after a partial install destroys the staged files.**
- **The sequence:**
  1. After `install-intent.json` is written and some renames are done, a crash leaves `state-installed.json` absent.
  2. The extract unit's conditions (`extract-gsi.service:8-9`) still pass, and `cmd_extract_stage` empties `stage/` (`guest_state.py:183-187`).
  3. `install` then refuses ("neither the recorded staged file…", `:236-237`), with `data/db` half-populated.
- **Cost:** recovery needs manual cleanup plus a full re-extraction.
- **Minimal fix (one line):** in `cmd_extract_stage`, refuse if `os.path.lexists(<work>/install-intent.json)` (rc 2, "finish with install"). The extract unit can read the work dir.

## Real qualification required before production (documented by root; the stubs do not count)
**Q1. The BLAKE3 tool.**
- **Gap:** `gsi.env.example:3` is a placeholder; no tool, pin or qualification record exists.
- **Required:** follow the author's plan (`logs/claude-guest-state-install-r1.md:90-98`) and record:
  - the apt signature chain;
  - the `.deb` sha256 + `Packages` stanza;
  - the extracted `b3sum` sha256 = `GSI_B3SUM_SHA256`;
  - the KAT output;
  - `findmnt -no OPTIONS /srv/enclave-base-holder` (`b3tool` executes its copy from the work dir, `guest_state.py:131-138`; a `noexec` mount would refuse).
- **Final qualification:** install's own result is the native BLAKE3 qualification: **all 4 outputs equal the manifest pins, including the 1.14 TB `mdbx.dat`**. Record it explicitly.
- A wrong tool fails closed (rc 10, nothing installed).

**Q2. Extract confinement, shown in the guest with the real base binary.**
- **Unit checks:**
  - `systemd-analyze verify` on both units;
  - then, under **identical sandbox properties** (`systemd-run --wait` with the unit's `[Service]` settings, or a scratch copy of the unit with scratch paths), run `guest_state.py extract-stage` on a **small hostile `.tar.zst`**;
  - the archive targets a **scratch decoy dir** outside the writable paths, **not** `data/`.
- **Hostile cases:**
  - an absolute path;
  - `../`;
  - a symlink, then a write through it;
  - a hardlink to the decoy;
  - an extra file.
- **Expected:** for each, the extractor fails or `staged_set` gives rc 8, and the decoy and `data/` are byte-for-byte unchanged. Record EROFS/EACCES or the tar-rs refusal.

**Q3. Guard ordering, live config, read-only only.**
- **Steps:**
  1. Install the drop-in and `daemon-reload`.
  2. Confirm the **installed** unit's sha256 is `f0238826…`.
  3. Record `systemctl show enclave-base-retention.service -p ExecStartPre`; the guard must be last, after `retention_guard.py pre`.
  4. Run the guard command by hand **now**; it must give rc 2 ("no state-installed.json").
- **Do NOT start the retention unit to test it.**

**Q4. The real run itself.** Each step's rc and output must be recorded:
1. `archive_provenance.py` on the host;
2. transfer;
3. `import-verify` (sha256 == provenance);
4. `extract-stage` (exact set);
5. `install` (4 BLAKE3 equal to the manifest; `state-installed.json`);
6. the guard by hand gives rc 0;
7. **only then** does root start retention.

## Verified correct (source reading only)
**Import:**
- size == the manifest state size;
- regular, `nlink == 1`;
- the provenance format, manifest and size match;
- the full sha256 of the guest copy == the host provenance (`:153-168`);
- `extract-stage` re-checks inode/dev/mtime/size against `import.json` (`:174-177`);
- the base binary sha256 is pinned (`:178`);
- the host provenance re-stats after hashing and is never overwritten (`archive_provenance.py:26-38`).

**Extract confinement (`extract-gsi.service:13-45`):**
- `ProtectSystem=strict`, with `ReadWritePaths` limited to `stage/`, `x-home/` and `extract-state/` only;
- no capabilities, `NoNewPrivileges`, `PrivateNetwork`, `AF_UNIX` only;
- the extractor has a clean env with `HOME`/`TMPDIR` set to `x-home` (`:190`).
- **An escape into the writable siblings cannot install anything:**
  - `staged_set` refuses anything but `db/` and the 4 regular single-link files of exact size (`:107-124`);
  - `atomic_json` uses `O_NOFOLLOW`;
  - install still requires the BLAKE3 pins.

**Install:**
- the retention and holder units must be inactive;
- `state-installed.json` must be absent;
- `data/db` must be owned by the datadir owner and empty;
- staged identities must equal `staged.json` before and after hashing;
- BLAKE3 must equal the manifest **before** the intent record and any rename (`:214-230`);
- per file: `fchown` (`O_NOFOLLOW`), then `rename`, then `fsync` of both directories;
- a resume completes exactly the recorded renames and refuses otherwise (`:231-246`);
- foreign-file check, then the record with size/mtime/inode/dev/uid/gid/BLAKE3 (`:247-253`).
- **The `rename` stays within one mount:** the install unit's `ReadWritePaths` includes `/srv/enclave-base-holder` itself, and the nested entries share its mode. Q4 proves this (an EXDEV would fail closed before any rename).

**Guard (`:257-275`):**
- it refuses when `retention-complete` exists, when the record is absent or foreign, when `db/` holds extra entries, or when the size/inode/dev/mtime of any output changed;
- it uses `lstat` and requires regular files;
- `ExecStartPre=+` without `-`, so a refusal fails the unit before `ExecStart`.
- **This matches reth:**
  - a pre-finalize interruption leaves `db/` untouched (the DB is opened only at `:663`), so a restart is allowed;
  - after `init_db` or a partial finalize, the mtime changes and the guard refuses, so the known delete/redownload path is closed.

**Capacity at transfer:** guest free ≥ archive + `decompressed_size` + 200 GB (`transfer_to_guest.sh:18-20`).

## Low priority (non-blocking; fail closed)
- **Retention capacity with the guest archive copy present:** `retention_guard.py pre` (capacity preflight) must still admit with the 761 GB guest copy in `tmp/state-gsi`. If it refuses, root may remove the **guest** copy after a successful install, since the host original on USB is kept.
- **`dev` in the record:** if the holder disk's device number changes across reboots (e.g. different dm/virtio enumeration), the guard refuses (`:273`). That fails closed, but would need a root re-record.
- **`same()` ignores mtime** (`:233`) on the resume path, where BLAKE3 is not repeated. `fchown` does not change mtime, so including `mtimeNs` costs nothing.

**Out of scope:** the holder unit stays disabled until `retention-complete`; that is enforced by `retention_guard.py pre` and the Conflicts= line, not by this stage.
