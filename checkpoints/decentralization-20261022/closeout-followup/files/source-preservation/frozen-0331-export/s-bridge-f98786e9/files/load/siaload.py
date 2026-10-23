#!/usr/bin/env python3
"""Load reproduction for the whole-restore bridge (generated data only; loopback / private namespace only).

  siaload.py hosts SPEC.json STATS.json          fake Sia hosts: one asyncio process serving every endpoint of SPEC
  siaload.py recovery restore SNAP SHA OUT ...   the stand-in restore binary: the load generator (config in SNAP["load"])
  siaload.py measure ...                         drive one runner.py (old or new) under that load and sample memory

Wire protocol (client -> host, then host -> client): a 24-byte request '>QQII' (nbytes, seed, mode, param), then the
host streams `nbytes` of position-dependent generated data. Modes: 0 normal; 1 slow (16 KiB pieces, `param` ms apart);
2 stall (send `param` bytes, then never send again but keep the connection open); 3 reset (send `param` bytes, then
RST); 4 host half-close (send everything, shut down the write side, then read until the client's EOF); 5 client
half-close (read until the client's EOF, `param` bytes expected, then send `nbytes` and close). Hosts never close idle
connections (as Sia hosts do).
"""
import asyncio
import hashlib
import json
import os
import random
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

BLOCK = hashlib.shake_256(b'siaload').digest(1 << 20)
PIECE = 1 << 16
REQ = struct.Struct('>QQII')


def piece(seed, i):
    off = (seed * 7919 + i * 104729) % (len(BLOCK) - PIECE)
    return struct.pack('>QQ', seed & (2**64 - 1), i) + BLOCK[off:off + PIECE - 16]


def gen(seed, n):
    i = 0
    while n > 0:
        p = piece(seed, i)
        if n < len(p):
            p = p[:n]
        yield p
        n -= len(p)
        i += 1


class Expect:
    """Compares a received stream, in arbitrary pieces, with gen(seed, n); also hashes it."""
    def __init__(self, seed, n):
        self.it, self.cur, self.pos, self.left, self.bad = gen(seed, n), b'', 0, n, False
        self.sha = hashlib.sha256()

    def feed(self, data):
        self.sha.update(data)
        mv = memoryview(data)
        while len(mv):
            if self.pos == len(self.cur):
                self.cur, self.pos = next(self.it, b''), 0
                if not self.cur:
                    self.bad = True
                    return
            k = min(len(mv), len(self.cur) - self.pos)
            if mv[:k] != self.cur[self.pos:self.pos + k]:
                self.bad = True
            self.pos += k
            self.left -= k
            mv = mv[k:]


def expected_sha(seed, n):
    h = hashlib.sha256()
    for p in gen(seed, n):
        h.update(p)
    return h.hexdigest()


# ---- fake hosts ------------------------------------------------------------------------------------------------------
def hosts(spec_path, stats_path):
    spec = json.load(open(spec_path))
    stats = {'accepted': 0, 'open': 0, 'maxOpen': 0, 'requests': 0, 'bytesSent': 0, 'resets': 0}

    async def handle(reader, writer):
        stats['accepted'] += 1
        stats['open'] += 1
        stats['maxOpen'] = max(stats['maxOpen'], stats['open'])
        try:
            while True:
                try:
                    n, seed, mode, param = REQ.unpack(await reader.readexactly(REQ.size))
                except (asyncio.IncompleteReadError, ConnectionError):
                    return
                stats['requests'] += 1
                if mode == 5:
                    got = 0
                    while True:
                        d = await reader.read(1 << 16)
                        if not d:
                            break
                        got += len(d)
                    if got != param:
                        return
                sent = 0
                for p in gen(seed, n):
                    if mode in (2, 3) and sent + len(p) > param:
                        p = p[:param - sent]
                    if p:
                        writer.write(p)
                        await writer.drain()
                        sent += len(p)
                        stats['bytesSent'] += len(p)
                    if mode in (2, 3) and sent >= param:
                        break
                    if mode == 1:
                        await asyncio.sleep(param / 1000)
                if mode == 2:
                    while await reader.read(1 << 16):
                        pass
                    return
                if mode == 3:
                    sock = writer.get_extra_info('socket')
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                    stats['resets'] += 1
                    writer.transport.abort()
                    return
                if mode in (4, 5):
                    if mode == 4:
                        writer.write_eof()
                        while await reader.read(1 << 16):
                            pass
                    return
        except (ConnectionError, OSError):
            return
        finally:
            stats['open'] -= 1
            writer.close()

    async def control(reader, writer):
        writer.close()

    async def main():
        servers = []
        for ip, port in spec['endpoints']:
            servers.append(await asyncio.start_server(handle, ip, port, backlog=512, limit=1 << 16))
        for ip, port in spec.get('controls', []):
            servers.append(await asyncio.start_server(control, ip, port))
        stop = asyncio.Event()
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
        open(stats_path + '.ready', 'w').close()
        await stop.wait()
        for s in servers:
            s.close()
        with open(stats_path, 'w') as f:
            json.dump(stats, f)
    asyncio.run(main())


