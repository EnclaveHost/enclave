# Compact header extraction prerequisites — saved evidence only

RAID owner reports no standalone qualified targeted extraction script. Do not run its L1-specific verify-l1-backup.sh unchanged or trust old PID files. Prior Base backup view was closed October26 at14:08 per its ACTIVE-STATE. No mount/extraction was started for this coordination.

Root read existing small saved evidence in /home/steven/Documents/Codex/2026-10-26/my/work/tr004 (not the image):
- base-first-megabyte.bin:1048576bytes, SHA256e3796d096073a00ea4419ed65a70a3d314e3921edf09d7f2a69956a95c0e0317. Ext4 magic0xef53 at raw1080 and UUID11c6bbac-f823-4052-a87a-066eed6ad590 at raw1128. This supports a filesystem starting at raw offset0.
- base-filesystem-header.txt reports same UUID,4096blocksize,enc-base-origin.
- base-backup-fsck.txt records five completed checking passes and final filesystem summary.
- Prior reconciled full inventories376equal and compact content/copy comparisons already committed in canonical-state-input-inventory-1859.

These are saved provenance, not a fresh read or hash of the compact image. At eventual targeted extraction, freshly bind the image identity and readonly/no-backing-dependency conditions, verify virtual filesystem magic/UUID before accessing exact inventory paths, use owned readonly lifecycle/private paths and bounded /vm destination, and recheck identity afterward. No original/USB reads or writes are needed for that source mapping. Preserve all source images and partial archives. Selected six header files plus reth.toml total362900885bytes per the listed inventory values (verify exact values programmatically at implementation).
