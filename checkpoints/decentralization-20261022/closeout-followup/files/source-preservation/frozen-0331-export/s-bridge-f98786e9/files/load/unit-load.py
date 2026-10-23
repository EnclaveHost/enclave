#!/usr/bin/env python3
"""The load reproduction through the REAL launcher and a REAL `systemd-run --user` unit with a reduced MemoryMax
(loopback only): `whole_restore.py start --target local` of a given harness (the frozen one or the candidate) runs
siaload.py as the restore binary; the fake Sia hosts listen on 127.0.1.N (outside the unit), the "indexer" on 127.0.0.2.
Samples the unit's own cgroup (memory.current / anon / sock / oom_kill, tasks) while it runs; then `finish --abandon`
(staging only) and `systemctl --user reset-failed`. Prints one JSON summary.

  unit-load.py --harness DIR --workdir NEW_DIR --out JSON --memory-max-mib 256 --duration 180 [load knobs]
"""
import argparse
import hashlib
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LOAD = os.path.join(HERE, 'siaload.py')


def free_port(ips):
    for _ in range(200):
        port = 20000 + secrets.randbelow(30000)
        ok = True
        for ip in ips:
            s = socket.socket()
            try:
                s.bind((ip, port))
            except OSError:
                ok = False
            s.close()
        if ok:
            return port
    raise SystemExit('no free port')


def call(harness, *argv):
    p = subprocess.run([sys.executable, '-I', os.path.join(harness, 'whole_restore.py')] + list(argv), capture_output=True, text=True, timeout=120)
    lines = p.stdout.strip().splitlines()
    return p.returncode, (json.loads(lines[-1]) if lines else {'stderr': p.stderr[-2000:]})


def unit_cgroup(unit):
    p = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'ControlGroup', '--value'], capture_output=True, text=True)
    cg = p.stdout.strip()
    return '/sys/fs/cgroup' + cg if cg else None


