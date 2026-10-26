# Prepared transport; not approved for production

The private IPC and method-allowlist design keeps debug methods off the existing forwarded HTTP ports. Ten actual offline tests pass on frozen stage646e6db, including real loopback HTTP against a fake Unix-socket node and wrapper argv comparisons. They do not prove operation against a real node, sandbox, or real witness.

Root review found resource defects the initial suite does not cover: four192MiB responses and multiple decoded copies may exceed MemoryMax512M; a per-read timeout is not an absolute request deadline; and threads can wait on headers/bodies before the request semaphore. Malformed Content-Length also needs explicit handling. A separate corrected revision and production composition are in progress. Do not install or restart nodes using this prepared version.

The source-pinned node restricts debug_dbGet to a code-hash key; that restriction is not implemented by this bridge. The proposed sockets are local0600, and bridge ports must never be forwarded. Actual L1 IPC activation would require a separately coordinated EL restart. No production services or administrator controls have changed.
