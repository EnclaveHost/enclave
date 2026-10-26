# Host state fetch r3 (EARLY report, 2026-10-26 ~16:18 UTC): VM-free durable download of the pinned state archive

**Status: PREPARED, NOT TESTED.**
- I ran no tests, build, queue, network, live action or commit; only checks were `py_compile` and `bash -n`.
- Production deployment is root's, and only after the tests pass.
- Data recovery remains the primary request. This stage adds nothing beyond the fetch.

**Stage:** `resumable-state-recovery-stage/r3/`, **SHA256SUMS sha256 `e27c06e3b80c49bd1e640bbd6eae4bec28940343b0353b44e4e5d4490be299a0`** (6 files, read-only).
- r1 and r2 are untouched; r2 `aa1add08…` was re-verified.

## 1. Root 1438 (r2) failures, read exactly (`r2/logs/run-20261026T160706Z-1999822`)
**Controller: 12/12 PASS. Fetch/extract: 35 ran, FAILED (3 failures, 1 error).** Every failure is in `Extract`, with one cause in my r2 code:
- **The cause:** `srr2.py` ran the extractor with `env={'PATH','HOME','TMPDIR','LC_ALL'}` only. The labelled stub therefore never received `STUB_MODE` or `STUB_ARGV_LOG`.
- **The resulting failures:**
  - `test_confined_extraction…`: the argv log was never written (`FileNotFoundError`);
  - `test_hostile_or_wrong_staging…`, `test_wrong_blake3…` and `test_extractor_failure…`: no hostile mode was injected, so a correct extraction returned 0 where 8, 10 and 9 were asserted.
- **What it means:** the assertions are right; the harness wiring is wrong. **Extraction is not qualified.**
- **Required fix** (in a later extract stage, without weakening assertions): give the stub its mode through a file under the test's own directory, not the environment.
- The stderr `ConnectionResetError` at the top of the TAP comes from the fault server's intentional cuts. It is not a failure.

## 2. Correction requested by root's 15:54 note
- **My earlier claim** (from source reading): a graceful stop always deletes the reth segmented `.part`.
- **Observed:** after the controlled stop at 15:53:59, `state.tar.zst.part` still exists (logical 761,228,785,915, about 4.3 GB allocated). **My claim was wrong for this stop.**
- **What still holds:** the next reth start would truncate it (`create_file`), and it has no piece record. It is preserved as evidence only. r3 never reads, adopts or overwrites it; it is in the guest qcow2, and r3 runs on the host in a new directory.

## 3. r3: host-only fetch (root's chosen path: VM off, 256 MiB queue lane)
- **Paths and pins:**
  - target `/mnt/usb/enclave-rpc-production/state-recovery-r3`: a new 0700 dir owned by uid 1000 (parent `steven 0700`; ntfs3 `uid=1000,gid=1000,dmask=0022,fmask=0022,acl,prealloc`; about 33.4 TB free when read);
  - the manifest is the **local copy** `logs/base-manifest.body` = sha256 `1f0c4e6c…`, copied into the stage and re-verified at every start. No `payload-v2/snapshots` copy exists on this host. Nothing is downloaded besides the archive;
  - pinned URL `https://mainnet-v2-snapshots.base.org/1792886410/state.tar.zst`; pinned total 761,228,785,915.
- **Ownership:** explicit production ownership (`--owner-uid` = the running uid; the job requires 1000). No test-mode bypass, no systemd units and no guest `/proc` assumptions. Host `/proc` is scanned only for processes using work-dir files.
- **ETag pre-review:** `probe` records one `bytes=0-0` response for root to review. `fetch` **requires** the reviewed strong ETag and Last-Modified, sends `If-Range` on every request, and stores the pins with the committed offset. A run with different pins refuses.
- **Bounded chunks** (64 MiB maximum), validated before commit: status, exact range and total, numeric Content-Length = received, identity encoding, no duplicated critical headers, no redirect, and both pins. `pwrite` + `fsync` + atomic committed offset.
- **Failure behaviour:** **failures never discard committed bytes.** Each start truncates only its own uncommitted tail. The work dir must contain only this tool's files, so a foreign `old.partial` refuses and nothing is overwritten.
- **Capacity:** free ≥ remaining archive + reserve, with reserve ≥ 500 GB. The archive is kept.
- **Durable owned controller** (`jobs/host-state-fetch-r3.sh`):
  - **runs** in the queue's 256 lane, so the queue's memory guard holds the 16 GiB floor continuously;
  - **refuses to start** unless MemAvailable ≥ 16,384 + 256 MiB at start;
  - **forwards** INT/TERM/HUP, and has a `timeout` deadline. Every stop keeps committed progress;
  - **logs** only events (offsets, codes) to the stage; user data stays in the private work dir.
