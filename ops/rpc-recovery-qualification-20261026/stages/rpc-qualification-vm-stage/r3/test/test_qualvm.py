"""rpc-qualification-vm-stage/r3 offline tests (python3 -I -m unittest discover -s <abs test dir> -t <same> -v). SOURCE FIXTURES:
systemctl/systemd-run/ssh/QMP are stubs; the pinned production launcher/manifest/units are only READ. No QEMU, no unit is started."""
import json, os, sys, tempfile, unittest, importlib.util
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qualvm', os.path.join(os.path.dirname(HERE), 'qualvm.py')); Q = importlib.util.module_from_spec(spec); spec.loader.exec_module(Q)
GIB, MIB = 1 << 30, 1 << 20
UUID = '0a1b2c3d-1111-2222-3333-444455556666'
GRUB = f"""if [ "${{next_entry}}" ] ; then
   set default="${{next_entry}}"
else
   set default="0"
fi
menuentry 'Ubuntu' --class ubuntu $menuentry_id_option 'gnulinux-simple' {{
\trecordfail
\tinsmod ext2
\tsearch --no-floppy --fs-uuid --set=root {UUID}
\tlinux\t/vmlinuz-6.8.0-1-generic root=LABEL=cloudimg-rootfs ro console=tty1 console=ttyS0 $vt_handoff
\tinitrd\t/initrd.img-6.8.0-1-generic
}}
submenu 'Advanced' {{
\tmenuentry 'x' {{ linux /vmlinuz-6.8.0-1-generic root=LABEL=cloudimg-rootfs }}
}}
"""


class Sys:
    """stub of systemctl/systemd-run/ssh: records every call; unit properties from a dict (per call sequence if a list)"""
    def __init__(self, units=None, ssh_out='', ssh_rc=0):
        self.units, self.calls, self.ssh_out, self.ssh_rc = units or {}, [], ssh_out, ssh_rc

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        R = lambda rc=0, out='', err='': type('R', (), {'returncode': rc, 'stdout': out, 'stderr': err})()
        if argv[0] == 'systemctl' and argv[2] == 'show':
            p = self.units.get(argv[-1], {'LoadState': 'not-found', 'ActiveState': 'inactive'})
            p = p.pop(0) if isinstance(p, list) and len(p) > 1 else (p[0] if isinstance(p, list) else p)
            return R(out=''.join(f'{k}={v}\n' for k, v in p.items()))
        if argv[0] == 'ssh':
            return R(self.ssh_rc, self.ssh_out)
        return R()

    def started(self):
        return [c for c in self.calls if c[0] == 'systemd-run']


PROD_OK = {u: {'LoadState': 'loaded', 'ActiveState': 'inactive'} for u in Q.PROD_UNIT_NAMES}


