"""rpc-qualification-vm-stage/r5 offline tests (python3 -I -m unittest discover -s <abs test dir> -t <same> -v). SOURCE FIXTURES:
systemctl/systemd-run/ssh/QMP are stubs; the pinned production launcher/manifest/units are only READ. No QEMU, no unit is started."""
import json, os, posixpath, sys, tempfile, unittest, importlib.util
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
    def __init__(self, units=None, ssh_out='', ssh_rc=0, on_start=None):
        self.units, self.calls, self.ssh_out, self.ssh_rc, self.on_start = units or {}, [], ssh_out, ssh_rc, on_start or (lambda argv: None)

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        R = lambda rc=0, out='', err='': type('R', (), {'returncode': rc, 'stdout': out, 'stderr': err})()
        if argv[0] == 'systemctl' and argv[2] == 'show':
            p = self.units.get(argv[-1], {'LoadState': 'not-found', 'ActiveState': 'inactive'})
            p = p.pop(0) if isinstance(p, list) and len(p) > 1 else (p[0] if isinstance(p, list) else p)
            return R(out=''.join(f'{k}={v}\n' for k, v in p.items()))
        if argv[0] == 'ssh':
            return R(self.ssh_rc, self.ssh_out)
        if argv[0] == 'systemd-run':
            self.on_start(argv)
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
            self.assertTrue(any('overlay + console allocated' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)))
        finally:
            Q.OVERLAY_MAX = old
        os.unlink(os.path.join(self.out, 'os-qual.qcow2'))
        self.assertTrue(any('unreadable' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)))

    def test_floor_loop_ready_only_after_a_clean_first_check_and_trip_exits_4(self):
        old = Q.nvme_policy; Q.nvme_policy = lambda m, out: {'tripAvailBytes': 1, 'admitAvailBytes': 1}
        ready = os.path.join(self.out, 'floor-ready.json')
        try:
            os.environ.pop('INVOCATION_ID', None)                                   # not the owned floor unit -> never ready
            self.assertEqual(Q.cmd_floor(self.out, self.pid, self.tok, max_loops=3, meminfo=self.mem, sleep=lambda s: None), 4)
            self.assertFalse(os.path.exists(ready))
            os.environ['INVOCATION_ID'] = 'ab' * 16
            self.assertEqual(Q.cmd_floor(self.out, self.pid, self.tok, max_loops=3, meminfo=self.mem, sleep=lambda s: None), 0)
            r = json.load(open(ready)); self.assertEqual((r['invocation'], r['firstCheck']), ('ab' * 16, []))
            os.unlink(ready); self.setmem(17 * GIB)                                 # the FIRST check trips -> no ready receipt
            self.assertEqual(Q.cmd_floor(self.out, self.pid, self.tok, max_loops=3, meminfo=self.mem, sleep=lambda s: None), 4)
            self.assertFalse(os.path.exists(ready))
            self.assertTrue(json.load(open(os.path.join(self.out, 'floor-trip.json')))['reasons'])
        finally:
            Q.nvme_policy = old; os.environ.pop('INVOCATION_ID', None)

    def test_console_has_its_own_cap_and_counts_with_the_overlay(self):
        con = os.path.join(self.out, 'console.log'); open(con, 'wb').write(os.urandom(8192))
        self.assertEqual(Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem), [])
        old = (Q.CONSOLE_MAX, Q.OVERLAY_MAX)
        try:
            Q.CONSOLE_MAX = 4096
            self.assertTrue(any('console.log allocated' in w for w in Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)))
            Q.CONSOLE_MAX, Q.OVERLAY_MAX = old[0], 10000                            # each alone fits, together they do not
            w = Q.floor_reasons(self.out, self.pid, self.tok, 1, self.mem)
            self.assertTrue(any('overlay + console' in x for x in w), w)
        finally:
            Q.CONSOLE_MAX, Q.OVERLAY_MAX = old


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
        Q.STOP['flag'] = False; self.saved['FLOOR_READY_S'] = Q.FLOOR_READY_S; Q.FLOOR_READY_S = 0.3

    def ready(self, invocation='F1', pid=None):
        """stands in for the floor unit writing its ready receipt when it is started (source fixture)"""
        def on_start(argv):
            if f'--unit={Q.FLOOR_UNIT}' in argv and invocation is not None:
                p = pid or os.getpid()
                json.dump({'invocation': invocation, 'pid': p, 'startToken': Q.start_token(p), 'firstCheck': []}, open(os.path.join(self.out, 'floor-ready.json'), 'w'))
        return on_start

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
        s = Sys(units, on_start=self.ready())
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

    def test_no_vm_unless_the_floor_proves_ready_for_its_own_invocation(self):
        F = lambda: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}] + [{'InvocationID': 'F1', 'ActiveState': 'active', 'LoadState': 'loaded'}] * 20
        stale = os.path.join(self.out, 'floor-ready.json')
        for name, hook in (('never ready', self.ready(None)), ('other invocation', self.ready('F2')), ('dead pid', self.ready('F1', pid=2 ** 22 + 9)),
                           ('stale receipt only', None)):
            json.dump({'invocation': 'F1', 'pid': os.getpid(), 'startToken': Q.start_token(os.getpid())}, open(stale, 'w'))  # a previous run's file
            s = Sys({**PROD_OK, Q.FLOOR_UNIT: F()}, on_start=hook)
            with self.assertRaises(Q.Refuse, msg=name):
                Q.cmd_controller(self.out, s, sleep=lambda x: None)
            st = s.started()
            self.assertEqual(len(st), 1, name); self.assertIn(f'--unit={Q.FLOOR_UNIT}', st[0])          # floor only, never the VM
            self.assertIn(['systemctl', '--user', 'stop', Q.FLOOR_UNIT], s.calls, name)          # and our own floor is stopped

    def test_stop_request_acpi_then_bounded_force_never_foreign(self):
        Q.ACPI_GRACE_S_saved = Q.ACPI_GRACE_S; Q.ACPI_GRACE_S = 0
        try:
            active = {'InvocationID': 'V1', 'ActiveState': 'active', 'LoadState': 'loaded'}
            units = {**PROD_OK, Q.FLOOR_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}] + [{'InvocationID': 'F1', 'ActiveState': 'active', 'LoadState': 'loaded'}] * 9,
                     Q.VM_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}] + [active] * 9}
            Q.STOP['flag'] = True; s = Sys(units, on_start=self.ready())
            rec = Q.cmd_controller(self.out, s, sleep=lambda x: None)['controller']
            self.assertEqual(rec['end'], 'stop-requested'); self.assertEqual(rec['vmStop'], 'stopped')
            self.assertIn(['systemctl', '--user', 'stop', Q.VM_UNIT], s.calls)
            s2 = Sys({Q.VM_UNIT: {'InvocationID': 'FOREIGN', 'ActiveState': 'active', 'LoadState': 'loaded'}})
            self.assertTrue(Q.own_stop(Q.VM_UNIT, 'V1', s2).startswith('NOT stopped'))
            self.assertNotIn(['systemctl', '--user', 'stop', Q.VM_UNIT], s2.calls)
        finally:
            Q.ACPI_GRACE_S = Q.ACPI_GRACE_S_saved

    def test_post_start_floor_recheck_stops_our_vm_when_the_floor_is_not_our_ready_invocation(self):
        for name, after in (('another floor invocation', {'InvocationID': 'F2', 'ActiveState': 'active', 'LoadState': 'loaded'}),
                            ('floor already gone', {'InvocationID': '', 'ActiveState': 'inactive', 'LoadState': 'not-found'})):
            self.tearDown(); self.setUp()
            units = {**PROD_OK,
                     Q.FLOOR_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}, {'InvocationID': 'F1', 'ActiveState': 'active'},
                                    {'InvocationID': 'F1', 'ActiveState': 'active', 'LoadState': 'loaded'}, after],
                     Q.VM_UNIT: [{'LoadState': 'not-found', 'ActiveState': 'inactive'}, {'InvocationID': 'V1', 'ActiveState': 'active'},
                                 {'InvocationID': 'V1', 'ActiveState': 'active', 'LoadState': 'loaded'}]}
            s = Sys(units, on_start=self.ready())
            with self.assertRaises(Q.Refuse, msg=name):
                Q.cmd_controller(self.out, s, sleep=lambda x: None)
            self.assertEqual(len(s.started()), 2, name)                                         # floor, then the VM
            self.assertIn(['systemctl', '--user', 'stop', Q.VM_UNIT], s.calls, name)            # our VM is stopped at once
            self.assertNotIn(['systemctl', '--user', 'stop', Q.FLOOR_UNIT], s.calls, name)      # a floor that is not ours is never stopped
            rec = json.load(open(os.path.join(self.out, 'controller.json')))
            self.assertEqual((rec['vmStop'], rec['postStartFloor']['InvocationID']), ('stopped', after['InvocationID']), name)