- **Review findings closed for fetch:**
  - **S1:** malformed or duplicated headers become a classified stop, not a traceback;
  - **S2:** pins are mandatory;
  - **S4:** curl dies with the tool (`PR_SET_PDEATHSIG`);
  - **B1:** no guest unit is needed for fetch on the host.

## 4. Root jobs (prepared)
```
# tests (exactly 30, bare OK, on the TARGET ntfs3 filesystem; HOME untouched; loopback HTTP only)
SRR3_TEST_ROOT=/mnt/usb/enclave-rpc-production/srr3-test \
  jobs/q-exit-status.sh root-srr3-tests-1 1024 bash resumable-state-recovery-stage/r3/jobs/root-srr3-tests.sh
# then probe (review probe.json), then fetch with the reviewed pins
jobs/q-exit-status.sh root-host-state-fetch-r3-probe 256 bash resumable-state-recovery-stage/r3/jobs/host-state-fetch-r3.sh probe --max-hours=1
jobs/q-exit-status.sh root-host-state-fetch-r3-1 256 bash resumable-state-recovery-stage/r3/jobs/host-state-fetch-r3.sh fetch \
    --max-hours=<n> --expect-etag='<reviewed>' --expect-last-modified='<reviewed>'
```
- `srr3-test` must be created first: 0700, uid 1000, on the same filesystem.

**The 30 tests** (never run):
1. a filesystem-semantics check of the target (mode 0700 persists, `O_NOFOLLOW`, `pwrite`/`fsync`, `rename`, dir `fsync`, cross-process `flock`);
2. a multi-chunk byte-identical fetch under the pins;
3. probe review, committing nothing, with weak-ETag refusal;
4. pins mandatory and matching;
5. pins changed between runs: never spliced;
6. SIGKILL mid-chunk;
7. SIGKILL after `pwrite` before commit (own tail truncated);
8. SIGKILL before the first `pwrite`;
9. an external process-group SIGKILL;
10. SIGTERM keeping progress;
11. 13 refusals, each with nothing committed: 200 on the first chunk or on resume, wrong start, wrong total, ETag change (If-Range → 200, and on a 206), a Last-Modified change, a weak ETag, gzip, a redirect, an oversize body, a malformed Content-Length, a duplicated Content-Range;
12. retries for a truncated body, a stall and 503;
13. a capacity refusal before any request;
14. ownership: symlinked or 0750 work dir, a foreign `old.partial` preserved, a symlinked archive, an owner-uid mismatch;
15. lock held, archive busy, a process with its cwd in the work dir;
16. inconsistent local state: an unknown archive, committed bytes missing, a malformed `committed.json`;
17. provenance and bounds (sha, URL, total, 128 MiB chunk, reserve below 500 GB, http without the loopback switch);
18. hostile `.curlrc` and proxy env ignored.

**Unsettled until run:**
- what curl writes to `-D` on early aborts (`--max-filesize`, malformed Content-Length); the refusal code is 6 either way by design;
- the stall timing;
- **ntfs3 symlink/mode semantics.** If 0700 does not persist, both the tests and the tool refuse (fail-safe).

## 5. Exact inputs root provides
- **For the tests:** `SRR3_TEST_ROOT` (0700, uid 1000, on the target filesystem).
- **For fetch:**
  - the reviewed `--expect-etag` and `--expect-last-modified` from `probe.json`;
  - `--max-hours` per window;
  - optionally `--reserve-bytes` ≥ 5e11;
  - admission of the 256 MiB lane. The fit is expected to be small but is **unmeasured**.

## 6. Still required later (documented; NOT qualified here)
- **Integrity:** BLAKE3 of the 4 extracted outputs against the manifest, with a separately qualified tool (`b3sum 1.2.0-1` is only a candidate).
- **Confined extraction (B2):** a sandboxed extraction step plus a separate install step that sets the datadir owner (S3) and runs the BLAKE3 tool from a verified private copy (S5). The r2 extract harness fault (§1) must be fixed first.
- **Finalize/unit guards:** the record-based guard must run as an `ExecStartPre` drop-in in the retention unit (B3), plus the capacity rule of `retention_guard.py pre` with the kept archive.
- **Phase 3 deadline:** still unsafe for in-flight history archives. A stop after finalize but before the marker requires manual review.
- **Guest import** of the verified outputs is a separate reviewed phase.
- **No claims:** I make none about chain state, readiness, the extraction or throughput. The network bottleneck remains an inference.
