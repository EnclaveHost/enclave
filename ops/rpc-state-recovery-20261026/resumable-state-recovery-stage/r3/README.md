# resumable-state-recovery-stage/r3: HOST-ONLY durable fetch of the pinned state archive (no VM)

**PREPARED, NOT TESTED.** Claude ran no test, build, queue, network or live action. Root runs the tests, then any production fetch. r1 and r2 are untouched (r2 frozen `aa1add08…`).

**Scope:**
- Fetch only: the 761,228,785,915-byte `https://mainnet-v2-snapshots.base.org/1792886410/state.tar.zst` into `/mnt/usb/enclave-rpc-production/state-recovery-r3/` on the host. The RPC VM stays off, so no 16+ GiB VM blocks production admissions.
- **Extraction, BLAKE3 qualification, guest import and the finalize/unit guards are later, separate phases and are NOT qualified here** (see the last section).
- This does not recover the removed MDBX; it re-fetches the snapshot's state archive.
- **The old `.part` is never touched or adopted:** reth's `.download-cache/state.tar.zst.part` (logical size 761,228,785,915, about 4.3 GB allocated), inside the guest's qcow2.

## Files
| file | role |
|---|---|
| `srr3_fetch.py` | Python stdlib + curl. `probe` (one `bytes=0-0` request for root review) and `fetch`. |
| `manifest/base-1792886410-manifest.json` | A byte copy of `logs/base-manifest.body`, sha256 `1f0c4e6c…` (verified at every start). No manifest is ever downloaded. |
| `jobs/host-state-fetch-r3.sh` | The production host job: the durable owned controller for the 256 MiB queue lane. |
| `jobs/root-srr3-tests.sh` | Offline tests, exactly 30, on the target filesystem. |
| `test/test_srr3.py` | Real curl against a loopback HTTP fault server, with real SIGKILL/SIGTERM. |

## Guarantees (all r2 fetch guards kept, plus host specifics)
- **Ownership:** explicit production ownership. `--owner-uid` must equal the running uid (the job pins 1000, the owner of `/mnt/usb/enclave-rpc-production`). There is no test-mode ownership bypass.
- **Work dir:**
  - a real directory, mode exactly 0700, holding **only this tool's files**. A foreign file (e.g. an `old.partial`) refuses; nothing is mixed or overwritten.
  - every file is opened `O_NOFOLLOW` and must be regular, `nlink` 1, owned by us, with no group/other write;
  - `flock`;
  - refuses if another process has a work-dir file open or its cwd inside the work dir;
  - the parent must be a real directory owned by the owner, without group/other write.
- **Pins reviewed in advance:**
  - `probe` records status, Content-Range, ETag, Last-Modified and encoding in `probe.json`.
  - `fetch` **requires** `--expect-etag` (strong, quoted) and `--expect-last-modified`. Every request carries `If-Range: <ETag>`, and every response must match both pins byte-for-byte. Pins are never taken first-come.
  - `committed.json` stores the pins; a later run with different pins refuses (rc 6, never spliced).
- **Bounded chunks:** ≤ 64 MiB (the job uses exactly 64 MiB). The curl body is read through a pipe into the tool's `O_EXCL` `chunk.tmp` and refused past E−S+1 bytes. curl is killed if the tool dies (`PR_SET_PDEATHSIG`).
- **Validated before commit:**
  - curl exit 0; status 206;
  - `Content-Range` exactly `bytes S-E/N`;
  - `Content-Length` exactly E−S+1 (digits only) = received;
  - identity encoding;
  - no duplicated critical headers; no 3xx anywhere in the chain;
  - strong ETag and Last-Modified equal to the pins.
- **Commit:** `pwrite` at S, `fsync`, atomic `committed.json` (tmp + fsync + rename + dir fsync).
  - **The committed offset is the only progress truth.** Each start truncates only the tool's own uncommitted tail.
  - An archive shorter than the offset, or one without a record, refuses.
  - **Nothing ever discards committed bytes.** An identity change stops for root and never restarts from 0.
