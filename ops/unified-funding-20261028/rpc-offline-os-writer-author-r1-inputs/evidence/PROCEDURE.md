# Offline masking on a separate OS derivative — preparation only

No image was copied, mounted, edited, repaired, or launched. No tool qualification was run. This procedure replaces the memory-heavy OS-only boot with bounded filesystem work; it does not qualify or start the smaller full RPC VM. Root retains production execution. The user's production recovery authorization already exists.

## Scope and material already available

Use the exact eight fragment hashes in UNIT-PINS.json, extracted as data from the unchanged `postrestore-maintenance-stage/r1/guest_mask.py`. Preserve each original fragment and its enablement metadata. Mask those eight names in `/etc/systemd/system`; remove only their inventoried enablement links. Keep drop-ins, forwarding sockets, all other units, boot files, and chain data unchanged. Do not attach or inspect Base/L1 disks.

Root reported a verified fresh backup at `/vm/enclave-volumes/rpc-production-maint/os-backup-20261030T061922Z-1a31c4/os.qcow2`, SHA256 `f7e4ebc11362393f9db8e72c5f957cfa543ea4583d6ce5a73d3c59198037ab57`. Revalidate its receipt and identity before use. Derive a new standalone qcow2 on the reviewed NVMe maintenance filesystem, separate from that backup and from the authoritative OS. This preparation has not selected or created the derivative path.

The old inventory reports GPT partition 1, first LBA 2099200, last LBA 67108830, sector size 512, root offset 1074790400, Linux filesystem type and label `cloudimg-rootfs`. These are comparison expectations, not a substitute for fresh validation or filesystem UUID. Root must capture the ext4 UUID, geometry, feature bits and state before mutation.

## Phase 1: bounded tool qualification and immutable inputs

1. Root qualifies the exact installed nbdfuse/qemu-nbd/debugfs/e2fsck sequence on a small synthetic ext4-in-qcow2 fixture first. Cover partition offset/length, writer locking, symlink inode preservation, debugfs stderr errors despite exit zero, read-only reopen, flush/termination, and post-edit `e2fsck -f -n` exit zero. A deliberately competing writer must be rejected. No production disk is used in qualification.
2. Pin executable identities and relevant source bytes. Use a single bounded helper allocation, no network, no swap, bounded stdout/stderr, runtime and disk limits. Proposed starting allowance is the already-used 512 MiB hard/450 MiB RSS envelope, subject to root's fresh admission and actual fixture outcome; this is not a measured memory minimum for full fsck. A resource refusal must leave the derivative unpromotable, not trigger unbounded retries.
3. Hold the production workflow's existing image-operation lock for the entire operation; verify stopped production VM/guard, exact source and backup identities, and no competing writer. A lock only coordinates users that honor it, so retain QEMU's native image locking; never use force-share or disable locking. Incomplete process visibility is not proof of no holders.
4. Create an exclusive new derivative directory and file; refuse existing names and symlink paths. Reserve the derivative's worst-case virtual allocation, filesystem/evidence margin and existing NVMe floor before copying. Keep it on NVMe, never `/tmp` or the root filesystem. A reflink/sparse copy may save actual blocks but must not be treated as guaranteed future space. A full byte-preserving standalone copy from the verified backup is simplest. Verify the initial complete hash and source identities before/after copying. Refuse backing chains, external data files, encryption or other unexpected qcow2 dependencies rather than silently following them.

## Phase 2: read-only validation of the derivative

Run `qemu-img check` without repair and require zero errors. Expose only the derivative read-only using the existing nbdfuse + qemu-nbd pattern. Validate primary and backup GPT headers/tables including CRCs, bounds and non-overlap, and select exactly one matching ext4 root. The old reader checks a primary signature and label but does not supply these stronger writer preconditions.

Require the exact filesystem UUID/label/geometry, supported features, clean state, no pending journal recovery, no filesystem error state and no external journal dependency. Do not repair a dirty filesystem as an incidental part of masking. Require a full read-only forced fsck exit zero before mutation; any refusal, timeout, nonzero status or truncated diagnostic makes the operation incomplete.

Expose the root partition as an offset-zero, length-bounded NBD file for fsck and debugfs. Candidate argument shape (separate argv elements, not shell interpolation):

```
nbdfuse -r <private-mount>/root.ext4 [ qemu-nbd -r --cache=directsync --discard=ignore --image-opts driver=raw,offset=<bytes>,size=<bytes>,file.driver=qcow2,file.file.driver=file,file.file.filename=<derivative> ]
e2fsck -f -n <private-mount>/root.ext4
```

