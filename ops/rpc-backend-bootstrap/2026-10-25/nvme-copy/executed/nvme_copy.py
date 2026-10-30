#!/usr/bin/env python3
"""nvme_copy.py PLAN.json -- copy ONE stopped VM disk file (e.g. an L1 qcow2) to a target directory, OFFLINE, verified.

Run by root on the host, with the VM's unit STOPPED and its guest cleanly shut down. The helper only CHECKS that the unit is
inactive/failed with MainPID 0; it never starts, stops, installs or repairs anything, and a clean copy says nothing about the
consistency of the guest filesystem inside the image (an unclean guest shutdown is copied exactly as it is).

What it does, in order (any failure stops it; nothing is ever retried or resumed):
  1. plan: format, absolute paths without symlinked components, the source's EXACT (dev, ino, size) from the plan;
  2. source: lstat = regular file, not a symlink, st_nlink == 1, (dev, ino, size) == plan; opened O_RDONLY|O_NOFOLLOW (the
     source is never opened for writing, never truncated, renamed, removed or modified);
  3. unit: `systemctl show` LoadState=loaded, ActiveState inactive|failed, MainPID 0 (before the lock, after it, after the copy);
  4. QEMU lock: refuses if ANY process holds a lock on QEMU's image-lock bytes (100..299, file-posix.c RAW_LOCK_PERM_BASE /
     RAW_LOCK_SHARED_BASE) or has the file open (/proc/*/fd; as REAL root every fd table must be readable, otherwise only an
     explicit plan "allowIncompleteProcScan": true - tests in a user namespace - accepts an incomplete scan), then holds a SHARED OFD read lock on bytes 100..299 for the whole
     run: QEMU's own lock check then refuses to open the image (read-only or read-write) until the helper exits. A shared read
     lock needs only the O_RDONLY descriptor (no O_RDWR);
  5. target: an existing directory (not a symlink) on a disk filesystem (tmpfs/ramfs refused); free space >= source size +
     reserve (reserve >= 300 GB, decimal); final name and the private partial name must NOT exist;
  6. copy: one 8 MiB buffer, the source's SHA256 as read, an all-zero chunk is not written (a hole), the file length is set
     once at the end (ftruncate to the source size: the copy is byte-for-byte, no conversion), periodic fdatasync, fsync at
     the end; then the partial is RE-READ and hashed and must equal the source hash;
  7. source re-check: fstat AND lstat (dev, ino, size, mtime_ns, ctime_ns, nlink, mode) unchanged and the path still names it;
  8. publish: link(partial, final) (fails if final exists: never replaces), unlink(partial), fsync(directory);
  9. receipt (public: sizes, hashes, times, fsync times, unit state; no file contents) + progress JSON every 15 s (atomic).
On ANY failure after the partial exists, the partial is KEPT and an exclusive '<partial>.FAILED.json' marker names the error:
the partial is never a valid copy and is never resumed; delete it by hand after reading the marker.
"""
import fcntl, hashlib, json, os, socket, stat, struct, subprocess, sys, time

FORMAT = 'enclave-nvme-copy-plan/v1'
CHUNK = 8 << 20                       # the one bounded buffer
MIN_RESERVE = 300 * 10**9             # free space left on the target filesystem after the copy (decimal GB)
SYNC_EVERY = 4 << 30                  # fdatasync + drop cached pages every 4 GiB
PROGRESS_EVERY = 15.0
QEMU_LOCK_START, QEMU_LOCK_LEN = 100, 200   # bytes 100..299: RAW_LOCK_PERM_BASE 100 + RAW_LOCK_SHARED_BASE 200 (+ bit)
RAM_FS = {'tmpfs', 'ramfs', 'devtmpfs', 'hugetlbfs'}
ZERO = bytes(CHUNK)

class Refused(Exception):
    pass

def flock_struct(ltype, start, length):
    return struct.pack('hhqqi4x', ltype, os.SEEK_SET, start, length, 0)   # struct flock (x86_64); l_pid 0 for OFD

