"""rpc-memory-recovery-stage/r1 offline tests (python3 -I -m unittest -v test_rpc_memory_r1). The LIVE launcher, manifest and
units are only READ (copied into temp dirs); nothing touches systemd (systemctl is a stub), QMP, the VM, the OS disk or HOME."""
import hashlib, importlib.util, json, os, shutil, struct, sys, tempfile, unittest, uuid
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_STATE, LIVE_UNITS = '/home/steven/.local/state/enclave-rpc-production', '/home/steven/.config/systemd/user'
GIB = 1 << 30


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


R = load('resize_r1', os.path.join(HERE, 'resize_vm_memory.py'))
I = load('inspect_r1', os.path.join(HERE, 'inspect_os_disk.py'))
sha = lambda b: hashlib.sha256(b).hexdigest()


class Systemctl:
    def __init__(self, vm='inactive', guard='inactive'):
        self.state, self.calls = {R.UNIT: vm, R.GUARD: guard}, []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        assert argv[:3] == ['systemctl', '--user', 'show'], argv          # the only systemctl use permitted
        st = self.state.get(argv[-1], 'inactive')
        out = st + '\n' if '--value' in argv else f'ActiveState={st}\nSubState={"dead" if st == "inactive" else "running"}\n'
        return type('R', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); s, u = os.path.join(self.t.name, 'state'), os.path.join(self.t.name, 'units')
        os.makedirs(s); os.makedirs(u)
        for src, dst, mode in ((f'{LIVE_STATE}/provision_vm.py', f'{s}/provision_vm.py', 0o500), (f'{LIVE_STATE}/manifest.json', f'{s}/manifest.json', 0o600),
                               (f'{LIVE_UNITS}/{R.UNIT}', f'{u}/{R.UNIT}', 0o644), (f'{LIVE_UNITS}/{R.GUARD}', f'{u}/{R.GUARD}', 0o644)):
            shutil.copyfile(src, dst); os.chmod(dst, mode)
        self.mem = os.path.join(self.t.name, 'meminfo'); self.setmem(81 * GIB)
        self.env = {'stateDir': s, 'unitDir': u, 'meminfo': self.mem}
        self.orig = {k: open(p, 'rb').read() for k, p in R.files_of(self.env).items()}

    def tearDown(self):
        for root, dirs, files in os.walk(self.t.name):
            for n in dirs + files:
                os.chmod(os.path.join(root, n), 0o700)
        self.t.cleanup()

    def setmem(self, b):
        open(self.mem, 'w').write(f'MemTotal: 130874596 kB\nMemAvailable: {b // 1024} kB\n')

    def stage(self, gib=48):
        out = os.path.join(self.t.name, f'staged-{gib}'); R.cmd_stage(self.env, gib, out); return out

    def live(self):
        return {k: open(p, 'rb').read() for k, p in R.files_of(self.env).items()}


