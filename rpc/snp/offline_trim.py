"""Return the blocks the RPC enclave's chain filesystems freed to the host disk, with the guest stopped.

python3 -I rpc/snp/offline_trim.py UNIT LAUNCH_CONFIG STATE_JSON [--force]

Each chain disk is a qcow2 on /vm that grows when the guest writes somewhere new and never shrinks when
the guest's ext4 frees blocks, unless the guest discards them. The r11 guest never does: its fstrim.service
trims only filesystems in /etc/fstab, which lists just the read-only root, and its chain disks mount
without `discard`. L1 reached 673 GiB for 427 GiB of data (rpc-snp-prod-r11, 2026-11-08).

The guest has no shell, so this stops UNIT, and for each launch-config disk with "discard": true:
  - exports the qcow2 through qemu-storage-daemon (FUSE, discard=unmap on both nodes; its write lock
    refuses an image the guest still holds);
  - requires `e2fsck -fn` clean, so the block bitmaps are authoritative;
  - punches holes over exactly the ranges the bitmaps mark free, shrunk inward to the qcow2 cluster
    (e2fsck -E discard issues nothing through this export);
  - requires `e2fsck -fn` clean again, closes the export, and requires `qemu-img check` clean
    (leaked clusters, which are only unreferenced space, are repaired and re-checked).
Then it starts UNIT again. A disk that is not clean before is left untouched. Any failure after a punch
began leaves UNIT stopped: the guest does not start on a disk that could be damaged.

STATE_JSON records each run. A run within 24 h of the previous one, or after a failed one, is refused
unless --force (disk_guard.py starts this automatically and must not loop).
"""
import ctypes
import json
import os
import re
import subprocess
import sys
import tempfile
import time

CLUSTER = 64 << 10
COOLDOWN = 24 * 3600
PUNCH = 0x02 | 0x01   # FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE
GIB = 1 << 30


class Refused(Exception):
    """Nothing on this disk was changed."""


class Failed(Exception):
    """A step after the punch began failed; the guest must not start."""


def free_ranges(dump):
    """Block size and merged free-block ranges [first, last] from `dumpe2fs` output of a clean filesystem."""
    if not re.search(r'^Filesystem state:\s+clean$', dump, re.M):
        raise Refused('filesystem not clean')
    if 'needs_recovery' in re.search(r'^Filesystem features:(.*)$', dump, re.M).group(1):
        raise Refused('journal needs recovery')
    bs = int(re.search(r'^Block size:\s+(\d+)', dump, re.M).group(1))
    ranges = []
    for line in dump.splitlines():
        # Only the indented per-group lines list blocks; the unindented header line is the free-block count.
        if not line.startswith('  Free blocks: '):
            continue
        for part in line[len('  Free blocks: '):].split(','):
            part = part.strip()
            if not part:
                continue
            a, _, b = part.partition('-')
            a, b = int(a), int(b or a)
            if ranges and ranges[-1][1] + 1 == a:
                ranges[-1][1] = b
            else:
                ranges.append([a, b])
    return bs, ranges


def byte_ranges(bs, ranges, align=CLUSTER):
    """(offset, length) per free range, shrunk inward to `align`; ranges smaller than one unit are dropped."""
    out = []
    for a, b in ranges:
        start = -(-a * bs // align) * align
        end = (b + 1) * bs // align * align
        if end > start:
            out.append((start, end - start))
    return out


def punch(raw, spans):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.fallocate.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_long, ctypes.c_long]
    fd = os.open(raw, os.O_RDWR)
    try:
        for off, n in spans:
            if libc.fallocate(fd, PUNCH, off, n) != 0:
                raise OSError(ctypes.get_errno(), 'fallocate at %d' % off)
    finally:
        os.close(fd)
    return sum(n for _, n in spans)


def fsck(raw):
    r = subprocess.run(['/usr/sbin/e2fsck', '-fn', raw], capture_output=True, text=True, timeout=7200)
    return r.returncode, (r.stdout.strip().splitlines() or [''])[-1]


def qcow2_check(path):
    r = subprocess.run(['/usr/bin/qemu-img', 'check', path], capture_output=True, text=True, timeout=3600)
    if r.returncode == 3:   # leaked clusters only
        subprocess.run(['/usr/bin/qemu-img', 'check', '-r', 'leaks', path], capture_output=True, text=True, timeout=3600)
        r = subprocess.run(['/usr/bin/qemu-img', 'check', path], capture_output=True, text=True, timeout=3600)
        return r.returncode, 'leaks repaired'
    return r.returncode, ''


def allocated(path):
    return os.stat(path).st_blocks * 512


