# Recovery evidence, 2026-10-26 21:30 UTC

Original Base database NOT recovered or accepted. Original USB image remains read-only; writes, download and VM boot remain paused. No production RPC cutover.

Overlay r7 passed all 20 actual tests, including deleted-file reconstruction, write refusal, corruption rejection, bounded overlay size and interruption cleanup. Its actual offline plan passed: 30 metadata patches, 119040 bytes, 9001 extents. No original exposure or full database scan yet.

Real postdelete r2 returned BLOCKED (rc5): old live inode to new live generation occurred across adjacent committed transactions with no intermediate deleted row. Independent Linux source review confirms that unlink/free/reuse can coalesce in one transaction; absence of an intermediate row is not corruption evidence. r3 is prepared but UNTESTED, with follow-up review corrections pending. No absence-of-reuse claim.

The first qemu-img allocation map exceeded the explicit 32MiB output cap and was stopped cleanly. A bounded libnbd metadata-only alternative is prepared but UNTESTED; r1 requires long socket path and lifecycle corrections before actual use.

Full MDBX, plain/hashed state equality, trie/root validation and independent canonical-chain anchoring remain necessary. These metadata and fixture results do not establish data integrity or production readiness. Journal/database bytes and binaries excluded; small historical inode/leaf metadata fixtures included.
