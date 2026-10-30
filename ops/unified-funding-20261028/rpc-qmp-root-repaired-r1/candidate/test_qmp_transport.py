"""Offline regression tests for the repaired QMP transport in maint_boot.py (the REAL QMP class, open_qmp and seams).
AUTHORED ONLY, NOT RUN by the source author. Fake sockets + a fake monotonic clock give exact deadline/remaining-time
assertions; the UnixFixture tests use one private AF_UNIX path in a TemporaryDirectory with finite timeouts and joins.
No QEMU, systemd, SSH, network, disk images or databases; no module-global monkeypatching."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import types
import unittest

HERE = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
M = load('maint_qmp_fixture', HERE / 'maint_boot.py')

GREETING = b'{"QMP": {"version": {"qemu": {"major": 9, "minor": 1, "micro": 0}, "package": ""}, "capabilities": ["oob"]}}\r\n'
EOF, BLOCK = object(), object()            # recv: peer closed (sticky) / send: blocks for the whole remaining timeout

def frame(obj):
    return json.dumps(obj).encode() + b'\r\n'
def ok(rid, ret=None):
    return frame({'return': {} if ret is None else ret, 'id': rid})
def error(rid, desc='fixture failure'):
    return frame({'error': {'class': 'GenericError', 'desc': desc}, 'id': rid})
def event(name, **data):
    return frame({'event': name, 'data': data, 'timestamp': {'seconds': 1, 'microseconds': 0}})
def name_of(n):
    return errno.errorcode[n]


class FakeClock:
    """fake monotonic clock: moves only via fake socket calls, sleep(), or `tick` per reading"""
    def __init__(self, t=1000.0, tick=0.0):
        self.t, self.tick, self.sleeps = t, tick, []
    def __call__(self):
        now = self.t
        self.t += self.tick
        return now
    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


class FakePeer:
    """scripted fake socket. recv() delivers queued items (bytes, an exception instance, EOF); an empty queue returns idle()
    if set, else behaves like a blocking recv that waits out its whole timeout. send() accepts send_caps[i] bytes (an int,
    BLOCK or an exception instance; default everything); each complete request line queues replies.pop(0)(req), else
    handler(req), else ok(id). Every connect/recv/send advances the clock by `step`."""
    def __init__(self, clock, rx=(), handler=None, step=0.0, connect_error=None, send_caps=(), idle=None):
        self.clock, self.rx, self.handler, self.step, self.connect_error = clock, list(rx), handler, step, connect_error
        self.send_caps, self.idle, self.replies = list(send_caps), idle, []
        self.timeouts, self.timeout, self.wire, self.requests, self.closes, self.recv_calls = [], None, b'', [], 0, 0

    def settimeout(self, t):
        self.timeout = t
        self.timeouts.append(t)

    def connect(self, path):
        self.clock.t += self.step
        if self.connect_error is not None:
            raise self.connect_error

    def recv(self, n):
        self.recv_calls += 1
        self.clock.t += self.step
        if not self.rx:
            if self.idle is not None:
                return self.idle()
            self.clock.t += self.timeout
            raise socket.timeout('timed out')
        item = self.rx[0]
        if item is EOF:
            return b''
        self.rx.pop(0)
        if isinstance(item, BaseException):
            raise item
        if len(item) > n:
            self.rx.insert(0, item[n:])
            item = item[:n]
        return item

    def send(self, data):
        self.clock.t += self.step
        cap = self.send_caps.pop(0) if self.send_caps else len(data)
        if cap is BLOCK:
            self.clock.t += self.timeout
            raise socket.timeout('timed out')
        if isinstance(cap, BaseException):
            raise cap
        chunk = bytes(data[:cap])
        self.wire += chunk
        while b'\n' in self.wire:
            line, self.wire = self.wire.split(b'\n', 1)
            req = json.loads(line)
            self.requests.append(req)
            if self.replies:
                self.rx.extend(self.replies.pop(0)(req))
            elif self.handler is not None:
                self.rx.extend(self.handler(req))
            else:
                self.rx.append(ok(req['id']))
        return len(chunk)

    def close(self):
        self.closes += 1


def open_fake(peer, clock, end=None):
    return M.QMP('/nonexistent/qmp.sock', end=clock() + 60 if end is None else end, clock=clock, sock=lambda: peer)


class Factory:
    """deadline-aware factory through the explicit seam; every attempt is the REAL QMP constructor over the next FakePeer"""
    DEADLINE_AWARE = True
    def __init__(self, peers):
        self.peers, self.made, self.ends = list(peers), [], []
    def __call__(self, path, *, end, clock):
        peer = self.peers.pop(0)
        self.made.append(peer)
        self.ends.append(end)
        return M.QMP(path, end=end, clock=clock, sock=lambda: peer)


class Constructor(unittest.TestCase):
    def test_success_assigns_ids_and_close_is_idempotent(self):
        clock = FakeClock(); peer = FakePeer(clock, rx=[GREETING])
        q = open_fake(peer, clock)
        self.assertEqual(peer.requests, [{'execute': 'qmp_capabilities', 'id': 'maint-1'}])
        peer.replies.append(lambda r: [ok(r['id'], {'status': 'prelaunch', 'running': False})])
        self.assertEqual(q.cmd('query-status'), {'status': 'prelaunch', 'running': False})
        self.assertEqual(peer.requests[1], {'execute': 'query-status', 'id': 'maint-2'})
        q.close(); q.close()
        self.assertEqual(peer.closes, 1)
        self.assertFalse(q.usable())
        with self.assertRaises(M.QMPError) as cm:
            q.cmd('query-status')
        self.assertEqual((cm.exception.op, cm.exception.sent, cm.exception.outcome), ('state', 'none', 'not-sent'))
        self.assertEqual(len(peer.requests), 2)

    def test_new_socket_closed_on_every_failing_path(self):
        cases = {
            'connect ENOENT': (dict(connect_error=FileNotFoundError(errno.ENOENT, 'x')), [], ('connect', 'connect')),
            'connect EACCES': (dict(connect_error=PermissionError(errno.EACCES, 'x')), [], ('connect', 'connect')),
            'greeting EOF': (dict(rx=[EOF]), [], ('greeting', 'eof')),
            'greeting partial EOF': (dict(rx=[GREETING[:20], EOF]), [], ('greeting', 'eof')),
            'greeting malformed': (dict(rx=[frame({'QMP': 'x'})]), [], ('greeting', 'envelope')),
            'greeting is an event': (dict(rx=[event('STOP')]), [], ('greeting', 'envelope')),
            'greeting not JSON': (dict(rx=[b'garbage\r\n']), [], ('greeting', 'decode')),
            'greeting recv EAGAIN': (dict(rx=[BlockingIOError(errno.EAGAIN, 'x')]), [], ('greeting', 'recv')),
            'greeting timeout': (dict(rx=[]), [], ('greeting', 'recv')),
            'capabilities send EAGAIN': (dict(rx=[GREETING], send_caps=[BlockingIOError(errno.EAGAIN, 'x')]), [],
                                         ('capabilities', 'send')),
            'capabilities error reply': (dict(rx=[GREETING]), [lambda r: [error(r['id'])]], ('capabilities', 'reply')),
            'capabilities wrong id': (dict(rx=[GREETING]), [lambda r: [ok('maint-9')]], ('capabilities', 'correlate')),
            'capabilities no reply': (dict(rx=[GREETING]), [lambda r: []], ('capabilities', 'recv')),
            'capabilities EOF': (dict(rx=[GREETING]), [lambda r: [EOF]], ('capabilities', 'eof')),
        }
        for label, (kw, replies, where) in cases.items():
            with self.subTest(label):
                clock = FakeClock(); peer = FakePeer(clock, **kw); peer.replies.extend(replies)
                with self.assertRaises(M.QMPError) as cm:
                    open_fake(peer, clock)
                self.assertEqual((cm.exception.stage, cm.exception.op), where)
                self.assertEqual(peer.closes, 1)

    def test_socket_creation_failure_and_later_non_oserror_exception(self):
        def nofd():
            raise OSError(errno.EMFILE, 'x')
        with self.assertRaises(M.QMPError) as cm:
            M.QMP('/nonexistent/qmp.sock', end=10.0, clock=FakeClock(0.0), sock=nofd)
        self.assertEqual((cm.exception.stage, cm.exception.op, cm.exception.errno), ('connect', 'socket', errno.EMFILE))
        clock = FakeClock(); peer = FakePeer(clock, rx=[KeyboardInterrupt()])   # any later initialization exception
        with self.assertRaises(KeyboardInterrupt):
            open_fake(peer, clock)
        self.assertEqual(peer.closes, 1)

    def test_close_error_never_raises(self):
        clock = FakeClock(); peer = FakePeer(clock, rx=[GREETING])
        q = open_fake(peer, clock)
        def bad_close():
            raise OSError(errno.EBADF, 'x')
        peer.close = bad_close
        q.close(); q.close()
        self.assertEqual(q.stats()['closeErrno'], name_of(errno.EBADF))


class Classification(unittest.TestCase):
    def test_eagain_classified_by_actual_phase(self):
        clock = FakeClock()
        cases = [
            (FakePeer(clock, connect_error=BlockingIOError(errno.EAGAIN, 'x')), None, ('connect', 'connect')),
            (FakePeer(clock, rx=[BlockingIOError(errno.EAGAIN, 'x')]), None, ('greeting', 'recv')),
            (FakePeer(clock, rx=[GREETING], send_caps=[BlockingIOError(errno.EAGAIN, 'x')]), None, ('capabilities', 'send')),
            (FakePeer(clock, rx=[GREETING]), lambda r: [BlockingIOError(errno.EAGAIN, 'x')], ('capabilities', 'recv')),
        ]
        for peer, reply, where in cases:
            with self.subTest(where):
                if reply:
                    peer.replies.append(reply)
                with self.assertRaises(M.QMPError) as cm:
                    open_fake(peer, clock)
                e = cm.exception
                self.assertEqual((e.stage, e.op, e.errno, e.expired), (*where, errno.EAGAIN, False))
                self.assertEqual(e.diag()['errnoName'], name_of(errno.EAGAIN))
        clock = FakeClock(); peer = FakePeer(clock, rx=[GREETING]); q = open_fake(peer, clock)
        peer.send_caps.append(BlockingIOError(errno.EAGAIN, 'x'))
        with self.assertRaises(M.QMPError) as cm:
            q.cmd('query-status')
        self.assertEqual((cm.exception.stage, cm.exception.op, cm.exception.sent), ('command', 'send', 'none'))
        clock2 = FakeClock(); peer2 = FakePeer(clock2, rx=[GREETING]); q2 = open_fake(peer2, clock2)
        peer2.replies.append(lambda r: [BlockingIOError(errno.EAGAIN, 'x')])
        with self.assertRaises(M.QMPError) as cm:
            q2.cmd('query-status')
        self.assertEqual((cm.exception.stage, cm.exception.op, cm.exception.sent), ('command', 'recv', 'full'))
        self.assertEqual(len(peer2.requests), 2)                  # no retry/resend of the command

    def test_eintr_retries_are_capped_against_the_same_end(self):
        clock = FakeClock(); peer = FakePeer(clock, rx=[GREETING]); q = open_fake(peer, clock)
        peer.replies.append(lambda r: [InterruptedError(errno.EINTR, 'x') for _ in range(20)])
        before = peer.recv_calls
        with self.assertRaises(M.QMPError) as cm:
            q.cmd('query-status')
        self.assertEqual(peer.recv_calls - before, M.QMP_EINTR_MAX)
        self.assertEqual((cm.exception.op, cm.exception.errno), ('recv', errno.EINTR))
        self.assertFalse(q.usable())


class Deadlines(unittest.TestCase):
    def test_dribbling_greeting_cannot_reset_the_readiness_end(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[bytes([b]) for b in GREETING], step=1.0)
        with self.assertRaises(M.QMPError) as cm:
            open_fake(peer, clock, end=1005.0)
        self.assertEqual((cm.exception.stage, cm.exception.op, cm.exception.expired), ('greeting', 'deadline', True))
        self.assertEqual(peer.timeouts, [5.0, 4.0, 3.0, 2.0, 1.0])
        self.assertEqual(peer.recv_calls, 4)
        self.assertEqual(clock.t, 1005.0)
        self.assertEqual(peer.closes, 1)

    def test_greeting_and_capabilities_share_one_end(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING], step=1.0)
        reply = ok('maint-1')
        peer.replies.append(lambda r: [reply[i:i + 1] for i in range(len(reply))])
        with self.assertRaises(M.QMPError) as cm:
            open_fake(peer, clock, end=1006.0)
        e = cm.exception
        self.assertEqual((e.stage, e.op, e.command, e.rid, e.sent, e.outcome),
                         ('capabilities', 'deadline', 'qmp_capabilities', 'maint-1', 'full', 'unknown'))
        self.assertEqual(peer.timeouts, [6.0, 5.0, 4.0, 3.0, 2.0, 1.0])
        self.assertEqual(peer.closes, 1)

    def test_command_end_is_constrained_by_the_caller_end(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING]); q = open_fake(peer, clock)
        peer.replies.append(lambda r: [])
        peer.timeouts.clear()
        with self.assertRaises(M.QMPError) as cm:
            q.cmd('query-status', 1007.5)
        self.assertEqual(peer.timeouts, [7.5, 7.5])                # send, then recv with the remaining 7.5 (not 30)
        self.assertEqual(clock.t, 1007.5)
        self.assertTrue(cm.exception.expired)
        peer2 = FakePeer(clock, rx=[GREETING]); q2 = open_fake(peer2, clock)
        peer2.replies.append(lambda r: []); peer2.timeouts.clear()
        with self.assertRaises(M.QMPError):
            q2.cmd('query-status', clock() + 500)                  # a later caller end never widens QMP_CMD_S
        self.assertEqual(peer2.timeouts, [float(M.QMP_CMD_S)] * 2)

    def test_buffered_event_flood_cannot_extend_the_command_end(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING]); q = open_fake(peer, clock)
        flood = b''.join(event('RTC_CHANGE', offset=i) for i in range(1000))
        peer.replies.append(lambda r: [flood + ok(r['id'])])
        clock.tick = 1.0
        start = clock.t
        with self.assertRaises(M.QMPError) as cm:
            q.cmd('query-status')
        self.assertEqual((cm.exception.op, cm.exception.outcome), ('deadline', 'unknown'))
        self.assertLessEqual(clock.t, start + M.QMP_CMD_S + 1)
        self.assertLess(q.events_seen, 1000)
        self.assertLessEqual(len(q.recent), M.QMP_EVENTS_KEEP)
        self.assertEqual(list(q.abandoned), ['maint-2'])

    def test_pump_window_never_passes_the_outer_end(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING]); q = open_fake(peer, clock)
        peer.timeouts.clear()
        self.assertTrue(q.pump(1, 1000.5))
        self.assertEqual((peer.timeouts, clock.t), ([0.5], 1000.5))
        calls = peer.recv_calls
        self.assertTrue(q.pump(1, 1000.5))                          # end reached == expired: no recv at all
        self.assertEqual(peer.recv_calls, calls)
        peer.rx.append(b'{"ev')                                     # dribbled partial frame: window ends, bytes stay buffered
        self.assertTrue(q.pump(1, clock() + 3))
        self.assertEqual((q.buf, clock.t), (b'{"ev', 1001.5))
        self.assertTrue(q.usable())


class Framing(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(); self.peer = FakePeer(self.clock, rx=[GREETING])
        self.q = open_fake(self.peer, self.clock)

    def fails(self, items, op, cmd='query-status'):
        self.peer.replies.append(lambda r: items(r) if callable(items) else items)
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd(cmd)
        self.assertEqual(cm.exception.op, op)
        return cm.exception

    def test_overlong_frame_without_newline_bounded(self):
        before = self.peer.recv_calls
        self.fails([b'{"return": "' + b'x' * (M.QMP_FRAME_MAX + 10)], 'frame')
        self.assertEqual(self.peer.recv_calls - before, M.QMP_FRAME_MAX // M.QMP_RECV + 1)
        self.assertLessEqual(len(self.q.buf), M.QMP_FRAME_MAX + M.QMP_RECV)
        self.assertFalse(self.q.usable())

    def test_overlong_frame_with_newline_refused(self):
        self.fails([b'"' + b'x' * M.QMP_FRAME_MAX + b'"\n'], 'frame')

    def test_eof_inside_a_frame(self):
        e = self.fails([b'{"return": {}, "id": "ma', EOF], 'eof')
        self.assertEqual((e.sent, e.outcome, self.q.trailing, self.q.eof), ('full', 'unknown', 24, True))
        self.assertFalse(self.q.pump(1))

    def test_clean_eof_before_reply(self):
        e = self.fails([EOF], 'eof')
        self.assertEqual((e.outcome, self.q.eof, self.q.broken), ('unknown', True, None))

    def test_malformed_frames_fail_closed(self):
        cases = {'not an object': ([b'[1, 2]\n'], 'envelope'), 'not JSON': ([b'{nope\n'], 'decode'),
                 'integer id': ([frame({'return': {}, 'id': 2})], 'envelope'),
                 'no id': ([frame({'return': {}})], 'envelope'),
                 'return and error': (lambda r: [frame({'return': {}, 'error': {}, 'id': r['id']})], 'envelope'),
                 'bad error body': (lambda r: [frame({'error': 'x', 'id': r['id']})], 'envelope'),
                 'bad event name': ([frame({'event': 'not upper'})], 'event'),
                 'event with id': (lambda r: [frame({'event': 'STOP', 'id': r['id']})], 'event'),
                 'event data not object': ([frame({'event': 'SHUTDOWN', 'data': [True]})], 'event'),
                 'invalid utf-8': ([b'{"return": "\xff", "id": "maint-2"}\n'], 'decode')}
        for label, (items, op) in cases.items():
            with self.subTest(label):
                self.setUp()
                self.fails(items, op)
                self.assertFalse(self.q.usable())
                with self.assertRaises(M.QMPError):
                    self.q.cmd('query-status')
                self.assertEqual(len(self.peer.requests), 2)        # nothing sent on a fail-closed connection


class Correlation(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(); self.peer = FakePeer(self.clock, rx=[GREETING])
        self.q = open_fake(self.peer, self.clock)

    def test_interleaved_events_then_matching_reply(self):
        self.peer.replies.append(lambda r: [event('RTC_CHANGE', offset=1), event('STOP'), ok(r['id'], {'x': 1})])
        self.assertEqual(self.q.cmd('query-status'), {'x': 1})
        self.assertEqual(self.q.events_seen, 2)

    def test_mismatched_id_never_satisfies_the_request(self):
        self.peer.replies.append(lambda r: [ok('maint-99', {'status': 'running'})])
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('query-status')
        self.assertEqual(cm.exception.op, 'correlate')
        self.assertNotIn('maint-99', str(cm.exception))           # peer-chosen ids are not echoed into messages

    def test_duplicate_reply_cannot_satisfy_a_later_command(self):
        self.peer.replies.append(lambda r: [ok(r['id'], {'n': 1}), ok(r['id'], {'n': 1})])
        self.assertEqual(self.q.cmd('query-status'), {'n': 1})
        self.peer.replies.append(lambda r: [ok(r['id'], {'n': 2})])
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('query-status')
        self.assertEqual(cm.exception.op, 'correlate')

    def test_correlated_error_is_rejected_bounded_and_keeps_the_connection(self):
        self.peer.replies.append(lambda r: [error(r['id'], 'y' * 5000)])
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('cont')
        self.assertEqual((cm.exception.op, cm.exception.outcome), ('reply', 'rejected'))
        self.assertLess(len(str(cm.exception)), 400)
        self.assertEqual(self.q.uncertain, {})
        self.assertTrue(self.q.usable())
        self.assertEqual(self.q.cmd('query-status'), {})

    def test_late_reply_to_abandoned_id_absorbed_once(self):
        self.peer.replies.append(lambda r: [])
        with self.assertRaises(M.QMPError):
            self.q.cmd('query-status')
        self.assertEqual(self.q.abandoned, {'maint-2': 'query-status'})
        self.peer.replies.append(lambda r: [ok('maint-2', {'status': 'stale'}), ok(r['id'], {'status': 'running'})])
        self.assertEqual(self.q.cmd('query-status'), {'status': 'running'})
        self.assertEqual((self.q.abandoned, self.q.late), ({}, {'maint-2': 'return'}))
        self.peer.replies.append(lambda r: [ok('maint-2'), ok(r['id'])])
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('query-status')
        self.assertEqual(cm.exception.op, 'correlate')

    def test_unsolicited_reply_during_pump_fails_closed(self):
        self.peer.rx.append(ok('maint-7'))
        with self.assertRaises(M.QMPError) as cm:
            self.q.pump(1)
        self.assertEqual((cm.exception.stage, cm.exception.op), ('pump', 'correlate'))
        with self.assertRaises(M.QMPError):
            self.q.pump(1)

    def test_abandoned_ids_are_bounded(self):
        for _ in range(M.QMP_ABANDONED_MAX + 1):
            self.peer.replies.append(lambda r: [])
            with self.assertRaises(M.QMPError):
                self.q.cmd('query-status')
        self.assertEqual(self.q.broken, 'too many unanswered requests')
        self.assertFalse(self.q.usable())


class SendOutcome(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(); self.peer = FakePeer(self.clock, rx=[GREETING])
        self.q = open_fake(self.peer, self.clock)

    def test_partial_send_then_block_is_unknown_and_never_replayed(self):
        self.peer.send_caps.extend([5, BLOCK]); self.peer.timeouts.clear(); start = self.clock.t
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('cont')
        e = cm.exception
        self.assertEqual((e.op, e.expired, e.sent, e.outcome), ('send', True, 'partial', 'unknown'))
        self.assertEqual(self.peer.timeouts, [30.0, 30.0])
        self.assertEqual(self.clock.t, start + M.QMP_CMD_S)
        self.assertEqual(self.peer.wire, b'{"exe')
        self.assertEqual(self.q.uncertain, {'cont': 'maint-2'})
        with self.assertRaises(M.QMPError):
            self.q.cmd('cont')
        self.assertEqual(self.peer.wire, b'{"exe')
        self.assertEqual([r for r in self.peer.requests if r['execute'] == 'cont'], [])

    def test_blocked_send_with_nothing_written_is_not_sent(self):
        self.peer.send_caps.append(BLOCK)
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('cont')
        self.assertEqual((cm.exception.sent, cm.exception.outcome), ('none', 'not-sent'))
        self.assertEqual((self.q.uncertain, self.q.abandoned, self.q.broken), ({}, {}, None))
        self.assertEqual(self.q.cmd('query-status'), {})
        self.assertEqual(self.peer.requests[-1]['id'], 'maint-3')   # ids are never reused

    def test_full_send_without_reply_is_unknown_and_sent_once(self):
        self.peer.replies.append(lambda r: [])
        with self.assertRaises(M.QMPError) as cm:
            self.q.cmd('system_powerdown')
        self.assertEqual((cm.exception.op, cm.exception.sent, cm.exception.outcome), ('recv', 'full', 'unknown'))
        self.assertEqual(self.q.uncertain, {'system_powerdown': 'maint-2'})
        self.assertEqual([r['execute'] for r in self.peer.requests].count('system_powerdown'), 1)


class ShutdownEvidence(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock(); self.peer = FakePeer(self.clock, rx=[GREETING])
        self.q = open_fake(self.peer, self.clock)

    def pump_all(self, frames):
        self.peer.rx.append(b''.join(frames))
        for _ in frames:
            self.assertTrue(self.q.pump(1))

    def test_guest_true_evidence_survives_retention_cap(self):
        self.pump_all([event('SHUTDOWN', guest=False, reason='host-signal'), event('SHUTDOWN', guest=True, reason='guest-shutdown')]
                      + [event('RTC_CHANGE', offset=i) for i in range(200)])
        self.assertEqual((self.q.events_seen, len(self.q.recent), self.q.events_dropped), (202, M.QMP_EVENTS_KEEP, 138))
        self.assertTrue(M.guest_shutdown_seen(self.q))
        self.assertEqual(self.q.events[0], {'event': 'SHUTDOWN', 'data': {'guest': True, 'reason': 'guest-shutdown'}})
        self.assertEqual(len(self.q.events), M.QMP_EVENTS_KEEP + 1)

    def test_guest_false_or_non_boolean_is_insufficient(self):
        self.pump_all([event('SHUTDOWN', guest=False), event('SHUTDOWN', guest='true'), event('SHUTDOWN')]
                      + [event('RTC_CHANGE', offset=i) for i in range(100)])
        self.assertFalse(M.guest_shutdown_seen(self.q))
        self.assertIsNone(self.q.shutdown_guest)

    def test_late_guest_true_kept_once_and_payload_not_retained(self):
        self.pump_all([event('RTC_CHANGE', offset=i, secret='x' * 100) for i in range(100)]
                      + [event('SHUTDOWN', guest=True, reason='Not A Reason', extra='x' * 100)])
        self.assertTrue(M.guest_shutdown_seen(self.q))
        self.assertEqual(len(self.q.events), M.QMP_EVENTS_KEEP)
        self.assertEqual(self.q.events[-1], {'event': 'SHUTDOWN', 'data': {'guest': True}})
        self.assertNotIn('secret', json.dumps(self.q.events))


class Readiness(unittest.TestCase):
    PLAN = {'unit': 'enclave-rpc-maint-fixture.service', 'runDir': '/nonexistent-fixture-run'}

    def ctx(self, clock, peers, active='active'):
        calls = []
        def run(argv, **kw):
            calls.append(argv)
            return types.SimpleNamespace(returncode=0, stdout=f'ActiveState={active}\nInvocationID=ours\n'.encode(), stderr=b'')
        f = Factory(peers)
        return M.Ctx(run=run, qmp=f, clock=clock, sleep=clock.sleep), f, calls

    def test_connect_not_ready_retried_within_one_end(self):
        clock = FakeClock(1000.0)
        bad = [FakePeer(clock, connect_error=x) for x in (BlockingIOError(errno.EAGAIN, 'x'),
               ConnectionRefusedError(errno.ECONNREFUSED, 'x'), FileNotFoundError(errno.ENOENT, 'x'))]
        good = FakePeer(clock, rx=[GREETING])
        c, f, calls = self.ctx(clock, bad + [good])
        t = M.Trace()
        q = M.open_qmp(c, self.PLAN, 1180.0, t)
        self.assertTrue(q.usable())
        self.assertEqual(t.readiness, {'attempts': 4, 'sleeps': 3, 'connectErrnos': {
            name_of(errno.EAGAIN): 1, name_of(errno.ECONNREFUSED): 1, name_of(errno.ENOENT): 1}})
        self.assertEqual(clock.sleeps, [1, 1, 1])
        self.assertEqual([p.closes for p in bad + [good]], [1, 1, 1, 0])
        self.assertEqual(f.ends, [1180.0] * 4)
        self.assertEqual(len(calls), 3)                              # owned-unit state checked after every failed connect

    def test_absolute_end_across_attempts(self):
        clock = FakeClock(1000.0)
        peers = [FakePeer(clock, connect_error=BlockingIOError(errno.EAGAIN, 'x')) for _ in range(4)]
        c, f, _ = self.ctx(clock, peers)
        t = M.Trace()
        with self.assertRaises(M.QMPError) as cm:
            M.open_qmp(c, self.PLAN, 1002.5, t)
        self.assertEqual((cm.exception.stage, cm.exception.op), ('connect', 'deadline'))
        self.assertEqual(clock.sleeps, [1, 1, 0.5])
        self.assertEqual(clock.t, 1002.5)
        self.assertEqual([p.timeouts for p in peers], [[2.5], [1.5], [0.5], []])
        self.assertEqual([p.closes for p in peers], [1, 1, 1, 1])
        self.assertEqual(t.readiness['attempts'], 4)

    def test_no_retry_outside_connect(self):
        cases = {'greeting EAGAIN': dict(rx=[BlockingIOError(errno.EAGAIN, 'x')]),
                 'connect EACCES': dict(connect_error=PermissionError(errno.EACCES, 'x')),
                 'malformed greeting': dict(rx=[frame({'QMP': {}})]),
                 'greeting timeout': dict(rx=[])}
        for label, kw in cases.items():
            with self.subTest(label):
                clock = FakeClock(1000.0)
                first, spare = FakePeer(clock, **kw), FakePeer(clock, rx=[GREETING])
                c, f, calls = self.ctx(clock, [first, spare])
                t = M.Trace()
                with self.assertRaises(M.QMPError):
                    M.open_qmp(c, self.PLAN, 1180.0, t)
                self.assertEqual((f.made, calls, clock.sleeps, first.closes), ([first], [], [], 1))
                self.assertEqual(t.readiness['attempts'], 1)
                self.assertLessEqual(clock.t, 1180.0)

    def test_inactive_owned_unit_stops_retrying(self):
        clock = FakeClock(1000.0)
        c, f, calls = self.ctx(clock, [FakePeer(clock, connect_error=FileNotFoundError(errno.ENOENT, 'x'))], active='failed')
        with self.assertRaises(M.QMPError) as cm:
            M.open_qmp(c, self.PLAN, 1180.0, M.Trace())
        self.assertEqual(cm.exception.op, 'unit-inactive')
        self.assertEqual(clock.sleeps, [])

    def test_legacy_factory_seam(self):
        clock, seen = FakeClock(1000.0), []
        def legacy(path):                                           # no DEADLINE_AWARE: called as factory(path) only
            seen.append(path)
            if len(seen) == 1:
                raise FileNotFoundError(errno.ENOENT, 'x')
            if len(seen) == 2:
                return 'fixture-connection'
        c, _, _ = self.ctx(clock, [])
        c.qmp = legacy
        self.assertEqual(M.open_qmp(c, self.PLAN, 1180.0, M.Trace()), 'fixture-connection')
        def legacy_timeout(path):
            raise TimeoutError('x')
        c.qmp = legacy_timeout
        with self.assertRaises(TimeoutError):                       # ambiguous: not retried
            M.open_qmp(c, self.PLAN, 1180.0, M.Trace())


def fds():
    return len(os.listdir('/proc/self/fd'))


class UnixFixture:
    """ONE private AF_UNIX listener in a TemporaryDirectory serving one connection with `serve(conn, requests)`;
    5 s socket timeouts, 10 s join; close() is idempotent"""
    def __init__(self, serve):
        self.tmp = tempfile.TemporaryDirectory()
        self.path, self.error, self.requests, self.done = os.path.join(self.tmp.name, 'qmp.sock'), None, [], False
        self.ls = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.ls.bind(self.path); self.ls.listen(1); self.ls.settimeout(5)
        self.th = threading.Thread(target=self._run, args=(serve,), daemon=True)
        self.th.start()

    def _run(self, serve):
        try:
            conn, _ = self.ls.accept()
            with conn:
                conn.settimeout(5)
                serve(conn, self)
        except Exception as e:
            self.error = e

    def read(self, conn, buf):
        while b'\n' not in buf[0]:
            chunk = conn.recv(4096)
            if not chunk:
                raise EOFError('client closed')
            buf[0] += chunk
        line, buf[0] = buf[0].split(b'\n', 1)
        req = json.loads(line); self.requests.append(req)
        return req

    def close(self):
        if not self.done:
            self.done = True
            self.th.join(10); self.ls.close(); self.tmp.cleanup()


class RealUnixSocket(unittest.TestCase):
    def test_framing_events_correlation_and_eof(self):
        def serve(conn, srv):
            buf = [b'']
            conn.sendall(GREETING)
            conn.sendall(ok(srv.read(conn, buf)['id']))
            rid = srv.read(conn, buf)['id']
            conn.sendall(event('RTC_CHANGE', offset=1) + ok(rid, {'status': 'prelaunch', 'running': False})[:7])
            conn.sendall(ok(rid, {'status': 'prelaunch', 'running': False})[7:])
            rid = srv.read(conn, buf)['id']
            conn.sendall(ok(rid) + event('SHUTDOWN', guest=True, reason='guest-shutdown'))
        srv = UnixFixture(serve); self.addCleanup(srv.close)
        q = M.QMP(srv.path, end=time.monotonic() + 10)
        self.assertEqual(q.cmd('query-status'), {'status': 'prelaunch', 'running': False})
        self.assertEqual(q.cmd('system_powerdown'), {})
        end = time.monotonic() + 10
        while time.monotonic() < end and q.pump(1, end):
            pass
        self.assertTrue(q.eof)
        self.assertTrue(M.guest_shutdown_seen(q))
        q.close(); q.close()
        srv.close()
        self.assertIsNone(srv.error)
        self.assertEqual([r['id'] for r in srv.requests], ['maint-1', 'maint-2', 'maint-3'])

    def test_constructor_failures_leave_no_descriptor(self):
        def partial_greeting(conn, srv):
            conn.sendall(GREETING[:15])
        def wrong_id(conn, srv):
            conn.sendall(GREETING); srv.read(conn, [b'']); conn.sendall(ok('maint-7'))
            conn.recv(1)                                            # until the client closes (bounded by the 5 s timeout)
        for serve, where in ((partial_greeting, ('greeting', 'eof')), (wrong_id, ('capabilities', 'correlate'))):
            with self.subTest(where):
                before = fds()
                srv = UnixFixture(serve)
                with self.assertRaises(M.QMPError) as cm:
                    M.QMP(srv.path, end=time.monotonic() + 5)
                self.assertEqual((cm.exception.stage, cm.exception.op), where)
                srv.close()
                self.assertEqual(fds(), before)

    def test_repeated_connect_failure_no_descriptor_growth(self):
        with tempfile.TemporaryDirectory() as d:
            before = fds()
            for _ in range(50):
                with self.assertRaises(M.QMPError) as cm:
                    M.QMP(os.path.join(d, 'absent.sock'), end=time.monotonic() + 5)
                self.assertEqual((cm.exception.stage, cm.exception.op, cm.exception.errno), ('connect', 'connect', errno.ENOENT))
            self.assertEqual(fds(), before)

    def test_dribbling_real_peer_bounded_by_one_end(self):
        def dribble(conn, srv):
            try:
                for b in GREETING:
                    conn.sendall(bytes([b])); time.sleep(0.05)
            except OSError:
                pass                                                # the client gave up and closed
        srv = UnixFixture(dribble); self.addCleanup(srv.close)
        start = time.monotonic()
        with self.assertRaises(M.QMPError) as cm:
            M.QMP(srv.path, end=start + 0.3)
        self.assertTrue(cm.exception.expired)
        self.assertLess(time.monotonic() - start, 2.0)


if __name__ == '__main__': unittest.main()
