# offline-b3sum-bundle-stage/r2: review corrections S1–S4, explicit-only HTTP, guarded fetch admission (source only)

**Status: PREPARED, NOT RUN.**
- No test, build, network, queue, package execution, VM or live action by me. The only local checks were `ast.parse` (no bytecode written) and `bash -n`.
- I also read two pinned trust files: `logs/guest-trust-1492/ubuntu-archive-keyring.gpg` sha256 = `80a36b0a…5c31` and `ubuntu.sources` sha256 = `e93b42f6…d3`, and inspected its `URIs:` lines.
- r1 is untouched: its SHA256SUMS is still `405fe0a8…` and verifies.

**Stage:** `offline-b3sum-bundle-stage/r2/`, **SHA256SUMS sha256 `8118e2ca22c14ec75c1b6bb0c92a931cbafdc9d780559b06308daba5d0680382`**. Files are read-only (0444):

| file | sha256 |
|---|---|
| `b3bundle.py` | `099ea9d82591a2929c394a57c778c976eca8c2b9a57f03241ef7a03b5aa01806` |
| `test/test_b3bundle.py` | `41512e3485180e1a44676c88dac34655c58206451fa061e995572623a324c64d` (28 tests) |
| `jobs/root-b3bundle-tests.sh` | `c049ee2d06a4bdbf3572958643bbb780c6972594b0c581944b9295f5a2c51d79` |
| `jobs/root-b3bundle-fetch.sh` | `0943d8ca36c1a9c1331f9ab9a23a4e19a5daf34a924099f2348c6ab5a4a69b7f` |
| `README.md` | `b97fef8c28cf5523a52c9ab037884beda01d1c0ce4ff4238f8d6b397787cfd06` |

## Corrections (against `logs/claude-b3bundle-r1-review.md`)
- **S1 (version pin):**
  - `--package-version` is required, with a strict Debian-version regex (rc 2). There is no built-in version any more.
  - The stanza `Version` must equal the pin, and the pool file name must be `b3sum_<pin without epoch>_amd64.deb`.
  - The receipt records `packageVersion`, and `qualify` compares it.
  - The `--version` check is derived from the pin: the first line must be exactly `b3sum <upstream>` or `b3sum <upstream> …`. r1's `startswith('b3sum 1.2.0')` accepted `1.2.01`; r2 refuses it.
- **S2 (typed failures):**
  - `tarfile.TarError` → rc 9.
  - `validate_receipt` refuses a malformed or r1-format receipt with rc 2 before any indexing.
  - `main` has a final `except Exception` → rc 2 with a JSON `refused` event. There is no traceback path.
- **S3 (trust inputs):** `compare_receipt` requires the receipt's `transport`, `origin`, `suite`, `component`, `keyringSha256`, `packageVersion` and `allowedPrimaryFingerprints` (sorted, upper case) to equal the qualify inputs (rc 2). The guest-verified `primaryFingerprints`, stanza, `.deb`, signed-Release and Packages hashes must equal the receipt (rc 8).
- **S4 (digest algorithm):** every `VALIDSIG` must use hash algorithm 8, 9 or 10 (SHA-256/384/512). Anything else gives rc 7, including one weak signature among good ones.
- **B1 (transport):**
  - HTTPS stays the default (`--proto =https --tlsv1.2`).
  - HTTP is used only with an explicit `--transport http`, and only for exactly `http://archive.ubuntu.com/ubuntu` and `http://security.ubuntu.com/ubuntu`, the URIs in the pinned guest sources. It then uses `--proto =http`.
  - `--max-redirs 0`, the size caps and the full signed-metadata chain are identical in both modes.
  - The transport is recorded in the receipt and compared.
- **B2 (memory):**
  - The Packages index stays bytes; only `Package: b3sum` stanzas are decoded.
  - A stanza whose `Package` is not its first field, a duplicated field or non-UTF-8 refuses (rc 8).
- **S5:** unchanged. As the review noted, `--max-filesize` does not apply without Content-Length; `curl_get` still checks the file size against the cap after download.

## Regression tests (28 = r1's 14 adapted + 14 new; prepared, NOT run)
- **Weak digest:**
  - algorithms 1, 2, 3, 11, 0, `SHA256` and `08` each refuse with rc 7;
  - a mixed good and weak pair refuses;
  - 8, 9 and 10 are accepted.
