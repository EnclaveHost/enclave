# offline-b3sum-bundle-stage/r3: fetch b3sum on the HOST, qualify it OFFLINE in the guest (Q1 without guest network)

**PREPARED, NOT RUN.**
- Claude ran no network, test, build, extraction, VM, queue or package action. The only local checks were `ast.parse` (no bytecode written) and `bash -n`.
- r1 (frozen, `405fe0a8…`; root 1501 passed its 14 mocked tests) is not modified.
- r2 (frozen, `8118e2ca…`; root 1515 passed its 28 tests) applied `logs/claude-b3bundle-r1-review.md`: S1–S4, plus B1 and B2 as below. It is not modified.
- r3 changes ONLY the xz decoding (below). Root 1516's real fetch verified the signature and the `Packages.xz` hash, then r2 refused the file's trailing data.
- No key, fingerprint, hash or URL is guessed. The keyring pin comes from root's guest-trust record 1492. Fingerprints and the package version are root inputs.

| file | role |
|---|---|
| `b3bundle.py` | `fetch` (host) and `qualify` (guest), ONE stdlib file, Python ≥ 3.9. It is one file because `python3 -I` does not add the script dir to `sys.path`. |
| `test/test_b3bundle.py` | 34 logic tests: r2's 28 plus 6 r3 xz-stream regressions. Synthetic fixtures and mocked gpgv/subprocess only. NOT a qualification. |
| `jobs/root-b3bundle-tests.sh` | Root job: exactly 34 tests, bare `OK`, offline (`unshare -Urn`). |
| `jobs/root-b3bundle-fetch.sh` | Root job: the actual host fetch through the queue main lane, with fixed keyring and origin pins (below). |

## r3 change: concatenated xz streams (root 1516/1517)
Root 1517's read-only inspection (`logs/b3bundle-xz-inspect-1517.json`) shows the official signed noble `universe` `Packages.xz` is **two** xz streams:
- a data stream decoding to 73,379,142 bytes;
- a 32-byte empty stream.

The concatenated output's sha256 equals the signed `Packages` entry. The xz file format (spec §2.2) allows concatenated streams and stream padding. `bounded_unxz` now:
- **Streams:** decodes **every** stream to its end. Each stream gets its own decoder with memlimit `XZ_MEMLIMIT` = 256 MiB, and each stream must reach its end-of-stream (`eof`).
- **Padding:** accepts stream padding after a stream only as zero bytes in a multiple of 4. The file must start with an xz stream.
- **Total cap:** the **total** output of all streams is capped (`CAP_PKGS` = 512 MiB). Each decoder gets `max_length` = remaining budget + 1, so a bomb spread across streams refuses.
- **Stream count:** at most `MAX_XZ_STREAMS` = 8 streams, empty ones included.
- **Refusals (rc 8):** truncation, garbage or non-xz data after a stream, a corrupt stream, invalid padding, too many streams, a memlimit breach or an over-budget total. Trailing data is **never** ignored.
- **Unchanged:** the compressed digest is still checked **before** decompression, and the concatenated output must still equal the signed `Packages` entry when Release lists it. The stanza and `.deb` checks are as in r2.
- **Memory:** in the official layout only one stream is non-empty, so its output is returned without a join copy. Several non-empty streams are joined (≤ 2 × cap transiently).

The receipt and qualification formats are bumped to `/r3`. A guest `qualify` needs an r3 receipt from a fresh r3 fetch.

## r2 changes (kept)
| id | change |
|---|---|
| S1 | `--package-version` is **required** (exact Debian version, strict regex; root pin, no default). The stanza must carry that `Version`, and the pool file name must be `b3sum_<version without epoch>_amd64.deb`. The version is recorded in the receipt (`packageVersion`) and compared in `qualify`. The tool check is derived from the pin: the first line of `--version` must be exactly `b3sum <upstream>` or `b3sum <upstream> …`, so `b3sum 1.2.01` is refused for 1.2.0-1. |
| S2 | Typed failures instead of tracebacks: `tarfile.TarError` → rc 9; a malformed or r1-format receipt → rc 2 (`validate_receipt`); any other unexpected exception in `main` → rc 2 with a JSON `refused` event. |
| S3 | `qualify` (`compare_receipt`) requires the receipt's `transport`, `origin`, `suite`, `component`, `keyringSha256`, `packageVersion` **and** `allowedPrimaryFingerprints` (sorted, upper case) to equal this run's inputs (rc 2). The guest-verified `primaryFingerprints`, stanza, `.deb`, signed-Release and Packages hashes must equal the receipt (rc 8). |
| S4 | Every `VALIDSIG` must use hash algorithm 8, 9 or 10 (SHA-256/384/512). SHA-1, MD5, RIPEMD-160, SHA-224 or unknown refuse with rc 7, even when only one of several signatures is weak. |
| B1 | HTTPS is the default (`--proto =https --tlsv1.2`). Plain HTTP is used **only** with an explicit `--transport http`, and **only** for exactly `http://archive.ubuntu.com/ubuntu` or `http://security.ubuntu.com/ubuntu`, the URIs of the pinned guest `ubuntu.sources` (`e93b42f6…`). It then uses `--proto =http`. In both modes `--max-redirs 0` and the size caps apply. Trust never depends on the transport: the pinned keyring, pinned fingerprints, SHA-2 signature, signed Release, Packages.xz and `.deb` hashes, and the exact stanza are required identically. |
| B2 | The Packages index stays `bytes`. Only stanzas that start with exactly `Package: b3sum` are decoded. A stanza whose `Package` is not its first field, a duplicated field or non-UTF-8 refuses with rc 8. |

