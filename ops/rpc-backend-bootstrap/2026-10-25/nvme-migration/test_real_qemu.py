#!/usr/bin/python3 -I
"""Real-QEMU checks (installed 11.1.2), no guest OS, disposable files only (< 64 MiB):
 1. guard_loop over the REAL second QMP monitor (-chardev/-mon exactly as qemu_argv v2 renders it) pauses ONLY that
    QEMU, which the main QMP monitor then reports as paused; powerdown's floor watch pauses too.
 2. the production blockdev() JSON with discard='unmap' really returns host blocks on guest discard (qcow2 -> file)."""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.abspath(os.environ.get('PROVISION_VM_LAUNCHER') or os.path.join(HERE, '..', 'provision_vm.py'))
spec = importlib.util.spec_from_file_location('pv_real', LAUNCHER)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
MIB = 1 << 20


def wait_sock(path):
    for _ in range(200):
        if os.path.exists(path):
            return
        time.sleep(0.05)
    raise AssertionError(f'{path} never appeared')


class GuardOnRealQemu(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='gq-', dir='/tmp')          # short unix socket paths
        self.main, self.guard = os.path.join(self.d, 'qmp.sock'), os.path.join(self.d, 'guard-qmp.sock')
        self.q = subprocess.Popen(['/usr/bin/qemu-system-x86_64', '-machine', 'none', '-nodefaults', '-display', 'none',
                                   '-S', '-qmp', f'unix:{self.main},server=on,wait=off',
                                   '-chardev', f'socket,id=qmpg,path={self.guard},server=on,wait=off',
                                   '-mon', 'chardev=qmpg,mode=control'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        wait_sock(self.main)
        wait_sock(self.guard)
        self.ops = pv.Qmp(self.main)
        self.ops.cmd('cont')
        self.assertEqual(self.ops.cmd('query-status')['status'], 'running')

    def tearDown(self):
        self.q.kill()
        self.q.wait()
        shutil.rmtree(self.d, ignore_errors=True)

    def m(self):
        cap = {'floorBytes': 300, 'pauseMarginBytes': 64, 'shutdownMarginBytes': 100, 'startHeadroomBytes': 20,
               'shutdownLeadSeconds': 2400, 'pollSeconds': 1}
        b = {'kind': 'nvme', 'growth': 'bounded', 'mount': '/x', 'dir': '/x/y', 'capacity': cap}
        return {'format': pv.FORMAT_V2, 'backings': {'nvme': b}, 'disks': {'l1': {'backing': 'nvme'}},
                'paths': {'guardQmp': self.guard, 'qmp': self.main, 'guardMode': os.path.join(self.d, 'mode.json')}}

    def test_guard_pauses_via_second_monitor(self):
        m = self.m()
        frees = iter([10**6, 400, 360])
        notes = []

        class IO(pv.GuardIO):
            def check(self, b):
                pass

            def free(self, mount):
                return next(frees)

            def notify(self, msg):
                notes.append(msg)

            def status(self, obj):
                notes.append(obj['state'])

            def sleep(self, s):
                time.sleep(0.05)
        rc = pv.guard_loop(m, 'S', IO(m), max_loops=3)
        self.assertIsNone(rc)
        self.assertEqual([n for n in notes if n in ('armed', 'shutdown-requested', 'paused')],
                         ['armed', 'shutdown-requested', 'paused'])
        self.assertEqual(self.ops.cmd('query-status')['status'], 'paused')   # seen on the OTHER monitor

    def test_powerdown_floor_watch_pauses_from_manifest(self):
        m = self.m()
        self.ops.close()
        m.update(uid=os.getuid())
        path = os.path.join(self.d, 'manifest.json')
        real_load, real_free = pv.load_manifest, pv.fs_free
        pv.load_manifest = lambda p, want_sha=None: (m, 'S')
        pv.fs_free = lambda mount: 364
        try:
            rc = pv.cmd_powerdown(path, wait_s=20)
        finally:
            pv.load_manifest, pv.fs_free = real_load, real_free
        self.assertEqual(rc, 1)
        ops = pv.Qmp(self.guard)               # the main monitor is still held by powerdown's (exited) connection
        self.assertEqual(ops.cmd('query-status')['status'], 'paused')
        ops.close()


class DiscardUnmap(unittest.TestCase):
    def test_production_blockdev_unmap_frees_host_blocks(self):
        d = tempfile.mkdtemp(prefix='du-', dir='/tmp')
        img = os.path.join(d, 'l1.qcow2')
        subprocess.run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-o',
                        'compat=1.1,preallocation=off,lazy_refcounts=off', img, str(64 * MIB)], check=True)
        qmp, nbd = os.path.join(d, 'q.sock'), os.path.join(d, 'n.sock')
        qsd = subprocess.Popen(['/usr/bin/qemu-storage-daemon', '--chardev', f'socket,id=m0,path={qmp},server=on,wait=off',
                                '--monitor', 'chardev=m0', '--blockdev', pv.blockdev('l10', 'qcow2', img, discard='unmap'),
                                '--nbd-server', f'addr.type=unix,addr.path={nbd}',
                                '--export', 'type=nbd,id=e0,node-name=l10,writable=on'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            wait_sock(nbd)
            uri = f'nbd+unix:///l10?socket={nbd}'
            io = lambda *c: subprocess.run(['/usr/bin/qemu-io', '-f', 'raw'] + sum([['-c', x] for x in c], []) + [uri],
                                           check=True, capture_output=True, text=True).stdout
            io('write -P 0x77 0 16M', 'flush')
            full = os.stat(img).st_blocks * 512
            io('discard 0 16M', 'flush')
            after = os.stat(img).st_blocks * 512
            self.assertIn('read', io('read -P 0 0 16M'))
            print(json.dumps({'allocatedAfterWrite': full, 'allocatedAfterDiscard': after}))
            self.assertGreater(full, 16 * MIB)
            self.assertLess(after, full - 15 * MIB)               # host blocks returned through qcow2 -> file
        finally:
            qsd.kill()
            qsd.wait()
            shutil.rmtree(d, ignore_errors=True)


class PowerdownRegression(unittest.TestCase):
    """ExecStop regression: an explicit socket timeout followed by QMP events must not end the wait; EOF = clean exit."""

    def manifest(self, d, qmp, guard):
        cap = {'floorBytes': 300, 'pauseMarginBytes': 64, 'shutdownMarginBytes': 100, 'startHeadroomBytes': 20,
               'shutdownLeadSeconds': 2400, 'pollSeconds': 1}
        return {'format': pv.FORMAT_V2, 'uid': os.getuid(),
                'backings': {'nvme': {'kind': 'nvme', 'growth': 'bounded', 'mount': '/x', 'dir': '/x/y', 'capacity': cap}},
                'disks': {'l1': {'backing': 'nvme'}},
                'paths': {'qmp': qmp, 'guardQmp': guard, 'guardMode': os.path.join(d, 'mode.json')}}

    def run_powerdown(self, m):
        real_load, real_free = pv.load_manifest, pv.fs_free
        pv.load_manifest = lambda p, want_sha=None: (m, 'S')
        pv.fs_free = lambda mount: 10**15
        try:
            return pv.cmd_powerdown('/unused', wait_s=60)
        finally:
            pv.load_manifest, pv.fs_free = real_load, real_free

    def test_timeout_then_events_then_eof(self):
        import socket
        import threading
        d = tempfile.mkdtemp(prefix='pr-', dir='/tmp')
        path = os.path.join(d, 'qmp.sock')
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(1)
        seen = []

        def serve():
            c, _ = srv.accept()
            f = c.makefile('rwb')
            f.write(b'{"QMP": {}}\n')
            f.flush()
            for line in f:
                cmd = json.loads(line)['execute']
                seen.append(cmd)
                f.write(json.dumps({'return': {'status': 'running'} if cmd == 'query-status' else {}}).encode() + b'\n')
                f.flush()
                if cmd == 'system_powerdown':
                    time.sleep(1.6)                      # > the 1 s v2 socket timeout: explicit timeout path
                    f.write(b'{"event": "POWERDOWN", "data": {}}\n')
                    f.flush()
                    time.sleep(1.6)
                    f.write(b'{"event": "SHUTDOWN", "data": {"guest": true}}\n')
                    f.flush()
                    time.sleep(0.3)
                    break
            f.close()
            c.close()
        t = threading.Thread(target=serve)
        t.start()
        try:
            t0 = time.time()
            rc = self.run_powerdown(self.manifest(d, path, os.path.join(d, 'g.sock')))
            t.join(10)
            self.assertEqual(rc, 0)
            self.assertGreater(time.time() - t0, 3.0)
            self.assertEqual(seen, ['qmp_capabilities', 'query-status', 'system_powerdown'])
        finally:
            srv.close()
            shutil.rmtree(d, ignore_errors=True)

    def test_real_qemu_clean_exit_while_waiting(self):
        import threading
        d = tempfile.mkdtemp(prefix='pq-', dir='/tmp')
        main, guard = os.path.join(d, 'qmp.sock'), os.path.join(d, 'guard-qmp.sock')
        q = subprocess.Popen(['/usr/bin/qemu-system-x86_64', '-machine', 'none', '-nodefaults', '-display', 'none',
                              '-qmp', f'unix:{main},server=on,wait=off',
                              '-chardev', f'socket,id=qmpg,path={guard},server=on,wait=off', '-mon', 'chardev=qmpg,mode=control'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_sock(main)
            wait_sock(guard)
            res = {}
            t = threading.Thread(target=lambda: res.update(rc=self.run_powerdown(self.manifest(d, main, guard))))
            t.start()
            time.sleep(2.5)                              # powerdown is waiting through several 1 s timeouts
            g = pv.Qmp(guard)
            try:
                g.cmd('quit')                            # the "guest" goes away: QEMU exits cleanly
            except OSError:
                pass
            t.join(20)
            self.assertEqual(res.get('rc'), 0)
            self.assertEqual(q.wait(10), 0)
        finally:
            if q.poll() is None:
                q.kill()
                q.wait()
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
