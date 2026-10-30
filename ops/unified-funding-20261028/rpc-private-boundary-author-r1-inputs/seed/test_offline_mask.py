"""Authored, NOT run.  Unit tests for offline_mask.py using only in-memory synthetic GPT/ext4 bytes, fake debugfs/runner/
exporter effects and nonexistent synthetic paths.  No test touches an image, a production path, a subprocess or the network.
    /usr/bin/python3 -I -m unittest test_offline_mask      (root runs later, from a copy of candidate/, after review)
"""
import copy, hashlib, json, os, struct, subprocess, sys, unittest, uuid, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offline_mask as om  # noqa: E402  (import is inert by contract)

S = 512
LINUX = '0fc63daf-8483-4772-8e79-3d69d8477de4'
DISK_GUID = '11111111-2222-4333-8444-555555555555'
ROOT_GUID = '66666666-7777-4888-9999-aaaaaaaaaaaa'
OTHER_GUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
FS_UUID = '01234567-89ab-4cde-8f01-23456789abcd'
BASE = '/nonexistent-synthetic-test'


def build_disk(parts=((LINUX, ROOT_GUID, 2048, 4000),), nsec=4096, count=128, esize=128, mutate=None):
    disk, table = bytearray(nsec * S), bytearray(count * esize)
    for i, (t, u, f, l) in enumerate(parts):
        struct.pack_into('<16s16sQQQ', table, i * esize, uuid.UUID(t).bytes_le, uuid.UUID(u).bytes_le, f, l, 0)
    last, tsec = nsec - 1, -(-count * esize // S)
    belba = last - tsec

    def hdr(me, alt, elba, tcrc):
        h = bytearray(S)
        struct.pack_into('<8sIIIIQQQQ16sQIII', h, 0, b'EFI PART', 0x10000, 92, 0, 0, me, alt, 2 + tsec, belba - 1,
                         uuid.UUID(DISK_GUID).bytes_le, elba, count, esize, tcrc)
        if mutate:
            mutate('header', me, h)
        struct.pack_into('<I', h, 16, zlib.crc32(bytes(h[:16]) + b'\0' * 4 + bytes(h[20:92])) & 0xffffffff)
        return h
    ptab, btab = bytes(table), bytes(table)
    if mutate:
        btab = mutate('backup-table', None, bytearray(btab)) or btab
    disk[S:2 * S] = hdr(1, last, 2, zlib.crc32(ptab) & 0xffffffff)
    disk[2 * S:2 * S + len(ptab)] = ptab
    disk[belba * S:belba * S + len(btab)] = btab
    disk[last * S:] = hdr(last, 1, belba, zlib.crc32(btab) & 0xffffffff)
    return disk


def build_sb(fs_uuid=FS_UUID, label='cloudimg-rootfs', state=1, compat=0x3c, incompat=0x2c2, ro=0x6b, journal_dev=0,
             orphan=0, errors=0, blocks=200):
    sb = bytearray(1024)
    struct.pack_into('<II', sb, 0, 64, blocks)
    struct.pack_into('<I', sb, 0x18, 2)
    struct.pack_into('<HH', sb, 0x38, 0xEF53, state)
    struct.pack_into('<I', sb, 0x4C, 1)
    struct.pack_into('<III', sb, 0x5C, compat, incompat, ro)
    sb[0x68:0x78] = uuid.UUID(fs_uuid).bytes
    sb[0x78:0x78 + len(label)] = label.encode()
    struct.pack_into('<III', sb, 0xE0, 8, journal_dev, orphan)
    struct.pack_into('<I', sb, 0x194, errors)
    return bytes(sb)


def reader(disk):
    return lambda off, n: bytes(disk[off:off + n])


def plan():
    sha = lambda c: c * 64
    return {
        'format': om.FORMAT_PLAN, 'operationId': 'synthetic-op-0001', 'stamp': '20261030T120000Z-abcdef',
        'writerSource': {'path': BASE + '/offline_mask.py', 'sha256': sha('a')},
        'unitPins': {'path': BASE + '/UNIT-PINS.json', 'sha256': sha('b')},
        'tools': dict({k: {'path': p, 'sha256': h} for k, (p, h) in om.TOOL_PINS.items()},
                      systemctl={'path': '/usr/bin/systemctl', 'sha256': sha('c')}),
        'source': {'path': BASE + '/os/os.qcow2', 'sha256': sha('d'), 'device': 10, 'inode': 100, 'size': 1 << 30,
                   'mtimeNs': 5},
        'backup': {'path': BASE + '/backup/os.qcow2', 'sha256': sha('e'), 'device': 10, 'inode': 200, 'size': 1 << 30,
                   'mtimeNs': 6, 'receiptPath': BASE + '/backup/RECEIPT.json', 'receiptSha256': sha('f')},
        'destination': {'parentDir': BASE + '/nvme', 'workDirName': 'deriv-1', 'device': 20, 'forbiddenDevices': [1, 2],
                        'floorBytes': 1 << 30, 'evidenceMarginBytes': 1 << 20, 'workingMarginBytes': 1 << 20,
                        'qcowMetadataAllowanceBytes': 1 << 24},
        'image': {'virtualSize': 4096 * S, 'sectorSize': S, 'diskGuid': DISK_GUID, 'rootIndex': 1,
                  'rootTypeGuid': LINUX, 'rootUniqueGuid': ROOT_GUID, 'rootFirstLba': 2048, 'rootLastLba': 4000},
        'filesystem': {'uuid': FS_UUID, 'label': 'cloudimg-rootfs', 'blockSize': 4096, 'blocksCount': 200,
                       'inodesCount': 64, 'featureCompat': 0x3c, 'featureIncompat': 0x2c2, 'featureRoCompat': 0x6b},
        'fragments': {'mode': 0o644, 'uid': 0, 'gid': 0, 'xattrNames': [], 'inodes': {}},
        'usrMerge': True, 'vmUnits': ['enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service'],
        'workflowLocks': [{'path': BASE + '/lock', 'device': 10, 'inode': 300}],
        'resourceEnvelope': {'cgroup': '/synthetic.scope', 'memoryMax': '536870912', 'swapMax': '0'},
        'bounds': {'totalSeconds': 3600, 'commandSeconds': 60, 'fsckSeconds': 600, 'exportStartSeconds': 30,
                   'exportStopSeconds': 30, 'maxOutputBytes': 1 << 20, 'maxLogBytes': 1 << 22, 'maxInventoryEntries': 5000},
        'acceptUnqualified': sorted(om.UNQUALIFIED),
    }


class PlanTests(unittest.TestCase):
    def test_valid_synthetic_plan(self):
        om.validate_plan(plan())

    def test_digest_mismatch_and_duplicate_keys(self):
        data = json.dumps(plan()).encode()
        with self.assertRaises(om.Refusal):
            om.load_plan(data, '0' * 64)
        dup = b'{"format": "x", "format": "y"}'
        with self.assertRaises(om.Refusal):
            om.load_plan(dup, hashlib.sha256(dup).hexdigest())

    def test_unqualified_primitives_need_explicit_acceptance(self):
        p = plan(); p['acceptUnqualified'] = p['acceptUnqualified'][1:]
        with self.assertRaises(om.Refusal):
            om.validate_plan(p)

    def test_tool_pin_and_unknown_key(self):
        p = plan(); p['tools']['debugfs']['sha256'] = '1' * 64
        with self.assertRaises(om.Refusal):
            om.validate_plan(p)
        p = plan(); p['extra'] = 1
        with self.assertRaises(om.Refusal):
            om.validate_plan(p)

    def test_unsafe_paths(self):
        for bad in ('/tmp/x.qcow2', BASE + '/../etc/x', BASE + '/a,b', 'relative', BASE + '//x', '/run/x', BASE + '/a b'):
            p = plan(); p['source']['path'] = bad
            with self.assertRaises(om.Refusal, msg=bad):
                om.validate_plan(p)

    def test_source_backup_alias_and_forbidden_destination(self):
        p = plan(); p['backup']['inode'] = p['source']['inode']
        with self.assertRaises(om.Refusal):
            om.validate_plan(p)
        p = plan(); p['destination']['device'] = 1
        with self.assertRaises(om.Refusal):
            om.validate_plan(p)

    def test_unit_pins_must_be_exact(self):
        good = json.dumps({'kind': om.UNIT_PINS_KIND, 'units': om.UNITS}).encode()
        om.validate_unit_pins(good, hashlib.sha256(good).hexdigest())
        units = dict(om.UNITS); units.pop('enclave-l1-cl.service')
        bad = json.dumps({'kind': om.UNIT_PINS_KIND, 'units': units}).encode()
        with self.assertRaises(om.Refusal):
            om.validate_unit_pins(bad, hashlib.sha256(bad).hexdigest())


class GptTests(unittest.TestCase):
    def parse(self, disk):
        return om.parse_gpt(reader(disk), len(disk), S)

    def test_valid(self):
        g = self.parse(build_disk())
        self.assertEqual(g['diskGuid'], DISK_GUID)
        self.assertEqual([(x['first'], x['last']) for x in g['partitions']], [(2048, 4000)])

    def test_corrupt_primary_and_backup_header_crc(self):
        for lba in (1, 4095):
            d = build_disk(); d[lba * S + 60] ^= 1
            with self.assertRaises(om.Refusal):
                self.parse(d)

    def test_corrupt_primary_and_backup_table_crc(self):
        d = build_disk(); d[2 * S + 40] ^= 1
        with self.assertRaisesRegex(om.Refusal, 'primary entry table CRC'):
            self.parse(d)
        d = build_disk(); d[(4095 - 32) * S + 40] ^= 1
        with self.assertRaisesRegex(om.Refusal, 'backup entry table CRC'):
            self.parse(d)

    def test_mismatching_backup_table_with_valid_crc(self):
        def mut(kind, me, buf):
            if kind == 'backup-table':
                struct.pack_into('<Q', buf, 40, 3999)
                return bytes(buf)
        with self.assertRaisesRegex(om.Refusal, 'differ'):
            self.parse(build_disk(mutate=mut))

    def test_bad_geometry_with_valid_crc(self):
        def huge(kind, me, h):
            if kind == 'header':
                struct.pack_into('<I', h, 80, 100000)
        with self.assertRaisesRegex(om.Refusal, 'geometry'):
            self.parse(build_disk(mutate=huge))
        def wrong_alt(kind, me, h):
            if kind == 'header' and me == 1:
                struct.pack_into('<Q', h, 32, 4000)
        with self.assertRaisesRegex(om.Refusal, 'location'):
            self.parse(build_disk(mutate=wrong_alt))

    def test_overlap_and_out_of_usable(self):
        with self.assertRaisesRegex(om.Refusal, 'overlap'):
            self.parse(build_disk(parts=((LINUX, ROOT_GUID, 2048, 3000), (LINUX, OTHER_GUID, 3000, 4000))))
        with self.assertRaisesRegex(om.Refusal, 'usable'):
            self.parse(build_disk(parts=((LINUX, ROOT_GUID, 2048, 4090),)))

    def test_ambiguous_and_mismatching_root(self):
        p = plan()
        g = self.parse(build_disk(parts=((LINUX, ROOT_GUID, 2048, 3000), (LINUX, OTHER_GUID, 3001, 4000))))
        sb = om.parse_ext4_sb(build_sb())
        with self.assertRaisesRegex(om.Refusal, 'ambiguous'):
            om.select_root(g, p['image'], {1: sb, 2: sb}, p['filesystem'])
        g = self.parse(build_disk())
        im = dict(p['image'], rootUniqueGuid=OTHER_GUID)
        with self.assertRaises(om.Refusal):
            om.select_root(g, im, {1: sb}, p['filesystem'])
        part, off, length = om.select_root(g, p['image'], {1: sb}, p['filesystem'])
        self.assertEqual((off, length), (2048 * S, 1953 * S))


class Ext4Tests(unittest.TestCase):
    def check(self, **kw):
        return om.validate_sb(om.parse_ext4_sb(build_sb(**kw)), plan()['filesystem'], 1953 * S)

    def test_clean(self):
        self.assertEqual(self.check()['uuid'], FS_UUID)

    def test_refusals(self):
        cases = [dict(state=0), dict(state=3), dict(state=5), dict(orphan=12), dict(errors=1), dict(journal_dev=0x801),
                 dict(fs_uuid=OTHER_GUID), dict(label='other')]
        for kw in cases:
            with self.assertRaises(om.Refusal, msg=kw):
                self.check(**kw)

    def test_recovery_and_unsupported_features(self):
        fs = plan()['filesystem']
        for incompat in (0x2c2 | 0x4, 0x2c2 | 0x8, 0x2c2 | 0x100, 0x2c2 | 0x8000):
            with self.assertRaises(om.Refusal):
                om.validate_sb(om.parse_ext4_sb(build_sb(incompat=incompat)), dict(fs, featureIncompat=incompat), 1953 * S)
        with self.assertRaises(om.Refusal):
            om.validate_sb(None, fs, 1953 * S)


class QcowTests(unittest.TestCase):
    def hdr(self, version=3, bfo=0, crypt=0, incompat=0, ext=None):
        h = bytearray(4096)
        struct.pack_into('>4sIQIIQI', h, 0, b'QFI\xfb', version, bfo, 0, 16, 4096 * S, crypt)
        struct.pack_into('>QQQII', h, 72, incompat, 0, 0, 4, 112)
        if ext:
            struct.pack_into('>II', h, 112, ext, 8)
        return bytes(h)

    def test_refusals(self):
        om.parse_qcow2_header(self.hdr(), 1)
        for kw in (dict(bfo=512), dict(crypt=1), dict(incompat=0x4), dict(incompat=0x1), dict(ext=0x44415441)):
            with self.assertRaises(om.Refusal, msg=kw):
                om.parse_qcow2_header(self.hdr(**kw), 1)
        im = plan()['image']
        with self.assertRaises(om.Refusal):
            om.validate_qemu_info({'format': 'qcow2', 'virtual-size': im['virtualSize'], 'backing-filename': 'x'}, im)


FRAG_MODE, LINK_MODE, DIR_MODE = 0o100644, 0o120777, 0o040755


def frag_stat(ino, size, links=1, perm=0o644):
    return {'inode': ino, 'type': 'regular', 'perm': perm, 'flags': '0x80000', 'uid': 0, 'gid': 0, 'size': size,
            'links': links, 'times': {'ctime': '0x1'}, 'xattrNames': [], 'xattrSha256': None, 'target': None}


def base_inventory():
    entries, hashes = {}, {}
    entries[f'{om.ETC}/multi-user.target.wants'] = {'inode': 50, 'mode': DIR_MODE, 'uid': 0, 'gid': 0, 'size': 4096}
    for i, (u, h) in enumerate(om.UNITS.items()):
        entries[f'{om.ETC}/{u}'] = {'inode': 1000 + i, 'mode': FRAG_MODE, 'uid': 0, 'gid': 0, 'size': 100 + i}
        hashes[f'{om.ETC}/{u}'] = h
        entries[f'{om.ETC}/multi-user.target.wants/{u}'] = {'inode': 2000 + i, 'mode': LINK_MODE, 'uid': 0, 'gid': 0,
                                                             'size': 10, 'target': f'{om.ETC}/{u}', 'links': 1}
    entries[f'{om.ETC}/enclave-l1-el.service.d'] = {'inode': 60, 'mode': DIR_MODE, 'uid': 0, 'gid': 0, 'size': 4096}
    entries[f'{om.ETC}/enclave-l1-el.service.d/override.conf'] = {'inode': 61, 'mode': FRAG_MODE, 'uid': 0, 'gid': 0,
                                                                   'size': 7}
    hashes[f'{om.ETC}/enclave-l1-el.service.d/override.conf'] = '9' * 64
    inv = {'dirs': [om.ETC, om.USR], 'entries': entries, 'hashes': hashes, 'directives': {}, 'readErrors': []}
    stats = {u: frag_stat(1000 + i, 100 + i) for i, u in enumerate(om.UNITS)}
    return inv, stats


def post_inventory(base):
    post = copy.deepcopy(base)
    for i, u in enumerate(om.UNITS):
        post['entries'][f'{om.ETC}/{u}'] = {'inode': 3000 + i, 'mode': LINK_MODE, 'uid': 0, 'gid': 0, 'size': 9,
                                            'target': '/dev/null', 'links': 1}
        post['hashes'].pop(f'{om.ETC}/{u}')
        post['entries'].pop(f'{om.ETC}/multi-user.target.wants/{u}')
    return post


class InventoryTests(unittest.TestCase):
    def test_clean_preconditions(self):
        inv, st = base_inventory()
        links = om.check_preconditions(inv, st, plan())
        self.assertEqual(len(links), 8)
        ops = om.build_ops(plan(), links, keep_exists=False)
        self.assertEqual([o['op'] for o in ops[:5]], ['mkdir', 'mkdir', 'ln', 'unlink', 'symlink'])
        self.assertNotIn('rm', [o['op'] for o in ops if o.get('unit')])     # original fragments are never rm'd

    def test_fragment_and_link_drift(self):
        cases = []
        inv, st = base_inventory(); inv['hashes'][f'{om.ETC}/enclave-l1-cl.service'] = '0' * 64; cases.append((inv, st))
        inv, st = base_inventory(); st['enclave-l1-cl.service']['links'] = 2; cases.append((inv, st))
        inv, st = base_inventory(); st['enclave-l1-cl.service']['perm'] = 0o664; cases.append((inv, st))
        inv, st = base_inventory(); st['enclave-l1-cl.service']['xattrNames'] = ['user.x']; cases.append((inv, st))
        inv, st = base_inventory()
        inv['entries'][f'{om.ETC}/multi-user.target.wants/enclave-l1-cl.service']['target'] = '/usr/lib/x/other.service'
        cases.append((inv, st))
        inv, st = base_inventory()
        inv['entries'][f'{om.ETC}/alias.service'] = {'inode': 9, 'mode': LINK_MODE, 'uid': 0, 'gid': 0, 'size': 9,
                                                     'target': f'{om.ETC}/enclave-l1-el.service', 'links': 1}
        cases.append((inv, st))
        inv, st = base_inventory()
        inv['entries'][f'{om.USR}/enclave-l1-el.service'] = {'inode': 9, 'mode': FRAG_MODE, 'uid': 0, 'gid': 0, 'size': 1}
        cases.append((inv, st))
        inv, st = base_inventory()
        inv['entries'][f'{om.ETC}/fifo'] = {'inode': 9, 'mode': 0o010644, 'uid': 0, 'gid': 0, 'size': 0}
        cases.append((inv, st))
        inv, st = base_inventory()
        inv['entries'][f'{om.ETC}/enclave-l1-el.service']['mode'] = LINK_MODE      # already masked
        cases.append((inv, st))
        for i, (inv, st) in enumerate(cases):
            with self.assertRaises(om.Refusal, msg=i):
                om.check_preconditions(inv, st, plan())

    def test_semantic_delta(self):
        base, _ = base_inventory()
        links = om.check_preconditions(base, base_inventory()[1], plan())
        self.assertEqual(om.semantic_delta(base, post_inventory(base), links), [])
        post = post_inventory(base); post['hashes'][f'{om.ETC}/enclave-l1-el.service.d/override.conf'] = '8' * 64
        self.assertTrue(om.semantic_delta(base, post, links))
        post = post_inventory(base); post['entries'][f'{om.ETC}/new.service'] = dict(base['entries'][f'{om.ETC}/fifo'] if
                                                                                      False else {'inode': 1, 'mode': FRAG_MODE,
                                                                                                  'uid': 0, 'gid': 0, 'size': 1})
        self.assertTrue(om.semantic_delta(base, post, links))
        post = post_inventory(base)
        post['entries'][f'{om.ETC}/multi-user.target.wants/enclave-l1-cl.service'] = \
            base['entries'][f'{om.ETC}/multi-user.target.wants/enclave-l1-cl.service']
        self.assertTrue(om.semantic_delta(base, post, links))
        post = post_inventory(base); post['readErrors'] = ['x']
        self.assertTrue(om.semantic_delta(base, post, links))

    def test_archive_verification(self):
        _, st = base_inventory()
        listing = [{'name': u} for u in om.UNITS]
        self.assertEqual(om.verify_archive(st, copy.deepcopy(st), listing), [])
        moved = copy.deepcopy(st); moved['enclave-l1-cl.service']['times']['ctime'] = '0x2'
        self.assertTrue(om.verify_archive(st, moved, listing))
        self.assertTrue(om.verify_archive(st, st, listing + [{'name': 'extra'}]))


class FakeRun:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def run(self, argv, timeout, limit):
        self.calls.append(argv)
        return self.replies.pop(0)


class DebugfsTests(unittest.TestCase):
    def dbg(self, replies):
        fx = FakeRun(replies)
        return om.Debugfs(fx, '/usr/bin/debugfs', BASE + '/mnt/root.ext4', plan()['bounds'],
                          om.Deadline(60, lambda: 0.0), lambda *a: None), fx

    def test_unknown_stderr_with_rc0_fails(self):
        d, _ = self.dbg([(0, b'', b'debugfs 1.47.1 (20-May-2024)\nln: Could not allocate block\n')])
        with self.assertRaisesRegex(om.Refusal, 'stderr'):
            d.call('ln <12> /var/lib/enclave-rpc-maint/x/enclave-l1-el.service', True)
        d, _ = self.dbg([(0, b'ok', b'debugfs 1.47.1 (20-May-2024)\n')])
        self.assertEqual(d.call('cat /etc/fstab'), b'ok')
        d, _ = self.dbg([(1, b'', b'')])
        with self.assertRaises(om.Refusal):
            d.call('cat /etc/fstab')

    def test_unsafe_requests_never_run(self):
        d, fx = self.dbg([])
        for req in ('rm /etc/a;rm /etc/b', 'cat "/etc/x"', 'rm /etc/../etc/x', 'rm  /etc/x', 'cat /etc/x\\y'):
            with self.assertRaises(om.Refusal, msg=req):
                d.call(req, True)
        self.assertEqual(fx.calls, [])

    def test_parse_stat_and_ls(self):
        text = ('Inode: 1005   Type: regular    Mode:  0644   Flags: 0x80000\nUser:     0   Group:     0   Size: 104\n'
                'Links: 1   Blockcount: 8\n ctime: 0x6543abcd:00000000 -- x\n mtime: 0x6543abcd:00000000 -- x\n')
        st = om.parse_stat(text)
        self.assertEqual((st['inode'], st['type'], st['perm'], st['links'], st['size']), (1005, 'regular', 0o644, 1, 104))
        with self.assertRaises(om.Refusal):
            om.parse_stat('garbage')
        with self.assertRaises(om.Refusal):
            om.parse_ls_p('/12/100644/0/0/a/1/\nnot a listing line\n')


class FakeDbg:
    """minimal guest model for Writer.apply partial-write detection"""
    def __init__(self, frag, corrupt=None):
        self.dirs = {om.ETC: {u for u in om.UNITS}, f'{om.KEEP}/20261030T120000Z-abcdef': set()}
        self.frag, self.corrupt, self.stats = frag, corrupt, {}

    def ls(self, d):
        return [{'name': n} for n in self.dirs.get(d, set())]

    def call(self, req, write=False):
        w = req.split(' ')
        if w[0] == 'ln':
            parent, name = w[2].rsplit('/', 1)
            self.dirs[parent].add(name)
            u = name
            st = dict(self.frag[u])
            if self.corrupt == 'ln-inode':
                st['inode'] += 1
            self.stats[w[2]] = st
        elif w[0] == 'unlink' and self.corrupt != 'unlink-noop':
            parent, name = w[1].rsplit('/', 1)
            self.dirs[parent].discard(name)
        return b''

    def stat(self, p):
        return self.stats[p]


class ApplyTests(unittest.TestCase):
    class W(om.Writer):
        def __init__(self):
            self.p, self.ops_done, self.work = plan(), [], BASE + '/work'
            self.fx = type('F', (), {'append_sync': lambda *a: None})()

    def test_partial_writes_refused(self):
        _, st = base_inventory()
        u = 'enclave-l1-el.service'
        ln = {'op': 'ln', 'unit': u, 'path': f'{om.KEEP}/20261030T120000Z-abcdef/{u}'}
        w = self.W()
        with self.assertRaisesRegex(om.Refusal, 'exact original inode'):
            w.apply(FakeDbg(st, 'ln-inode'), ln, st)
        dbg, w = FakeDbg(st, 'unlink-noop'), self.W()
        w.apply(dbg, ln, st)
        with self.assertRaisesRegex(om.Refusal, 'still present'):
            w.apply(dbg, {'op': 'unlink', 'unit': u, 'path': f'{om.ETC}/{u}'}, st)
        self.assertEqual(w.ops_done, [ln])          # nothing recorded past the failing step


class FakePipeProc:
    def __init__(self, data, close=True):
        r1, w1 = os.pipe(); r2, w2 = os.pipe()
        os.write(w1, data)
        os.close(w2)
        if close:
            os.close(w1)
        else:
            self.keep = w1
        self.stdout, self.stderr = os.fdopen(r1, 'rb', 0), os.fdopen(r2, 'rb', 0)
        self.pid, self.returncode = 999999, None

    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class RunnerTests(unittest.TestCase):
    def test_output_limit_and_timeout_kill_own_child(self):
        killed = []
        clock = iter(range(0, 10000, 5)).__next__
        fx = om.OsEffects(popen=lambda *a, **k: FakePipeProc(b'x' * 10000), killpg=lambda pid, sig: killed.append(pid),
                          clock=lambda: 0.0)
        with self.assertRaisesRegex(om.Refusal, 'output exceeded'):
            fx.run(['/usr/bin/debugfs', '-R', 'stat /x', BASE + '/f'], 10, 4096)
        self.assertEqual(killed, [999999])
        killed.clear()
        fx = om.OsEffects(popen=lambda *a, **k: FakePipeProc(b'', close=False), killpg=lambda pid, sig: killed.append(pid),
                          clock=clock)
        with self.assertRaisesRegex(om.Refusal, 'exceeded'):
            fx.run(['/usr/bin/e2fsck', '-fn', BASE + '/f'], 3, 4096)
        self.assertEqual(killed, [999999])

    def test_lock_bypass_argv_refused(self):
        fx = om.OsEffects(popen=lambda *a, **k: self.fail('must not spawn'))
        for bad in (['/usr/bin/qemu-img', 'info', '-U', 'x'], ['/usr/bin/qemu-nbd', '--image-opts', 'file.locking=off']):
            with self.assertRaises(om.Refusal):
                fx.run(bad, 1, 4096)


class CleanupTests(unittest.TestCase):
    def test_identity_mismatch_never_signals(self):
        killed = []
        proc = type('P', (), {'returncode': None, 'pid': 4242, 'wait': lambda self, timeout=None: 0})()
        fx = om.OsEffects(killpg=lambda pid, sig: killed.append(pid), proc_starttime=lambda pid: 777)
        h = {'proc': proc, 'pid': 4242, 'start': 123, 'mount': BASE + '/mnt', 'file': BASE + '/mnt/f'}
        with self.assertRaisesRegex(om.Refusal, 'identity mismatch'):
            fx.export_force_cleanup(h, None)
        self.assertEqual(killed, [])
        with self.assertRaises(om.Refusal):
            om.assert_owned(h, None)


class EntryTests(unittest.TestCase):
    class Fx:
        def __init__(self):
            self.writes = []
            self.monotonic, self.time = (lambda: 0.0), (lambda: 0.0)

        def hash_file(self, *a):
            return '0' * 64, {}, {}          # writer source mismatch -> refusal before any write

        def write_excl(self, *a):
            self.writes.append(a)

        def mkdir_excl(self, *a):
            self.writes.append(a)

        def release(self, fd):
            pass

    def test_refusal_before_any_write(self):
        fx = self.Fx()
        code, out = om.operate(plan(), 'f' * 64, [3], fx, plan()['writerSource']['path'])
        self.assertEqual(code, 2)
        self.assertEqual(out['refused']['phase'], 'pins')
        self.assertEqual(fx.writes, [])

    def test_usage_has_no_defaults(self):
        fx = self.Fx()
        self.assertEqual(om.main([], fx=fx), 2)
        self.assertEqual(om.main(['--plan', '/tmp/../x'], fx=fx), 2)
        self.assertEqual(fx.writes, [])


if __name__ == '__main__':
    unittest.main()
