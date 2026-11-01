"""Finite Linux qualification: actual KVM, read-only namespace, owner death."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('linux_direct', ROOT/'rpc/linux_direct.py')
direct = importlib.util.module_from_spec(spec); spec.loader.exec_module(direct)


class DirectQualification(unittest.TestCase):
    def test_pending_and_retained_floor(self):
        row = {'authenticated': True, 'unreadUnits': 0, 'availableMiB': 60000, 'pendingMiB': 6000, 'floorMiB': 18432}
        direct.admit(row, True)
        with self.assertRaises(ValueError): direct.admit(dict(row, availableMiB=54000), True)
        with self.assertRaises(ValueError): direct.admit(dict(row, unreadUnits=1), True)
        with self.assertRaises(ValueError): direct.admit(dict(row, authenticated=False), True)
        with self.assertRaises(ValueError): direct.admit(dict(row, pendingMiB=True), True)
        with self.assertRaises(ValueError): direct.admit(dict(row, floorMiB=40000), True)

    def test_native_readonly_namespace(self):
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td)/'original'; parent.write_text('immutable')
            result = subprocess.run(['/usr/bin/bwrap', '--unshare-user', '--die-with-parent',
                '--ro-bind', '/', '/', '--', '/usr/bin/python3', '-c',
                'import os,sys,errno\ntry: os.open(sys.argv[1],os.O_WRONLY)\nexcept OSError as e: sys.exit(0 if e.errno==errno.EROFS else 2)\nsys.exit(1)', str(parent)], timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(parent.read_text(), 'immutable')

    def test_actual_kvm_owner_death(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); qmp = root/'qmp'
            args = ['/usr/bin/bwrap', '--unshare-user', '--die-with-parent', '--new-session',
                    '--ro-bind', '/', '/', '--bind', td, td, '--dev-bind', '/dev/kvm', '/dev/kvm', '--',
                    '/usr/sbin/qemu-system-x86_64', '-machine', 'q35,accel=kvm', '-cpu', 'host',
                    '-m', '32', '-smp', '1', '-nodefaults', '-display', 'none', '-S',
                    '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
                    '-qmp', 'unix:'+str(qmp)+',server=on,wait=off']
            owner_code = 'import subprocess,json,sys,time\np=subprocess.Popen(json.loads(sys.argv[1]));print(p.pid,flush=True);time.sleep(20)'
            owner = subprocess.Popen(['/usr/bin/python3', '-c', owner_code, json.dumps(args)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            held = []
            try:
                self.assertTrue(select.select([owner.stdout], [], [], 5)[0])
                pid = int(owner.stdout.readline()); held.append(os.pidfd_open(pid))
                deadline = time.monotonic()+5
                while not qmp.exists() and time.monotonic() < deadline: time.sleep(.05)
                self.assertTrue(qmp.exists(), 'QEMU did not open QMP')
                # Prehold every descendant identity before owner loss.
                pending = [pid]
                while pending:
                    p = pending.pop()
                    children = Path('/proc', str(p), 'task', str(p), 'children').read_text().split()
                    for child in children:
                        held.append(os.pidfd_open(int(child))); pending.append(int(child))
                with socket.socket(socket.AF_UNIX) as s:
                    s.settimeout(2); s.connect(str(qmp))
                    greeting = s.recv(4096)
                    self.assertIn(b'QMP', greeting)
                owner.kill(); owner.wait(timeout=3)
                deadline = time.monotonic()+3
                for fd in held:
                    self.assertTrue(select.select([fd], [], [], max(0, deadline-time.monotonic()))[0], 'Exact child survived owner loss')
            finally:
                if owner.poll() is None: owner.kill(); owner.wait(timeout=2)
                for fd in held:
                    if not select.select([fd], [], [], 0)[0]: signal.pidfd_send_signal(fd, signal.SIGKILL)
                    os.close(fd)
                owner.stdout.close(); owner.stderr.close()


if __name__ == '__main__': unittest.main(verbosity=2)
