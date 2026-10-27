# Actual sixteen-test pass including evidence-collection failures

All16 tests passed in3.963seconds with no warnings or skipped tests. Peak RSS56MiB, minimum host24003MiB, existing256MiB small lane retaining the full4096MiB concurrent-large reservation and16GiB host floor.

The new case invokes the same collection, receipt-generation and final-status scripts used by production. It tests healthy empty results, failed pgrep/grep/awk/sort, output beyond the file-size cap, an unwritable evidence target, missing/malformed/truncated status, and preservation of a nonzero runtime status. Failed evidence with a simulated successful runtime cannot yield final success.

The runtime receipt in this case is synthetic; no production database was read, no FUSE mounted and no cgroup property changed. The prior lifecycle, stop and cancellation tests remain included. Independent source review of the correction is still pending. Actual recovered-database structural and canonical validation require all265 parts and a separately qualified production run. Original USB writes, downloads and RPC VM startup remain paused.

Independent review1835 completed and found B1 resolved with no remaining concrete blocker for owned, private, fresh job directories. Root's actual sixteen-test PASS is recorded above. The correction is source-reviewed and unit-tested; this does not establish production database validity or guaranteed memory safety.

The structural checker remains manual and gated: all265 parts independently verified in confirmed sessions, qualified production view, exact prerequisite receipts and source pins, fresh capacity and a coordinated4096MiB main-lane window preserving16GiB host memory. Use this r10 entry rather than inactive older versions. No new human permission is implied solely by earlier source comments; existing user authorization applies once prerequisites pass. Canonical state validation remains a separate step.