class Prove(unittest.TestCase):
    def setUp(self):
        self.pv, self.m = Q.production()
        self.prep = {'cmdlineFromGrub': ['root=LABEL=cloudimg-rootfs', 'ro', 'console=ttyS0'], 'kernelVersion': '6.8.0-1-generic',
                     'unitInventory': {'enclave-base-readiness.timer': ['/etc/systemd/system/timers.target.wants/enclave-base-readiness.timer'],
                                       'enclave-l1-cl.service': ['/etc/systemd/system/enclave-l1-cl.service']}}
        self.good = {'cmdline': ' '.join(Q.expected_cmdline(self.m, self.prep)) + '\n', 'uname': '6.8.0-1-generic\n', 'memtotal_kb': str(8 * GIB // 1024 - 200000),
                     'unitfiles': ''.join(f'{u} masked-runtime enabled\n' for u in Q.mask_set(self.m, self.prep)),
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
        bad['unrecorded guest unit'] = d(unitfiles=self.good['unitfiles'] + 'enclave-base-recover.service masked-runtime enabled\n')
        for k, v in bad.items():
            self.assertTrue(Q.guest_checks(self.m, self.prep, v), k)

    def test_disk_units_are_masked_on_the_cmdline_and_the_cmdline_is_capped(self):
        cmd = Q.expected_cmdline(self.m, self.prep)
        self.assertIn('systemd.mask=enclave-base-readiness.timer', cmd)                  # found on the disk, not in MASKS
        self.assertEqual(cmd.count('systemd.mask=enclave-l1-cl.service'), 1)              # union, no duplicate
        self.assertLessEqual(Q.cmdline_ok(self.m, self.prep), Q.CMDLINE_MAX)
        big = {**self.prep, 'unitInventory': {f'enclave-unit-with-a-long-name-{i:03d}.service': [] for i in range(60)}}
        with self.assertRaises(Q.Refuse):
            Q.cmdline_ok(self.m, big)

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


class FakeFS:
    """a tiny ext4-like tree answering debugfs `ls -p <dir>` and `stat <path>` (SOURCE FIXTURE, not debugfs)
    tree: {path: 'dir' | 'file' | ('link', target)}; broken: dirs whose listing fails (rc 1, no ./.. lines)"""
    def __init__(self, tree, broken=()):
        self.tree, self.broken, self.calls = {'/': 'dir', **tree}, set(broken), 0

    def mode(self, p):
        t = self.tree[p]
        return '40755' if t == 'dir' else ('120777' if isinstance(t, tuple) else '100644')

    def __call__(self, req):
        self.calls += 1
        w = req.split()
        if w[0] == 'ls':
            p = w[2]
            if p in self.broken:
                return 1, 'garbage\n'
            if self.tree.get(p) != 'dir':
                return 0, ''                                                       # real debugfs: the error goes to stderr
            kids = sorted(k for k in self.tree if k != '/' and posixpath.dirname(k) == p)
            rows = ['/2/40755/0/0/./4096/', '/2/40755/0/0/../4096/'] + \
                   [f'/{i}/{self.mode(k)}/0/0/{posixpath.basename(k)}/0/' for i, k in enumerate(kids, 10)]
            return 0, '\n'.join(rows) + '\n'
        if w[0] == 'stat':
            t = self.tree.get(w[1])
            if isinstance(t, tuple):
                return 0, f'Inode: 5   Type: symlink    Mode:  0777\nFast link dest: "{t[1]}"\n'
            return 0, ('Inode: 5   Type: directory\n' if t == 'dir' else '')
        return 1, ''


def noble(**extra):
    """usr-merged noble shape: /lib -> usr/lib; one enclave system unit; no /usr/local units; no user units; no linger dir"""
    t = {'/etc': 'dir', '/etc/systemd': 'dir', '/etc/systemd/system': 'dir', '/etc/systemd/system/multi-user.target.wants': 'dir',
         '/etc/systemd/system/multi-user.target.wants/ssh.service': ('link', '/usr/lib/systemd/system/ssh.service'),
         '/etc/systemd/system/enclave-l1-cl.service': 'file',
         '/usr': 'dir', '/usr/lib': 'dir', '/usr/lib/systemd': 'dir', '/usr/lib/systemd/system': 'dir',
         '/usr/lib/systemd/system/ssh.service': 'file', '/lib': ('link', 'usr/lib'),
         '/var': 'dir', '/var/lib': 'dir', '/var/lib/systemd': 'dir', '/home': 'dir', '/home/ubuntu': 'dir', '/root': 'dir'}
    for k, v in extra.items():
        t[k] = v
    return t


def with_parents(t, path, leaf):
    parts = path.strip('/').split('/')
    for i in range(1, len(parts)):
        t.setdefault('/' + '/'.join(parts[:i]), 'dir')
    t[path] = leaf
    return t


class Scan(unittest.TestCase):
    def test_noble_shape_scans_clean_alias_and_absent_are_distinct(self):
        s = Q.scan_units(FakeFS(noble()))
        self.assertEqual(list(s['system']), ['enclave-l1-cl.service']); self.assertEqual(s['problems'], [])
        self.assertEqual(s['dirs']['/lib/systemd/system'], {'state': 'alias', 'of': '/usr/lib/systemd/system'})
        self.assertEqual(s['dirs']['/usr/local/lib/systemd/system']['state'], 'absent')
        self.assertEqual(s['dirs']['/var/lib/systemd/linger']['state'], 'absent')
        self.assertEqual(s['dirs']['/etc/systemd/system']['state'], 'listed')

    def test_usr_local_wants_requires_and_dropins_of_every_system_dir_are_found_and_masked(self):
        t = noble()
        with_parents(t, '/usr/local/lib/systemd/system/enclave-local.service', 'file')
        with_parents(t, '/usr/lib/systemd/system/timers.target.wants/enclave-readiness.timer', ('link', '../enclave-readiness.timer'))
        with_parents(t, '/etc/systemd/system/enclave-holder.service.d', 'dir')
        with_parents(t, '/etc/systemd/system/enclave-gate.target.wants', 'dir')
        with_parents(t, '/etc/systemd/system/sockets.target.requires/enclave-x@a.socket', ('link', '/x'))
        s = Q.scan_units(FakeFS(t))
        self.assertEqual(sorted(s['system']), ['enclave-gate.target', 'enclave-holder.service', 'enclave-l1-cl.service',
                                               'enclave-local.service', 'enclave-readiness.timer', 'enclave-x@a.socket'])
        m = {'disks': {'l1': {'mount': '/srv/enclave-l1-pair'}, 'base': {'mount': '/srv/enclave-base-holder'}}}
        masks = Q.mask_set(m, {'unitInventory': s['system']})
        for u in s['system']:
            self.assertEqual(masks.count(u), 1, u)

    def test_required_dirs_absent_empty_or_unreadable_refuse(self):
        no_usr = {k: v for k, v in noble().items() if not k.startswith('/usr/lib/systemd/system')}
        empty_usr = {k: v for k, v in noble().items() if k != '/usr/lib/systemd/system/ssh.service'}
        for name, fs in (('absent /usr/lib/systemd/system', FakeFS(no_usr)), ('empty /usr/lib/systemd/system', FakeFS(empty_usr)),
                         ('unreadable /etc/systemd/system', FakeFS(noble(), broken={'/etc/systemd/system'})),
                         ('unreadable parent /usr', FakeFS(noble(), broken={'/usr'}))):
            with self.assertRaises(Q.Refuse, msg=name):
                Q.scan_units(fs)

    def test_optional_dir_absent_is_fine_but_an_unreadable_one_refuses(self):
        t = with_parents(noble(), '/usr/local/lib/systemd/system', 'dir')
        self.assertEqual(Q.scan_units(FakeFS(t))['dirs']['/usr/local/lib/systemd/system']['state'], 'listed')   # exists, empty: ok
        with self.assertRaises(Q.Refuse):
            Q.scan_units(FakeFS(t, broken={'/usr/local/lib/systemd/system'}))                                    # exists, error: never "empty"
        t2 = with_parents(noble(), '/usr/local/lib/systemd/system', 'file')
        with self.assertRaises(Q.Refuse):
            Q.scan_units(FakeFS(t2))                                                                               # exists, not a directory

    def test_user_units_and_linger_are_refusals_non_enclave_user_units_are_not(self):
        cases = {'/etc/systemd/user/enclave-u.service': 'file',
                 '/home/ubuntu/.config/systemd/user/default.target.wants/enclave-v.service': ('link', '/x'),
                 '/root/.config/systemd/user/enclave-w.timer': 'file', '/var/lib/systemd/linger/ubuntu': 'file'}
        for path, leaf in cases.items():
            s = Q.scan_units(FakeFS(with_parents(noble(), path, leaf)))
            self.assertTrue(s['problems'], path)
        s = Q.scan_units(FakeFS(with_parents(noble(), '/etc/systemd/user/pipewire.service', 'file')))
        self.assertEqual(s['problems'], [])
        s = Q.scan_units(FakeFS(with_parents(noble(), '/var/lib/systemd/linger', 'dir')))                        # empty linger dir: fine
        self.assertEqual((s['problems'], s['linger']), ([], []))

    def test_nonliteral_names_symlink_loops_and_the_request_budget(self):
        s = Q.scan_units(FakeFS(noble(**{"/etc/systemd/system/enclave-x'y.service": 'file'})))
        self.assertTrue(any('not literal' in p for p in s['problems']))
        s = Q.scan_units(FakeFS(with_parents(noble(), '/home/a b', 'dir')))
        self.assertTrue(any('home directory name' in p for p in s['problems']))
        with self.assertRaises(Q.Refuse):
            Q.scan_units(FakeFS(noble(**{'/lib': ('link', 'lib')})))                                               # loop -> bounded
        calls = []
        stub = lambda argv, **kw: (calls.append(argv), type('R', (), {'returncode': 0, 'stdout': b'/2/40755/0/0/./0/\n/2/40755/0/0/../0/\n'})())[1]
        dbg = Q.make_dbg('raw?offset=0', stub, budget=3)
        for _ in range(3):
            dbg('ls -p /')
        with self.assertRaises(Q.Refuse):
            dbg('ls -p /')
        self.assertEqual(len(calls), 3); self.assertEqual(calls[0][:3], ['debugfs', '-c', '-R'])                 # read-only debugfs only


class FakeProc:
    def __init__(self, raw, exit_code=0, hang=False, poll_rc=None):
        self.raw, self.exit_code, self.hang, self.poll_rc, self.killed = raw, exit_code, hang, poll_rc, False
        open(raw, 'wb').write(b'x' * 1024)

    def poll(self):
        return self.poll_rc

    def wait(self, timeout=None):
        if self.hang and not self.killed:
            raise Q.subprocess.TimeoutExpired('nbdfuse', timeout)
        if os.path.exists(self.raw):
            os.unlink(self.raw)                                                     # the FUSE mount is gone
        return -9 if self.killed else self.exit_code

    def kill(self):
        self.killed = True


class Exposure(unittest.TestCase):
    def mk(self, fus_rc=0, open_after=(), **proc):
        I = type('I', (), {'open_by_others': staticmethod(lambda p: list(open_after))})
        run = lambda argv, **kw: type('R', (), {'returncode': fus_rc if argv[0] == 'fusermount3' else 0, 'stdout': b''})()
        holder = {}
        def popen(argv, **kw):
            holder['p'] = FakeProc(argv[2], **proc); return holder['p']
        return Q.Exposure(I, '/vm/os.qcow2', run, popen, ismount=lambda p: False, sleep=lambda s: None), holder

    def test_teardown_is_verified_and_every_unclean_fact_counts(self):
        ex, _ = self.mk()
        with ex:
            self.assertTrue(os.path.exists(ex.raw))
        self.assertTrue(ex.clean, ex.teardown); self.assertFalse(os.path.exists(ex.mnt))
        for name, kw in (('fusermount failed', {'fus_rc': 1}), ('nbdfuse hung -> killed', {'hang': True}),
                         ('nbdfuse exit 1', {'exit_code': 1}), ('disk still open', {'open_after': [4242]})):
            ex, _ = self.mk(**kw)
            with ex:
                pass
            self.assertFalse(ex.clean, name)

    def test_a_failed_exposure_is_still_torn_down(self):
        ex, holder = self.mk(poll_rc=1)                                                 # nbdfuse died before exposing
        os_path_getsize = os.path.getsize
        try:
            os.path.getsize = lambda p: 0                                               # never "exposed"
            with self.assertRaises(Q.Refuse):
                with ex:
                    pass
        finally:
            os.path.getsize = os_path_getsize
        self.assertIsNotNone(ex.teardown); self.assertFalse(os.path.exists(ex.mnt))


class Inventory(unittest.TestCase):
    M = {'disks': {'os': {'path': None}, 'l1': {'mount': '/srv/enclave-l1-pair'}, 'base': {'mount': '/srv/enclave-base-holder'}}}

    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); self.osd = os.path.join(self.t.name, 'os.qcow2'); open(self.osd, 'wb').write(b'os')
        self.out = os.path.join(self.t.name, 'inv'); self.m = json.loads(json.dumps(self.M)); self.m['disks']['os']['path'] = self.osd
        self.saved = {k: getattr(Q, k) for k in ('cgroup_max', 'production', 'inspector', 'Exposure', 'read_partitions', 'read_grub',
                                                 'make_dbg', 'avail_bytes', 'nvme_policy')}
        self.opened, self.made, self.exposure_clean, self.touch = [], [], True, False
        Q.cgroup_max = lambda: str(Q.LANE); Q.production = lambda: (None, self.m)
        Q.inspector = lambda: type('I', (), {'open_by_others': staticmethod(lambda p: list(self.opened))})
        test = self
        class FakeExposure:
            def __init__(s, I, osd, run=None, popen=None):
                test.made.append(osd); s.raw, s.teardown, s.clean = '/tmp/fake.raw', None, False
            def __enter__(s):
                return s
            def __exit__(s, *e):
                s.teardown, s.clean = {'fake': True}, test.exposure_clean
                if test.touch:
                    os.utime(test.osd, ns=(1, 1))
                return False
        Q.Exposure = FakeExposure
        Q.read_partitions = lambda I, raw: ([{'label': 'cloudimg-rootfs'}], {'cloudimg-rootfs': {'first': 2048}})
        Q.read_grub = lambda I, raw, parts, byl, run: ({'args': ['root=LABEL=cloudimg-rootfs', 'ro'], 'kernelVersion': '6.8.0-1-generic',
                                                        'searchUuid': UUID}, 'BOOT', 'dev')
        Q.make_dbg = lambda dev, run: FakeFS(noble())
        Q.avail_bytes = lambda p: (_ for _ in ()).throw(AssertionError('inventory must not use capacity'))
        Q.nvme_policy = lambda m, out: (_ for _ in ()).throw(AssertionError('inventory must not use the capacity policy'))

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(Q, k, v)
        self.t.cleanup()

    def test_reads_metadata_only_without_capacity_overlay_or_extraction(self):
        s = Sys(dict(PROD_OK))
        rec = Q.cmd_inventory(self.out, s)
        self.assertTrue(rec['ok'], rec['problems'])
        self.assertEqual(list(rec['unitScan']['system']), ['enclave-l1-cl.service'])
        self.assertIn('enclave-l1-cl.service', rec['maskSet']); self.assertLessEqual(rec['cmdlineBytes'], Q.CMDLINE_MAX)
        self.assertFalse([c for c in s.calls if c[0] in ('qemu-img', 'systemd-run', 'qemu-system-x86_64') or 'dump' in ' '.join(c)])
        self.assertEqual(os.listdir(self.out), ['INVENTORY.json']); self.assertEqual(os.stat(self.out).st_mode & 0o777, 0o700)
        self.assertEqual(json.load(open(os.path.join(self.out, 'INVENTORY.json')))['osDiskIdentBefore'], rec['osDiskIdentAfter'])
        with self.assertRaises(Q.Refuse):
            Q.cmd_inventory(self.out, Sys(dict(PROD_OK)))                                    # never reuses an output dir
        self.assertEqual(Q.main(['inventory', os.path.join(self.t.name, 'inv2')], run=Sys(dict(PROD_OK))), 0)

    def test_unclean_teardown_identity_change_or_scan_problem_writes_the_record_and_rc_2(self):
        for name, mut in (('unclean teardown', lambda: setattr(self, 'exposure_clean', False)), ('identity changed', lambda: setattr(self, 'touch', True)),
                          ('user unit', lambda: setattr(Q, 'make_dbg', lambda dev, run: FakeFS(with_parents(noble(), '/etc/systemd/user/enclave-u.service', 'file'))))):
            self.exposure_clean, self.touch = True, False; Q.make_dbg = lambda dev, run: FakeFS(noble())
            mut(); out = os.path.join(self.t.name, name.replace(' ', '-'))
            self.assertEqual(Q.main(['inventory', out], run=Sys(dict(PROD_OK))), 2, name)
            rec = json.load(open(os.path.join(out, 'INVENTORY.json'))); self.assertFalse(rec['ok'], name); self.assertTrue(rec['problems'], name)

    def test_preconditions_refuse_before_any_mapping(self):
        for name, mut, units in (('outside a queue lane', lambda: setattr(Q, 'cgroup_max', lambda: 'max'), PROD_OK),
                                 ('lane above 512 MiB', lambda: setattr(Q, 'cgroup_max', lambda: str(4096 * MIB)), PROD_OK),
                                 ('production running', None, {**PROD_OK, Q.PROD_UNIT_NAMES[0]: {'LoadState': 'loaded', 'ActiveState': 'active'}}),
                                 ('qual vm present', None, {**PROD_OK, Q.VM_UNIT: {'LoadState': 'loaded', 'ActiveState': 'active'}}),
                                 ('disk open', lambda: self.opened.append(777), PROD_OK)):
            self.made.clear(); Q.cgroup_max = lambda: str(Q.LANE); self.opened.clear()
            if mut:
                mut()
            with self.assertRaises(Q.Refuse, msg=name):
                Q.cmd_inventory(os.path.join(self.t.name, 'p-' + name.replace(' ', '-')), Sys(dict(units)))
            self.assertEqual(self.made, [], name)                                        # never mapped the disk


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
        prep = {'osDisk': osd, 'overlay': '/tmp/x/os-qual.qcow2', 'cmdlineFromGrub': ['root=LABEL=cloudimg-rootfs', 'ro'], 'unitInventory': {}}
        a, p = Q.qual_argv(pv, m, prep), pv.qemu_argv(m)
        body, pbody = a[:-6], p[:31] + p[35:]
        self.assertEqual({i for i, (x, y) in enumerate(zip(body, pbody)) if x != y}, {2, 6, 14, 26, 30, 38, 42, 46, 54})
        self.assertIn('restrict=on', body[54].split(',')); self.assertEqual(a[-1], ' '.join(Q.expected_cmdline(m, prep)))


if __name__ == '__main__':
    unittest.main()