class Grub(unittest.TestCase):
    def test_accepted_fixture_binds_search_uuid_and_version(self):
        g = Q.parse_grub(GRUB, 'next_entry=\n')
        self.assertEqual((g['kernel'], g['initrd'], g['searchUuid'], g['kernelVersion']),
                         ('/vmlinuz-6.8.0-1-generic', '/initrd.img-6.8.0-1-generic', UUID, '6.8.0-1-generic'))

    def test_adversarial_refused(self):
        S = f'\tsearch --no-floppy --fs-uuid --set=root {UUID}'
        bad = {'indented entry before': '  menuentry "hidden" { linux /a root=x }\n' + GRUB,
               'no search': GRUB.replace(S + '\n', ''), 'two search': GRUB.replace(S, S + '\n' + S),
               'search without --set=root': GRUB.replace('--set=root ', ''), 'search variable': GRUB.replace(UUID, '$uuid'),
               'kernel without version': GRUB.replace('/vmlinuz-6.8.0-1-generic root', '/vmlinuz root'),
               'two initrd files': GRUB.replace('\tinitrd\t/initrd.img-6.8.0-1-generic', '\tinitrd\t/ucode.img /initrd.img-6.8.0-1-generic'),
               'default 1': GRUB.replace('set default="0"', 'set default="1"'), 'arg variable': GRUB.replace('$vt_handoff', '$x')}
        for k, v in bad.items():
            with self.assertRaises(Q.Refuse, msg=k):
                Q.parse_grub(v, '')

    def test_root_binding_regular_files_and_bzimage(self):
        parts = [{'label': 'cloudimg-rootfs', 'fsUuid': UUID, 'partUuid': 'aa-1'}, {'label': 'BOOT', 'fsUuid': 'b', 'partUuid': 'bb-2'}]
        for a, ok in (('root=LABEL=cloudimg-rootfs', True), (f'root=UUID={UUID.upper()}', True), ('root=PARTUUID=bb-2', True),
                      ('root=/dev/sda1', False), ('root=LABEL=missing', False)):
            self.assertEqual(Q.root_matches(a, parts), ok, a)
        self.assertFalse(Q.root_matches('root=LABEL=cloudimg-rootfs', parts + [{'label': 'cloudimg-rootfs'}]))   # ambiguous
        self.assertTrue(Q.is_regular('Inode: 12   Type: regular    Mode:  0644'))
        self.assertFalse(Q.is_regular('Inode: 13   Type: symlink    Mode:  0777\nFast link dest: "vmlinuz-6.8"'))
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b'\0' * 0x202 + b'XXXX')
        with self.assertRaises(Q.Refuse):
            Q.check_kernel(f.name)
        open(f.name, 'wb').write(b'\0' * 0x202 + b'HdrS'); Q.check_kernel(f.name); os.unlink(f.name)


class Floor(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.out = self.t.name
        open(os.path.join(self.out, 'os-qual.qcow2'), 'wb').write(b'x' * 4096)
        self.mem = os.path.join(self.out, 'meminfo'); self.setmem(30 * GIB)
        self.pid, self.tok = os.getpid(), Q.start_token(os.getpid())

    def tearDown(self):
        self.t.cleanup()

    def setmem(self, b):
        open(self.mem, 'w').write(f'MemTotal: 130000000 kB\nMemAvailable: {b // 1024} kB\n')

    def test_each_trip_condition(self):
        self.assertEqual(Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem), [])
        self.setmem(Q.STOP_BELOW - 1024); self.assertTrue(Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem))
        self.setmem(Q.STOP_BELOW); self.assertEqual(Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem), [])
        open(self.mem, 'w').write('garbage\n'); self.assertIn('MemAvailable unreadable', Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem))
        self.assertIn('MemAvailable unreadable', Q.floor_reasons(self.out, self.pid, self.tok, 1, '/nonexistent/meminfo'))
        self.setmem(30 * GIB)
        self.assertTrue(any('controller' in w for w in Q.floor_reasons(self.out, self.pid, 'wrong-token', 1, self.mem)))
        self.assertTrue(any('controller' in w for w in Q.floor_reasons(self.out, 2 ** 22 + 7, self.tok, 1, self.mem)))
        self.assertTrue(any('NVMe avail' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 10 ** 18, self.mem)))
        old = Q.OVERLAY_MAX; Q.OVERLAY_MAX = 1
        try:
            self.assertTrue(any('overlay allocated' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)))
        finally:
            Q.OVERLAY_MAX = old
        os.unlink(os.path.join(self.out, 'os-qual.qcow2'))
        self.assertTrue(any('unreadable' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)))

    def test_floor_loop_exits_4_and_records_the_trip(self):
        old = Q.nvme_policy; Q.nvme_policy = lambda m, out: {'tripAvailBytes': 1, 'admitAvailBytes': 1}
        try:
            self.assertEqual(Q.cmd_floor(self.out, self.pid, self.tok, max_loops=3, meminfo=self.mem, sleep=lambda s: None), 0)
            self.setmem(17 * GIB)
            self.assertEqual(Q.cmd_floor(self.out, self.pid, self.tok, max_loops=3, meminfo=self.mem, sleep=lambda s: None), 4)
            self.assertTrue(json.load(open(os.path.join(self.out, 'floor-trip.json')))['reasons'])
        finally:
            Q.nvme_policy = old


