"""The L1 pair's network-hdd-nbd layout (role binding, gating of BOTH node units on the supervisor) and the guarantee that
the LOCAL layout renders byte for byte as at P f8c999ed. Kernel/systemd/NBD behaviour: the composition workspace's KVM
guest test."""
import copy, importlib.util, io, json, os, subprocess, sys, tarfile, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(HERE))
import test_l1pair as T  # noqa: E402  (its good() builds a valid local config)
L = T.L
BASE_COMMIT = 'f8c999ed5a9600ef477ff05ee00b31dee366b2b1'


def placement(role='l1', nbytes=4_000_000_000_000):
    return {'exportName': f'enclave-rpc-{role}', 'imageBytes': nbytes, 'imagePath': f'/mnt/usb/enclave-rpc/{role}-origin.img',
            'mountTarget': '/mnt/usb', 'fstype': 'ntfs3', 'requireRotational': True, 'serverCertSha256': 'a' * 64, 'caCertSha256': 'b' * 64}


def network(cached=False):
    c = T.good()
    c['storage']['layout'] = 'network-hdd-nbd'
    c['storage']['origin'] = {'transport': 'enclave-rpc-hdd-nbd/v1', 'role': 'l1', 'attachConfig': '/etc/enclave-rpc-hdd/attach-l1.json',
                              'device': '/dev/nbd0', 'placement': placement(), 'bytes': 4_000_000_000_000, 'filesystemUuid': None}
    if cached:
        c['storage']['cache'] = T.cache(4 << 30)
        c['storage']['nvmeBudget'] = {'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}
    return c


class Network(unittest.TestCase):
    def test_l1_role_only(self):
        L.validate(network())
        c = network(); c['storage']['origin'].update(role='base', placement=placement('base', 4_000_000_000_000))
        with self.assertRaises(L.Refused) as e:
            L.validate(c)
        self.assertIn('role l1', str(e.exception))
        c = network(); c['storage']['origin']['placement']['requireRotational'] = False
        with self.assertRaises(L.Refused):
            L.validate(c)

    def test_both_node_units_bind_to_the_supervisor(self):
        for cached in (False, True):
            c = L.validate(network(cached))
            with tempfile.TemporaryDirectory() as d:
                m = L.render(c, Path(d) / 'o')
                self.assertNotIn('l1pair-storage.sh', m['files'])
                mnt = c['storage']['mountPoint']
                for side in ('el', 'cl'):
                    u = (Path(d) / f'o/enclave-l1-{side}.service').read_text()
                    for line in ('Requires=enclave-l1-pair-watch.service', 'BindsTo=enclave-l1-pair-watch.service',
                                 f'ReadWritePaths={mnt}/data {mnt}/tmp'):
                        self.assertIn(line + '\n', u, side)
                    self.assertNotIn('enclave-l1-pair-storage.service', u)
                cl = (Path(d) / 'o/enclave-l1-cl.service').read_text()
                self.assertIn('After=network-online.target enclave-l1-pair-watch.service enclave-l1-el.service\n', cl)
                st = (Path(d) / 'o/enclave-l1-pair-storage.service').read_text()
                self.assertIn('BindsTo=enclave-rpc-hdd-attach@l1.service\n', st)
                self.assertIn('Before=enclave-l1-pair-watch.service enclave-l1-el.service enclave-l1-cl.service\n', st)
                sc = json.loads((Path(d) / 'o/l1pair-storage-nbd.json').read_text())
                self.assertEqual((sc['role'], sc['name'], sc['mechanism']), ('l1', 'enclave-l1-pair', 'dm-cache' if cached else 'none'))
                self.assertEqual(sc['dirs'], [f'{mnt}/data', f'{mnt}/tmp'])
                wc = json.loads((Path(d) / 'o/l1pair-watch.json').read_text())
                self.assertEqual((wc['device'], wc['mapping']), ('/dev/nbd0', 'enclave-l1-pair' if cached else None))

    def test_local_layout_renders_byte_identically_to_the_pinned_original(self):
        tar = subprocess.run(['git', '-C', str(PKG.parent), 'archive', BASE_COMMIT, 'l1pair'], capture_output=True, check=True).stdout
        with tempfile.TemporaryDirectory() as d:
            tarfile.open(fileobj=io.BytesIO(tar)).extractall(d, filter='data')
            s2 = importlib.util.spec_from_file_location('l1pair_old', Path(d) / 'l1pair/l1pair.py')
            O = importlib.util.module_from_spec(s2); s2.loader.exec_module(O)
            for cached in (False, True):
                c = T.good()
                if cached:
                    c['storage']['cache'] = T.cache(4 << 30)
                    c['storage']['nvmeBudget'] = {'ledgerPath': '/etc/enclave-rpc-cache/nvme-cache-budget.json', 'reservationId': 'l1-pair-dm-cache'}
                a = L.render(L.validate(copy.deepcopy(c)), Path(d) / f'new{cached}')
                b = O.render(O.validate(copy.deepcopy(c)), Path(d) / f'old{cached}')
                self.assertEqual(a['files'], b['files'], 'local-layout render changed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
