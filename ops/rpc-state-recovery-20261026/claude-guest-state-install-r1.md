# Guest state install r1: guest-state-install-stage/r1 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, network, queue, live actions or commits; my only checks were `ast` parse, `bash -n` and `sha256sum -c`.
- **Not edited:** 6d's `resumable-state-recovery-stage` (r2 `srr2.py` `eae537dc…`, r3 host fetch).
- **Frozen and untouched:** memory r1 (11 PASS, root 1442) and the OS inspections 1443/1444.
- **Current state:** the guest OS is off, and nothing is installed anywhere.
- Admin controls, the 16 GiB floor and chain readiness are unchanged. Readiness is still a separate gate; this stage installs data only.

## Stage
`guest-state-install-stage/r1/`, `SHA256SUMS` = **`f7a92e4703910bf2637986db81a2e917ab8bbf2d57df50a9a7ce7a28b1120cec`**

| file | sha256 |
|---|---|
| `guest_state.py` | `eddd2d6c769acd377b95635c92a45e5cf8b38060c6c4e76158149750563665a8` |
| `test/test_guest_state.py` (13) | `63e493635db10b0eae210cd64812330dec3a2a49c4f9c0bd623e1a48c91f6d5e` |
| `host/archive_provenance.py` | `b6e4f61e88b8fd7fc9529ef459148b4f2a855a2adc24741fa82c66280cc2c3ee` |
| `host/transfer_to_guest.sh` | `3f12d332f0d3b410cfc27bde03651b3119be644c9fb36fd77dfd292425e49af2` |
| `units/enclave-base-state-extract-gsi.service` | `0f807e139b805daf900e5ad20c3dfef378a17bd62497598e1516316cfc9bc856` |
| `units/enclave-base-state-install-gsi.service` | `54d5b615e8097a2ceeef45ab68cf1459c0d75369e227e9d1a6a77d28f80a664d` |
| `units/enclave-base-retention.service.d/60-state-install-guard.conf` | `9d0a0e7fbcca6e0a41dd54608616d80c000d2dc7e69114b66620f4479c82cf09` |
| `units/gsi.env.example` | `1a4066fefa8c06c952d7fc9a0489c19656181d511f19d2a2ca38ef9e82efe8ee` |
| `jobs/root-gsi-r1-tests.sh` | `e3c5d903c8e4d7d746b44da1dbc8b3f3367eb322811696a8152a23440ea623a1` |
| `README.md` | `2251be8fa42ddfeead53e59673f7e646f73ce9c73b2a958716479c131b88f30b` |

## Root cause of r2's root 1438 failures (3 FAIL + 1 ERROR)
**Cause:**
- `srr2.py:533` runs the extractor with a clean environment `{PATH, HOME, TMPDIR, LC_ALL}`, which is correct production behaviour.
- The r2 tests inject the fault through `STUB_MODE`/`STUB_ARGV_LOG` environment variables (`test/stub_base.py:7-13`), which never reach the stub.
- So the stub extracted normally, the install "succeeded", and `argv.json` was never written.
- **The code is not at fault. The failures were real and correctly reported.**

