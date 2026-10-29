"""SOURCE ONLY, no CLI. Post-death private readback; never sends/stops/restarts.

Caller must provide independently verified sole-writer, quarantine and trace
context. This function cannot establish source or financial coverage itself.
"""
import hashlib
import json
import os
from pathlib import Path
import stat

CAP = 8 * 1024 * 1024


def same_stat(a, b):
    return (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (
        b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns, b.st_ctime_ns)


def verify_dead(pid, cgroup):
    if not isinstance(pid, int) or pid < 2 or Path(f'/proc/{pid}').exists():
        raise RuntimeError('original-pid-not-absent')
    cg = Path(cgroup)
    if not str(cg).startswith('/sys/fs/cgroup/system.slice/') or '..' in cg.parts:
        raise RuntimeError('unexpected-cgroup')
    if cg.exists():
        for root, dirs, files in os.walk(cg, followlinks=False):
            if any((Path(root)/d).is_symlink() for d in dirs):
                raise RuntimeError('unexpected-cgroup-symlink')
            if 'cgroup.procs' in files and (Path(root)/'cgroup.procs').read_text().strip():
                raise RuntimeError('writer-cgroup-not-empty')


def preserve(journal, output_directory, *, writer_pid, cgroup,
             expected_directory_device, expected_directory_inode,
             expected_observed_bytes):
    """Fresh private output directory required; partial failure is never retried.
    No raw financial values are returned. Output body remains private0600/0400.
    """
    verify_dead(writer_pid, cgroup)
    source = Path(journal)
    if not source.is_absolute() or source.name != 'sessions-relayer.json':
        raise RuntimeError('unexpected-journal-path')
    if not isinstance(expected_observed_bytes, int) or not 0 < expected_observed_bytes <= CAP:
        raise RuntimeError('invalid-observed-size')
    parent = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        directory = os.fstat(parent)
        if (directory.st_dev, directory.st_ino) != (expected_directory_device, expected_directory_inode):
            raise RuntimeError('journal-directory-identity-changed')
        fd = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise RuntimeError('journal-not-exclusive-regular-file')
        if before.st_size != expected_observed_bytes or before.st_mode & 0o007:
            raise RuntimeError('journal-size-or-world-permission-mismatch')
        chunks, count = [], 0
        while True:
            b = os.read(fd, min(65536, CAP + 1 - count))
            if not b:
                break
            chunks.append(b); count += len(b)
            if count > CAP:
                raise RuntimeError('journal-byte-bound')
        body = b''.join(chunks)
        after = os.fstat(fd)
        at_name = os.stat(source.name, dir_fd=parent, follow_symlinks=False)
        if count != before.st_size or not same_stat(before, after) or not same_stat(after, at_name):
            raise RuntimeError('journal-changed-during-readback')
        doc = json.loads(body)
        if not isinstance(doc, dict) or not isinstance(doc.get('txs'), list) or len(doc['txs']) > 500:
            raise RuntimeError('unexpected-journal-schema')
        if any(not isinstance(r, dict) for r in doc['txs']):
            raise RuntimeError('unexpected-journal-record')
        os.fsync(fd); os.fsync(parent)
        verify_dead(writer_pid, cgroup)
        if not same_stat(after, os.stat(source.name, dir_fd=parent, follow_symlinks=False)):
            raise RuntimeError('journal-changed-after-fsync')
        out = Path(output_directory)
        if not out.is_absolute() or not out.parent.is_dir():
            raise RuntimeError('private-output-parent-required')
        out.mkdir(mode=0o700)  # exclusive; never overwrite an existing operation
        summary = {'device': before.st_dev, 'inode': before.st_ino, 'bytes': count,
                   'sha256': hashlib.sha256(body).hexdigest(), 'records': len(doc['txs']),
                   'fileAndParentFsynced': True, 'writerPidAbsent': True,
                   'cgroupEmpty': True, 'financialOutcome': 'UNKNOWN',
                   'productionAcceptance': False, 'writeResumptionAllowed': False}
        for name, data in [('journal.private.json', body),
                           ('manifest.json', (json.dumps(summary, indent=2)+'\n').encode())]:
            ofd = os.open(out/name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                view = memoryview(data)
                while view:
                    n = os.write(ofd, view)
                    if n <= 0:
                        raise RuntimeError('private-checkpoint-write-failed')
                    view = view[n:]
                os.fchmod(ofd, 0o400); os.fsync(ofd)
            finally:
                os.close(ofd)
        for folder in (out, out.parent):
            dfd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        return summary
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)
