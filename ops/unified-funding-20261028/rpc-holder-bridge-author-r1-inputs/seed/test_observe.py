import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import threading
import ctypes
from unittest import mock
import observe


class DescriptorObserverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='descriptor-fixture-')
        self.path = Path(self.temp.name) / 'owned-file'
        self.path.write_bytes(b'never read the contents')
        self.ro = os.open(self.path, os.O_RDONLY)
        self.rw = os.open(self.path, os.O_RDWR)
        s = self.path.stat()
        self.target = (s.st_dev, s.st_ino)

    def tearDown(self):
        os.close(self.ro)
        os.close(self.rw)
        self.temp.cleanup()

    def own_scope(self, pid=None):
        target_pid = os.getpid() if pid is None else pid
        original = observe.names_bounded
        def listing(fd, limit, check):
            if isinstance(fd, int) and os.readlink('/proc/self/fd/' + str(fd)) == '/proc':
                check()
                return [str(target_pid)]
            return original(fd, limit, check)
        return mock.patch.object(observe, 'names_bounded', side_effect=listing)

    def test_actual_owned_descriptor_modes_with_explicit_single_pid_scope(self):
        with self.own_scope():
            result = observe.scan({self.target}, 'a' * 32, require_root=False)
        own = {m['fd']: m for m in result['matches'] if m['pid'] == os.getpid()}
        self.assertEqual(own[self.ro]['accessMode'], os.O_RDONLY)
        self.assertEqual(own[self.rw]['accessMode'], os.O_RDWR)
        self.assertGreater(own[self.ro]['startTicks'], 0)
        self.assertNotIn('never read the contents', json.dumps(result))
        self.assertEqual(result['complete'], not result['errors'])

    def test_cli_requires_host_root_no_fake_success(self):
        self.assertNotEqual(os.geteuid(), 0, 'fixture is deliberately unprivileged')
        r = subprocess.run([sys.executable, '-I', str(Path(observe.__file__).resolve()),
                            '--target', ':'.join(map(str,self.target)), '--nonce', 'b'*32],
                           capture_output=True, timeout=5)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stdout)['refusal'], 'host_root_required')

    def test_missing_matching_descriptor_flags_is_incomplete(self):
        original = observe.read_at
        def altered(parent, name, limit):
            if name == 'fdinfo/' + str(self.ro):
                return b''
            return original(parent, name, limit)
        with self.own_scope(), mock.patch.object(observe, 'read_at', side_effect=altered):
            result = observe.scan({self.target}, 'c'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertTrue(any(x.get('pid') == os.getpid() and x.get('phase') == 'descriptor' for x in result['errors']))

    def test_full_host_unprivileged_visibility_diagnostic(self):
        result = observe.scan({self.target}, 'f'*32, require_root=False)
        summary = {k:result.get(k) for k in ('complete','enumerated','processes','descriptors','exited','elapsedSeconds')}
        summary['errors'] = len(result['errors'])
        summary['errorKinds'] = sorted(set(x['kind'] for x in result['errors']))
        summary['scanIncomplete'] = any(x.get('phase') == 'scan' for x in result['errors'])
        Path('visibility-diagnostic.json').write_text(json.dumps(summary,indent=2)+'\n')
        self.assertEqual(result['complete'], not result['errors'])
        self.assertFalse(result['complete'], 'unprivileged host-wide visibility is intentionally NOT qualified')

    def test_deadline_never_reports_complete(self):
        with mock.patch.object(observe, 'MAX_SECONDS', -1):
            result = observe.scan({self.target}, 'd'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertTrue(result['errors'])

    def test_cli_rejects_paths_duplicates_and_too_many_targets(self):
        target = ':'.join(map(str,self.target))
        variants = [['--target', '/etc/passwd'], ['--target', target, '--target', target],
                    sum((['--target', f'1:{i+1}'] for i in range(4)), [])]
        for options in variants:
            r = subprocess.run([sys.executable, '-I', str(Path(observe.__file__).resolve()),
                                '--nonce', 'e'*32, *options], capture_output=True, timeout=5)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(r.stdout, b'')

    def test_missing_process_metadata_is_not_exit_proof(self):
        with self.own_scope(), mock.patch.object(observe, 'identity', side_effect=FileNotFoundError(2, 'fixture')):
            result = observe.scan({self.target}, 'a'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertEqual(result['exited'], 0)
        self.assertTrue(any(e['phase'] == 'process_disappearance' for e in result['errors']))

    def test_descriptor_enumeration_stops_at_bound(self):
        with self.own_scope(), mock.patch.object(observe, 'MAX_FDS', 1):
            result = observe.scan({self.target}, 'a'*32, require_root=False)
        self.assertFalse(result['complete'])
        self.assertTrue(result['errors'])

    def test_bounded_directory_iterator_does_not_materialize_remainder(self):
        visited=[]
        class Entries:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def __iter__(self):
                for n in range(100):
                    visited.append(n)
                    yield type('Entry', (), {'name':str(n)})()
        with mock.patch.object(os,'scandir', return_value=Entries()):
            with self.assertRaises(observe.Incomplete):
                observe.names_bounded(123, 2, lambda:None)
        self.assertEqual(len(visited),3)

    def test_actual_thread_unshared_fd_table_is_observed(self):
        ready=threading.Event();release=threading.Event();data={}
        def worker():
            fd=None
            try:
                libc=ctypes.CDLL(None,use_errno=True)
                rc=libc.unshare(0x400) # CLONE_FILES, this disposable thread only
                if rc: raise OSError(ctypes.get_errno(),'unshare CLONE_FILES')
                fd=os.open(self.path,os.O_RDONLY)
                data.update(tid=threading.get_native_id(),fd=fd)
                ready.set();release.wait(5)
            except BaseException as exc:
                data['error']=repr(exc);ready.set()
            finally:
                if fd is not None:os.close(fd)
        thread=threading.Thread(target=worker);thread.start()
        try:
            self.assertTrue(ready.wait(3));self.assertNotIn('error',data)
            with self.own_scope():result=observe.scan({self.target},'a'*32,require_root=False)
            self.assertTrue(result['complete'],result['errors'])
            self.assertTrue(any(m['tid']==data['tid'] and m['fd']==data['fd'] for m in result['matches']))
            self.assertTrue(all('taskStartTicks' in m and m['accessModeAdvisory'] for m in result['matches']))
        finally:
            release.set();thread.join(3)
            self.assertFalse(thread.is_alive())

    def test_task_count_limit_refuses(self):
        with self.own_scope(),mock.patch.object(observe,'MAX_TASKS',0):
            result=observe.scan({self.target},'a'*32,require_root=False)
        self.assertFalse(result['complete']);self.assertTrue(result['errors'])

    def test_live_thread_after_leader_exit_cannot_be_clean(self):
        ready=Path(self.temp.name)/'thread-ready'
        script="""import os,sys,time,threading,ctypes
from pathlib import Path
def worker():
 fd=os.open(sys.argv[1],os.O_RDONLY)
 Path(sys.argv[2]).write_text(str(threading.get_native_id()))
 time.sleep(20)
t=threading.Thread(target=worker);t.start()
while not Path(sys.argv[2]).exists():time.sleep(.01)
ctypes.CDLL(None).pthread_exit(None)
"""
        proc=subprocess.Popen([sys.executable,'-I','-c',script,str(self.path),str(ready)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            import time
            end=time.monotonic()+3
            while not ready.exists() and time.monotonic()<end:time.sleep(.01)
            self.assertTrue(ready.exists())
            end=time.monotonic()+3
            while time.monotonic()<end:
                fields=Path('/proc/'+str(proc.pid)+'/stat').read_text().rsplit(')',1)[1].split()
                if fields[0]=='Z':break
                time.sleep(.01)
            self.assertEqual(fields[0],'Z','fixture main thread must have exited')
            with self.own_scope(proc.pid):result=observe.scan({self.target},'a'*32,require_root=False)
            self.assertTrue(result['matches'] or not result['complete'],result)
        finally:
            proc.terminate()
            try:proc.wait(timeout=3)
            except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
