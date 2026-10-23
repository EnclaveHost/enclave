"""The network-hdd-nbd layout (validation, rendering, gating) and the guarantee that the LOCAL loop layout renders byte for
byte as at S 92b71784. Kernel, systemd and NBD behaviour are exercised in the composition workspace's KVM guest test,
not here."""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('holder', HERE.parent / 'holder.py')
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
spec2 = importlib.util.spec_from_file_location('storage_nbd', HERE.parent / 'storage_nbd.py')
N = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(N)
EXAMPLE = json.loads((HERE.parent / 'holder.example.json').read_text())
BASE_COMMIT = '92b71784c9452056eeeb6a97b8e1fcb8ef1815ca'
WATCH_KEYS = {"format", "role", "attachConfig", "device", "mapping", "mountPoint", "intervalSec", "probeTimeoutSec", "failureFile"}


def placement(role='base', nbytes=3_100_000_000_000):
    return {'exportName': f'enclave-rpc-{role}', 'imageBytes': nbytes, 'imagePath': f'/mnt/usb/enclave-rpc/{role}-origin.img',
            'mountTarget': '/mnt/usb', 'fstype': 'ntfs3', 'requireRotational': True, 'serverCertSha256': 'a' * 64, 'caCertSha256': 'b' * 64}


def good(cached=True):
    c = copy.deepcopy(EXAMPLE)
    c['binary']['sha256'] = H.BINARY['binary']['sha256']
    c['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
    c['storage']['layout'] = 'network-hdd-nbd'
    c['storage']['origin'] = {'transport': 'enclave-rpc-hdd-nbd/v1', 'role': 'base', 'attachConfig': '/etc/enclave-rpc-hdd/attach-base.json',
                              'device': '/dev/nbd1', 'placement': placement(), 'bytes': 3_100_000_000_000, 'filesystemUuid': None}
    if not cached:
        c['storage']['cache'] = {'mechanism': 'none'}
        c['storage'].pop('nvmeBudget', None)
    return c


class Network(unittest.TestCase):
    def refused(self, mutate, needle):
        c = good()
        mutate(c)
        with self.assertRaises(H.Refused) as e:
            H.validate(c)
        self.assertIn(needle, str(e.exception))

    def test_valid_and_pinned(self):
        c = H.validate(good())
        o = c['storage']['origin']
        self.assertEqual(o['placementSha256'], __import__('hashlib').sha256(H.canonical_json(placement())).hexdigest())
        self.assertEqual(c['storage']['nvmeAccounting']['capBytes'], 250_000_000_000)   # the cache rules are S's, unchanged

    def test_false_or_foreign_placements_are_refused(self):
        P = lambda **kw: (lambda c: c['storage']['origin']['placement'].update(**kw))
        self.refused(P(requireRotational=False), 'requireRotational must be true')
        self.refused(P(fstype='tmpfs'), 'fstype')
        self.refused(P(exportName='enclave-rpc-l1'), 'enclave-rpc-base export')
        self.refused(P(imageBytes=3_100_000_000_512), 'exactly storage.origin.bytes')
        self.refused(P(imagePath='/mnt/usb/enclave-rpc/l1-origin.img'), 'base-origin.img')
        self.refused(P(mountTarget='/'), 'base-origin.img')
        self.refused(P(serverCertSha256='x'), 'fingerprint')
        self.refused(lambda c: c['storage']['origin']['placement'].pop('caCertSha256'), 'required')
        self.refused(lambda c: c['storage']['origin'].update(transport='nbd'), 'transport')
        self.refused(lambda c: c['storage']['origin'].update(device='/dev/sdb'), '/dev/nbdN')
        self.refused(lambda c: c['storage']['origin'].update(filesystemUuid='not-a-uuid'), 'filesystemUuid')
        self.refused(lambda c: c['storage']['origin'].update(role='l1', placement=placement('l1')), 'role base')
        self.refused(lambda c: c['storage'].update(layout='nbd-any'), 'storage.layout')

    def test_render_gates_the_consumer_on_the_supervisor(self):
        for cached in (True, False):
            c = H.validate(good(cached))
            with tempfile.TemporaryDirectory() as d:
                m = H.render(c, Path(d) / 'o')
                files = set(m['files'])
                self.assertNotIn('holder-storage.sh', files)
                for f in ('enclave-base-holder-storage.service', 'enclave-base-holder-watch.service', 'holder-storage-nbd.json', 'holder-watch.json'):
                    self.assertIn(f, files)
                u = (Path(d) / 'o/enclave-base-holder.service').read_text()
                for line in ('Requires=enclave-base-holder-watch.service', 'BindsTo=enclave-base-holder-watch.service',
                             'After=network-online.target enclave-base-holder-watch.service',
                             f"ReadWritePaths={c['datadir']} {c['storage']['mountPoint']}/tmp"):
                    self.assertIn(line + '\n', u)
                self.assertNotIn('Requires=enclave-base-holder-storage.service', u)
                st = (Path(d) / 'o/enclave-base-holder-storage.service').read_text()
                for line in ('Requires=enclave-rpc-hdd-attach@base.service', 'BindsTo=enclave-rpc-hdd-attach@base.service', 'Type=oneshot'):
                    self.assertIn(line + '\n', st)
                w = (Path(d) / 'o/enclave-base-holder-watch.service').read_text()
                for line in ('Type=notify', 'Restart=no', 'BindsTo=enclave-base-holder-storage.service', 'DeviceAllow=/dev/nbd1 r',
                             'DevicePolicy=closed', 'NoNewPrivileges=yes', f"CapabilityBoundingSet={'CAP_SYS_ADMIN' if cached else ''}"):
                    self.assertIn(line + '\n', w)
                self.assertEqual('DeviceAllow=/dev/mapper/control rw' in w, cached)
                sc = json.loads((Path(d) / 'o/holder-storage-nbd.json').read_text())
                self.assertEqual(set(sc), N.KEYS)
                with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
                    json.dump(sc, f); f.flush()
                    self.assertEqual(N.load(f.name)['mechanism'], 'dm-cache' if cached else 'none')
                wc = json.loads((Path(d) / 'o/holder-watch.json').read_text())
                self.assertEqual(set(wc), WATCH_KEYS)
                self.assertEqual(wc['mapping'], 'enclave-base-holder' if cached else None)
                self.assertEqual(wc['failureFile'], sc['watchFailureFile'])

    def test_local_layout_renders_byte_identically_to_the_pinned_original(self):
        """The local loop layout (holder-storage.sh.in cab32bbe and its units) must not change."""
        repo = HERE.parent.parent
        old = subprocess.run(['git', '-C', str(repo), 'show', f'{BASE_COMMIT}:holder/holder.py'], capture_output=True, check=True).stdout
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / 'holder.py').write_bytes(old)
            for f in ('FLAGS.json', 'BINARY.json', 'budget.py', 'holder-storage.sh.in'):
                (Path(d) / f).write_bytes(subprocess.run(['git', '-C', str(repo), 'show', f'{BASE_COMMIT}:holder/{f}'],
                                                         capture_output=True, check=True).stdout)
            sys.path.insert(0, d)
            try:
                s2 = importlib.util.spec_from_file_location('holder_old', Path(d) / 'holder.py')
                O = importlib.util.module_from_spec(s2); s2.loader.exec_module(O)
            finally:
                sys.path.remove(d)
            c = copy.deepcopy(EXAMPLE); c['binary']['sha256'] = H.BINARY['binary']['sha256']
            c['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
            for cached in (True, False):
                cc = copy.deepcopy(c)
                if not cached:
                    cc['storage']['cache'] = {'mechanism': 'none'}; cc['storage'].pop('nvmeBudget', None)
                a, b = H.render(H.validate(cc), Path(d) / f'new{cached}'), O.render(O.validate(cc), Path(d) / f'old{cached}')
                self.assertEqual(a['files'], b['files'], 'local-layout render changed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
