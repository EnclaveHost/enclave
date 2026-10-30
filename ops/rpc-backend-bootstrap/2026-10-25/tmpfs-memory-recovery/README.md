# Recover tmpfs memory without stopping apps (2026-10-25)

Archived eight cold user-owned temporary build trees, 1,856,773,364 bytes, to `/vm/enclave-volumes/build-tmp-recovery/20261025`. Original paths now resolve through symlinks to retained NVMe copies. No VM, app, RPC service, memory allocation or runtime floor changed.

Each tree was older than a day, had no references in the visible process FD/cwd/exe/maps/command scan, no special files, and no hard links. Root-owned/inaccessible process entries cannot be fully inspected (counts are in the receipt), so this scan is not proof of global inactivity. Active perf scratch and trees with hard links were retained. The archived siblings of the active scratch directory were checked separately; the active directory itself was not moved.

The tool streams SHA256 for all regular files, preserves metadata and symlinks, refuses relative links escaping the tree, checks source/copy equality and source stability, syncs the destination filesystem, then uses Linux renameat2(RENAME_EXCHANGE) for an atomic directory/link swap. It re-verifies the old tmpfs tree before removing that redundant copy. The NVMe recovery copy is retained. Full per-file manifests remain beside those archives; they are not published here. No arbitrary temporary-file contents are committed.

A separate tiny cross-filesystem fixture exercised copy verification, atomic directory/link exchange and old-path access before the real operation; it passed and was removed. `apply.json` records the actual operation. Host MemAvailable was 21,500,312 KiB before and 23,304,028 KiB after; this is an observation, not a guarantee against unrelated memory changes.

## Rollback

Stop only the build job if necessary and ensure enough free tmpfs and host memory above the16GiB floor to restore the selected tree. Check visible references again. Copy its NVMe archive into a new sibling directory beside the original symlink, verify it against the retained manifest using snapshot(), then exchange that new directory and the original symlink with exchange(). The original path becomes a directory again. Remove only the displaced symlink. Keep the NVMe archive and manifests until recovery has been verified. Do not restore into active paths, overwrite archives, or consume the host memory floor. The script contains workstation paths and is an audited one-time helper, not a recurring cleaner.
