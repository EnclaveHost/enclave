# offline-b3sum-bundle-stage/r1: Q1 without guest network (EARLY report; source only)

**Status: PREPARED, NOT RUN.**
- No network, test, build, extraction, VM, queue or live action by me; the only checks were `py_compile` and `bash -n`.
- No key, fingerprint, hash or URL is guessed. The test fingerprint is a plainly synthetic value.
- The existing Q1 scripts are not modified.

**Stage:** `offline-b3sum-bundle-stage/r1/`, **SHA256SUMS sha256 `405fe0a82b65f8e347568ac1878b2e5d0b1b2df7d68378de9679fc6f96ad839b`** (4 files).
- `b3bundle.py`: `fetch`/`qualify`, stdlib, Python ≥ 3.9;
- `test/test_b3bundle.py`: 14 logic tests;
- `jobs/root-b3bundle-tests.sh`;
- `README.md`.

## Design
**Host `fetch`** (Arch, no Ubuntu keyring or b3sum needed; HTTPS to the allowed Ubuntu origin only; writes only a NEW 0700 dir):
- **Root pins:**
  - `--keyring` (absolute) + mandatory `--keyring-sha256`: the guest's own `ubuntu-archive-keyring`, extracted read-only by root's pinned OS inspector;
  - `--allowed-primary-fpr`;
  - origin, suite and component from fixed allowlists (`https://archive.ubuntu.com/ubuntu` | `https://security.ubuntu.com/ubuntu`; `noble` / `-updates` / `-security`; `main` / `universe`).
- **Download:** curl, https only, no redirects, size caps.
- **Signature:** gpgv `--status-fd` with **only** that keyring. It requires `GOODSIG`/`VALIDSIG` pairs from pinned primary fingerprints; any bad, unknown or expired status refuses. Only the gpgv-output signed Release text is parsed.
- **Package index:** `Packages.xz` size and sha256 are checked **before** decompression, and decompression is bounded. The decompressed `Packages` must match its Release hash when listed.
- **Package file:** **exactly one** `b3sum 1.2.0-1 amd64` stanza, a strict pool path (no traversal), then the `.deb` size and sha256 must equal the stanza.
- **Output:** `receipt.json` (URLs, gpgv status lines and fingerprints, every hash and size, stanza) and `SHA256SUMS`. The `.deb` is **never extracted or executed on the host**; there is no apt install and no global change.

**Guest `qualify`** (noble, root, offline):
- **Pins:** the receipt must match its pin. The guest's own keyring must match its pin, which must equal the receipt's keyring.
- **Re-verification:** the whole chain (signature, fingerprints, Release, `Packages.xz`, Packages, stanza, `.deb`) must equal the host receipt.
- **One file extracted:** **only** `./usr/bin/b3sum`, read from the `dpkg-deb --fsys-tarfile` stream (one regular member, no links, no traversal anywhere) and written 0500 with `O_EXCL`.
- **Tool checks:** `--version` must start with `b3sum 1.2.0`, and the empty-input KAT must give `af1349b9…3262`.
- **Record:** `qualification.json` with the **proposed** `GSI_B3SUM_SHA256`.

**Scope, honestly:** version and empty-input KAT only, with no source-tarball vectors. **Native qualification remains Q4**: install's BLAKE3 of all 4 state outputs, including the 1.14 TB `mdbx.dat`, against the manifest.

## Tests (14, prepared, NOT run)
- **gpgv status:**
  - a good signature from a pinned key passes;
  - each of `BADSIG`, `ERRSIG`, `NO_PUBKEY`, `EXPKEYSIG`, `REVKEYSIG` and `EXPSIG` refuses;
  - a missing, incomplete or unpinned signature refuses.
- **Release:** a wrong suite or codename, a missing `.xz` entry, a malformed hash line, or a duplicate entry refuses.
- **Stanza:**
  - exact selection among versions and arches;
  - a missing or duplicate version refuses;
  - path traversal, absolute, `//`, wrong component, wrong name or URL filenames refuse;
  - a malformed or oversized size or sha refuses.
- **Digests:** a wrong digest is refused **before** decompression; a size mismatch refuses; an xz bomb is capped and a truncated stream refused.
- **Payload:**
  - only the tool member is returned;
  - `../`, an absolute path, a symlink, a hardlink, a duplicate, a missing or empty member, and a traversal elsewhere all refuse;
  - a wrong version or KAT refuses.
- **Inputs:** origin, suite and component allowlists; keyring pin mismatch, relative path and symlinked keyring; missing or malformed fingerprints.

**Root job:** `jobs/q-exit-status.sh root-b3bundle-tests 256 unshare -Urn bash offline-b3sum-bundle-stage/r1/jobs/root-b3bundle-tests.sh` (exactly 14, bare `OK`).

## Exact root inputs and known open points
- **Inputs:**
  - the keyring file and its sha256, plus the accepted primary fingerprints (from the OS inspector);
  - the origin, suite and component that actually carry `b3sum 1.2.0-1` in the guest's sources;
  - the `receipt.json` pin after fetch;
  - the bundle transfer into the guest.
- **Open:**
  - whether noble's InRelease carries any signature from a key **not** in that keyring. A `NO_PUBKEY`/`ERRSIG` fails closed by design, which may need root review.
  - whether the archive serves the paths over HTTPS without redirects. A redirect fails closed (rc 6).