class Controller(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.out = self.t.name
        self.osd = os.path.join(self.out, 'os.qcow2'); open(self.osd, 'wb').write(b'os')
        self.ovl = os.path.join(self.out, 'os-qual.qcow2'); open(self.ovl, 'wb').write(b'ov')
        prep = {'osDisk': self.osd, 'overlay': self.ovl}
        self.saved = {k: getattr(Q, k) for k in ('cgroup_max', 'checked', 'nvme_policy', 'avail_bytes', 'mem_available', 'qual_argv', 'qmp')}
        Q.cgroup_max = lambda: str(Q.LANE); Q.checked = lambda out: (None, {}, prep)
        Q.nvme_policy = lambda m, out: {'tripAvailBytes': 1, 'admitAvailBytes': 1}; Q.avail_bytes = lambda p: 10 ** 12
        Q.mem_available = lambda path='/proc/meminfo': 40 * GIB; Q.qual_argv = lambda pv, m, prep: ['/usr/bin/qemu-system-x86_64']
        Q.qmp = lambda c: (_ for _ in ()).throw(OSError('no socket in tests'))
        Q.STOP['flag'] = False

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(Q, k, v)
        Q.STOP['flag'] = False; self.t.cleanup()

    def test_admission_refusals_start_nothing(self):
        self.assertEqual(Q.ADMIT, 16 * GIB + 10 * GIB + 512 * MIB + 256 * MIB + 1 * GIB)
        cases = [('lane', lambda: setattr(Q, 'cgroup_max', lambda: str(4096 * MIB)), PROD_OK),
                 ('prod not loaded', None, {**PROD_OK, Q.PROD_UNIT_NAMES[0]: {'LoadState': 'not-found', 'ActiveState': 'inactive'}}),
                 ('prod active', None, {**PROD_OK, Q.PROD_UNIT_NAMES[1]: {'LoadState': 'loaded', 'ActiveState': 'activating'}}),
                 ('qual vm exists', None, {**PROD_OK, Q.VM_UNIT: {'LoadState': 'loaded', 'ActiveState': 'active'}}),
                 ('memory', lambda: setattr(Q, 'mem_available', lambda path='/proc/meminfo': Q.ADMIT - 1), PROD_OK),
                 ('memory unreadable', lambda: setattr(Q, 'mem_available', lambda path='/proc/meminfo': None), PROD_OK),
                 ('nvme', lambda: setattr(Q, 'avail_bytes', lambda p: 0), PROD_OK)]
        for name, mut, units in cases:
            self.tearDown(); self.setUp()
            if mut:
                mut()
            s = Sys(dict(units))
            with self.assertRaises(Q.Refuse, msg=name):
                Q.cmd_controller(self.out, s, sleep=lambda x: None)
            self.assertEqual(s.started(), [], name)

    def test_lifecycle_floor_first_vm_bound_own_invocations_only(self):
        units = {**PROD_OK, Q.FLOOR_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}, {'InvocationID': 'F1', 'ActiveState': 'active'},
                                           {'InvocationID': 'F1', 'ActiveState': 'active', 'LoadState': 'loaded'}],
                 Q.VM_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}, {'InvocationID': 'V1', 'ActiveState': 'active'},
                             {'InvocationID': 'V1', 'ActiveState': 'active'}, {'InvocationID': 'V1', 'ActiveState': 'inactive', 'LoadState': 'not-found'}]}
        s = Sys(units)
        r = Q.cmd_controller(self.out, s, sleep=lambda x: None)
        st = s.started()
        self.assertEqual(len(st), 2); self.assertIn(f'--unit={Q.FLOOR_UNIT}', st[0]); self.assertIn(f'--unit={Q.VM_UNIT}', st[1])
        for p in (f'-pBindsTo={Q.FLOOR_UNIT}', f'-pAfter={Q.FLOOR_UNIT}', f'-pMemoryMax={Q.VM_MAX}', '-pMemorySwapMax=0', '-pRestart=no'):
            self.assertIn(p, st[1])
        for p in (f'-pMemoryMax={Q.FLOOR_UNIT_MAX}', '-pRestart=no'):
            self.assertIn(p, st[0])
        self.assertIn('--controller-token', st[0])
        rec = r['controller']; self.assertEqual((rec['vmInvocation'], rec['floorInvocation'], rec['end']), ('V1', 'F1', 'vm-exited'))
        self.assertEqual(rec['floorStop'], 'stopped'); self.assertTrue(rec['productionUnchanged'])

    def test_stop_request_acpi_then_bounded_force_never_foreign(self):
        Q.ACPI_GRACE_S_saved = Q.ACPI_GRACE_S; Q.ACPI_GRACE_S = 0
        try:
            active = {'InvocationID': 'V1', 'ActiveState': 'active', 'LoadState': 'loaded'}
            units = {**PROD_OK, Q.FLOOR_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}] + [{'InvocationID': 'F1', 'ActiveState': 'active', 'LoadState': 'loaded'}] * 9,
                     Q.VM_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}] + [active] * 9}
            Q.STOP['flag'] = True; s = Sys(units)
            rec = Q.cmd_controller(self.out, s, sleep=lambda x: None)['controller']
            self.assertEqual(rec['end'], 'stop-requested'); self.assertEqual(rec['vmStop'], 'stopped')
            self.assertIn(['systemctl', '--user', 'stop', Q.VM_UNIT], s.calls)
            s2 = Sys({Q.VM_UNIT: {'InvocationID': 'FOREIGN', 'ActiveState': 'active', 'LoadState': 'loaded'}})
            self.assertTrue(Q.own_stop(Q.VM_UNIT, 'V1', s2).startswith('NOT stopped'))
            self.assertNotIn(['systemctl', '--user', 'stop', Q.VM_UNIT], s2.calls)
        finally:
            Q.ACPI_GRACE_S = Q.ACPI_GRACE_S_saved


