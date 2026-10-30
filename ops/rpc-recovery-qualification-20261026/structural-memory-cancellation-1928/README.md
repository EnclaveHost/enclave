# Structural validation cancelled by host memory pressure

Scan 1928 ran from 2026-10-27 14:43 UTC until approximately 19:22 UTC. It exited 5 (CANCELLED) when its soft guard observed 16,758 MiB available, below the 16 GiB reserve plus 512 MiB buffer. The outer guard recorded a minimum of 16,567 MiB. This is not a clean structural result, nor evidence of database corruption.

A concurrent snapshot-work owner reported an unguarded Node assertion-formatting test consuming approximately 70 GB RSS. The owner stopped its test processes. That reported spike coincided with this recorded guard cancellation; the scan did not terminate by OOM. Do not describe the unrelated test as guarded, or its reported 18.8 GiB observation as the minimum host availability.

The final job receipt confirms complete owned-process/mount cleanup, unchanged peers and preserved input snapshots. No USB writes, RPC VM restart, state import or consumer cutover occurred. The original files remain preserved. Subsequent tests must use bounded cgroups and the host floor even for small fixtures. A fresh structural run is still required; progress from this cancelled scan cannot be claimed as completed validation.
