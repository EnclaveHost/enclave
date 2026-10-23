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
import errno
import hashlib
import json
import os
import resource
import selectors
import shutil
import socket
import struct
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


# ---- the bridge ------------------------------------------------------------------------------------------------------
# Both ends (outside: AF_UNIX listeners -> the real ip:port; inside: loopback TCP listeners -> AF_UNIX) are one Bridge:
# one thread running one selector loop over non-blocking sockets. No thread per connection, no allocation per read.
#   status byte   the outside answers each AF_UNIX connection with ONE byte once its own dial has finished: 1 = the real
#                 host accepted the TCP connection, 0 = it did not, 2 = the bridge refused (a connection limit). The
#                 inside relays nothing before it has read a 1, so a local accept is never mistaken for the host.
#   backpressure  each direction holds at most one chunk. A source is read only while its direction holds nothing;
#                 bytes the destination cannot take wait in that direction's chunk, so a slow reader slows its writer
#                 through the kernel's own flow control instead of growing a queue here.
#   half-close    an EOF is passed on as shutdown(SHUT_WR) once that direction's bytes are written; the other direction
#                 keeps flowing. The connection closes when both directions have ended.
#   bounds        live connections per end and per endpoint: at a cap the NEW connection is refused (inside: RST;
#                 outside: status 2), never an existing one. Connect, status, idle, half-closed idle and stalled-send
#                 timeouts. No absolute age limit: a transfer that keeps moving bytes is never cut.
#   errors        a reset, a refused dial, a limit or a timeout closes both sockets; the TCP socket(s) of the end that
#                 detects it close with RST. Across the AF_UNIX hop an abort arrives as EOF (as in the old bridge);
#                 siamux frames are authenticated, so the SDK detects a truncated stream either way.
BRIDGE_DEFAULTS = {
    'chunkBytes': 64 << 10,        # per direction, held only while the destination is not writable
    'maxConns': 256,               # live connections per bridge end
    'maxConnsPerEndpoint': 16,     # the SDK keeps one connection per host; re-dials after errors
    'connectSecs': 15,             # outside: the dial of the real host (the SDK gives up after 10)
    'statusSecs': 30,              # inside: wait for the status byte (longer than connectSecs)
    'idleSecs': 1800,              # nothing moved either way (siamux keepalives: every 3/4 of its 20 min timeout)
    'halfClosedIdleSecs': 60,      # one direction has ended and NOTHING moves either way (an active response continues)
    'stalledSendSecs': 300,        # bytes are waiting and the destination took none of them
    'hostRecvBufBytes': 1 << 20,   # outside: SO_RCVBUF of the dial to the real host, set before connect (the TCP window)
    'localSendBufBytes': 256 << 10,  # inside: SO_SNDBUF of each accepted loopback connection
}
BRIDGE_LIMITS = {'chunkBytes': (4096, 1 << 20), 'maxConns': (1, 4096), 'maxConnsPerEndpoint': (1, 4096),
                 'connectSecs': (1, 300), 'statusSecs': (2, 600), 'idleSecs': (1, 86400), 'halfClosedIdleSecs': (1, 86400),
                 'stalledSendSecs': (1, 86400), 'hostRecvBufBytes': (0, 64 << 20), 'localSendBufBytes': (0, 64 << 20)}
ABORT = struct.pack('ii', 1, 0)    # SO_LINGER on, 0 s: close() sends RST


def bridge_settings(plan):
    cfg = dict(BRIDGE_DEFAULTS)
    for k, v in (plan.get('bridge') or {}).items():
        lo, hi = BRIDGE_LIMITS.get(k, (None, None))
        if lo is None or isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise SystemExit('plan bridge setting %r must be an integer in %s' % (k, BRIDGE_LIMITS.get(k)))
        cfg[k] = v
    if cfg['statusSecs'] <= cfg['connectSecs']:
        raise SystemExit('plan bridge statusSecs must exceed connectSecs')
    return cfg


class Direction:
    __slots__ = ('src', 'dst', 'buf', 'start', 'end', 'eof', 'done', 'since')

    def __init__(self, src, dst):
        self.src, self.dst, self.buf, self.start, self.end = src, dst, None, 0, 0
        self.eof = self.done = False
        self.since = 0.0  # when the waiting bytes last moved


