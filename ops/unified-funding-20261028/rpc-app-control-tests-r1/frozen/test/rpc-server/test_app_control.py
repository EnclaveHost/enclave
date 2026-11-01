"""Finite real TLS/process tests. Only generated keys and inert workers."""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import ssl
import subprocess
import sys
import time
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE/'rpc/server'))
import app_control as ac
import guarded_export as g

REQUEST = '12'*32
CONTRACT = '34'*32
GOOD = {'authenticated': True, 'availableMiB': 40000, 'pendingMiB': 1000, 'floorMiB': 27648, 'unreadUnits': 0}


def command(args):
    subprocess.run(args, check=True, capture_output=True, timeout=5)


def start_id(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    return raw[raw.rfind(')')+2:].split()[19]


def client(root, port, mode):
    ctx = ssl.create_default_context(cafile=str(root/'ca-cert.pem'))
    ctx.minimum_version = ctx.maximum_version = ssl.TLSVersion.TLSv1_3
    if mode != 'no-certificate':
        prefix = 'other' if mode == 'wrong-certificate' else 'client'
        ctx.load_cert_chain(str(root/(prefix+'-cert.pem')), str(root/(prefix+'-key.pem')))
    plain = socket.create_connection(('127.0.0.1', port), timeout=3)
    if mode == 'stalled-handshake':
        plain.settimeout(5)
        assert plain.recv(1) == b''
        return
    sock = plain
    hello = ac.HELLO + bytes.fromhex(REQUEST) + bytes.fromhex(CONTRACT)
    if mode == 'wrong-request':hello = ac.HELLO + bytes(32) + bytes.fromhex(CONTRACT)
    if mode == 'wrong-contract':hello = hello[:-32] + bytes(32)
    if mode == 'oversized':hello += b'x'
    try:
        sock = ctx.wrap_socket(plain, server_hostname='rpc-control.test')
        # Partial records must accumulate without opening the work gate early.
        sock.sendall(hello[:7]);time.sleep(.02);sock.sendall(hello[7:])
        expected = ac.BOUND + hashlib.sha256(hello).digest()
        received = b''
        while len(received) < len(expected):
            part = sock.recv(len(expected)-len(received))
            if not part:break
            received += part
        if mode in ('no-certificate', 'wrong-certificate', 'wrong-request', 'wrong-contract', 'oversized'):
            assert received != expected
            return
        assert received == expected
        until = time.monotonic()+3
        marker = root/'worker.json'
        while not marker.exists():
            assert time.monotonic() < until
            time.sleep(.005)
        rows = json.loads(marker.read_text())
        held = []
        try:
            for row in rows:
                fd = os.pidfd_open(row['pid']);held.append(fd)
                assert start_id(row['pid']) == row['start']
                assert not select.select([fd], [], [], 0)[0]
            began = time.monotonic()
            if mode == 'extra-data':sock.sendall(b'x')
            elif mode == 'deadline':pass
            else:sock.close()
            while len(select.select(held, [], [], .02)[0]) != len(held):
                assert time.monotonic()-began < 3
            (root/'death.json').write_text(json.dumps({'held': rows, 'seconds': time.monotonic()-began, 'allDead': True}))
        finally:
            for fd in held:os.close(fd)
    except (ssl.SSLError, ConnectionResetError, BrokenPipeError):
        if mode not in ('no-certificate', 'wrong-certificate', 'wrong-request', 'wrong-contract', 'oversized'):raise
    finally:
        sock.close()


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.umask(0o077)
        os.environ['OPENSSL_CONF'] = '/dev/null'
        cls.base = Path(os.environ['RPC_TEST_PRIVATE'])
        cls.base.mkdir(mode=0o700)
        cls.keys = cls.base/'keys';cls.keys.mkdir(mode=0o700)
        p = cls.keys
        command(['openssl', 'req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', str(p/'ca-key.pem'), '-out', str(p/'ca-cert.pem'), '-days', '1', '-subj', '/CN=inert-control-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
        for name, usage in [('server', 'serverAuth'), ('client', 'clientAuth'), ('other', 'clientAuth')]:
            command(['openssl', 'req', '-newkey', 'ed25519', '-nodes', '-keyout', str(p/(name+'-key.pem')), '-out', str(p/(name+'.csr')), '-subj', '/CN=rpc-control.test'])
            (p/(name+'.ext')).write_text('extendedKeyUsage='+usage+'\nsubjectAltName=DNS:rpc-control.test\n')
            command(['openssl', 'x509', '-req', '-in', str(p/(name+'.csr')), '-CA', str(p/'ca-cert.pem'), '-CAkey', str(p/'ca-key.pem'), '-CAcreateserial', '-out', str(p/(name+'-cert.pem')), '-days', '1', '-extfile', str(p/(name+'.ext'))])
        cls.sha = hashlib.sha256(ssl.PEM_cert_to_DER_cert((p/'client-cert.pem').read_text())).hexdigest()

    def run_case(self, mode, seconds=6, adopted=False, resource_delay=0):
        root = self.base/uuid.uuid4().hex;root.mkdir(mode=0o700)
        # Fixture-only credential copies; never preserve any of this directory.
        for path in self.keys.glob('*.pem'):(root/path.name).write_bytes(path.read_bytes())
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0));port = reserve.getsockname()[1]
        config = {'schema':'enclave-rpc-export-control/1', 'host':'127.0.0.1', 'port':port, 'tls':str(root), 'clientCertificateSha256':self.sha, 'requestSha256':REQUEST}
        deadline = time.monotonic()+seconds
        control = ac.AppControl(config, CONTRACT, deadline)
        process = subprocess.Popen([sys.executable, '-B', __file__, '--client', str(root), str(port), mode], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def worker(channel, _):
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            pid = os.fork()
            if pid == 0:
                while True:time.sleep(.05)
            # Atomic test marker precedes deliberately blocked preparation.
            rows = [{'pid':n, 'start':start_id(n)} for n in (os.getpid(), pid)]
            tmp = root/'worker.tmp';tmp.write_text(json.dumps(rows));tmp.rename(root/'worker.json')
            if adopted:channel.send(b'READY {}')
            while True:time.sleep(.05)
        argv = [sys.executable, '-c', 'import time;time.sleep('+repr(resource_delay)+');print('+repr(json.dumps(GOOD))+',flush=True)']
        try:
            result = g.guard(worker, argv, deadline, 27648, 512, lambda:None, lambda _:None, lambda:adopted, app_control=control)
            out, err = process.communicate(timeout=4)
            self.assertEqual(process.returncode, 0, err.decode())
        finally:
            control.close()
            if process.poll() is None:process.kill();process.wait(timeout=2)
        self.assertFalse(result['writersFenced']);self.assertFalse(result['reservationMayRelease'])
        return root, result

    def test_close_interrupts_blocked_owner_and_descendant(self):
        root, result = self.run_case('close')
        self.assertTrue(result['released']);self.assertFalse(result['ready'])
        self.assertEqual(result['reason'], 'app-control-lost');self.assertEqual(result['ownerExit'], -9)
        death = json.loads((root/'death.json').read_text())
        self.assertTrue(death['allDead']);self.assertLess(death['seconds'], 1.2)

    def test_additional_data_stops_exact_tree(self):
        root, result = self.run_case('extra-data')
        self.assertEqual(result['reason'], 'app-control-lost')
        self.assertTrue(json.loads((root/'death.json').read_text())['allDead'])

    def test_identity_and_request_refusals_never_release(self):
        for mode in ('no-certificate', 'wrong-certificate', 'wrong-request', 'wrong-contract', 'oversized'):
            with self.subTest(mode=mode):
                root, result = self.run_case(mode)
                self.assertFalse(result['released']);self.assertFalse((root/'worker.json').exists())
                self.assertEqual(result['reason'], 'app-control-lost')

    def test_handshake_timeout_keeps_work_gate_closed(self):
        root, result = self.run_case('stalled-handshake')
        self.assertFalse(result['released']);self.assertFalse((root/'worker.json').exists())
        self.assertEqual(result['reason'], 'app-control-lost')

    def test_adoption_cannot_extend_original_control_deadline(self):
        root, result = self.run_case('deadline', seconds=.8, adopted=True)
        self.assertTrue(result['adopted']);self.assertEqual(result['reason'], 'startup-deadline')
        self.assertTrue(json.loads((root/'death.json').read_text())['allDead'])

    def test_original_deadline_before_bind_never_releases(self):
        root, result = self.run_case('stalled-handshake', seconds=.3)
        self.assertFalse(result['released']);self.assertFalse((root/'worker.json').exists())
        self.assertEqual(result['reason'], 'startup-deadline')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--client':
        client(Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    else:unittest.main(verbosity=2)