## Root inputs
1. **Keyring:**
   - `logs/guest-trust-1492/ubuntu-archive-keyring.gpg`, sha256 **`80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31`**. The fetch job fixes both.
   - In the guest, `/usr/share/keyrings/ubuntu-archive-keyring.gpg` must have the same sha256.
2. **Primary fingerprints:** root derives them **separately**, without importing, and decides which to allow:
   ```
   GH=$(mktemp -d) && gpg --homedir "$GH" --no-default-keyring --no-auto-key-retrieve --show-keys --with-colons --fixed-list-mode \
       logs/guest-trust-1492/ubuntu-archive-keyring.gpg | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}'; rm -rf "$GH"
   ```
   The `fpr` record directly after each `pub` is that primary key's fingerprint. A signature by a key that is not in the keyring fails closed (`NO_PUBKEY`/`ERRSIG`, rc 7). So does a signature by a keyring key that root did not allow.
3. **Suite, component, version:** the pocket and the exact version root chooses, e.g. from the guest's apt policy or root's own index inspection.
   - Suites: `noble` | `noble-updates` | `noble-security`.
   - Components: `main` | `universe`.
   - Version: an exact Debian version string.
   - If the version or pocket is wrong, fetch refuses with rc 8 (`found 0`). Nothing is guessed.
4. **Transport:** `https`, the default policy. Use `http` only if root explicitly selects it, e.g. because HTTPS to the origin is unavailable or redirects (rc 6).

## Host fetch (actual network; root only, through the queue)
```
jobs/q-exit-status.sh root-b3bundle-fetch 1536 bash offline-b3sum-bundle-stage/r3/jobs/root-b3bundle-fetch.sh \
    <SUITE> <COMPONENT> <PACKAGE_VERSION> https <NEW abs OUT_DIR> <PRIMARY_FPR> [<PRIMARY_FPR> ...]
```
**Admission** (the queue main lane, 1536 MiB, with the 16 GiB physical host floor):
- `claude-test-queue.py` starts the job only when MemAvailable ≥ 16384 + 1536 + 256 MiB plus any concurrent reservation. It runs it under `MemoryMax=1536M`, `MemorySwapMax=0`.
- `memory-guard.mjs` (`--max-rss-mib 1536 --floor-available-mib 16384`) kills the tree if host MemAvailable falls below 16384 MiB. It writes `peakTreeRssMiB` and `minHostAvailableMiB` to `logs/root-b3bundle-fetch.guard`. Root records them.
- The job itself also refuses (rc 9) unless MemAvailable ≥ 16384 + 1536 MiB at start.

**Expected peak:** by construction it is below the cap. Limits: Packages ≤ 512 MiB total, xz ≤ 64 MiB, one 256 MiB-memlimit decoder at a time, `.deb` ≤ 32 MiB; these are not all held at once. The official layout returns its single non-empty stream without a join copy; root 1517 measured 73,379,142 decoded bytes. The real figure is the guard's `peakTreeRssMiB`; Claude has not measured it.

**Job checks**, before any network access; each refusal is rc 9:
- stage == `SHA256SUMS`;
- keyring sha == `80a36b0a…5c31`;
- `ubuntu.sources` sha == `e93b42f6…d3`, and the origin host is one of its URIs;
- `TRANSPORT` is `https` or `http`;
- the origin is derived from the suite exactly as in the guest sources: `noble-security` → `security.ubuntu.com`, `noble`/`noble-updates` → `archive.ubuntu.com`;
- `OUT_DIR` is absolute and NEW.

**Run and outputs:**
- It then runs `b3bundle.py fetch` (timeout 1800 s) and checks the bundle against its own `SHA256SUMS`.
- It prints the `receipt.json` sha256 for root to pin.
- Logs go to `offline-b3sum-bundle-stage/r3/logs/fetch-<ts>-<pid>/`: `inputs.txt`, `fetch.json`, `fetch.err` and `rc`.
- Bundle: `InRelease`, `Release.signed`, `Packages.xz`, `b3sum_<ver>_amd64.deb`, `receipt.json` (format `enclave-offline-b3sum-bundle/r3`) and `SHA256SUMS`.
- The `.deb` is **never extracted or executed on the host**. There is no apt or global change.

**Explicit HTTP variant** (only if root selects it): the same command with `http` in place of `https`. The receipt records `"transport": "http"`, and `qualify` must then be given `--transport http` with the same `http://` origin.

## Guest offline qualification (noble, root, no network; after root copies the bundle in)
```
python3 -I b3bundle.py qualify --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg \
    --keyring-sha256 80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31 \
    --allowed-primary-fpr <same FPRs as fetch> --package-version <same> --transport <same> \
    --origin <same origin as the receipt> --suite <same> --component <same> \
    --bundle <bundle dir> --receipt-sha256 <pinned receipt sha> --scratch <NEW abs dir>
```
1. **Receipt:** it must equal its pin, be a well-formed r3 receipt, and have the same trust inputs (S3).
2. **Files and chain:** every bundle file must equal the receipt. The full chain is re-verified with the **guest's own** keyring, and the evidence must equal the receipt.
3. **Extraction:** **only** `./usr/bin/b3sum` is taken from the `dpkg-deb --fsys-tarfile` stream and written 0500 with `O_EXCL`.
4. **Tool checks:** `--version` must match the pinned upstream version, and the empty-input KAT must give `af1349b9…3262`.
5. **Record:** `qualification.json` with the **proposed** `GSI_B3SUM_SHA256`.

## Scope (honest)
- **Qualified here:** provenance, identity, version and the empty-input KAT.
- **Remains Q4:** native qualification, i.e. all 4 state outputs must equal the manifest BLAKE3.
- **Not shown:** that the noble archive actually serves the chosen version over HTTPS without redirects, or which keys sign InRelease. Root's real fetch shows both.