- **curl hardening:** `-q` (no `.curlrc`), an environment of `PATH`/`LC_ALL` only (no proxy variables), `--noproxy '*'`, `--http1.1`, `--max-redirs 0`, `--proto =https` (plain http only to 127.0.0.1 with `--allow-http-loopback`, a switch the production job never passes), `--max-filesize`, time and stall bounds.
- **Capacity:** free ≥ remaining archive + `--reserve-bytes`, with reserve ≥ 500,000,000,000, before the first chunk and every 16 chunks. The 761 GB archive is kept. Nothing is deleted to make room.
- **Stops are durable:** deadline (`timeout`), INT/TERM/HUP forwarded, queue memory-guard kill, crash. All keep every committed chunk, and a rerun continues.

## Procedure (root)
1. **Tests:**
   - create `/mnt/usb/enclave-rpc-production/srr3-test` (0700, uid 1000);
   - run `SRR3_TEST_ROOT=… jobs/q-exit-status.sh root-srr3-tests-1 1024 bash resumable-state-recovery-stage/r3/jobs/root-srr3-tests.sh`;
   - it must PASS exactly 30, with a bare `OK`.
2. **Probe:** `jobs/q-exit-status.sh root-host-state-fetch-r3-probe 256 bash …/jobs/host-state-fetch-r3.sh probe --max-hours=1`. Review `/mnt/usb/enclave-rpc-production/state-recovery-r3/probe.json`: 206, `bytes 0-0/761228785915`, a strong ETag, Last-Modified, no encoding.
3. **Fetch:** `jobs/q-exit-status.sh root-host-state-fetch-r3-1 256 bash …/jobs/host-state-fetch-r3.sh fetch --max-hours=<n> --expect-etag='<reviewed>' --expect-last-modified='<reviewed>'`.
   - Repeat after any stop; rc 0 means the transfer completed. That is **not** integrity and **not** readiness.
   - On rc 6, review `events.jsonl` before anything else.
4. **Keep the archive.** No deletion until the later phases complete and root confirms the reader proof is safe.

## Not covered / not claimed
- The real CDN's headers (the probe shows them), and throughput. The network bottleneck is an inference only.
- **256 MiB fit:** expected to be small (one 4 MiB copy buffer, 1 MiB pipe reads, curl), but **unmeasured**.
- **Queue SIGKILL of the job alone:** if the queue SIGKILLs only the job and not its process group, `timeout` and the tool keep running until their own deadline. Root's queue semantics decide this; the tool remains durable either way.
- Power-loss behaviour beyond `fsync` ordering on ntfs3 (the filesystem semantics test covers mode 0700, `O_NOFOLLOW`, `pwrite`/`fsync`, `rename` and `flock` only).

## Later phases (required before ANY chain use; documented, NOT built in r3)
- **Integrity:** the BLAKE3 of the 4 extracted state outputs against the pinned manifest, with a separately qualified tool (e.g. Ubuntu noble `b3sum 1.2.0-1`, root-qualified; nothing installed here). The fetched compressed bytes have no manifest digest; transport checks only prevent splicing.
- **Confined extraction (review B2):**
  - an extraction step sandboxed so it can write only its staging dir (`ReadWritePaths=<stage>`, `PrivateNetwork=yes`);
  - a separate install step: exact output set, BLAKE3, `rename` into `data/db` with the datadir's owner (S3), and a 0400 record;
  - the BLAKE3 tool executed from a verified private copy (S5).
- **Root 1438 extraction failures:** r2's extractor ran with a stripped environment, so the test stub never received `STUB_MODE`/`STUB_ARGV_LOG`. That is a harness wiring fault. The next extract stage must pass the stub's mode through a file in the test's own directory (or an argv-visible path), **without weakening any assertion**.
- **Finalize/unit guards (review A1/A2/B3):** the guard (no record / changed size, mtime, inode, dev without `retention-complete` → no reth start) must run **inside** the retention unit as a reviewed `ExecStartPre` drop-in, not only as a separate controller phase.
  - Phase 3 is not deadline-safe for in-flight history archives.
  - A stop after finalize but before the marker requires manual review.
- **Guest import:** a local transfer of the verified archive or outputs into the guest's datadir. A separate reviewed phase.