def lock_holder(fd):
    """-> None, or the lock another file description holds on QEMU's lock bytes (F_OFD_GETLK for an exclusive lock)."""
    r = fcntl.fcntl(fd, fcntl.F_OFD_GETLK, flock_struct(fcntl.F_WRLCK, QEMU_LOCK_START, QEMU_LOCK_LEN))
    ltype, _, start, length, pid = struct.unpack('hhqqi4x', r)
    return None if ltype == fcntl.F_UNLCK else {'type': 'read' if ltype == fcntl.F_RDLCK else 'write', 'start': start, 'len': length, 'pid': pid}

def take_shared_lock(fd):
    fcntl.fcntl(fd, fcntl.F_OFD_SETLK, flock_struct(fcntl.F_RDLCK, QEMU_LOCK_START, QEMU_LOCK_LEN))   # non-blocking

def other_openers(dev, ino):
    """-> ([pids with the file open], unreadable /proc entries). The helper's own pid is excluded."""
    me, found, unreadable = os.getpid(), [], 0
    for pid in os.listdir('/proc'):
        if not pid.isdigit() or int(pid) == me:
            continue
        try:
            fds = os.listdir(f'/proc/{pid}/fd')
        except FileNotFoundError:
            continue
        except PermissionError:
            unreadable += 1; continue
        for fd in fds:
            try:
                st = os.stat(f'/proc/{pid}/fd/{fd}')
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if (st.st_dev, st.st_ino) == (dev, ino):
                found.append(int(pid)); break
    return found, unreadable

