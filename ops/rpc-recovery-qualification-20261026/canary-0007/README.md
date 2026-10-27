# Actual 4 GiB recovery canary passed

Part 0 was copied from the privately reconstructed, read-only original to the root NVMe and independently byte-compared against the source in a NEW confirmed session. Both queue jobs completed 0, both sessions are CONFIRMED, parent metadata stayed unchanged, all temporary mounts/processes were cleaned up and peer snapshots were unchanged. Source and destination SHA256 both equal 49d162cd2dfd14add92b1584e47fcdf444d6e275acaa24b9db93aeb97b6ef6b1. The records and source-view checks are attached; no database bytes are included.

The copy data-service interval was 83.544 seconds (about 49.0 MiB/s); verification was 77.546 seconds (about 52.8 MiB/s). Cache state and concurrent load were uncontrolled: this is not a full-dataset ETA. Copy/verification peak process-tree memory was 225/223 MiB; minimum host available memory was 23,900/23,877 MiB, above the 16 GiB floor.

Only one of 265 parts is preserved and independently verified at this point. Remaining-part copy must receive coordinated go-ahead and repeat capacity admission. The included bulk wrapper is prepared, not evidence of execution. All preserved bytes still need database/content validation; original USB writes, downloads, VM boot and RAID reset remain paused. No RPC production cutover has occurred.
