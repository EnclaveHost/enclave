# Actual target boot-media result

The protected Windows target has independently verified boot.vhdx (1,933,574,144 bytes, SHA-256 5d01973660220c8069d707e8d54a38d3a68e32956ac8ff9a0075b714974fd175) and seed.iso (378,880 bytes, SHA-256 c92f5bc01f1c615df4a5f5df697c0cb9e32456ddfb8f88e746e561e1f981b78a). Native Get-VHD reports standalone dynamic VHDX, virtual 3,758,096,384 bytes, unattached. Root is the exact SPEC.json root. Transfer elapsed 19.931s under the unchanged150s transfer deadline. No VM was created, defined or started.

Original r1 transfer failed DNS resolution before connection after protected namespace creation. Changed r2 transport reached the target but its single32KiB window timed out; exact local processes are gone, a fresh read found no SFTP writers, and the454,852,608-byte partial remains preserved in its original root. Changed r3 used64x32KiB requests in a new namespace and succeeded. These are transport preparation, not RPC startup trials.

Duplicate preparation source.qcow2 and output/boot.vhdx on Control were removed only after exact hash/size/nonlink/ownership/inode checks. The original Warden cloud image and verified Windows target remain; all other preparation evidence remains. No explicit trim or VM/service restart. Control output/boot.vhdx is no longer the artifact location.

Fresh metadata read at08:48UTC found19,173,773,312 bytes free on Windows C:. Remaining4GiB boot envelope plus256MiB artifacts and16GiB floor requires19,809,697,792 bytes after staging, so full disk admission still failed by635,924,480 bytes. User subsequently explicitly authorized uninstalling games; that separate action is in progress. Warden USB /mnt/usb reports52,399,020,703,744 bytes available (47.66TiB), separate from Windows C:. Chain databases are not copied into this boot image.

All original failures retained. Capacity read r1 exited1 without preserved stderr, so no cause claim; changed r2 returned structured diagnostics and explicit integer arithmetic, success. Actual target boot/storage connection, completed cut/pool transition,20GiB workload fit, chain sync/finality and consumer cutover remain unproven. Full goal remains active.
