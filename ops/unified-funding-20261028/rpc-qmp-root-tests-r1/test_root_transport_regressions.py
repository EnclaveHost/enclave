"""Root transport regressions. Authored only; run against frozen delivery after review."""
import errno
import json
import unittest
from unittest.mock import patch
import maint_boot as M

class Socket:
    def __init__(self, connect_error=None, greeting=None):
        self.closed = False
        self.connect_error = connect_error
        self.parts = [greeting if greeting is not None else json.dumps({'QMP': {'version': {'qemu': {'major': 9, 'minor': 0, 'micro': 0}, 'package': ''}, 'capabilities': []}}).encode() + b'\n']
        self.sent = bytearray()
        self.commands = []
        self.wrong_reply = False
    def settimeout(self, value):
        pass
    def connect(self, path):
        if self.connect_error:
            raise self.connect_error
    def close(self):
        self.closed = True
    def recv(self, count):
        if not self.parts:
            return b''
        part = self.parts.pop(0)
        if len(part) > count:
            self.parts.insert(0, part[count:])
        return part[:count]
    def send(self, data):
        self.sent.extend(data)
        while b'\n' in self.sent:
            line, rest = self.sent.split(b'\n', 1)
            self.sent = bytearray(rest)
            request = json.loads(line)
            self.commands.append(request)
            response = {'return': {'status': 'prelaunch'}, 'id': 'wrong-response' if self.wrong_reply else request.get('id')}
            self.parts.append(json.dumps(response).encode() + b'\n')
        return len(data)
    def sendall(self, data):
        self.send(data)

class RootTransport(unittest.TestCase):
    def test_connect_eagain_closes_failed_constructor(self):
        sock = Socket(connect_error=BlockingIOError(errno.EAGAIN, 'fixture connect'))
        with patch.object(M.socket, 'socket', return_value=sock):
            with self.assertRaises(Exception):
                M.QMP('/fixture-only/no-socket')
        self.assertTrue(sock.closed, 'failed QMP constructor must close its own socket')
        self.assertEqual(sock.commands, [])

    def test_partial_greeting_eof_closes_failed_constructor(self):
        sock = Socket(greeting=b'{"QMP":')
        with patch.object(M.socket, 'socket', return_value=sock):
            with self.assertRaises(Exception):
                M.QMP('/fixture-only/no-socket')
        self.assertTrue(sock.closed)
        self.assertEqual(sock.commands, [])

    def test_malformed_greeting_closes_failed_constructor(self):
        sock = Socket(greeting=b'null\n')
        with patch.object(M.socket, 'socket', return_value=sock):
            with self.assertRaises(Exception):
                M.QMP('/fixture-only/no-socket')
        self.assertTrue(sock.closed)

    def test_wrong_command_reply_never_satisfies_request_or_resends(self):
        sock = Socket()
        with patch.object(M.socket, 'socket', return_value=sock):
            q = M.QMP('/fixture-only/no-socket')
            try:
                sock.wrong_reply = True
                with self.assertRaises(Exception):
                    q.cmd('cont')
                self.assertEqual(sum(x['execute'] == 'cont' for x in sock.commands), 1)
            finally:
                sock.close()

if __name__ == '__main__':
    unittest.main()
