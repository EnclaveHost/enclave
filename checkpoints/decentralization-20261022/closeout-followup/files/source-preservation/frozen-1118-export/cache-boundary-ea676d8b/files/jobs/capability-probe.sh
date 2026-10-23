#!/bin/bash
# READ-ONLY capability probe for a bounded local dm-cache/loop/ext4 test. Changes nothing; creates no device.
set -u
echo "## date"; date -u +%FT%TZ
echo "## id"; id
echo "## sudo -n"; sudo -n true 2>&1 && echo "sudo -n: AVAILABLE" || echo "sudo -n: NOT available (no password request made)"
echo "## control nodes"; ls -l /dev/loop-control /dev/mapper/control 2>&1
echo "## existing loops (count)"; ls /dev/loop[0-9]* 2>/dev/null | wc -l; losetup -l -n 2>&1 | head -5
echo "## existing dm devices (names only)"; ls /dev/mapper 2>&1
echo "## modules present (read /sys only)"; for m in loop dm_mod dm_cache dm_cache_smq dm_crypt dm_persistent_data dm_bio_prison; do printf '%s ' $m; [ -d /sys/module/$m ] && echo loaded || echo not-loaded; done
echo "## dm targets (needs no root?)"; dmsetup targets 2>&1 | head -10
echo "## userns"; cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null; cat /proc/sys/user/max_user_namespaces
echo "## unshare -rm + overlay (private ns, throwaway dirs)"; T=$(mktemp -d); mkdir -p $T/{lo,up,wk,mnt}; echo x > $T/lo/f
unshare -rm sh -c "mount -t overlay overlay -o lowerdir=$T/lo,upperdir=$T/up,workdir=$T/wk $T/mnt && cat $T/mnt/f && echo overlay-in-userns: OK" 2>&1; rm -rf $T
echo "## unshare -rm + ext4 loop mount attempt (expected to fail unprivileged)"; T=$(mktemp -d); truncate -s 16M $T/img; mkfs.ext4 -q -F $T/img 2>&1 && echo mkfs-on-file: OK
unshare -rm sh -c "mkdir $T/m; mount -o loop $T/img $T/m 2>&1; echo mount-rc=\$?" ; rm -rf $T
echo "## tools"; for t in losetup dmsetup mkfs.ext4 e2fsck debugfs dumpe2fs cryptsetup blockdev fallocate cache_check; do printf '%s ' $t; command -v $t || echo missing; done
echo "## workspace filesystem"; findmnt -T "$PWD" -o TARGET,SOURCE,FSTYPE; lsblk -no NAME,TYPE,ROTA "$(findmnt -T "$PWD" -no SOURCE)" 2>&1 | head
echo "## end"