**Fix (applied in this stage's tests; r2 is not edited):**
- the fault mode and log path are **baked into a per-test stub file** (`STUB_BASE % (mode, log)`);
- one test asserts the extractor really sees only `HOME, LC_ALL, PATH, TMPDIR`;
- expected failures are unchanged: hostile staging → 8, extractor failure → 9, wrong digest → 10.

**For 6d's r2:** the same two-line change to `stub_base.py` / `test_srr2.py` (write a stub per mode instead of using the environment) would fix those 4 tests without weakening anything.

## The pipeline (each step a separate, root-run phase)
1. **Host provenance** (`host/archive_provenance.py`, read-only on r3's dir):
   - **Requires:** `fetch-complete.json` (manifest sha, url `…/1792886410/state.tar.zst`, `total`), with `total == manifest state size (761228785915) == archive size`, a regular single-link file.
   - **Computes** the full sha256 (one read of 761 GB on the HDD) and re-checks size/mtime/inode afterwards.
   - **Writes** a NEW provenance JSON (never overwritten) including the r3 record and its sha256.
   - **Provenance is transport identity only.** The manifest has NO archive-level digest: its `state` entry has `file`/`size`/`decompressed_size`/`output_files` only.
2. **Local transfer** (`host/transfer_to_guest.sh PROVENANCE [BWLIMIT_KIB]`):
   - Runs only after the VM is up again (48 GiB plan), over the VM's pinned SSH (`ssh_config` Host `enclave-rpc`, `known_hosts`, BatchMode, StrictHostKeyChecking).
   - **Refuses unless:** the guest has rsync and passwordless sudo; `/srv/enclave-base-holder/tmp/state-gsi/{stage,x-home,extract-state}` exist, with the work dir root 0700; guest free ≥ archive + 1,138,167,361,549 + 200 GB.
   - **Copy:** `rsync --partial --append-verify --inplace --timeout=600 [--bwlimit] --chown=root:root --chmod=F0600 --rsync-path="sudo -n rsync"`. Resumable and bounded, with no second WAN fetch; the host archive is kept and only read.
   - **Assumptions to check first:** rsync is present in the guest, and `rpcadmin` has passwordless sudo. The script refuses if either is not true.
3. **`guest_state.py import-verify`:** size == manifest and the guest's full sha256 == provenance (rc 10 otherwise); records inode/dev/mtime.
4. **Confined extraction** (`enclave-base-state-extract-gsi.service`, oneshot, by hand):
   - **Command:** the pinned base binary (`9c44836d…`), `snapshot download --chain base --datadir <stage> --url file://<archive>`.
   - **Legacy path checked in reth 7134be3:** `mod.rs:504-534` calls only `stream_and_extract` (`file://` supported, `extract.rs:558`), then `return Ok(None)`. No `write_config`/`init_db`, so the staged DB stays exactly the archive's bytes.
   - **OS confinement:**
     - `ProtectSystem=strict` with `ReadWritePaths` = **only** `stage/ x-home/ extract-state/`. The archive, the work-dir records, `data/` and the holder root are read-only, so an escaping entry fails with EROFS/EACCES.
     - `PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`.
     - **No capabilities** (`CapabilityBoundingSet=` empty), so no mknod or chown.
     - `NoNewPrivileges`, `RestrictSUIDSGID`, `PrivateDevices`, `SystemCallFilter=@system-service`, `MemoryMax=4G`, `MemorySwapMax=0`, `Restart=no`.
     - **No `Conflicts=`:** that would make systemd stop a running retention.
   - **Then** the exact set: only `db/` plus the 4 declared files; regular, `nlink 1`, exact sizes, no setuid/setgid/sticky or group/other write. Otherwise rc 8 and nothing is installed.
5. **Install** (`enclave-base-state-install-gsi.service`, by hand; never runs the extractor):
   - **Refuses when:** a retention or holder unit is active; `state-installed.json` exists; `data/db` is absent, not owned by the datadir owner, or not empty.
   - **Before anything moves:**
     - the exact staged set and staged identity (unchanged since extraction);
     - the root-qualified BLAKE3 tool (pinned sha256, copied to the private work dir 0500 and executed from there, KAT BLAKE3("") = `af1349b9…3262`);
     - each output equal to the manifest hash (see the table below); otherwise rc 10 and nothing is installed.
   - **Then:**
     1. `install-intent.json`;
     2. per output: `fchown` (O_NOFOLLOW) to the datadir owner, `rename` into `data/db`, fsync both directories;
     3. foreign-file check;
     4. `state-installed.json`, with size/mtime/inode/dev/uid/gid/BLAKE3 per file.
   - **Idempotent:** a re-run after a crash completes exactly the recorded renames, and refuses any other state. The archive is never deleted.
6. **Guard** (`ExecStartPre=+ … guest_state.py guard` drop-in for `enclave-base-retention.service`):
   - **Ordering:** systemd runs the unit's own ExecStartPre lines (mountpoint, `retention_guard.py pre`) and then the drop-in's, all **before** `ExecStart` (reth). So there is no check-after-deletion window.
   - **Refuses when:** `retention-complete` exists (finalized, so a start would delete and re-download); there is no installed record or it is not this manifest's; there are extra `db/` files; any output's size/mtime/inode/dev changed.
   - Otherwise the state is byte-identical to the BLAKE3-verified install, so reth's own reuse check passes and nothing is deleted.
   - After the first successful retention run finalizes the DB, every later retention start is refused (repeat-finalized policy).
   - **Holder start and readiness are untouched.**

**The manifest's state outputs** (`logs/base-manifest.body`, pinned manifest `1f0c4e6c…`):

| path | size | BLAKE3 |
|---|---|---|
| `db/database.version` | 1 | `813e9b729141e7f385afa0a2d0df3e6c3789e427ffe4aeef566a565bc8f2fe3d` |
| `db/lock` | 12 | `9ab30451140325989ce85269ed330d93149afac6b4f2dd8decf954b3aeb215bb` |
| `db/mdbx.dat` | 1,138,166,333,440 | `8de35ff5950e596c4d012b471a3b21cd79762e7dbd5f733267b691c59ea09ef9` |
| `db/mdbx.lck` | 1,028,096 | `9717741509677596feeda872fd928f597c7612dd602ef4113789db260ec73b0b` |

## b3sum qualification plan (root; not done; the stub SHA-256 is NOT BLAKE3)
1. **Obtain the candidate inside the guest** (noble): `apt-get download b3sum` (candidate `1.2.0-1`; small, not the archive).
   - apt verifies the signed `InRelease` → `Packages` SHA256 → `.deb` chain with the guest's `ubuntu-archive-keyring`.
   - **Do not install it.** Run `dpkg-deb -x` into a root 0700 dir and record the `.deb` sha256 plus the `Packages` stanza.
2. **Pin** the extracted `usr/bin/b3sum` sha256 into `/etc/enclave-rpc/gsi.env` (`GSI_B3SUM`, `GSI_B3SUM_SHA256`).
3. **Qualify:**
   - (a) the tool's KAT on empty input is built into `install`;
   - (b) optionally, the official BLAKE3 test vectors from the signed source package (`apt-get source --download-only`), only if they are present there; do not invent vectors;
   - (c) **on real data:** the three small outputs must equal the manifest hashes, and install also checks `mdbx.dat`. A wrong tool cannot pass silently, since the result is a mismatch (rc 10) and nothing is installed.

## Root commands (not run)
**Tests:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh gsi-r1 256 unshare -Urn bash guest-state-install-stage/r1/jobs/root-gsi-r1-tests.sh
```
- Labelled stubs only; needs python ≥ 3.14 (tarfile zstd). PASS = `Ran 13 tests` + `OK`.
- **Coverage:**
  - import: identity, sha, format and size refusals;
  - extract: clean env, exact argv, data untouched; refuses symlink, hardlink, fifo, extra file or dir, missing, wrong size and setuid; extractor failure then clean retry; archive changed or binary unpinned;
  - install: verify, rename, record, archive kept, no re-install; wrong digest, non-empty or missing `db`; staged changed; wrong tool pin; KAT required (a SHA-256 stub fails it without the test-only value); `--kat-expect` refused outside test mode; crash after 1, 2 or 3 renames resumes exactly;
  - guard: nothing installed; mtime changed (finalize); marker present; extra file; foreign record;
  - units: extract confinement directives; install never extracts; drop-in order after `retention_guard.py pre` and before ExecStart.

**Live order:**
1. host provenance;
2. VM up (48 GiB plan);
3. create the work layout (root 0700);
4. transfer, then import-verify;
5. qualify b3sum;
6. install the two units, the drop-in and `gsi.env` (`daemon-reload`);
7. start the extract unit, check, then start the install unit;
8. only then a retention run. Its guard admits only the pristine installed state, and its own `retention_guard.py pre` still applies, including capacity: the kept 761 GB archive occupies the base filesystem.

## Limits / unknowns
- **tar behaviour:** tar-rs `Archive::unpack` on hostile entries is not tested here (stub only). The OS confinement is the control; it is not proven under the real extractor until root runs it.
- **Guest systemd:** noble's systemd (255) is assumed to support every directive used. `systemd-analyze verify` in the guest is a recommended first check.
- **`apt-get download`** needs the guest's normal apt network (not the archive WAN). Otherwise transfer the signed `.deb` and its `Packages` file locally and verify them the same way.
- **Base filesystem capacity:** archive 761 GB + state 1,138 GB + the r2 history plan (about 1.16 TB per selection-r4) must fit with reserves. Check before each phase; the transfer script checks archive + state + 200 GB only.
- **The old `.download-cache/state.tar.zst.part`** is preserved and untouched. It is not under `db/`, so the guard ignores it.
