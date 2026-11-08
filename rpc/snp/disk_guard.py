"""Keep the RPC enclave's chain disks from exhausting the host disk.

python3 -I rpc/snp/disk_guard.py UNIT PATH FLOOR_GIB [--launch-config JSON --trim-unit UNIT --trim-state JSON]
                                 [--trim-at GIB] [--warn-at GIB] [--min-reclaim GIB]

Every 30 s it reads PATH's free space; every 10 min it logs a status line: free space, its growth rate
and the days left before FLOOR, and for each launch-config disk the qcow2's allocation against what
the guest's ext4 actually uses (from its superblock, read through `qemu-io -r -U`, which neither locks
nor writes the image). The difference is space the guest freed but never discarded.

- Under --warn-at, or under 7 days from FLOOR at the measured rate: a `disk-warn` line, at most hourly.
- Under --trim-at with at least --min-reclaim GiB reclaimable, and offline_trim.py's state allowing a
  run (none in 24 h, the last not failed): start --trim-unit, which stops the guest, returns the freed
  blocks (offline_trim.py) and starts it again. The trim unit is not PartOf UNIT; this guard is, so
  stopping the guest stops the guard and starting it starts a fresh one.
- Under FLOOR otherwise: stop UNIT once (its own stop path powers the guest off through QMP so the
  chain clients close their databases) and exit. A full disk would instead pause QEMU on ENOSPC and
  starve every other workload sharing the disk.
"""
import argparse
import json
import os
import re
import struct
import subprocess
import time

GIB = 1 << 30
WEEK_DAYS = 7


def superblock_used(qcow2):
    """Bytes in use on the ext4 filesystem inside qcow2, from its primary superblock (lazily updated)."""
    out = subprocess.run(['/usr/bin/qemu-io', '-r', '-U', '-f', 'qcow2', '-c', 'read -v 1024 1024', qcow2],
                         capture_output=True, text=True, timeout=60).stdout
    b = bytearray()
    for line in out.splitlines():
        m = re.match(r'^[0-9a-f]{8}:\s+((?:[0-9a-f]{2}\s){1,16})', line)
        if m:
            b += bytes.fromhex(m.group(1).replace(' ', ''))
    return used_from_superblock(bytes(b))


def used_from_superblock(sb):
    if len(sb) < 1024 or struct.unpack_from('<H', sb, 0x38)[0] != 0xEF53:
        raise ValueError('no ext4 superblock')
    wide = struct.unpack_from('<I', sb, 0x60)[0] & 0x80   # INCOMPAT_64BIT: the _hi halves are valid
    blocks = struct.unpack_from('<I', sb, 4)[0] | ((struct.unpack_from('<I', sb, 0x150)[0] << 32) if wide else 0)
    free = struct.unpack_from('<I', sb, 12)[0] | ((struct.unpack_from('<I', sb, 0x158)[0] << 32) if wide else 0)
    return (blocks - free) * (1024 << struct.unpack_from('<I', sb, 24)[0])


def disk_report(paths, used=superblock_used):
    out = []
    for p in paths:
        alloc = os.stat(p).st_blocks * 512
        try:
            u = used(p)
        except Exception as e:
            out.append({'disk': p, 'allocatedGiB': round(alloc / GIB, 1), 'error': str(e)[:200]})
            continue
        # Data in a backing file counts in `used` but not in this file's allocation, so this underestimates.
        out.append({'disk': p, 'allocatedGiB': round(alloc / GIB, 1), 'fsUsedGiB': round(u / GIB, 1),
                    'reclaimableGiB': round(max(0, alloc - u) / GIB, 1)})
    return out


def growth_per_day(samples):
    """Bytes/day of free-space loss over the samples [(t, free)], from at least an hour of history."""
    if len(samples) < 2 or samples[-1][0] - samples[0][0] < 3600:
        return None
    (t0, f0), (t1, f1) = samples[0], samples[-1]
    return (f0 - f1) / (t1 - t0) * 86400


