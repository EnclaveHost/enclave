# External source appendix (preservation checkpoint 2026-10-22)

**Status: archive only.** This directory holds authored source, patches, scripts, tests, docs, recipes
and small fixtures that existed only in isolated workspace directories, *outside* the primary git
repositories. Those repositories (EnclaveHost/enclave, EnclaveHost/enclave-apps and related repos) were
checkpointed separately. Nothing here is integrated, built, released, deployed or production-reviewed.
Many entries are superseded candidates or earlier variants, kept on purpose. No tests or builds were run
for this snapshot.

## Contents (5614 stored files)

| Path | Count | Contents |
|---|---|---|
| `files/<workspace-path>` | 4934 | Full copies of standalone authored files. |
| `diffs/<workspace-path>.diff` | 337 | Unified diffs that turn a **public baseline blob** into the workspace file. These are variants of repo files found in candidate trees. |
| `scratch-repos/<repo>/<commit>/<path>.diff` | 127 | Content that existed only in local scratch/build git repos. Only the snapshot commits were exported, never their history. Each is a diff against EnclaveHost/enclave `d09f377d0`, or against an empty file for new paths. |
| `archive-extracts/<archive>/<member>` | 11 | Source members that existed only inside local zip/tar archives. These include earlier variants of the bootstrap harness. |
| `files/**/SHA256SUMS`, `*.sha256`, `SOURCE.digest`, `PINS.sha256` | 199 | Small hash manifests that sit next to stored packages. |
| `files/**/*.source-only.patch` | 6 | Patches over 2 MiB, stored with their generated-bundle file sections removed. MANIFEST lists each removed section. |
| `MANIFEST.json` | | One entry per stored file: original path, aliases (other paths with identical content), original `sha256`, `stored_sha256`, kind, baseline and transforms. |
| `tools/verify_appendix.py` | | Verifies hashes and reconstructs files. |

Original paths are relative to the author's workspace root and have no meaning outside it. They are
provenance labels only. All `stored` paths are relative to this directory.

## Notable packages

* **Windows bootstrap process-control harness:** `work/bootstrap-process-control-20261022/**`. Includes the
  driver, the native component, compile/parse checks, C# fixtures and the non-process tests. Earlier
  reviewed variants are under `archive-extracts/outputs/bootstrap-process-control/`.
* **Storage replica controller r5 (latest, rev2):** `work/claude-resumed-20261022/control-package/storage-migration-r5/`.
  The r3, r4 and fixture variants sit next to it.
* **Storage/indexd SDK changes:** diffs of the vendored `sia-sdk-rs` against
  `enclave-apps@sia-recovery:sia-s3/vendor/sia-sdk-rs`, found in the `indexd-c2-implementation/sdk-snapshot-*`,
  `storage-real-indexd/sdk-*` and `storage-clone-*` packages. Also `storage-sdk-regressions/`.
* **indexd enclave trees:** `work/claude-resumed-20261022/storage-enclave-build/trees/{fence-enclave,c2-enclave}`,
  stored as diffs against `indexd@ddaf24b9` plus new files.
* **Restore tests:** `storage-fresh-restore-run/`, `storage-fresh-backup/` and `work/restore-indexd-full.py`.
* **Reproducibility tooling:** the `*repro*` scripts, build and verify scripts, and the hash manifests.

## Baselines (all public)

| Label | Repository | Commit |
|---|---|---|
| `enclave@nan-retirement` | https://github.com/EnclaveHost/enclave `decentralize/nan-retirement` | `d09f377d0` |
| `enclave@main` | https://github.com/EnclaveHost/enclave `main` | `7752a4239b3bec2cf452491cd1b95164a8c2bdb8` |
| `enclave-apps@wallet-uploads` | https://github.com/EnclaveHost/enclave-apps `decentralize/wallet-uploads` | `50f93d74c5a41acb8df73c8ae094d8c9fb05e666` |
| `enclave-apps@sia-recovery` | https://github.com/EnclaveHost/enclave-apps `decentralize/sia-recovery` | `54818ba68ea0feddec1cae5650230ddf2fec3d30` |
| `indexd@ddaf24b9` | https://github.com/SiaFoundation/indexd | `ddaf24b999800651af5aee7575a68ae543506fd9` |

