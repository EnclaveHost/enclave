# Actual eleven-test pass; synthetic measurement remains pending

The r4 fix corrects the sampler's RSS/PTE field names and ensures the test cleans up its owned child and log even on error. Eleven actual unit/negative tests passed in 1.096 seconds, with empty stdout and no warnings, skips or bad markers. The previous failed r3 evidence remains archived.

Root used the existing 256 MiB small queue lane for these unit tests after reviewing all cases: they use only their own temporary files and processes, and read their own cgroup; there is no FUSE mount or scope mutation. The prior run peaked at 65 MiB and this run at 62 MiB. The shared queue retained its full concurrent-large reservation and 16 GiB host floor. No queue code or production memory gate changed.

The separate real synthetic FUSE/mmap workload is queued in the exclusive 768 MiB main lane and has not produced a measurement yet. Only that later result can inform the production checker memory plan. These unit tests do not validate recovered database integrity, canonical state or RPC readiness.