The installed qemu-nbd manual documents a raw slice with offset and size. Nested raw-over-qcow2 plus FUSE remains a qualification item, not a claimed tested command. Do not pass debugfs's `?offset=` convention to e2fsck. Use a controlled path with no option delimiters. The full image is read-only for GPT inspection; the later writable export must expose only the bounded root partition.

Inventory all three on-disk unit directories using the pinned inventory semantics, with full error checking. Record each target fragment's exact inode, regular-file type, size, hash, mode, owner, link count, timestamps and extended attributes. Require the eight expected regular files with the pinned contents; any already-masked or other state requires a separately reconciled plan. Inventory the exact `.wants`, `.requires`, `.upholds` symlink paths and targets for the eight names, including all relevant layers. Refuse unexpected aliases/types/paths rather than running a broad disable command. Preserve the original inventory outside the image and in a bounded rollback receipt. Do not log secrets or unrelated file contents.

## Phase 3: edit only the derivative

Close the read-only exporter cleanly. Start one identity-tracked writable qemu-nbd/nbdfuse exporter on the derivative's bounded root partition, retaining native image locking. Do not use `-r` for this phase; do not use `debugfs -c`, which forces read-only. Do not use checksum bypass, force options or unsafe cache modes. Require the synthetic qualification to demonstrate durable flush and normal exporter shutdown.

Use a new rollback directory within `/var/lib/enclave-rpc-maint/<unique-stamp>` with root ownership and mode 0700. Refuse any unexpected existing path or symlink component. Perform only a precomputed, bounded list of filesystem operations; do not execute scripts or systemctl from the guest.

For each regular fragment, the smallest inode-preserving move candidate is:

```
ln <EXACT_INODE> /var/lib/enclave-rpc-maint/<stamp>/<unit>
unlink /etc/systemd/system/<unit>
symlink /etc/systemd/system/<unit> /dev/null
```

These are debugfs requests. Its documented `ln` and `unlink` both leave the inode reference count unchanged, so the paired operations preserve the final count. Require original link count one and verify the new link points to the same inode before unlinking the original. Do not substitute `rm` for this unlink: it decrements the reference count and could deallocate the preserved inode. Qualify exact inode syntax and behavior on the fixture first. A failure between the two commands invalidates the derivative; do not repair or promote it automatically.

Preserve enablement symlinks in the receipt with their exact paths, targets and metadata; preferably move their exact inodes into unique rollback names using the same qualified pair. This requires qualifying symlink-inode behavior explicitly. Remove only those exact pre-inventoried names from their original enablement directories. Verify no matching enablement link remains. No type-wide drop-in or unrelated symlink is removed. Store a bounded receipt mapping original paths to archive paths; preserve all original fragment bytes and metadata.

Check exit status **and** stderr for every debugfs invocation; this tool can print an error with status zero. Treat unknown diagnostics as failure. Verify every individual operation before the next destructive step. Flush all writes and end the writer normally. A timeout/kill/I/O error never constitutes a successful edit.

## Phase 4: independent offline verification and handoff

Reopen through a fresh read-only exporter. Require `e2fsck -f -n` exit zero; no automatic correction, journal replay, checksum disable or accepting exit 1 as clean. Check the same UUID/geometry/state/features, all eight `/dev/null` masks, absence of their enablement links, preserved fragment bytes/inodes/metadata and archived link records. Re-run the complete unit inventory with no readErrors and compare to baseline: allowed changes are only those masks, exact archived entries, removed target enablement links and receipt. All drop-ins and unrelated unit/enablement entries must match. A whole-filesystem fsck is required, while the semantic inventory comparison covers the unit tree; this is not a claim of byte-identical filesystem metadata.

Verify primary/backup GPT and non-root partitions unchanged. Close/unmount normally, prove nbdfuse/qemu-nbd descendants exited, fsync the derivative file and containing directory, and run a final nonrepairing qcow2 check. Capture final full hash/stat, tool identities, fsck/check statuses, baseline/post inventories, explicit allowed delta, backup reference and terminal cleanup. Recheck original OS and backup identities/hashes unchanged. Mark READY only after all checks pass.

Do not rename over the live OS, change the production manifest, activate forwarding, attach chain disks or launch any VM in this procedure. Hand the verified derivative to root for a separate stopped-image switch and updated manifest/pins. This avoids the maintenance boot allocation only; full RPC resource admission and sync/finality/history/proof qualification still remain.

On any failure keep the derivative marked FAILED for bounded diagnosis, release owned resources, and leave the source/backup authoritative. Do not automatically reuse a partly edited image or rerun mutations. Clean up abandoned derivatives only after root establishes they are no longer needed; their retained bytes count against the storage ceiling.
