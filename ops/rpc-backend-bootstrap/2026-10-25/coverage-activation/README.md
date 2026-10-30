# Base coverage activation bridge (applied and installed, NOT activated)

## Current state (2026-10-25 18:25 UTC, from root's `evidence/root-install/install.out`)

**Applied.** Root applied `coverage-activation.patch` (sha256 `4a1e6e80…`) to this source tree. The runtime files are
`../chain_service.py`, `../test_chain_service.py` and `../test_coverage_activation.py`. This publication does not copy
or overwrite them.

| File | sha256 |
| --- | --- |
| `../chain_service.py` | `a60ae322d9a70f2d154cc5ae10880159ccf65e2bc82fa6c3aa802ec22d7a3ca7` |
| `../test_chain_service.py` | `42231a7a5660861bf5d2c7a0a2e63fe236ab78596914320dcbf8f8da198b90bc` |
| `../test_coverage_activation.py` | `085672f3e1b1efe44792a4a411c4d68b6bf33b24c91ce4cabf71649d4738fcda` |

**Installed on the RPC VM:**
- `/opt/enclave-rpc/chain_service.py` is `a60ae322…`. The old `a7adf5e6…` (boolean semantics) is preserved as a backup.
- The pinned snapshot metadata was copied root-owned into `/etc/enclave-rpc/coverage/`.

**Not activated:**
- `chain.json` `baseBootstrap.coverageVerified` is **false**.
- The Base path unit is **disabled**.
- `coverage-check` exits 1 with `Base snapshot blob coverage not approved`, as expected.
- The protected PIDs are unchanged: EL 847, CL 898, Base downloader 4061.

`coverage-identity` on the VM:

| Field | Value |
| --- | --- |
| bootstrapManifestSha256 | `c35ec24b…` |
| **snapshotManifestSha256** | **`1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2`** |
| chainConfigSha256 | `6d3fff80…` |
| baseBinarySha256 | `9c44836d…` |
| kzgcheckSha256 | `00b3eeb9…` |
| snapshotManifestUrl | `https://mainnet-v2-snapshots.base.org/1792886410/manifest.json` |

**No coverage verdict exists for the real snapshot.** The full-range `origin_extract.py` + `coverage_gate.py` run on the
actual Base snapshot and L1 is **pending**. All verdicts in the tests are synthetic fixtures. Nothing here proves real
coverage.

## What the bridge is, and is not

**Is.**
- **A fail-closed activation gate.** `coverageVerified: true`, the operator's decision, is necessary but not sufficient.
- **Pinned evidence.** `chain.json` must also pin the sha256 of four root-owned evidence files: receipt, verdict, origin
  and the exact downloaded snapshot manifest.
- **Same validation as readiness.** Receipt, verdict and origin are validated with the readiness rules.
- **Two manifests, bound separately.** The bootstrap/install manifest and the snapshot manifest each have their own
  hash; the installer document is rejected as snapshot identity.
- **Manifest location policy.** The snapshot manifest is checked against pinned reth `7134be3` URL-resolution semantics
  and a local location policy.
- **Snapshot bound to the extraction.** The origin tip must equal the snapshot block.
- **Live L1 checks before start.** Strict `l1_ready`, finality, a canonical safe origin, and receipts/blobs served at
  the bound values.

**Is not.**
- It is **not authenticated snapshot state**: the manifest's BLAKE3 values are publisher claims, verified by the
  downloader.
- It is **not full readiness**.
- It is **not a real-coverage proof** until the pending gate run.
- Reviewer names are unsigned; root-only write access is the authority.

## Files

| Path | What |
| --- | --- |
| `coverage-activation.patch` | the exact applied patch (3 files) |
| `recipes/jobs.sh` | the executed staging job (`claude-test-queue.py --mib 256 -- unshare -rn bash jobs.sh`). It ran in the stage layout, with the test files and `mutants/` beside it, and sets `REAL_SNAPSHOT_MANIFEST` to the observed 4,089,437-byte manifest (`outputs/…/base-download-tuning/snapshot-manifest-observed.json`, not published here) |
| `recipes/make_mutants.py` | regenerates the 12 executed mutants from `../chain_service.py`. Verified byte-identical to the executed ones. m8 removes both bootstrap-substitution layers, because removing one alone is equivalent |
| `logs/final/` | the passing runs (below) |
| `logs/superseded/` | earlier failing runs, kept |
| `evidence/root-install/` | root's install script and receipt |
| `SHA256SUMS` | every file here |

## Test evidence (all through `claude-test-queue.py --mib 256`, 16 GiB floor)

**Final, passing:**

| Run | Result |
| --- | --- |
| `logs/final/test-20261025T182244Z.out` (stage) | rc 0: `test_coverage_activation.py` 36/36 (3 `RealManifest` ran, 0 skipped), `test_chain_service.py` 20/20, mutants 12/12 KILLED |
| `logs/final/patchcheck-r3-20261025T182302Z.out` (patch applied to a fresh copy of the HEAD originals) | rc 0: 36/36 (real manifest, 0 skipped) + 20/20 |
| `logs/final/coverage-root-applied.out` (**root's independent run on the actual applied source**) | 36/36 + 20/20, `REAL_SNAPSHOT_MANIFEST` enabled, 0 skips, peak 61 MiB, min host available 21,425 MiB |

**Superseded, failing, kept:**

| Run | Failure |
| --- | --- |
| `test-20261025T180854Z` (rc 1) | A test expected a file-owner refusal, but the directory-owner check fires first. Also a `KeyError` on a missing base pin, now a clean refusal |
| `test-20261025T180956Z` (rc 1) | The subprocess CLI shim was malformed; replaced by an in-process `main(argv)` test |
| `test-20261025T181723Z` (rc 1) | Mutant m8 survived (equivalent mutant: one layer only); m8 now removes both layers |

Revision history:
- Revision 2 bound the installer manifest under the snapshot-manifest name. Root review rejected it.
- Revision 3 initially rejected the real manifest's host-root `base_url`. Root review rejected that too. Both are fixed
  in the applied patch.

## Rollback (keep coverage false)

The current state is already safe: `coverageVerified` is false, so Base cannot start, whichever launcher is installed.

**Never activate as part of a rollback.**
- Leave `coverageVerified: false` and the Base path unit disabled.
- To fully revert: stop Base if it is ever running, then reinstall the preserved `a7adf5e6…` `chain_service.py`
  **with `coverageVerified` still false**.
- The old launcher activates on the boolean alone. Setting `coverageVerified: true` under the old launcher would bypass
  every binding above, so it must never be done without a fresh root review.
- The evidence files in `/etc/enclave-rpc/coverage/` are inert without the config pins. They may stay.
- Source rollback: `git apply -R coverage-activation.patch`. EL and CL behaviour is identical under both launchers.

## Remaining activation steps (root, not done)

1. Base snapshot download and output re-verification complete against the pinned local manifest `1f0c4e6c…`.
2. Run `origin_extract.py` on the read-only datadir before Base ever runs. Its tip must equal 53048526.
3. Run `coverage_gate.py` over the full range. It must return `COVERED` (exit 0).
4. The reviewer writes the receipt.
5. Install the evidence.
6. Edit `chain.json` (four pins plus `coverageVerified: true`).
7. `coverage-check` must pass.
8. Run the existing reviewed enable procedure. Base start repeats every check plus the live L1 checks.
