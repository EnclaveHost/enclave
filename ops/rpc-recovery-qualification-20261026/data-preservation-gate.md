# Data preservation before rebuilding the USB array

## Current user decision — October 27, 2026

The user explicitly chose to defer recovered-database usability validation until later. This supersedes the earlier requirement to complete structural and local-state validation before the RAID reset. Scan 1930 was cancelled cleanly; see [its receipts](structural-user-cancellation-1930/README.md). Do not restart these scans or bulk rehashes as a pre-reset gate.

This is acceptance of recovery risk, not evidence that the database is healthy. No validator acceptance predicate has been changed. The RAID owner retains responsibility for its complete inventory, reset and restoration; this RPC document does not independently authorize destructive operations.

## Preserve the recovery inputs

- Retain all 265 independently verified 4 GiB parts outside the array, in their existing locations, with their ordered mapping, identities, receipts and reconstruction metadata. Do not move or modify pinned parts.
- Retain extracted compact headers and extraction receipts, compact backups, stopped VM disks, and distinct partial archives/checkpoints. The resumable fetch checkpoint is 122742112256 committed bytes; a partial archive is not a complete download.
- Keep the RAID owner’s complete backup inventory and bounded restoration plan, including exact destinations and capacity checks. Retain recovery copies through restoration and subsequent usability checks.

The recovery-side scan cleanup is complete, with no owned processes or mounts left and peers unchanged. Do not change peer mounts or Metal0; the RAID owner controls them. USB writes, downloads and the RPC VM remain paused until explicit restored-storage authorization.

## Deferred checks and production RPC acceptance

Structural integrity and actual state usability have not been proven. Cancelled scans, copy hashes, mocked tests and source-only helpers do not establish them. Check usability after restoration as needed, and report failures honestly rather than labelling preserved bytes a usable node database.

External canonical-chain authentication, current Ethereum/Base synchronization, historical blob availability, safe/finalized readiness, proof-serving, lease relay and consumer cutover remain prerequisites for the RPC replacement. None is a prerequisite imposed by this chat on the RAID reset. A PARTIAL/self-consistency result keeps that classification; it is not canonical proof or production acceptance. Native snapshot experiments and app publication are separate work.
