# Native lease coverage v3: built and unit-tested, not live-qualified

The authoritative r2 source digest is c990e67156f32992ab0c10d7e9c7d4ad98ea94485125eb2a57df538701f6deb0. Root corrected one compiler type error by comparing NonZeroU64.get() to1; the original source and failed build are retained. The corrected job reuses the same locked private dependency cache, with no upstream lockfile change.

Actual root-native-lease-v3-r2-1234 completed successfully: fourteen Rust tests passed, zero failed/ignored/filtered. Cargo.lock remained f122da76. The built binary SHA256 is49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa. Peak process-tree memory659MiB; physical host available stayed above18194MiB. The agent report was prepared before compilation and is superseded by these receipts.

Coverage includes every executed block and all logs with the three lease-event topic0 values from any emitting address, including structurally valid one-topic logs. Receipts, transaction bytes, header roots and intermediate output roots are bound before output. No RPC-provided log list is trusted and no matching logs are silently dropped. Range is at most1800 with interval1; output is capped16MiB.

Remaining: actual positive Base witness,1/30/1800 resource measurements, measured-image/SNP qualification, v3 reader journal/capability integration and release-writer adapter. Pre-bootstrap claims still require proven historical coverage; no automatic reclaim transaction occurs. Custody's existing120-second freshness guard is unchanged; a deny-only unsafe observation does not prove fresh absence of revocation. Administrator controls remain intact.
