#!/usr/bin/python3
"""Read-only descriptor inventory. Fixed /proc, <=3 exact file identities, no paths.

Root-owned installation and invocation are separate, currently unqualified steps.
Completeness means every enumerated process was inspected or observed to exit;
it is not an atomic reservation or protection against arbitrary privileged writes.
"""
import argparse
import json
import os
import re
import stat
import time

MAX_PROCESSES = 32768
MAX_FDS = 262144
MAX_ERRORS = 256
MAX_MATCHES = 1024
MAX_SECONDS = 20


class Incomplete(Exception):
    pass


def read_at(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
    try:
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise Incomplete('metadata_length')
        return data
    finally:
        os.close(fd)


def identity(proc_fd, expected_pid):
    data = read_at(proc_fd, 'stat', 8192)
    # comm may contain whitespace/parentheses; only PID and start-time are used.
    if int(data.split(b'(', 1)[0]) != expected_pid:
        raise Incomplete('pid_identity')
    fields = data.rsplit(b')', 1)[1].split()
    return int(fields[19])


def scan(targets, nonce, *, require_root=True):
    if require_root:
        if os.geteuid() != 0:
            raise Incomplete('host_root_required')
        if os.stat('/proc/self/ns/user').st_ino != os.stat('/proc/1/ns/user').st_ino:
            raise Incomplete('user_namespace_mismatch')
        # No arbitrary user-writable helper may claim trusted privileged provenance.
        helper = os.path.abspath(__file__)
        s = os.lstat(helper)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Incomplete('root_owned_helper_required')
        parent = os.path.dirname(helper)
        while True:
            s = os.lstat(parent)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
                raise Incomplete('root_owned_helper_ancestry_required')
            if parent == '/':
                break
            parent = os.path.dirname(parent)
    started = time.monotonic()
    result = {'schema': 'enclave-descriptor-observer/1', 'nonce': nonce,
              'targets': [{'device': d, 'inode': i} for d, i in sorted(targets)],
              'complete': False, 'matches': [], 'errors': [], 'exited': 0,
              'processes': 0, 'descriptors': 0, 'uid': os.geteuid(),
              'startedAt': time.time(), 'scope': 'enumerated descriptor metadata; not mappings or future access'}

    def bound():
        if time.monotonic() - started > MAX_SECONDS:
            raise Incomplete('deadline')
        if result['descriptors'] > MAX_FDS or len(result['matches']) > MAX_MATCHES or len(result['errors']) >= MAX_ERRORS:
            raise Incomplete('count_limit')

    def error(pid, phase, exc):
        # Never emit exception messages which might include unrelated paths/data.
        result['errors'].append({'pid': pid, 'phase': phase, 'kind': type(exc).__name__,
                                 'errno': getattr(exc, 'errno', None)})
        bound()

    root = os.open('/proc', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        pids = sorted(int(x) for x in os.listdir(root) if x.isdecimal())
        if len(pids) > MAX_PROCESSES:
            raise Incomplete('process_count')
        result['enumerated'] = len(pids)
        for pid in pids:
            bound()
            proc_fd = None
            fd_dir = None
            try:
                proc_fd = os.open(str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=root)
                start = identity(proc_fd, pid)
                fd_dir = os.open('fd', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=proc_fd)
                descriptors = os.listdir(fd_dir)
                result['processes'] += 1
                for name in descriptors:
                    if not name.isdecimal():
                        raise Incomplete('descriptor_name')
                    result['descriptors'] += 1
                    bound()
                    try:
                        # Follow only kernel proc-fd references for metadata; never open target contents.
                        before = os.stat(name, dir_fd=fd_dir)
                        key = (before.st_dev, before.st_ino)
                        if key not in targets:
                            continue
                        info = read_at(proc_fd, 'fdinfo/' + name, 65536)
                        flags = re.search(rb'^flags:\s*([0-7]+)\s*$', info, re.M)
                        if flags is None:
                            raise Incomplete('descriptor_flags')
                        after = os.stat(name, dir_fd=fd_dir)
                        if (after.st_dev, after.st_ino) != key or identity(proc_fd, pid) != start:
                            raise Incomplete('descriptor_identity_changed')
                        result['matches'].append({'pid': pid, 'startTicks': start, 'fd': int(name),
                                                  'device': key[0], 'inode': key[1],
                                                  'accessMode': int(flags[1], 8) & os.O_ACCMODE})
                    except FileNotFoundError:
                        # A closed FD has no remaining descriptor access; this is not a future-access promise.
                        continue
                    except (OSError, ValueError, Incomplete) as exc:
                        error(pid, 'descriptor', exc)
                if identity(proc_fd, pid) != start:
                    raise Incomplete('process_identity_changed')
            except (FileNotFoundError, ProcessLookupError):
                result['exited'] += 1
            except (OSError, ValueError, IndexError, Incomplete) as exc:
                error(pid, 'process', exc)
            finally:
                if fd_dir is not None:
                    os.close(fd_dir)
                if proc_fd is not None:
                    os.close(proc_fd)
        result['complete'] = not result['errors']
    except (OSError, Incomplete) as exc:
        result['errors'].append({'phase': 'scan', 'kind': type(exc).__name__, 'errno': getattr(exc, 'errno', None)})
    finally:
        os.close(root)
    result['finishedAt'] = time.time()
    result['elapsedSeconds'] = time.monotonic() - started
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', action='append', required=True)
    parser.add_argument('--nonce', required=True)
    args = parser.parse_args()
    if not 1 <= len(args.target) <= 3 or not re.fullmatch(r'[a-f0-9]{32}', args.nonce):
        parser.error('one to three numeric identities and a 32-hex nonce required')
    targets = set()
    for value in args.target:
        if not re.fullmatch(r'[0-9]{1,20}:[0-9]{1,20}', value):
            parser.error('target must be device:inode, not a path')
        target = tuple(map(int, value.split(':')))
        if min(target) < 1 or max(target) >= 1 << 64:
            parser.error('identity outside unsigned 64-bit bounds')
        targets.add(target)
    if len(targets) != len(args.target):
        parser.error('duplicate target')
    try:
        result = scan(targets, args.nonce)
    except Incomplete as exc:
        result = {'schema':'enclave-descriptor-observer/1', 'nonce':args.nonce,
                  'complete':False, 'refusal':str(exc)}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['complete'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
