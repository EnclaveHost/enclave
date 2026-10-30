# Recovery follow-up, 2026-10-26 17:39 UTC

The production RPC replacement remains incomplete. No consumer cutover or VM launch occurred.

Read-only inspection of the stopped Base image returned zero deleted inodes; no verified recovery candidate was found. This is not proof that all forensic recovery is impossible. The backing image inode/size/mtime/ctime were unchanged, and the FUSE mapping was cleanly removed. Existing 115 archive outputs remain reusable. The host state download has preserved approximately 53 GB of 761.23 GB, with durable committed offsets. Do not restart the old guest segmented retention command, which truncates partial downloads.

The cold Fable-Fusion source cache was copied and independently SHA256 verified on USB, then its old path atomically replaced with a symlink. Live model volumes were not changed. T710 available space increased from 58.72 to 79.90 GB. Two failed pre-mutation checks are retained: NTFS timestamps have 100 ns precision, and this installed fuser rejects the double-dash separator. The final run preserved exact source identity, required no reported open users, and verified the copied file before replacement. Qwen padbank growth had stopped; it was neither deleted nor throttled. RPC qualification VM activation still fails the required NVMe capacity threshold.

Qualification VM r4 has 18 passing mocked logic tests and addresses the r3 review's inventory/readiness/console-budget issues. Actual boot/confinement behavior remains unqualified. Offline b3sum r1 has 14 passing mocked logic tests; provenance, actual package fetch, guest execution, and full state BLAKE3 verification remain unqualified. The independent review records transport/admission and additional hardening findings; no production use is authorized by these test results.

Writer two-anchor implementation remains in progress in a separate Claude-owned stage. Existing administrator controls and production apps remain preserved.
