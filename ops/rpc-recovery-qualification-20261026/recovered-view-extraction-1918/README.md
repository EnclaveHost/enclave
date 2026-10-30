# Recovery preservation and extraction evidence — 2026-10-27

All 265 parts (1,060 GiB) completed copying and independent verification; driver ended at 13:21:28 UTC. The production view importer rechecked confirmed records and identities without rehashing the entire file. Its result is a read-only logical view, not database integrity.

Extractor r3 passed all eight real fixture E2E cases, including production-like ownership/nanosecond metadata and cancellation cleanup. The production extraction then completed CLEAN for exactly seven allowlisted files, 362,900,885 bytes, from the read-only compact backup into NVMe. Inner and outer receipts are both retained. No USB writes, RPC VM boot, blockchain readiness or media reset was authorized by these results. Structural validation was started separately and has no result in this archive.

Original receipt paths and timestamps remain as recorded. Copies here preserve evidence bytes; the original E2E run is not a new run at this archive path. Full part data, backup images and extracted header data are excluded from Git.

The canonical review is source inspection, not authentication evidence. Its proposed fresh read-only A1 queries are within the existing user-authorized investigation; no additional user permission is inferred from its wording. Its rough October 29 estimate is unverified and must not be used for scheduling or readiness. The prior A1 anchor does not authenticate a later Finish block. A writable full copy is one possible unwind implementation; this review did not establish that it is the only storage implementation.