def unit_state(systemctl, unit):
    out = subprocess.run([systemctl, 'show', '--no-pager', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', unit],
                         capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise Refused(f'systemctl show {unit} failed: {out.stderr.strip()[:200]}')
    kv = dict(l.split('=', 1) for l in out.stdout.splitlines() if '=' in l)
    st = {k: kv.get(k) for k in ('LoadState', 'ActiveState', 'SubState', 'MainPID')}
    if st['LoadState'] != 'loaded' or st['ActiveState'] not in ('inactive', 'failed') or st['MainPID'] != '0':
        raise Refused(f'unit {unit} is not stopped (need LoadState=loaded, ActiveState inactive|failed, MainPID 0): {st}')
    return st

def fs_type(path):
    dev = os.stat(path).st_dev
    want = f'{os.major(dev)}:{os.minor(dev)}'
    best = None
    with open('/proc/self/mountinfo') as f:
        for line in f:
            a, b = line.split(' - ', 1)
            fields = a.split()
            if fields[2] == want and (best is None or len(fields[4]) > len(best[0])):
                best = (fields[4], b.split()[0])
    return best[1] if best else None

def abs_canonical(p, what):
    if not isinstance(p, str) or not os.path.isabs(p) or os.path.realpath(p) != os.path.normpath(p) or os.path.normpath(p) != p:
        raise Refused(f'{what} must be an absolute, normalized path with no symlinked component: {p!r}')
    return p

def read_bytes(p):
    with open(p, 'rb') as f:
        return f.read()

def read_text(p):
    return read_bytes(p).decode()

def read_exact(fd, buf, off, n):
    """read n bytes at off into buf (a memoryview); -> bytes read (short only at EOF)"""
    got = 0
    while got < n:
        r = os.preadv(fd, [buf[got:n]], off + got)
        if r == 0:
            break
        got += r
    return got

def stat_key(st):
    return {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'ctime_ns': st.st_ctime_ns,
            'nlink': st.st_nlink, 'mode': st.st_mode}

def write_json_atomic(path, obj):
    d, base = os.path.split(path)
    tmp = os.path.join(d, f'.{base}.{os.getpid()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        os.write(fd, (json.dumps(obj, indent=1) + '\n').encode()); os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)

def hash_file(dfd, name, size, progress):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    try:
        h, buf, off = hashlib.sha256(), bytearray(CHUNK), 0
        mv = memoryview(buf)
        while off < size:
            n = read_exact(fd, mv, off, min(CHUNK, size - off))
            if n == 0:
                raise Refused(f'the copy is shorter than the source ({off} of {size} bytes)')
            h.update(mv[:n]); off += n
            if off % SYNC_EVERY < CHUNK:
                os.posix_fadvise(fd, 0, off, os.POSIX_FADV_DONTNEED)
            progress('verify', off)
        if os.pread(fd, 1, size):                       # pread: the reads above never moved the file offset
            raise Refused('the copy is longer than the source')
        return h.hexdigest()
    finally:
        os.close(fd)

def run(plan_path):
    t0 = time.time()
    with open(plan_path) as f:
        plan = json.load(f)
    if plan.get('format') != FORMAT:
        raise Refused(f'plan format must be {FORMAT}')
    src = plan.get('source') if isinstance(plan.get('source'), dict) else {}; tgt = plan.get('target') if isinstance(plan.get('target'), dict) else {}
    progress_path = abs_canonical(plan.get('progressPath'), 'progressPath'); receipt_path = abs_canonical(plan.get('receiptPath'), 'receiptPath')
    for p in (progress_path, receipt_path):
        if os.path.lexists(p):
            raise Refused(f'{p} exists: every run gets fresh progress/receipt paths')
    name = tgt.get('name'); reserve = plan.get('reserveBytes', MIN_RESERVE); unit = plan.get('unit'); tdir = tgt.get('dir')
    partial = f'.{name}.partial' if isinstance(name, str) else None
    rec = {'format': 'enclave-nvme-copy-receipt/v1', 'host': socket.gethostname(), 'helperSha256': hashlib.sha256(read_bytes(__file__)).hexdigest(),
           'plan': {'source': src, 'target': {'dir': tdir, 'name': name}, 'unit': unit, 'reserveBytes': reserve}, 'started': time.strftime('%FT%TZ', time.gmtime(t0)),
           'status': 'refused', 'events': []}
    last = [0.0]
    def progress(phase, done, force=False):
        now = time.time()
        if force or now - last[0] >= PROGRESS_EVERY:
            last[0] = now
            write_json_atomic(progress_path, {'phase': phase, 'bytesDone': done, 'bytesTotal': src['size'], 'elapsedSec': round(now - t0, 1),
                                              'rateMiBps': round(done / max(now - t0, 1e-6) / 2**20, 1), 'at': time.strftime('%FT%TZ', time.gmtime(now))})
    sfd = dfd = pfd = None; partial_made = False
    try:
        # 1. the plan's own fields
        spath = abs_canonical(src.get('path'), 'source.path')
        tdir = abs_canonical(tgt.get('dir'), 'target.dir')
        if not isinstance(name, str) or not name or '/' in name or name.startswith('.') or name in ('.', '..'):
            raise Refused('target.name must be a plain file name (no "/", not hidden)')
        for k in ('dev', 'ino', 'size'):
            if not isinstance(src.get(k), int) or src[k] < 0:
                raise Refused(f'source.{k} must be the exact non-negative integer from stat')
        if not isinstance(reserve, int) or reserve < MIN_RESERVE:
            raise Refused(f'reserveBytes must be an integer >= {MIN_RESERVE}')
        if not isinstance(unit, str) or not unit.endswith('.service'):
            raise Refused('unit must be the VM service unit name (*.service)')
        systemctl = abs_canonical(plan.get('systemctl', '/usr/bin/systemctl'), 'systemctl')
        partial = f'.{name}.partial'
        # 2. the source: exact file, read-only
        lst = os.lstat(spath)
        if not stat.S_ISREG(lst.st_mode):
            raise Refused('source is not a regular file (symlinks are refused)')
        if lst.st_nlink != 1:
            raise Refused(f'source has {lst.st_nlink} hard links (expected exactly 1)')
        if (lst.st_dev, lst.st_ino, lst.st_size) != (src['dev'], src['ino'], src['size']):
            raise Refused(f'source is not the planned file: dev/ino/size {(lst.st_dev, lst.st_ino, lst.st_size)} != plan {(src["dev"], src["ino"], src["size"])}')
        sfd = os.open(spath, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        before = stat_key(os.fstat(sfd))
        if (before['dev'], before['ino']) != (lst.st_dev, lst.st_ino):
            raise Refused('source changed between lstat and open')
        rec['sourceBefore'] = before
        # 3. unit stopped, 4. no opener / no QEMU lock, then the shared lock
        rec['unitBefore'] = unit_state(systemctl, unit)
        holder = lock_holder(sfd)
        if holder:
            raise Refused(f'another process holds a lock on the QEMU lock bytes: {holder}')
        openers, unreadable = other_openers(before['dev'], before['ino'])
        if openers:
            raise Refused(f'the source is open in other processes: {openers}')
        real_root = os.geteuid() == 0 and read_text('/proc/self/uid_map').split() == ['0', '0', '4294967295']
        if unreadable and (real_root or plan.get('allowIncompleteProcScan') is not True):
            raise Refused(f'{unreadable} /proc fd tables were unreadable (real root: {real_root}): cannot prove no other opener')
        take_shared_lock(sfd)
        rec['lock'] = {'kind': 'OFD shared read lock (F_OFD_SETLK, O_RDONLY fd)', 'bytes': [QEMU_LOCK_START, QEMU_LOCK_START + QEMU_LOCK_LEN - 1]}
        rec['unitAfterLock'] = unit_state(systemctl, unit)
        openers, _ = other_openers(before['dev'], before['ino'])
        if openers:
            raise Refused(f'the source is open in other processes (after the lock): {openers}')
        rec['procScan'] = {'unreadableEntries': unreadable, 'realRoot': real_root, 'allowIncompleteProcScan': plan.get('allowIncompleteProcScan') is True}
        # 5. target
        tl = os.lstat(tdir)
        if not stat.S_ISDIR(tl.st_mode):
            raise Refused('target.dir is not a directory (symlinks are refused)')
        fstype = fs_type(tdir)
        if fstype is None or fstype in RAM_FS:
            raise Refused(f'target filesystem {fstype!r} is not a disk filesystem')
        dfd = os.open(tdir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        for n in (name, partial, partial + '.FAILED.json'):
            try:
                os.lstat(n, dir_fd=dfd); raise Refused(f'{os.path.join(tdir, n)} exists: never overwritten, never resumed')
            except FileNotFoundError:
                pass
        vs = os.statvfs(dfd)
        free = vs.f_bavail * vs.f_frsize
        rec['target'] = {'fsType': fstype, 'freeBefore': free, 'need': src['size'] + reserve}
        if free < src['size'] + reserve:
            raise Refused(f'target free {free} B < source {src["size"]} B + reserve {reserve} B')
        # 6. copy
        pfd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        partial_made = True
        os.posix_fadvise(sfd, 0, 0, os.POSIX_FADV_SEQUENTIAL)
        h, buf, off, zero_chunks, written = hashlib.sha256(), bytearray(CHUNK), 0, 0, 0
        mv = memoryview(buf); size = src['size']; tc = time.time(); fsyncs = []
        progress('copy', 0, force=True)
        while off < size:
            want = min(CHUNK, size - off)
            space = os.statvfs(dfd)
            if space.f_bavail * space.f_frsize < reserve + want:
                raise Refused('target free space fell below reserve during copy; source unchanged')
            n = read_exact(sfd, mv, off, want)
            if n != want:
                raise Refused(f'source shorter than planned at {off} (read {n} of {want})')
            chunk = mv[:n]
            h.update(chunk)
            if chunk == ZERO[:n]:
                zero_chunks += 1                                # a hole: not written
            else:
                w = 0
                while w < n:
                    w += os.pwrite(pfd, chunk[w:], off + w)
                written += n
            off += n
            if off % SYNC_EVERY < CHUNK and off < size:
                ts = time.time(); os.fdatasync(pfd); fsyncs.append(round(time.time() - ts, 3))
                os.posix_fadvise(pfd, 0, off, os.POSIX_FADV_DONTNEED); os.posix_fadvise(sfd, 0, off, os.POSIX_FADV_DONTNEED)
            progress('copy', off)
        os.ftruncate(pfd, size)                                 # the exact length (trailing holes); never shorter than the source
        ts = time.time(); os.fsync(pfd); final_fsync = round(time.time() - ts, 3)
        os.close(pfd); pfd = None
        src_sha = h.hexdigest(); copy_sec = round(time.time() - tc, 1)
        # 7. source re-check (still locked)
        after_f, after_l = stat_key(os.fstat(sfd)), stat_key(os.lstat(spath))
        if after_f != before or after_l != before:
            raise Refused(f'the source changed during the copy: before {before} after fstat {after_f} lstat {after_l}')
        rec['unitAfterCopy'] = unit_state(systemctl, unit)
        # re-read the copy
        tv = time.time()
        dst_sha = hash_file(dfd, partial, size, progress)
        verify_sec = round(time.time() - tv, 1)
        if dst_sha != src_sha:
            raise Refused(f'the re-read copy hash {dst_sha} != the source hash {src_sha}')
        pst = os.lstat(partial, dir_fd=dfd)
        if pst.st_size != size or not stat.S_ISREG(pst.st_mode) or pst.st_nlink != 1:
            raise Refused('the partial is not a single regular file of the source size')
        if stat_key(os.lstat(spath)) != before:
            raise Refused('the source changed during verification')
        # 8. publish (no replace), then the directory entry is durable
        os.link(partial, name, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
        os.unlink(partial, dir_fd=dfd)
        ts = time.time(); os.fsync(dfd); dir_fsync = round(time.time() - ts, 3)
        fst = os.lstat(name, dir_fd=dfd)
        rec.update({'status': 'ok', 'final': os.path.join(tdir, name), 'sourceSha256': src_sha, 'copySha256': dst_sha, 'bytes': size,
                    'bytesWritten': written, 'zeroChunksSkipped': zero_chunks, 'chunkBytes': CHUNK, 'allocatedBytes': fst.st_blocks * 512,
                    'copySec': copy_sec, 'verifySec': verify_sec, 'periodicFdatasyncSec': fsyncs, 'finalFsyncSec': final_fsync,
                    'dirFsyncSec': dir_fsync, 'finalInode': fst.st_ino, 'finalMode': oct(fst.st_mode & 0o7777),
                    'sourceAfter': after_l})
        progress('done', size, force=True)
        return 0
    except BaseException as e:
        rec['error'] = f'{type(e).__name__}: {e}'
        if partial_made:
            rec['status'] = 'failed'
            rec['partial'] = os.path.join(tdir, partial) + ' (KEPT, INVALID: never resumed; remove by hand)'
            try:
                mfd = os.open(partial + '.FAILED.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
                os.write(mfd, (json.dumps({'invalidPartial': partial, 'error': rec['error'], 'at': time.strftime('%FT%TZ', time.gmtime())}) + '\n').encode())
                os.fsync(mfd); os.close(mfd); os.fsync(dfd)
            except Exception as me:
                rec['markerError'] = str(me)
        if not isinstance(e, Refused) and not isinstance(e, Exception):
            raise
        return 2 if isinstance(e, Refused) else 3
    finally:
        rec['finished'] = time.strftime('%FT%TZ', time.gmtime()); rec['totalSec'] = round(time.time() - t0, 1)
        if pfd is not None:
            os.close(pfd)
        if sfd is not None:
            os.close(sfd)                                         # releases the OFD lock
        if dfd is not None:
            os.close(dfd)
        try:
            write_json_atomic(receipt_path, rec)
        except Exception as e:
            print(f'receipt not written: {e}', file=sys.stderr)
        print(json.dumps({k: rec.get(k) for k in ('status', 'error', 'final', 'partial', 'sourceSha256', 'copySha256', 'bytes', 'copySec', 'verifySec')}))

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    try:
        sys.exit(run(sys.argv[1]))
    except Refused as e:                      # an unusable plan before any receipt path is known: nothing was opened
        print(json.dumps({'status': 'refused', 'error': f'Refused: {e}', 'receipt': None})); sys.exit(2)
