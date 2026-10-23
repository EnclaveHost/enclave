#!/bin/bash
# READ-ONLY local inventory: mounts, block devices, free space, memory, kernel cache modules and tools. No writes outside
# this job's output file, no root, no device access beyond sysfs/proc metadata.
set -u
echo "## date"; date -u +%FT%TZ
echo "## id"; id
echo "## uname"; uname -r
echo "## lsblk"; lsblk -b -o NAME,TYPE,SIZE,ROTA,TRAN,MODEL,FSTYPE,MOUNTPOINTS 2>&1
echo "## findmnt (real filesystems)"; findmnt -rn -t ext4,xfs,btrfs,zfs,f2fs,vfat,exfat,ntfs3,fuseblk -o TARGET,SOURCE,FSTYPE,OPTIONS 2>&1
echo "## df"; df -B1 --output=source,fstype,size,used,avail,target -x tmpfs -x devtmpfs -x overlay -x squashfs 2>&1
echo "## free"; free -b
echo "## meminfo"; grep -E "MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback:" /proc/meminfo
echo "## nproc"; nproc
echo "## kernel modules on disk (dm-cache, bcache, dm-writecache, loop)"; M=/lib/modules/$(uname -r); ls -d $M 2>&1; find $M/kernel/drivers/md $M/kernel/drivers/block -maxdepth 2 \( -name 'dm-cache*' -o -name 'bcache*' -o -name 'dm-writecache*' -o -name 'loop*' -o -name 'dm-mod*' \) 2>/dev/null
echo "## loaded/builtin"; for m in dm_mod dm_cache dm_cache_smq bcache dm_writecache loop; do printf '%s ' $m; [ -d /sys/module/$m ] && echo present || echo absent; done
grep -E "dm_cache|bcache|loop" $M/modules.builtin 2>/dev/null | head
echo "## tools"; for t in lvm lvcreate dmsetup losetup cache_check make-bcache bcache xfs_quota setquota quotacheck tune2fs btrfs zfs; do printf '%s ' $t; command -v $t || echo missing; done
echo "## dm targets visible"; cat /proc/devices | grep -E "device-mapper|loop" ; ls /sys/class/misc/ 2>/dev/null | grep -E "device-mapper|loop-control"
echo "## sudo -n"; sudo -n true 2>&1 && echo "sudo -n: yes" || echo "sudo -n: no"
echo "## ext4 features via sysfs"; ls /sys/fs/ext4/ 2>/dev/null
echo "## lvm pvs/vgs (unprivileged attempt)"; (vgs --noheadings 2>&1 | head -3)
echo "## base binaries present?"; for p in $HOME/.cargo/bin /usr/local/bin /usr/bin; do ls $p 2>/dev/null | grep -E "^(base|base-reth-node|base-consensus|op-reth|reth|geth|lighthouse|nimbus)" | sed "s|^|$p/|"; done
command -v docker podman 2>/dev/null
