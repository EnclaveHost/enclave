# Actual sixteen-test pass including evidence-collection failures

All16 tests passed in3.963seconds with no warnings or skipped tests. Peak RSS56MiB, minimum host24003MiB, existing256MiB small lane retaining the full4096MiB concurrent-large reservation and16GiB host floor.

The new case invokes the same collection, receipt-generation and final-status scripts used by production. It tests healthy empty results, failed pgrep/grep/awk/sort, output beyond the file-size cap, an unwritable evidence target, missing/malformed/truncated status, and preservation of a nonzero runtime status. Failed evidence with a simulated successful runtime cannot yield final success.

The runtime receipt in this case is synthetic; no production database was read, no FUSE mounted and no cgroup property changed. The prior lifecycle, stop and cancellation tests remain included. Independent source review of the correction is still pending. Actual recovered-database structural and canonical validation require all265 parts and a separately qualified production run. Original USB writes, downloads and RPC VM startup remain paused.
