"""rpc-qualification-vm-stage/r2 offline tests (python3 -I -m unittest discover -s <abs test dir> -t <same> -v). Reads the pinned
production launcher/manifest/units ONLY; never runs QEMU, systemd-run, ssh, nbdfuse or qemu-img (systemctl is a stub)."""
import hashlib, importlib.util, json, os, sys, tempfile, unittest
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('qualvm', os.path.join(os.path.dirname(HERE), 'qualvm.py')); Q = importlib.util.module_from_spec(spec); spec.loader.exec_module(Q)
GIB = 1 << 30
# Ubuntu-shaped (stock next_entry branch, $vt_handoff, search/insmod/echo lines); a LABELLED fixture, not the real OS's grub.cfg
GRUB = """if [ -s $prefix/grubenv ]; then
  load_env
fi
if [ "${next_entry}" ] ; then
   set default="${next_entry}"
   set next_entry=
   save_env next_entry
   set boot_once=true
else
   set default="0"
fi
menuentry 'Ubuntu' --class ubuntu --class gnu-linux $menuentry_id_option 'gnulinux-simple-1234' {
\trecordfail
\tinsmod ext2
\tsearch --no-floppy --fs-uuid --set=root 1234-ABCD
\techo 'Loading Linux 6.8.0-1-generic ...'
\tlinux\t/vmlinuz-6.8.0-1-generic root=LABEL=cloudimg-rootfs ro console=tty1 console=ttyS0 $vt_handoff
\techo 'Loading initial ramdisk ...'
\tinitrd\t/initrd.img-6.8.0-1-generic
}
submenu 'Advanced options for Ubuntu' $menuentry_id_option 'gnulinux-advanced-1234' {
\tmenuentry 'Ubuntu, with Linux 6.8.0-1-generic' {
\t\tlinux /vmlinuz-6.8.0-1-generic root=LABEL=cloudimg-rootfs ro
\t\tinitrd /initrd.img-6.8.0-1-generic
\t}
}
"""
ENV = "# GRUB Environment Block\nnext_entry=\n" + "#" * 900


def stub(states):
    def run(argv, **kw):
        assert argv[:3] == ['systemctl', '--user', 'show'], argv
        return type('R', (), {'returncode': 0, 'stdout': states.get(argv[-1], 'inactive') + '\n', 'stderr': ''})()
    return run


class Grub(unittest.TestCase):
    def test_ubuntu_shaped_default_entry_is_taken_literally(self):
        k, i, args = Q.parse_grub(GRUB, ENV)
        self.assertEqual((k, i), ('/vmlinuz-6.8.0-1-generic', '/initrd.img-6.8.0-1-generic'))     # r1 returned '/' (li[0][0])
        self.assertEqual(args, ['root=LABEL=cloudimg-rootfs', 'ro', 'console=tty1', 'console=ttyS0'])

    def test_adversarial_entries_are_refused(self):
        L, I = '\tlinux\t/vmlinuz-6.8.0-1-generic root=LABEL=cloudimg-rootfs ro console=tty1 console=ttyS0 $vt_handoff', '\tinitrd\t/initrd.img-6.8.0-1-generic'
        bad = {
            'two initrd lines': GRUB.replace(I, I + '\n' + I, 1),
            'two initrd files (microcode first)': GRUB.replace(I, '\tinitrd\t/amd-ucode.img /initrd.img-6.8.0-1-generic', 1),
            'initrd variable': GRUB.replace(I, '\tinitrd\t$initrd_path', 1),
            'initrd relative': GRUB.replace(I, '\tinitrd\tinitrd.img', 1),
            'initrd dotdot': GRUB.replace(I, '\tinitrd\t/../initrd.img', 1),
            'no initrd': GRUB.replace(I + '\n', '', 1),
            'two linux lines': GRUB.replace(L, L + '\n' + L, 1),
            'kernel variable': GRUB.replace('/vmlinuz-6.8.0-1-generic root=LABEL', '${kernel} root=LABEL', 1),
            'arg variable': GRUB.replace('console=ttyS0 $vt_handoff', 'console=ttyS0 $extra_cmdline', 1),
            'arg quoted': GRUB.replace('console=ttyS0 $vt_handoff', 'quiet "splash"', 1),
            'no root=': GRUB.replace('root=LABEL=cloudimg-rootfs ', '', 1),
            'two root=': GRUB.replace('ro console=tty1', 'ro root=/dev/sda1 console=tty1', 1),
            'linux16 only': GRUB.replace('\tlinux\t/vmlinuz', '\tlinux16\t/vmlinuz', 1),
            'default 1': GRUB.replace('set default="0"', 'set default="1"'),
            'default saved_entry': GRUB.replace('set default="0"', 'set default="${saved_entry}"'),
            'submenu first': GRUB[GRUB.index('submenu'):] + GRUB[GRUB.index('menuentry'):GRUB.index('submenu')],
            'no menuentry': 'set default="0"\n',
        }
        for name, cfg in bad.items():
            with self.assertRaises(Q.Refuse, msg=name):
                Q.parse_grub(cfg, ENV)

    def test_grubenv_next_or_saved_entry_refuses(self):
        for env in ('next_entry=gnulinux-advanced-1234>1\n', 'saved_entry=1\n'):
            with self.assertRaises(Q.Refuse, msg=env):
                Q.parse_grub(GRUB, env)
        self.assertEqual(Q.parse_grub(GRUB, 'saved_entry=\nnext_entry=\n')[1], '/initrd.img-6.8.0-1-generic')


