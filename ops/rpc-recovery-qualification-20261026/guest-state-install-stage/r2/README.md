# guest-state-install-stage/r2 (PREPARED by Claude; nothing run). r1 + the independent review's B1/B2 + the resume-mtime item. r1 stays frozen

Review: `logs/claude-guest-state-install-review.md`.

**Fixes:**
- **B1:** tar-rs applies the header mode & 0o777, and the umask does not apply. The staged-set check no longer refuses group/other bits (setuid/setgid/sticky still refuse). `install` sets every output to 0600 (`fchmod` next to `fchown`); this changes neither the content nor the mtime.
- **B2:** `extract-stage` refuses once `install-intent.json` exists. A partial install is finished only by `install`.
- **Resume mtime:** the resume identity includes the mtime.
- **Units and paths:** `/opt/enclave-rpc/state-install-r2/`. The record format is `enclave-guest-state-install/r2`.
- **Harness:** `python3 -I -m unittest discover -s <absolute test dir> -t <same>`. No HOME override.

**Tests:** 16, with LABELLED stubs: an extractor that applies header modes as-is (like tar-rs), with its fault mode baked into its own file, and a SHA-256 "BLAKE3" tool with a test-only KAT.
- **New regressions:**
  - 0664/0444/0666/0640 headers extract and install as 0600;
  - extract after a partial install refuses, every staged and installed byte and identity is preserved, and resume succeeds;
  - resume refuses a changed mtime on a staged or installed file.

**Python:** production `guest_state.py` targets the guest's Python 3.12. The tests need Python ≥ 3.14 on the host (`tarfile` zstd).

**Not a qualification:** the review's Q1-Q4 (real BLAKE3 tool, guest confinement with the real binary, live guard ordering, the real run) remain root's.