class Conn:
    __slots__ = ('a', 'b', 'ep', 'state', 'deadline', 'last', 'up', 'down', 'masks')

    def __init__(self, a, ep, now):
        self.a, self.b, self.ep, self.state, self.deadline, self.last = a, None, ep, 'new', 0.0, now
        self.up = self.down = None
        self.masks = {}


class Bridge:
    """The relay loop of one bridge end. outside=True: each listener is an AF_UNIX socket, and its connections go to the
    real (ip, port) of that endpoint, answered with the status byte. outside=False: each listener is a loopback TCP socket,
    and its connections go to the AF_UNIX path, after a status byte of 1."""

    def __init__(self, outside, cfg):
        self.outside, self.cfg = outside, cfg
        self.sel = selectors.DefaultSelector()
        self.wake_r, self.wake_w = socket.socketpair()
        self.wake_r.setblocking(False)
        self.wake_w.setblocking(False)
        self.sel.register(self.wake_r, selectors.EVENT_READ, ('wake', None))
        self.listeners, self.paused = [], {}
        self.conns, self.per_ep = set(), {}
        self.pool, self.buffers = [], 0
        self.scratch = bytearray(cfg['chunkBytes'])
        self.stopping = False
        self.thread = None
        self.stats = {k: 0 for k in ('accepted', 'relayed', 'rejectedLimit', 'rejectedEndpointLimit', 'dialFailed',
                                     'statusFailed', 'connectTimeouts', 'statusTimeouts', 'idleTimeouts',
                                     'halfClosedTimeouts', 'stalledTimeouts', 'resets', 'closedClean', 'halfCloses',
                                     'bytesAtoB', 'bytesBtoA', 'maxLive', 'buffersAllocated', 'acceptPaused')}
        self.stats['loopError'] = None
        self.stats['settings'] = dict(cfg)
        self.max_conns = cfg['maxConns']

    # -- setup / teardown (caller's thread) --
    def add(self, listener, target):
        """target: (ip, port) outside, or an AF_UNIX path inside. The bridge owns and closes the listener."""
        listener.setblocking(False)
        ep = len(self.listeners)
        self.listeners.append((listener, target))
        self.per_ep[ep] = 0
        self.sel.register(listener, selectors.EVENT_READ, ('listen', ep))

    def start(self):
        # two descriptors per connection plus the listeners must fit the descriptor limit, which is left unchanged (the
        # restore inherits it); a smaller limit lowers the connection cap rather than failing accepts
        soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        if soft != resource.RLIM_INFINITY:
            self.max_conns = max(1, min(self.max_conns, (soft - len(self.listeners) - 64) // 2))
        self.stats['maxConnsEffective'] = self.max_conns
        self.thread = threading.Thread(target=self._run, name='bridge-' + ('outside' if self.outside else 'inside'), daemon=True)
        self.thread.start()
        return self

    def stop(self, timeout=30):
        """Close every listener and connection and end the loop thread. -> stats (counts and booleans only)."""
        self.stopping = True
        try:
            self.wake_w.send(b'x')
        except OSError:
            pass
        if self.thread:
            self.thread.join(timeout)
        else:
            self._cleanup()
        self.stats['threadEnded'] = not (self.thread and self.thread.is_alive())
        return dict(self.stats)

    # -- the loop --
    def _run(self):
        try:
            next_scan = 0.0
            while not self.stopping:
                for key, ev in self.sel.select(1.0):
                    kind, obj = key.data
                    if kind == 'listen':
                        self._accept(obj)
                    elif kind == 'conn':
                        conn, sock = obj
                        if conn in self.conns:
                            self._event(conn, sock, ev)
                    else:
                        try:
                            while self.wake_r.recv(64):
                                pass
                        except BlockingIOError:
                            pass
                now = time.monotonic()
                if now >= next_scan:
                    next_scan = now + 0.5
                    self._timeouts(now)
        except Exception as e:  # noqa: BLE001 - recorded, and the run fails (see run())
            self.stats['loopError'] = '%s: %s' % (type(e).__name__, e)
        finally:
            self._cleanup()

    def _cleanup(self):
        self.stats['openAtStop'] = len(self.conns)
        for conn in list(self.conns):
            self._close(conn, abort=True, why=None)
        for listener, _ in self.listeners:
            self._unregister(listener)
            listener.close()
        self._unregister(self.wake_r)
        self.wake_r.close()
        self.wake_w.close()
        self.sel.close()
        self.pool.clear()

    def _unregister(self, sock):
        try:
            self.sel.unregister(sock)
        except (KeyError, ValueError):
            pass

    def _accept(self, ep):
        listener, target = self.listeners[ep]
        for _ in range(64):
            try:
                a, _ = listener.accept()
            except BlockingIOError:
                return
            except OSError as e:
                if e.errno in (errno.EMFILE, errno.ENFILE, errno.ENOBUFS, errno.ENOMEM):
                    self._unregister(listener)  # try again on the next timeout scan rather than spin
                    self.paused[ep] = time.monotonic() + 1
                    self.stats['acceptPaused'] += 1
                return
            self.stats['accepted'] += 1
            try:
                self._open(a, ep, target)
            except OSError:  # a socket call on the new connection failed: drop just that connection
                self.stats['resets'] += 1
                conn = next((c for c in self.conns if c.a is a), None)
                if conn:
                    self._close(conn, abort=True, why=None)
                else:
                    a.close()

    def _open(self, a, ep, target):
        a.setblocking(False)
        if not self._room(ep):
            self.stats['rejectedLimit' if len(self.conns) >= self.max_conns else 'rejectedEndpointLimit'] += 1
            if self.outside:
                self._send_status(a, b'\2')
                a.close()
            else:
                self._rst(a)
            return
        now = time.monotonic()
        conn = Conn(a, ep, now)
        self.conns.add(conn)
        self.per_ep[ep] += 1
        self.stats['maxLive'] = max(self.stats['maxLive'], len(self.conns))
        if self.outside:
            try:
                b = socket.socket(socket.AF_INET6 if ':' in target[0] else socket.AF_INET, socket.SOCK_STREAM)
            except OSError:
                self.stats['dialFailed'] += 1
                self._send_status(a, b'\0')
                self._close(conn, abort=False, why=None)
                return
            b.setblocking(False)
            conn.b = b
            if self.cfg['hostRecvBufBytes']:  # bounds what the host can push ahead of the restore (0 = autotune)
                b.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self.cfg['hostRecvBufBytes'])
            err = b.connect_ex(target)
            if err not in (0, errno.EINPROGRESS):
                self.stats['dialFailed'] += 1
                self._send_status(a, b'\0')
                self._close(conn, abort=False, why=None)
                return
            conn.state, conn.deadline = 'dial', now + self.cfg['connectSecs']
            self._want(conn, b, selectors.EVENT_WRITE)
        else:
            if self.cfg['localSendBufBytes']:
                a.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, self.cfg['localSendBufBytes'])
            try:
                b = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                b.setblocking(False)
                conn.b = b
                b.connect(target)
            except OSError:  # EAGAIN: the outside's backlog is full; anything else: it is gone
                self.stats['statusFailed'] += 1
                self._close(conn, abort=True, why=None)
                return
            conn.state, conn.deadline = 'status', now + self.cfg['statusSecs']
            self._want(conn, b, selectors.EVENT_READ)

    def _room(self, ep):
        """A new connection fits the per-endpoint and global caps. At capacity the NEWCOMER is refused; an existing
        connection is never closed to make room (a half-closed one may still be carrying its response). Existing
        connections end only on completion, error or their own connect/status/idle/half-closed-idle/stall deadline."""
        return self.per_ep[ep] < self.cfg['maxConnsPerEndpoint'] and len(self.conns) < self.max_conns

    def _send_status(self, sock, byte):
        try:
            return sock.send(byte) == 1
        except OSError:
            return False

    def _rst(self, sock):
        try:
            if sock.family != socket.AF_UNIX:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, ABORT)
        except OSError:
            pass
        sock.close()

    def _want(self, conn, sock, mask):
        old = conn.masks.get(sock, 0)
        if mask == old:
            return
        if not mask:
            self._unregister(sock)
        elif not old:
            self.sel.register(sock, mask, ('conn', (conn, sock)))
        else:
            self.sel.modify(sock, mask, ('conn', (conn, sock)))
        conn.masks[sock] = mask

    def _update(self, conn):
        """Interest for both sockets of a relaying connection, from its two directions."""
        for sock in (conn.a, conn.b):
            mask = 0
            for d in (conn.up, conn.down):
                if d.src is sock and not d.eof and d.buf is None:
                    mask |= selectors.EVENT_READ
                if d.dst is sock and d.buf is not None:
                    mask |= selectors.EVENT_WRITE
            self._want(conn, sock, mask)

    def _begin_relay(self, conn, now):
        conn.state, conn.last = 'relay', now
        conn.up, conn.down = Direction(conn.a, conn.b), Direction(conn.b, conn.a)
        self.stats['relayed'] += 1
        self._update(conn)

    def _event(self, conn, sock, ev):
        now = time.monotonic()
        try:
            if conn.state == 'dial':  # outside: the real host's TCP connect has finished
                if sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR):
                    self.stats['dialFailed'] += 1
                    self._send_status(conn.a, b'\0')
                    self._close(conn, abort=False, why=None)
                    return
                if not self._send_status(conn.a, b'\1'):
                    self._close(conn, abort=True, why=None)
                    return
                self._want(conn, conn.b, 0)
                self._begin_relay(conn, now)
                return
            if conn.state == 'status':  # inside: the outside's verdict on the real host
                try:
                    status = sock.recv(1)
                except BlockingIOError:
                    return
                if status != b'\1':
                    self.stats['statusFailed'] += 1
                    self._close(conn, abort=True, why=None)
                    return
                self._want(conn, conn.b, 0)
                self._begin_relay(conn, now)
                return
            for d in (conn.up, conn.down):
                if ev & selectors.EVENT_WRITE and d.dst is sock and d.buf is not None:
                    self._flush(d, now, conn)
                if ev & selectors.EVENT_READ and d.src is sock and d.buf is None and not d.eof:
                    self._pump(d, now, conn)
            if conn.up.done and conn.down.done:
                self.stats['closedClean'] += 1
                self._close(conn, abort=False, why=None)
            elif conn in self.conns:
                self._update(conn)
        except OSError:
            self._close(conn, abort=True, why='resets')

    def _pump(self, d, now, conn):
        try:
            n = d.src.recv_into(self.scratch)
        except BlockingIOError:
            return
        if n == 0:
            d.eof = True
            self._end(d, conn)
            return
        conn.last = now
        self.stats['bytesAtoB' if d is conn.up else 'bytesBtoA'] += n
        try:
            sent = d.dst.send(memoryview(self.scratch)[:n])
        except BlockingIOError:
            sent = 0
        if sent < n:  # keep the rest in this direction's chunk; stop reading its source until it is written
            d.buf = self.pool.pop() if self.pool else self._new_buffer()
            d.buf[:n - sent] = memoryview(self.scratch)[sent:n]
            d.start, d.end, d.since = 0, n - sent, now

    def _new_buffer(self):
        self.buffers += 1
        self.stats['buffersAllocated'] = max(self.stats['buffersAllocated'], self.buffers)
        return bytearray(self.cfg['chunkBytes'])

    def _flush(self, d, now, conn):
        try:
            sent = d.dst.send(memoryview(d.buf)[d.start:d.end])
        except BlockingIOError:
            return
        if sent:
            d.start += sent
            d.since = conn.last = now
        if d.start == d.end:
            self._release(d)
            if d.eof:
                self._end(d, conn)

    def _release(self, d):
        if d.buf is not None:
            if len(self.pool) < 2 * self.cfg['maxConns']:
                self.pool.append(d.buf)
            else:
                self.buffers -= 1
            d.buf = None

    def _end(self, d, conn):
        """Source EOF with nothing waiting: pass it on as a half-close."""
        if d.buf is None and not d.done:
            d.dst.shutdown(socket.SHUT_WR)
            d.done = True
            self.stats['halfCloses'] += 1

    def _timeouts(self, now):
        for ep, until in list(self.paused.items()):
            if now >= until:
                del self.paused[ep]
                self.sel.register(self.listeners[ep][0], selectors.EVENT_READ, ('listen', ep))
        c = self.cfg
        for conn in list(self.conns):
            if conn.state == 'dial' and now >= conn.deadline:
                self.stats['connectTimeouts'] += 1
                self._send_status(conn.a, b'\0')
                self._close(conn, abort=True, why=None)
            elif conn.state == 'status' and now >= conn.deadline:
                self._close(conn, abort=True, why='statusTimeouts')
            elif conn.state == 'relay':
                waiting = [d.since for d in (conn.up, conn.down) if d.buf is not None]
                if waiting:  # bytes wait for a slow destination: only the stall deadline applies
                    if now - min(waiting) >= c['stalledSendSecs']:
                        self._close(conn, abort=True, why='stalledTimeouts')
                elif (conn.up.eof or conn.down.eof) and now - conn.last >= c['halfClosedIdleSecs']:
                    self._close(conn, abort=True, why='halfClosedTimeouts')
                elif now - conn.last >= c['idleSecs']:
                    self._close(conn, abort=True, why='idleTimeouts')

    def _close(self, conn, abort, why):
        if conn not in self.conns:
            return
        self.conns.discard(conn)
        self.per_ep[conn.ep] -= 1
        if why:
            self.stats[why] += 1
        for d in (conn.up, conn.down):
            if d is not None:
                self._release(d)
        for sock in (conn.a, conn.b):
            if sock is None:
                continue
            if conn.masks.get(sock):
                self._unregister(sock)
            if abort:
                self._rst(sock)
            else:
                sock.close()
        conn.masks.clear()


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
    bridge = Bridge(False, bridge_settings(plan))
    try:
        subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
        for ip in sorted({e['ip'] for e in plan['endpoints']}):
            if not ip.startswith('127.'):  # already on loopback (test fixtures only; prepare admits global addresses)
                subprocess.run(['ip', 'address', 'add', ip + '/32', 'dev', 'lo'], check=True)
        for i, e in enumerate(plan['endpoints']):
            listener = socket.socket()
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind((e['ip'], e['port']))
            listener.listen(128)
            bridge.add(listener, os.path.join(sockdir, str(i)))
        bridge.start()
        return probe_and_restore(plan, attempt, sockdir)
    finally:
        write_new(os.path.join(attempt, 'bridge-inside.json'), bridge.stop())


