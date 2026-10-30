#!/usr/bin/python3
"""PREPARED, NOT EXECUTED. One isolated-root adoption check; never restart guestd.

Root must supply ROOT-ADMISSION.json binding every delivery hash. Run only through
launch-command.txt. Private guest output never goes to stdout or the journal.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import time

P = Path(__file__).resolve().parent
CAP = 1536 << 20
RSS_CAP = 1408 << 20
FLOOR = 27648 << 20
OUTPUT_CAP = 1 << 20
DISK_CAP = 1 << 30
DEADLINE_SECONDS = 360


class Refused(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Refused(code)


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def read_json(path, limit=1 << 20):
    with open(path, 'rb') as f:
        data = f.read(limit + 1)
    require(len(data) <= limit, 'json-size')
    return json.loads(data)


def exclusive_json(path, value):
    with open(path, 'x', encoding='utf-8') as f:
        os.fchmod(f.fileno(), 0o600)
        json.dump(value, f, sort_keys=True, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def proc(pid):
    try:
        p = Path('/proc') / str(pid)
        fields = (p / 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'startTime': int(fields[19]), 'state': fields[0],
                'exe': str((p / 'exe').resolve(strict=True)),
                'cgroup': (p / 'cgroup').read_text().strip()}
    except FileNotFoundError:
        return None


def same_proc(expected):
    got = proc(expected['pid'])
    return got is not None and all(got[k] == expected[k] for k in ('startTime', 'exe', 'cgroup'))


def host_available():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    raise Refused('host-memory-unreadable')


def events(cg):
    return {k: int(v) for k, v in (line.split() for line in (cg / 'memory.events').read_text().splitlines())}


def unit_members(cg):
    # No descendants may escape this admitted scope; known children never create
    # nested cgroups. Refuse a new subtree instead of silently omitting it.
    require(not any(x.is_dir() for x in cg.iterdir()), 'unexpected-cgroup-subtree')
    return {int(x) for x in (cg / 'cgroup.procs').read_text().split()}


def disk_usage(root):
    total = count = 0
    for here, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            count += 1
            require(count <= 30000, 'disk-entry-limit')
            try:
                s = os.lstat(Path(here) / name)
            except FileNotFoundError:  # compiler atomically replaces cache files
                continue
            require(not stat.S_ISLNK(s.st_mode), 'temporary-symlink')
            total += max(s.st_size, s.st_blocks * 512)
    return total


def verify_pins(doc):
    for row in doc['files']:
        p = Path(row['path'])
        require(str(p.resolve(strict=True)) == row['realpath'], 'input-realpath-drift')
        require(p.stat().st_size == row['bytes'] and digest(p) == row['sha256'], 'input-pin-drift')


def check_parent(path, want):
    for part in [*reversed(path.parents), path]:
        a = part.lstat()
        require(stat.S_ISDIR(a.st_mode) and a.st_uid in (0, 1000) and not a.st_mode & 0o022,
                'private-ancestor')
        for attr in ('system.posix_acl_access', 'system.posix_acl_default'):
            try:
                os.getxattr(part, attr, follow_symlinks=False)
            except OSError as e:
                require(e.errno == errno.ENODATA, 'ancestor-acl-unreadable')
            else:
                raise Refused('ancestor-acl-present')
        b = part.lstat()
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_ctime_ns')
        require(all(getattr(a, k) == getattr(b, k) for k in fields), 'ancestor-observation-race')
    require((b.st_dev, b.st_ino, b.st_uid, stat.S_IMODE(b.st_mode)) ==
            (want['device'], want['inode'], 1000, 0o700), 'private-parent')
    require(b.st_dev != Path('/').stat().st_dev, 'root-filesystem-forbidden')
    v = os.statvfs(path)
    require(v.f_bavail * v.f_frsize >= (300 << 30) + DISK_CAP, 'storage-reserve')


def private_copy(src, dst, expected_sha):
    fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as inp, open(dst, 'xb') as out:
        require(stat.S_ISREG(os.fstat(inp.fileno()).st_mode), 'copy-source-type')
        os.fchmod(out.fileno(), 0o600)
        h = hashlib.sha256()
        while data := inp.read(1 << 20):
            h.update(data)
            out.write(data)
        out.flush()
        os.fsync(out.fileno())
    require(h.hexdigest() == expected_sha and digest(dst) == expected_sha, 'copy-digest')


def main():
    os.umask(0o077)
    require(os.geteuid() == 1000 and os.sched_getaffinity(0) == {1}, 'uid-or-affinity')
    require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd-required')
    plan = read_json(P / 'PLAN.json')
    delivery = read_json(P / 'DELIVERY-PINS.json')
    admission = read_json(P / 'ROOT-ADMISSION.json', 16384)
    require(admission == {'scope': 'isolated-root-same-binary-adoption-check-only',
                         'deliverySha256': digest(P / 'DELIVERY-PINS.json'),
                         'authorized': True}, 'root-admission')
    for name, want in delivery.items():
        require(Path(name).name == name and digest(P / name) == want, 'delivery-pin')
    inputs = read_json(P / 'INPUT-PINS.json')
    verify_pins(inputs)
    tool_inputs = read_json(P / 'TOOL-PINS.json')
    verify_pins(tool_inputs)
    require(all(same_proc(x) for x in inputs['processes']), 'production-identity-drift')
    raw = Path('/proc/194657/cmdline').read_bytes()
    require(hashlib.sha256(raw).hexdigest() == inputs['daemonArgvSha256'], 'daemon-argv-drift')
    args = [x.decode('utf-8', 'strict') for x in raw.split(b'\0') if x]
    require(len(args) == inputs['daemonArgc'] and '-adopt-check' not in args, 'daemon-argv-shape')
    require(args[0] == inputs['processes'][0]['exe'], 'daemon-executable')
    cg_name = Path('/proc/self/cgroup').read_text().strip()
    require(re.fullmatch(r'0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-[A-Za-z0-9-]+\.scope', cg_name), 'scope-required')
    cg = Path('/sys/fs/cgroup' + cg_name[3:])
    require((cg / 'memory.max').read_text().strip() == str(CAP), 'hard-memory-cap')
    require((cg / 'memory.swap.max').read_text().strip() == '0', 'swap-disabled')
    require(host_available() >= FLOOR + CAP, 'initial-host-floor')
    baseline = unit_members(cg)
    require(os.getpid() in baseline, 'scope-membership')
    require(not ({x['pid'] for x in inputs['processes']} & baseline), 'production-in-job-scope')
    before_events = events(cg)
    parent = Path(plan['parent']['path'])
    check_parent(parent, plan['parent'])
    require(not (parent / plan['directory']).exists(), 'work-already-exists')
    require(plan['directory'] == 'guestd-adopt-check-20261030-r1', 'work-name')
    start = time.monotonic()
    exclusive_json(P / 'ATTEMPT.json', {'startedAt': time.time(), 'scope': cg_name,
                   'deliverySha256': digest(P / 'DELIVERY-PINS.json'), 'authorizedAction': admission['scope']})
    root = parent / plan['directory']
    root.mkdir(mode=0o700)
    exclusive_json(P / 'TEMP.json', {'path': str(root), 'scope': 'isolated-adoption-check-only'})
    for name in ('tmp', 'go-cache', 'go-modcache', 'go-tmp', 'gd61126785'):
        (root / name).mkdir(mode=0o700)
    pinmap = {x['path']: x['sha256'] for x in inputs['files']}
    old = Path('/home/steven/enclave-prod/guestd-root/gd61126785')
    for name in ('instance.json', 'app.bundle'):
        private_copy(old / name, root / 'gd61126785' / name, pinmap[str(old / name)])
    record = read_json(root / 'gd61126785/instance.json', 16384)
    require(record['ID'] == 'gd61126785' and record['Unit'] == 'm2-gd61126785-1384596', 'record-identity')
    require(record['Name'] == plan['deployment'], 'deployment-identity')
    for flag, value in (('-root', str(root)), ('-guest-mem-mib', '0'), ('-guest-cpus', '0')):
        require(args.count(flag) == 1, 'duplicate-or-missing-flag')
        args[args.index(flag) + 1] = value
    args.append('-adopt-check')
    # Explicit non-secret environment. HOME remains the user's actual HOME.
    env = {'PATH': plan['path'], 'HOME': os.environ['HOME'], 'LANG': 'C.UTF-8',
           'GUESTD_ENABLE': '1', 'XDG_RUNTIME_DIR': '/run/user/1000',
           'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus',
           'GOCACHE': str(root / 'go-cache'), 'GOMODCACHE': str(root / 'go-modcache'),
           'GOTMPDIR': str(root / 'go-tmp'), 'TMPDIR': str(root / 'tmp'),
           'GOMAXPROCS': '1', 'GOFLAGS': '-p=1', 'GOENV': 'off', 'GOTOOLCHAIN': 'local',
           'GOPROXY': 'off', 'GOSUMDB': 'off', 'PYTHONDONTWRITEBYTECODE': '1',
           'NODE_OPTIONS': '--max-old-space-size=256'}
    require(env['HOME'] == '/home/steven', 'unexpected-home')
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 << 20, 256 << 20))
    owned = {}  # pid -> (start-time, pidfd); pin before any signal, retain until terminal cleanup
    child = None
    sel = selectors.DefaultSelector()
    streams = []
    failure = None
    rc = None
    peak_rss = peak_disk = output_bytes = 0
    min_available = host_available()
    cleanup_done = False

    def discover():
        for pid in unit_members(cg) - baseline:
            got = proc(pid)
            if got is None:
                continue
            require(got['cgroup'] == cg_name, 'child-cgroup')
            require(os.sched_getaffinity(pid) == {1}, 'child-affinity')
            if pid in owned:
                require(owned[pid][0] == got['startTime'], 'child-pid-reused')
                continue
            try:
                fd = os.pidfd_open(pid, 0)
            except ProcessLookupError:
                continue
            after = proc(pid)
            if after is None or after['startTime'] != got['startTime'] or after['cgroup'] != cg_name:
                os.close(fd)
                raise Refused('child-identity-race')
            owned[pid] = (got['startTime'], fd)

    def signal_owned(sig):
        discover()
        for _, fd in owned.values():
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass

    def on_signal(_signum, _frame):
        raise Refused('interrupted')

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        for name in ('stdout', 'stderr'):
            streams.append(open(root / ('guestd.' + name), 'xb', buffering=0))
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=env, cwd=root, start_new_session=True)
        exclusive_json(P / 'PROCESS.json', {'pid': child.pid, 'startTime': proc(child.pid)['startTime'],
                       'exe': args[0], 'scope': cg_name, 'argvSha256': hashlib.sha256(b'\0'.join(x.encode() for x in args) + b'\0').hexdigest()})
        for pipe, target in zip((child.stdout, child.stderr), streams):
            os.set_blocking(pipe.fileno(), False)
            sel.register(pipe, selectors.EVENT_READ, target)
        last_disk = 0.0
        while True:
            discover()
            now = time.monotonic()
            require(now - start <= DEADLINE_SECONDS, 'deadline')
            available = host_available()
            min_available = min(min_available, available)
            require(available >= FLOOR, 'host-floor')
            require(all(same_proc(x) for x in inputs['processes']), 'production-identity-changed')
            rss = 0
            for pid in unit_members(cg):
                try:
                    text = (Path('/proc') / str(pid) / 'status').read_text()
                except FileNotFoundError:
                    continue
                match = re.search(r'^VmRSS:\s+(\d+) kB$', text, re.M)
                rss += int(match[1]) * 1024 if match else 0
            peak_rss = max(peak_rss, rss)
            require(rss <= RSS_CAP, 'rss-cap')
            if now - last_disk >= 1:
                v = os.statvfs(parent)
                require(v.f_bavail * v.f_frsize >= (300 << 30), 'storage-floor')
                used = disk_usage(root)
                peak_disk = max(peak_disk, used)
                require(used <= DISK_CAP, 'disk-cap')
                diagnostic = output_bytes
                for name in ('fwd.log', 'verify.txt', 'doc.json'):
                    f = root / 'gd61126785' / name
                    if f.exists():
                        diagnostic += f.stat().st_size
                require(diagnostic <= OUTPUT_CAP, 'private-output-cap')
                last_disk = now
            for key, _ in sel.select(timeout=0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                output_bytes += len(data)
                require(output_bytes <= OUTPUT_CAP, 'stdout-stderr-cap')
                key.data.write(data)
            rc = child.poll()
            if rc is not None and not sel.get_map():
                break
        require(rc == 0, 'adopt-check-exit')
        text = (root / 'guestd.stderr').read_text(errors='strict')
        require(text.count('ADOPT OK gd61126785') == 1 and 'ADOPT REFUSED' not in text, 'adoption-result')
        # No application payload is copied into the public result.
        verify_text = (root / 'gd61126785/verify.txt').read_text(errors='strict')
        values = dict(re.findall(r'^RESULT ([a-z0-9_]+)=([^\n]*)$', verify_text, re.M))
        require(values.get('gate') == 'open' and values.get('spki_sha256') == record['TransportKeySha256'], 'guest-key-verdict')
        require(values.get('runtime_pinned') == '1' and values.get('host_data_checked') == '1', 'guest-bindings')
        require(values.get('key_stable_in_launch') == '1' and values.get('second_nonce_verdict') == 'attested', 'fresh-guest-proof')
        require(values.get('replay_rejected') == '1', 'replay-proof')
        check_parent(parent, plan['parent'])
        for name in ('instance.json', 'app.bundle'):
            require(digest(root / 'gd61126785' / name) == pinmap[str(old / name)], 'copied-record-changed')
    except Exception as e:
        failure = str(e) if isinstance(e, Refused) else type(e).__name__
    finally:
        # Never signal by a production PID, process name, or unit wildcard.
        # All recipients are pidfds acquired from this unique admitted scope.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            signal_owned(signal.SIGTERM)
            until = time.monotonic() + 5
            while unit_members(cg) - baseline and time.monotonic() < until:
                if child is not None:
                    child.poll()
                discover()
                time.sleep(0.1)
            if unit_members(cg) - baseline:
                signal_owned(signal.SIGKILL)
            if child is not None:
                child.wait(timeout=5)
            until = time.monotonic() + 5
            while unit_members(cg) - baseline and time.monotonic() < until:
                time.sleep(0.1)
            cleanup_done = not (unit_members(cg) - baseline)
        except Exception:
            failure = failure or 'cleanup-failed'
        finally:
            sel.close()
            for f in streams:
                f.close()
            for _, fd in owned.values():
                os.close(fd)
    original_inputs_unchanged = False
    original_inputs_error = None
    tools_unchanged = False
    try:
        verify_pins(inputs)
        original_inputs_unchanged = True
    except Exception as e:
        original_inputs_error = str(e) if isinstance(e, Refused) else type(e).__name__
        failure = failure or 'final-original-input-verification-failed'
    try:
        verify_pins(tool_inputs)
        tools_unchanged = True
    except Exception:
        failure = failure or 'final-tool-verification-failed'
    after_events = events(cg)
    no_oom = all(after_events.get(k, 0) == before_events.get(k, 0) for k in ('oom', 'oom_kill', 'oom_group_kill'))
    unchanged = all(same_proc(x) for x in inputs['processes'])
    ok = (failure is None and rc == 0 and cleanup_done and no_oom and unchanged
          and original_inputs_unchanged and tools_unchanged)
    result = {'status': 'ADOPTION-PREFLIGHT-PASSED' if ok else 'FAILED', 'exit': rc,
              'failure': failure, 'cleanupComplete': cleanup_done, 'noOom': no_oom,
              'productionProcessesUnchanged': unchanged, 'peakScopeRssBytes': peak_rss,
              'originalInputsUnchanged': original_inputs_unchanged,
              'originalInputsError': original_inputs_error, 'toolsUnchanged': tools_unchanged,
              'peakWorkBytesObserved': peak_disk, 'minHostAvailableBytes': min_available,
              'seconds': time.monotonic() - start, 'privateEvidence': str(root),
              'privateOutputSha256': {n: digest(root / ('guestd.' + n)) for n in ('stdout', 'stderr') if (root / ('guestd.' + n)).exists()},
              'restartPerformed': False, 'rpcStarted': False, 'published': False,
              'rootMustCollectSameScopeTerminal': True}
    exclusive_json(P / 'RESULT.json', result)
    print(json.dumps(result, sort_keys=True))
    return 0 if ok else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # No raw subprocess, environment, attestation or application output.
        print(json.dumps({'status': 'REFUSED', 'reason': str(error) if isinstance(error, Refused) else type(error).__name__,
                          'restartPerformed': False, 'rpcStarted': False}))
        sys.exit(2)
