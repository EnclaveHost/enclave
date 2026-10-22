#!/bin/sh
# READ-ONLY resource/service inventory for one regional node (run over `ssh -o BatchMode=yes ... sh -s`).
# Reads ONLY aggregate kernel/cgroup counters, filesystem sizes, systemd unit properties (no ExecStart/Environment),
# executable paths (readlink /proc/PID/exe: path only, never cmdline/environ) and counts. Changes nothing.
echo "### host"; hostname; uname -r; nproc; cat /proc/uptime
echo "### meminfo"; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Shmem|Slab|SReclaimable|SUnreclaim|Committed_AS|CommitLimit|AnonPages|KernelStack|PageTables)' /proc/meminfo
echo "### psi_memory"; cat /proc/pressure/memory 2>/dev/null
echo "### cgroup_root"; for f in memory.current memory.peak memory.max memory.swap.max memory.events; do printf '%s ' "system.slice/$f"; tr '\n' ' ' < /sys/fs/cgroup/system.slice/$f 2>/dev/null; echo; done
echo "### disk"; df -B1 --output=target,size,used,avail,pcent / /var 2>/dev/null; df -i / | tail -1
echo "### swap"; swapon --show 2>/dev/null; echo "swappiness $(cat /proc/sys/vm/swappiness)"
echo "### docker"; command -v docker >/dev/null && echo "docker present" || echo "docker absent"; systemctl is-active docker 2>/dev/null; systemctl is-active containerd 2>/dev/null
echo "### units"
systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}' | while read -r u; do
  props=$(systemctl show "$u" -p MemoryCurrent -p MemoryPeak -p MemoryMax -p MemoryHigh -p MemorySwapMax -p MainPID -p ActiveEnterTimestamp -p NRestarts -p FragmentPath --no-pager 2>/dev/null | tr '\n' '|')
  pid=$(systemctl show "$u" -p MainPID --value 2>/dev/null)
  exe=""; [ -n "$pid" ] && [ "$pid" != "0" ] && exe=$(readlink /proc/$pid/exe 2>/dev/null)
  echo "UNIT $u|$props EXE=$exe"
done
echo "### oom_kills_30d"; journalctl -k --since "-30 days" --no-pager 2>/dev/null | grep -ciE "out of memory|oom-kill" ; for f in /sys/fs/cgroup/system.slice/memory.events; do grep -E '^(oom|oom_kill) ' $f 2>/dev/null; done
echo "### var_lib_sizes"; du -sb /var/lib/docker /var/lib/enclave* /opt/enclave* /var/log 2>/dev/null
echo "### listening_ports_count"; ss -Hltn 2>/dev/null | wc -l
echo "### end"
