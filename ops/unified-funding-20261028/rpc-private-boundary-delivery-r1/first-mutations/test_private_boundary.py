"""Authored, NOT run.  Targeted tests of the opt-in private-derivative holder policy in offline_mask.py.  In-memory metadata
fakes and nonexistent synthetic paths only; one test observes a fresh tempfile through the real OsEffects.access_meta.  The
original suites are unchanged; the qualified guest phases (exports, debugfs, fsck, qemu-img, GPT) are covered there and are
inert recorders here so the private boundary is observed across the REAL Writer.execute()/operate() sequence.
    /usr/bin/python3 -I -m unittest test_private_boundary      (root runs later, from a copy of candidate/, after review)
"""
import ast, contextlib, copy, errno, hashlib, inspect, json, os, stat, sys, tempfile, textwrap, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offline_mask as om  # noqa: E402  (import is inert by contract)
from test_offline_mask import plan as base_plan, BASE  # noqa: E402

UID = 1000
SHA = lambda b: hashlib.sha256(b).hexdigest()
SRC, BAK, RCPT = BASE + '/os/os.qcow2', BASE + '/backup/os.qcow2', BASE + '/backup/RECEIPT.json'
NVME = BASE + '/nvme'
WORK, MARK = NVME + '/deriv-1', NVME + '/deriv-1.operation'
DERIV = WORK + '/derivative.qcow2'
PA, CO = BASE + '/review/path-access.json', BASE + '/review/coordination.json'
PLAN_SHA, FINAL = '9' * 64, '7' * 64
UNIT_BYTES = b'[Unit]\nDescription=synthetic\n'
RECEIPT = b'{"backupSha256": "' + b'e' * 64 + b'"}'
D, F = stat.S_IFDIR, stat.S_IFREG
DEFAULT_RECEIPT_KEYS = {'format', 'status', 'operationId', 'planSha256', 'writerSha256', 'unitPinsSha256', 'state',
                        'publishable', 'running', 'rpcReady', 'unqualifiedPrimitivesAccepted', 'derivative',
                        'mutationStarted', 'operationsCompleted', 'phase', 'error', 'evidence'}


def mknode(dev, ino, kind, uid, perm, size=0, mtime=1, sha=None):
    return {'dev': dev, 'ino': ino, 'mode': kind | perm, 'uid': uid, 'gid': uid, 'nlink': 2 if kind == D else 1,
            'size': size, 'mtimeNs': mtime, 'ctimeNs': mtime, 'blocks': 8, 'sha': sha, 'aclAccess': 'absent',
            'aclDefault': 'absent', 'unstable': False}


def tree():
    return {
        '/': mknode(1, 2, D, 0, 0o755),
        BASE: mknode(10, 11, D, UID, 0o755),
        BASE + '/os': mknode(10, 12, D, UID, 0o700),
        SRC: mknode(10, 100, F, UID, 0o600, 1 << 30, 5, 'd' * 64),
        BASE + '/backup': mknode(10, 13, D, UID, 0o700),
        BAK: mknode(10, 200, F, UID, 0o400, 1 << 30, 6, 'e' * 64),
        RCPT: mknode(10, 14, F, UID, 0o400, len(RECEIPT)),
        NVME: mknode(20, 2, D, UID, 0o700),
        BASE + '/offline_mask.py': mknode(10, 15, F, UID, 0o400, 1, 1, 'a' * 64),
        BASE + '/UNIT-PINS.json': mknode(10, 16, F, UID, 0o400, 2),
        BASE + '/review': mknode(10, 17, D, UID, 0o700),
        PA: mknode(10, 18, F, UID, 0o400),
        CO: mknode(10, 19, F, UID, 0o400),
    }


def pin(nodes, path):
    n = nodes[path]
    return {'path': path, 'device': n['dev'], 'inode': n['ino'], 'type': om._kind(n['mode']), 'uid': n['uid'],
            'gid': n['gid'], 'mode': stat.S_IMODE(n['mode']), 'acl': 'none'}


def access_doc(p, nodes):
    tgt = {'source': SRC, 'backup': BAK, 'destinationParent': NVME}
    return {'format': om.FORMAT_PATH_ACCESS, 'operationId': p['operationId'], 'maintenanceUid': UID,
            'capturedBy': 'synthetic-review', 'chains': {k: [pin(nodes, x) for x in om.path_chain(v)] for k, v in tgt.items()}}


def coord_doc(p):
    return {'format': om.FORMAT_COORDINATION, 'operationId': p['operationId'], 'stamp': p['stamp'],
            'vmUnits': list(p['vmUnits']), 'workflowLocks': copy.deepcopy(p['workflowLocks']),
            'lifecycleProducers': [{'name': u, 'coordination': 'plan-vm-unit-stopped', 'ref': u} for u in p['vmUnits']] +
            [{'name': 'maintenance-workflow', 'coordination': 'plan-workflow-lock', 'ref': p['workflowLocks'][0]['path']}],
            'operatorAssertions': {k: True for k in om.POLICY_TRUST},
            'sameUidActorDiscovery': 'not-performed-operator-assertion-only', 'operator': 'synthetic-operator'}


def enc(doc):
    return json.dumps(doc, sort_keys=True).encode()


def policy(pa, co):
    return {'kind': om.POLICY_KIND, 'intent': 'private-preparation-only', 'maintenanceUid': UID,
            'trust': {k: True for k in om.POLICY_TRUST}, 'authority': {k: False for k in om.POLICY_AUTHORITY},
            'hostHolderVisibility': 'incomplete-not-asserted', 'unreadableProcesses': 'retain-as-incomplete-visibility',
            'inputModes': {'source': 0o600, 'backup': 0o400},
            'evidence': {'pathAccess': {'path': PA, 'sha256': SHA(pa)}, 'coordination': {'path': CO, 'sha256': SHA(co)}}}


