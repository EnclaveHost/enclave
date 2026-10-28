# Restoration and temporary backup retirement

The RAID owner's completion receipt records restoration at 2026-10-28 01:56:53 UTC (October 27, 6:56 p.m. Phoenix): 2,147 ordinary files and the recovered 1,138,166,333,440-byte MDBX file were restored with matching readback. The helper detached its owned NBD connection. This establishes copied-byte equality, not database structural integrity, canonical-chain validity or production RPC readiness.

Afterward the user requested freeing space in the RAID chat (turn `01a1803a-1815-7323-9d01-e8019d9a584d`, user item `01a1803a-18e4-70d0-8418-aa4c385215fc`). The RAID owner is retiring the verified temporary NVMe backup files and 265 recovery part files with identity checks and deletion receipts. The completion receipt's `nvme_backups_retained` field describes the instant restoration completed, before that later instruction. Do not interpret it as current retention status after cleanup.

Old multipart manifests and validation views are historical evidence and must not be reused against retired paths. Preserve the restored images, restored partial download/checkpoint and small recovery records. No bulk rehash or structural scan is a prerequisite for the RAID operation; the user explicitly deferred database usability checks.

At this checkpoint cleanup completion and release of the shared storage hold are still pending. Do not start RPC writers or Metal0 from the completion receipt alone. Metal0 requires the separately recorded recovery plan because normal controller startup can delete retained dead-guest records and padbanks.
