#!/usr/bin/env python3
"""SOURCE ONLY. Not executed. Attach ONLY to this harness's synthetic child.

No --pid argument exists. Requires a fresh network namespace, binary pins,
explicit fixture opt-in, and separately approved shared-queue admission.
Produces raw metadata for MANUAL review, never a production coverage verdict.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import tempfile
import time

FIXTURE_SHA = '2f8853effef7a19674297f2acd83dd36d67b6fa9b80443502a31f5f61c632963'
CANARY = b'SYNTHETIC_BUFFER_CANARY_NOT_A_SECRET_7f86'
MODES = ['clean', 'swallowed-flush-failure', 'write-after-rename',
         'wrong-target', 'timer-rename-before-signal']
STRACE = Path('/usr/bin/strace')
NODE = Path('/usr/bin/node')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
       'TZ': 'UTC', 'ENCLAVE_CHECKPOINT_OWNED_FIXTURE': '1', 'UV_THREADPOOL_SIZE': '2'}
TRACE_CAP = 16 * 1024 * 1024
LOG_CAP = 64 * 1024


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def status(pid):
    p = Path(f'/proc/{pid}')
    try:
        fields = dict(line.split(':', 1) for line in (p/'status').read_text().splitlines() if ':' in line)
        stat = (p/'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': int(pid), 'startTicks': stat[19], 'state': fields['State'].strip()[0],
                'tracerPid': int(fields['TracerPid']),
                'rssKiB': int(fields.get('VmRSS', '0 kB').split()[0])}
    except FileNotFoundError:
        return None


def tasks(pid):
    try:
        result = [status(int(p.name)) for p in Path(f'/proc/{pid}/task').iterdir()]
        return sorted((x for x in result if x is not None), key=lambda x: x['pid'])
    except FileNotFoundError:
        return []


def no_children(pid):
    for t in Path(f'/proc/{pid}/task').glob('*'):
        try:
            if (t/'children').read_text().strip():
                return False
        except FileNotFoundError:
            continue
    return True


def file_limit(cap):
    parent = os.getpid()
    def apply():
        # Owned children must not remain group-stopped if this harness dies.
        # This is ONLY applied to our newly forked fixture/tracer, never targets.
        if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            os._exit(125)
        if os.getppid() != parent:
            os._exit(125)
        resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--execute-owned-fixture', action='store_true')
    p.add_argument('--output-root', type=Path, required=True)
    p.add_argument('--mode', choices=MODES, required=True)
    p.add_argument('--expected-strace-sha', required=True)
    p.add_argument('--expected-node-sha', required=True)
    p.add_argument('--expected-unit', required=True)
    p.add_argument('--min-available-mib', type=int, required=True)
    a = p.parse_args()
    if not a.execute_owned_fixture or os.geteuid() != 0:
        raise RuntimeError('explicit-owned-fixture-opt-in-and-root-required')
    if a.min_available_mib < 512:
        raise RuntimeError('reviewed-memory-floor-required')
    if not re.fullmatch(r'enclave-checkpoint-fixture-[a-z0-9-]+\.service', a.expected_unit):
        raise RuntimeError('dedicated-owned-fixture-unit-required')
    cg_name = '/system.slice/' + a.expected_unit
    if Path('/proc/self/cgroup').read_text().strip() != '0::' + cg_name:
        raise RuntimeError('unexpected-fixture-cgroup')
    cg = Path('/sys/fs/cgroup') / cg_name.lstrip('/')
    if (not (0 < int((cg/'memory.max').read_text()) <= 192*1024*1024)
            or int((cg/'memory.swap.max').read_text()) != 0
            or not (0 < int((cg/'pids.max').read_text()) <= 64)):
        raise RuntimeError('owned-cgroup-bounds-required')
    if os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise RuntimeError('fresh-unshared-network-namespace-required')
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('pidfd-support-required')
    fixture = Path(__file__).resolve().with_name('owned_fixture.mjs')
    if sha(fixture) != FIXTURE_SHA:
        raise RuntimeError('fixture-source-pin-mismatch')
    for exe, pin in [(STRACE, a.expected_strace_sha), (NODE, a.expected_node_sha)]:
        if not re.fullmatch('[0-9a-f]{64}', pin) or sha(exe) != pin:
            raise RuntimeError('binary-pin-mismatch')
    out = a.output_root.resolve(strict=True)
    if not any(str(out).startswith(prefix) for prefix in
               ('/var/tmp/enclave-checkpoint-fixture-', '/tmp/enclave-checkpoint-fixture-')):
        raise RuntimeError('dedicated-temporary-fixture-output-root-required')
    if not out.is_dir() or out.stat().st_uid != 0 or out.stat().st_mode & 0o077:
        raise RuntimeError('existing-private-root-owned-output-directory-required')
    os.umask(0o077)
    run = Path(tempfile.mkdtemp(prefix='owned-checkpoint-', dir=out))
    data = run/'data'; data.mkdir(mode=0o700)
    # Only this new namespace changes; no host interface or production service.
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'dev', 'lo', 'up'],
                   check=True, timeout=3, env=ENV, capture_output=True)
    trace_path = run/'trace.raw'
    log_paths = [run/'fixture.stdout', run/'fixture.stderr', run/'tracer.stderr']
    logs = [x.open('xb', buffering=0) for x in log_paths]
    child = tracer = None
    child_fd = tracer_fd = None
    coverage_started = False
    begin = time.monotonic()
    report = {'mode': a.mode, 'sourceOnlyCandidate': True, 'productionAcceptance': False,
              'binaryPins': {'node': a.expected_node_sha, 'strace': a.expected_strace_sha},
              'fixtureSha256': FIXTURE_SHA, 'rosters': [], 'failures': []}
    seen = {}

    def guard():
        if time.monotonic() - begin > 30:
            raise RuntimeError('owned-fixture-deadline')
        available = next(int(s.split()[1]) for s in Path('/proc/meminfo').read_text().splitlines()
                         if s.startswith('MemAvailable:'))
        if available < a.min_available_mib * 1024:
            raise RuntimeError('remote-memory-floor')
        rss = sum((status(proc.pid) or {}).get('rssKiB', 0)
                  for proc in (child, tracer) if proc is not None)
        rss += (status(os.getpid()) or {}).get('rssKiB', 0)
        if rss > 128 * 1024:
            raise RuntimeError('owned-rss-cap')
        for f, cap in [(trace_path, TRACE_CAP)] + [(x, LOG_CAP) for x in log_paths]:
            if f.exists() and f.stat().st_size >= cap:
                raise RuntimeError('owned-output-cap')
        if child is not None and child.poll() is None:
            if not no_children(child.pid):
                raise RuntimeError('unexpected-fixture-process-child')
            for row in tasks(child.pid):
                old = seen.get(row['pid'])
                if old and old != row['startTicks']:
                    raise RuntimeError('task-identity-reuse')
                seen[row['pid']] = row['startTicks']
                if (coverage_started and row['state'] not in {'Z','X'}
                        and row['tracerPid'] != tracer.pid):
                    raise RuntimeError('live-task-outside-tracer-coverage')
            if coverage_started and tracer.poll() is not None:
                raise RuntimeError('tracer-ended-before-owned-child')

    def wait_for(test, seconds, reason):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            guard()
            if test():
                return
            time.sleep(0.025)
        raise RuntimeError(reason)

    def message(key):
        for line in log_paths[0].read_bytes().splitlines():
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get(key) is True and child is not None and obj.get('pid') == child.pid:
                return True
        return False

    def roster(phase):
        rows = tasks(child.pid)
        report['rosters'].append({'phase': phase, 'elapsedMs': round((time.monotonic()-begin)*1000),
                                  'tasks': rows})
        return rows

    def sig(fd, value):
        signal.pidfd_send_signal(fd, value)

    try:
        def interrupted(signum, frame):
            raise RuntimeError('owned-harness-interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        guard()
        child = subprocess.Popen([str(NODE), str(fixture), str(data), a.mode],
            cwd=data, env=ENV, stdin=subprocess.DEVNULL, stdout=logs[0], stderr=logs[1],
            close_fds=True, start_new_session=True, preexec_fn=file_limit(1024*1024))
        child_fd = os.pidfd_open(child.pid)
        report['ownedChild'] = status(child.pid)
        wait_for(lambda: message('ready'), 5, 'fixture-not-ready')
        sig(child_fd, signal.SIGSTOP)
        wait_for(lambda: bool(tasks(child.pid)) and all(x['state'] in {'T','t'} for x in tasks(child.pid)),
                 3, 'fixture-group-not-stopped')
        before = roster('owned-child-stopped-before-attach')
        # Exact reviewed argv: all syscalls, raw arguments EXCEPT filesystem
        # open/rename PATH metadata. No read=/write= dumps, argv/env, -yy, or
        # injection. This PID can only come from our own Popen above.
        argv = [str(STRACE), '-f', '-ttt', '-T', '-s', '256',
                '-e', 'trace=all',
                '-e', 'raw=!open,openat,rename,renameat,renameat2',
                '-e', 'signal=all', '-o', str(trace_path), '-p', str(child.pid)]
        report['straceArgv'] = argv
        tracer = subprocess.Popen(argv, cwd=run, env=ENV, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=logs[2], close_fds=True,
            start_new_session=True, preexec_fn=file_limit(TRACE_CAP))
        tracer_fd = os.pidfd_open(tracer.pid)
        def attached():
            if tracer.poll() is not None:
                raise RuntimeError('tracer-failed-before-coverage')
            rows = tasks(child.pid)
            return bool(rows) and all(x['tracerPid'] == tracer.pid for x in rows)
        wait_for(attached, 5, 'incomplete-task-attach')
        after = roster('all-observed-tasks-attached-while-stopped')
        if {(x['pid'],x['startTicks']) for x in before} != {(x['pid'],x['startTicks']) for x in after}:
            raise RuntimeError('task-roster-changed-during-attach')
        coverage_started = True
        sig(child_fd, signal.SIGCONT)
        if a.mode == 'timer-rename-before-signal':
            sig(child_fd, signal.SIGUSR2)  # OWNED fixture handler, not inspector.
            wait_for(lambda: message('preStopRename'), 3, 'prestop-fixture-phase-missing')
        roster('before-owned-termination')
        sig(child_fd, signal.SIGTERM)
        wait_for(lambda: child.poll() is not None, 5, 'owned-child-not-exited')
        wait_for(lambda: tracer.poll() is not None, 3, 'tracer-not-complete')
        report['childReturnCode'] = child.returncode
        report['tracerReturnCode'] = tracer.returncode
        if child.returncode != 0 or tracer.returncode != 0:
            raise RuntimeError('unclean-fixture-or-tracer-exit')
        if tasks(child.pid):
            raise RuntimeError('owned-tasks-remain')
        if set((cg/'cgroup.procs').read_text().split()) != {str(os.getpid())}:
            raise RuntimeError('unexpected-process-remains-in-owned-cgroup')
        for f in [trace_path] + log_paths:
            if CANARY in f.read_bytes():
                raise RuntimeError('synthetic-buffer-canary-leaked-to-output')
        journal = data/'sessions-relayer.json'
        with journal.open('rb') as f:
            raw = f.read(1024*1024 + 1)
            if len(raw) > 1024*1024:
                raise RuntimeError('fixture-journal-size')
            parsed = json.loads(raw)
            os.fsync(f.fileno())
            st = os.fstat(f.fileno())
        d = os.open(data, os.O_DIRECTORY); os.fsync(d); os.close(d)
        report['privateReadbackSummary'] = {'sha256':hashlib.sha256(raw).hexdigest(),
            'device':st.st_dev, 'inode':st.st_ino, 'size':st.st_size,
            'records':len(parsed['txs']), 'states':[r['status'] for r in parsed['txs']]}
        report['collectionCompleted'] = True
        report['coverageVerified'] = False
        report['manualReviewRequired'] = ['all thread/clone/exit events', 'raw buffer secrecy',
            'open/write/rename FD identity', 'no outgoing writes after capture',
            'complete nontruncated syscall pairing', 'expected fault-case refusal']
    except BaseException as exc:
        report['failures'].append(str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        report['collectionCompleted'] = False
    finally:
        # Only these pidfds, created from our Popen children, can be signalled.
        # No production PID, process-name search, arbitrary group kill, or tool
        # installation. Even a failed attach leaves an owned child to clean up.
        for proc, fd in [(child, child_fd), (tracer, tracer_fd)]:
            if proc is not None and proc.poll() is None and fd is not None:
                try:
                    sig(fd, signal.SIGKILL)
                    proc.wait(timeout=3)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    report['failures'].append('owned-cleanup-not-confirmed')
            if fd is not None:
                os.close(fd)
        for f in logs:
            f.close()
        report['observedTaskIdentities'] = seen
        report['artifacts'] = {}
        for f in [trace_path] + log_paths:
            if f.exists():
                with f.open('rb') as h:
                    os.fsync(h.fileno())
                if CANARY in f.read_bytes() and 'synthetic-buffer-canary-leaked-to-output' not in report['failures']:
                    report['failures'].append('synthetic-buffer-canary-leaked-to-output')
                report['artifacts'][f.name] = {'bytes':f.stat().st_size, 'sha256':sha(f)}
        report['elapsedMs'] = round((time.monotonic()-begin)*1000)
        if report['failures']:
            report['collectionCompleted'] = False
        with (run/'result.json').open('x') as f:
            json.dump(report,f,indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
        d=os.open(run,os.O_DIRECTORY); os.fsync(d); os.close(d)
        print(json.dumps({'ownedFixtureDirectory':str(run), 'collectionCompleted':report.get('collectionCompleted',False),
                          'failureCount':len(report['failures']), 'productionAcceptance':False}))
    return 0 if report.get('collectionCompleted') and not report['failures'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