class Export:
    """A writable raw FUSE view of a qcow2 whose discards punch holes in the file."""
    def __init__(self, qcow2, workdir):
        self.qcow2, self.raw, self.pid = qcow2, os.path.join(workdir, 'disk.raw'), os.path.join(workdir, 'qsd.pid')

    def __enter__(self):
        open(self.raw, 'w').close()
        subprocess.run(['/usr/sbin/qemu-storage-daemon',
                        '--blockdev', 'driver=file,node-name=f,filename=%s,discard=unmap' % self.qcow2,
                        '--blockdev', 'driver=qcow2,node-name=q,file=f,discard=unmap',
                        '--export', 'type=fuse,id=e,node-name=q,mountpoint=%s,writable=on' % self.raw,
                        '--daemonize', '--pidfile', self.pid], check=True, capture_output=True, text=True, timeout=120)
        self.qsd = int(open(self.pid).read())
        return self.raw

    def __exit__(self, *exc):
        os.kill(self.qsd, 15)
        for _ in range(600):
            try:
                os.kill(self.qsd, 0)
            except ProcessLookupError:
                return False
            time.sleep(0.5)
        raise Failed('qemu-storage-daemon did not exit')


def trim_disk(qcow2, log=print):
    before = allocated(qcow2)
    with tempfile.TemporaryDirectory(prefix='offline-trim-') as work:
        try:
            exp = Export(qcow2, work)
            raw = exp.__enter__()
        except subprocess.CalledProcessError as e:
            raise Refused('export refused (image in use?): ' + e.stderr.strip()[-300:])
        try:
            rc, summary = fsck(raw)
            if rc != 0:
                raise Refused('e2fsck -fn rc=%d before: %s' % (rc, summary))
            dump = subprocess.run(['/usr/sbin/dumpe2fs', raw], capture_output=True, text=True, check=True, timeout=3600).stdout
            bs, ranges = free_ranges(dump)
            spans = byte_ranges(bs, ranges)
            log(json.dumps({'event': 'trim-punch', 'disk': qcow2, 'fsck': summary, 'ranges': len(spans)}), flush=True)
            try:
                punched = punch(raw, spans)
            except OSError as e:
                raise Failed('punch: %s' % e)
            rc, after = fsck(raw)
            if rc != 0 or after != summary:
                raise Failed('e2fsck -fn rc=%d after: %s (before: %s)' % (rc, after, summary))
        finally:
            exp.__exit__()
    rc, note = qcow2_check(qcow2)
    if rc != 0:
        raise Failed('qemu-img check rc=%d %s' % (rc, note))
    return {'disk': qcow2, 'beforeBytes': before, 'afterBytes': allocated(qcow2), 'punchedBytes': punched,
            'fsck': summary, 'qcow2Check': note or 'clean'}


def systemctl(*args):
    return subprocess.run(['/usr/bin/systemctl', '--user', *args], capture_output=True, text=True, timeout=900)


def run(unit, config, state_path, force=False, trim=trim_disk, ctl=systemctl, now=time.time, log=print):
    try:
        prev = json.load(open(state_path))
    except FileNotFoundError:
        prev = {}
    if not force and prev.get('result') == 'failed':
        raise SystemExit('previous offline trim failed; inspect it, then rerun with --force')
    if not force and 'started' in prev and now() - prev['started'] < COOLDOWN:
        raise SystemExit('previous offline trim started under 24 h ago; rerun with --force')
    disks = [d['path'] for d in json.load(open(config))['disks'] if d.get('discard')]
    if not disks:
        raise SystemExit('no launch-config disk has discard set')
    vm = os.path.dirname(disks[0])
    st = os.statvfs(vm)
    state = {'started': now(), 'unit': unit, 'freeBefore': st.f_bavail * st.f_frsize, 'disks': [], 'result': 'running'}

    def save():
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        tmp = state_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, state_path)
    save()
    log(json.dumps({'event': 'trim-stop', 'unit': unit}), flush=True)
    ctl('stop', unit)
    if ctl('is-active', unit).stdout.strip() == 'active':
        state['result'] = 'refused'; state['error'] = 'unit still active after stop'; save()
        ctl('start', unit)
        raise SystemExit(state['error'])
    failed = None
    for disk in disks:
        try:
            state['disks'].append(trim(disk, log=log))
        except Refused as e:
            state['disks'].append({'disk': disk, 'refused': str(e)})
        except Exception as e:   # Failed, or anything unexpected once a punch may have begun
            state['disks'].append({'disk': disk, 'failed': str(e)})
            failed = e
            break
        save()
        log(json.dumps({'event': 'trim-disk', **state['disks'][-1]}), flush=True)
    st = os.statvfs(vm)
    state.update(freeAfter=st.f_bavail * st.f_frsize, ended=now())
    if failed is not None:
        state['result'] = 'failed'; save()
        log(json.dumps({'event': 'trim-failed', 'unit': unit, 'held': True, 'error': str(failed)}), flush=True)
        raise SystemExit('offline trim failed; %s left stopped: %s' % (unit, failed))
    state['result'] = 'ok' if all('refused' not in d for d in state['disks']) else 'partial'
    save()
    ctl('start', unit)
    log(json.dumps({'event': 'trim-done', 'result': state['result'], 'freeBeforeGiB': round(state['freeBefore'] / GIB, 1),
                    'freeAfterGiB': round(state['freeAfter'] / GIB, 1)}), flush=True)
    return state


if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if x != '--force']
    run(a[0], a[1], a[2], force='--force' in sys.argv)
