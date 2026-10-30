# Read-only review: `offline-b3sum-bundle-stage/r1` (2026-10-26 17:35-17:37Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` `405fe0a8…839b`; `sha256sum -c` OK.
  - `b3bundle.py` `8da60963…9c5`
  - `test/test_b3bundle.py` `8aae1021…cd`
  - `jobs/root-b3bundle-tests.sh` `d830d585…ba`
  - `README.md` `88ee61a4…ba5`
- **Also read:** `logs/claude-offline-b3sum-bundle-r1.md`.
- **Root 1492's guest record:** the files re-hash equal to `record.json`:
  - keyring `80a36b0a…5c31`;
  - `ubuntu.sources` `e93b42f6…`: **`URIs: http://archive.ubuntu.com/ubuntu`** (noble, -updates, -backports) and **`http://security.ubuntu.com/ubuntu`** (noble-security), `Signed-By` that keyring;
  - os-release noble 24.04.
- **Not done:** no tests, builds, network, installs, gpg/dpkg runs or edits.

## Verified correct (source)
**Signature:**
- `gpgv --status-fd 1 --keyring <pinned file>`: with `--keyring` given, gpgv's default `trustedkeys` is not used.
- Every `GOODSIG` must pair with a `VALIDSIG`. The primary fingerprint (field 10, so subkey signatures are handled) must be in the root-pinned set.
- Any of `BADSIG`/`ERRSIG`/`NO_PUBKEY`/`EXP*`/`REV*`/`NODATA`/`FAILURE` refuses (`:56-74`).
- **Only gpgv's `--output` text is parsed**, never the outer clearsigned file (`:168-178`).

**Release:**
- `Suite` = the request and `Codename` = noble;
- SHA256 lines are strict (64-hex, size, path), and a duplicate wanted entry refuses;
- an `.xz` entry is required (`:77-101`).

**Packages:**
- size and sha256 are checked **before** decompression (`:179-180`);
- xz uses `memlimit` 256 MiB and output ≤ 512 MiB; it must reach EOF with no trailing data (`:109-117`);
- the plain `Packages` hash is checked when listed.

**Stanza:**
- exactly one name/version/arch match;
- a strict pool-path regex, no `..`/`//`;
- Size ≤ 32 MiB; `.deb` size and sha256 = the stanza (`:120-140`, `:185-186`).

**Payload:**
- `dpkg-deb --fsys-tarfile` runs only after the chain verifies;
- every member is screened for absolute and `..` paths;
- exactly one **regular** `./usr/bin/b3sum` within the cap, read from memory;
- only that file is written (`O_EXCL|O_NOFOLLOW`, 0500) in a new 0700 scratch dir (`:143-155`, `:284-291`).

**Receipt replay:**
- the receipt sha256 is a root pin;
- origin, suite, component and keyring sha must equal the qualify arguments, and the guest's own keyring must equal the receipt's;
- every bundle file must equal the receipt;
- the guest re-runs the full chain and compares the stanza, `.deb`, signed-Release and Packages hashes (`:263-283`).

**Outputs:** new private dirs, `x`-mode writes, and no host extraction or execution.

## Blockers (fix before root's live run)
**B1. The origin allowlist is HTTPS-only, but the guest's pinned sources are HTTP.**
- **The gap:** `ALLOWED_ORIGINS` contains only `https://archive|security.ubuntu.com/ubuntu` (`:25`), with curl `--proto =https` (`:210`). The guest's recorded `ubuntu.sources` uses the `http://` URIs, and whether those paths are served over HTTPS without redirects is unverified (the author's own open point).
- **Trust does not depend on the transport:** it comes from the pinned keyring, the pinned primary fingerprint, the signed Release and the hash chain, exactly as for apt. So HTTP adds no trust loss for this exact-version chain.
- **Minimal fix:** also allow exactly the two `http://` URIs from the pinned guest `ubuntu.sources` (`e93b42f6…`). Use `--proto =http,https` only for those; keep `--max-redirs 0` and the caps.
- Otherwise the first live fetch may simply refuse with rc 6 and need another stage revision.

**B2. Memory and admission for `fetch`.**
- **Peak memory:** the Packages index is held whole: up to 512 MiB of bytes, then a `str` plus `re.split` copies (`:181`, `:184`, `:122`). The universe index is large, so the peak is plausibly well above 256 MiB (not measured).
- **The gap:** the README runs `fetch` directly on the host, outside the queue.
- **Fix (procedure):** run `fetch` through `jobs/q-exit-status.sh` in a lane sized for it (e.g. 1536), so the 16 GiB floor guard applies, and record `peakTreeRssMiB`.
- **Optional code reduction:** keep `pk` as bytes and scan for `b'\nPackage: b3sum\n'` blocks only.

## Should fix (small; not blocking)
- **S1. Version pin:** `VERSION = '1.2.0-1'` is a code constant (`:24`), not verified against noble's metadata. If the archive carries another version, every run refuses and the code must change. Make it a required root pin (`--package-version`, strict regex), recorded in the receipt and compared in `qualify`; derive the `--version` prefix check from it.
- **S2. Fail-closed but unclassified:** `tarfile.TarError` (`:146`) and a `TypeError` from a malformed receipt escape `main`'s handler (`:327`), giving a traceback and exit 1. Map `tarfile.TarError` to `Refuse(9)`, and add a final `except Exception` returning rc 2.
- **S3. Receipt comparison:** `qualify` does not compare `primaryFingerprints` or the allowed set with the receipt (`:281-283`). Add that equality, so a guest run with different trust inputs cannot be presented as the same qualification.
- **S4. Hash algorithm:** `VALIDSIG` hash-algo (field 8) is not checked. Require SHA-256/384/512 (8, 9, 10), so a SHA-1 data signature never passes, whatever gpgv's defaults are.
- **S5. Download size:** `--max-filesize` has no effect without `Content-Length` on older curl. The post-hoc size check refuses, but only after writing, bounded by `--max-time`. Acceptable; note it.

## Live qualification evidence (root's run; not blockers in source)
- **E1. Fingerprints:** root derives the primary fingerprints from the pinned keyring `80a36b0a…` (e.g. `gpg --show-keys --with-colons <file>`, no import) and records them as `--allowed-primary-fpr`.
- **E2. Real gpgv status:** with the real noble InRelease and that keyring, gpgv gives GOODSIG/VALIDSIG by a pinned primary key, with **no** `NO_PUBKEY`/`ERRSIG`/`KEYEXPIRED` from any other signature, which would refuse by design.
- **E3. Transport:** reachability over HTTPS without redirects, or the B1 HTTP fallback.
- **E4. Index and stanza:**
  - `Packages.xz` is a single xz stream within the caps;
  - exactly one stanza for the pinned version in the chosen suite and component;
  - the memory peak is recorded under the queue guard.
- **E5. In the guest:**
  - `dpkg-deb` is present;
  - exactly one member is extracted;
  - `--version` and the empty-input KAT pass;
  - `qualification.json` gives the **proposed** `GSI_B3SUM_SHA256`.
  - This qualifies provenance, identity and the KAT only; native BLAKE3 qualification remains Q4 (all 4 state outputs equal the manifest).
