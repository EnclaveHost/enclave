"""rpc/snp/build_image.py and the guest's memory: limits that follow the guest's size, logs that cannot fill it, no
stock service that installs or writes by itself, and the working-set probe.

python3 -m unittest test/rpc-snp/test_build_image_memory.py
"""
import base64
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import build_image as B  # noqa: E402

UNITS = '/etc/systemd/system/'
L1 = UNITS + 'srv-enclave\\x2dl1\\x2dpair.mount'
BASE = UNITS + 'srv-enclave\\x2dbase\\x2dholder.mount'
MOUNT = '[Mount]\nWhat=/dev/disk/by-uuid/%s\nWhere=%s\nType=ext4\nOptions=rw,noatime\n'


class Memory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        (Path(tmp.name)/'files').mkdir()
        writes = [{'path': p, 'content': MOUNT % (u, w)} for p, u, w in ((L1, 'a2f2', '/srv/enclave-l1-pair'), (BASE, '11c6', '/srv/enclave-base-holder'))]
        (Path(tmp.name)/'files/user-data').write_text('#cloud-config\n' + json.dumps({'write_files': writes}) + '\n')
        old = B.PRIVATE_SEED
        B.PRIVATE_SEED = Path(tmp.name)
        cls.addClassCleanup(setattr, B, 'PRIVATE_SEED', old)
        cls.files = {w['path']: base64.b64decode(w['content']).decode() if w.get('encoding') == 'b64' else w['content']
                     for w in B.seed_config('ssh-ed25519 AAAA test')['write_files']}
        cls.script = cls.files['/opt/enclave-rpc/build-image.sh'].splitlines()

    def test_no_limit_names_a_number_of_bytes(self):
        limits = {p: t for p, t in self.files.items() if p.endswith('/limits.conf')}
        self.assertEqual(sorted(limits), [UNITS + 'enclave-rpc-%s.d/limits.conf' % u for u in
                                          ('base.service', 'cl.service', 'clients.slice', 'el.service')])
        for path, text in limits.items():
            for line in text.splitlines():
                if line.startswith('Memory'):
                    self.assertRegex(line, r'^Memory(High|Max)=(\d{1,2}%|infinity)$', path)
        self.assertEqual(limits[UNITS + 'enclave-rpc-clients.slice.d/limits.conf'], '[Slice]\nMemoryHigh=90%\nMemoryMax=94%\n')

    def test_the_clients_share_the_slice_and_none_is_throttled_alone(self):
        for side, cap in (('el', 45), ('cl', 45), ('base', 75)):
            self.assertEqual(self.files[UNITS + 'enclave-rpc-%s.service.d/limits.conf' % side],
                             '[Service]\nTimeoutStopSec=300\nMemoryHigh=infinity\nMemoryMax=%d%%\n' % cap)
        # the slice throttles before it kills, leaves the rest of the guest a share, and holds any one client's maximum
        self.assertLess(B.CLIENTS_HIGH, B.CLIENTS_MAX)
        self.assertLessEqual(B.CLIENTS_MAX, 94)
        self.assertTrue(all(cap < B.CLIENTS_HIGH for cap in B.CLIENT_MAX.values()))
        self.assertEqual(sorted(B.CLIENT_MAX), ['base', 'cl', 'el'])

    def test_the_journal_is_capped_and_nothing_copies_it(self):
        for path in ('/etc/systemd/journald.conf.d/zz-enclave-rpc.conf', '/etc/systemd/journald@base.conf'):
            conf = dict(l.split('=', 1) for l in self.files[path].splitlines()[1:])
            self.assertEqual(self.files[path].splitlines()[0], '[Journal]')
            self.assertEqual(conf, {'Storage': 'persistent', 'SystemMaxUse': '256M', 'SystemMaxFileSize': '32M',
                                    'RuntimeMaxUse': '32M', 'ForwardToSyslog': 'no'})
        # the distribution's drop-in turns forwarding on; a later file name wins
        self.assertGreater('zz-enclave-rpc.conf', 'syslog.conf')
        self.assertEqual(self.files[UNITS + 'enclave-rpc-base.service.d/log-namespace.conf'], '[Service]\nLogNamespace=base\n')
        self.assertEqual([p for p in self.files if 'log-namespace' in p], [UNITS + 'enclave-rpc-base.service.d/log-namespace.conf'])

    def test_stock_services_that_write_or_install_by_themselves_are_masked(self):
        masks = [l for l in self.script if l.startswith('systemctl mask ') and 'ssh' not in l]
        self.assertEqual(len(masks), 1)
        masked = masks[0].split()[2:]
        self.assertEqual(masked, list(B.MASKED_UNITS))
        self.assertEqual(len(set(masked)), len(masked))
        for unit in ('rsyslog.service', 'syslog.socket', 'apt-daily.timer', 'apt-daily-upgrade.timer', 'apt-daily.service',
                     'apt-daily-upgrade.service', 'unattended-upgrades.service', 'snapd.service', 'snapd.socket'):
            self.assertIn(unit, masked)
        for unit in masked:
            self.assertRegex(unit, r'^[A-Za-z0-9@.-]+\.(service|socket|timer|path)$')
            self.assertFalse(re.match(r'enclave|systemd-|ssh|cron|fstrim|logrotate|multipath|iscsi|lvm|dm-|apparmor|ufw|network', unit), unit)
        # the build itself still installs its kernel modules with apt before anything is masked
        self.assertLess(self.script.index('apt-get -qy install linux-modules-extra-$(uname -r)'), self.script.index(masks[0]))

    def test_the_probe_is_shipped_enabled_and_confined(self):
        self.assertEqual(self.files['/opt/enclave-rpc/memprobe.py'], (ROOT/'rpc/snp/memprobe.py').read_text())
        unit = self.files[UNITS + 'enclave-rpc-memprobe.service'].splitlines()
        for line in ('ExecStart=/usr/bin/python3 -I /opt/enclave-rpc/memprobe.py', 'PrivateNetwork=yes', 'NoNewPrivileges=yes',
                     'ProtectSystem=strict', 'MemoryMax=64M', 'RuntimeDirectory=enclave-rpc-memprobe', 'WantedBy=multi-user.target'):
            self.assertIn(line, unit)
        self.assertNotIn('Slice=enclave-rpc-clients.slice', unit)   # its own reclaim work must not count as the clients' pressure
        self.assertIn('systemctl enable enclave-rpc-memprobe.service', self.script)
        import front as F
        import memprobe as M
        self.assertEqual(str(F.PROBE_STATE), str(M.STATE))
        self.assertEqual(str(M.STATE.parent), '/run/enclave-rpc-memprobe')
        self.assertEqual(F.cgroup_dir(F.MEMORY_UNITS['clients']), M.slice_dir(M.CGROUPS, M.SLICE))

    def test_the_image_record_names_the_probe_source(self):
        self.assertIn("'memprobe.py'", (ROOT/'rpc/snp/build_image.py').read_text().split("'sources':", 1)[1].split('}', 1)[0])


if __name__ == '__main__':
    unittest.main()
