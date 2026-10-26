# journal-recovery-verifier-stage/r2: a HARNESS/FIXTURE-ONLY fix of r1 (root 1646; PREPARED by Claude, nothing run)

- **Unchanged:** `jbd2_verify.py` (`d3cfa34e…`), `jobs/root-verify.sh`, `targets/` and `upstream/` are byte-identical to frozen r1 (SUMS `1a7bcc31…`), so the verification runtime is unchanged.
- **Changed:**
  - `tests/test_jbd2_verify.py`: every fixture file is closed, and the verifier's own stdout/stderr are captured inside the tests (`vmain`).
  - `jobs/tests.sh`: runs `python -u -W always::ResourceWarning` with separate stdout/stderr. PASS requires exactly one `Ran 9 tests`, a last stderr line of exactly `OK`, **empty stdout**, and no ResourceWarning, skipped, FAIL, ERROR or Traceback. It writes `runs/tests-*/receipt.json`.
- **Tests job:** `bash jobs/q-exit-status.sh jrv-r2-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r2/jobs/tests.sh`

---
(r1 README follows; its tests command is superseded by the one above)

# journal-recovery-verifier-stage/r1 (PREPARED by Claude; nothing run except a 4 KiB superblock check)

`jbd2_verify.py`: a bounded OFFLINE verifier of a JBD2 csum-v3 journal COPY. It is separate from `journal-recovery-stage/r1` (an unauthenticated inventory, unchanged).

**Semantics:** taken from pinned upstream Linux `fs/jbd2/{recovery,commit,journal,revoke}.c` and `include/linux/jbd2.h` (`upstream/`, with URLs and sha256 in the module, fetched at `upstream/FETCHED_AT`). Checksums use raw CRC32C:
- **Seed:** `crc32c(~0, s_uuid)`.
- **Superblock:** `crc32c(~0, sb[0:1024])` with `s_checksum` zeroed.
- **Descriptor/revoke:** the 4-byte tail, computed over the block with the tail zeroed.
- **Commit:** `h_chksum[0]` over the whole block with that field zeroed, or the 64-byte partial form.
- **Tag v3:** `crc32c(crc32c(seed, be32 seq), the escaped image as logged)`.

**Revoke precedence:** a revoke at sequence ≥ the tag's sequence revokes it.

**Proof:**
- **The walk:** each committed transaction is walked contiguously from one of its own descriptor/revoke blocks to exactly its commit. Every block must carry its sequence, and every checksum must verify.
- **What counts as proven:** only images on such a walk.
- **What a proven image is:** authentic content AS LOGGED in that committed transaction. It is never current-state proof, and never a recovery acceptance. Newer or unprovable references are listed.
- **Nothing is written** except one new 0600 JSON (≤ 16 MiB); only image sha256s are reported.

**Bounds:**
- the header index uses compact arrays;
- one 4 KiB block is in memory at a time while walking;
- walk reads are ≤ 4 × the log length;
- reference/revoke index entries are capped at 200,000;
- listed output entries are byte-budgeted (12 MiB) **as they are appended**, with exact totals still counted.

**Run it under a 256 MiB queue lane.**

**CRC:** production uses `libext2fs` `ext2fs_crc32c_le` (path and sha256 recorded). It is self-tested against the CRC-32C check vector and the reference table. The pure table is for fixtures only.

| job | command |
|---|---|
| tests (9) | `bash jobs/q-exit-status.sh jrv-r1-tests 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/tests.sh` |
| actual | `bash jobs/q-exit-status.sh jrv-r1-verify 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/root-verify.sh [ABS_TARGETS]` |

**The actual job:** it checks the copy's sha256 (`d95d81fc…`) before and after the run. Its default targets are fs block 499122346 (the current `/data/db` directory block) and the journal positions 88134, 109966, 117979 and 118419 (the namescan hits).