class Build(Base):
    def test_only_the_reviewed_fields_change_for_each_size(self):
        old = load('pv_old', R.files_of(self.env)['launcher']); om = json.loads(self.orig['manifest'])
        for gib in (48, 32, 16):
            files, plan = R.build(self.orig, gib)
            new_m = json.loads(files['manifest'])
            self.assertEqual((new_m['vm']['guestMemBytes'], new_m['vm']['memoryMaxBytes'], new_m['vm']['hostReserveBytes']), (gib * GIB, (gib + 2) * GIB, 16 * GIB))
            for k in ('disks', 'backings', 'paths', 'ports', 'mac', 'instanceId', 'name', 'uid', 'sshPublicKey', 'sshKeyFingerprint', 'baseImage', 'migration', 'format', 'nvme', 'createdAt', 'hostAtPrepare'):
                self.assertEqual(new_m.get(k), om.get(k), k)
            self.assertEqual({k: v for k, v in new_m['files'].items() if k not in ('launcher', 'qemuArgv')}, {k: v for k, v in om['files'].items() if k not in ('launcher', 'qemuArgv')})
            self.assertEqual(new_m['files']['launcher'], sha(files['launcher']))
            new = load(f'pv_new{gib}', self.write(files['launcher']))
            self.assertEqual(new_m['files']['qemuArgv'], new.sha256_text(new.canonical(new.qemu_argv(new_m))))
            msha = new.sha256_text(files['manifest'].decode())
            self.assertIn(f'manifest.json {msha}\n', files['unit'].decode()); self.assertIn(f'manifest.json {msha}\n', files['guard'].decode())
            self.assertIn(f'MemoryMax={(gib + 2) * GIB}\n', files['unit'].decode()); self.assertIn('MemoryMax=256M\n', files['guard'].decode())
            a, b = old.qemu_argv(om), new.qemu_argv(new_m)
            self.assertEqual([(x, y) for x, y in zip(a, b) if x != y],
                             [(f'memory-backend-ram,id=rpcmem,size={64 * GIB},prealloc=on', f'memory-backend-ram,id=rpcmem,size={gib * GIB},prealloc=on'), ('65536M', f'{gib * 1024}M')])
            for must in ('MemorySwapMax=0', 'NoNewPrivileges=yes', 'UMask=0077', 'KillMode=mixed', 'Restart=on-failure', f'BindsTo={R.GUARD}'):
                self.assertIn(must, files['unit'].decode())

    def write(self, b):
        p = os.path.join(self.t.name, f'l{len(os.listdir(self.t.name))}.py'); open(p, 'wb').write(b); return p

    def test_unreviewed_sizes_and_changed_originals_refuse(self):
        for gib in (64, 24, 0, 8):
            with self.assertRaises(R.Refuse):
                R.build(self.orig, gib)
        f = R.files_of(self.env)
        for k, mut in (('launcher', b'\n# x\n'), ('manifest', b' '), ('unit', b'\n'), ('guard', b'\n')):
            self.tearDown(); self.setUp(); f = R.files_of(self.env)
            os.chmod(f[k], 0o600); open(f[k], 'ab').write(mut)
            with self.assertRaises(R.Refuse, msg=k):
                R.check_original(self.env)


