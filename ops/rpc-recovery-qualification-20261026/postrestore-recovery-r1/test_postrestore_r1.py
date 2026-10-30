"""postrestore-recovery-stage/r1 offline tests:  cd <this dir> && python3 -B -I -m unittest discover -s . -p test_postrestore_r1.py -v
The LIVE launcher and manifest are only READ (the manifest is rewritten into a temp fixture); systemctl, debugfs and the USB
mount are fakes; no image is opened except the tiny fake qcow2 headers in the temp dir; nothing touches HOME, the VM or /mnt/usb."""
import contextlib, copy, hashlib, importlib.util, io, json, os, shutil, struct, sys, tempfile, types, unittest
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_STATE = '/home/steven/.local/state/enclave-rpc-production'
LAUNCHER, LIVE_MANIFEST = f'{LIVE_STATE}/provision_vm.py', f'{LIVE_STATE}/manifest.json'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


I = load('inspect_units_r1', os.path.join(HERE, 'inspect_units.py'))
B = load('rebind_usb_r1', os.path.join(HERE, 'rebind_usb.py'))
sha = lambda b: hashlib.sha256(b).hexdigest()


# ---- unit inventory (fake debugfs over a fake ext4 tree) ----------------------------------------------------------------
class Link(str):
    fast, broken = True, False


def link(target, fast=True, broken=False):
    l = Link(target); l.fast, l.broken = fast, broken; return l


class Err(str):
    is_dir = True


DIR = ('dir',)
BANNER = b'debugfs 1.47.1 (20-May-2024)\ncatastrophic mode - not reading inode or group bitmaps\n'


class FakeFS:
    def __init__(self, tree, states=None):
        self.tree, self.calls, self.states = dict(tree), [], states or {}
        for p in list(self.tree):
            q = os.path.dirname(p)
            while q not in ('', '/'):
                self.tree.setdefault(q, DIR); q = os.path.dirname(q)

    @staticmethod
    def res(out=b'', err=b''):
        return types.SimpleNamespace(returncode=0, stdout=out, stderr=err)

    def mode(self, n):
        return 0o120777 if isinstance(n, Link) else 0o40755 if n is DIR or (isinstance(n, Err) and n.is_dir) else 0o100644

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        if argv[0] == 'systemctl':
            return types.SimpleNamespace(returncode=0, stdout=self.states.get(argv[-1], 'inactive') + '\n', stderr='')
        assert argv[:3] == ['debugfs', '-c', '-R'] and kw.get('capture_output'), argv
        cmd, path = argv[3].split(' ')[0], argv[3].rsplit(' ', 1)[1]
        node = self.tree.get(path)
        if node is None:
            return self.res(err=BANNER + f'{cmd}: File not found by ext2_lookup while doing {cmd}\n'.encode())
        if isinstance(node, Err):
            return self.res(err=BANNER + f'{cmd}: {node}\n'.encode())
        if cmd == 'ls':
            if node is not DIR:
                return self.res(err=BANNER + b'ls: Ext2 inode is not a directory\n')
            kids = sorted(k for k in self.tree if os.path.dirname(k) == path)
            return self.res(''.join(f'/{i}/{self.mode(self.tree[k]):o}/0/0/{os.path.basename(k)}/0/\n' for i, k in enumerate(kids, 10)).encode(), BANNER)
        if cmd == 'stat':
            if isinstance(node, Link):
                return self.res(('Inode: 9   Type: symlink\n' + (f'Fast link dest: "{node}"\n' if node.fast else '')).encode(), BANNER)
            return self.res(b'Inode: 9   Type: regular\n' if isinstance(node, bytes) else b'Inode: 9   Type: directory\n', BANNER)
        if isinstance(node, Link):
            return self.res(err=BANNER + b'cat: Ext2 file too big\n') if node.broken else self.res(str(node).encode(), BANNER)
        return self.res(node if isinstance(node, bytes) else b'', BANNER)


