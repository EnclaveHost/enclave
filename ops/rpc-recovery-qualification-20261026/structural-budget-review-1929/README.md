# Structural scan duration review and controlled restart

The source review found that the full checker walks tree pages and subsequently traverses records. Syscall byte counts include repeat reads; they do not measure unique pages or completion. The reviewer could not establish whether an eight-hour cap would suffice.

Correction to the review: a saved historical diagnostic does record readahead OFF0..276959557 and open-MADV_DONTNEED276959557..277872640 at transaction51691982. This provides a historical used-region boundary, not a count of distinct reachable pages or the running scan's stage. Thus8.5% of one used-region byte pass is an activity equivalence; a hypothetical4% two-pass figure is not measured completion. Available sources do not establish a reliable ETA.

The wrapper's deadline is fixed at process startup. Root used the already-qualified r10 stop helper (PID/start-time/pidfd checked) to stop scan1926, then verified its CANCELLED5 receipt: cleanupComplete, snapshotsOk, noMountLeft, noProcessLeft and peersUnchanged. Its evidence predicate returns nonzero because clean/rc0 are false; this is not a fabricated successful validation. The original cancelled run is preserved.

A fresh scan1928 uses the identical qualified checker and r10 runner with the supported max-hours parameter24 instead of8. Scope, memory4GiB, host reserve16GiB, disk floors, part identity checks and cleanup remain unchanged. The longer cap reduces timeout risk; it is neither an ETA nor a guarantee of completion. No running process deadline was patched, checks skipped, backup altered, USB writer resumed, or peer mount/service changed by this operation. Metal0 remains temporarily stopped under the user's prior authorization and its owner's control.
