#!/usr/bin/env python3
"""Whole-snapshot Sia restore, run INSIDE its bounded unit (started by whole_restore.py; stdlib only, Python >= 3.8).

    runner.py run ATTEMPT_DIR

Isolation: the restore binary runs in a NEW network namespace whose only interface is loopback. Each pinned Sia host
endpoint of the snapshot (ip:port) is an address on that loopback, served by a listener that relays over an AF_UNIX
socket to this process, which connects to exactly that ip:port and nothing else. Every other destination (the indexer,
Nan, the DigitalOcean fronts, gateways, control services, DNS) has no route inside. That is checked from inside, against
the same endpoints proven reachable from outside, before the restore starts.

Output: ATTEMPT_DIR/result.json (counts, sizes, digests and booleans only). The restore's inventory (names) and data stay
in ATTEMPT_DIR/restored (private). A partial restore is a failure. The key file is passed to the binary by PATH only.
"""
import datetime
import hashlib
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

RESERVE_BYTES = 1 << 30  # free space kept beyond the byte budget
PROBE_TIMEOUT = 3


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_new(path, obj):
    """Write JSON to a path that must not exist (create-new temp, then link: never overwrites)."""
    tmp = '%s.tmp-%s' % (path, os.urandom(6).hex())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(json.dumps(obj, indent=2, sort_keys=True) + '\n')
        f.flush()
        os.fsync(f.fileno())
    try:
        os.link(tmp, path)
    finally:
        os.unlink(tmp)


def relay(a, b):
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], 900)
            if not ready:
                return
            for s in ready:
                data = s.recv(1 << 18)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass
    finally:
        a.close()
        b.close()


def serve(listener, connect, status=False):
    """Relay each accepted connection to connect(). With status (the outside end of the bridge), first tell the inside
    end in one byte whether the real ip:port answered, so the inside never mistakes its own listener for the host."""
    def loop():
        while True:
            try:
                a, _ = listener.accept()
            except OSError:
                return

            def one(a=a):
                try:
                    b = connect()
                except OSError:
                    if status:
                        try:
                            a.sendall(b'\0')
                        except OSError:
                            pass
                    a.close()
                    return
                try:
                    if status:
                        a.sendall(b'\1')
                except OSError:
                    a.close()
                    b.close()
                    return
                relay(a, b)
            threading.Thread(target=one, daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()


def dial(ip, port):
    s = socket.create_connection((ip, port), 15)
    s.settimeout(None)  # the relay waits in select(); a send must not time out mid-transfer
    return s


def bridged(path):
    """Inside: a connection through the bridge; raises unless the bridge reports the real host answered."""
    s = socket.socket(socket.AF_UNIX)
    try:
        s.settimeout(30)
        s.connect(path)
        if s.recv(1) != b'\1':
            raise ConnectionRefusedError('the host did not answer the bridge')
        s.settimeout(None)
        return s
    except OSError:
        s.close()
        raise


def try_connect(host, port):
    try:
        socket.create_connection((host, port), PROBE_TIMEOUT).close()
        return None
    except OSError as e:
        return type(e).__name__


def check_plan(plan):
    allowed = {(e['ip'], e['port']) for e in plan['endpoints']}
    blocked = {(e['ip'], e['port']) for e in plan['blocked']}
    allowed_ips = {e['ip'] for e in plan['endpoints']}
    if not allowed:
        raise SystemExit('plan has no Sia host endpoints')
    if allowed & blocked or allowed_ips & {e['ip'] for e in plan['blocked']}:
        raise SystemExit('plan allows a blocked address')
    if not any(e.get('outsideMustConnect') for e in plan['blocked']):
        raise SystemExit('plan has no outside-reachable control endpoint (the indexer)')


def child(attempt, sockdir):
    """Inside the new network namespace: loopback listeners, probes, then the restore. -> exit code."""
    plan = json.load(open(os.path.join(attempt, 'plan.json')))
    subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
    for ip in sorted({e['ip'] for e in plan['endpoints']}):
        if not ip.startswith('127.'):  # already on loopback (test fixtures only; prepare admits global addresses)
            subprocess.run(['ip', 'address', 'add', ip + '/32', 'dev', 'lo'], check=True)
    for i, e in enumerate(plan['endpoints']):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((e['ip'], e['port']))
        listener.listen(128)

        serve(listener, lambda path=os.path.join(sockdir, str(i)): bridged(path))
    probes = {'at': now(), 'blocked': [], 'names': [], 'allowedReached': 0, 'allowedTried': 0}
    for e in plan['blocked']:
        err = try_connect(e['ip'], e['port'])
        probes['blocked'].append({'label': e['label'], 'ip': e['ip'], 'port': e['port'], 'blocked': err is not None, 'error': err})
    for n in plan.get('blockedNames', []):
        try:
            socket.getaddrinfo(n['name'], n['port'], socket.AF_INET, socket.SOCK_STREAM)
            resolved = True
        except OSError:
            resolved = False
        probes['names'].append({'label': n['label'], 'name': n['name'], 'resolved': resolved})
    for i in range(min(8, len(plan['endpoints']))):  # positive control: real hosts answer through the bridge
        probes['allowedTried'] += 1
        try:
            bridged(os.path.join(sockdir, str(i))).close()
            probes['allowedReached'] += 1
        except OSError:
            pass
        if probes['allowedReached'] >= 2:
            break
    probes['isolated'] = all(p['blocked'] for p in probes['blocked']) and not any(p['resolved'] for p in probes['names'])
    write_new(os.path.join(attempt, 'probes.json'), probes)
    if not probes['isolated']:
        return 91
    if probes['allowedReached'] == 0:
        return 92
    # the pins, again, immediately before the binary runs
    if sha256_file(plan['binary']) != plan['binarySha256'] or sha256_file(plan['snapshot']) != plan['snapshotSha256']:
        return 93
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'SIA_RECOVERY_KEY_FILE': plan['keyFile']}
    argv = [plan['binary'], 'recovery', 'restore', plan['snapshot'], plan['snapshotSha256'], plan['outdir'],
            str(plan['maxTotalBytes']), str(plan['deadlineSecs'])]
    with open(os.path.join(attempt, 'restore.stdout'), 'xb') as out, open(os.path.join(attempt, 'restore.stderr'), 'xb') as err:
        try:
            return subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  timeout=plan['deadlineSecs'] + 120).returncode
        except subprocess.TimeoutExpired:
            return 94