def procs(cg):
    """Per-process rows of the unit: role, RssAnon, threads, descriptors."""
    rows = {}
    try:
        pids = [int(x) for x in open(cg + '/cgroup.procs').read().split()]
    except (OSError, ValueError):
        return rows
    for pid in pids:
        try:
            st = dict(l.split(':', 1) for l in open('/proc/%d/status' % pid).read().splitlines() if ':' in l)
            cmd = [c.decode() for c in open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\0') if c]
            role = 'inside' if 'child' in cmd[2:4] else 'outside' if 'run' in cmd[2:4] else 'restore' if 'recovery' in cmd else cmd[0].rsplit('/', 1)[-1]
            rows[role] = {'rssAnonKiB': int(st['RssAnon'].split()[0]), 'threads': int(st['Threads']),
                          'fds': len(os.listdir('/proc/%d/fd' % pid))}
        except (OSError, KeyError, ValueError, IndexError):
            pass
    return rows


def sample(cg):
    try:
        stat = dict(l.split() for l in open(cg + '/memory.stat').read().splitlines())
        ev = dict(l.split() for l in open(cg + '/memory.events').read().splitlines())
        return {'current': int(open(cg + '/memory.current').read()), 'anon': int(stat['anon']), 'sock': int(stat['sock']),
                'file': int(stat['file']), 'oomKill': int(ev.get('oom_kill', 0)), 'tasks': int(open(cg + '/pids.current').read()),
                'procs': procs(cg)}
    except (OSError, KeyError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--harness', required=True)
    ap.add_argument('--workdir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--memory-max-mib', type=int, required=True)
    ap.add_argument('--duration', type=float, default=180)
    ap.add_argument('--endpoints', type=int, default=50)
    ap.add_argument('--streams', type=int, default=50)
    ap.add_argument('--paced-streams', type=int, default=40)
    ap.add_argument('--pace-ms', type=int, default=2)
    ap.add_argument('--sector-bytes', type=int, default=4 << 20)
    ap.add_argument('--churn-threads', type=int, default=4)
    ap.add_argument('--churn-per-sec', type=float, default=10)
    ap.add_argument('--stallers', type=int, default=10)
    ap.add_argument('--idlers', type=int, default=10)
    ap.add_argument('--bridge', action='append', default=[])
    a = ap.parse_args()
    harness = os.path.abspath(a.harness)
    work = os.path.abspath(a.workdir)
    os.makedirs(work, mode=0o700)
    os.chmod(work, 0o700)
    ips = ['127.0.1.%d' % (i + 1) for i in range(a.endpoints)]
    port, cport = free_port(ips), free_port(['127.0.0.2'])
    spec = {'endpoints': [[ip, port] for ip in ips], 'controls': [['127.0.0.2', cport]]}
    json.dump(spec, open(os.path.join(work, 'hosts.json'), 'w'))
    hstats = os.path.join(work, 'hosts-stats.json')
    hp = subprocess.Popen([sys.executable, '-I', LOAD, 'hosts', os.path.join(work, 'hosts.json'), hstats])
    rep = {'harness': harness, 'whole_restoreSha256': hashlib.sha256(open(os.path.join(harness, 'whole_restore.py'), 'rb').read()).hexdigest(),
           'runnerSha256': hashlib.sha256(open(os.path.join(harness, 'runner.py'), 'rb').read()).hexdigest(), 'args': vars(a)}
    unit = None
    try:
        for _ in range(200):
            if os.path.exists(hstats + '.ready'):
                break
            time.sleep(0.05)
        root = os.path.join(work, 'root')
        os.mkdir(root, 0o700)
        run = os.path.join(root, '20261023T000000Z-' + secrets.token_hex(4))
        os.mkdir(run, 0o700)
        load = {'duration': a.duration, 'streams': a.streams, 'slowStreams': 0, 'pacedStreams': a.paced_streams, 'paceMs': a.pace_ms,
                'sectorBytes': a.sector_bytes, 'churnThreads': a.churn_threads, 'churnPerSec': a.churn_per_sec,
                'stallers': a.stallers, 'idlers': a.idlers}
        snap = {'version': 1, 'load': load, 'hosts': [{'public_key': 'ed25519:%d' % i, 'addresses': [{'protocol': 'siamux', 'address': '%s:%d' % (ip, port)}]}
                                                      for i, ip in enumerate(ips)]}
        raw = json.dumps(snap).encode()
        open(os.path.join(work, 'snapshot.json'), 'wb').write(raw)
        open(os.path.join(run, 'snapshot-ip-pinned.json'), 'wb').write(raw)
        open(os.path.join(work, 'archive'), 'wb').write(b'a')
        key = os.path.join(work, 'app.seed')
        with open(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
            f.write('load-test-key-' + secrets.token_hex(8))
        sha = hashlib.sha256(raw).hexdigest()
        json.dump({'snapshot': os.path.join(work, 'snapshot.json'), 'snapshotSha256': sha, 'archive': os.path.join(work, 'archive'),
                   'archiveSha256': hashlib.sha256(b'a').hexdigest(), 'keyFile': key, 'derivativeSha256': sha,
                   'endpoints': [{'ip': ip, 'port': port} for ip in ips], 'blockedNames': [],
                   'blocked': [{'label': 'indexer', 'ip': '127.0.0.2', 'port': cport, 'outsideMustConnect': True}]},
                  open(os.path.join(run, 'run.json'), 'w'))
        extra = [x for b in a.bridge for x in ('--bridge', b)]
        code, st = call(harness, 'start', '--run', run, '--target', 'local', '--binary', LOAD,
                        '--binary-sha', hashlib.sha256(open(LOAD, 'rb').read()).hexdigest(), '--max-total-bytes', str(1 << 20),
                        '--deadline-secs', str(int(a.duration) + 300), '--memory-max-mib', str(a.memory_max_mib), *extra)
        rep['start'] = st
        if code:
            raise SystemExit('start refused: %s' % st)
        unit = st['unit']
        t0, series, cg = time.monotonic(), [], None
        while True:
            cg = cg or unit_cgroup(unit)
            s = sample(cg) if cg else None
            if s:
                series.append(dict(s, t=round(time.monotonic() - t0, 1)))
            code, p = call(harness, 'poll', '--run', run)
            if p.get('state') != 'running':
                break
            if time.monotonic() - t0 > a.duration + 900:
                rep['stopped'] = call(harness, 'stop', '--run', run)
            time.sleep(2)
        rep['poll'] = p
        rep['elapsed'] = round(time.monotonic() - t0, 1)
        if series:
            rep['unitMax'] = {k: max(x[k] for x in series) for k in ('current', 'anon', 'sock', 'tasks', 'oomKill')}
            rep['procMax'] = {}
            for x in series:
                for r, v in x['procs'].items():
                    m = rep['procMax'].setdefault(r, {k: 0 for k in v})
                    for k in v:
                        m[k] = max(m[k], v[k])
            rep['series'] = series[::max(1, len(series) // 60)]
        out_dir = st['attempt']
        for name in ('restore.stdout', 'probes.json'):
            try:
                rep[name] = json.loads(open(os.path.join(out_dir, name)).read())
            except (OSError, ValueError):
                rep[name] = None
        rep['finish'] = call(harness, 'finish', '--run', run, '--abandon')[1]
    finally:
        if unit:
            subprocess.run(['systemctl', '--user', 'reset-failed', unit], capture_output=True)
            rep['unitAfter'] = subprocess.run(['systemctl', '--user', 'show', unit, '-p', 'LoadState,ActiveState', '--value'],
                                              capture_output=True, text=True).stdout.split()
        hp.send_signal(signal.SIGTERM)
        hp.wait(30)
        rep['hosts'] = json.load(open(hstats)) if os.path.exists(hstats) else None
        with open(a.out, 'w') as f:
            json.dump(rep, f, indent=1, sort_keys=True)
    res = (rep.get('poll') or {}).get('result') or {}
    brief = {'state': (rep.get('poll') or {}).get('state'), 'unitState': (rep.get('poll') or {}).get('unitState'),
             'unitMaxMiB': {k: (v >> 20 if k in ('current', 'anon', 'sock') else v) for k, v in (rep.get('unitMax') or {}).items()},
             'procMax': rep.get('procMax'), 'success': res.get('success'), 'error': res.get('error'), 'memoryPeakBytes': res.get('memoryPeakBytes'),
             'client': rep.get('restore.stdout'), 'bridge': {k: {kk: v.get(kk) for kk in ('relayed', 'maxLive', 'buffersAllocated', 'stalledTimeouts',
                                                                                          'idleTimeouts', 'resets', 'loopError', 'openAtStop')}
                                                             for k, v in (res.get('bridge') or {}).items() if isinstance(v, dict)},
             'runnerSha256': rep['runnerSha256'], 'elapsed': rep.get('elapsed'), 'unitAfter': rep.get('unitAfter')}
    print(json.dumps(brief, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