E, U = '/etc/systemd/system', '/usr/lib/systemd/system'
SNAP = (b'[Unit]\nRequiresMountsFor=/srv/enclave-base-holder\nConditionPathExists=!/srv/enclave-base-holder/snapshot-complete\n'
        b'[Service]\nEnvironment=API_TOKEN=supersecret\nExecStart=/opt/x download\n[Install]\nWantedBy=multi-user.target\n')
TREE = {
    f'{E}/enclave-rpc-base-snapshot.service': SNAP,
    f'{E}/enclave-rpc-base-snapshot.service.d/30-download-concurrency.conf':
        b'[Service]\nExecStart=\nExecStart=/opt/x download --download-concurrency 16\nEnvironment=OTHER=hunter2\n',
    f'{E}/multi-user.target.wants/enclave-rpc-base-snapshot.service': link(f'{E}/enclave-rpc-base-snapshot.service'),
    f'{E}/multi-user.target.wants/enclave-rpc-l1-snapshot.service': link(f'{E}/enclave-rpc-l1-snapshot.service'),
    f'{E}/enclave-rpc-l1-snapshot.service': link('/dev/null'),                  # masked although a .wants link exists
    f'{U}/enclave-rpc-l1-snapshot.service': b'[Service]\nExecStart=/opt/y\n',
    f'{E}/enclave-base-holder.service': b'',                                    # zero-byte mask over the vendor unit
    f'{U}/enclave-base-holder.service': b'[Service]\nExecStart=/opt/h\n',
    f'{E}/enclave-base-holder.path': link('/dev/null'),
    f'{E}/multi-user.target.wants/enclave-l1-el.path': link(f'{E}/enclave-l1-el.path'),
    f'{E}/enclave-l1-el.path': b'[Path]\nPathExists=/srv/enclave-l1-pair/ready\nUnit=enclave-l1-el.service\n[Install]\nWantedBy=multi-user.target\n',
    f'{E}/enclave-l1-el.service': b'[Service]\nExecStart=/opt/el\n',
    f'{E}/enclave-l1-cl.service': link(f'{U}/enclave-l1-cl.service', fast=False),
    f'{U}/enclave-l1-cl.service': b'[Service]\nExecStart=/opt/cl\n',
    f'{E}/multi-user.target.wants/enclave-l1-cl.service': link(f'{E}/enclave-l1-cl.service'),
    f'{U}/enclave-base-retention.service': b'[Service]\nType=oneshot\nExecStart=/opt/r\n',
    f'{U}/enclave-base-retention.timer': b'[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n',
    f'{U}/timers.target.wants/enclave-base-retention.timer': link('../enclave-base-retention.timer'),
    f'{E}/getty.target.wants/getty@tty1.service': link('/usr/lib/systemd/system/getty@.service'),
    f'{E}/unrelated.service': b'[Service]\nExecStart=/bin/true\n',
}