class Install(Base):
    def test_install_48_backs_up_exact_originals_and_reverifies_then_rollback_restores(self):
        st = self.stage(48); sc = Systemctl()
        r = R.cmd_install(self.env, st, None, sc)
        live = self.live(); plan = json.load(open(os.path.join(st, 'PLAN.json')))
        self.assertEqual({k: sha(v) for k, v in live.items()}, plan['new'])
        for k, p in R.files_of(self.env).items():
            self.assertEqual(os.stat(p).st_mode & 0o777, R.MODES[k])
        b = r['backup']
        self.assertEqual({k: open(os.path.join(b, k), 'rb').read() for k in live}, self.orig)
        self.assertTrue(all(c[:3] == ['systemctl', '--user', 'show'] for c in sc.calls))
        with self.assertRaises(R.Refuse):                                     # the originals are no longer live: no second install
            R.cmd_install(self.env, st, None, sc)
        R.cmd_rollback(self.env, b, sc)
        self.assertEqual(self.live(), self.orig); R.check_original(self.env)
        self.assertTrue(all(c[:3] == ['systemctl', '--user', 'show'] for c in sc.calls))

    def test_install_refusals_write_nothing(self):
        st = self.stage(48)
        for sc in (Systemctl(vm='active'), Systemctl(vm='activating'), Systemctl(guard='active'), Systemctl(vm='deactivating')):
            with self.assertRaises(R.Refuse):
                R.cmd_install(self.env, st, None, sc)
            self.assertEqual(self.live(), self.orig)
        need = (48 + 2) * GIB + 16 * GIB
        self.setmem(need - 1024)
        with self.assertRaises(R.Refuse):
            R.cmd_install(self.env, st, None, Systemctl())
        self.assertEqual(self.live(), self.orig)
        self.setmem(81 * GIB); os.chmod(os.path.join(st, 'manifest'), 0o600); open(os.path.join(st, 'manifest'), 'ab').write(b' ')
        with self.assertRaises(R.Refuse):
            R.cmd_install(self.env, st, None, Systemctl())
        self.assertEqual(self.live(), self.orig)

    def test_failure_mid_install_restores_every_original(self):
        st = self.stage(32)
        for n in (1, 2, 3):
            self.tearDown(); self.setUp(); st = self.stage(32)
            with self.assertRaises(R.Refuse):
                R.cmd_install(self.env, st, None, Systemctl(), fail_after=n)
            self.assertEqual(self.live(), self.orig, n)

    def test_16_gib_is_download_only_and_needs_fresh_l1_off_evidence(self):
        st = self.stage(16)
        with self.assertRaises(R.Refuse):
            R.cmd_install(self.env, st, None, Systemctl())
        osd = json.loads(self.orig['manifest'])['disks']['os']['path']; s = os.stat(osd)
        ev = {'format': 'enclave-rpc-os-disk-inspection/r1', 'osDisk': osd, 'osDiskIno': s.st_ino, 'osDiskMtimeNs': s.st_mtime_ns,
              'osDiskSha256Prefix': '00' * 32, 'enabled': {u: False for u in R.L1_UNITS}}
        p = os.path.join(self.t.name, 'ev.json')
        for bad in ({'enabled': {**ev['enabled'], 'enclave-l1-cl.service': True}}, {'enabled': {'enclave-l1-el.path': False}},
                    {'osDiskMtimeNs': s.st_mtime_ns - 1}, {'format': 'x'}):
            json.dump({**ev, **bad}, open(p, 'w'))
            with self.assertRaises(R.Refuse, msg=bad):
                R.cmd_install(self.env, st, p, Systemctl())
            self.assertEqual(self.live(), self.orig)
        json.dump(ev, open(p, 'w'))
        r = R.cmd_install(self.env, st, p, Systemctl())
        self.assertEqual(r['gib'], 16)

    def test_rollback_refusals(self):
        st = self.stage(48); r = R.cmd_install(self.env, st, None, Systemctl())
        with self.assertRaises(R.Refuse):
            R.cmd_rollback(self.env, r['backup'], Systemctl(vm='active'))
        os.chmod(os.path.join(r['backup'], 'unit'), 0o600); open(os.path.join(r['backup'], 'unit'), 'ab').write(b'\n')
        with self.assertRaises(R.Refuse):
            R.cmd_rollback(self.env, r['backup'], Systemctl())
        self.assertNotEqual(self.live(), self.orig)                           # nothing restored from a tampered backup


class Launcher(Base):
    def test_installed_launcher_refuses_below_its_floor_and_a_stale_cgroup_cap(self):
        st = self.stage(48); R.cmd_install(self.env, st, None, Systemctl())
        f = R.files_of(self.env); pv = load('pv_inst', f['launcher'])
        need = pv.MEMORY_MAX + pv.HOST_RESERVE
        self.assertEqual((pv.GUEST_MEM, pv.MEMORY_MAX, need), (48 * GIB, 50 * GIB, 66 * GIB))
        pv.mem_available = lambda: need - 1
        with self.assertRaises(pv.Refuse):
            pv.check_memory()
        pv.mem_available = lambda: need
        self.assertEqual(pv.check_memory(), need)
        m = json.load(open(f['manifest'])); msha = sha(open(f['manifest'], 'rb').read())
        os.environ['RUNTIME_DIRECTORY'] = m['paths']['runtimeDir']
        try:
            pv.own_cgroup_limits = lambda: (str(66 * GIB), '0')              # the OLD unit cap: no uncapped/mis-capped VM starts
            with self.assertRaisesRegex(pv.Refuse, 'cgroup'):
                pv.cmd_launch(f['manifest'], msha)
            pv.own_cgroup_limits = lambda: (str(pv.MEMORY_MAX), 'max')       # swap must stay 0
            with self.assertRaisesRegex(pv.Refuse, 'cgroup'):
                pv.cmd_launch(f['manifest'], msha)
        finally:
            del os.environ['RUNTIME_DIRECTORY']
        self.assertIn(f'MemoryMax={pv.MEMORY_MAX}\nMemorySwapMax=0\n', open(f['unit']).read())


