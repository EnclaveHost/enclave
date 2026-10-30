# Reviewed retention backfill, not activated

The first snapshot is still extracting. Do not start this service until that first job has finished successfully and the actual guard admits it.

The authoritative candidate is activation-r2, SHA256SUMS409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92. It selects26 archives under the pinned policy:8 already supplied by the first batch and18 additional archives. The missing count decreases on resume; completion requires all26. The earlier synthetic13-test passing candidate incorrectly compared18 against total selected and is retained only as superseded failure evidence. The corrected15-test suite includes the actual pinned manifest and partial/resume/completion lifecycle.

Actual read-only live precheck passed: it refused while first extraction PID4061 owns the datadir, found exactly18 additional missing archives, admitted capacity, and preserved production PIDs. The private uploaded guard files were removed. No service/unit/config was installed or started.

Use only the reviewed activation script once the first job is terminal. Direct systemctl start can stop a holder through Conflicts before the precondition runs; the supported script checks first. The holder is currently disabled/inactive. The backfill marker records file presence and sizes, not cryptographic coverage, synchronization or production readiness. No force/prune deletion or automatic retry is used. Administrator controls and existing applications remain unchanged.
