# Post-restoration RPC recovery tools, r1

Claude implemented the read-only unit inventory and stage-only USB rebind. Root reviewed the sources and ran 17 bounded fixture tests, all passing after correcting one test that accidentally commented out its inode replacement. The first run failed that fixture; no production change resulted. Fixtures emit Python ResourceWarnings from short-lived temporary-file handles; the completed run peaked at 23.1 MiB in a 256 MiB, zero-swap service. No skipped tests.

Run fixtures with `python3 -B -I -m unittest discover -s . -p test_postrestore_r1.py -v` from this directory through the shared queue. They read the pinned installed launcher and old manifest and frozen inspector; all disks, mount data, unit states and debugfs results under test are fixtures. Paths are intentionally local to this recovery machine.

Actual read-only OS inspection completed with no reported read errors and no FUSE/NBD processes or mounts remaining. Both snapshot download services are enabled and unmasked; L1 consensus and the L1 execution path are also enabled. This inventory does not evaluate generators, kernel-command-line masks or non-Enclave units pulling in Enclave units. It is not a general proof of safe boot.

The real USB observation, staging and subsequent check all passed without changing installed configuration. Only HDD UUID/source and Base inode change; leaf disk identity remains unchanged. New Base inode is 929; UUID is 702FE78A62B4C5DC on /dev/sda1. The staged manifest SHA256 is d73dcb68e2219ad85217d88b7727f5501aad2e7913f3c65eb1071d19a1229b39. No whole-image hash or database structural scan was performed. Restoration receipts prove recovered-copy equality; current inode/size observations are separate evidence.

Nothing is installed or started. Before installation repeat check-stage against fresh observations. Prevent snapshot/retention auto-start and resolve RAM/storage placement before any production VM boot. Preserve the current OS/L1 images on /vm; USB OS/L1 copies are older. The restored Base database is not yet qualified for chain usability, finality or production RPC service.