- **Changed trust inputs:**
  - each of an extra or other allowed fingerprint, keyring sha, version, transport, origin, suite and component refuses with rc 2;
  - a receipt with a wider allowed set refuses;
  - changed evidence (primary fingerprints, deb, Release, Packages or stanza) refuses with rc 8;
  - the same inputs pass, with lower-case fingerprints normalised.
- **Version pin:**
  - syntax: 5 versions accepted and 11 malformed ones refused;
  - the stanza follows the pin, a missing pinned version refuses, a file-name and version mismatch refuses, and epoch handling works;
  - the tool's `1.2.01`, `1.2.0-x`, `1.2` and a different version all refuse.
- **Typed failures:**
  - an empty, garbage or truncated tar gives rc 9;
  - 13 malformed receipts give rc 2;
  - `TypeError`, `AttributeError`, `IndexError`, `JSONDecodeError` and `ReadError` in `main` give rc 2 with a JSON event.
- **Transport:**
  - an HTTP origin under https, an https origin under http, a mirror, a trailing slash, ports and ftp are all refused;
  - the exact HTTP origins pass only with an explicit `http`;
  - the argparse default is `https`;
  - the curl `--proto` matches the transport, `--max-redirs 0` is always passed, there is no `-L`, `--tlsv1.2` is passed only for https, and a curl failure gives rc 6.
- **Bytes scan:** `b3sum-extra` is not matched, a `Filename` hidden before `Package` refuses, and a duplicated `SHA256` refuses.

## Root commands
1. **Tests** (offline):
   ```
   jobs/q-exit-status.sh root-b3bundle-r2-tests 256 unshare -Urn bash offline-b3sum-bundle-stage/r2/jobs/root-b3bundle-tests.sh
   ```
   PASS only with exactly `Ran 28`, a bare `OK` and rc 0.
2. **Primary fingerprints**, derived separately by root (no import):
   ```
   GH=$(mktemp -d) && gpg --homedir "$GH" --no-default-keyring --no-auto-key-retrieve --show-keys --with-colons --fixed-list-mode \
       logs/guest-trust-1492/ubuntu-archive-keyring.gpg | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}'; rm -rf "$GH"
   ```
   Root decides which of these to allow.
3. **Actual fetch** (network; main lane 1536 MiB; 16 GiB physical floor):
   ```
   jobs/q-exit-status.sh root-b3bundle-fetch 1536 bash offline-b3sum-bundle-stage/r2/jobs/root-b3bundle-fetch.sh \
       <SUITE> <COMPONENT> <PACKAGE_VERSION> https <NEW abs OUT_DIR> <PRIMARY_FPR> [<PRIMARY_FPR> ...]
   ```
   - **Admission:**
     - the queue starts it only at MemAvailable ≥ 16384 + 1536 + 256 MiB (plus any concurrent reservation), under `MemoryMax=1536M` and no swap;
     - the guard stops the tree below 16384 MiB available and writes `peakTreeRssMiB` to `logs/root-b3bundle-fetch.guard`;
     - the job itself also refuses (rc 9) below 16384 + 1536 MiB.
   - **Fixed inside the job:**
     - keyring `logs/guest-trust-1492/ubuntu-archive-keyring.gpg`, sha256 `80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31`;
     - `ubuntu.sources` sha256 `e93b42f6…`;
     - the origin is derived from the suite as in those sources;
     - it checks the bundle against its `SHA256SUMS` and prints the `receipt.json` sha256 for root to pin.
   - **HTTP:** replace `https` with `http` only by explicit root decision.
4. **Guest qualify:** see `README.md`. Use the same fingerprints, version, transport, origin, suite and component, plus the receipt pin.

## Open points (not verified by me)
- **Signing keys:** which primary keys actually sign noble's InRelease. An unlisted key fails closed (rc 7). Root's fetch output (`gpgvStatus`) shows them.
- **Version:** the exact version and pocket of `b3sum` in noble. A mismatch fails closed (rc 8, `found 0`).
- **HTTPS:** whether the archive serves HTTPS without redirects; otherwise rc 6. HTTP is then root's explicit choice.
- **gpgv run conditions:** gpgv runs with a minimal env (no `HOME`). If it fails for homedir reasons, that is rc 7, fail closed, and the job needs an adjustment.
- **Memory:** the actual peak RSS is not measured; it comes from the guard log.