def verify_output(outdir):
    """The restore's own inventory, cross-checked against the bytes on disk. -> (summary, ok)"""
    inv_path = os.path.join(outdir, 'inventory.json')
    raw = open(inv_path, 'rb').read()
    inv = json.loads(raw)
    files = inv.get('files', [])
    checks, independent, on_disk, bad = {}, {}, 0, 0
    lines = []
    for f in files:
        checks[f.get('etagCheck')] = checks.get(f.get('etagCheck'), 0) + 1
        independent[f.get('independentSha256')] = independent.get(f.get('independentSha256'), 0) + 1
        path = os.path.join(outdir, f['file'])
        name = f['file']
        if not (name.startswith('objects/') and name[8:-4].isdigit() and name.endswith('.bin')) or os.path.islink(path):
            bad += 1
            continue
        size = os.path.getsize(path)
        digest = sha256_file(path)
        on_disk += size
        if size != f['bytes'] or digest != f['outputSha256']:
            bad += 1
        lines.append('%s %d %s\n' % (name, size, digest))
    present = sorted(n for n in os.listdir(os.path.join(outdir, 'objects')))
    s = {
        'complete': inv.get('complete') is True,
        'keys': inv.get('keys'), 'restored': inv.get('restored'),
        'failed': len(inv.get('failed', [])), 'notAttempted': len(inv.get('notAttempted', [])),
        'expectedButAbsent': len(inv.get('expectedButAbsent', [])),
        'restoredBytes': inv.get('restoredBytes'), 'totalBytes': inv.get('totalBytes'),
        'etagChecks': checks, 'independentSha256': independent,
        'inventorySha256': hashlib.sha256(raw).hexdigest(),
        'filesDigest': hashlib.sha256(''.join(sorted(lines)).encode()).hexdigest(),
        'onDiskFiles': len(present), 'onDiskBytes': on_disk, 'onDiskMismatches': bad,
        'indexerUsed': inv.get('indexerUsed'), 'writesToSia': inv.get('writesToSia'),
    }
    ok = (s['complete'] and s['failed'] == 0 and s['notAttempted'] == 0 and s['expectedButAbsent'] == 0
          and s['keys'] == s['restored'] == len(files) == len(present) and bad == 0
          and s['restoredBytes'] == s['totalBytes'] == on_disk and s['indexerUsed'] is False and s['writesToSia'] is False)
    return s, ok


