"""Stop the RPC enclave cleanly before its writable chain disks exhaust the host disk.

python3 -I rpc/snp/disk_guard.py UNIT PATH FLOOR_GIB

Every 30 s: if PATH's filesystem has less than FLOOR_GIB available, stop UNIT once
(its own stop path powers the guest off through QMP so the chain clients close their
databases) and exit. A full disk would instead pause QEMU on ENOSPC and starve every
other workload sharing the disk.
"""
import json
import os
import subprocess
import sys
import time

unit, path, floor = sys.argv[1], sys.argv[2], int(sys.argv[3]) * 1024**3
while True:
    st = os.statvfs(path)
    free = st.f_bavail * st.f_frsize
    if free < floor:
        print(json.dumps({'event': 'disk-floor', 'freeBytes': free, 'floorBytes': floor, 'unit': unit, 'at': time.time()}), flush=True)
        subprocess.run(['/usr/bin/systemctl', '--user', 'stop', unit], timeout=600)
        sys.exit(0)
    time.sleep(30)
