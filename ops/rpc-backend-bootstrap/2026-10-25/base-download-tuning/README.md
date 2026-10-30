# Base download tuning and exact manifest pin — 2026-10-25 18:19 UTC

Only `enclave-rpc-base-snapshot.service` was stopped and resumed. Its concurrency changed from 8 to 16 HTTP downloads; its 4 GiB memory limit, zero swap, retention selection, filesystem access, snapshot block and resumable behavior stayed unchanged. Ethereum EL/CL PIDs 847/898 and the RPC VM stayed running. The authorized KVM chat was notified before tuning. No existing app or contract changed. Performance improvement is not yet established: reuse verification precedes transfer, and requires its own observation window.

The next controlled resume pins the actual downloaded snapshot manifest via `--manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json`, root:root 0644, SHA256 `1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2`, 4,089,437 bytes. The downloader logged loading this path, block 53048526, chain 8453, storage version 2 and nine components at 18:19:06. It re-verifies existing outputs against these exact bytes before reuse. This pins download metadata; it does not authenticate a snapshot's state or prove synchronization.

The public input was fetched from `https://mainnet-v2-snapshots.base.org/1792886410/manifest.json` through the RPC guest. A host urllib request returned HTTP403; a bounded guest request with a 2 MiB limit refused its larger body. A subsequent 8 MiB bound retrieved the complete 4,089,437-byte document. No incomplete body was used. Earlier URL-based invocations did not preserve the raw response, so no claim is made about their manifest byte identity. The complete observed JSON is retained in the workspace output and in the root-owned guest path above; it is not duplicated in Git.

## Installed configuration

Base unit remains SHA256 `f7a193f1f50ab147aa15d33cb7de9fbddc1ad0c01c244ffef852b417551950f4`. Its override is `/etc/systemd/system/enclave-rpc-base-snapshot.service.d/30-download-concurrency.conf`, now SHA256 `db6895e969dbf320fa20dfdf14a28930e5d4bb027092debd71ad67947aae29ba`. It resets only `ExecStart` and restates the existing command with concurrency16 and the local manifest. Original unit/override and receipts are retained under `/root/enclave-rpc-base-download-tuning-20261025`.

The included one-shot scripts enforce expected hashes/settings and refuse existing installation paths. They are executed change records, not instructions to rerun blindly. `install.out` and `manifest-pin-install.out` show acceptance of those guards. The pinned client itself accepted the local manifest and selected the unchanged components. No new application tests were necessary for this reversible unit configuration; no speed or readiness pass is claimed.

## Rollback

Stop only the snapshot service and wait for MainPID0. Check the installed override hash before editing. To retain the exact manifest but reduce concurrency, replace only `--download-concurrency 16` with `8`, daemon-reload and resume. To restore the previous URL-based configuration, restore the backed-up override (16 requests) or remove this exact override (original unit:8 requests), daemon-reload and resume. These latter options lose exact manifest input provenance. Preserve all partial files and verified outputs; never use `--force` or `--prune-unlisted` for a retry.

Base client activation remains disabled. No `coverageVerified` value was changed; a real coverage verdict and root review remain prerequisites.
