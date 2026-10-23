"""One end-to-end run through the REAL `systemd-run --user` (no stubs): the unit's properties are accepted, its exact
handle (unit + invocation id) is what poll reads, MemoryPeak is reported, and finish clears it. Loopback only: the
"Sia host" is 127.0.0.1, the "indexer" is 127.0.0.2 (reachable here, unreachable inside the restore's namespace)."""
import hashlib
import json
import os
import secrets
import shutil
import socket
import tempfile
import time
import unittest
from pathlib import Path

import importlib.util
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('test_harness_helpers', HERE / 'test_harness.py')
th = importlib.util.module_from_spec(spec)
spec.loader.exec_module(th)


def free_port(ip):
    s = socket.socket()
    s.bind((ip, 0))
    port = s.getsockname()[1]
    s.close()
    return port


class RealSystemd(unittest.TestCase):
    def test_real_user_unit(self):
        tmp = Path(tempfile.mkdtemp(prefix='swr-real-'))
        tmp.chmod(0o700)
        host, ctl = ('127.0.0.1', free_port('127.0.0.1')), ('127.0.0.2', free_port('127.0.0.2'))
        servers = [th.serve(host, b'gamma' * 1000), th.serve(ctl, b'')]
        try:
            root = tmp / 'root'
            root.mkdir(mode=0o700)
            run = root / ('20261023T000000Z-' + secrets.token_hex(4))
            run.mkdir(mode=0o700)
            snap = {'version': 1, 'created_at': 'x', 'objects': {}, 'keys': [], 'fake': {'mode': 'ok', 'tryBlocked': [list(ctl)]},
                    'hosts': [{'public_key': 'k', 'addresses': [{'protocol': 'siamux', 'address': '%s:%d' % host}]}]}
            raw = json.dumps(snap).encode()
            (tmp / 'snapshot.json').write_bytes(raw)
            (run / 'snapshot-ip-pinned.json').write_bytes(raw)
            (tmp / 'archive').write_bytes(b'a')
            key = tmp / 'app.seed'
            key.write_text('SENTINEL-REAL-' + secrets.token_hex(8))
            key.chmod(0o600)
            sha = hashlib.sha256(raw).hexdigest()
            (run / 'run.json').write_text(json.dumps({
                'snapshot': str(tmp / 'snapshot.json'), 'snapshotSha256': sha, 'archive': str(tmp / 'archive'),
                'archiveSha256': hashlib.sha256(b'a').hexdigest(), 'keyFile': str(key), 'derivativeSha256': sha,
                'endpoints': [{'ip': host[0], 'port': host[1]}], 'blockedNames': [],
                'blocked': [{'label': 'indexer', 'ip': ctl[0], 'port': ctl[1], 'outsideMustConnect': True}]}))
            code, o, _ = th.call('start', '--run', str(run), '--target', 'local', '--binary', str(th.FAKE),
                                 '--binary-sha', hashlib.sha256(th.FAKE.read_bytes()).hexdigest(), '--max-total-bytes', '100000',
                                 '--deadline-secs', '60', '--memory-max-mib', '256')
            self.assertEqual(code, 0, o)
            for _ in range(120):
                code, p, _ = th.call('poll', '--run', str(run))
                if p['state'] != 'running':
                    break
                time.sleep(0.5)
            self.assertEqual((code, p['state']), (0, 'succeeded'), p)
            started = json.loads((Path(o['attempt']) / 'started.json').read_text())
            self.assertRegex(started['invocationId'] or '', '^[0-9a-f]{32}$', 'the real unit passed its invocation id')
            self.assertEqual(p['result']['probes']['isolated'], True)
            self.assertEqual(p['result']['restore']['onDiskBytes'], 5000)
            self.assertGreater(p['result']['memoryPeakBytes'] or 0, 0, 'the unit cgroup memory.peak is recorded')
            inv = json.loads((Path(o['attempt']) / 'restored' / 'inventory.json').read_text())
            self.assertEqual(inv['fakeBlockedReached'], [False])
            code, f, _ = th.call('finish', '--run', str(run))
            self.assertEqual((code, f['stagingRemoved']), (0, True))
            print(json.dumps({'unit': o['unit'], 'unitState': p['unitState'], 'probes': p['result']['probes'],
                              'memoryPeakBytes': p['result']['memoryPeakBytes']}))
        finally:
            for s in servers:
                th.close(s)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
