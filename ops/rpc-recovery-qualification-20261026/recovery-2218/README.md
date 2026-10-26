# Recovery preparation and limits, 2026-10-26 22:18 UTC

Actual r7 qualification: all 10 disk-guard and 6 identity-parser tests passed. The real build launcher accepted the correct device identity, then refused before compilation because free space was 58.7 GiB, below the unchanged 64 GiB admission threshold. No Rust helper compilation or real state-validation success is claimed. No production or original-image changes occurred.

## Root review of the attached speed analysis

The analysis identifies a useful candidate route: sequentially copy the recovered database to adequately sized NVMe storage, then validate it there. It is not yet a measured recovery plan. The following qualifications override stronger statements in the attached Claude report:

- Its roughly 48-day number is a naive extrapolation from a short initial traversal interval, **not a reliable completion estimate**. We do not yet know how faults, locality, cache use and work per page vary across later phases. Do not assert that no full validation could finish within days.
- HDD random access is a plausible contributor. The current measurements do not isolate HDD/USB/RAID latency from FUSE/QEMU overhead, so neither the proposed latency breakdown nor the speedup from removing layers is established.
- The report's generic history BLOCKED statement is stale. The actual latest r5 journal-history result is REUSE_OBSERVED for exactly two extent-tree metadata blocks; both have authenticated original journal patches, and neither overlaps the 9001 data extents. No cross-commit data reuse was observed. Intra-transaction reuse and unrecorded writes remain outside that evidence; data integrity is still unproven.
- Source-level methods and the official checker are preferable to an improvised replacement validator. Readahead/cache tuning alone is not evidence of recovered integrity.
- The SDK's coldness and deletion eligibility are unknown. The pending question concerns an archive plan, not deletion authority. Existing verified cold copies still require their writer/alias checks. No storage reclamation or USB writes have been authorized by this report.

The candidate needs approximately 1.16 TB of free destination capacity with the currently planned margin. Only about 59 GiB is presently free on /vm. A bounded sequential read measurement could help compare recovery and resumable download costs, but no such benchmark was run here. The saved partial download and 115 archive files remain preserved.
