# offline-b3sum-bundle-stage/r1: fetch b3sum 1.2.0-1 on the HOST, qualify it OFFLINE in the guest (Q1 without guest network)

**PREPARED, NOT RUN.**
- Claude ran no network, test, build, extraction, VM or queue action.
- No key, fingerprint, hash or URL is guessed. Origins, suites and components are fixed Ubuntu allowlists; everything else is a root pin.
- The existing Q1 scripts (`guest-state-qualification-stage`) are not modified. This is a separate path that avoids guest network access and a reboot, and can run while the VM is off.

| file | role |
|---|---|
| `b3bundle.py` | `fetch` (host) and `qualify` (guest) in ONE stdlib file. Python ≥ 3.9 (uses dict `|`; guest 3.12 ok). It is one file because `python3 -I` does not add the script dir to `sys.path`. |
| `test/test_b3bundle.py` | 14 tests of the verification logic: tiny synthetic fixtures and mocked gpgv status only. NOT a qualification. |
| `jobs/root-b3bundle-tests.sh` | Root job: exactly 14 tests, bare `OK`, offline (`unshare -Urn`). |

## Root inputs (pins; nothing defaulted for trust)
1. **The guest's own keyring:** `--keyring <abs path>` + `--keyring-sha256 <pin>`. Root's pinned OS inspector extracts it **read-only** from the noble guest image (e.g. `/usr/share/keyrings/ubuntu-archive-keyring.gpg`) together with the apt sources. The host has no Ubuntu keyring.
2. **Signing keys:** `--allowed-primary-fpr <40-hex>` (repeatable), the primary fingerprints root accepts, taken from that keyring's inspection.
3. **Origin, suite, component:** `--origin` from {`https://archive.ubuntu.com/ubuntu`, `https://security.ubuntu.com/ubuntu`}, `--suite` from {`noble`, `noble-updates`, `noble-security`}, and `--component` from {`main`, `universe`}. They must match the guest's apt sources and the pocket that actually carries `b3sum 1.2.0-1`; root decides from the inspected sources.

## Host fetch (Arch; network = HTTPS to the allowed Ubuntu origin only; writes only a NEW private dir)
```
python3 -I offline-b3sum-bundle-stage/r1/b3bundle.py fetch --keyring <abs> --keyring-sha256 <pin> --allowed-primary-fpr <fpr> \
    --origin https://archive.ubuntu.com/ubuntu --suite <suite> --component <component> --out <NEW abs dir>
```
1. **Download:** curl, https only, TLS ≥ 1.2, no redirects, size caps (InRelease 4 MiB, `Packages.xz` 64 MiB, `.deb` 32 MiB).
2. **Signature:** `gpgv --status-fd 1 --keyring <pinned> --output Release.signed InRelease`. It requires matching `GOODSIG`/`VALIDSIG` pairs with primary fingerprints in the pinned set. Any `BADSIG`/`ERRSIG`/`NO_PUBKEY`/`EXP*`/`REVKEYSIG` refuses (an unknown key fails closed). **Only the gpgv output** (the signed text) is parsed; the unsigned outer text is never used.
3. **Release:** `Suite` must equal `--suite` and `Codename` must be `noble`; exactly one SHA256 entry for `<component>/binary-amd64/Packages.xz`.
4. **Packages index:** `Packages.xz` size and sha256 are checked **before** decompression. Decompression is bounded (512 MiB, xz memlimit 256 MiB; refuses truncation or trailing data). The decompressed sha256 must equal Release's `…/Packages` entry if one is listed.
5. **Stanza:** **exactly one** stanza `Package: b3sum`, `Version: 1.2.0-1`, `Architecture: amd64`. Anything else refuses (version unavailable or ambiguous). `Filename` must match `pool/<component>/<x>/<source>/b3sum_1.2.0-1_amd64.deb` (no `..`, no `//`, no absolute path or URL); Size and SHA256 must be well formed.
6. **Package file:** the `.deb` is downloaded from `<origin>/<Filename>`, and its size and sha256 must equal the stanza. Then the whole chain is re-verified.
7. **Output:** `InRelease`, `Release.signed`, `Packages.xz`, `b3sum_1.2.0-1_amd64.deb`, `receipt.json` (URLs, gpgv status lines, fingerprints, every size and sha256, the stanza, curl version) and `SHA256SUMS`.
8. **No host side effects:** the `.deb` is **never extracted or executed on the host**, nothing is installed, and no apt or global state is touched.

Root then pins `receipt.json`'s sha256 and copies the bundle into the guest (its own transfer procedure).

## Guest offline qualification (noble, root, no network)
```
python3 -I b3bundle.py qualify --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg --keyring-sha256 <same pin> \
    --allowed-primary-fpr <fpr> --origin <same> --suite <same> --component <same> \
    --bundle <bundle dir> --receipt-sha256 <pin> --scratch <NEW abs dir>
```
1. **Pins:** the receipt must equal its pin. The guest keyring sha256 must equal the pin, which must equal the receipt's `keyringSha256`; the guest verifies with **its own** keyring. All bundle files must equal the receipt.
2. **Re-verification:** the whole chain is re-verified (gpgv with fingerprints, Release, `Packages.xz`, Packages, stanza, `.deb`), and the signed Release, Packages, stanza and `.deb` hashes must equal the host receipt.
3. **Extraction of one file only:** `dpkg-deb --fsys-tarfile` output is read as a stream. **Only** `./usr/bin/b3sum` is written: one regular member, no links, no absolute or `..` members anywhere, with a size cap. It is written to `<scratch>/b3sum` with mode 0500 and `O_EXCL`. Nothing else is extracted.
4. **Tool checks:** `--version` must start with `b3sum 1.2.0`, and the empty-input KAT must give `af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262`.
5. **Record:** `<scratch>/qualification.json` with the **proposed** `GSI_B3SUM_SHA256`. Root reviews it and writes `gsi.env`.

## Scope (honest)
- **This qualifies:** the package's provenance chain, the tool's identity, version and the empty-input KAT.
- **No official test vectors:** no source tarball is fetched.
- **The native qualification remains Q4:** install's BLAKE3 of all 4 state outputs, including the 1.14 TB `mdbx.dat`, must equal the manifest pins.