class Argv(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(); d = self.t.name
        for n in ('vmlinuz', 'initrd'):
            open(os.path.join(d, n), 'wb').write(n.encode() * 100)
        self.pv, self.m = Q.production(stub({}))
        osd = self.m['disks']['os']['path']; st = os.stat(osd)
        self.prep = {'osDisk': osd, 'osDiskMtimeNs': st.st_mtime_ns, 'osDiskIno': st.st_ino, 'overlay': os.path.join(d, 'os-qual.qcow2'),
                     'kernel': {'sha256': Q.sha(os.path.join(d, 'vmlinuz'))}, 'initrd': {'sha256': Q.sha(os.path.join(d, 'initrd'))},
                     'cmdlineFromGrub': ['root=LABEL=cloudimg-rootfs', 'ro', 'console=ttyS0'], 'fstabAutoDataMounts': []}
        json.dump(self.prep, open(os.path.join(d, 'PREPARED.json'), 'w'))

    def tearDown(self):
        self.t.cleanup()

    def test_only_the_reviewed_differences(self):
        prod, a = self.pv.qemu_argv(self.m), Q.qual_argv(self.pv, self.m, self.prep)
        self.assertEqual(a[-6:-1], ['-kernel', f'{self.t.name}/vmlinuz', '-initrd', f'{self.t.name}/initrd', '-append'])
        cmd = a[-1].split()
        for u in Q.MASKS + ('srv-enclave\\x2dl1\\x2dpair.mount', 'srv-enclave\\x2dbase\\x2dholder.mount'):
            self.assertIn(f'systemd.mask={u}', cmd)
        self.assertEqual(cmd[:3], self.prep['cmdlineFromGrub'])
        body, pbody = a[:-6], prod[:31] + prod[35:]
        self.assertEqual(len(body), len(pbody))
        diff = {i for i, (x, y) in enumerate(zip(body, pbody)) if x != y}
        self.assertEqual(diff, {2, 6, 14, 26, 30, 38, 42, 46, 54})       # name, memory x2, console, qmp, os/l1/base blockdev, netdev
        self.assertEqual(body[6], f'memory-backend-ram,id=rpcmem,size={8 * GIB},prealloc=on'); self.assertEqual(body[14], '8192M')
        b = {json.loads(body[i])['node-name']: json.loads(body[i]) for i in (38, 42, 46, 50)}
        self.assertEqual(b['os0']['file']['filename'], self.prep['overlay']); self.assertFalse(b['os0']['read-only'])
        self.assertTrue(b['l10']['read-only'] and b['base0']['read-only']); self.assertTrue(b['seed0']['read-only'])
        self.assertEqual(b['l10']['file']['filename'], self.m['disks']['l1']['path'])
        net = body[54].split(',')
        self.assertEqual([t for t in net if t.startswith('hostfwd=')], [Q.SSH_FWD]); self.assertIn('restrict=on', net)   # always (r2)
        self.assertNotIn('guard-qmp.sock', ' '.join(a)); self.assertNotIn('/run/user/1000/enclave-rpc-production/', ' '.join(a))
        self.assertIn('on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny', body)

    def test_transient_unit_caps_and_launch_floor(self):
        sr = Q.systemd_run(['/usr/bin/qemu-system-x86_64'])
        self.assertIn(f'-pMemoryMax={10 * GIB}', sr); self.assertIn('-pMemorySwapMax=0', sr); self.assertIn(f'--unit={Q.QUAL_UNIT}', sr)
        Q.mem_available = lambda: 26 * GIB - 1
        with self.assertRaises(Q.Refuse):
            Q.cmd_launch(self.t.name, stub({}))
        for st in ({'enclave-rpc-production-vm.service': 'active'}, {'enclave-rpc-production-guard.service': 'activating'}, {Q.QUAL_UNIT: 'active'}):
            Q.mem_available = lambda: 80 * GIB
            with self.assertRaises(Q.Refuse):
                Q.cmd_launch(self.t.name, stub(st))

    def test_changed_kernel_or_auto_data_mount_refuses(self):
        open(os.path.join(self.t.name, 'vmlinuz'), 'ab').write(b'x')
        with self.assertRaises(Q.Refuse):
            Q.checked(self.t.name, stub({}))
        self.setUp(); self.prep['fstabAutoDataMounts'] = ['UUID=x /srv/enclave-l1-pair ext4 defaults 0 2']
        json.dump(self.prep, open(os.path.join(self.t.name, 'PREPARED.json'), 'w'))
        with self.assertRaises(Q.Refuse):
            Q.checked(self.t.name, stub({}))


if __name__ == '__main__':
    unittest.main()
