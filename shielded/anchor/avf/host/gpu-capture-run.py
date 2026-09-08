#!/usr/bin/env python3
"""Run an owned command inside a bounded, hash-checked GPU observation capture.

The recorded interval brackets the HOST child command, including its startup,
teardown and any remote work it waits for. It is never a phone decode interval.
Only processes started here are signaled; the sampler is read-only nvidia-smi.
"""
import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('gpu_window', Path(__file__).with_name('gpu-util-window.py'))
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


def exclusive(path, data):
    with open(path, 'xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def bounded_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            raise ValueError('not a bounded regular file: '+str(path))
        raw = f.read(limit+1)
        if len(raw) > limit:
            raise ValueError('file grew past bound: '+str(path))
        return raw


def ready(path, gpus, max_age):
    try:
        raw = bounded_regular(path, 256 << 10)
    except FileNotFoundError:
        return False
    now = time.monotonic()
    # A live writer can be between writes in the last CSV row.
    raw = raw[:raw.rfind(b'\n')+1]
    reader = csv.DictReader(io.StringIO(raw.decode('ascii'), newline=''))
    if reader.fieldnames is None:
        return False
    if len(reader.fieldnames) != len(set(reader.fieldnames)) or not window.REQUIRED <= set(reader.fieldnames):
        raise ValueError('invalid readiness CSV header')
    samples = {gpu: [] for gpu in gpus}
    for row in reader:
        if None in row or any(row.get(key) is None for key in window.REQUIRED):
            raise ValueError('invalid readiness CSV row')
        if row['uuid'] not in samples:
            raise ValueError('unselected GPU in readiness capture')
        stamp = window.number(row['recv_mono'], 'readiness time')
        window.number(row['util_gpu'], 'readiness utilization', hi=100)
        previous = samples[row['uuid']]
        if stamp > now or (previous and stamp <= previous[-1]):
            raise ValueError('invalid readiness sample clock')
        previous.append(stamp)
    return all(len(values) >= 2 and now-values[-1] <= max_age for values in samples.values())


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate summary key')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise ValueError('summary is not an object')
    return value


def stop_owned(proc, grace=8, leader_only=False):
    """Each child starts a new session. Reap its leader and stop its descendants."""
    if proc is None:
        return
    if proc.poll() is None:
        try:
            if leader_only:
                proc.terminate()  # let the sampler reap its own nvidia-smi
            else:
                os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        pass
    # A descendant may survive its leader. Its process group is still ours.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait(timeout=2)


def run(args):
    gpus = args.gpus.split(',')
    window.validate_gpus(gpus)
    prefix = str(Path(args.prefix).resolve())
    paths = {suffix: prefix+suffix for suffix in
             ('.csv', '.csv.summary.json', '.out', '.err', '.capture.json', '.capture.claim')}
    if any(os.path.lexists(path) for path in paths.values()):
        raise ValueError('capture prefix already used')
    exclusive(paths['.capture.claim'], b'owned GPU capture\n')
    result = dict(status='FAIL', scope='host-command-lifetime', command=args.command,
                  gpus=gpus, command_rc=None, capture_rc=None, reasons=[], started_utc=time.time())
    sampler = child = None
    sampler_out = sampler_err = None
    cancelled = []
    handlers = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        handlers[sig] = signal.signal(sig, lambda signum, frame: cancelled.append(signum))
    deadline = time.monotonic()+args.max_secs

    def check():
        if cancelled:
            raise InterruptedError('signal '+str(cancelled[0]))
        if time.monotonic() >= deadline:
            raise TimeoutError('capture/command deadline reached')

    try:
        sampler_out = open(paths['.out'], 'xb', buffering=0)
        sampler_err = open(paths['.err'], 'xb', buffering=0)
        env = dict(os.environ, OUT=paths['.csv'], GPUS=','.join(gpus),
                   INTERVAL_MS=str(args.interval_ms), MAX_SECS=str(args.max_secs))
        env.pop('STOPFILE', None)
        sampler = subprocess.Popen([sys.executable, args.sampler], env=env,
                                   stdout=sampler_out, stderr=sampler_err, start_new_session=True)
        result['sampler_pid'] = sampler.pid
        ready_deadline = min(deadline, time.monotonic()+args.ready_secs)
        while True:
            check()
            if sampler.poll() is not None:
                raise RuntimeError('sampler exited before command readiness')
            if ready(paths['.csv'], gpus, args.max_gap):
                break
            if time.monotonic() >= ready_deadline:
                raise TimeoutError('sampler lacks fresh readings from every selected GPU')
            time.sleep(.05)
        result['command_start_mono'] = time.monotonic()
        result['command_start_utc'] = time.time()
        child = subprocess.Popen(args.command, start_new_session=True)
        result['command_pid'] = child.pid
        print('GPU-CAPTURE command started; both selected devices have real readings', flush=True)
        sampler_failed = False
        while child.poll() is None:
            check()
            if sampler.poll() is not None and not sampler_failed:
                # Retain the command's own result and diagnostics even if capture
                # fails. The combined outcome remains failed, never inferred valid.
                sampler_failed = True
                result['reasons'].append('sampler exited during command')
            time.sleep(.05)
        result['command_rc'] = child.wait()
        result['command_end_mono'] = time.monotonic()
        result['command_end_utc'] = time.time()
        post_end = time.monotonic()+args.post_roll
        while time.monotonic() < post_end and sampler.poll() is None:
            check()
            time.sleep(.05)
        if sampler.poll() is not None:
            raise RuntimeError('sampler did not stay alive through post-roll')
    except (OSError, ValueError, RuntimeError, TimeoutError) as exc:
        result['reasons'].append(str(exc))
    finally:
        for proc in (child, sampler):
            try:
                stop_owned(proc, leader_only=proc is sampler)
            except (OSError, subprocess.TimeoutExpired) as exc:
                result['reasons'].append('owned child cleanup failed: '+str(exc))
        for f in (sampler_out, sampler_err):
            if f is not None:
                f.close()
        result['capture_rc'] = sampler.returncode if sampler is not None else None
        if child is not None:
            result['command_rc'] = child.returncode
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    try:
        capture = unique_json(bounded_regular(paths['.csv.summary.json'], 65536))
        if result['capture_rc'] != 0 or capture.get('status') != 'PASS' or type(capture.get('bad_rows')) is not int or capture['bad_rows'] != 0:
            raise ValueError('sampler exit or final capture status failed')
        rows = window.load_rows(paths['.csv'], gpus, capture)
        observations = window.analyze(rows, gpus, result['command_start_mono'], result['command_end_mono'],
                                      args.max_gap, capture_clean=True)
        result['observations'] = observations
        if observations['status'] != 'VALID_OBSERVATIONS':
            result['reasons'].extend(observations['reasons'])
    except (OSError, ValueError, KeyError, csv.Error) as exc:
        result['reasons'].append('capture validation: '+str(exc))
    if result['command_rc'] != 0:
        result['reasons'].append('command did not exit successfully')
    if not result['reasons']:
        result['status'] = 'PASS'
    result['ended_utc'] = time.time()
    exclusive(paths['.capture.json'], (json.dumps(result, indent=2, allow_nan=False)+'\n').encode())
    print('GPU-CAPTURE '+result['status']+' '+paths['.capture.json'], flush=True)
    return 0 if result['status'] == 'PASS' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prefix', required=True)
    parser.add_argument('--gpus', required=True)
    parser.add_argument('--sampler', required=True)
    parser.add_argument('--interval-ms', type=int, default=250)
    parser.add_argument('--max-secs', type=float, default=7200)
    parser.add_argument('--ready-secs', type=float, default=15)
    parser.add_argument('--max-gap', type=float, default=1)
    parser.add_argument('--post-roll', type=float, default=1)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == '--':
        args.command.pop(0)
    try:
        if not args.command or not 50 <= args.interval_ms <= 10000:
            raise ValueError('command required; interval must be 50..10000 ms')
        for name, lo, hi in [('max_secs', 1, 7200), ('ready_secs', .1, 60), ('max_gap', .05, 30), ('post_roll', .05, 30)]:
            window.number(getattr(args, name), name, lo, hi)
        return run(args)
    except (OSError, ValueError, csv.Error) as exc:
        print('GPU-CAPTURE INVALID: '+str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