def trim_allowed(state, now, cooldown=24 * 3600):
    return state.get('result') not in ('failed', 'running') and ('started' not in state or now - state['started'] >= cooldown)


def decide(free, a, reclaimable, state, now):
    """'trim', 'stop' or None for this free-space reading."""
    if a.trim_unit and free < a.trim_at and reclaimable is not None and reclaimable >= a.min_reclaim \
            and trim_allowed(state, now):
        return 'trim'
    if free < a.floor:
        return 'stop'
    return None


def parse(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('unit')
    p.add_argument('path')
    p.add_argument('floor', type=lambda g: int(g) * GIB)
    p.add_argument('--launch-config')
    p.add_argument('--trim-unit')
    p.add_argument('--trim-state')
    p.add_argument('--trim-at', type=lambda g: int(g) * GIB, default=150 * GIB)
    p.add_argument('--warn-at', type=lambda g: int(g) * GIB, default=250 * GIB)
    p.add_argument('--min-reclaim', type=lambda g: int(g) * GIB, default=50 * GIB)
    a = p.parse_args(argv)
    if a.trim_unit and not (a.launch_config and a.trim_state):
        p.error('--trim-unit needs --launch-config and --trim-state')
    return a


def emit(event, **kw):
    print(json.dumps({'event': event, 'at': round(time.time()), **kw}), flush=True)


def main(a):
    disks = [d['path'] for d in json.load(open(a.launch_config))['disks'] if d.get('discard')] if a.launch_config else []
    samples, last_status, last_warn, trim_started, report = [], 0, 0, None, []
    while True:
        now = time.time()
        st = os.statvfs(a.path)
        free = st.f_bavail * st.f_frsize
        if now - last_status >= 600:
            samples = [s for s in samples if now - s[0] <= 86400] + [(now, free)]
            report = disk_report(disks)
            rate = growth_per_day(samples)
            days = (free - a.floor) / rate if rate and rate > 0 else None
            emit('disk-status', freeGiB=round(free / GIB, 1), floorGiB=a.floor // GIB,
                 lossGiBPerDay=round(rate / GIB, 1) if rate is not None else None,
                 daysToFloor=round(days, 1) if days is not None else None, disks=report)
            last_status = now
            if (free < a.warn_at or (days is not None and days < WEEK_DAYS)) and now - last_warn >= 3600:
                emit('disk-warn', freeGiB=round(free / GIB, 1), daysToFloor=round(days, 1) if days is not None else None,
                     reclaimableGiB=round(sum(d.get('reclaimableGiB', 0) for d in report), 1))
                last_warn = now
        if free < a.trim_at or free < a.floor:
            reclaimable = sum(d.get('reclaimableGiB', 0) for d in report) * GIB if report else None
            try:
                state = json.load(open(a.trim_state)) if a.trim_state else {}
            except FileNotFoundError:
                state = {}
            if trim_started is None:
                action = decide(free, a, reclaimable, state, now)
            else:
                # The trim unit stops the guest, which stops this guard: still running after 15 min means it did
                # not. Fall back to the floor rule rather than starting it again.
                action = 'stop' if free < a.floor and now - trim_started > 900 else None
            if action == 'trim':
                emit('disk-trim', freeGiB=round(free / GIB, 1), reclaimableGiB=round(reclaimable / GIB, 1), unit=a.trim_unit)
                subprocess.run(['/usr/bin/systemctl', '--user', 'start', '--no-block', a.trim_unit], timeout=60)
                trim_started = now
            elif action == 'stop':
                emit('disk-floor', freeBytes=free, floorBytes=a.floor, unit=a.unit,
                     reclaimableGiB=round(reclaimable / GIB, 1) if reclaimable is not None else None,
                     trimState=state.get('result'))
                subprocess.run(['/usr/bin/systemctl', '--user', 'stop', a.unit], timeout=600)
                return
        time.sleep(30)


if __name__ == '__main__':
    main(parse())
