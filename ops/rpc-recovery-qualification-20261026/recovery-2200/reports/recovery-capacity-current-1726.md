# Root capacity observation 2026-10-26 21:50 UTC

`df -h / /vm` now shows root 47 GiB available and T710 75 GiB available, down from root176/T710285 at21:30. Existing RAID backup work owns those allocations; do not remove its files or alter its jobs. Our recovery overlay is only about4MB and remains read-only against original.

Do not start a large fresh Reth build or a recovered1.14TB copy at this capacity. Preserve the existing40GiB root free-space floor used for backup work, plus the16GiB host memory floor. Build preparation may continue; actual build requires a concrete disk-capacity preflight and bounded scratch growth before dispatch. No build is currently queued by root. Main lane is the bounded read-only recovery probe until~22:13.
