# Production derivative checks and publication identity

This supplements, without changing, PROCEDURE.md SHA256 a001fa2b9f6bd2518e37d367befebbf63f2399400b55d71c8b77a65d162a9c1f.

Root's fixture invocation fbc24257cc474c34a66e193c9a0c4356 reported PASS. Local readback of `U/rpc-offline-mask-fixture-r1/RESULT.json` and run.py confirms a synthetic 32 MiB ext4 partition, actual nested raw-over-qcow2 export, regular-file inode-preserving ln/unlink, masks, enablement-link removal, pre/post fsck zero, qcow check zero, unchanged prefix/suffix sentinels and original raw hash. This is fixture qualification, not a production derivative result.

The fixture used default QEMU cache settings and did not test a competing writer, symlink-inode relocation, production GPT validation, dirty/ext4-feature failures or publication. Keep claims limited to the operations exercised. For the smallest production delta, preserve enablement links as exact rollback records and use the fixture-tested `rm` on each precisely inventoried symlink. Symlink-inode relocation is optional and unqualified; do not add it merely to match the earlier candidate procedure. Archive original unit fragments using the qualified ln/unlink sequence.

## Fresh production preconditions

- Distinct source/backup/derivative paths, devices and inodes; no hard link from derivative to either protected image. Reflink is distinct inode but still requires full-capacity headroom. A standalone byte-preserving copy must start with the verified backup's full hash and have no backing image or external data dependency.
- Exact paused-workflow lock, authoritative image identity, terminal VM/guard, and known complete image-holder inventory; native QEMU image locks retained throughout exposure. Unknown holder visibility or a lock conflict is a refusal, not a reason to bypass locking.
- Primary/backup GPT header CRCs with their CRC field zeroed for computation, both partition-entry CRCs, agreeing disk GUID and partition layout, reciprocal header locations, valid usable-LBA bounds, bounded entry counts/sizes, non-overlap and root partition wholly within image. Root offset and length derive from verified first/last LBAs with checked arithmetic. Require expected sector size and capture partition unique GUID in addition to the type GUID.
- Exactly one root with the captured ext4 UUID, label, block size/count, partition bounds and compatible features. Require clean state, no recovery-needed flag, no external journal and zero fsck errors. The old reader's label alone is not filesystem identity. Do not disable checksums or silently replay a journal.
- Snapshot the eight regular fragments and all relevant unit-tree entries before any edit. Enforce the exact eight hashes, link count one, immutable expected owner/mode/xattrs, safe parent directory types and absence of archive collisions. Snapshot aliases and all `.wants/.requires/.upholds` links by exact path, link target, mode/ownership/timestamps/xattrs. Refuse special-file or unexpected hard-link cases.
- Keep each fragment's inode and metadata unchanged when archiving, except any specific metadata mutation actually demonstrated and explicitly accepted in the receipt. Restore original links from saved metadata on rollback; do not infer targets from unit names. Drop-ins, unrelated aliases, forwarding sockets, binaries and configuration remain outside the edit list.

## Publication receipt

Use an exclusive, immutable READY receipt that includes these fields after independent verification, not provisional success flags:

1. Operation ID; original manifest path/hash; original OS realpath/device/inode/size/timestamps/full hash; backup identity and full hash.
2. Derivative realpath/device/inode/size/timestamps/full hash; qcow2 virtual size and standalone status; verified GPT disk/root GUIDs, partition start/length and ext4 UUID/geometry/features.
3. Writer source/tool hashes and invocation/cgroup identity; exact eight before hashes and preserved inode metadata; exact enablement-link rollback records; actual mutation list and post-inventory allowed delta.
4. Pre/post full read-only fsck and nonrepairing qcow check results; fresh exporter readback; non-root partition/GPT preservation; complete cleanup and durable file/directory synchronization; unchanged source/backup checks.
5. Explicit state `verified-derivative-not-activated`. No Running/RPC-ready declaration and no DNS/KVM restore claim follows from an image edit.

Root's later publication must revalidate these identities under the same exclusive workflow lock, keep the old OS rollback identity, and bind the production manifest to the exact derivative inode/hash and changed configuration. A pathname-only switch or unchanged old manifest pin is insufficient. Rename changes metadata/possibly the path, so capture the published identity after the switch and before any launcher admission. Do not rewrite old PREPARED/QMP evidence to make it appear to describe the new image. Keep Base/L1 disks excluded until the separate full-RPC phase.

No publication, copy, writer, filesystem check or test was run by this preparation. Fresh UUID, derivative identity and final hashes are intentionally unknown until root's actual operation.