## Verify and reconstruct

Create three clones that contain the baseline commits above. Plain or bare clones both work.

```sh
git clone https://github.com/EnclaveHost/enclave enclave            # fetches main + decentralize/nan-retirement
git clone https://github.com/EnclaveHost/enclave-apps enclave-apps  # must contain both decentralize/* commits
git clone https://github.com/SiaFoundation/indexd indexd
python3 tools/verify_appendix.py --appendix . --enclave enclave --enclave-apps enclave-apps --indexd indexd \
    [--reconstruct /tmp/reconstructed]
```

Requirements: Python 3, git and `patch`. Diff entries are rebuilt as `git cat-file blob <baseline_blob>`
followed by `patch`. Scratch-repo entries use `d09f377d0:<path>`, or an empty file for new paths.
The reconstructed content must hash to `stored_content_sha256` when that field is present, and to `sha256`
otherwise. Running against the author's local clones on 2026-10-22 reported 5614 entries, 464 diffs
reconstructed and 0 failures.

## Transforms applied to stored bytes (recorded per entry)

* **History-rewrite transform (65 entries).** Published EnclaveHost/enclave history went through a literal
  rename: the former provider name, in any case, became `Cloud Provider`. The same rename was applied to stored
  content and to recorded paths here. `sha256` is still the hash of the untransformed original, and
  `stored_content_sha256` is the hash of what reconstruction produces.
* **Redactions (5 files, `<REDACTED:...>` placeholders).** The originals remain only in the private workspace.
  * An indexd admin password, in `work/restore-indexd-full.py` and `work/storage-vm/restore-target.py`.
  * A diagnostic secret, in `work/enclavedns-upload-502-20261021/root-diagnostic/test.mjs`.
  * A non-public test wallet key, in `work/browser-default-independence/{patches/05-tests.patch,tree/test/helpers/default-independence-rig.mjs}`.
    It is a mistyped Anvil key, not a known public dev key. Tests that depend on this key need a substitute
    key before they can run.

## Not preserved here (by design)

| Category | Approx. paths |
|---|---|
| Build outputs, dependencies, site/CAR extracts (targets, `dist`, chunks, cargo/Go caches, `vendor` other than `sia-sdk-rs`, PowerShell runtime) | 40,900+ |
| Generated JS bundles and minified files | 595 |
| Generated build/release manifests (`*.bundle.mjs.manifest.json`, `build-manifest.json`, release `manifest.json`, `*.package.json` bundle-input digest lists) | 401 |
| Built site extracts and hashed chunks | 135 |
| Result/evidence JSON outside test/fixture/testdata/vectors paths | 4,259 |
| Free-form txt notes, prompts and task files | 1,843 |
| Secret-named paths (key/account files in logs, `private/`) | 45 |
| PEM private-key fixture. The TLS test fixtures can be regenerated with `files/work/host-service-tls-20261021/native/gen-fixtures.sh` | 1 |
| History-rewrite and attribution tooling, kept private because it would republish removed names and identities | 93 |
| Generated activation plan JSONs over 512 KiB | 6 |

Logs, jsonl transcripts, `.env` files, wallets, DB dumps, backups, binaries, wasm, tar and zip files were
never selected. Generated artifacts must be rebuilt from source. Their reproducibility was **not** re-verified
for this snapshot.

## Completeness limits

* The inventory covered source/doc/config extensions, shebang scripts and a few extras (`.cs`, `.manifest`,
  `.in`, `.template`). Data-only formats were not reviewed. Symlinks were not followed.
* 442 workspace files existed only as uncommitted content in the primary repos' working trees. They are
  preserved by the primary-repository checkpoint, not here.
* Variants that are identical to any blob in the public baselines are not duplicated here.