def memory_peak():
    """This unit's cgroup memory.peak (cgroup v2), or None."""
    try:
        rel = [l.split(':', 2)[2] for l in open('/proc/self/cgroup').read().splitlines() if l.startswith('0::')][0].strip()
        return int(open('/sys/fs/cgroup' + rel + '/memory.peak').read())
    except (OSError, IndexError, ValueError):
        return None


def run(attempt):
    attempt = os.path.abspath(attempt)
    plan = json.load(open(os.path.join(attempt, 'plan.json')))
    write_new(os.path.join(attempt, 'started.json'), {'at': now(), 'invocationId': os.environ.get('INVOCATION_ID'), 'pid': os.getpid()})
    result = {'format': 'sia-whole-restore-result/v1', 'startedAt': now(), 'success': False,
              'binarySha256': plan['binarySha256'], 'snapshotSha256': plan['snapshotSha256'],
              'originalSnapshotSha256': plan['originalSnapshotSha256'], 'maxTotalBytes': plan['maxTotalBytes'],
              'deadlineSecs': plan['deadlineSecs'], 'allowedEndpoints': len(plan['endpoints'])}
    sockdir = None
    try:
        check_plan(plan)
        st = os.statvfs(attempt)
        result['freeBytesBefore'] = st.f_bavail * st.f_frsize
        if result['freeBytesBefore'] < plan['maxTotalBytes'] + RESERVE_BYTES:
            raise SystemExit('not enough free space for the byte budget plus %d reserve' % RESERVE_BYTES)
        sockdir = tempfile.mkdtemp(prefix='swr-', dir='/tmp')  # short paths: AF_UNIX names are limited to 107 bytes
        listeners = []
        for i, e in enumerate(plan['endpoints']):
            path = os.path.join(sockdir, str(i))
            assert len(path) < 100
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(path)
            listener.listen(128)
            listeners.append(listener)
            serve(listener, lambda e=e: dial(e['ip'], e['port']), status=True)
        userns = [] if os.geteuid() == 0 else ['--user', '--map-root-user']
        code = subprocess.run(['unshare', '--net'] + userns + [sys.executable, '-I', os.path.abspath(__file__), 'child', attempt, sockdir],
                              stdin=subprocess.DEVNULL).returncode
        result['restoreExit'] = code
        try:
            probes = json.load(open(os.path.join(attempt, 'probes.json')))
            result['probes'] = {'blocked': sum(p['blocked'] for p in probes['blocked']), 'blockedTried': len(probes['blocked']),
                                'namesResolved': sum(p['resolved'] for p in probes['names']), 'namesTried': len(probes['names']),
                                'allowedReached': probes['allowedReached'], 'allowedTried': probes['allowedTried'],
                                'isolated': probes['isolated']}
        except (OSError, ValueError):
            result['probes'] = None
        if code in (91, 92, 93, 94):
            result['error'] = {91: 'a blocked destination was reachable inside the namespace',
                               92: 'no Sia host endpoint was reachable through the bridge',
                               93: 'binary or snapshot pin mismatch immediately before the restore',
                               94: 'the restore exceeded its deadline plus grace'}[code]
        if os.path.exists(os.path.join(plan['outdir'], 'inventory.json')):
            summary, ok = verify_output(plan['outdir'])
            result['restore'] = summary
            result['success'] = code == 0 and ok and bool(result['probes'] and result['probes']['isolated'])
        result['originalSnapshotUnchanged'] = (not plan.get('originalSnapshot')) or not os.path.exists(plan['originalSnapshot']) or \
            sha256_file(plan['originalSnapshot']) == plan['originalSnapshotSha256']
        result['success'] = result['success'] and result['originalSnapshotUnchanged']
    except SystemExit as e:
        result['error'] = str(e)
    except Exception as e:  # noqa: BLE001 - report every harness failure as a failed result, never as success
        result['error'] = '%s: %s' % (type(e).__name__, e)
    finally:
        if sockdir:
            shutil.rmtree(sockdir, ignore_errors=True)
        result['memoryPeakBytes'] = memory_peak()
        result['completedAt'] = now()
        write_new(os.path.join(attempt, 'result.json'), result)
    return 0 if result['success'] else 1


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'child':
        sys.exit(child(sys.argv[2], sys.argv[3]))
    if len(sys.argv) == 3 and sys.argv[1] == 'run':
        sys.exit(run(sys.argv[2]))
    sys.exit('usage: runner.py run ATTEMPT_DIR')