class Inventory(unittest.TestCase):
    def setUp(self):
        self.frozen = I.load_pinned(I.FROZEN, I.FROZEN_SHA256, 'frozen_test')
        self.t = tempfile.TemporaryDirectory(); self.payload = os.path.join(self.t.name, 'payload.service')
        open(self.payload, 'wb').write(SNAP)

    def tearDown(self):
        self.t.cleanup()

    def run_inv(self, tree):
        return I.extended(self.frozen)('x?offset=0', self.payload, FakeFS(tree))

    def test_masks_symlinks_dropins_and_activation(self):
        body = self.run_inv(TREE); inv, u = body['unitInventory'], body['unitInventory']['units']
        self.assertEqual(inv['readErrors'], []); self.assertTrue(inv['complete'])
        self.assertEqual(inv['dirs']['/lib/systemd/system']['status'], 'absent')
        # the frozen body is preserved, and shows why a .wants link alone is not enough
        self.assertFalse(body['bootSnapshotSafe']); self.assertEqual(body['snapshotUnit']['dropIns'], ['30-download-concurrency.conf'])
        self.assertTrue(body['enabled']['enclave-rpc-l1-snapshot.service'])
        self.assertIs(u['enclave-rpc-l1-snapshot.service']['masked'], True); self.assertEqual(u['enclave-rpc-l1-snapshot.service']['bootLinked'], 'masked')
        self.assertTrue(u['enclave-rpc-l1-snapshot.service']['enabledBy'])
        self.assertIs(u['enclave-base-holder.service']['masked'], True); self.assertEqual(u['enclave-base-holder.service']['layers'], [E, U])
        self.assertEqual(u['enclave-base-holder.path']['bootLinked'], 'masked')
        s = u['enclave-rpc-base-snapshot.service']
        self.assertIs(s['masked'], False); self.assertEqual(s['bootLinked'], 'linked')
        conf = s['dropIns'][f'{E}/enclave-rpc-base-snapshot.service.d']['entries']['30-download-concurrency.conf']
        self.assertIn('ExecStart=/opt/x download --download-concurrency 16', conf['directives'])
        self.assertEqual(u['enclave-l1-el.path']['triggers'], 'enclave-l1-el.service')
        el = u['enclave-l1-el.service']
        self.assertEqual([t['unit'] for t in el['triggeredBy']], ['enclave-l1-el.path']); self.assertEqual(el['bootLinked'], 'linked')
        self.assertEqual(inv['dirs'][E]['entries']['enclave-l1-cl.service']['target'], f'{U}/enclave-l1-cl.service')   # slow symlink
        self.assertEqual(u['enclave-l1-cl.service']['bootLinked'], 'linked')
        r = u['enclave-base-retention.service']
        self.assertEqual(r['triggeredBy'][0]['unit'], 'enclave-base-retention.timer'); self.assertEqual(r['bootLinked'], 'linked')
        for secret in ('supersecret', 'hunter2', 'Environment='):
            self.assertNotIn(secret, json.dumps(body))
        for other in ('getty', 'unrelated.service'):                                # non-enclave entries are not inventoried
            self.assertNotIn(other, json.dumps(inv))

    def test_unit_absent_everywhere_is_not_linked_only_without_errors(self):
        tree = {k: v for k, v in TREE.items() if 'enclave-l1-el' not in k}
        self.assertEqual(self.run_inv(tree)['unitInventory']['units']['enclave-l1-el.service']['bootLinked'], 'not-linked')

    def test_read_errors_make_verdicts_unknown(self):
        tree = dict(TREE); tree[U] = Err('EXT2 directory corrupted')
        inv = self.run_inv(tree)['unitInventory']; u = inv['units']
        self.assertFalse(inv['complete']); self.assertTrue(any(U in e for e in inv['readErrors']))
        self.assertEqual(inv['dirs'][U]['status'], 'error')
        self.assertIs(u['enclave-rpc-l1-snapshot.service']['masked'], True)          # a mask that WAS read stays proven
        for n in ('enclave-l1-el.service', 'enclave-base-retention.service', 'enclave-rpc-base-snapshot.service'):
            self.assertEqual(u[n]['masked'], 'unknown'); self.assertEqual(u[n]['bootLinked'], 'unknown')
        tree = dict(TREE); tree[f'{E}/enclave-l1-cl.service'] = link('x', fast=False, broken=True)
        inv = self.run_inv(tree)['unitInventory']
        self.assertIsNone(inv['dirs'][E]['entries']['enclave-l1-cl.service']['target'])
        self.assertEqual(inv['units']['enclave-l1-cl.service']['masked'], 'unknown')
        tree = dict(TREE); tree[f'{E}/multi-user.target.wants'] = Err('Ext2 inode is not a directory')
        inv = self.run_inv(tree)['unitInventory']
        self.assertFalse(inv['complete']); self.assertEqual(inv['units']['enclave-rpc-base-snapshot.service']['bootLinked'], 'unknown')

    def test_frozen_source_is_pinned(self):
        bad = os.path.join(self.t.name, 'inspect_os_disk.py')
        open(bad, 'wb').write(open(I.FROZEN, 'rb').read() + b'\n')
        with self.assertRaises(I.PinError):
            I.load_pinned(bad, I.FROZEN_SHA256, 'x')
        orig, I.FROZEN = I.FROZEN, bad
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(I.main([], run=FakeFS({})), 2)
            self.assertIn('refused', out.getvalue())
        finally:
            I.FROZEN = orig

    def test_frozen_lifecycle_refuses_running_vm_before_any_disk_access(self):
        osd = os.path.join(self.t.name, 'os.qcow2'); open(osd, 'wb').close()
        man = os.path.join(self.t.name, 'manifest.json'); json.dump({'disks': {'os': {'path': osd}}}, open(man, 'w'))
        for unit in self.frozen.VM_UNITS:
            fs = FakeFS(TREE, states={unit: 'active'}); out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(I.main(['--manifest', man, '--payload-unit', self.payload], run=fs), 2)
            self.assertIn('refused', out.getvalue())
            self.assertFalse([c for c in fs.calls if c[0] != 'systemctl'])


