#!/bin/bash
set -u
cd "$(dirname "$0")"
unit="shield-direct-image-$$"
log="$PWD/image.log"
if [ "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" -lt $((16*1024*1024+1024*1024)) ]; then echo 'Insufficient headroom for 1024MiB image assembly';exit 75;fi
systemd-run --user --scope --unit="$unit" -p MemoryMax=1024M -p MemorySwapMax=0 timeout --signal=TERM 600 node --expose-gc --max-old-space-size=160 "$PWD/build-image.mjs" "$PWD/shield-direct.cpio.gz" 22c9666b5817ef651365892bf836c68a5c285b8ff94cdd3ad3e30f2bee1d7eaf "$PWD/image" /home/steven/enclave-bench/nucbox-shield-20260929/kernel-vtpm.elf /home/steven/enclave-bench/nucbox-shield-20260929/openhcl-shield.cpio.gz > "$log" 2>&1 &
pid=$!;peak=0;stopped='';cg=''
while kill -0 "$pid" 2>/dev/null; do
 if [ -z "$cg" ]; then cg=$(systemctl --user show -p ControlGroup --value "$unit.scope" 2>/dev/null);fi
 if [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/memory.peak" ]; then peak=$(cat "/sys/fs/cgroup$cg/memory.peak");fi
 available=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
 if [ "$available" -lt $((16*1024*1024)) ]; then stopped='host floor';systemctl --user stop "$unit.scope";break;fi
 sleep 1
done
wait "$pid";rc=$?
printf 'exit=%s peakBytes=%s stopped=%s\n' "$rc" "$peak" "$stopped" | tee -a "$log"
exit "$rc"