class Inspect(unittest.TestCase):
    def disk(self, roots=1):
        b = bytearray(4 * 1024 * 1024)
        b[512:520] = b'EFI PART'; struct.pack_into('<QII', b, 512 + 72, 2, 128, 128)
        for i in range(roots + 1):
            e = 1024 + i * 128
            b[e:e + 16] = I.LINUX_FS.bytes_le; first = 2048 + i * 2048
            struct.pack_into('<QQ', b, e + 32, first, first + 2000)
            sb = first * 512 + 1024
            struct.pack_into('<H', b, sb + 0x38, 0xEF53)
            lab = b'cloudimg-rootfs' if i < roots else b'BOOT'
            b[sb + 0x78:sb + 0x78 + len(lab)] = lab
        p = tempfile.NamedTemporaryFile(delete=False); p.write(bytes(b)); p.close(); return p.name

    def test_gpt_root_partition(self):
        p = self.disk(1)
        try:
            off, part = I.root_offset(p); self.assertEqual(off, 2048 * 512); self.assertEqual(part['index'], 1)
        finally:
            os.unlink(p)
        for n in (0, 2):
            p = self.disk(n)
            try:
                with self.assertRaises(I.Refuse):
                    I.root_offset(p)
            finally:
                os.unlink(p)

    def fake(self, unit, dropins=b'', wants=(('multi-user.target.wants', ['enclave-l1-el.path', 'enclave-l1-cl.service', 'enclave-rpc-base-snapshot.service']),)):
        top = b''.join(f'/2/40755/0/0/{w}//\n'.encode() for w, _ in wants)
        dirs = {w: b''.join(f'/3/120777/0/0/{n}//\n'.encode() for n in ns) + b'/4/100644/0/0/enclave-base-holder.path/10/\n' for w, ns in wants}
        def run(argv, **kw):
            req = argv[3]
            out = (unit if req.endswith(I.SNAPSHOT_UNIT) and req.startswith('cat') else dropins if req.endswith('.service.d') else
                   top if req == f'ls -p {I.UNIT_DIR}' else b'UUID=x /srv/enclave-base-holder ext4 defaults 0 2\n' if req == 'cat /etc/fstab' else
                   dirs.get(req.split('/')[-1], b'') if req.startswith('ls -p') else b'Fast link dest: "/etc/systemd/system/x"\n')
            return type('R', (), {'returncode': 0, 'stdout': out, 'stderr': b''})()
        return run

    def test_unit_identity_dropins_and_enabled_links(self):
        payload = open(I.DEFAULT_PAYLOAD, 'rb').read()
        r = I.inspect('x?offset=0', I.DEFAULT_PAYLOAD, self.fake(payload))
        self.assertTrue(r['bootSnapshotSafe']); self.assertTrue(r['snapshotUnit']['identicalToPayload'])
        self.assertEqual({u: r['enabled'][u] for u in ('enclave-l1-el.path', 'enclave-l1-cl.service', 'enclave-base-holder.path', 'enclave-l1-el.service')},
                         {'enclave-l1-el.path': True, 'enclave-l1-cl.service': True, 'enclave-base-holder.path': False, 'enclave-l1-el.service': False})
        self.assertIn('ConditionPathExists=!/srv/enclave-base-holder/snapshot-complete', r['snapshotUnit']['guards'])
        self.assertFalse(I.inspect('x?offset=0', I.DEFAULT_PAYLOAD, self.fake(payload, dropins=b'/9/100644/0/0/override.conf/20/\n'))['bootSnapshotSafe'])
        self.assertFalse(I.inspect('x?offset=0', I.DEFAULT_PAYLOAD, self.fake(payload.replace(b'ConditionPathIsMountPoint', b'#Condition')))['bootSnapshotSafe'])
        self.assertFalse(I.inspect('x?offset=0', I.DEFAULT_PAYLOAD, self.fake(b''))['snapshotUnit']['present'])

    def test_refuses_while_the_vm_or_guard_is_active(self):
        for st in ({R.UNIT: 'active'}, {R.GUARD: 'activating'}):
            sc = Systemctl(); sc.state.update(st)
            self.assertEqual(I.main([], run=sc), 2)
            self.assertTrue(all(c[:3] == ['systemctl', '--user', 'show'] for c in sc.calls))


if __name__ == '__main__':
    unittest.main()