# ---- USB identity rebind --------------------------------------------------------------------------------------------------
def qcow2(path, size):
    h = bytearray(512); h[:4] = b'QFI\xfb'; struct.pack_into('>I', h, 4, 3); struct.pack_into('>Q', h, 24, size)
    open(path, 'wb').write(bytes(h)); os.chmod(path, 0o644)


class Rebind(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); T = self.T = self.t.name
        self.mod = B.exec_pinned(B.read_pinned(LAUNCHER, B.LAUNCHER_SHA, 'launcher'), LAUNCHER, 'pv_fixture')
        m = json.load(open(LIVE_MANIFEST))
        h, n = m['backings']['hdd'], m['backings']['nvme']
        h['mount'], h['dir'] = f'{T}/usb', f'{T}/usb/enclave-rpc-production'
        n['mount'], n['dir'] = f'{T}/vm', f'{T}/vm/enclave-volumes/rpc-production'
        os.makedirs(h['dir']); os.makedirs(n['dir']); os.makedirs(f'{T}/state'); os.makedirs(f'{T}/units')
        m['paths']['hddDir'] = h['dir']
        for role, d in m['disks'].items():
            d['path'] = (h if d['backing'] == 'hdd' else n)['dir'] + '/' + os.path.basename(d['path'])
            qcow2(d['path'], d['bytes'])
            if role != 'base':
                d['ino'] = os.lstat(d['path']).st_ino          # base keeps the pre-restore 3221
        m['paths']['osDisk'], m['uid'] = m['disks']['os']['path'], os.getuid()
        m['files']['qemuArgv'] = self.mod.sha256_text(self.mod.canonical(self.mod.qemu_argv(m)))   # fixture paths only
        self.m1 = m
        self.write_manifest(m)
        msha = self.pins['manifest']
        for name, text in ((self.mod.UNIT, self.mod.render_unit(m, msha)), (self.mod.GUARD_UNIT, self.mod.render_guard_unit(m, msha))):
            open(f'{T}/units/{name}', 'w').write(text)
        self.rest = {'complete': True, 'completed_at': '2026-10-28T01:56:53.016772+00:00', 'mount_uuid': '702FE78A62B4C5DC',
                     'database_image': m['disks']['base']['path'], 'database_internal_path': '/data/db/mdbx.dat',
                     'database_bytes': 1138166333440, 'image_modified_after_current_file_copy': True}
        self.clean = {'complete': True, 'completed_at': '2026-10-28T02:00:17.849643+00:00', 'restored_usb_files_retained': True}
        self.write_receipts()
        self.states = {self.mod.UNIT: ('inactive', 0), self.mod.GUARD_UNIT: ('inactive', 0)}
        self.desc = {'mount': h['mount'], 'fstype': 'ntfs3', 'source': '/dev/sda1', 'fsUuid': '702FE78A62B4C5DC', 'rw': True,
                     'leafDisks': [{'model': 'TR-004 DISK00', 'name': 'sdb', 'rotational': True}]}
        self.env = {'launcher': LAUNCHER, 'manifest': f'{T}/state/manifest.json', 'unitDir': f'{T}/units',
                    'restoration': f'{T}/rest.json', 'cleanup': f'{T}/clean.json', 'pins': self.pins,
                    'unit_state': lambda u: self.states[u], 'open_by': B.open_by, 'describe': lambda mount: copy.deepcopy(self.desc)}
        self.n = 0

    def tearDown(self):
        self.t.cleanup()

    def write_manifest(self, m):
        text = self.mod.canonical(m); open(f'{self.T}/state/manifest.json', 'w').write(text)
        self.pins = getattr(self, 'pins', {'launcher': B.LAUNCHER_SHA}); self.pins['manifest'] = sha(text.encode())

    def write_receipts(self):
        for name, rec in (('rest', self.rest), ('clean', self.clean)):
            b = json.dumps(rec).encode(); open(f'{self.T}/{name}.json', 'wb').write(b)
            self.pins['restoration' if name == 'rest' else 'cleanup'] = sha(b)

    def path(self, stem):
        self.n += 1; return f'{self.T}/{stem}-{self.n}'

    def observe(self):
        p = self.path('obs.json'); B.cmd_observe(self.env, p); return p

    def refused(self, fn, *a, text=None):
        with self.assertRaises(B.Refuse) as cm:
            fn(self.env, *a)
        if text:
            self.assertIn(text, str(cm.exception))

    def live(self):
        return {p: open(p, 'rb').read() for p in (self.env['manifest'], f'{self.T}/units/{self.mod.UNIT}', f'{self.T}/units/{self.mod.GUARD_UNIT}')}

    def test_stage_is_exactly_the_allowed_diff_and_checks_current(self):
        before = self.live(); out = self.path('stage')
        ev = B.cmd_stage(self.env, self.observe(), out)
        self.assertEqual(self.live(), before)
        self.assertEqual(sorted(os.listdir(out)), sorted(B.STAGE_FILES + ('SHA256SUMS',))); self.assertEqual(os.stat(out).st_mode & 0o777, 0o700)
        mtext2 = open(f'{out}/manifest.json').read(); m2 = json.loads(mtext2)
        self.assertEqual(B.diff_keys(self.m1, m2), ['backings.hdd.fsUuid', 'backings.hdd.leafDisks', 'backings.hdd.source', 'disks.base.ino'])
        self.assertEqual(m2['disks']['base']['ino'], os.lstat(self.m1['disks']['base']['path']).st_ino)
        self.assertEqual((m2['backings']['hdd']['fsUuid'], m2['backings']['hdd']['source']), ('702FE78A62B4C5DC', '/dev/sda1'))
        self.assertEqual(m2['vm']['hostReserveBytes'], 16 << 30)
        msha2 = sha(mtext2.encode()); self.assertEqual(ev['to']['manifestSha256'], msha2)
        self.assertEqual(open(f'{out}/{self.mod.UNIT}').read(), self.mod.render_unit(m2, msha2))
        self.assertEqual(open(f'{out}/{self.mod.GUARD_UNIT}').read(), self.mod.render_guard_unit(m2, msha2))
        self.assertIs(ev['installed'], False); self.assertIn('NOT INSTALLED', open(f'{out}/NOT-INSTALLED.md').read())
        self.assertIn('doesNotAttest', ev['receiptCopyProof']); self.assertNotIn('"ino"', json.dumps(ev['receiptCopyProof']))
        for line in open(f'{out}/SHA256SUMS'):
            h, n = line.split(); self.assertEqual(sha(open(f'{out}/{n}', 'rb').read()), h)
        self.assertTrue(B.cmd_check_stage(self.env, out)['current'])

    def test_allowed_diff_refuses_every_other_change(self):
        ident = B.observe_identity(self.mod, self.m1, self.env); m2 = B.rebind(self.m1, ident)
        self.assertEqual(sorted(B.allowed_diff(self.m1, m2)), ['backings.hdd.fsUuid', 'backings.hdd.leafDisks', 'backings.hdd.source', 'disks.base.ino'])
        for mutate in (lambda m: m['vm'].update(guestMemBytes=48 << 30), lambda m: m['vm'].update(hostReserveBytes=8 << 30),
                       lambda m: m['ports'].update(ssh=22), lambda m: m.update(sshPublicKey='x'), lambda m: m['baseImage'].update(sha256='0'),
                       lambda m: m['disks']['os'].update(path='/vm/other.qcow2'), lambda m: m['disks']['l1'].update(ino=1),
                       lambda m: m['disks']['base'].update(path='/mnt/usb/x.qcow2'), lambda m: m['backings']['hdd'].update(dir='/mnt/usb/x'),
                       lambda m: m['backings']['nvme'].update(fsUuid='x'), lambda m: m['files'].update(seedIso='0'),
                       lambda m: m['paths'].update(key='/tmp/k'), lambda m: m['backings']['hdd'].pop('fsUuid')):
            bad = copy.deepcopy(m2); mutate(bad)
            with self.assertRaises(B.Refuse):
                B.allowed_diff(self.m1, bad)

    def test_refuses_wrong_usb_identity(self):
        for k, v in (('fsUuid', '489ED12D9ED11472'), ('fsUuid', None), ('fsUuid', '702FE78A62B4C5DD'), ('source', '/dev/sda2'),
                     ('source', '/dev/sdb1'), ('fstype', 'ext4'), ('rw', False),
                     ('leafDisks', [{'model': 'x', 'name': 'sda', 'rotational': False}]), ('leafDisks', [])):
            good = copy.deepcopy(self.desc); self.desc[k] = v
            self.refused(B.cmd_observe, self.path('obs.json')); self.desc = good

    def test_refuses_running_vm_or_guard(self):
        for u, st in ((self.mod.UNIT, ('active', 123)), (self.mod.UNIT, ('inactive', 7)), (self.mod.GUARD_UNIT, ('activating', 9)),
                      (self.mod.GUARD_UNIT, ('unknown', -1))):
            good = dict(self.states); self.states[u] = st; p = self.path('obs.json')
            self.refused(B.cmd_observe, p, text='must be stopped'); self.assertFalse(os.path.exists(p)); self.states = good

    def test_refuses_open_image(self):
        with open(self.m1['disks']['base']['path'], 'rb'):
            self.refused(B.cmd_observe, self.path('obs.json'), text='is open by')

    def test_refuses_launcher_drift(self):
        drift = f'{self.T}/provision_vm.py'; open(drift, 'wb').write(open(LAUNCHER, 'rb').read() + b'\n# drift\n')
        self.env['launcher'] = drift
        self.refused(B.cmd_observe, self.path('obs.json'), text='launcher')
        self.pins['launcher'] = sha(open(drift, 'rb').read())                       # pinned, but not what the manifest pins
        self.refused(B.cmd_observe, self.path('obs.json'), text='does not pin')

    def test_refuses_bad_receipts(self):
        for which, k, v in (('rest', 'database_image', '/mnt/usb/enclave-rpc-production/other.qcow2'), ('rest', 'mount_uuid', '489ED12D9ED11472'),
                            ('rest', 'complete', False), ('rest', 'database_bytes', None), ('clean', 'restored_usb_files_retained', False),
                            ('clean', 'completed_at', '2026-10-27T00:00:00+00:00'), ('clean', 'complete', 'yes')):
            rec = self.rest if which == 'rest' else self.clean; good = copy.deepcopy(rec); rec[k] = v; self.write_receipts()
            self.refused(B.cmd_observe, self.path('obs.json')); rec.clear(); rec.update(good); self.write_receipts()
        self.pins['restoration'] = '0' * 64
        self.refused(B.cmd_observe, self.path('obs.json'), text='restoration receipt')

    def test_refuses_wrong_base_image(self):
        base = self.m1['disks']['base']['path']
        os.link(base, base + '.extra'); self.refused(B.cmd_observe, self.path('obs.json'), text='single-link'); os.unlink(base + '.extra')
        os.chmod(base, 0o666); self.refused(B.cmd_observe, self.path('obs.json')); os.chmod(base, 0o644)
        qcow2(base, 3_100_000_000_000); self.refused(B.cmd_observe, self.path('obs.json'), text='virtual size')
        os.unlink(base); os.symlink(self.m1['disks']['os']['path'], base); self.refused(B.cmd_observe, self.path('obs.json'))
        os.unlink(base)
        with self.assertRaises(FileNotFoundError):
            B.cmd_observe(self.env, self.path('obs.json'))
        qcow2(base, self.m1['disks']['base']['bytes']); B.cmd_observe(self.env, self.path('obs.json'))
        osd = self.m1['disks']['os']['path']; qcow2(osd + '.new', 1)  # allocate while old inode exists
        os.rename(osd + '.new', osd)
        self.refused(B.cmd_observe, self.path('obs.json'), text='disk os')

    def test_refuses_identity_change_between_observe_and_stage(self):
        obs = self.observe(); base = self.m1['disks']['base']['path']; st = os.stat(base)
        os.utime(base, ns=(st.st_atime_ns, st.st_mtime_ns + 10 ** 9))
        self.refused(B.cmd_stage, obs, self.path('stage'), text='identity changed')
        obs = self.observe(); self.desc['leafDisks'] = [{'model': 'TR-004 DISK01', 'name': 'sdc', 'rotational': True}]
        self.refused(B.cmd_stage, obs, self.path('stage'), text='identity changed')
        self.desc['leafDisks'] = [{'model': 'TR-004 DISK00', 'name': 'sdb', 'rotational': True}]
        obs = self.observe(); self.clean['note'] = 'reissued'; self.write_receipts()
        self.refused(B.cmd_stage, obs, self.path('stage'), text='outdated observation')

    def test_refuses_outdated_or_tampered_stage(self):
        out = self.path('stage'); B.cmd_stage(self.env, self.observe(), out)
        self.assertTrue(B.cmd_check_stage(self.env, out)['current'])
        with self.assertRaises(B.Refuse):
            B.cmd_stage(self.env, self.observe(), out)                               # never reuses a stage dir
        unit = f'{out}/{self.mod.UNIT}'; good = open(unit).read()
        open(unit, 'w').write(good + '\n'); self.refused(B.cmd_check_stage, out, text='SHA256SUMS'); open(unit, 'w').write(good)
        open(f'{out}/extra', 'w').close(); self.refused(B.cmd_check_stage, out); os.unlink(f'{out}/extra')
        self.states[self.mod.GUARD_UNIT] = ('active', 5); self.refused(B.cmd_check_stage, out, text='must be stopped')
        self.states[self.mod.GUARD_UNIT] = ('inactive', 0)
        base = self.m1['disks']['base']['path']; st = os.stat(base)
        os.utime(base, ns=(st.st_atime_ns, st.st_mtime_ns + 10 ** 9)); self.refused(B.cmd_check_stage, out, text='identity changed')
        shutil.copyfile(f'{out}/manifest.json', self.env['manifest'])               # live manifest replaced (e.g. installed)
        self.refused(B.cmd_check_stage, out, text='manifest')

    def test_refuses_already_rebound_manifest(self):
        m = copy.deepcopy(self.m1); m['backings']['hdd'].update(fsUuid='702FE78A62B4C5DC', source='/dev/sda1'); self.write_manifest(m)
        self.refused(B.cmd_observe, self.path('obs.json'), text='pre-restore binding')

    def test_cli_exit_codes(self):
        args = ['--manifest-sha', self.pins['manifest'], '--restoration-sha', self.pins['restoration'], '--cleanup-sha', self.pins['cleanup']]
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            self.assertEqual(B.main(['observe', '--out', self.path('obs.json')] + args, env=self.env), 0)
            self.states[self.mod.UNIT] = ('active', 1)
            self.assertEqual(B.main(['observe', '--out', self.path('obs.json')] + args, env=self.env), 2)
        self.assertIn('REFUSED', err.getvalue())


if __name__ == '__main__':
    unittest.main()
