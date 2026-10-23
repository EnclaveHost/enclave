"""Offline tests for whole_restore.py + runner.py. Run by run-tests.sh INSIDE `unshare -rn` (a private network namespace
whose loopback also carries 203.0.113.5, standing in for a Sia host address): nothing here can reach a real network.
The restore binary is test/fake-sia-s3; ssh, systemd-run and systemctl are the stubs in test/stubs."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('whole_restore', HERE.parent / 'whole_restore.py')
wr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wr)
FAKE = HERE / 'fake-sia-s3'
SIA = '203.0.113.5'          # a "Sia host" on this namespace's loopback
CONTROL = ('127.0.0.2', 4100)  # the "indexer": reachable outside the restore's scope
GLOBAL = ['93.184.216.34', '8.8.4.4', '1.0.0.1']  # global-looking addresses for derivation tests (never contacted)


def serve(addr, payload):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(addr)
    s.listen(16)

    def loop():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            try:
                c.sendall(payload)
            except OSError:
                pass
            c.close()
    threading.Thread(target=loop, daemon=True).start()
    return s


def close(s):
    try:
        s.shutdown(socket.SHUT_RDWR)  # wakes the accept() thread; close() alone leaves the port bound
    except OSError:
        pass
    s.close()


def call(*argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = wr.main(list(argv))
    return code, json.loads(buf.getvalue().strip().splitlines()[-1]), buf.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='swr-test-'))
        self.tmp.chmod(0o700)
        self.stub = self.tmp / 'stub'
        self.stub.mkdir()
        self.env = {k: os.environ.get(k) for k in ('PATH', 'STUB_DIR', 'STUB_TAMPER', 'STUB_ACTIVE_OTHER')}
        os.environ['PATH'] = f"{HERE / 'stubs'}:{os.environ['PATH']}"
        os.environ['STUB_DIR'] = str(self.stub)
        self.sentinel = 'SENTINEL-KEY-' + secrets.token_hex(16)
        self.servers = [serve((SIA, 4001), b'alpha' * 300), serve((SIA, 4002), b'beta' * 777), serve(CONTROL, b'')]

    def tearDown(self):
        for s in self.servers:
            close(s)
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def calls(self, prefix):
        return [json.load(open(p)) for p in sorted(self.stub.glob(prefix + '-*.json'))]

    def make_run(self, fake=None, endpoints=((SIA, 4001), (SIA, 4002)), blocked=None):
        """A prepared run directory, as `prepare` leaves it (addresses already IP-pinned)."""
        root = self.tmp / 'root'
        root.mkdir(mode=0o700, exist_ok=True)
        run = root / ('20261023T000000Z-' + secrets.token_hex(4))
        run.mkdir(mode=0o700)
        snap = {'version': 1, 'created_at': 'x', 'objects': {}, 'keys': [], 'fake': fake or {'mode': 'ok'},
                'hosts': [{'public_key': 'ed25519:%d' % i, 'addresses': [{'protocol': 'siamux', 'address': f'{ip}:{port}'}]}
                          for i, (ip, port) in enumerate(endpoints)]}
        raw = json.dumps(snap).encode()
        (self.tmp / 'snapshot.json').write_bytes(raw)
        (run / 'snapshot-ip-pinned.json').write_bytes(raw)
        (self.tmp / 'archive.tar.gpg').write_bytes(b'archive bytes')
        key = self.tmp / 'app.seed'
        if not key.exists():
            key.write_text(self.sentinel + '\n')
            key.chmod(0o600)
        blocked = blocked or [{'label': 'indexer', 'ip': CONTROL[0], 'port': CONTROL[1], 'outsideMustConnect': True},
                              {'label': 'nan', 'ip': '62.238.4.214', 'port': 443, 'outsideMustConnect': False},
                              {'label': 'do-front', 'ip': '146.190.246.39', 'port': 8189, 'outsideMustConnect': False}]
        rec = {'format': 'sia-whole-restore-run/v1', 'run': str(run), 'snapshot': str(self.tmp / 'snapshot.json'),
               'snapshotSha256': hashlib.sha256(raw).hexdigest(), 'archive': str(self.tmp / 'archive.tar.gpg'),
               'archiveSha256': hashlib.sha256(b'archive bytes').hexdigest(), 'keyFile': str(key),
               'derivativeSha256': hashlib.sha256(raw).hexdigest(), 'endpoints': [{'ip': ip, 'port': p} for ip, p in endpoints],
               'blocked': blocked, 'blockedNames': [{'label': 'indexer name', 'name': 'sia.enclave.host', 'port': 443}]}
        (run / 'run.json').write_text(json.dumps(rec))
        return run

    def start_args(self, run, target='local', binary=FAKE, sha=None, extra=()):
        sha = sha or hashlib.sha256(Path(binary).read_bytes()).hexdigest()
        a = ['start', '--run', str(run), '--target', target, '--binary', str(binary), '--binary-sha', sha,
             '--max-total-bytes', '100000', '--deadline-secs', '60', '--memory-max-mib', '512']
        if target == 'vm':
            vm = self.tmp / 'vm'
            vm.mkdir(exist_ok=True)
            a += ['--vm-root', str(vm), '--ssh-dest', 'storageadmin@127.0.0.1', '--ssh-port', '32422',
                  '--ssh-identity', '/nonexistent/minipc', '--ssh-known-hosts', '/nonexistent/known_hosts']
        return a + list(extra)

    def assert_no_secret(self, *texts, allow=()):
        for t in texts:
            self.assertNotIn(self.sentinel, t)
        for p in self.tmp.rglob('*'):
            if p.is_file() and not p.is_symlink() and p.name != 'app.seed' and p not in allow and not (p.name == 'key' and p.parent.name == 'stage'):
                self.assertNotIn(self.sentinel.encode(), p.read_bytes(), str(p))


class Derivative(unittest.TestCase):
    SNAP = {'version': 1, 'created_at': 't', 'objects': {'o': {'x': 1}}, 'keys': [{'object': 'o', 'entry': 0}],
            'hosts': [{'public_key': 'a', 'addresses': [{'protocol': 'siamux', 'address': 'host-a.example:9984'},
                                                        {'protocol': 'quic', 'address': 'host-a.example:9984'}]},
                      {'public_key': 'b', 'addresses': [{'protocol': 'siamux', 'address': '8.8.4.4:9988'},
                                                        {'protocol': 'siamux', 'address': '192.168.1.5:9984'},
                                                        {'protocol': 'siamux', 'address': '[2001:db8::1]:9984'}]},
                      {'public_key': 'c', 'addresses': [{'protocol': 'siamux', 'address': 'gone.example:9984'}]}]}

    def resolver(self, name, port):
        return {'host-a.example': ['93.184.216.34', '10.0.0.1'], 'gone.example': []}[name]

    def test_only_addresses_change_and_only_to_announced_global_ipv4(self):
        d, eps, res, stats = wr.derive(self.SNAP, self.resolver)
        self.assertEqual([h['addresses'] for h in d['hosts']],
                         [[{'protocol': 'siamux', 'address': '93.184.216.34:9984'}], [{'protocol': 'siamux', 'address': '8.8.4.4:9988'}], []])
        self.assertEqual(eps, [('8.8.4.4', 9988), ('93.184.216.34', 9984)])
        self.assertEqual(stats, {'hosts': 3, 'hostsWithEndpoints': 2, 'droppedNonSiamux': 1, 'droppedNonGlobal': 3, 'unresolved': 1, 'malformed': 0})
        wr.verify_derivative(self.SNAP, d, res)
        self.assertEqual(self.SNAP['hosts'][0]['addresses'][0]['address'], 'host-a.example:9984', 'the original is not modified')

    def test_any_other_difference_is_refused(self):
        d, _, res, _ = wr.derive(self.SNAP, self.resolver)
        for mutate in (lambda x: x['objects']['o'].update(x=2), lambda x: x.update(version=2),
                       lambda x: x['hosts'][0].update(public_key='z'),
                       lambda x: x['hosts'][0]['addresses'].append({'protocol': 'siamux', 'address': '1.0.0.1:9984'}),
                       lambda x: x['hosts'][1]['addresses'].__setitem__(0, {'protocol': 'siamux', 'address': '8.8.4.4:1'})):
            bad = json.loads(json.dumps(d))
            mutate(bad)
            with self.assertRaises(wr.Refused):
                wr.verify_derivative(self.SNAP, bad, res)


class Prepare(Base):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / 'root'
        self.root.mkdir(mode=0o700)
        snap = dict(Derivative.SNAP)
        self.raw = json.dumps(snap).encode()
        (self.tmp / 'snapshot.json').write_bytes(self.raw)
        (self.tmp / 'archive.tar.gpg').write_bytes(b'archive')
        (self.tmp / 'app.seed').write_text(self.sentinel)
        (self.tmp / 'app.seed').chmod(0o600)
        self.blocked = self.tmp / 'blocked.json'
        self.blocked.write_text(json.dumps({'format': 'sia-whole-restore-blocked/v1', 'endpoints': [
            {'label': 'indexer', 'ip': '127.0.0.1', 'port': 9982, 'outsideMustConnect': True},
            {'label': 'nan', 'ip': '62.238.4.214', 'port': 443}]}))
        self.orig = wr.resolve4
        wr.resolve4 = lambda name, port: Derivative.resolver(None, name, port)

    def tearDown(self):
        wr.resolve4 = self.orig
        super().tearDown()

    def args(self, **over):
        v = {'--snapshot': self.tmp / 'snapshot.json', '--snapshot-sha': hashlib.sha256(self.raw).hexdigest(),
             '--archive': self.tmp / 'archive.tar.gpg', '--archive-sha': hashlib.sha256(b'archive').hexdigest(),
             '--key-file': self.tmp / 'app.seed', '--root': self.root, '--blocked': self.blocked}
        v.update(over)
        return ['prepare'] + [str(x) for kv in v.items() for x in kv]

    def test_prepare_pins_and_records_the_derivative(self):
        code, o, text = call(*self.args())
        self.assertEqual(code, 0, o)
        run = Path(o['run'])
        self.assertEqual(stat.S_IMODE(run.stat().st_mode), 0o700)
        self.assertEqual(o['derivativeSha256'], wr.sha256_file(run / 'snapshot-ip-pinned.json'))
        self.assertNotEqual(o['derivativeSha256'], o['snapshotSha256'])
        self.assertEqual((self.tmp / 'snapshot.json').read_bytes(), self.raw, 'original preserved byte for byte')
        self.assertEqual((o['allowedEndpoints'], o['hostsWithEndpoints']), (2, 2))
        self.assertEqual(stat.S_IMODE((run / 'snapshot-ip-pinned.json').stat().st_mode), 0o600)
        self.assert_no_secret(text)
        code, o2, _ = call(*self.args())
        self.assertNotEqual(o2['run'], o['run'], 'every prepare is a new directory')

    def test_refusals_write_nothing(self):
        bad_key = self.tmp / 'key644'
        bad_key.write_text('k')
        bad_key.chmod(0o644)
        link = self.tmp / 'keylink'
        link.symlink_to(self.tmp / 'app.seed')
        loose = self.tmp / 'loose'
        loose.mkdir(mode=0o755)
        loose.chmod(0o755)
        nocontrol = self.tmp / 'nocontrol.json'
        nocontrol.write_text(json.dumps({'format': 'sia-whole-restore-blocked/v1', 'endpoints': [{'label': 'nan', 'ip': '62.238.4.214', 'port': 443}]}))
        overlap = self.tmp / 'overlap.json'
        overlap.write_text(json.dumps({'format': 'sia-whole-restore-blocked/v1', 'endpoints': [
            {'label': 'indexer', 'ip': '127.0.0.1', 'port': 9982, 'outsideMustConnect': True},
            {'label': 'a DO front that a host resolved to', 'ip': '93.184.216.34', 'port': 443}]}))
        for over, why in (({'--snapshot-sha': '0' * 64}, 'snapshot hash'), ({'--archive-sha': '1' * 64}, 'archive hash'),
                          ({'--key-file': bad_key}, '0600'), ({'--key-file': link}, 'symlink'), ({'--root': loose}, '0700'),
                          ({'--blocked': nocontrol}, 'outsideMustConnect'), ({'--blocked': overlap}, 'blocked address'),
                          ({'--snapshot-sha': 'XYZ'}, '64 lowercase')):
            code, o, _ = call(*self.args(**over))
            self.assertEqual(code, 2, over)
            self.assertIn(why, o['refused'])
            self.assertEqual(list(self.root.iterdir()), [], f'{why}: nothing written')

    @unittest.skipUnless(shutil.which('gpg'), 'gpg not installed')
    def test_archive_members_must_be_this_snapshot_and_key(self):
        home = self.tmp / 'gnupg'
        home.mkdir(mode=0o700)
        os.environ['GNUPGHOME'] = str(home)
        try:
            pw = self.tmp / 'pass'
            pw.write_text('test passphrase\n')
            pw.chmod(0o600)
            for seed, ok in ((self.sentinel.encode(), True), (b'another key', False)):
                buf = io.BytesIO()
                with tarfile.open(fileobj=buf, mode='w') as tar:
                    for name, data in (('snapshot.json', self.raw), ('app.seed', seed)):
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                arch = self.tmp / ('a-%s.gpg' % ok)
                subprocess.run(['gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase-file', str(pw), '--symmetric',
                                '--output', str(arch)], input=buf.getvalue(), check=True, capture_output=True)
                code, o, text = call(*self.args(**{'--archive': arch, '--archive-sha': wr.sha256_file(arch),
                                                   '--archive-passphrase-file': pw}))
                if ok:
                    self.assertEqual((code, o['archiveMembers']), (0, {'snapshotMatches': True, 'keyFileMatches': True}))
                else:
                    self.assertEqual(code, 2)
                    self.assertIn('does not hold this snapshot and key', o['refused'])
                self.assertNotIn(self.sentinel, text)
        finally:
            subprocess.run(['gpgconf', '--homedir', str(home), '--kill', 'all'], capture_output=True)
            os.environ.pop('GNUPGHOME', None)


class Start(Base):
    def test_local_success_end_to_end(self):
        run = self.make_run(fake={'mode': 'ok', 'tryBlocked': [list(CONTROL), ['62.238.4.214', 443]]})
        code, o, text = call(*self.start_args(run))
        self.assertEqual(code, 0, o)
        code, p, ptext = call('poll', '--run', str(run))
        self.assertEqual((code, p['state']), (0, 'succeeded'), p)
        r = p['result']
        self.assertTrue(r['success'])
        self.assertEqual(r['probes'], {'blocked': 3, 'blockedTried': 3, 'namesResolved': 0, 'namesTried': 1,
                                       'allowedReached': 2, 'allowedTried': 2, 'isolated': True})
        self.assertEqual((r['restore']['keys'], r['restore']['restored'], r['restore']['onDiskBytes']), (2, 2, 1500 + 3108))
        self.assertTrue(r['originalSnapshotUnchanged'])
        attempt = Path(o['attempt'])
        inv = json.loads((attempt / 'restored' / 'inventory.json').read_text())
        self.assertEqual(inv['fakeBlockedReached'], [False, False], 'the binary itself cannot reach the indexer or Nan')
        self.assertEqual((attempt / 'restored' / 'objects' / '000001.bin').read_bytes(), b'alpha' * 300)
        self.assertEqual(r['restore']['inventorySha256'], hashlib.sha256((attempt / 'restored' / 'inventory.json').read_bytes()).hexdigest())
        argv = self.calls('systemd-run')[0]['argv']
        for prop in ('MemoryMax=512M', 'MemorySwapMax=0', 'CPUQuota=200%', 'KillMode=control-group', 'Type=exec'):
            self.assertIn(prop, argv)
        self.assertIn('--user', argv)
        self.assertFalse(any('IPAddress' in x for x in argv), 'user units cannot enforce IPAddress*: not claimed')
        self.assertNotIn('"k1"', ptext + text, 'no key names in what is printed')
        self.assert_no_secret(text, ptext, json.dumps(self.calls('systemd-run')))
        # finish removes only staging; discard is root's explicit choice
        code, f, _ = call('finish', '--run', str(run))
        self.assertEqual((code, f['stagingRemoved'], f['restoredDataKept']), (0, True, True))
        self.assertFalse((attempt / 'stage').exists())
        self.assertTrue((attempt / 'restored' / 'objects' / '000002.bin').exists())
        code, d, _ = call('discard', '--run', str(run))
        self.assertEqual((code, d['restoredRemoved']), (0, True))
        self.assertFalse((attempt / 'restored').exists())
        self.assertTrue((attempt / 'result.json').exists())

    def test_pins_are_checked_before_anything_starts_or_uploads(self):
        run = self.make_run()
        for target in ('local', 'vm'):
            code, o, _ = call(*self.start_args(run, target, sha='0' * 64))
            self.assertEqual(code, 2)
            self.assertIn('binary hash', o['refused'])
        (self.tmp / 'snapshot.json').write_bytes(b'{}')
        code, o, _ = call(*self.start_args(run, 'vm'))
        self.assertIn('original snapshot hash', o['refused'])
        self.assertEqual(self.calls('ssh') + self.calls('systemd-run'), [], 'nothing contacted or started')
        self.assertFalse((run / 'attempts').exists())
        for bad in (['--deadline-secs', '0'], ['--memory-max-mib', '64']):
            args = self.start_args(run)
            i = args.index(bad[0])
            args[i + 1] = bad[1]
            self.assertEqual(call(*args)[0], 2)

    def test_unreachable_indexer_outside_refuses_before_upload(self):
        close(self.servers[2])  # the control endpoint is down: the inside block would prove nothing
        run = self.make_run()
        for target in ('local', 'vm'):
            code, o, _ = call(*self.start_args(run, target))
            self.assertEqual(code, 2)
            self.assertIn('not reachable outside', o['refused'])
        self.assertEqual([c['argv'][-1].split()[0] for c in self.calls('ssh')], ['python3'], 'only the outside probe ran')
        self.assertEqual(self.calls('systemd-run'), [])

    def test_partial_restore_is_failure_and_staging_is_kept(self):
        run = self.make_run(fake={'mode': 'partial'})
        self.assertEqual(call(*self.start_args(run))[0], 0)
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual((code, p['state'], p['result']['success']), (1, 'failed', False))
        self.assertEqual((p['result']['restore']['failed'], p['result']['restore']['complete']), (1, False))
        code, f, _ = call('finish', '--run', str(run))
        self.assertEqual(code, 2)
        self.assertIn('--abandon', f['refused'])
        self.assertEqual(call('finish', '--run', str(run), '--abandon')[0], 0)

    def test_on_disk_mismatch_is_failure(self):
        run = self.make_run(fake={'mode': 'corrupt'})
        call(*self.start_args(run))
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual((code, p['state']), (1, 'failed'))
        self.assertEqual(p['result']['restore']['onDiskMismatches'], 2)

    def test_swapped_binary_or_dead_hosts_never_restore(self):
        run = self.make_run()
        call(*self.start_args(run))  # attempt 001: fine
        # the stub appends to $STUB_TAMPER before the unit runs: point it at the next attempt's staged binary
        n = len(list((run / 'attempts').iterdir())) + 1
        orig_mkdir = Path.mkdir

        def spy(self_, *a, **k):
            orig_mkdir(self_, *a, **k)
            if self_.name == 'stage' and self_.parent.name.startswith(f'{n:03d}-'):
                os.environ['STUB_TAMPER'] = str(self_ / 'sia-s3')
        Path.mkdir = spy
        try:
            code, o, _ = call(*self.start_args(run))
        finally:
            Path.mkdir = orig_mkdir
            os.environ.pop('STUB_TAMPER')
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual((p['state'], p['result']['restoreExit']), ('failed', 93))
        self.assertFalse((Path(o['attempt']) / 'restored').exists(), 'nothing restored by a swapped binary')
        for s in self.servers[:2]:
            close(s)
        code, o, _ = call(*self.start_args(run))
        self.assertEqual(code, 0, o)
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual((p['state'], p['result']['restoreExit'], p['result']['probes']['allowedReached']), ('failed', 92, 0))
        self.assertEqual(len(list((run / 'attempts').iterdir())), 3, 'each start is a new attempt directory')

    def test_plan_that_allows_a_blocked_address_never_runs(self):
        run = self.make_run(blocked=[{'label': 'indexer', 'ip': CONTROL[0], 'port': CONTROL[1], 'outsideMustConnect': True},
                                     {'label': 'same ip as a host', 'ip': SIA, 'port': 443, 'outsideMustConnect': False}])
        call(*self.start_args(run))
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual(p['state'], 'failed')
        self.assertIn('allows a blocked address', p['result']['error'])
        self.assertNotIn('restoreExit', p['result'])

    def test_handle_mismatch_is_never_acted_on(self):
        run = self.make_run()
        os.environ['STUB_ACTIVE_OTHER'] = '1'
        try:
            call(*self.start_args(run))
            code, p, _ = call('poll', '--run', str(run))
            self.assertEqual((code, p['state']), (1, 'handle-mismatch'))
            self.assertEqual(call('stop', '--run', str(run))[0], 2)
            self.assertEqual(call('finish', '--run', str(run), '--abandon')[0], 2)
            self.assertEqual(call('discard', '--run', str(run))[0], 2)
        finally:
            os.environ.pop('STUB_ACTIVE_OTHER')
        self.assertFalse([c for c in self.calls('systemctl') if c['argv'][-2:-1] == ['stop']])

    def test_vm_upload_holds_the_key_only_on_stdin_and_finish_removes_it(self):
        run = self.make_run()
        code, o, text = call(*self.start_args(run, 'vm'))
        self.assertEqual(code, 0, o)
        remote = Path(o['remote'])
        self.assertEqual(stat.S_IMODE(remote.stat().st_mode), 0o700)
        ssh = self.calls('ssh')
        verbs = [c['argv'][-1].replace('sudo -n ', '').split()[0] for c in ssh]
        self.assertEqual(verbs, ['python3', 'mkdir', 'tar', 'sha256sum', 'systemd-run'])
        tar_call = next(i for i, c in enumerate(ssh) if c['stdinBytes'])
        with tarfile.open(self.stub / ('ssh-%03d.stdin' % tar_call)) as t:
            self.assertEqual(sorted(t.getnames()), ['plan.json', 'runner.py', 'snapshot-ip-pinned.json', 'stage/key', 'stage/sia-s3'])
            self.assertEqual({m.name: m.mode for m in t}['stage/key'], 0o600)
        for c in ssh:
            self.assertNotIn(self.sentinel, json.dumps(c['argv']))
        unit_argv = self.calls('systemd-run')[0]['argv']
        self.assertIn('IPAddressDeny=any', unit_argv)
        self.assertIn(f'IPAddressAllow={SIA}', unit_argv)
        self.assertNotIn('--user', unit_argv)
        code, p, _ = call('poll', '--run', str(run))
        self.assertEqual((code, p['state']), (0, 'succeeded'), p)
        self.assertTrue((remote / 'stage' / 'key').exists())
        self.assert_no_secret(text, allow=(self.stub / ('ssh-%03d.stdin' % tar_call),))
        code, f, _ = call('finish', '--run', str(run))
        self.assertEqual((code, f['stagingRemoved']), (0, True))
        self.assertFalse((remote / 'stage').exists(), 'the uploaded key is gone after a verified success')
        self.assertTrue((remote / 'restored' / 'inventory.json').exists(), 'restored data stays')

    def test_vm_failure_keeps_the_uploaded_key_until_abandon(self):
        run = self.make_run(fake={'mode': 'partial'})
        code, o, _ = call(*self.start_args(run, 'vm'))
        remote = Path(o['remote'])
        self.assertEqual(call('poll', '--run', str(run))[1]['state'], 'failed')
        self.assertEqual(call('finish', '--run', str(run))[0], 2)
        self.assertTrue((remote / 'stage' / 'key').exists())
        self.assertEqual(call('finish', '--run', str(run), '--abandon')[0], 0)
        self.assertFalse((remote / 'stage').exists())


class Check(Base):
    def test_local_check_reports_and_refuses_an_impossible_budget(self):
        code, o, _ = call('check', '--target', 'local', '--root', str(self.tmp), '--total-bytes', '1000', '--binary', str(FAKE))
        self.assertTrue(o['unprivilegedNetns'])
        for k in ('freeBytes', 'memAvailableMiB', 'cpus', 'fitsBudget', 'isolationAvailable', 'glibc'):
            self.assertIn(k, o)
        code, o, _ = call('check', '--target', 'local', '--root', str(self.tmp), '--total-bytes', str(1 << 60))
        self.assertEqual((code, o['fitsBudget']), (1, False))

    def test_vm_check_is_one_read_only_ssh(self):
        call('check', '--target', 'vm', '--root', str(self.tmp), '--total-bytes', '1000', '--ssh-dest', 'x@127.0.0.1',
             '--ssh-port', '32422', '--ssh-identity', '/k', '--ssh-known-hosts', '/kh')
        ssh = self.calls('ssh')
        self.assertEqual(len(ssh), 1)
        self.assertTrue(ssh[0]['argv'][-1].startswith('python3 -I -c '))
        self.assertIn('StrictHostKeyChecking=yes', ssh[0]['argv'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