def probe_and_restore(plan, attempt, sockdir):
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
    sockdir = bridge = None
    try:
        check_plan(plan)
        cfg = bridge_settings(plan)
        st = os.statvfs(attempt)
        result['freeBytesBefore'] = st.f_bavail * st.f_frsize
        if result['freeBytesBefore'] < plan['maxTotalBytes'] + RESERVE_BYTES:
            raise SystemExit('not enough free space for the byte budget plus %d reserve' % RESERVE_BYTES)
        sockdir = tempfile.mkdtemp(prefix='swr-', dir='/tmp')  # short paths: AF_UNIX names are limited to 107 bytes
        bridge = Bridge(True, cfg)
        for i, e in enumerate(plan['endpoints']):
            path = os.path.join(sockdir, str(i))
            assert len(path) < 100
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(path)
            listener.listen(128)
            bridge.add(listener, (e['ip'], e['port']))
        bridge.start()
        userns = [] if os.geteuid() == 0 else ['--user', '--map-root-user']
        code = subprocess.run(['unshare', '--net'] + userns + [sys.executable, '-I', os.path.abspath(__file__), 'child', attempt, sockdir],
                              stdin=subprocess.DEVNULL).returncode
        result['restoreExit'] = code
        result['bridge'] = {'outside': bridge.stop()}
        bridge = None
        try:
            result['bridge']['inside'] = json.load(open(os.path.join(attempt, 'bridge-inside.json')))
        except (OSError, ValueError):
            result['bridge']['inside'] = None
        bridge_ok = all(b and b.get('loopError') is None and b.get('threadEnded') for b in result['bridge'].values())
        result['bridge']['ok'] = bridge_ok
        if not bridge_ok:
            result['error'] = 'a bridge loop failed or did not end'
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
            result['success'] = code == 0 and ok and bool(result['probes'] and result['probes']['isolated']) and bridge_ok
        result['originalSnapshotUnchanged'] = (not plan.get('originalSnapshot')) or not os.path.exists(plan['originalSnapshot']) or \
            sha256_file(plan['originalSnapshot']) == plan['originalSnapshotSha256']
        result['success'] = result['success'] and result['originalSnapshotUnchanged']
    except SystemExit as e:
        result['error'] = str(e)
    except Exception as e:  # noqa: BLE001 - report every harness failure as a failed result, never as success
        result['error'] = '%s: %s' % (type(e).__name__, e)
    finally:
        if bridge:
            result.setdefault('bridge', {'outside': bridge.stop()})
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
