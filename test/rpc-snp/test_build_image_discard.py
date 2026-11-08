"""rpc/snp/build_image.py gives the chain disks online discard and a daily fstrim that reaches them.

python3 -m unittest test/rpc-snp/test_build_image_discard.py
"""
import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import build_image as B  # noqa: E402

L1 = '/etc/systemd/system/srv-enclave\\x2dl1\\x2dpair.mount'
BASE = '/etc/systemd/system/srv-enclave\\x2dbase\\x2dholder.mount'


def mount(what, where, options='rw,noatime'):
    return ('[Unit]\nDescription=Exclusive RPC disk\n[Mount]\nWhat=/dev/disk/by-uuid/%s\nWhere=%s\nType=ext4\n'
            'Options=%s\nTimeoutSec=20\n' % (what, where, options))


def b64(path, text):
    return {'path': path, 'encoding': 'b64', 'permissions': '0644', 'content': base64.b64encode(text.encode()).decode()}


class Discard(unittest.TestCase):
    def seed(self, writes):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        (Path(tmp.name)/'files').mkdir()
        (Path(tmp.name)/'files/user-data').write_text('#cloud-config\n' + json.dumps({'write_files': writes}) + '\n')
        old = B.PRIVATE_SEED
        B.PRIVATE_SEED = Path(tmp.name)
        self.addCleanup(setattr, B, 'PRIVATE_SEED', old)
        return {w['path']: w for w in B.seed_config('ssh-ed25519 AAAA test')['write_files']}

    def text(self, w):
        return base64.b64decode(w['content']).decode()

    def test_drop_ins(self):
        files = self.seed([b64(L1, mount('a2f2', '/srv/enclave-l1-pair')), b64(BASE, mount('11c6', '/srv/enclave-base-holder')),
                           b64('/etc/ssh/sshd_config.d/00-rpc.conf', 'x')])
        for unit in (L1, BASE):
            self.assertEqual(self.text(files[unit + '.d/discard.conf']), '[Mount]\nOptions=rw,noatime,discard\n')
            self.assertIn(unit, files)   # the seed's own unit is shipped unchanged
        svc = self.text(files['/etc/systemd/system/fstrim.service.d/chain-disks.conf'])
        self.assertIn('ExecStart=\n', svc)   # clears the stock /etc/fstab-only command
        self.assertIn('--listed-in /proc/self/mountinfo', svc)
        self.assertNotIn('/etc/fstab', svc)
        self.assertIn('OnCalendar=daily', self.text(files['/etc/systemd/system/fstrim.timer.d/daily.conf']))
        self.assertNotIn('/etc/ssh/sshd_config.d/00-rpc.conf', files)

    def test_plain_content_and_refusals(self):
        plain = {'path': L1, 'content': mount('a2f2', '/srv/enclave-l1-pair')}
        self.assertEqual(B.discard_mounts([plain, b64(BASE, mount('11c6', '/srv/x'))]), [L1, BASE])
        with self.assertRaises(ValueError):   # options the drop-in would silently drop
            B.discard_mounts([b64(L1, mount('a', '/srv/a', 'rw,noatime,errors=remount-ro')), b64(BASE, mount('b', '/srv/b'))])
        with self.assertRaises(ValueError):
            B.discard_mounts([b64(L1, mount('a', '/srv/a'))])

    @unittest.skipUnless((B.PRIVATE_SEED/'files/user-data').exists(), 'needs the private direct-guest seed')
    def test_real_seed(self):
        raw = (B.PRIVATE_SEED/'files/user-data').read_text()
        writes = json.loads(raw.split('\n', 1)[1])['write_files']
        self.assertEqual(B.discard_mounts(writes), [L1, BASE])


if __name__ == '__main__':
    unittest.main()