# ---- the stand-in restore binary: load generator ---------------------------------------------------------------------
def client(argv):
    _, op, sub, snap_path, sha, outdir, max_total, deadline = argv
    assert (op, sub) == ('recovery', 'restore')
    raw = open(snap_path, 'rb').read()
    assert hashlib.sha256(raw).hexdigest() == sha
    snap = json.loads(raw)
    cfg = snap['load']
    eps = [tuple(a['address'].rsplit(':', 1)) for h in snap['hosts'] for a in h['addresses']]
    eps = [(ip, int(p)) for ip, p in eps]
    end = time.monotonic() + cfg['duration']
    lock = threading.Lock()
    st = {'streamBytes': 0, 'streamRequests': 0, 'streamErrors': 0, 'mismatches': 0, 'churnConnects': 0,
          'churnErrors': 0, 'stallersOpened': 0, 'stallersClosedByPeer': 0, 'idlersOpened': 0, 'idlersClosedByPeer': 0}
    errors = {}

    def add(k, v=1):
        with lock:
            st[k] += v

    def err(e):
        with lock:
            errors[type(e).__name__] = errors.get(type(e).__name__, 0) + 1

    def read_exact(s, n, seed, delay):
        exp, buf = Expect(seed, n), bytearray(PIECE)
        left = n
        while left:
            k = s.recv_into(buf, min(left, PIECE))
            if not k:
                raise ConnectionAbortedError('eof after %d of %d' % (n - left, n))
            exp.feed(bytes(buf[:k]))
            left -= k
            if delay:
                time.sleep(delay)
        return not exp.bad

    def stream(i):
        ep = eps[i % len(eps)]
        slow = i < cfg.get('slowStreams', 0)
        paced = cfg.get('slowStreams', 0) <= i < cfg.get('slowStreams', 0) + cfg.get('pacedStreams', 0)
        s = None
        while time.monotonic() < end:
            try:
                if s is None:
                    s = socket.create_connection(ep, 15)
                    s.settimeout(cfg.get('readTimeout', 120))
                seed = random.getrandbits(62)
                n = cfg['sectorBytes']
                s.sendall(REQ.pack(n, seed, 1, cfg.get('paceMs', 2)) if paced else REQ.pack(n, seed, 0, 0))
                ok = read_exact(s, n, seed, cfg.get('slowDelay', 0.002) if slow else 0)
                add('streamRequests')
                add('streamBytes', n)
                if not ok:
                    add('mismatches')
            except OSError as e:
                add('streamErrors')
                err(e)
                if s:
                    s.close()
                s = None
                time.sleep(0.2)
        if s:
            s.close()

    def churn(i):
        rnd = random.Random(i)
        gap = cfg.get('churnThreads', 1) / max(cfg.get('churnPerSec', 1), 0.001)
        while time.monotonic() < end:
            t0 = time.monotonic()
            try:
                s = socket.create_connection(rnd.choice(eps), 10)
                add('churnConnects')
                act = rnd.choice(('close', 'abort', 'small', 'nodata'))
                s.settimeout(30)
                if act == 'abort':
                    s.sendall(REQ.pack(1 << 20, rnd.getrandbits(62), 0, 0))
                    s.recv(1 << 16)
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                elif act == 'small':
                    seed = rnd.getrandbits(62)
                    s.sendall(REQ.pack(1 << 16, seed, 0, 0))
                    if not read_exact(s, 1 << 16, seed, 0):
                        add('mismatches')
                elif act == 'nodata':
                    time.sleep(0.05)
                s.close()
            except OSError as e:
                add('churnErrors')
                err(e)
            time.sleep(max(0, gap - (time.monotonic() - t0)))

    held = []
    for i in range(cfg.get('stallers', 0)):  # request a lot, read nothing, never close
        try:
            s = socket.create_connection(eps[i % len(eps)], 15)
            s.sendall(REQ.pack(cfg.get('stallerBytes', 1 << 30), random.getrandbits(62), 0, 0))
            held.append(('staller', s))
            add('stallersOpened')
        except OSError as e:
            err(e)
    for i in range(cfg.get('idlers', 0)):  # connect, send nothing
        try:
            held.append(('idler', socket.create_connection(eps[i % len(eps)], 15)))
            add('idlersOpened')
        except OSError as e:
            err(e)
    threads = [threading.Thread(target=stream, args=(i,)) for i in range(cfg.get('streams', 0))]
    threads += [threading.Thread(target=churn, args=(i,)) for i in range(cfg.get('churnThreads', 0))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for kind, s in held:  # did the bridge close it (a stalled or idle peer must not be held for ever)?
        s.setblocking(False)
        try:
            closed = s.recv(1, socket.MSG_PEEK) == b'' if kind == 'idler' else False
        except BlockingIOError:
            closed = False
        except OSError:
            closed = True
        if kind == 'staller':
            try:
                while True:
                    if not s.recv(1 << 20):
                        closed = True
                        break
            except BlockingIOError:
                pass
            except OSError:
                closed = True
        add('stallersClosedByPeer' if kind == 'staller' else 'idlersClosedByPeer', int(closed))
        s.close()
    summary = dict(st, errors=errors)
    data = (json.dumps(summary, sort_keys=True) + '\n').encode()
    os.mkdir(outdir, 0o700)
    os.mkdir(os.path.join(outdir, 'objects'), 0o700)
    with open(os.path.join(outdir, 'objects', '000001.bin'), 'xb') as f:
        f.write(data)
    ok = st['mismatches'] == 0 and st['streamRequests'] > 0
    inv = {'format': 'sia-s3-recovery-restore/v1', 'complete': ok, 'keys': 1, 'restored': 1, 'restoredBytes': len(data),
           'totalBytes': len(data), 'failed': [], 'notAttempted': [], 'expectedButAbsent': [],
           'files': [{'file': 'objects/000001.bin', 'bytes': len(data), 'outputSha256': hashlib.sha256(data).hexdigest(),
                      'etagCheck': 'md5', 'independentSha256': 'not-provided'}], 'indexerUsed': False, 'writesToSia': False}
    with open(os.path.join(outdir, 'inventory.json'), 'x') as f:
        json.dump(inv, f)
    print(json.dumps(summary, sort_keys=True), flush=True)
    return 0 if ok else 1


# ---- the driver -------------------------------------------------------------------------------------------------------
def proc_tree(root):
    kids = {}
    for p in os.listdir('/proc'):
        if p.isdigit():
            try:
                s = open('/proc/%s/stat' % p).read()
                kids.setdefault(int(s[s.rfind(')') + 2:].split()[1]), []).append(int(p))
            except OSError:
                pass
    out, todo = [], [root]
    while todo:
        p = todo.pop()
        out.append(p)
        todo += kids.get(p, [])
    return out


def proc_info(pid):
    try:
        status = dict(l.split(':', 1) for l in open('/proc/%d/status' % pid).read().splitlines() if ':' in l)
        cmd = open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\0')
        return {'pid': pid, 'cmd': [c.decode(errors='replace') for c in cmd if c][:4],
                'rssAnonKiB': int(status.get('RssAnon', '0 kB').split()[0]), 'rssKiB': int(status.get('VmRSS', '0 kB').split()[0]),
                'vmKiB': int(status.get('VmSize', '0 kB').split()[0]), 'threads': int(status.get('Threads', '0')),
                'fds': len(os.listdir('/proc/%d/fd' % pid))}
    except (OSError, ValueError):
        return None


def role(info):
    c = ' '.join(info['cmd'])
    if 'runner.py child' in c or (len(info['cmd']) >= 3 and info['cmd'][-2:-1] == ['child']):
        return 'inside'
    if 'runner.py' in c and ' run ' in c + ' ':
        return 'outside'
    if 'recovery' in info['cmd']:
        return 'client'
    return None


def cgroup_dir():
    rel = [l.split(':', 2)[2] for l in open('/proc/self/cgroup').read().splitlines() if l.startswith('0::')][0].strip()
    return '/sys/fs/cgroup' + rel


def cg_sample(d):
    try:
        stat = dict(l.split() for l in open(d + '/memory.stat').read().splitlines())
        return {'current': int(open(d + '/memory.current').read()), 'anon': int(stat['anon']), 'file': int(stat['file']),
                'sock': int(stat['sock']), 'kernel': int(stat.get('kernel', 0))}
    except (OSError, KeyError, ValueError):
        return None


def measure(a):
    import argparse
    ap = argparse.ArgumentParser(prog='siaload.py measure')
    ap.add_argument('--runner', required=True)
    ap.add_argument('--workdir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--endpoints', type=int, default=50)
    ap.add_argument('--first-ip', default='203.0.113.10')
    ap.add_argument('--port', type=int, default=9984)
    ap.add_argument('--control', default='127.0.0.2:4100')
    ap.add_argument('--duration', type=float, default=120)
    ap.add_argument('--streams', type=int, default=50)
    ap.add_argument('--slow-streams', type=int, default=0)
    ap.add_argument('--slow-delay', type=float, default=0.002)
    ap.add_argument('--paced-streams', type=int, default=0, help='streams whose host sends 16 KiB pieces --pace-ms apart')
    ap.add_argument('--pace-ms', type=int, default=2)
    ap.add_argument('--sector-bytes', type=int, default=4 << 20)
    ap.add_argument('--churn-threads', type=int, default=0)
    ap.add_argument('--churn-per-sec', type=float, default=0)
    ap.add_argument('--stallers', type=int, default=0)
    ap.add_argument('--idlers', type=int, default=0)
    ap.add_argument('--stop-anon-mib', type=int, default=320, help='end the run early if a bridge process exceeds this')
    ap.add_argument('--env', action='append', default=[], help='KEY=VALUE for the runner (e.g. GLIBC_TUNABLES)')
    ap.add_argument('--plan-extra', default='{}', help='JSON merged into plan.json (bridge settings for the new runner)')
    ap.add_argument('--interval', type=float, default=1.0)
    a = ap.parse_args(a)
    import ipaddress
    base = ipaddress.ip_address(a.first_ip)
    eps = [(str(base + i), a.port) for i in range(a.endpoints)]
    work = os.path.abspath(a.workdir)
    os.makedirs(work, mode=0o700)
    attempt = os.path.join(work, 'attempt')
    os.mkdir(attempt, 0o700)
    cip, cport = a.control.rsplit(':', 1)
    spec = {'endpoints': eps, 'controls': [[cip, int(cport)]]}
    json.dump(spec, open(os.path.join(work, 'hosts.json'), 'w'))
    hstats = os.path.join(work, 'hosts-stats.json')
    hp = subprocess.Popen([sys.executable, '-I', os.path.abspath(__file__), 'hosts', os.path.join(work, 'hosts.json'), hstats])
    for _ in range(200):
        if os.path.exists(hstats + '.ready'):
            break
        time.sleep(0.05)
    load = {'duration': a.duration, 'streams': a.streams, 'slowStreams': a.slow_streams, 'slowDelay': a.slow_delay,
            'sectorBytes': a.sector_bytes, 'pacedStreams': a.paced_streams, 'paceMs': a.pace_ms, 'churnThreads': a.churn_threads, 'churnPerSec': a.churn_per_sec,
            'stallers': a.stallers, 'idlers': a.idlers}
    snap = {'version': 1, 'load': load,
            'hosts': [{'public_key': 'ed25519:%d' % i, 'addresses': [{'protocol': 'siamux', 'address': '%s:%d' % e}]} for i, e in enumerate(eps)]}
    raw = json.dumps(snap).encode()
    open(os.path.join(work, 'snapshot.json'), 'wb').write(raw)
    key = os.path.join(work, 'key')
    with open(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write('load-test-key\n')
    me = os.path.abspath(__file__)
    plan = {'format': 'sia-whole-restore-plan/v1', 'binary': me, 'binarySha256': hashlib.sha256(open(me, 'rb').read()).hexdigest(),
            'snapshot': os.path.join(work, 'snapshot.json'), 'snapshotSha256': hashlib.sha256(raw).hexdigest(),
            'originalSnapshot': os.path.join(work, 'snapshot.json'), 'originalSnapshotSha256': hashlib.sha256(raw).hexdigest(),
            'keyFile': key, 'outdir': os.path.join(attempt, 'restored'), 'maxTotalBytes': 1 << 20, 'deadlineSecs': int(a.duration) + 600,
            'endpoints': [{'ip': ip, 'port': p} for ip, p in eps],
            'blocked': [{'label': 'indexer', 'ip': cip, 'port': int(cport), 'outsideMustConnect': True},
                        {'label': 'nan', 'ip': '198.51.100.7', 'port': 443, 'outsideMustConnect': False}],
            'blockedNames': []}
    plan.update(json.loads(a.plan_extra))
    json.dump(plan, open(os.path.join(attempt, 'plan.json'), 'w'))
    runner_bytes = open(a.runner, 'rb').read()
    open(os.path.join(attempt, 'runner.py'), 'wb').write(runner_bytes)
    env = dict(os.environ)
    for kv in a.env:
        k, v = kv.split('=', 1)
        env[k] = v
    cg = cgroup_dir()
    base_cg = cg_sample(cg)
    t0 = time.monotonic()
    rp = subprocess.Popen([sys.executable, '-I', os.path.join(attempt, 'runner.py'), 'run', attempt], env=env, stdin=subprocess.DEVNULL)
    series, peaks, early = [], {}, None
    while rp.poll() is None:
        t = round(time.monotonic() - t0, 1)
        row = {'t': t, 'cg': cg_sample(cg), 'procs': {}}
        for pid in proc_tree(rp.pid):
            info = proc_info(pid)
            r = info and role(info)
            if r:
                row['procs'][r] = {k: info[k] for k in ('pid', 'rssAnonKiB', 'rssKiB', 'vmKiB', 'threads', 'fds')}
                pk = peaks.setdefault(r, {'rssAnonKiB': 0, 'threads': 0, 'fds': 0, 'vmKiB': 0})
                for k in pk:
                    pk[k] = max(pk[k], info[k])
                if r in ('inside', 'outside') and info['rssAnonKiB'] > a.stop_anon_mib * 1024 and early is None:
                    early = {'t': t, 'role': r, 'rssAnonKiB': info['rssAnonKiB']}
        series.append(row)
        if early:
            for pid in reversed(proc_tree(rp.pid)):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            break
        time.sleep(a.interval)
    rc = rp.wait()
    hp.send_signal(signal.SIGTERM)
    hp.wait(30)
    def last(r, k):
        vals = [row['procs'][r][k] for row in series if r in row['procs']]
        return vals[-1] if vals else None
    cgs = [row['cg'] for row in series if row['cg']]
    rep = {'runner': os.path.abspath(a.runner), 'runnerSha256': hashlib.sha256(runner_bytes).hexdigest(), 'args': vars(a),
           'runnerExit': rc, 'earlyStop': early, 'elapsed': round(time.monotonic() - t0, 1), 'peaks': peaks,
           'final': {r: {k: last(r, k) for k in ('rssAnonKiB', 'threads', 'fds')} for r in ('outside', 'inside', 'client')},
           'cgroupBaseline': base_cg,
           'cgroupMax': {k: max(c[k] for c in cgs) for k in ('current', 'anon', 'sock')} if cgs else None,
           'hosts': json.load(open(hstats)) if os.path.exists(hstats) else None}
    for name in ('result.json', 'probes.json', 'restore.stdout', 'restore.stderr', 'bridge-outside.json', 'bridge-inside.json'):
        p = os.path.join(attempt, name)
        if os.path.exists(p):
            txt = open(p).read()
            try:
                rep[name] = json.loads(txt)
            except ValueError:
                rep[name] = txt[-4000:]
    rep['series'] = [{'t': r['t'], 'cg': r['cg'], **{k: {kk: v[kk] for kk in ('rssAnonKiB', 'threads', 'fds')} for k, v in r['procs'].items()}}
                     for r in series[::max(1, len(series) // 120)]]
    with open(a.out, 'w') as f:
        json.dump(rep, f, indent=1, sort_keys=True)
    brief = {k: rep[k] for k in ('runnerSha256', 'runnerExit', 'earlyStop', 'elapsed', 'peaks', 'final', 'cgroupMax', 'hosts')}
    brief['client'] = rep.get('restore.stdout')
    brief['result'] = {k: (rep.get('result.json') or {}).get(k) for k in ('success', 'error', 'restoreExit', 'memoryPeakBytes')}
    for n in ('bridge-outside.json', 'bridge-inside.json'):
        if n in rep:
            brief[n] = rep[n]
    print(json.dumps(brief, sort_keys=True), flush=True)
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'hosts':
        hosts(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'recovery':
        sys.exit(client(sys.argv))
    elif len(sys.argv) >= 2 and sys.argv[1] == 'measure':
        sys.exit(measure(sys.argv[2:]))
    else:
        sys.exit(__doc__)