class Prove(unittest.TestCase):
    def setUp(self):
        self.pv, self.m = Q.production()
        self.prep = {'cmdlineFromGrub': ['root=LABEL=cloudimg-rootfs', 'ro', 'console=ttyS0'], 'kernelVersion': '6.8.0-1-generic'}
        mounts = [Q.mount_unit(self.m['disks'][k]['mount']) for k in ('l1', 'base')]
        self.good = {'cmdline': ' '.join(Q.expected_cmdline(self.m, self.prep)) + '\n', 'uname': '6.8.0-1-generic\n', 'memtotal_kb': str(8 * GIB // 1024 - 200000),
                     'unitfiles': ''.join(f'{u} masked-runtime enabled\n' for u in Q.MASKS + tuple(mounts)),
                     'units': ''.join(f'{u} masked inactive dead x\n' for u in Q.MASKS),
                     'findmnt': {self.m['disks']['l1']['mount']: '', self.m['disks']['base']['mount']: ''},
                     'lsblk': ''.join(f'sd{c} {self.m["disks"][k]["serial"]} {ro}\n' for c, k, ro in (('a', 'os', '0'), ('b', 'l1', '1'), ('c', 'base', '1')))}

    def test_good_sections_pass_and_each_defect_fails(self):
        self.assertEqual(Q.guest_checks(self.m, self.prep, self.good), [])
        d = lambda **kw: {**self.good, **kw}
        bad = {'cmdline extra token': d(cmdline=self.good['cmdline'].strip() + ' quiet'), 'cmdline missing mask': d(cmdline='root=LABEL=cloudimg-rootfs ro console=ttyS0'),
               'uname': d(uname='6.8.0-2-generic'), 'memtotal': d(memtotal_kb=str(16 * GIB // 1024)),
               'unit not masked': d(unitfiles=self.good['unitfiles'] + 'enclave-new.timer enabled enabled\n'),
               'unit active': d(units=self.good['units'] + 'enclave-new.service loaded active running x\n'),
               'mask missing from inventory': d(unitfiles=''.join(l + '\n' for l in self.good['unitfiles'].splitlines()[1:])),
               'data mounted': d(findmnt={**self.good['findmnt'], self.m['disks']['base']['mount']: '/srv/enclave-base-holder /dev/sdc ext4 ro'}),
               'data disk writable': d(lsblk=self.good['lsblk'].replace(f'{self.m["disks"]["l1"]["serial"]} 1', f'{self.m["disks"]["l1"]["serial"]} 0')),
               'data disk mounted': d(lsblk=self.good['lsblk'].replace(f'{self.m["disks"]["base"]["serial"]} 1', f'{self.m["disks"]["base"]["serial"]} 1 /mnt')),
               'disk missing': d(lsblk=''.join(self.good['lsblk'].splitlines(True)[:2]))}
        for k, v in bad.items():
            self.assertTrue(Q.guest_checks(self.m, self.prep, v), k)

    def test_query_quotes_mount_units_and_has_8_sections(self):
        q = Q.guest_query([self.m['disks']['l1']['mount'], self.m['disks']['base']['mount']])
        self.assertIn("'srv-enclave\\x2dl1\\x2dpair.mount'", q); self.assertEqual(q.count('echo @@'), 7)

    def test_prove_never_sshes_into_a_guest_that_is_not_ours_and_main_rc_3(self):
        t = tempfile.TemporaryDirectory()
        json.dump({'pid': os.getpid(), 'startToken': Q.start_token(os.getpid()), 'vmInvocation': 'V1', 'floorInvocation': 'F1'}, open(os.path.join(t.name, 'controller.json'), 'w'))
        old = Q.checked; Q.checked = lambda out: (self.pv, self.m, self.prep)
        try:
            s = Sys({**PROD_OK, Q.VM_UNIT: {'ActiveState': 'active', 'InvocationID': 'OTHER', 'BindsTo': Q.FLOOR_UNIT, 'MemoryMax': str(Q.VM_MAX), 'MemorySwapMax': '0'},
                     Q.FLOOR_UNIT: {'ActiveState': 'active', 'InvocationID': 'F1'}})
            r = Q.cmd_prove(t.name, s)
            self.assertFalse(r['ok']); self.assertFalse([c for c in s.calls if c[0] == 'ssh'])
            s = Sys({**PROD_OK, Q.VM_UNIT: {'ActiveState': 'active', 'InvocationID': 'V1', 'BindsTo': '', 'MemoryMax': str(Q.VM_MAX), 'MemorySwapMax': '0'},
                     Q.FLOOR_UNIT: {'ActiveState': 'active', 'InvocationID': 'F1'}})
            self.assertFalse(Q.cmd_prove(t.name, s)['ok'])                     # VM not bound to the floor unit
            self.assertEqual(Q.main(['prove', t.name], run=s), 3)
        finally:
            Q.checked = old; t.cleanup()


class Discard(unittest.TestCase):
    def test_discard_refuses_while_ours_is_alive(self):
        t = tempfile.TemporaryDirectory()
        json.dump({'osDisk': '/nonexistent'}, open(os.path.join(t.name, 'PREPARED.json'), 'w'))
        with self.assertRaises(Q.Refuse):
            Q.cmd_discard(t.name, Sys({Q.FLOOR_UNIT: {'ActiveState': 'active'}}))
        json.dump({'pid': os.getpid(), 'startToken': Q.start_token(os.getpid())}, open(os.path.join(t.name, 'controller.json'), 'w'))
        with self.assertRaises(Q.Refuse):
            Q.cmd_discard(t.name, Sys({}))
        t.cleanup()


class Argv(unittest.TestCase):
    def test_argv_shape_unchanged_from_r2_and_always_restricted(self):
        pv, m = Q.production()
        osd = m['disks']['os']['path']
        prep = {'osDisk': osd, 'overlay': '/tmp/x/os-qual.qcow2', 'cmdlineFromGrub': ['root=LABEL=cloudimg-rootfs', 'ro']}
        a, p = Q.qual_argv(pv, m, prep), pv.qemu_argv(m)
        body, pbody = a[:-6], p[:31] + p[35:]
        self.assertEqual({i for i, (x, y) in enumerate(zip(body, pbody)) if x != y}, {2, 6, 14, 26, 30, 38, 42, 46, 54})
        self.assertIn('restrict=on', body[54].split(',')); self.assertEqual(a[-1], ' '.join(Q.expected_cmdline(m, prep)))


if __name__ == '__main__':
    unittest.main()