def setup(private=True):
    nodes, p = tree(), base_plan()
    p['backup']['receiptSha256'] = SHA(RECEIPT)
    files = {RCPT: RECEIPT, BASE + '/UNIT-PINS.json': b'{}'}
    if private:
        pa, co = enc(access_doc(p, nodes)), enc(coord_doc(p))
        files.update({PA: pa, CO: co})
        p['holderPolicy'] = policy(pa, co)
    om.validate_plan(p)
    return p, nodes, files


class Fx:
    """metadata-only fake of the effects used by execute(); every creation is exclusive like O_EXCL/mkdir"""

    def __init__(self, nodes, files, envelope, scan=None):
        self.nodes, self.files, self.envelope = nodes, files, envelope
        self.monotonic, self.time = (lambda: 0.0), (lambda: 1.0)
        self.events, self.hooks, self.next_ino, self.uid, self.fds = [], {}, 900, UID, []
        self.scan = scan or (lambda idents: ([], []))
        self.scanned, self.stream_sha, self.readback_sha = [], None, None

    def fire(self, name):
        self.events.append(name)
        fn = self.hooks.pop(name, None)      # once-only drift injection
        if fn:
            fn(self)

    def node(self, path):
        if path not in self.nodes:
            raise FileNotFoundError(errno.ENOENT, 'synthetic', path)
        return self.nodes[path]

    def lstat(self, path):
        n = self.node(path)
        return {k: n[k] for k in ('mode', 'uid', 'dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'blocks')}

    def access_meta(self, path):
        n = self.node(path)
        kind = om._kind(n['mode'])
        self.events.append('meta:' + path)
        return {'path': path, 'dev': n['dev'], 'ino': n['ino'], 'type': kind, 'uid': n['uid'], 'gid': n['gid'],
                'perm': stat.S_IMODE(n['mode']), 'nlink': n['nlink'], 'size': n['size'], 'mtimeNs': n['mtimeNs'],
                'ctimeNs': n['ctimeNs'], 'aclAccess': n['aclAccess'],
                'aclDefault': n['aclDefault'] if kind == 'directory' else 'not-applicable', 'stable': not n['unstable']}

    def euid(self):
        return self.uid

    def read_bounded(self, path, limit):
        self.node(path)
        data = self.files[path]
        if len(data) > limit:
            om.refuse('files', f'{path} exceeds {limit} bytes')
        return data

    def hash_file(self, path, deadline, phase):
        n = self.node(path)
        ident = {'dev': n['dev'], 'ino': n['ino'], 'size': n['size'], 'mtimeNs': n['mtimeNs'], 'ctimeNs': n['ctimeNs']}
        sha = n['sha']
        self.fire('hash:' + path)
        return sha, ident, dict(ident)

    def resource_scope(self):
        return dict(self.envelope)

    def lock_evidence(self, fd, path):
        return {'dev': 10, 'ino': 300, 'pathMatches': True, 'fdHoldsFlockWrite': True, 'freshTrylockBlocked': True}

    def hold_qemu_locks(self, path, ident):
        self.node(path)
        fd = 40 + len(self.fds)
        self.fds.append(fd)
        self.events.append('qlock:' + path)
        return fd

    def release(self, fd):
        self.events.append(f'release:{fd}')

    def scan_holders(self, idents):
        self.scanned.append(set(idents))
        self.events.append('scan')
        return self.scan(set(idents))

    def statvfs(self, path):
        return {'availBytes': 1 << 50, 'dev': self.node(path)['dev']}

    def _create(self, path, mode, size=0):
        if path in self.nodes:
            raise FileExistsError(errno.EEXIST, 'synthetic', path)
        parent = self.node(os.path.dirname(path))
        self.next_ino += 1
        self.nodes[path] = mknode(parent['dev'], self.next_ino, stat.S_IFMT(mode), UID, stat.S_IMODE(mode), size)
        parent['mtimeNs'] += 1; parent['ctimeNs'] += 1
        if stat.S_ISDIR(mode):
            parent['nlink'] += 1

    def write_excl(self, path, data, mode):
        self._create(path, F | mode, len(data))
        self.files[path] = bytes(data)
        self.fire('write:' + path)

    def mkdir_excl(self, path, mode):
        self._create(path, D | mode)
        self.fire('mkdir:' + path)

    def sparse_copy(self, src, ident, dst, deadline):
        self.events.append('open-ro:' + src)
        self._create(dst, F | 0o600, ident['size'])
        self.nodes[dst]['sha'] = self.readback_sha or ident['sha256']
        self.fire('copy')
        return self.stream_sha or ident['sha256']

    def read_at(self, path, offset, length):
        return b''

    def append_sync(self, path, data):
        self.events.append('append:' + path)

    def fsync_file(self, path):
        pass

    def fsync_dir(self, path):
        pass

    def chmod(self, path, mode):
        n = self.node(path)
        n['mode'] = stat.S_IFMT(n['mode']) | mode
        n['ctimeNs'] += 1
        self.fire('chmod:' + path)

    def export_fault(self, h):
        return None


class LegacyFx(Fx):
    """a default-path caller's effects: the new policy methods must never be needed"""

    @property
    def access_meta(self):
        raise AssertionError('default path used access_meta')

    @property
    def euid(self):
        raise AssertionError('default path used euid')


SB = {k: 1 for k in ('uuid', 'label', 'blockSize', 'blocksCount', 'inodesCount', 'featureCompat', 'featureIncompat',
                     'featureRoCompat', 'state')}


class FakeDbg:
    def __init__(self, stamp):
        self.stamp = stamp

    def stat(self, path):
        return {'path': path}

    def ea_list(self, path):
        return {'eaList': 'empty'}

    def cat(self, path):
        return UNIT_BYTES

    def ls(self, path):
        return [{'name': self.stamp}] if path == om.KEEP else []


class StubWriter(om.Writer):
    def tool_hashes(self):
        return {'debugfs': 'pinned-by-original-suite'}

    def vm_stopped(self):
        self.fx.events.append('vm-stopped')
        return {u: {'ActiveState': 'inactive'} for u in self.p['vmUnits']}

    def run(self, argv, cap=None):
        self.fx.events.append('run:' + os.path.basename(argv[0]))
        return 0, b'{}', b''

    def qcheck(self):
        self.fx.events.append('qcheck')
        return {'rc': 0}

    def export(self, kind):
        self.fx.fire('export:' + kind)
        return {'file': BASE + '/export-' + kind, 'kind': kind}

    def unexport(self, h):
        self.fx.events.append('unexport:' + h['kind'])

    def full_image_facts(self, dev):
        return {'diskGuid': 'g'}, {'offset': 1 << 20, 'length': 1 << 20, 'partition': {}}, ['h0', 'h1']

    def root_facts(self, dev):
        return dict(SB), FakeDbg(self.p['stamp']), {'directives': {}}

    def fsck(self, dev):
        return {'rc': 0}

    def ancestors(self, dbg):
        return {}, True, []

    def rollback_inputs(self, dbg, frag, links, keep_exists):
        return {u: {'eaList': 'empty'} for u in om.UNITS}, [], {}

    def revalidate(self, *a):
        self.fx.events.append('revalidate')
        return {}

    def guard(self, *a):
        pass

    def apply(self, dbg, op, frag):
        self.fx.fire('apply')
        self.fx.nodes[self.deriv]['sha'] = FINAL       # the derivative's content changes only through the mutation
        self.ops_done.append(op)

    def settle(self, *a):
        pass


STUB_FUNCS = {
    'validate_unit_pins': lambda data, sha: {},
    'parse_qcow2_header': lambda h, size: {'virtualSize': base_plan()['image']['virtualSize']},
    'validate_qemu_info': lambda info, im: {'virtualSize': im['virtualSize']},
    'parse_ext4_sb': lambda raw: None,
    'validate_sb': lambda sb, fs, n: {'state': 1},
    'Debugfs': lambda *a: None,
    'check_preconditions': lambda inv, frag, p: [],
    'build_ops': lambda p, links, keep: [{'op': 'synthetic'}],
    'semantic_delta': lambda base, post, links: [],
    'verify_archive': lambda a, b, c: [],
}


@contextlib.contextmanager
def patched():
    with contextlib.ExitStack() as st:
        st.enter_context(mock.patch.object(om, 'Writer', StubWriter))
        st.enter_context(mock.patch.dict(om.UNITS, {'synthetic.service': SHA(UNIT_BYTES)}, clear=True))
        for name, fn in STUB_FUNCS.items():
            st.enter_context(mock.patch.object(om, name, fn))
        yield


def run(p, nodes, files, fx_cls=Fx, hooks=None, scan=None, uid=UID, stream_sha=None, readback_sha=None):
    fx = fx_cls(nodes, files, p['resourceEnvelope'], scan)
    fx.uid, fx.stream_sha, fx.readback_sha = uid, stream_sha, readback_sha
    fx.hooks.update(hooks or {})
    with patched():
        code, out = om.operate(p, PLAN_SHA, [3], fx, p['writerSource']['path'])
    receipt = json.loads(fx.files[out['receipt']]) if code != 2 else None
    return code, out, fx, receipt


def legacy_publication_gate(r):
    """what a consumer of the DEFAULT receipt would test; a private receipt must never satisfy it"""
    return r.get('format') == om.FORMAT_RECEIPT and r.get('status') == 'READY' and r.get('publishable') is True and \
        r.get('state') == 'verified-derivative-not-activated'


def obs(**kw):
    o = {'path': BASE + '/x', 'dev': 10, 'ino': 50, 'type': 'regular', 'uid': UID, 'gid': UID, 'perm': 0o600, 'nlink': 1,
         'size': 0, 'mtimeNs': 1, 'ctimeNs': 1, 'aclAccess': 'absent', 'aclDefault': 'not-applicable', 'stable': True}
    o.update(kw)
    return o


def no_write_events(fx):
    return not any(e.startswith(('write:', 'mkdir:', 'qlock:', 'open-ro:', 'chmod:')) for e in fx.events)


# ------------------------------------------------------------------------------------------------------------ plan schema
class PolicySchemaTests(unittest.TestCase):
    def test_default_shape_unchanged_and_private_shape_valid(self):
        om.validate_plan(base_plan())
        om.validate_plan(setup()[0])
        for bad in ({'holderPolicyX': {}}, {'holderPolicy': None}, {'holderPolicy': {}}):
            p = base_plan(); p.update(bad)
            with self.assertRaises(om.Refusal, msg=str(bad)):
                om.validate_plan(p)

    def test_every_policy_declaration_is_exact(self):
        cases = {
            'unknown-key': lambda h: h.update(extra=1), 'missing-key': lambda h: h.pop('trust'),
            'kind': lambda h: h.update(kind='private-derivative-v2'), 'intent': lambda h: h.update(intent='publish'),
            'uid-root': lambda h: h.update(maintenanceUid=0), 'uid-negative': lambda h: h.update(maintenanceUid=-1),
            'uid-string': lambda h: h.update(maintenanceUid='1000'), 'uid-bool': lambda h: h.update(maintenanceUid=True),
            'uid-huge': lambda h: h.update(maintenanceUid=1 << 31),
            'visibility': lambda h: h.update(hostHolderVisibility='complete'),
            'unreadable': lambda h: h.update(unreadableProcesses='ignore'),
            'source-0644': lambda h: h['inputModes'].update(source=0o644),
            'backup-0600': lambda h: h['inputModes'].update(backup=0o600),
            'mode-bool': lambda h: h['inputModes'].update(source=True),
            'mode-extra': lambda h: h['inputModes'].update(other=0o400),
            'evidence-missing': lambda h: h['evidence'].pop('coordination'),
            'evidence-sha': lambda h: h['evidence']['pathAccess'].update(sha256='A' * 64),
            'evidence-tmp': lambda h: h['evidence']['pathAccess'].update(path='/tmp/x.json'),
            'evidence-same': lambda h: h['evidence']['coordination'].update(path=PA),
            'evidence-input': lambda h: h['evidence']['pathAccess'].update(path=SRC),
            'evidence-marker': lambda h: h['evidence']['pathAccess'].update(path=MARK),
            'evidence-in-work': lambda h: h['evidence']['pathAccess'].update(path=WORK + '/x.json'),
            'trust-truthy': lambda h: h['trust'].update(localHostRootTrusted=1),
            'trust-missing': lambda h: h['trust'].pop('maintenanceUidTrusted'),
            'authority-none': lambda h: h['authority'].update(boot=None),
        }
        for k in om.POLICY_TRUST:
            cases['trust-false-' + k] = lambda h, k=k: h['trust'].update({k: False})
        for k in om.POLICY_AUTHORITY:
            cases['authority-' + k] = lambda h, k=k: h['authority'].update({k: True})
        for name, f in cases.items():
            p = setup()[0]
            f(p['holderPolicy'])
            with self.subTest(name), self.assertRaises(om.Refusal):
                om.validate_plan(p)


# ----------------------------------------------------------------------------------------------------- evidence (pure)
class EvidenceTests(unittest.TestCase):
    def access(self, f):
        p, nodes, _ = setup()
        doc = access_doc(p, nodes)
        f(doc)
        data = enc(doc)
        return om.validate_path_access(data, SHA(data), p)

    def coord(self, f):
        p = setup()[0]
        doc = coord_doc(p)
        f(doc)
        data = enc(doc)
        return om.validate_coordination(data, SHA(data), p)

    def test_valid_evidence(self):
        self.assertEqual(self.access(lambda d: None)['chains']['source'][-1]['inode'], 100)
        self.assertEqual(self.coord(lambda d: None)['sameUidActorDiscovery'], 'not-performed-operator-assertion-only')

    def test_raw_evidence_must_match_pin_and_be_strict_json(self):
        p = setup()[0]
        for data in (b'{"format": 1, "format": 2}', b'\xff\xfe', b'not json'):
            with self.subTest(data), self.assertRaises(om.Refusal):
                om.validate_path_access(data, SHA(data), p)
        good = enc(access_doc(p, tree()))
        with self.assertRaisesRegex(om.Refusal, 'plan pin'):
            om.validate_path_access(good, '0' * 64, p)

    def test_path_access_refusals(self):
        S = lambda d: d['chains']['source']
        cases = {
            'format': lambda d: d.update(format='x'), 'operation': lambda d: d.update(operationId='other-op-0001'),
            'uid-mismatch': lambda d: d.update(maintenanceUid=1001), 'uid-bool': lambda d: d.update(maintenanceUid=True),
            'unknown-key': lambda d: d.update(extra=1), 'captured-by': lambda d: d.update(capturedBy='a b'),
            'missing-component': lambda d: S(d).pop(1), 'wrong-component': lambda d: S(d)[1].update(path='/other'),
            'missing-chain': lambda d: d['chains'].pop('backup'),
            'final-inode': lambda d: S(d)[-1].update(inode=101), 'final-device': lambda d: S(d)[-1].update(device=11),
            'foreign-owner': lambda d: S(d)[2].update(uid=1001), 'group-writable': lambda d: S(d)[2].update(mode=0o770),
            'sticky-world-writable': lambda d: S(d)[2].update(mode=0o1777),
            'acl-present': lambda d: S(d)[-1].update(acl='access:present,default:not-applicable'),
            'symlink-type': lambda d: S(d)[2].update(type='symlink'), 'source-mode': lambda d: S(d)[-1].update(mode=0o644),
            'source-root-owned': lambda d: S(d)[-1].update(uid=0),
            'no-private-dir': lambda d: S(d)[2].update(mode=0o750),
            'dest-mode': lambda d: d['chains']['destinationParent'][-1].update(mode=0o755),
            'dest-device': lambda d: d['chains']['destinationParent'][-1].update(device=21),
            'shared-inconsistent': lambda d: S(d)[1].update(gid=5), 'pin-extra-key': lambda d: S(d)[0].update(size=1),
            'shared-identity': lambda d: d['chains']['backup'][2].update(inode=12),
            'backup-mode': lambda d: d['chains']['backup'][-1].update(mode=0o600),
        }
        for name, f in cases.items():
            with self.subTest(name), self.assertRaises(om.Refusal):
                self.access(f)

    def test_coordination_refusals(self):
        cases = {
            'stamp': lambda d: d.update(stamp='20261030T120000Z-000000'),
            'operation': lambda d: d.update(operationId='other-op-0001'), 'extra': lambda d: d.update(x=1),
            'vm-order': lambda d: d['vmUnits'].reverse(), 'lock': lambda d: d['workflowLocks'][0].update(inode=301),
            'assertion-false': lambda d: d['operatorAssertions'].update(untrustedSameUidPluginsExcluded=False),
            'assertion-missing': lambda d: d['operatorAssertions'].pop('localHostRootTrusted'),
            'discovery-claim': lambda d: d.update(sameUidActorDiscovery='no-same-uid-actors-found'),
            'operator': lambda d: d.update(operator='bad operator'),
            'producer-unref': lambda d: d['lifecycleProducers'].append(
                {'name': 'x.service', 'coordination': 'plan-vm-unit-stopped', 'ref': 'other.service'}),
            'producer-kind': lambda d: d['lifecycleProducers'][0].update(coordination='assumed-quiet'),
            'producer-ref-type': lambda d: d['lifecycleProducers'][0].update(ref=['a']),
            'vm-uncovered': lambda d: d.update(lifecycleProducers=d['lifecycleProducers'][1:]),
            'producers-empty': lambda d: d.update(lifecycleProducers=[]),
        }
        for name, f in cases.items():
            with self.subTest(name), self.assertRaises(om.Refusal):
                self.coord(f)


# ------------------------------------------------------------------------------------------------- access check (pure)
class AccessCheckTests(unittest.TestCase):
    def test_valid_and_record(self):
        rec = om.check_access(obs(), UID, 'access', 'regular', 0o600)
        self.assertEqual((rec['mode'], rec['acl'], rec['nlink']), (0o600, 'none', 1))
        d = om.check_access(obs(type='directory', perm=0o700, aclDefault='absent', nlink=5), UID, 'access', 'directory')
        self.assertEqual(d['acl'], 'none')

    def test_refusals(self):
        cases = {
            'unstable': (obs(stable=False), 'regular', None, 'during observation'),
            'symlink': (obs(type='symlink', aclAccess='not-observed'), 'regular', None, 'symlink'),
            'special': (obs(type='special'), 'regular', None, 'special'),
            'foreign-owner': (obs(uid=1001), 'regular', None, 'neither root'),
            'group-write': (obs(perm=0o620), 'regular', None, 'writable'),
            'sticky-world-writable-dir': (obs(type='directory', perm=0o1777, aclDefault='absent'), 'directory', None,
                                          'no sticky-bit exception'),
            'access-acl': (obs(aclAccess='present'), 'regular', None, 'ACL'),
            'acl-unreadable': (obs(aclAccess='unreadable'), 'regular', None, 'ACL'),
            'acl-unsupported': (obs(aclAccess='unsupported'), 'regular', None, 'ACL'),
            'default-acl-dir': (obs(type='directory', perm=0o700, aclDefault='present'), 'directory', None, 'ACL'),
            'default-acl-unreadable': (obs(type='directory', perm=0o700, aclDefault='unreadable'), 'directory', None, 'ACL'),
            'two-links': (obs(nlink=2), 'regular', None, 'links'),
            'wrong-mode': (obs(perm=0o400), 'regular', 0o600, 'mode 600'),
            'root-owned-new': (obs(uid=0), 'regular', 0o600, 'maintenance-UID'),
        }
        for name, (o, want, perm, msg) in cases.items():
            with self.subTest(name), self.assertRaisesRegex(om.Refusal, msg):
                om.check_access(o, UID, 'access', want, perm)
        good = obs()
        p = {'path': good['path'], 'device': 10, 'inode': 51, 'type': 'regular', 'uid': UID, 'gid': UID, 'mode': 0o600,
             'acl': 'none'}
        with self.assertRaisesRegex(om.Refusal, r"\['inode'\]"):
            om.check_access(good, UID, 'access', 'regular', None, p)

    def test_real_access_meta_never_follows_symlinks(self):
        fx = om.OsEffects()
        with tempfile.TemporaryDirectory(prefix='rpc-private-meta-') as t:
            f, l = os.path.join(t, 'f'), os.path.join(t, 'l')
            open(f, 'xb').close()
            os.chmod(f, 0o600)
            os.symlink(f, l)
            fo, do, lo = fx.access_meta(f), fx.access_meta(t), fx.access_meta(l)
            states = ('absent', 'present', 'unsupported', 'unreadable')
            self.assertEqual((fo['type'], fo['perm'], fo['aclDefault'], fo['stable']), ('regular', 0o600, 'not-applicable', True))
            self.assertIn(fo['aclAccess'], states)
            self.assertEqual(do['type'], 'directory')
            self.assertIn(do['aclDefault'], states)
            self.assertEqual((lo['type'], lo['aclAccess']), ('symlink', 'not-observed'))
            with self.assertRaisesRegex(om.Refusal, 'not a regular'):
                om.check_access(lo, os.geteuid(), 'access', 'regular')


# --------------------------------------------------------------------------------------------------- workflow (execute)
class WorkflowTests(unittest.TestCase):
    def test_private_success_retains_real_incomplete_observation(self):
        p, nodes, files = setup()
        code, out, fx, r = run(p, nodes, files, scan=lambda idents: ([], [4343, 4242]))
        self.assertEqual(code, 0, out)
        self.assertEqual(out['status'], 'READY')                 # operate()'s unchanged stdout shape; see PRIVATE-POLICY.md
        self.assertEqual(r['format'], om.FORMAT_PRIVATE_RECEIPT)
        self.assertEqual(r['status'], 'PRIVATE-PREPARED')
        self.assertEqual(r['state'], 'private-derivative-prepared-not-activated-not-published')
        self.assertIs(r['artifactPreparedPrivately'], True)
        for k in ('publishable', 'publicationAuthorized', 'activated', 'published', 'booted', 'running', 'rpcReady'):
            self.assertIs(r[k], False, k)
        self.assertFalse(legacy_publication_gate(r))
        for when in ('before', 'after'):
            h = r['holderObservations'][when]
            self.assertEqual((h['holders'], h['unreadable'], h['unreadableCount']), ([], [4242, 4343], 2))
            self.assertEqual(h['hostVisibility'], 'incomplete-not-asserted')
            self.assertIs(h['completeHostHolderVisibility'], False)
        self.assertEqual((r['hostVisibility'], r['completeHostHolderVisibility']), ('incomplete-not-asserted', False))
        c = r['claims']
        self.assertIs(c['inputsOpenedReadOnlyByThisWriter'], True)
        self.assertIs(c['initialBackupStreamAndDerivativeReadbackEqualExpectedDigest'], True)
        self.assertIs(c['endpointInputIdentitiesTimesDigestsMatch'], True)
        self.assertEqual(c['finalDerivativeSha256RecordsResult'], FINAL)
        self.assertIn('every guest root byte compared against a precomputed expected final output', r['notClaimed'])
        self.assertEqual(r['holderPolicy']['policySha256'], om.policy_sha(p['holderPolicy']))
        self.assertEqual(r['holderPolicy']['evidence'], p['holderPolicy']['evidence'])
        ac = r['accessChecks']
        self.assertEqual(set(ac), {'preflight', 'work', 'derivative', 'mutate', 'final'})
        self.assertEqual(ac['preflight']['newNamesAbsent'], [WORK, MARK])
        self.assertEqual((ac['work']['work']['mode'], ac['work']['marker']['mode']), (0o700, 0o444))
        self.assertEqual(ac['derivative']['derivative']['mode'], 0o600)
        self.assertEqual(ac['mutate']['derivative']['mode'], 0o600)
        self.assertEqual(ac['final']['derivative']['mode'], 0o400)
        deriv = (nodes[DERIV]['dev'], nodes[DERIV]['ino'])
        self.assertEqual((ac['final']['derivative']['device'], ac['final']['derivative']['inode']), deriv)
        self.assertIn(deriv, fx.scanned[-1])
        ev = fx.events
        self.assertLess(ev.index('mkdir:' + WORK), ev.index('copy'))
        self.assertLess(ev.index('qlock:' + SRC), ev.index('copy'))
        self.assertLess(ev.index('qlock:' + BAK), ev.index('copy'))
        first_deriv_meta = ev.index('meta:' + DERIV)
        self.assertLess(ev.index('hash:' + DERIV), first_deriv_meta)
        self.assertLess(first_deriv_meta, ev.index('run:qemu-img'))
        self.assertLess(first_deriv_meta, ev.index('export:full-ro'))
        self.assertLess(max(i for i, e in enumerate(ev) if e == 'meta:' + SRC and i < ev.index('export:root-rw')),
                        ev.index('export:root-rw'))
        self.assertEqual(sorted(e for e in ev if e.startswith('release:')), ['release:40', 'release:41'])
        self.assertIn('open-ro:' + BAK, ev)
        self.assertFalse(any(e.endswith((SRC, BAK)) and e.split(':', 1)[0] in ('write', 'chmod', 'mkdir') for e in ev))
        # our own marker/work creation changed the parent's nlink/times; only security identity is pinned
        self.assertEqual(nodes[NVME]['nlink'], 3)
        self.assertGreater(nodes[NVME]['mtimeNs'], 1)

    def test_default_unreadable_refusal_unchanged(self):
        p, nodes, files = setup(private=False)
        code, out, fx, _ = run(p, nodes, files, fx_cls=LegacyFx, scan=lambda idents: ([], [7]))
        self.assertEqual(code, 2)
        self.assertEqual(out['refused']['phase'], 'holders')
        self.assertIn('unreadable processes [7]: holder scope incomplete', out['refused']['message'])
        self.assertTrue(no_write_events(fx))
        self.assertFalse(any(e.startswith('meta:') for e in fx.events))

    def test_default_success_receipt_unchanged_without_new_effects(self):
        p, nodes, files = setup(private=False)
        code, out, fx, r = run(p, nodes, files, fx_cls=LegacyFx)
        self.assertEqual(code, 0, out)
        self.assertEqual(set(r), DEFAULT_RECEIPT_KEYS)
        self.assertEqual((r['format'], r['status'], r['publishable']), (om.FORMAT_RECEIPT, 'READY', True))
        self.assertEqual(r['state'], 'verified-derivative-not-activated')
        self.assertEqual(r['evidence']['holdersBefore'], {'holders': [], 'unreadable': [],
                                                          'note': 'process scan is supplementary to QEMU and workflow locks'})
        self.assertNotIn('privateBoundary', r['evidence'])

    def test_inserted_checks_are_inert_without_policy(self):
        class Bare:
            monotonic = staticmethod(lambda: 0.0)
        w = om.Writer(base_plan(), PLAN_SHA, [3], Bare(), BASE + '/offline_mask.py')
        for ph in ('work', 'derivative', 'mutate', 'final', 'anything'):
            self.assertIsNone(w.private_check(ph, None))

    def test_known_holders_still_refuse(self):
        p, nodes, files = setup()
        code, out, fx, _ = run(p, nodes, files, scan=lambda idents: ([99], [1, 2]))
        self.assertEqual((code, out['refused']['phase']), (2, 'holders'))
        self.assertTrue(no_write_events(fx))

    def test_final_holder_on_derivative_refuses(self):
        p, nodes, files = setup()
        scan = lambda idents: ([77], []) if any(d == 20 for d, _ in idents) else ([], [5])
        code, out, fx, r = run(p, nodes, files, scan=scan)
        self.assertEqual((code, r['status'], r['error']['phase']), (3, 'FAILED', 'holders'))
        self.assertIs(r['publishable'], False)

    def test_euid_and_evidence_binding(self):
        for name, uid, mutate in (('euid-other', 1001, None), ('euid-root', 0, None),
                                  ('evidence-drift', UID, lambda f: f.update({PA: f[PA] + b' '})),
                                  ('coordination-drift', UID, lambda f: f.update({CO: f[CO].replace(b'synthetic-operator',
                                                                                                    b'other-operator')}))):
            p, nodes, files = setup()
            if mutate:
                mutate(files)
            code, out, fx, _ = run(p, nodes, files, uid=uid)
            with self.subTest(name):
                self.assertEqual((code, out['refused']['phase']), (2, 'policy'))
                self.assertTrue(no_write_events(fx))
                self.assertNotIn('scan', fx.events)

    def test_preflight_access_refusals_before_any_write_or_lock(self):
        cases = {
            'foreign-ancestor-owner': lambda n: n[BASE].update(uid=1001),
            'symlink-private-dir': lambda n: n[BASE + '/os'].update(mode=stat.S_IFLNK | 0o777),
            'sticky-world-writable-ancestor': lambda n: n[BASE].update(mode=D | 0o1777),
            'group-writable-destination': lambda n: n[NVME].update(mode=D | 0o770),
            'access-acl-backup': lambda n: n[BAK].update(aclAccess='present'),
            'default-acl-destination': lambda n: n[NVME].update(aclDefault='present'),
            'acl-unreadable-source': lambda n: n[SRC].update(aclAccess='unreadable'),
            'acl-unsupported-ancestor': lambda n: n[BASE].update(aclAccess='unsupported'),
            'source-mode-0644': lambda n: n[SRC].update(mode=F | 0o644),
            'backup-mode-0600': lambda n: n[BAK].update(mode=F | 0o600),
            'source-root-owned': lambda n: n[SRC].update(uid=0),
            'backup-two-links': lambda n: n[BAK].update(nlink=2),
            'backup-inode-replaced': lambda n: n[BAK].update(ino=201),
            'source-device-changed': lambda n: n[SRC].update(dev=11),
            'source-special-file': lambda n: n[SRC].update(mode=stat.S_IFIFO | 0o600),
            'missing-private-ancestor': lambda n: n[BASE + '/os'].update(mode=D | 0o755),
            'gid-drift': lambda n: n[BASE + '/backup'].update(gid=1001),
            'unstable-observation': lambda n: n[SRC].update(unstable=True),
            'destination-root-owned': lambda n: n[NVME].update(uid=0),
            'existing-work-dir': lambda n: n.update({WORK: mknode(20, 777, D, UID, 0o700)}),
            'existing-marker': lambda n: n.update({MARK: mknode(20, 778, F, UID, 0o444)}),
        }
        for name, f in cases.items():
            p, nodes, files = setup()
            f(nodes)
            code, out, fx, _ = run(p, nodes, files, scan=lambda idents: ([], [1]))
            with self.subTest(name):
                self.assertEqual(code, 2, out)
                self.assertEqual(out['refused']['phase'], 'access', out)
                self.assertTrue(no_write_events(fx))
                self.assertNotIn('scan', fx.events)

    def assert_failed_before(self, r, fx, absent, phase='access'):
        self.assertEqual((r['status'], r['error']['phase']), ('FAILED', phase), r['error'])
        self.assertIs(r['artifactPreparedPrivately'], False)
        self.assertIs(r['publishable'], False)
        self.assertIs(r['mutationStarted'], False)
        self.assertEqual(r['operationsCompleted'], [])
        for e in absent:
            self.assertNotIn(e, fx.events)
        self.assertEqual(sorted(e for e in fx.events if e.startswith('release:')), ['release:40', 'release:41'])

    def test_new_work_dir_and_marker_checked_before_copy(self):
        cases = {
            'work-access-acl': lambda fx: fx.nodes[WORK].update(aclAccess='present'),
            'work-default-acl': lambda fx: fx.nodes[WORK].update(aclDefault='present'),
            'work-mode-0750': lambda fx: fx.nodes[WORK].update(mode=D | 0o750),
            'work-root-owned': lambda fx: fx.nodes[WORK].update(uid=0),
            'work-reuses-pinned-identity': lambda fx: fx.nodes[WORK].update(dev=20, ino=2),
            'marker-mode': lambda fx: fx.nodes[MARK].update(mode=F | 0o644),
            'marker-foreign': lambda fx: fx.files.update({MARK: b'{"operationId": "other-op-0001"}'}),
            'parent-mode-drift': lambda fx: fx.nodes[NVME].update(mode=D | 0o750),
            'parent-acl-drift': lambda fx: fx.nodes[NVME].update(aclDefault='present'),
            'backup-dir-drift': lambda fx: fx.nodes[BASE + '/backup'].update(aclAccess='present'),
        }
        for name, hook in cases.items():
            p, nodes, files = setup()
            code, out, fx, r = run(p, nodes, files, hooks={'mkdir:' + WORK: hook})
            with self.subTest(name):
                self.assertEqual(code, 3, out)
                self.assert_failed_before(r, fx, ('copy', 'open-ro:' + BAK))

    def test_new_derivative_checked_before_qemu_img_or_export(self):
        replace_after_readback = lambda fx: fx.nodes[DERIV].update(ino=6000)
        cases = {
            'mode-0644': ('copy', lambda fx: fx.nodes[DERIV].update(mode=F | 0o644)),
            'access-acl': ('copy', lambda fx: fx.nodes[DERIV].update(aclAccess='present')),
            'acl-unreadable': ('copy', lambda fx: fx.nodes[DERIV].update(aclAccess='unreadable')),
            'root-owned': ('copy', lambda fx: fx.nodes[DERIV].update(uid=0)),
            'unstable': ('copy', lambda fx: fx.nodes[DERIV].update(unstable=True)),
            'work-replaced': ('copy', lambda fx: fx.nodes[WORK].update(ino=5000)),
            'replaced-after-readback': ('hash:' + DERIV, replace_after_readback),
        }
        for name, (event, hook) in cases.items():
            p, nodes, files = setup()
            code, out, fx, r = run(p, nodes, files, hooks={event: hook})
            with self.subTest(name):
                self.assertEqual(code, 3, out)
                self.assert_failed_before(r, fx, ('run:qemu-img', 'export:full-ro'))

    def test_digest_semantics_unchanged(self):
        for name, kw, msg in (('stream', {'stream_sha': '1' * 64}, 'backup stream hash differs'),
                              ('readback', {'readback_sha': '2' * 64}, 'derivative initial full hash differs')):
            p, nodes, files = setup()
            code, out, fx, r = run(p, nodes, files, **kw)
            with self.subTest(name):
                self.assertEqual(code, 3)
                self.assertIn(msg, r['error']['message'])
                self.assert_failed_before(r, fx, ('export:full-ro',), phase='copy')
                self.assertIs(r['claims']['initialBackupStreamAndDerivativeReadbackEqualExpectedDigest'], False)

    def test_drift_before_writable_export_refuses_before_mutation(self):
        cases = {
            'derivative-mode': lambda fx: fx.nodes[DERIV].update(mode=F | 0o644),
            'derivative-acl': lambda fx: fx.nodes[DERIV].update(aclAccess='present'),
            'work-mode': lambda fx: fx.nodes[WORK].update(mode=D | 0o750),
            'backup-dir-mode': lambda fx: fx.nodes[BASE + '/backup'].update(mode=D | 0o750),
            'source-acl': lambda fx: fx.nodes[SRC].update(aclAccess='present'),
            'destination-default-acl': lambda fx: fx.nodes[NVME].update(aclDefault='present'),
            'ancestor-owner': lambda fx: fx.nodes[BASE].update(uid=1001),
        }
        for name, hook in cases.items():
            p, nodes, files = setup()
            code, out, fx, r = run(p, nodes, files, hooks={'export:root-ro': hook})
            with self.subTest(name):
                self.assertEqual(code, 3, out)
                self.assert_failed_before(r, fx, ('export:root-rw', 'apply', 'revalidate'))
                self.assertIn('export:full-ro', fx.events)

    def test_final_requires_0400_and_unchanged_identity(self):
        cases = {
            'mode-0440': lambda fx: fx.nodes[DERIV].update(mode=F | 0o440),
            'acl': lambda fx: fx.nodes[DERIV].update(aclAccess='present'),
            'replaced': lambda fx: fx.nodes[DERIV].update(ino=7000),
            'source-dir-acl': lambda fx: fx.nodes[BASE + '/os'].update(aclDefault='present'),
        }
        for name, hook in cases.items():
            p, nodes, files = setup()
            code, out, fx, r = run(p, nodes, files, hooks={'chmod:' + DERIV: hook})
            with self.subTest(name):
                self.assertEqual((code, r['status'], r['error']['phase']), (3, 'FAILED', 'access'))
                self.assertIs(r['mutationStarted'], True)
                self.assertIs(r['publishable'], False)
                self.assertIs(r['artifactPreparedPrivately'], False)

    def test_cancellation_reaches_unchanged_cleanup(self):
        def cancel(fx):
            raise om.Refusal('cancelled', 'signal 15')
        p, nodes, files = setup()
        code, out, fx, r = run(p, nodes, files, hooks={'export:full-ro': cancel})
        self.assertEqual((code, r['status'], r['error']['phase']), (3, 'FAILED', 'cancelled'))
        self.assertEqual(sorted(e for e in fx.events if e.startswith('release:')), ['release:40', 'release:41'])
        self.assertIs(r['publishable'], False)


# ----------------------------------------------------------------------------------------------- preserved source shape
class SourceShapeTests(unittest.TestCase):
    def test_inserted_checks_positions(self):
        body = ast.parse(textwrap.dedent(inspect.getsource(om.Writer.execute))).body[0].body
        txt = [ast.unparse(s) for s in body]
        idx = lambda frag: next(i for i, t in enumerate(txt) if frag in t)
        self.assertEqual(sum(t.startswith('self.private_check(') for t in txt), 3)
        self.assertGreater(idx("self.private_check('work'"), idx('fx.mkdir_excl('))
        self.assertLess(idx("self.private_check('work'"), idx('fx.sparse_copy('))
        self.assertGreater(idx("self.private_check('derivative'"), idx('backup changed during copy'))
        self.assertLess(idx("self.private_check('derivative'"), idx("self.phase = 'qcow2'"))
        self.assertEqual(idx("self.private_check('mutate'") + 1, idx("self.export('root-rw')"))

    def test_read_only_inputs_exclusive_creation_and_native_locks_delegated(self):
        copy_src = inspect.getsource(om.OsEffects.sparse_copy)
        self.assertIn('os.open(src, os.O_RDONLY | os.O_NOFOLLOW', copy_src)
        self.assertIn('os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW', copy_src)
        locks = inspect.getsource(om.OsEffects.hold_qemu_locks)
        self.assertIn('os.O_RDONLY', locks)
        self.assertIn('F_OFD_SETLK', locks)
        self.assertIn('os.mkdir(path, mode)', inspect.getsource(om.OsEffects.mkdir_excl))
        self.assertIn('os.O_RDONLY', inspect.getsource(om.OsEffects.hash_file))


if __name__ == '__main__':
    unittest.main()
