#!/usr/bin/python3 -I
"""offline_mask.py: OFFLINE mask of the exact eight unsafe autostart units on ONE NEW standalone qcow2 derivative of an
exact verified OS backup.  SOURCE ONLY; root reviews it and runs it later under its own admission.

Operator entry point (no defaults, no production path compiled in):
    /usr/bin/python3 -I offline_mask.py --plan /abs/plan.json --plan-sha256 <hex> --lock-fd N [--lock-fd M ...]
The plan (format enclave-rpc-offline-mask-plan/1, see validate_plan) carries every fresh identity root captured: writer and
UNIT-PINS hashes, tool paths/hashes, source and backup identity + full sha256, destination filesystem/floor/margins, GPT and
ext4 identity, fragment metadata, VM units, caller-held workflow locks, resource envelope, time/output bounds and the explicit
list of primitives accepted although the synthetic fixture did not exercise them (UNQUALIFIED).

Workflow (each phase fails closed; nothing is repaired, retried, renamed onto, or promoted):
  preflight -> copy (exclusive, sparse, full hash == backup) -> qcow2 header/info/check -> read-only full-image GPT ->
  read-only root slice (superblock, e2fsck -f -n, inventory, preconditions) -> rollback receipt -> writable root slice
  (debugfs ln/unlink/symlink/rm, each verified) -> fresh read-only root slice (fsck, inventory delta, archive) -> fresh
  read-only full image (GPT + outside-root bytes unchanged) -> qemu-img check, fsync, final hash -> source/backup unchanged
  -> immutable RESULT.json (READY = verified-derivative-not-activated, or FAILED = nonpublishable).
Importing this module performs no I/O, no subprocess and no argv handling.
"""
import errno, fcntl, hashlib, json, os, re, selectors, signal, stat, struct, subprocess, sys, threading, time, uuid, zlib

FORMAT_PLAN = 'enclave-rpc-offline-mask-plan/1'
FORMAT_RECEIPT = 'enclave-rpc-offline-mask-receipt/1'
FORMAT_ROLLBACK = 'enclave-rpc-offline-mask-rollback/1'
UNIT_PINS_KIND = 'offline-mask-unit-pins/1'
UNITS = {
    'enclave-rpc-base-snapshot.service': 'f7a193f1f50ab147aa15d33cb7de9fbddc1ad0c01c244ffef852b417551950f4',
    'enclave-rpc-l1-snapshot.service': '42cfc951d82ff4996460a4d180a9d6b91257d1bdfbee76e23c755d7e1e267070',
    'enclave-base-retention.service': 'f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee',
    'enclave-base-holder.path': '8accb496663c590e2a52a83cd73815d42a81d994b430dde96d17df1e56bf4329',
    'enclave-base-holder.service': '3d305f2ef091af5ee7edec61bcd47607c7e969e64873dec66d021db34f5955ef',
    'enclave-l1-el.path': 'd2b379983fb5b5d6a442aef9ec7738e7f09641a2166353227d214ef1579656e3',
    'enclave-l1-el.service': 'be00a7d9542f79515658f09d49bc3ad546d3d80de3f30a531a4ee5d1fd72086d',
    'enclave-l1-cl.service': '54791e1a9ac7e27d4e12ce7630d903363ba1069f9fb3529acade709a4a8bb547',
}
TOOL_PINS = {   # native-tool-pins.json (root's metadata hashing); systemctl is pinned only by the plan
    'nbdfuse': ('/usr/bin/nbdfuse', '51c1a1fd18785d4fe2240c1710eb4f78590b9d333fcde4cda421871d6f010a01'),
    'qemu-nbd': ('/usr/bin/qemu-nbd', 'b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934'),
    'qemu-img': ('/usr/bin/qemu-img', '3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30'),
    'debugfs': ('/usr/bin/debugfs', '9b27184084383c8607eee03b43c80eca4ef912acf4887b40a7cc420e267ad8a8'),
    'e2fsck': ('/usr/bin/e2fsck', 'a9ea133a844edd695b5172abadc8bbbbb03aaedad80fc24d039bdbf4563a125c'),
    'fusermount3': ('/usr/bin/fusermount3', 'c3d04bdf77c7152eba94ce670338e7089730b8dbfede57762b7b92c893a00f4f'),
}
PLAN_TOOLS = tuple(TOOL_PINS) + ('systemctl',)
# Used here but NOT exercised by root's synthetic fixture; the plan must list every id in acceptUnqualified or nothing runs.
UNQUALIFIED = {
    'readonly-export': 'nbdfuse -r [ qemu-nbd -r ... ] (fixture exported writable only; -r is the old reader shape)',
    'full-image-export': 'nbdfuse -r [ qemu-nbd -r -f qcow2 <derivative> ] for GPT/outside-root reads',
    'qemu-img-info': 'qemu-img info --output=json -f qcow2 (format/backing/data-file/virtual size)',
    'debugfs-mkdir-sif': 'debugfs -w mkdir + sif <dir> mode 040700 on the export (fixture mkdir ran on the raw file)',
    'debugfs-stat-parse': 'parsing Type/Mode/User/Group/Size/timestamps/xattr names from debugfs stat',
    'qemu-lock-bytes': 'OFD probe of QEMU lock bytes 100-299 and deny-WRITE/RESIZE holds (201, 203) on source/backup',
    'ext4-sb-crc32c': 'superblock crc32c check when metadata_csum is set',
    'systemctl-user-show': 'systemctl --user show (read-only) for VM/guard state',
}
ETC, USR, LIB, KEEP = '/etc/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system', '/var/lib/enclave-rpc-maint'
LINK_DIR = re.compile(r'\.(wants|requires|upholds)$')
TYPE_DROPINS = ('service.d', 'path.d', 'timer.d', 'socket.d', 'mount.d', 'target.d')
DIRECTIVE = re.compile(r'^(Unit|Path\w+|On\w+|Persistent|Wants|Requires|Requisite|BindsTo|PartOf|Upholds|WantedBy|RequiredBy|'
                       r'UpheldBy|Also|Alias|Condition\w+|Assert\w+|RequiresMountsFor|DefaultDependencies)=')
SAFE_PATH = re.compile(r'/[A-Za-z0-9._/-]{1,1024}')        # no ',', '=', ':', '[', ']', space: safe in image-opts/argv
GUEST_PATH = re.compile(r'/[A-Za-z0-9._@/-]{1,255}')       # one debugfs request token
STAMP = re.compile(r'\d{8}T\d{6}Z-[0-9a-f]{6}')
OPID = re.compile(r'[a-z0-9][a-z0-9-]{7,63}')
SHA = re.compile(r'[0-9a-f]{64}')
BANNER = re.compile(r'debugfs \d+\.\d+(\.\d+)?(-\S+)? \([^()]{1,40}\)')
LS_P = re.compile(r'/(\d+)/([0-7]+)/(\d+)/(\d+)/(.*)/(\d*)/')
FORBIDDEN_ROOTS = ('/tmp', '/var/tmp', '/dev', '/proc', '/sys', '/run')
CHILD_ENV = {'PATH': '/usr/bin', 'LANG': 'C', 'LC_ALL': 'C', 'DEBUGFS_PAGER': '__none__', 'PAGER': '__none__'}
CHUNK = 4 << 20
EXT4_SUPPORTED_INCOMPAT = 0x2 | 0x40 | 0x80 | 0x200 | 0x2000      # filetype extent 64bit flex_bg csum_seed
EXT4_SUPPORTED_RO_COMPAT = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x40 | 0x400  # sparse large_file huge gdt_csum dir_nlink isize mcsum


class Refusal(Exception):
    def __init__(self, phase, msg):
        super().__init__(f'{phase}: {msg}'[:1000])
        self.phase = phase


def refuse(phase, msg):
    raise Refusal(phase, msg)


class Deadline:
    probe = None        # Writer installs its exporter-fault check: every bounded hash/command/wait step observes it

    def __init__(self, seconds, clock):
        self.clock, self.end = clock, clock() + seconds

    def left(self, phase, cap):
        if self.probe is not None:
            self.probe()
        rem = self.end - self.clock()
        if rem <= 0:
            refuse(phase, 'total operation deadline exceeded')
        return min(rem, cap)


# ----------------------------------------------------------------------------------------------------------- plan (pure)
def _no_dupes(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError(f'duplicate key {k!r}')
        d[k] = v
    return d


def _obj(v, keys, name):
    if not isinstance(v, dict) or set(v) != set(keys):
        refuse('plan', f'{name} must have exactly keys {sorted(keys)}')
    return v


def _int(v, name, lo=0, hi=1 << 62):
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        refuse('plan', f'{name} must be an integer in [{lo}, {hi}]')
    return v


def _sha(v, name):
    if not isinstance(v, str) or not SHA.fullmatch(v):
        refuse('plan', f'{name} must be a lowercase sha256')
    return v


def safe_path(v, name, forbid=FORBIDDEN_ROOTS):
    if not isinstance(v, str) or not SAFE_PATH.fullmatch(v) or os.path.normpath(v) != v or v == '/':
        refuse('plan', f'{name} is not a safe normalized absolute path')
    if any(c in ('.', '..') for c in v.split('/')[1:]):
        refuse('plan', f'{name} has dot components')
    if any(v == r or v.startswith(r + '/') for r in forbid):
        refuse('plan', f'{name} is under a forbidden root')
    return v


def _guid(v, name):
    try:
        if str(uuid.UUID(v)) != v:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        refuse('plan', f'{name} must be a lowercase canonical GUID')
    return v


def validate_plan(p):
    top = ('format', 'operationId', 'stamp', 'writerSource', 'unitPins', 'tools', 'source', 'backup', 'destination', 'image',
           'filesystem', 'fragments', 'usrMerge', 'vmUnits', 'workflowLocks', 'resourceEnvelope', 'bounds', 'acceptUnqualified')
    _obj(p, top + (('holderPolicy',) if isinstance(p, dict) and 'holderPolicy' in p else ()), 'plan')
    if p['format'] != FORMAT_PLAN:
        refuse('plan', 'wrong format')
    if not isinstance(p['operationId'], str) or not OPID.fullmatch(p['operationId']):
        refuse('plan', 'operationId')
    if not isinstance(p['stamp'], str) or not STAMP.fullmatch(p['stamp']):
        refuse('plan', 'stamp')
    for k in ('writerSource', 'unitPins'):
        _obj(p[k], ('path', 'sha256'), k)
        safe_path(p[k]['path'], k + '.path', ('/tmp', '/var/tmp', '/dev', '/proc', '/sys'))
        _sha(p[k]['sha256'], k + '.sha256')
    _obj(p['tools'], PLAN_TOOLS, 'tools')
    for name, t in p['tools'].items():
        _obj(t, ('path', 'sha256'), f'tools.{name}')
        if name in TOOL_PINS and (t['path'], t['sha256']) != TOOL_PINS[name]:
            refuse('plan', f'tools.{name} differs from the pinned native tool')
        if name == 'systemctl' and t['path'] != '/usr/bin/systemctl':
            refuse('plan', 'tools.systemctl must be /usr/bin/systemctl')
        _sha(t['sha256'], f'tools.{name}.sha256')
    ident = ('path', 'sha256', 'device', 'inode', 'size', 'mtimeNs')
    _obj(p['source'], ident, 'source')
    _obj(p['backup'], ident + ('receiptPath', 'receiptSha256'), 'backup')
    for k in ('source', 'backup'):
        safe_path(p[k]['path'], k + '.path')
        _sha(p[k]['sha256'], k + '.sha256')
        for f in ('device', 'inode', 'size', 'mtimeNs'):
            _int(p[k][f], f'{k}.{f}', 1 if f != 'mtimeNs' else 0)
    safe_path(p['backup']['receiptPath'], 'backup.receiptPath')
    _sha(p['backup']['receiptSha256'], 'backup.receiptSha256')
    if p['source']['path'] == p['backup']['path'] or \
            (p['source']['device'], p['source']['inode']) == (p['backup']['device'], p['backup']['inode']):
        refuse('plan', 'source and backup are not distinct identities')
    d = _obj(p['destination'], ('parentDir', 'workDirName', 'device', 'forbiddenDevices', 'floorBytes',
                                'evidenceMarginBytes', 'workingMarginBytes', 'qcowMetadataAllowanceBytes'), 'destination')
    safe_path(d['parentDir'], 'destination.parentDir')
    if not isinstance(d['workDirName'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', d['workDirName']):
        refuse('plan', 'destination.workDirName')
    _int(d['device'], 'destination.device', 1)
    if not isinstance(d['forbiddenDevices'], list) or len(d['forbiddenDevices']) < 1:
        refuse('plan', 'destination.forbiddenDevices must list at least the root and /tmp filesystems')
    for i, v in enumerate(d['forbiddenDevices']):
        _int(v, f'destination.forbiddenDevices[{i}]', 1)
    if d['device'] in d['forbiddenDevices']:
        refuse('plan', 'destination device is a forbidden (root//tmp) filesystem')
    for f in ('floorBytes', 'evidenceMarginBytes', 'workingMarginBytes', 'qcowMetadataAllowanceBytes'):
        _int(d[f], f'destination.{f}', 1)
    for k in ('source', 'backup'):
        if os.path.dirname(p[k]['path']) == os.path.join(d['parentDir'], d['workDirName']):
            refuse('plan', f'{k} lies inside the new work directory')
    im = _obj(p['image'], ('virtualSize', 'sectorSize', 'diskGuid', 'rootIndex', 'rootTypeGuid', 'rootUniqueGuid',
                           'rootFirstLba', 'rootLastLba'), 'image')
    _int(im['sectorSize'], 'image.sectorSize', 512, 4096)
    if im['sectorSize'] not in (512, 4096):
        refuse('plan', 'image.sectorSize')
    _int(im['virtualSize'], 'image.virtualSize', 1 << 20)
    if im['virtualSize'] % im['sectorSize']:
        refuse('plan', 'image.virtualSize not a sector multiple')
    _int(im['rootIndex'], 'image.rootIndex', 1, 1024)
    for g in ('diskGuid', 'rootTypeGuid', 'rootUniqueGuid'):
        _guid(im[g], 'image.' + g)
    _int(im['rootFirstLba'], 'image.rootFirstLba', 34)
    _int(im['rootLastLba'], 'image.rootLastLba', im['rootFirstLba'])
    if (im['rootLastLba'] + 1) * im['sectorSize'] > im['virtualSize']:
        refuse('plan', 'root partition exceeds the virtual size')
    fs = _obj(p['filesystem'], ('uuid', 'label', 'blockSize', 'blocksCount', 'inodesCount', 'featureCompat',
                                'featureIncompat', 'featureRoCompat'), 'filesystem')
    _guid(fs['uuid'], 'filesystem.uuid')
    if not isinstance(fs['label'], str) or not 0 < len(fs['label'].encode()) <= 16:
        refuse('plan', 'filesystem.label')
    if fs['blockSize'] not in (1024, 2048, 4096, 65536):
        refuse('plan', 'filesystem.blockSize')
    for f in ('blocksCount', 'inodesCount'):
        _int(fs[f], 'filesystem.' + f, 1)
    for f in ('featureCompat', 'featureIncompat', 'featureRoCompat'):
        _int(fs[f], 'filesystem.' + f, 0, 0xffffffff)
    if fs['blocksCount'] * fs['blockSize'] > (im['rootLastLba'] - im['rootFirstLba'] + 1) * im['sectorSize']:
        refuse('plan', 'filesystem larger than the root partition')
    fr = _obj(p['fragments'], ('mode', 'uid', 'gid', 'xattrNames', 'inodes'), 'fragments')
    _int(fr['mode'], 'fragments.mode', 0, 0o7777)
    if fr['mode'] & 0o022:
        refuse('plan', 'fragments.mode must not be group/world writable')
    _int(fr['uid'], 'fragments.uid'); _int(fr['gid'], 'fragments.gid')
    if not isinstance(fr['xattrNames'], list) or not all(isinstance(x, str) for x in fr['xattrNames']):
        refuse('plan', 'fragments.xattrNames')
    if not isinstance(fr['inodes'], dict) or not set(fr['inodes']) <= set(UNITS):
        refuse('plan', 'fragments.inodes keys must be pinned unit names')
    for u, n in fr['inodes'].items():
        _int(n, f'fragments.inodes.{u}', 11)
    if not isinstance(p['usrMerge'], bool):
        refuse('plan', 'usrMerge must be boolean')
    if not isinstance(p['vmUnits'], list) or len(p['vmUnits']) < 2 or \
            not all(isinstance(u, str) and re.fullmatch(r'[A-Za-z0-9@._-]+\.service', u) for u in p['vmUnits']):
        refuse('plan', 'vmUnits must name the exact VM and guard services')
    if not isinstance(p['workflowLocks'], list) or not p['workflowLocks']:
        refuse('plan', 'workflowLocks must name the caller-held workflow lock(s)')
    for i, lk in enumerate(p['workflowLocks']):
        _obj(lk, ('path', 'device', 'inode'), f'workflowLocks[{i}]')
        safe_path(lk['path'], f'workflowLocks[{i}].path', ('/tmp', '/var/tmp', '/dev', '/proc', '/sys'))
        _int(lk['device'], 'lock.device', 1); _int(lk['inode'], 'lock.inode', 1)
    re_ = _obj(p['resourceEnvelope'], ('cgroup', 'memoryMax', 'swapMax'), 'resourceEnvelope')
    if not all(isinstance(v, str) and v for v in re_.values()):
        refuse('plan', 'resourceEnvelope values must be the exact strings root admitted')
    b = _obj(p['bounds'], ('totalSeconds', 'commandSeconds', 'fsckSeconds', 'exportStartSeconds', 'exportStopSeconds',
                           'maxOutputBytes', 'maxLogBytes', 'maxInventoryEntries'), 'bounds')
    for f in ('totalSeconds', 'commandSeconds', 'fsckSeconds', 'exportStartSeconds', 'exportStopSeconds'):
        _int(b[f], 'bounds.' + f, 1, 7 * 86400)
    _int(b['maxOutputBytes'], 'bounds.maxOutputBytes', 4096, 64 << 20)
    _int(b['maxLogBytes'], 'bounds.maxLogBytes', 4096, 256 << 20)
    _int(b['maxInventoryEntries'], 'bounds.maxInventoryEntries', 16, 100000)
    if not isinstance(p['acceptUnqualified'], list) or sorted(p['acceptUnqualified']) != sorted(UNQUALIFIED):
        refuse('plan', f'acceptUnqualified must list exactly {sorted(UNQUALIFIED)} after root review')
    if 'holderPolicy' in p:
        validate_holder_policy(p)
    return p


def load_plan(data, digest):
    if not isinstance(digest, str) or not SHA.fullmatch(digest):
        refuse('plan', 'digest must be 64 lowercase hex')
    got = hashlib.sha256(data).hexdigest()
    if got != digest:
        refuse('plan', f'plan sha256 {got} is not the reviewed {digest}')
    try:
        plan = json.loads(data.decode('utf-8'), object_pairs_hook=_no_dupes)
    except (UnicodeDecodeError, ValueError) as e:
        refuse('plan', f'invalid JSON: {e}')
    return validate_plan(plan)


def validate_unit_pins(data, sha):
    if hashlib.sha256(data).hexdigest() != sha:
        refuse('pins', 'UNIT-PINS.json hash differs from the plan')
    try:
        pins = json.loads(data.decode('utf-8'), object_pairs_hook=_no_dupes)
    except (UnicodeDecodeError, ValueError) as e:
        refuse('pins', f'UNIT-PINS.json invalid: {e}')
    if not isinstance(pins, dict) or pins.get('kind') != UNIT_PINS_KIND or pins.get('units') != UNITS:
        refuse('pins', 'UNIT-PINS.json units are not exactly the eight compiled pins')
    return pins


# ------------------------------------------------------------------- private-derivative holder policy (pure, opt-in only)
# Selected only by an explicit, hash-pinned plan['holderPolicy']; without it nothing below runs and the default global
# holder refusal is exactly the reviewed one.  The boundary TRUSTS local root and the maintenance UID by explicit operator
# declaration: it checks current DAC/ACL metadata and identities, it does not exclude hostile root/same-UID actors, ptrace,
# descriptor transfer or descriptors opened before the checks, and it never authorizes boot, publication or replacement.
POLICY_KIND = 'private-derivative-v1'
FORMAT_PATH_ACCESS = 'enclave-rpc-private-path-access/1'
FORMAT_COORDINATION = 'enclave-rpc-private-coordination/1'
FORMAT_PRIVATE_RECEIPT = 'enclave-rpc-offline-mask-private-receipt/1'
POLICY_TRUST = ('localHostRootTrusted', 'maintenanceUidTrusted', 'untrustedSameUidCommandsExcluded',
                'untrustedSameUidPluginsExcluded', 'noCompetingWriterOrPublicationDuringPreparation')
POLICY_AUTHORITY = ('boot', 'publication', 'replaceExistingBacking', 'sourceWrite', 'destructiveRepair', 'custody')
POLICY_INPUT_MODES = {'source': (0o600, 0o400), 'backup': (0o400,)}
CHAIN_KEYS = ('source', 'backup', 'destinationParent')
PIN_KEYS = ('path', 'device', 'inode', 'type', 'uid', 'gid', 'mode', 'acl')
EVIDENCE_LIMITS = {'pathAccess': 1 << 20, 'coordination': 1 << 16}
PRODUCER_COORDINATION = ('plan-vm-unit-stopped', 'plan-workflow-lock')
OPERATOR = re.compile(r'[A-Za-z0-9][A-Za-z0-9._@-]{0,99}')
UID_MAX = (1 << 31) - 2
MAX_CHAIN = 64


def policy_sha(hp):
    return hashlib.sha256(json.dumps(hp, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_holder_policy(p):
    """plan['holderPolicy']: the only accepted alternative to the default refusal; every declaration exact"""
    hp = _obj(p['holderPolicy'], ('kind', 'intent', 'maintenanceUid', 'trust', 'authority', 'hostHolderVisibility',
                                  'unreadableProcesses', 'inputModes', 'evidence'), 'holderPolicy')
    if hp['kind'] != POLICY_KIND:
        refuse('plan', f'holderPolicy.kind must be {POLICY_KIND!r} (unsupported policy)')
    if hp['intent'] != 'private-preparation-only':
        refuse('plan', "holderPolicy.intent must be 'private-preparation-only'")
    _int(hp['maintenanceUid'], 'holderPolicy.maintenanceUid (non-root)', 1, UID_MAX)
    _obj(hp['trust'], POLICY_TRUST, 'holderPolicy.trust')
    if not all(hp['trust'][k] is True for k in POLICY_TRUST):
        refuse('plan', 'holderPolicy.trust: every explicit trust/exclusion declaration must be literally true')
    _obj(hp['authority'], POLICY_AUTHORITY, 'holderPolicy.authority')
    if not all(hp['authority'][k] is False for k in POLICY_AUTHORITY):
        refuse('plan', 'holderPolicy.authority: private preparation grants no boot/publication/replace/write/repair/custody')
    if hp['hostHolderVisibility'] != 'incomplete-not-asserted':
        refuse('plan', "holderPolicy.hostHolderVisibility must be 'incomplete-not-asserted'")
    if hp['unreadableProcesses'] != 'retain-as-incomplete-visibility':
        refuse('plan', "holderPolicy.unreadableProcesses must be 'retain-as-incomplete-visibility'")
    modes = _obj(hp['inputModes'], tuple(POLICY_INPUT_MODES), 'holderPolicy.inputModes')
    for k, allowed in POLICY_INPUT_MODES.items():
        if not isinstance(modes[k], int) or isinstance(modes[k], bool) or modes[k] not in allowed:
            refuse('plan', f'holderPolicy.inputModes.{k} must be one of {[oct(m) for m in allowed]}')
    ev = _obj(hp['evidence'], ('pathAccess', 'coordination'), 'holderPolicy.evidence')
    for k in ('pathAccess', 'coordination'):
        _obj(ev[k], ('path', 'sha256'), f'holderPolicy.evidence.{k}')
        safe_path(ev[k]['path'], f'holderPolicy.evidence.{k}.path')
        _sha(ev[k]['sha256'], f'holderPolicy.evidence.{k}.sha256')
    paths = {ev[k]['path'] for k in ('pathAccess', 'coordination')}
    d = p['destination']
    work = os.path.join(d['parentDir'], d['workDirName'])
    if len(paths) != 2 or paths & {p['source']['path'], p['backup']['path'], p['backup']['receiptPath'], work + '.operation'} \
            or any(x.startswith(work + '/') for x in paths):
        refuse('plan', 'holderPolicy evidence paths must be two distinct reviewed files outside the inputs and work dir')
    return hp


def path_chain(path):
    """'/a/b' -> ['/', '/a', '/a/b']: every component from / including the final one"""
    parts = path.split('/')[1:]
    return ['/'] + ['/' + '/'.join(parts[:i + 1]) for i in range(len(parts))]


def _evidence_json(data, sha, name):
    if not isinstance(data, bytes) or hashlib.sha256(data).hexdigest() != sha:
        refuse('policy', f'{name} evidence sha256 is not the plan pin')
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_no_dupes)
    except (UnicodeDecodeError, ValueError) as e:
        refuse('policy', f'{name} evidence is not strict JSON: {str(e)[:200]}')


def validate_path_access(data, sha, p):
    """reviewed expected security identity pins for every component of source, backup and destination parent; the pins
    themselves must satisfy the boundary, so a pin can never admit a weaker observation"""
    hp, d = p['holderPolicy'], p['destination']
    ev = _obj(_evidence_json(data, sha, 'pathAccess'), ('format', 'operationId', 'maintenanceUid', 'capturedBy', 'chains'),
              'pathAccess')
    if ev['format'] != FORMAT_PATH_ACCESS or ev['operationId'] != p['operationId']:
        refuse('policy', 'pathAccess evidence is not bound to this operation')
    _int(ev['maintenanceUid'], 'pathAccess.maintenanceUid', 1, UID_MAX)
    if ev['maintenanceUid'] != hp['maintenanceUid']:
        refuse('policy', 'pathAccess maintenance UID differs from the plan policy')
    if not isinstance(ev['capturedBy'], str) or not OPERATOR.fullmatch(ev['capturedBy']):
        refuse('policy', 'pathAccess.capturedBy')
    chains = _obj(ev['chains'], CHAIN_KEYS, 'pathAccess.chains')
    target = {'source': p['source']['path'], 'backup': p['backup']['path'], 'destinationParent': d['parentDir']}
    uid, shared = hp['maintenanceUid'], {}
    for key in CHAIN_KEYS:
        chain, want = chains[key], path_chain(target[key])
        if not isinstance(chain, list) or len(chain) != len(want) or len(chain) > MAX_CHAIN:
            refuse('policy', f'{key} chain must pin exactly {len(want)} components from /')
        for i, pin in enumerate(chain):
            name = f'pathAccess.chains.{key}[{i}]'
            _obj(pin, PIN_KEYS, name)
            if pin['path'] != want[i]:
                refuse('policy', f'{name} is not {want[i]}')
            _int(pin['device'], name + '.device', 1); _int(pin['inode'], name + '.inode', 1)
            _int(pin['uid'], name + '.uid', 0, UID_MAX); _int(pin['gid'], name + '.gid', 0, UID_MAX)
            _int(pin['mode'], name + '.mode', 0, 0o7777)
            kind = 'regular' if i == len(chain) - 1 and key != 'destinationParent' else 'directory'
            if pin['type'] != kind:
                refuse('policy', f'{name} type must be {kind}')
            if pin['uid'] not in (0, uid):
                refuse('policy', f'{name} owner is neither root nor the maintenance UID')
            if pin['mode'] & 0o022:
                refuse('policy', f'{name} is group/world writable (no sticky-bit exception)')
            if pin['acl'] != 'none':
                refuse('policy', f'{name} must pin acl "none"')
            if shared.setdefault(pin['path'], pin) != pin:
                refuse('policy', f'{name} differs from the pin of the same path in another chain')
        last = chain[-1]
        if key == 'destinationParent':
            if (last['uid'], last['mode'], last['device']) != (uid, 0o700, d['device']):
                refuse('policy', 'destination parent must be a 0700 maintenance-UID directory on the reviewed device')
        else:
            if (last['device'], last['inode']) != (p[key]['device'], p[key]['inode']):
                refuse('policy', f'{key} pin is not the plan {key} identity')
            if (last['uid'], last['mode']) != (uid, hp['inputModes'][key]):
                refuse('policy', f'{key} pin is not maintenance-UID owned with the reviewed mode')
            if not any(x['uid'] == uid and x['mode'] == 0o700 for x in chain[1:-1]):
                refuse('policy', f'{key} has no reviewed 0700 maintenance-UID private directory on its path')
    if len({(x['device'], x['inode']) for x in shared.values()}) != len(shared):
        refuse('policy', 'two pinned paths share one identity')
    return ev


def validate_coordination(data, sha, p):
    """binds this operation, the plan VM units/workflow locks, known lifecycle producers and the operator's explicit
    trust/exclusion assertions; it records an assertion, never a discovered absence of same-UID actors"""
    ev = _obj(_evidence_json(data, sha, 'coordination'), ('format', 'operationId', 'stamp', 'vmUnits', 'workflowLocks',
                                                          'lifecycleProducers', 'operatorAssertions',
                                                          'sameUidActorDiscovery', 'operator'), 'coordination')
    if ev['format'] != FORMAT_COORDINATION or ev['operationId'] != p['operationId'] or ev['stamp'] != p['stamp']:
        refuse('policy', 'coordination evidence is not bound to this operation')
    if ev['vmUnits'] != p['vmUnits'] or ev['workflowLocks'] != p['workflowLocks']:
        refuse('policy', 'coordination evidence does not name exactly the plan VM units and workflow locks')
    _obj(ev['operatorAssertions'], POLICY_TRUST, 'coordination.operatorAssertions')
    if not all(ev['operatorAssertions'][k] is True for k in POLICY_TRUST):
        refuse('policy', 'coordination: every operator trust/exclusion assertion must be literally true')
    if ev['sameUidActorDiscovery'] != 'not-performed-operator-assertion-only':
        refuse('policy', "coordination.sameUidActorDiscovery must be 'not-performed-operator-assertion-only'")
    if not isinstance(ev['operator'], str) or not OPERATOR.fullmatch(ev['operator']):
        refuse('policy', 'coordination.operator')
    lp = ev['lifecycleProducers']
    if not isinstance(lp, list) or not 1 <= len(lp) <= 64:
        refuse('policy', 'coordination.lifecycleProducers must list 1..64 known producers')
    refs = {'plan-vm-unit-stopped': set(p['vmUnits']), 'plan-workflow-lock': {lk['path'] for lk in p['workflowLocks']}}
    for i, x in enumerate(lp):
        _obj(x, ('name', 'coordination', 'ref'), f'coordination.lifecycleProducers[{i}]')
        if not all(isinstance(x[k], str) for k in x) or not re.fullmatch(r'[A-Za-z0-9@._-]{1,100}', x['name']) or \
                x['coordination'] not in refs or x['ref'] not in refs[x['coordination']]:
            refuse('policy', f'coordination.lifecycleProducers[{i}] is not coordinated by a plan VM unit or workflow lock')
    if not set(p['vmUnits']) <= {x['ref'] for x in lp if x['coordination'] == 'plan-vm-unit-stopped'}:
        refuse('policy', 'every plan VM unit must be listed as a coordinated lifecycle producer')
    return ev


def acl_state(obs):
    want = 'absent' if obs['type'] == 'directory' else 'not-applicable'
    if obs['aclAccess'] == 'absent' and obs['aclDefault'] == want:
        return 'none'
    return f'access:{obs["aclAccess"]},default:{obs["aclDefault"]}'


def check_access(obs, uid, phase, want, perm=None, pin=None):
    """one actual metadata observation (OsEffects.access_meta): stable, expected type, trusted owner, no group/world write,
    no POSIX ACL; optionally exact maintenance-UID mode, and exact equality with the reviewed security pin"""
    path = obs['path']
    if not obs['stable']:
        refuse(phase, f'{path}: metadata identity changed during observation')
    if obs['type'] != want:
        refuse(phase, f'{path} is a {obs["type"]}, not a {want} (no symlink or special-file substitute)')
    if obs['uid'] not in (0, uid):
        refuse(phase, f'{path} owner {obs["uid"]} is neither root nor the maintenance UID')
    if obs['perm'] & 0o022:
        refuse(phase, f'{path} is group/world writable (mode {obs["perm"]:o}; no sticky-bit exception)')
    acl = acl_state(obs)
    if acl != 'none':
        refuse(phase, f'{path}: POSIX ACL present or not observable ({acl})')
    if perm is not None and (obs['uid'], obs['perm']) != (uid, perm):
        refuse(phase, f'{path} is not maintenance-UID owned with mode {perm:o}')
    if want == 'regular' and obs['nlink'] != 1:
        refuse(phase, f'{path} has {obs["nlink"]} links')
    got = {'path': path, 'device': obs['dev'], 'inode': obs['ino'], 'type': obs['type'], 'uid': obs['uid'],
           'gid': obs['gid'], 'mode': obs['perm'], 'acl': acl}
    if pin is not None and got != pin:
        refuse(phase, f'{path}: security identity differs from the reviewed pin in {sorted(k for k in PIN_KEYS if got[k] != pin[k])}')
    return dict(got, nlink=obs['nlink'], mtimeNs=obs['mtimeNs'], ctimeNs=obs['ctimeNs'])


# ------------------------------------------------------------------------------------------------------ GPT / ext4 (pure)
def _gpt_header(raw, sector, my_lba, alt_lba, which):
    if len(raw) != sector or raw[:8] != b'EFI PART':
        refuse('gpt', f'{which} header signature missing')
    rev, hsize, crc, reserved = struct.unpack_from('<IIII', raw, 8)
    if rev != 0x00010000 or not 92 <= hsize <= sector or reserved:
        refuse('gpt', f'{which} header revision/size/reserved invalid')
    if zlib.crc32(raw[:16] + b'\0\0\0\0' + raw[20:hsize]) & 0xffffffff != crc:
        refuse('gpt', f'{which} header CRC mismatch')
    if any(raw[hsize:]):
        refuse('gpt', f'{which} header reserved tail not zero')
    me, alt, first, last = struct.unpack_from('<QQQQ', raw, 24)
    entries_lba, count, esize, tcrc = struct.unpack_from('<QIII', raw, 72)
    if me != my_lba or alt != alt_lba:
        refuse('gpt', f'{which} header location {me}/{alt} is not {my_lba}/{alt_lba}')
    if not (0 < count <= 1024 and esize in (128, 256, 512, 1024, 2048, 4096) and count * esize <= 1 << 20):
        refuse('gpt', f'{which} entry table geometry {count}x{esize} out of bounds')
    if first > last:
        refuse('gpt', f'{which} usable range inverted')
    return {'diskGuid': str(uuid.UUID(bytes_le=raw[56:72])), 'first': first, 'last': last, 'entriesLba': entries_lba,
            'count': count, 'esize': esize, 'tableCrc': tcrc}


def parse_gpt(read_at, disk_bytes, sector):
    """read_at(offset, length) -> bytes over the full image; validates both headers/tables -> layout dict"""
    if disk_bytes % sector or disk_bytes < sector * 68:
        refuse('gpt', 'disk size is not a sector multiple or too small')
    last_lba = disk_bytes // sector - 1
    p = _gpt_header(read_at(sector, sector), sector, 1, last_lba, 'primary')
    b = _gpt_header(read_at(last_lba * sector, sector), sector, last_lba, 1, 'backup')
    for k in ('diskGuid', 'first', 'last', 'count', 'esize', 'tableCrc'):
        if p[k] != b[k]:
            refuse('gpt', f'primary/backup {k} differ')
    tbytes = p['count'] * p['esize']
    tsec = -(-tbytes // sector)
    if p['entriesLba'] != 2 or p['first'] < 2 + tsec:
        refuse('gpt', 'primary table placement overlaps usable space')
    if b['entriesLba'] <= p['last'] or b['entriesLba'] + tsec > last_lba:
        refuse('gpt', 'backup table placement overlaps usable space or backup header')
    pt, bt = read_at(2 * sector, tbytes), read_at(b['entriesLba'] * sector, tbytes)
    if len(pt) != tbytes or zlib.crc32(pt) & 0xffffffff != p['tableCrc']:
        refuse('gpt', 'primary entry table CRC mismatch')
    if len(bt) != tbytes or zlib.crc32(bt) & 0xffffffff != b['tableCrc']:
        refuse('gpt', 'backup entry table CRC mismatch')
    if pt != bt:
        refuse('gpt', 'primary/backup entry tables differ')
    parts = []
    for i in range(p['count']):
        e = pt[i * p['esize']:(i + 1) * p['esize']]
        t = uuid.UUID(bytes_le=e[:16])
        if t.int == 0:
            if any(e):
                refuse('gpt', f'entry {i + 1} unused but not zero')
            continue
        u = uuid.UUID(bytes_le=e[16:32])
        first, last = struct.unpack_from('<QQ', e, 32)
        if u.int == 0 or not p['first'] <= first <= last <= p['last']:
            refuse('gpt', f'entry {i + 1} has a zero GUID or lies outside usable LBAs')
        try:
            name = e[56:128].decode('utf-16-le').rstrip('\0')
        except UnicodeDecodeError:
            refuse('gpt', f'entry {i + 1} name is not UTF-16')
        parts.append({'index': i + 1, 'type': str(t), 'unique': str(u), 'first': first, 'last': last, 'name': name})
    if len({x['unique'] for x in parts}) != len(parts):
        refuse('gpt', 'duplicate partition unique GUIDs')
    s = sorted(parts, key=lambda x: x['first'])
    for a, c in zip(s, s[1:]):
        if c['first'] <= a['last']:
            refuse('gpt', f'partitions {a["index"]} and {c["index"]} overlap')
    return {'diskGuid': p['diskGuid'], 'firstUsable': p['first'], 'lastUsable': p['last'], 'entryCount': p['count'],
            'entrySize': p['esize'], 'backupEntriesLba': b['entriesLba'], 'lastLba': last_lba, 'partitions': parts,
            'tableSha256': hashlib.sha256(pt).hexdigest()}


def _crc32c_raw(crc, data, _t=[]):
    if not _t:
        for n in range(256):
            c = n
            for _ in range(8):
                c = (c >> 1) ^ 0x82F63B78 if c & 1 else c >> 1
            _t.append(c)
    for x in data:
        crc = _t[(crc ^ x) & 0xff] ^ (crc >> 8)
    return crc


def parse_ext4_sb(sb):
    if len(sb) != 1024 or struct.unpack_from('<H', sb, 0x38)[0] != 0xEF53:
        return None
    u32 = lambda o: struct.unpack_from('<I', sb, o)[0]
    incompat = u32(0x60)
    log = u32(0x18)
    blocks = u32(0x4) | ((u32(0x150) << 32) if incompat & 0x80 else 0)
    try:
        label = sb[0x78:0x88].rstrip(b'\0').decode('utf-8')
    except UnicodeDecodeError:
        label = None
    return {'uuid': str(uuid.UUID(bytes=sb[0x68:0x78])), 'label': label, 'blockSize': 1024 << log if log <= 6 else None,
            'blocksCount': blocks, 'inodesCount': u32(0x0), 'state': struct.unpack_from('<H', sb, 0x3A)[0],
            'revLevel': u32(0x4C), 'featureCompat': u32(0x5C), 'featureIncompat': incompat, 'featureRoCompat': u32(0x64),
            'journalUuidZero': not any(sb[0xD0:0xE0]), 'journalInum': u32(0xE0), 'journalDev': u32(0xE4),
            'lastOrphan': u32(0xE8), 'errorCount': u32(0x194), 'firstErrorTime': u32(0x198), 'lastErrorTime': u32(0x1CC),
            'checksumOk': None if not u32(0x64) & 0x400 else (sb[0x175] == 1 and _crc32c_raw(0xffffffff, sb[:0x3FC]) == u32(0x3FC))}


def validate_sb(sb, fs, part_bytes):
    """sb: parse_ext4_sb result; fs: plan['filesystem'] -> refusal unless clean, supported and exactly the expected identity"""
    if sb is None:
        refuse('ext4', 'no ext4 superblock')
    for k in ('uuid', 'label', 'blockSize', 'blocksCount', 'inodesCount', 'featureCompat', 'featureIncompat', 'featureRoCompat'):
        if sb[k] != fs[k]:
            refuse('ext4', f'{k} {sb[k]!r} is not the expected {fs[k]!r}')
    if sb['revLevel'] != 1:
        refuse('ext4', 'not a dynamic-revision filesystem')
    if sb['state'] != 1:
        refuse('ext4', f'state {sb["state"]:#x} is not clean (error/orphan flags or not cleanly unmounted)')
    if sb['featureIncompat'] & 0x4:
        refuse('ext4', 'journal recovery is pending (needs_recovery)')
    if sb['featureIncompat'] & 0x8 or sb['journalDev'] or not sb['journalUuidZero']:
        refuse('ext4', 'external journal dependency')
    if sb['featureCompat'] & 0x4 and sb['journalInum'] != 8:
        refuse('ext4', 'journal is not the internal inode 8')
    if sb['featureIncompat'] & ~EXT4_SUPPORTED_INCOMPAT or sb['featureRoCompat'] & ~EXT4_SUPPORTED_RO_COMPAT:
        refuse('ext4', 'unsupported incompat/ro_compat feature (incl. orphan_present, mmp, inline_data, encrypt, casefold)')
    if sb['lastOrphan'] or sb['errorCount'] or sb['firstErrorTime'] or sb['lastErrorTime']:
        refuse('ext4', 'orphan list or recorded filesystem errors present')
    if sb['checksumOk'] is False:
        refuse('ext4', 'superblock checksum mismatch')
    if sb['blocksCount'] * sb['blockSize'] > part_bytes:
        refuse('ext4', 'filesystem extends past its partition')
    return sb


def select_root(gpt, im, sbs, fs):
    """sbs: {index: parse_ext4_sb result or None} for every partition of the root type; exactly one may carry the
    expected ext4 UUID or label, and it must be the planned partition"""
    if gpt['diskGuid'] != im['diskGuid']:
        refuse('gpt', 'disk GUID differs from the plan')
    cand = [x for x in gpt['partitions'] if x['type'] == im['rootTypeGuid'] and sbs.get(x['index']) and
            (sbs[x['index']]['uuid'] == fs['uuid'] or sbs[x['index']]['label'] == fs['label'])]
    if len(cand) != 1:
        refuse('gpt', f'expected exactly one partition with the root ext4 UUID/label, found {len(cand)} (ambiguous root)')
    r = cand[0]
    if (r['index'], r['unique'], r['first'], r['last']) != (im['rootIndex'], im['rootUniqueGuid'], im['rootFirstLba'],
                                                            im['rootLastLba']):
        refuse('gpt', 'root partition index/GUID/start/end differ from the plan')
    off, length = r['first'] * im['sectorSize'], (r['last'] - r['first'] + 1) * im['sectorSize']
    if off + length > (gpt['lastLba'] + 1) * im['sectorSize']:
        refuse('gpt', 'root partition outside the image')
    return r, off, length


def parse_qcow2_header(h, file_size):
    """first 4 KiB of the qcow2 file: refuse backing files, encryption, external data files, dirty/corrupt bits"""
    if len(h) < 104 or h[:4] != b'QFI\xfb':
        refuse('qcow2', 'not a qcow2 image')
    version, bfo, bfs, cbits, size, crypt = struct.unpack_from('>IQIIQI', h, 4)
    if version not in (2, 3) or bfo or bfs or crypt:
        refuse('qcow2', 'backing file, encryption or unsupported version')
    if version == 3:
        incompat, compat, autoclear, _order, hlen = struct.unpack_from('>QQQII', h, 72)
        if incompat:
            refuse('qcow2', f'incompatible feature bits {incompat:#x} (dirty/corrupt/external data file/compression)')
        if autoclear & ~0x1:
            refuse('qcow2', 'unexpected autoclear features (raw external data)')
        pos = hlen
        while True:
            if pos + 8 > len(h):
                refuse('qcow2', 'header extensions exceed the inspected header')
            et, el = struct.unpack_from('>II', h, pos)
            if et == 0:
                break
            if et == 0x44415441:
                refuse('qcow2', 'external data file extension present')
            pos += 8 + ((el + 7) & ~7)
    return {'version': version, 'virtualSize': size, 'clusterBits': cbits, 'fileSize': file_size}


def validate_qemu_info(info, im):
    if not isinstance(info, dict) or info.get('format') != 'qcow2':
        refuse('qcow2', 'qemu-img info format is not qcow2')
    if any(k in info for k in ('backing-filename', 'full-backing-filename', 'backing-filename-format')):
        refuse('qcow2', 'image has a backing chain')
    if info.get('virtual-size') != im['virtualSize']:
        refuse('qcow2', 'virtual size differs from the plan')
    data = (info.get('format-specific') or {}).get('data') or {}
    if data.get('data-file') or data.get('data-file-raw') or data.get('encrypt') or data.get('corrupt'):
        refuse('qcow2', 'external data file, encryption or corrupt flag')
    return {'virtualSize': info['virtual-size'], 'compat': data.get('compat'), 'actualSize': info.get('actual-size')}


# --------------------------------------------------------------------------------------------------------- debugfs layer
def parse_ls_p(text):
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = LS_P.fullmatch(line.strip())
        if not m:
            refuse('inventory', 'unparseable debugfs ls -p line')
        if m.group(5) in ('.', '..'):
            continue
        out.append({'inode': int(m.group(1)), 'mode': int(m.group(2), 8), 'uid': int(m.group(3)), 'gid': int(m.group(4)),
                    'name': m.group(5), 'size': int(m.group(6) or 0)})
    return out


def parse_stat(text):
    m = re.search(r'Inode: (\d+)\s+Type: ([a-zA-Z ]+?)\s+Mode:\s+([0-7]+)\s+Flags: (0x[0-9a-f]+)', text)
    ug = re.search(r'User:\s+(\d+)\s+Group:\s+(\d+)', text)
    sz = re.search(r'Size: (\d+)', text)
    ln = re.search(r'Links: (\d+)', text)
    if not (m and ug and sz and ln):
        refuse('inventory', 'unparseable debugfs stat output')
    times = dict(re.findall(r'^\s*(ctime|atime|mtime|crtime): (0x[0-9a-f]+(?::[0-9a-f]+)?)', text, re.M))
    xattrs, xsec = [], re.search(r'^Extended attributes:\n((?:  .*\n?)*)', text, re.M)
    if xsec:
        xattrs = sorted(re.findall(r'^  (\S+?)(?: \(\d+\))? = ', xsec.group(1), re.M))
    dest = re.search(r'Fast link dest: "([^"]*)"', text)
    return {'inode': int(m.group(1)), 'type': m.group(2), 'perm': int(m.group(3), 8), 'flags': m.group(4),
            'uid': int(ug.group(1)), 'gid': int(ug.group(2)), 'size': int(sz.group(1)), 'links': int(ln.group(1)),
            'times': times, 'xattrNames': xattrs, 'xattrSha256': hashlib.sha256(xsec.group(1).encode()).hexdigest() if xsec
            else None, 'target': dest.group(1) if dest else None}


def stderr_noise(err):
    """debugfs prints failures on stderr with rc 0; only its version banner is tolerated"""
    return [l.strip()[:200] for l in err.decode('utf-8', 'replace').splitlines() if l.strip() and not BANNER.fullmatch(l.strip())]


class Debugfs:
    def __init__(self, fx, tool, dev, bounds, deadline, log):
        self.fx, self.tool, self.dev, self.b, self.deadline, self.log = fx, tool, dev, bounds, deadline, log

    def call(self, request, write=False):
        words = request.split(' ')
        if any(w != w.strip() or not w for w in words) or any(c in request for c in '"\'\\\n\t;|&$`'):
            refuse('debugfs', 'request contains unsafe characters')
        for w in words[1:]:
            if w.startswith('/') and not (GUEST_PATH.fullmatch(w) and os.path.normpath(w) == w):
                refuse('debugfs', f'unsafe guest path {w!r}')
        argv = [self.tool] + (['-w'] if write else []) + ['-R', request, self.dev]
        rc, out, err = self.fx.run(argv, self.deadline.left('debugfs', self.b['commandSeconds']), self.b['maxOutputBytes'])
        noise = stderr_noise(err)
        self.log(argv, rc, out, err)
        if rc != 0 or noise:
            refuse('debugfs', f'{words[0]} rc {rc} stderr {noise[:3]}')
        return out

    def ls(self, path):
        return parse_ls_p(self.call(f'ls -p {path}').decode('utf-8', 'replace'))

    def stat(self, path):
        raw = parse_stat(self.call(f'stat {path}').decode('utf-8', 'replace'))
        if raw['type'] != 'symlink':
            return raw
        size, inode = raw['size'], raw['inode']
        if not 1 <= size <= min(4096, self.b['maxOutputBytes']) or inode < 1:
            refuse('inventory', f'{path}: invalid symlink inode/size')
        if raw['target'] is None:
            data = self.cat(f'<{inode}>')  # numeric inode contents, never dereference the link
            after = parse_stat(self.call(f'stat {path}').decode('utf-8', 'replace'))
            if after != raw:
                refuse('inventory', f'{path}: symlink metadata changed during read')
        else:
            data = raw['target'].encode('utf-8')
        if len(data) != size or b'\x00' in data:
            refuse('inventory', f'{path}: invalid symlink target length or NUL')
        try:
            target = data.decode('utf-8', 'strict')
        except UnicodeDecodeError:
            refuse('inventory', f'{path}: non-UTF8 symlink target')
        return dict(raw, target=target)

    def cat(self, path):
        return self.call(f'cat {path}')

    def ea_list(self, path):
        """explicit native xattr listing: only rc 0, no stderr (enforced by call) and EMPTY stdout mean no attributes"""
        out = self.call(f'ea_list {path}')
        if out != b'':
            refuse('xattrs', f'{path}: ea_list not empty ({len(out)} bytes, sha256 {hashlib.sha256(out).hexdigest()})')
        return {'eaList': 'empty', 'stdoutSha256': hashlib.sha256(out).hexdigest()}


def _kind(mode):
    return {stat.S_IFREG: 'regular', stat.S_IFDIR: 'directory', stat.S_IFLNK: 'symlink'}.get(stat.S_IFMT(mode), 'special')


def guest_dirs(dbg, usr_merge):
    lib = dbg.stat('/lib')
    if lib['type'] == 'symlink':
        if lib['target'] not in ('usr/lib', '/usr/lib'):
            refuse('inventory', '/lib is an unexpected symlink')
        merged = True
    elif lib['type'] == 'directory':
        merged = False
    else:
        refuse('inventory', '/lib is neither directory nor usr-merge symlink')
    if merged != usr_merge:
        refuse('inventory', f'usr-merge state {merged} differs from the plan')
    # with usr-merge /lib/systemd/system IS /usr/lib/systemd/system: scanned once, never addressed by its alias
    return (ETC, USR) if merged else (ETC, USR, LIB)


def inventory(dbg, dirs, limit):
    """metadata of every entry in the unit dirs and one level below; content hashes of EVERY regular file in that scope
    (never displayed or logged); whitelisted directives only for the eight fragments"""
    entries, hashes, directives, count = {}, {}, {}, 0
    for d in dirs:
        top = dbg.ls(d)
        for e in top:
            p = f'{d}/{e["name"]}'
            entries[p] = {k: e[k] for k in ('inode', 'mode', 'uid', 'gid', 'size')}
            if _kind(e['mode']) == 'directory':
                for s in dbg.ls(p):
                    entries[f'{p}/{s["name"]}'] = {k: s[k] for k in ('inode', 'mode', 'uid', 'gid', 'size')}
        count = len(entries)
        if count > limit:
            refuse('inventory', f'more than {limit} unit-tree entries')
    for p, m in entries.items():
        k, name, parent = _kind(m['mode']), p.rsplit('/', 1)[1], p.rsplit('/', 1)[0]
        if k == 'symlink':
            st = dbg.stat(p)
            if st['type'] != 'symlink' or any(st[k] != m[k] for k in ('inode', 'size', 'uid', 'gid')) or st['perm'] != stat.S_IMODE(m['mode']):
                refuse('inventory', f'{p}: symlink listing/stat identity differs')
            if st['target'] is None:
                refuse('inventory', f'{p}: slow or unreadable symlink target')
            m['target'], m['links'] = st['target'], st['links']
        elif k == 'regular':
            data = dbg.cat(p)
            if len(data) != m['size']:
                refuse('inventory', f'{p}: short read')
            hashes[p] = hashlib.sha256(data).hexdigest()
            if name in UNITS and parent == ETC:
                directives[name] = [l.strip() for l in data.decode('utf-8', 'replace').splitlines() if DIRECTIVE.match(l.strip())]
    return {'dirs': list(dirs), 'entries': entries, 'hashes': hashes, 'directives': directives, 'readErrors': []}


def _allowed_targets(link_path, unit):
    parent = link_path.rsplit('/', 2)[0]
    return {f'{ETC}/{unit}'} | ({f'../{unit}'} if parent == ETC else set())


def check_preconditions(inv, frag_stats, plan):
    """-> enablement link records; refuses drift, aliases, extra layers, hard links, special files"""
    fr, links = plan['fragments'], []
    for p, m in inv['entries'].items():
        k, name = _kind(m['mode']), p.rsplit('/', 1)[1]
        if k == 'special':
            refuse('preconditions', f'{p} is a special file')
        parent = p.rsplit('/', 1)[0]
        in_link_dir = bool(LINK_DIR.search(parent.rsplit('/', 1)[1])) and parent.rsplit('/', 1)[0] in inv['dirs']
        tbase = os.path.basename(m.get('target', '').rstrip('/')) if k == 'symlink' else None
        if name in UNITS and parent in inv['dirs'] and parent != ETC:
            refuse('preconditions', f'{p}: unexpected extra layer for a pinned unit')
        if in_link_dir and name in UNITS:
            if k != 'symlink' or m['target'] not in _allowed_targets(p, name) or m.get('links') != 1:
                refuse('preconditions', f'{p}: enablement entry is not a single-link symlink to the /etc fragment')
            links.append({'path': p, 'target': m['target'], 'meta': dict(m)})
        elif tbase in UNITS:
            refuse('preconditions', f'{p}: alias/unexpected link to pinned unit {tbase}')
    for u, want in UNITS.items():
        p = f'{ETC}/{u}'
        m, st = inv['entries'].get(p), frag_stats.get(u)
        if m is None or _kind(m['mode']) != 'regular' or st is None or st['type'] != 'regular':
            refuse('preconditions', f'{p} is not a regular fragment (already masked or missing: needs a reconciled plan)')
        if inv['hashes'].get(p) != want:
            refuse('preconditions', f'{u} sha256 differs from UNIT-PINS (fragment drift)')
        if st['links'] != 1 or st['inode'] != m['inode'] or st['size'] != m['size']:
            refuse('preconditions', f'{u}: hard link, inode or size mismatch')
        if (st['perm'], st['uid'], st['gid'], st['xattrNames']) != (fr['mode'], fr['uid'], fr['gid'], sorted(fr['xattrNames'])):
            refuse('preconditions', f'{u}: mode/owner/xattrs differ from the plan')
        if u in fr['inodes'] and fr['inodes'][u] != st['inode']:
            refuse('preconditions', f'{u}: inode differs from the plan')
    return sorted(links, key=lambda x: x['path'])


def check_ancestor(st, path, phase='preconditions'):
    if st['type'] != 'directory' or st['uid'] != 0 or st['perm'] & 0o022:
        refuse(phase, f'{path} is not a root-owned, non-group/world-writable directory')


def build_ops(plan, links, keep_exists):
    stampdir = f'{KEEP}/{plan["stamp"]}'
    ops = [] if keep_exists else [{'op': 'mkdir', 'path': KEEP}]
    ops.append({'op': 'mkdir', 'path': stampdir})
    for u in UNITS:
        ops += [{'op': 'ln', 'unit': u, 'path': f'{stampdir}/{u}'}, {'op': 'unlink', 'unit': u, 'path': f'{ETC}/{u}'},
                {'op': 'symlink', 'unit': u, 'path': f'{ETC}/{u}', 'target': '/dev/null'}]
    ops += [{'op': 'rm', 'path': l['path']} for l in links]
    return ops


def semantic_delta(base, post, links):
    """-> list of unexpected differences in the unit tree (empty == only the enumerated delta)"""
    removed, masked = {l['path'] for l in links}, {f'{ETC}/{u}' for u in UNITS}
    bad = []
    if post['readErrors'] or base['readErrors']:
        bad.append('readErrors present')
    for p in sorted(set(base['entries']) | set(post['entries'])):
        b, a = base['entries'].get(p), post['entries'].get(p)
        if p in masked:
            if a is None or _kind(a['mode']) != 'symlink' or a.get('target') != '/dev/null':
                bad.append(f'{p}: not masked to /dev/null')
        elif p in removed:
            if a is not None:
                bad.append(f'{p}: enablement link still present')
        elif b is None or a is None:
            bad.append(f'{p}: entry {"added" if b is None else "removed"}')
        else:
            keys = ('inode', 'mode', 'uid', 'gid', 'target') + (() if _kind(b['mode']) == 'directory' else ('size',))
            if any(b.get(k) != a.get(k) for k in keys):
                bad.append(f'{p}: metadata changed')
    for p, h in base['hashes'].items():
        if p not in masked and post['hashes'].get(p) != h:
            bad.append(f'{p}: content hash changed')
    for p in sorted(set(post['hashes']) - set(base['hashes'])):
        bad.append(f'{p}: regular file hashed only after the mutation')
    for inv, when in ((base, 'before'), (post, 'after')):
        for p, m in sorted(inv['entries'].items()):
            if _kind(m['mode']) == 'regular' and p not in inv['hashes']:
                bad.append(f'{p}: regular file without a content hash {when}')
    for p in post['entries']:
        name = p.rsplit('/', 1)[1]
        parent = p.rsplit('/', 1)[0]
        if name in UNITS and LINK_DIR.search(parent.rsplit('/', 1)[1]):
            bad.append(f'{p}: matching enablement link remains')
    return bad


def verify_archive(base_stats, post_stats, archive_listing):
    bad = []
    if sorted(e['name'] for e in archive_listing) != sorted(UNITS):
        bad.append('archive directory does not contain exactly the eight units')
    for u in UNITS:
        if post_stats.get(u) != base_stats.get(u):
            bad.append(f'{u}: archived inode metadata differs from the original')
    return bad


ANCESTORS = ('/etc', '/etc/systemd', ETC, '/var', '/var/lib')
TIMES = ('atime', 'crtime', 'ctime', 'mtime')


def check_record(st, path, kind, phase='preconditions'):
    """a rollback record needs the complete native metadata: expected type, one link, all four timestamps, no xattrs"""
    if st['type'] != kind or st['links'] != 1 or sorted(st['times']) != list(TIMES):
        refuse(phase, f'{path}: incomplete or unexpected native metadata (type {st["type"]}, links {st["links"]}, '
                      f'times {sorted(st["times"])})')
    if st['xattrNames'] or st['xattrSha256'] is not None:
        refuse(phase, f'{path}: stat reports extended attributes')


def link_records(dbg, links, phase='preconditions'):
    """full rollback record per enablement link: native stat (inode/type/mode/owner/size/links/target/4 times) + ea_list"""
    out = []
    for l in links:
        st = dbg.stat(l['path'])
        check_record(st, l['path'], 'symlink', phase)
        if st['inode'] != l['meta']['inode'] or st['target'] != l['target']:
            refuse(phase, f'{l["path"]}: native stat inode/target differs from the inventory')
        out.append(dict(l, stat=st, xattrs=dbg.ea_list(l['path'])))
    return out


def lsmap(dbg, d):
    return {e['name']: e['inode'] for e in dbg.ls(d)}


# ------------------------------------------------------------------------------------------------------------- OS effects
FLOCK_FMT = '@hhqqi4x'


def _starttime(pid):
    try:
        with open(f'/proc/{pid}/stat', 'rb') as f:
            return int(f.read().rsplit(b')', 1)[1].split()[19])
    except (OSError, IndexError, ValueError):
        return None


def _proc_table():
    """pid -> (state, ppid, pgrp, sid, starttime) for every readable /proc/PID/stat"""
    out = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                with open(f'/proc/{name}/stat', 'rb') as f:
                    w = f.read().rsplit(b')', 1)[1].split()
                out[int(name)] = (w[0].decode(), int(w[1]), int(w[2]), int(w[3]), int(w[19]))
            except (OSError, IndexError, ValueError):
                continue
    return out


def _mounted(path):
    """mountinfo, not os.path.ismount: a dead FUSE mount fails lstat (ENOTCONN) and ismount would report it absent"""
    want = os.fsencode(path)
    with open('/proc/self/mountinfo', 'rb') as f:
        for line in f.read().splitlines():
            w = line.split(b' ')
            if len(w) > 4 and re.sub(rb'\\([0-7]{3})', lambda m: bytes([int(m.group(1), 8)]), w[4]) == want:
                return True
    return False


def assert_owned(handle, observed_start):
    if observed_start is None or observed_start != handle['start']:
        refuse('cleanup', f'exporter pid {handle["pid"]} identity mismatch; not signalling a process we do not own')


def bounded_collect(proc, timeout, limit, clock, argv0):
    end, total = clock() + timeout, 0
    bufs = {proc.stdout: bytearray(), proc.stderr: bytearray()}
    sel = selectors.DefaultSelector()
    for f in bufs:
        sel.register(f, selectors.EVENT_READ)
    try:
        while sel.get_map():
            left = end - clock()
            if left <= 0:
                refuse('bounds', f'{argv0} exceeded {timeout:.0f}s')
            for key, _ in sel.select(min(left, 1.0)):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                total += len(chunk)
                if total > limit:
                    refuse('bounds', f'{argv0} output exceeded {limit} bytes')
                bufs[key.fileobj] += chunk
    finally:
        sel.close()
    return bytes(bufs[proc.stdout]), bytes(bufs[proc.stderr]), max(0.1, end - clock())


class OsEffects:
    """Real effects; tests inject a fake with the same methods.  Never used at import."""

    def __init__(self, popen=subprocess.Popen, killpg=os.killpg, proc_starttime=_starttime, clock=time.monotonic,
                 proc_table=_proc_table, pidfd_open=getattr(os, 'pidfd_open', None),
                 pidfd_signal=getattr(signal, 'pidfd_send_signal', None), ismount=_mounted,
                 proc_exists=lambda pid: os.path.lexists(f'/proc/{pid}')):
        self.popen, self.killpg, self.proc_starttime, self.monotonic = popen, killpg, proc_starttime, clock
        self.sleep, self.time = time.sleep, time.time
        self.proc_table, self.pidfd_open, self.pidfd_signal, self.ismount = proc_table, pidfd_open, pidfd_signal, ismount
        self.close, self.join_seconds, self.proc_exists = os.close, 5, proc_exists

    # --- files
    def lstat(self, path):
        st = os.lstat(path)
        return {'mode': st.st_mode, 'uid': st.st_uid, 'dev': st.st_dev, 'ino': st.st_ino, 'nlink': st.st_nlink,
                'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'ctimeNs': st.st_ctime_ns, 'blocks': st.st_blocks}

    def read_bounded(self, path, limit):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            data = os.read(fd, limit + 1)
        finally:
            os.close(fd)
        if len(data) > limit:
            refuse('files', f'{path} exceeds {limit} bytes')
        return data

    def _ident(self, st):
        return {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'ctimeNs': st.st_ctime_ns}

    def hash_file(self, path, deadline, phase):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            before, h = self._ident(os.fstat(fd)), hashlib.sha256()
            while True:
                deadline.left(phase, 1)
                b = os.read(fd, CHUNK)
                if not b:
                    break
                h.update(b)
            return h.hexdigest(), before, self._ident(os.fstat(fd))
        finally:
            os.close(fd)

    def hash_region(self, path, start, length, deadline, phase):
        fd, h, pos = os.open(path, os.O_RDONLY | os.O_CLOEXEC), hashlib.sha256(), start
        try:
            while pos < start + length:
                deadline.left(phase, 1)
                b = os.pread(fd, min(CHUNK, start + length - pos), pos)
                if not b:
                    refuse(phase, 'short read through export')
                h.update(b); pos += len(b)
        finally:
            os.close(fd)
        return h.hexdigest()

    def read_at(self, path, offset, length):
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            return os.pread(fd, length, offset)
        finally:
            os.close(fd)

    def statvfs(self, path):
        s = os.statvfs(path)
        return {'availBytes': s.f_bavail * s.f_frsize, 'dev': os.stat(path).st_dev}

    def mkdir_excl(self, path, mode):
        os.mkdir(path, mode)
        os.chmod(path, mode)
        self.fsync_dir(os.path.dirname(path))

    def write_excl(self, path, data, mode):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        self.fsync_dir(os.path.dirname(path))

    def append_sync(self, path, data):
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            os.write(fd, data); os.fsync(fd)
        finally:
            os.close(fd)

    def fsync_dir(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def fsync_file(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def chmod(self, path, mode):
        os.chmod(path, mode)        # every component was lstat-verified symlink-free by the caller

    def sparse_copy(self, src, ident, dst, deadline):
        """streamed byte-preserving copy; holes stay holes where SEEK_DATA works; returns sha256 of the source stream"""
        sfd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        dfd = None
        try:
            if {k: v for k, v in self._ident(os.fstat(sfd)).items() if k != 'ctimeNs'} != \
                    {'dev': ident['device'], 'ino': ident['inode'], 'size': ident['size'], 'mtimeNs': ident['mtimeNs']}:
                refuse('copy', 'backup identity changed before copy')
            dfd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            size, pos, h, zeros = ident['size'], 0, hashlib.sha256(), bytes(CHUNK)
            while pos < size:
                deadline.left('copy', 1)
                try:
                    data = os.lseek(sfd, pos, os.SEEK_DATA)
                    hole = os.lseek(sfd, data, os.SEEK_HOLE)
                except OSError as e:
                    if e.errno == errno.ENXIO:
                        data = hole = size
                    elif e.errno == errno.EINVAL:
                        data, hole = pos, size
                    else:
                        raise
                while pos < data:
                    n = min(CHUNK, data - pos); h.update(zeros[:n]); pos += n
                while pos < min(hole, size):
                    deadline.left('copy', 1)
                    b = os.pread(sfd, min(CHUNK, hole - pos), pos)
                    if not b:
                        refuse('copy', 'short read from backup')
                    h.update(b)
                    view, off = memoryview(b), pos
                    while view:
                        n = os.pwrite(dfd, view, off); view, off = view[n:], off + n
                    pos += len(b)
            os.ftruncate(dfd, size)
            os.fsync(dfd)
            return h.hexdigest()
        finally:
            os.close(sfd)
            if dfd is not None:
                os.close(dfd)

    # --- locks / holders / scope
    def lock_evidence(self, fd, path):
        st = os.fstat(fd)
        with open(f'/proc/self/fdinfo/{fd}') as f:
            info = f.read()
        flock = any(l.startswith('lock:') and 'FLOCK' in l and 'WRITE' in l for l in info.splitlines())
        fresh = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            fst = os.fstat(fresh)
            try:
                fcntl.flock(fresh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fresh, fcntl.LOCK_UN); blocked = False
            except BlockingIOError:
                blocked = True
        finally:
            os.close(fresh)
        return {'dev': st.st_dev, 'ino': st.st_ino, 'pathMatches': (fst.st_dev, fst.st_ino) == (st.st_dev, st.st_ino),
                'fdHoldsFlockWrite': flock, 'freshTrylockBlocked': blocked}

    def hold_qemu_locks(self, path, ident):
        if os.uname().machine != 'x86_64':
            refuse('locks', 'struct flock layout only qualified for x86_64')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st = os.fstat(fd)
            if (st.st_dev, st.st_ino) != (ident['device'], ident['inode']):
                refuse('locks', f'{path} identity changed')
            # Deny WRITE, WRITE_UNCHANGED and RESIZE before checking granted
            # permissions. Keep these OFD locks through the final conflict scan:
            # a check-before-lock sequence permits a native writer to enter.
            # WRITE_UNCHANGED may modify image metadata despite stable guest bytes.
            for byte in (201, 202, 203):
                fcntl.fcntl(fd, fcntl.F_OFD_SETLK, struct.pack(FLOCK_FMT, fcntl.F_RDLCK, os.SEEK_SET, byte, 1, 0))
            r = fcntl.fcntl(fd, fcntl.F_OFD_GETLK, struct.pack(FLOCK_FMT, fcntl.F_WRLCK, os.SEEK_SET, 100, 200, 0))
            if struct.unpack(FLOCK_FMT, r)[0] != fcntl.F_UNLCK:
                refuse('locks', f'{path} has a QEMU image lock held by another process')
            return fd
        except BaseException:
            os.close(fd)
            raise

    def release(self, fd):
        os.close(fd)

    # --- private-derivative policy observations (opt-in only; the default holder gate never calls these)
    def euid(self):
        return os.geteuid()

    def access_meta(self, path):
        """lstat + POSIX access/default ACL presence, bracketed by a second lstat of the same path; never follows a
        symlink.  Absent ACLs are reported only on ENODATA; unsupported or unreadable observations are reported as such"""
        def sec(st):
            return st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_nlink, st.st_ctime_ns
        a = os.lstat(path)
        kind, acl = _kind(a.st_mode), {'aclAccess': 'not-observed', 'aclDefault': 'not-applicable'}
        if kind in ('regular', 'directory'):
            names = [('aclAccess', 'system.posix_acl_access')]
            if kind == 'directory':
                names.append(('aclDefault', 'system.posix_acl_default'))
            for key, name in names:
                try:
                    os.getxattr(path, name, follow_symlinks=False)
                    acl[key] = 'present'
                except OSError as e:
                    acl[key] = {errno.ENODATA: 'absent', errno.ENOTSUP: 'unsupported',
                                errno.EOPNOTSUPP: 'unsupported'}.get(e.errno, 'unreadable')
        b = os.lstat(path)
        return {'path': path, 'dev': b.st_dev, 'ino': b.st_ino, 'type': kind, 'uid': b.st_uid, 'gid': b.st_gid,
                'perm': stat.S_IMODE(b.st_mode), 'nlink': b.st_nlink, 'size': b.st_size, 'mtimeNs': b.st_mtime_ns,
                'ctimeNs': b.st_ctime_ns, 'aclAccess': acl['aclAccess'], 'aclDefault': acl['aclDefault'],
                'stable': sec(a) == sec(b)}

    def scan_holders(self, idents):
        holders, unreadable, me = [], [], os.getpid()
        for name in os.listdir('/proc'):
            if not name.isdigit() or int(name) == me:
                continue
            try:
                fds = os.listdir(f'/proc/{name}/fd')
            except FileNotFoundError:
                continue
            except PermissionError:
                unreadable.append(int(name)); continue
            for fd in fds:
                try:
                    st = os.stat(f'/proc/{name}/fd/{fd}')
                except FileNotFoundError:
                    continue
                except PermissionError:
                    unreadable.append(int(name)); break
                if (st.st_dev, st.st_ino) in idents:
                    holders.append(int(name))
        return sorted(set(holders)), sorted(set(unreadable))

    def resource_scope(self):
        with open('/proc/self/cgroup') as f:
            v2 = [l[3:].strip() for l in f.read().splitlines() if l.startswith('0::')]
        if len(v2) != 1:
            refuse('scope', 'cgroup v2 membership unknown')
        base, out = '/sys/fs/cgroup' + v2[0], {'cgroup': v2[0]}
        for k, fn in (('memoryMax', 'memory.max'), ('swapMax', 'memory.swap.max')):
            with open(f'{base}/{fn}') as f:
                out[k] = f.read().strip()
        return out

    # --- bounded children
    def _kill_own(self, proc):
        if proc.returncode is None:
            try:
                self.killpg(proc.pid, signal.SIGKILL)   # unreaped child: pid/pgid cannot have been reused
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass

    def run(self, argv, timeout, limit):
        if not argv or not all(isinstance(a, str) for a in argv) or any(a in ('-U', '--force-share') or 'locking=off' in a
                                                                          for a in argv):
            refuse('bounds', 'argv rejected (non-string or lock bypass)')
        child_env = dict(CHILD_ENV)
        if argv[0] == '/usr/bin/systemctl' and '--user' in argv:
            for key in ('XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'):
                if os.environ.get(key):
                    child_env[key] = os.environ[key]
        proc = self.popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env,
                          start_new_session=True, close_fds=True)
        try:
            out, err, left = bounded_collect(proc, timeout, limit, self.monotonic, os.path.basename(argv[0]))
            try:
                rc = proc.wait(timeout=left)
            except subprocess.TimeoutExpired:
                refuse('bounds', f'{os.path.basename(argv[0])} did not exit within its deadline')
        finally:
            self._kill_own(proc)
            for f in (proc.stdout, proc.stderr):
                try:
                    f.close()
                except (OSError, AttributeError):
                    pass
        return rc, out, err

    # --- exporters: registered at spawn, stderr drained continuously, teardown verified before the leader is reaped
    def _exited(self, pid):
        info = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        return info                 # WNOWAIT: the unreaped leader keeps its pid, pgid and sid reserved

    def _owned_scan(self, h):
        """record (pid, starttime) of every live session/group member and ppid descendant of the unreaped leader;
        returns the live owned set (leader excluded: it is observed through waitid)"""
        table, sid = self.proc_table(), h['pid']
        for pid, start in h['owned']:
            if pid not in table:
                observed = self.proc_starttime(pid)
                if observed == start or (observed is None and self.proc_exists(pid)):
                    refuse('cleanup', f'owned member {pid}: process metadata unreadable; visibility incomplete')
        kids = {pid for pid, r in table.items() if pid != sid and sid in (r[2], r[3])}
        frontier = {sid} | kids
        while frontier:
            frontier = {pid for pid, r in table.items() if r[1] in frontier and pid != sid and pid not in kids}
            kids |= frontier
        h['owned'] |= {(pid, table[pid][4]) for pid in kids if table[pid][0] != 'Z'}
        return sorted((pid, st) for pid, st in h['owned'] if pid in table and table[pid][4] == st and table[pid][0] != 'Z')

    def _await_gone(self, h, seconds):
        end = self.monotonic() + seconds
        while True:
            leader = h['proc'].returncode is not None or self._exited(h['pid']) is not None
            alive = self._owned_scan(h)
            if (leader and not alive) or self.monotonic() >= end:
                return leader, alive
            self.sleep(0.1)

    def _signal_owned(self, h, sig, alive):
        sent = []
        with h['lock']:
            if not h['reaped'] and h['proc'].returncode is None:
                try:
                    self.killpg(h['pid'], sig)       # unreaped leader: its pgid cannot have been reused
                    sent.append(('group', h['pid']))
                except ProcessLookupError:
                    pass
        for pid, start in alive:
            if self.pidfd_open is None or self.pidfd_signal is None:
                refuse('cleanup', f'pidfd signalling unavailable: owned member {pid} cannot be pinned')
            try:
                fd = self.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                if self.proc_starttime(pid) == start:   # pidfd pins this exact process; otherwise it is not ours
                    self.pidfd_signal(fd, sig)
                    sent.append(('pidfd', pid))
            except ProcessLookupError:
                pass
            finally:
                self.close(fd)
        return sent

    def _drain(self, h):
        """owned drainer thread: reads exporter stderr as it is written, retains at most limit bytes; overflow is a fault
        that stops the exporter group at once (never just truncation), whatever the parent is doing"""
        kept, total, limit = bytearray(), 0, h['limit']
        try:
            while True:
                chunk = os.read(h['errfd'], 65536)
                if not chunk:
                    break
                total += len(chunk)
                kept += chunk[:max(0, limit - len(kept))]
                h['stderrBytes'] = total
                if total > limit and h['fault'] is None:
                    h['fault'] = f'exporter stderr exceeded {limit} bytes'
                    with h['lock']:
                        if not h['reaped'] and h['proc'].returncode is None:
                            try:
                                self.killpg(h['pid'], signal.SIGTERM)    # teardown escalates and verifies
                            except ProcessLookupError:
                                pass
        except OSError as e:
            h['fault'] = h['fault'] or f'exporter stderr drain failed (errno {e.errno})'
        finally:
            h['stderrBytes'], h['stderrKept'] = total, bytes(kept)

    def export_fault(self, h):
        if h['closed'] or h['stopping']:
            return h['fault']
        if h['fault']:
            return h['fault']
        if self._exited(h['pid']) is not None:
            return f'exporter {h["pid"]} exited while its export was in use'
        return None

    def export_start(self, argv, mount_dir, export_file, size, timeout, limit, register, fusermount):
        # Defer our Python cancellation handler across spawn/registration, without
        # blocking OS signals that an exec child would inherit.
        old = _CANCEL['deferred']
        _CANCEL['deferred'] = True
        try:
            proc = self.popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              env=CHILD_ENV, start_new_session=True, close_fds=True)
            h = {'proc': proc, 'pid': proc.pid, 'start': self.proc_starttime(proc.pid), 'mount': mount_dir,
                 'file': export_file, 'argv': argv, 'limit': limit, 'owned': set(), 'lock': threading.Lock(),
                 'reaped': False, 'fault': None, 'stopping': False, 'closed': None, 'stderrBytes': 0, 'stderrKept': b'',
                 'errfd': proc.stderr.fileno()}
            register(h)
            # Python cancellation handlers run on the main thread, not this drainer
            h['drainer'] = threading.Thread(target=self._drain, args=(h,), name=f'exporter-stderr-{proc.pid}', daemon=True)
            h['drainer'].start()
        finally:
            _CANCEL['deferred'] = old
        end = self.monotonic() + timeout
        try:
            if _CANCEL['pending'] is not None and not old:
                refuse('cancelled', f'signal {_CANCEL["pending"]} during exporter registration')
            if h['start'] is None:
                refuse('export', f'exporter pid {h["pid"]} start time unreadable: ownership cannot be pinned')
            while True:
                if h['fault']:
                    refuse('export', h['fault'])
                if self._exited(proc.pid) is not None:
                    refuse('export', 'exporter exited before exposing the image')
                try:
                    got = os.stat(export_file).st_size
                except FileNotFoundError:
                    got = None
                if got == size:
                    self._owned_scan(h)
                    return h
                if got is not None:
                    refuse('export', f'export appeared with size {got}, expected {size}')
                if self.monotonic() > end:
                    refuse('export', 'export did not appear with the expected size in time')
                self.sleep(0.1)
        except BaseException:
            try:
                self.export_force_cleanup(h, fusermount)
            except Exception as e:      # still registered: Writer.cleanup retries and reports it
                h['cleanupError'] = str(e)[:300]
            raise

    def export_stop(self, h, fusermount, timeout, limit):
        h['stopping'] = True
        rc, info, alive = None, None, []
        if not h['fault']:
            rc = self.run([fusermount, '-u', h['mount']], timeout, limit)[0]
            leader, alive = self._await_gone(h, timeout)
            info = self._exited(h['pid']) if leader and h['proc'].returncode is None else None
        ev = self.export_force_cleanup(h, fusermount)    # same verified teardown; signals only owned survivors
        clean = rc == 0 and info is not None and info.si_code == os.CLD_EXITED and info.si_status == 0 and not alive
        ev.update(fusermountRc=rc, normal=clean)
        if not clean or h['fault']:
            refuse('export', f'exporter did not stop normally (fusermount rc {rc}, exit '
                             f'{info and (info.si_code, info.si_status)}, survivors {alive[:8]}, fault {h["fault"]})')
        return ev

    def export_force_cleanup(self, h, fusermount):
        """bounded TERM->KILL of the owned leader group and every recorded member/descendant (exact start-time
        identity), verified unmount, and only then reap the leader and join the drainer; refuses if incomplete"""
        if h.get('closed'):
            return h['closed']
        proc = h['proc']
        if proc.returncode is None:
            assert_owned(h, self.proc_starttime(h['pid']))
        h['stopping'], ev = True, {'pid': h['pid'], 'signals': [], 'unmount': []}
        leader, alive = self._await_gone(h, 0)
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            if leader and not alive:
                break
            ev['signals'] += [[int(sig), how, pid] for how, pid in self._signal_owned(h, sig, alive)]
            leader, alive = self._await_gone(h, wait)
        if not leader or alive:
            refuse('cleanup', f'exporter {h["pid"]}: leader exited {leader}, owned survivors {alive[:8]} after TERM/KILL')
        for _ in range(2):
            if not self.ismount(h['mount']):
                break
            if not fusermount:
                refuse('cleanup', f'{h["mount"]} still mounted and no pinned unmount tool was supplied')
            rc, _, err = self.run([fusermount, '-u', h['mount']], 10, h['limit'])
            ev['unmount'].append({'rc': rc, 'stderr': err[:512].decode('utf-8', 'replace')})
        if self.ismount(h['mount']):
            refuse('cleanup', f'{h["mount"]} still mounted after owned processes exited ({ev["unmount"]})')
        with h['lock']:
            if proc.returncode is None:
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    refuse('cleanup', f'exporter leader {h["pid"]} could not be reaped')
            h['reaped'] = True
        t = h.get('drainer')
        if t is not None:
            t.join(self.join_seconds)
            if t.is_alive():
                refuse('cleanup', f'exporter {h["pid"]} stderr drainer did not finish (pipe still held open)')
        if getattr(proc, 'stderr', None) is not None:
            proc.stderr.close()
        kept = h['stderrKept']
        ev.update(exit=proc.returncode, owned=sorted(h['owned']), survivors=[], mountPresent=False, fault=h['fault'],
                  stderrBytes=h['stderrBytes'], stderrSha256=hashlib.sha256(kept).hexdigest(),
                  stderrHead=kept[:2048].decode('utf-8', 'replace'), drainerJoined=True, result='complete')
        h['closed'] = ev
        return ev


# ---------------------------------------------------------------------------------------------------------------- writer
class Writer:
    def __init__(self, plan, plan_sha, lock_fds, fx, writer_path):
        self.p, self.plan_sha, self.lock_fds, self.fx, self.writer_path = plan, plan_sha, lock_fds, fx, writer_path
        self.b, self.t = plan['bounds'], {k: v['path'] for k, v in plan['tools'].items()}
        self.deadline = Deadline(self.b['totalSeconds'], fx.monotonic)
        self.deadline.probe = self.check_exporters
        d = plan['destination']
        self.work = os.path.join(d['parentDir'], d['workDirName'])
        self.deriv = os.path.join(self.work, 'derivative.qcow2')
        self.marker = os.path.join(d['parentDir'], d['workDirName'] + '.operation')
        self.phase, self.ev, self.handles, self.qlocks = 'preflight', {}, [], []
        self.work_created = self.mutation_started = False
        self.ops_done, self.export_n, self.log_bytes, self.pending_log = [], 0, 0, []

    # --- helpers
    def log(self, argv, rc, out, err):
        rec = (json.dumps({'phase': self.phase, 'argv': argv, 'rc': rc, 'stdoutBytes': len(out),
                           'stdoutSha256': hashlib.sha256(out).hexdigest(), 'stderr': err[:2048].decode('utf-8', 'replace')})
               + '\n').encode()
        self.log_bytes += len(rec)
        if self.log_bytes > self.b['maxLogBytes']:
            refuse('bounds', 'command log exceeded maxLogBytes')
        if self.work_created:
            self.fx.append_sync(os.path.join(self.work, 'COMMANDS.jsonl'), b''.join(self.pending_log) + rec)
            self.pending_log = []
        else:
            self.pending_log.append(rec)

    def run(self, argv, cap=None):
        rc, out, err = self.fx.run(argv, self.deadline.left(self.phase, cap or self.b['commandSeconds']),
                                   self.b['maxOutputBytes'])
        self.log(argv, rc, out, err)
        return rc, out, err

    def safe_existing(self, path, want, phase):
        """every component lstat'd from /: no symlinks, ancestors not group/world-writable"""
        parts, cur = path.split('/')[1:], ''
        for i, c in enumerate(parts):
            cur += '/' + c
            st = self.fx.lstat(cur)
            last = i == len(parts) - 1
            if stat.S_ISLNK(st['mode']):
                refuse(phase, f'{cur} is a symlink')
            if not last and (not stat.S_ISDIR(st['mode']) or (st['mode'] & 0o022 and not st['mode'] & stat.S_ISVTX)):
                refuse(phase, f'{cur} is not a safe ancestor directory')
        if (want == 'file' and not stat.S_ISREG(st['mode'])) or (want == 'dir' and not stat.S_ISDIR(st['mode'])):
            refuse(phase, f'{path} is not a {want}')
        return st

    def tool_hashes(self):
        out = {}
        for name, t in self.p['tools'].items():
            st = self.safe_existing(t['path'], 'file', 'tools')
            if st['uid'] != 0 or st['mode'] & 0o022:
                refuse('tools', f'{name} is not root-owned/non-writable')
            got = self.fx.hash_file(t['path'], self.deadline, 'tools')[0]
            if got != t['sha256']:
                refuse('tools', f'{name} sha256 {got} differs from the pin')
            out[name] = got
        return out

    def check_identity(self, key, full_hash):
        r = self.p[key]
        st = self.safe_existing(r['path'], 'file', 'identity')
        got = {'device': st['dev'], 'inode': st['ino'], 'size': st['size'], 'mtimeNs': st['mtimeNs']}
        if got != {k: r[k] for k in got}:
            refuse('identity', f'{key} stat identity drifted: {got}')
        if st['nlink'] != 1:
            refuse('identity', f'{key} has hard links')
        rec = dict(got, ctimeNs=st['ctimeNs'], path=r['path'])
        if full_hash:
            sha, before, after = self.fx.hash_file(r['path'], self.deadline, 'identity')
            if before != after or sha != r['sha256']:
                refuse('identity', f'{key} content drifted during/after hashing')
            rec['sha256'] = sha
        return rec

    def vm_stopped(self):
        out = {}
        for u in self.p['vmUnits']:
            rc, so, _ = self.run([self.t['systemctl'], '--user', 'show', '--property=LoadState', '--property=ActiveState',
                                  '--property=MainPID', '--', u])
            kv = dict(l.split('=', 1) for l in so.decode('utf-8', 'replace').splitlines() if '=' in l)
            if rc or kv.get('LoadState') != 'loaded' or kv.get('ActiveState') not in ('inactive', 'failed') or \
                    kv.get('MainPID') != '0':
                refuse('vm', f'{u} is not a loaded, stopped unit ({kv or rc})')
            out[u] = kv
        return out

    def holders(self, idents):
        if 'holderPolicy' in self.p:
            return self.private_holders(idents)
        h, unreadable = self.fx.scan_holders(idents)
        if h or unreadable:
            refuse('holders', f'image holders {h} or unreadable processes {unreadable[:20]}: holder scope incomplete')
        return {'holders': [], 'unreadable': [], 'note': 'process scan is supplementary to QEMU and workflow locks'}

    def capacity(self, extra_written):
        d, im = self.p['destination'], self.p['image']
        worst = max(self.p['backup']['size'], im['virtualSize'] + d['qcowMetadataAllowanceBytes'])
        need = worst - extra_written + d['evidenceMarginBytes'] + d['workingMarginBytes'] + d['floorBytes']
        v = self.fx.statvfs(d['parentDir'])
        if v['dev'] != d['device'] or v['dev'] in d['forbiddenDevices']:
            refuse('capacity', 'destination is not the reviewed filesystem')
        if v['availBytes'] < need:
            refuse('capacity', f'{v["availBytes"]} bytes available < required {need}')
        return {'availBytes': v['availBytes'], 'requiredBytes': need, 'worstCaseDerivativeBytes': worst}

    # --- exports
    def export(self, kind):
        self.export_n += 1
        mnt = os.path.join(self.work, f'mnt-{self.export_n}-{kind}')
        self.fx.mkdir_excl(mnt, 0o700)
        im, r = self.p['image'], self.ev.get('root')
        nbdfuse, qnbd = self.t['nbdfuse'], self.t['qemu-nbd']
        if kind == 'full-ro':
            f, size = os.path.join(mnt, 'disk.raw'), im['virtualSize']
            argv = [nbdfuse, '-r', f, '[', qnbd, '-r', '-f', 'qcow2', self.deriv, ']']
        else:
            f, size = os.path.join(mnt, 'root.ext4'), r['length']
            opts = (f'driver=raw,offset={r["offset"]},size={r["length"]},file.driver=qcow2,file.file.driver=file,'
                    f'file.file.filename={self.deriv}')
            argv = [nbdfuse] + (['-r'] if kind == 'root-ro' else []) + [f, '[', qnbd] + \
                (['-r'] if kind == 'root-ro' else []) + ['--image-opts', opts, ']']
        # export_start registers the handle in self.handles before anything can fail or be cancelled
        h = self.fx.export_start(argv, mnt, f, size, self.deadline.left('export', self.b['exportStartSeconds']),
                                 self.b['maxOutputBytes'], self.handles.append, self.t['fusermount3'])
        self.log(argv, None, b'', b'')
        return h

    def unexport(self, h):
        try:
            self.fx.export_stop(h, self.t['fusermount3'], self.deadline.left('export', self.b['exportStopSeconds']),
                                self.b['maxOutputBytes'])
        finally:
            if h.get('closed') and h in self.handles:
                self.handles.remove(h)
                self.ev.setdefault('exporters', []).append(h['closed'])

    def check_exporters(self):
        for h in self.handles:
            f = self.fx.export_fault(h)
            if f:
                refuse('export', f'background exporter failure: {f}')

    def assert_quiesced(self):
        """READY only with no registered exporter and every teardown complete, drainer joined, no background fault"""
        self.check_exporters()
        bad = [e.get('pid') for e in self.ev.get('exporters', [])
               if e.get('result') != 'complete' or e.get('fault') or not e.get('drainerJoined')]
        if self.handles or bad:
            refuse('final', f'exporters still registered {[h["pid"] for h in self.handles]} or failed teardown {bad}')

    # --- RO-to-RW revalidation and per-operation identity (writable root slice)
    def ancestors(self, dbg):
        anc = {}
        for a in ANCESTORS:
            anc[a] = dbg.stat(a)
            check_ancestor(anc[a], a)
        anc['/lib'] = dbg.stat('/lib')
        keep_exists, keep_before = 'enclave-rpc-maint' in lsmap(dbg, '/var/lib'), []
        if keep_exists:
            anc[KEEP] = dbg.stat(KEEP)
            check_ancestor(anc[KEEP], KEEP)
            keep_before = sorted(lsmap(dbg, KEEP))
            if self.p['stamp'] in keep_before:
                refuse('preconditions', 'rollback directory for this stamp already exists')
        return anc, keep_exists, keep_before

    def rollback_inputs(self, dbg, frag, links, keep_exists):
        for u in UNITS:
            check_record(frag[u], f'{ETC}/{u}', 'regular')
        xattrs = {u: dbg.ea_list(f'{ETC}/{u}') for u in UNITS}
        links = link_records(dbg, links)
        parents = {ETC, '/var/lib'} | ({KEEP} if keep_exists else set()) | {l['path'].rsplit('/', 1)[0] for l in links}
        return xattrs, links, {d: lsmap(dbg, d) for d in sorted(parents)}

    def revalidate(self, dbg, base, frag, links, anc, dirmaps):
        """on the writable export, before the first write: the entire precomputed mutation input must be unchanged"""
        ph = 'revalidate'
        if list(guest_dirs(dbg, self.p['usrMerge'])) != base['dirs']:
            refuse(ph, 'unit directory set (usr-merge state) changed')
        for a, st in anc.items():
            if dbg.stat(a) != st:
                refuse(ph, f'{a}: ancestor metadata changed')
        inv = inventory(dbg, base['dirs'], self.b['maxInventoryEntries'])
        for k in ('entries', 'hashes', 'directives'):
            if inv[k] != base[k]:
                refuse(ph, f'unit-tree {k} changed between read-only inventory and writable export')
        for u in UNITS:
            if dbg.stat(f'{ETC}/{u}') != frag[u]:
                refuse(ph, f'{u}: fragment inode metadata changed between read-only inventory and writable export')
            dbg.ea_list(f'{ETC}/{u}')
        for l in links:
            if dbg.stat(l['path']) != l['stat']:
                refuse(ph, f'{l["path"]}: enablement link metadata changed')
            dbg.ea_list(l['path'])
        model = {}
        for d, want in dirmaps.items():
            if lsmap(dbg, d) != want:
                refuse(ph, f'{d}: directory entries changed')
            model[d] = dict(want)
        if (self.p['stamp'] in model[KEEP]) if KEEP in model else ('enclave-rpc-maint' in model['/var/lib']):
            refuse(ph, 'rollback parent/new name appeared after the read-only inventory')
        return model

    def guard(self, dbg, op, frag, links, model):
        """immediately before a write: the parent holds exactly what our own completed steps left, and the object the
        step consumes is the exact recorded one"""
        p, ph = op['path'], 'mutate'
        parent, name = p.rsplit('/', 1)
        if parent not in model or lsmap(dbg, parent) != model[parent]:
            refuse(ph, f'{parent}: entries differ from the expected state before {op["op"]} {p}')
        if op['op'] in ('mkdir', 'ln', 'symlink') and name in model[parent]:
            refuse(ph, f'{p}: unexpected occupant before {op["op"]}')
        if op['op'] in ('ln', 'unlink'):
            u, src = op['unit'], f'{ETC}/{op["unit"]}'
            if model[ETC].get(u) != frag[u]['inode'] or dbg.stat(src) != frag[u]:
                refuse(ph, f'{src} is not the recorded original fragment before {op["op"]}')
        if op['op'] == 'unlink':
            arch_dir = f'{KEEP}/{self.p["stamp"]}'
            if model.get(arch_dir, {}).get(u) != frag[u]['inode'] or dbg.stat(f'{arch_dir}/{u}') != frag[u]:
                refuse(ph, f'{arch_dir}/{u} does not reference the original inode before unlink')
            dbg.ea_list(src)
        if op['op'] == 'rm':
            rec = next((l for l in links if l['path'] == p), None)
            if rec is None or model[parent].get(name) != rec['stat']['inode'] or dbg.stat(p) != rec['stat']:
                refuse(ph, f'{p} is not the recorded enablement link before rm')

    def settle(self, dbg, op, frag, model):
        """after a write: the parent changed by exactly our own step (no other occupant appeared or vanished)"""
        p = op['path']
        parent, name = p.rsplit('/', 1)
        want = dict(model[parent])
        if op['op'] in ('unlink', 'rm'):
            want.pop(name, None)
        elif op['op'] == 'ln':
            want[name] = frag[op['unit']]['inode']
        else:
            ino = dbg.stat(p)['inode']
            if ino in want.values():
                refuse('mutate', f'{p}: {op["op"]} did not create a fresh inode')
            want[name] = ino
        if lsmap(dbg, parent) != want:
            refuse('mutate', f'{parent}: entries after {op["op"]} {p} differ from the single expected change')
        model[parent] = want
        if op['op'] == 'mkdir':
            if lsmap(dbg, p) != {}:
                refuse('mutate', f'{p}: new directory is not empty')
            model[p] = {}

    def fsck(self, dev):
        rc, out, err = self.run([self.t['e2fsck'], '-fn', dev], self.b['fsckSeconds'])
        if rc != 0:
            refuse('fsck', f'e2fsck -f -n exit {rc} (no correction attempted)')
        return {'rc': 0, 'stdoutSha256': hashlib.sha256(out).hexdigest()}

    def qcheck(self):
        rc, out, _ = self.run([self.t['qemu-img'], 'check', '-f', 'qcow2', self.deriv], self.b['fsckSeconds'])
        if rc != 0 or b'No errors were found on the image.' not in out:
            refuse('qcow2', f'qemu-img check exit {rc} (nonrepairing; not accepted)')
        return {'rc': 0}

    def full_image_facts(self, dev):
        im, read = self.p['image'], (lambda o, n: self.fx.read_at(dev, o, n))
        gpt = parse_gpt(read, im['virtualSize'], im['sectorSize'])
        sbs = {x['index']: parse_ext4_sb(read(x['first'] * im['sectorSize'] + 1024, 1024))
               for x in gpt['partitions'] if x['type'] == im['rootTypeGuid']}
        part, off, length = select_root(gpt, im, sbs, self.p['filesystem'])
        validate_sb(sbs[part['index']], self.p['filesystem'], length)
        regions = [(0, off), (off + length, im['virtualSize'] - off - length)]
        return gpt, {'offset': off, 'length': length, 'partition': part}, \
            [self.fx.hash_region(dev, s, n, self.deadline, 'gpt') for s, n in regions]

    def root_facts(self, dev):
        sb = validate_sb(parse_ext4_sb(self.fx.read_at(dev, 1024, 1024)), self.p['filesystem'], self.ev['root']['length'])
        dbg = Debugfs(self.fx, self.t['debugfs'], dev, self.b, self.deadline, self.log)
        dirs = guest_dirs(dbg, self.p['usrMerge'])
        inv = inventory(dbg, dirs, self.b['maxInventoryEntries'])
        return sb, dbg, inv

    # --- mutation (writable root slice)
    def apply(self, dbg, op, frag_stats):
        p = op['path']
        parent, name = p.rsplit('/', 1)
        names = lambda d: {e['name'] for e in dbg.ls(d)}
        self.fx.append_sync(os.path.join(self.work, 'MUTATION-JOURNAL.jsonl'),
                            (json.dumps({'begin': op}) + '\n').encode())
        if op['op'] == 'mkdir':
            if name in names(parent):
                refuse('mutate', f'{p} already exists')
            dbg.call(f'mkdir {p}', True)
            dbg.call(f'sif {p} mode 040700', True)
            st = dbg.stat(p)
            if (st['type'], st['uid'], st['gid'], st['perm']) != ('directory', 0, 0, 0o700):
                refuse('mutate', f'{p} not a root-owned 0700 directory after mkdir')
        elif op['op'] == 'ln':
            want = frag_stats[op['unit']]
            if name in names(parent):
                refuse('mutate', f'archive name {p} collides')
            dbg.call(f'ln <{want["inode"]}> {p}', True)
            st = dbg.stat(p)
            if st != want:
                refuse('mutate', f'{p} does not reference the exact original inode with unchanged metadata')
        elif op['op'] == 'unlink':
            dbg.call(f'unlink {p}', True)
            if name in names(parent):
                refuse('mutate', f'{p} still present after unlink')
            arch = dbg.stat(f'{KEEP}/{self.p["stamp"]}/{op["unit"]}')
            if arch != frag_stats[op['unit']]:
                refuse('mutate', f'{op["unit"]} archived inode changed after unlink (link count must stay 1)')
        elif op['op'] == 'symlink':
            dbg.call(f'symlink {p} /dev/null', True)
            st = dbg.stat(p)
            if st['type'] != 'symlink' or st['target'] != '/dev/null':
                refuse('mutate', f'{p} is not a /dev/null mask')
        elif op['op'] == 'rm':
            dbg.call(f'rm {p}', True)
            if name in names(parent):
                refuse('mutate', f'{p} still present after rm')
        else:
            refuse('mutate', 'unknown op')
        self.ops_done.append(op)
        self.fx.append_sync(os.path.join(self.work, 'MUTATION-JOURNAL.jsonl'), (json.dumps({'done': op}) + '\n').encode())

    # --- workflow
    def execute(self):
        p, fx = self.p, self.fx
        if self.writer_path != p['writerSource']['path'] or \
                fx.hash_file(self.writer_path, self.deadline, 'pins')[0] != p['writerSource']['sha256']:
            refuse('pins', 'running writer source is not the reviewed file')
        self.safe_existing(p['unitPins']['path'], 'file', 'pins')
        validate_unit_pins(fx.read_bounded(p['unitPins']['path'], 1 << 16), p['unitPins']['sha256'])
        self.ev['tools'] = self.tool_hashes()
        scope = fx.resource_scope()
        if scope != p['resourceEnvelope']:
            refuse('scope', f'observed resource scope {scope} is not the reviewed envelope')
        self.ev['scope'] = scope
        if len(self.lock_fds) != len(p['workflowLocks']):
            refuse('locks', 'each plan workflow lock needs exactly one inherited --lock-fd')
        for fd, lk in zip(self.lock_fds, p['workflowLocks']):
            e = fx.lock_evidence(fd, lk['path'])
            if (e['dev'], e['ino']) != (lk['device'], lk['inode']) or not (e['pathMatches'] and e['fdHoldsFlockWrite']
                                                                            and e['freshTrylockBlocked']):
                refuse('locks', f'workflow lock {lk["path"]} is not held exclusively by the caller-supplied fd')
        self.ev['vmBefore'] = self.vm_stopped()
        rec = self.p['backup']
        self.safe_existing(rec['receiptPath'], 'file', 'identity')
        receipt = fx.read_bounded(rec['receiptPath'], 1 << 20)
        if hashlib.sha256(receipt).hexdigest() != rec['receiptSha256'] or rec['sha256'].encode() not in receipt:
            refuse('identity', 'backup receipt hash differs or does not state the backup sha256')
        self.safe_existing(p['destination']['parentDir'], 'dir', 'identity')
        idents = {(p[k]['device'], p[k]['inode']) for k in ('source', 'backup')}
        self.ev['holdersBefore'] = self.holders(idents)
        for k in ('source', 'backup'):
            self.qlocks.append(fx.hold_qemu_locks(p[k]['path'], p[k]))
        self.ev['sourceBefore'] = self.check_identity('source', True)
        self.ev['backupBefore'] = self.check_identity('backup', False)   # full hash is taken by the copy stream
        self.ev['capacityBefore'] = self.capacity(0)

        self.phase = 'copy'
        fx.write_excl(self.marker, json.dumps({'operationId': p['operationId'], 'planSha256': self.plan_sha,
                                               'startedAt': fx.time()}).encode(), 0o444)
        fx.mkdir_excl(self.work, 0o700)
        self.work_created = True
        wst = self.safe_existing(self.work, 'dir', 'copy')
        if wst['dev'] != p['destination']['device']:
            refuse('copy', 'work directory is not on the reviewed filesystem')
        self.private_check('work', wst)
        copied = fx.sparse_copy(p['backup']['path'], p['backup'], self.deriv, self.deadline)
        if copied != p['backup']['sha256']:
            refuse('copy', 'backup stream hash differs from the verified backup sha256')
        self.ev['backupBefore']['sha256'] = copied
        dst = self.safe_existing(self.deriv, 'file', 'copy')
        if (dst['dev'], dst['ino']) in idents or dst['nlink'] != 1 or dst['size'] != p['backup']['size']:
            refuse('copy', 'derivative is not a distinct single-link file of the backup size')
        if fx.hash_file(self.deriv, self.deadline, 'copy')[0] != p['backup']['sha256']:
            refuse('copy', 'derivative initial full hash differs from the backup')
        self.ev['derivativeInitial'] = {'sha256': p['backup']['sha256'], 'dev': dst['dev'], 'ino': dst['ino'],
                                        'size': dst['size'], 'blocks': dst['blocks']}
        self.ev['capacityAfterCopy'] = self.capacity(dst['blocks'] * 512)
        if self.check_identity('backup', False) != {k: v for k, v in self.ev['backupBefore'].items() if k != 'sha256'}:
            refuse('identity', 'backup changed during copy')
        self.private_check('derivative', dst)

        self.phase = 'qcow2'
        self.ev['qcow2Header'] = parse_qcow2_header(fx.read_at(self.deriv, 0, 4096), dst['size'])
        if self.ev['qcow2Header']['virtualSize'] != p['image']['virtualSize']:
            refuse('qcow2', 'header virtual size differs from the plan')
        rc, out, _ = self.run([self.t['qemu-img'], 'info', '--output=json', '-f', 'qcow2', self.deriv])
        try:
            info = json.loads(out.decode('utf-8')) if rc == 0 else None
        except (UnicodeDecodeError, ValueError):
            info = None
        self.ev['qemuInfo'] = validate_qemu_info(info, p['image'])
        self.ev['qcowCheckBefore'] = self.qcheck()

        self.phase = 'gpt'
        h = self.export('full-ro')
        gpt, root, outside = self.full_image_facts(h['file'])
        self.unexport(h)
        self.ev.update(gptBefore=gpt, root=root, outsideRootBefore=outside)

        self.phase = 'inventory'
        h = self.export('root-ro')
        sb, dbg, base = self.root_facts(h['file'])
        self.ev['fsckBefore'] = self.fsck(h['file'])
        anc, keep_exists, keep_before = self.ancestors(dbg)
        frag = {u: dbg.stat(f'{ETC}/{u}') for u in UNITS}
        links = check_preconditions(base, frag, p)
        frag_xattrs, links, dirmaps = self.rollback_inputs(dbg, frag, links, keep_exists)
        self.unexport(h)
        self.ev.update(superblockBefore=sb, inventoryBefore=base, fragmentsBefore=frag, enablementLinks=links,
                       ancestorsBefore=anc, fragmentXattrs=frag_xattrs)
        ops = build_ops(p, links, keep_exists)

        self.phase = 'receipt'
        fx.write_excl(os.path.join(self.work, 'ROLLBACK.json'), json.dumps({
            'format': FORMAT_ROLLBACK, 'operationId': p['operationId'], 'derivative': self.deriv,
            'fragments': {u: {'path': f'{ETC}/{u}', 'archive': f'{KEEP}/{p["stamp"]}/{u}', 'sha256': UNITS[u],
                              'stat': frag[u], 'xattrs': frag_xattrs[u], 'directives': base['directives'].get(u, [])}
                          for u in UNITS},
            'enablementLinks': links, 'operations': ops,
            'restore': 'from these records only; never infer link targets from unit names'}, sort_keys=True).encode(), 0o444)

        self.phase = 'mutate'
        self.private_check('mutate')
        h = self.export('root-rw')
        wsb = validate_sb(parse_ext4_sb(fx.read_at(h['file'], 1024, 1024)), p['filesystem'], root['length'])
        wdbg = Debugfs(fx, self.t['debugfs'], h['file'], self.b, self.deadline, self.log)
        model = self.revalidate(wdbg, base, frag, links, anc, dirmaps)
        self.mutation_started = True
        for op in ops:
            self.guard(wdbg, op, frag, links, model)
            self.apply(wdbg, op, frag)
            self.settle(wdbg, op, frag, model)
        self.unexport(h)
        self.ev['superblockAtWrite'] = wsb

        self.phase = 'verify'
        h = self.export('root-ro')
        sb2, vdbg, post = self.root_facts(h['file'])
        self.ev['fsckAfter'] = self.fsck(h['file'])
        archived = {u: vdbg.stat(f'{KEEP}/{p["stamp"]}/{u}') for u in UNITS}
        self.ev['archivedXattrs'] = {u: vdbg.ea_list(f'{KEEP}/{p["stamp"]}/{u}') for u in UNITS}
        bad = semantic_delta(base, post, links) + verify_archive(frag, archived, vdbg.ls(f'{KEEP}/{p["stamp"]}'))
        for u in UNITS:
            if hashlib.sha256(vdbg.cat(f'{KEEP}/{p["stamp"]}/{u}')).hexdigest() != UNITS[u]:
                bad.append(f'{u}: archived content hash differs')
        if sorted(e['name'] for e in vdbg.ls(KEEP)) != sorted(keep_before + [p['stamp']]):
            bad.append(f'{KEEP} contains entries beyond the new rollback directory')
        self.unexport(h)
        if bad:
            refuse('verify', '; '.join(bad[:20]))
        same = ('uuid', 'label', 'blockSize', 'blocksCount', 'inodesCount', 'featureCompat', 'featureIncompat',
                'featureRoCompat', 'state')
        if any(sb2[k] != sb[k] for k in same):
            refuse('verify', 'superblock identity/features changed')
        self.ev.update(inventoryAfter=post, archived=archived, superblockAfter=sb2)

        h = self.export('full-ro')
        gpt2, root2, outside2 = self.full_image_facts(h['file'])
        self.unexport(h)
        if gpt2 != gpt or root2 != root or outside2 != outside:
            refuse('verify', 'GPT or bytes outside the root partition changed')

        self.phase = 'final'
        self.ev['qcowCheckAfter'] = self.qcheck()
        fx.chmod(self.deriv, 0o400)
        fx.fsync_file(self.deriv); fx.fsync_dir(self.work)
        sha, before, after = fx.hash_file(self.deriv, self.deadline, 'final')
        if before != after:
            refuse('final', 'derivative changed while hashing')
        self.ev['derivativeFinal'] = dict(after, sha256=sha, path=self.deriv)
        self.ev['sourceAfter'] = self.check_identity('source', True)
        self.ev['backupAfter'] = self.check_identity('backup', True)
        for k in ('source', 'backup'):
            if self.ev[k + 'After'] != self.ev[k + 'Before']:
                refuse('final', f'{k} identity or content changed during the operation')
        self.ev['vmAfter'] = self.vm_stopped()
        self.ev['toolsAfter'] = self.tool_hashes()
        if self.ev['toolsAfter'] != self.ev['tools']:
            refuse('final', 'tool bytes changed during the operation')
        self.ev['holdersAfter'] = self.holders(idents | {(after['dev'], after['ino'])})
        self.assert_quiesced()
        return 'READY'

    def receipt(self, status, error=None):
        if 'holderPolicy' in self.p:
            return self.private_receipt(status, error)
        body = {'format': FORMAT_RECEIPT, 'status': status, 'operationId': self.p['operationId'], 'planSha256': self.plan_sha,
                'writerSha256': self.p['writerSource']['sha256'], 'unitPinsSha256': self.p['unitPins']['sha256'],
                'state': 'verified-derivative-not-activated' if status == 'READY' else 'failed-nonpublishable',
                'publishable': status == 'READY', 'running': False, 'rpcReady': False,
                'unqualifiedPrimitivesAccepted': sorted(UNQUALIFIED), 'derivative': self.deriv,
                'mutationStarted': self.mutation_started, 'operationsCompleted': self.ops_done,
                'phase': self.phase, 'error': error, 'evidence': self.ev}
        return json.dumps(body, sort_keys=True, default=str).encode()

    # --- private-derivative policy (opt-in): reached only when the hash-pinned plan carries holderPolicy
    def private_holders(self, idents):
        if self.phase == 'preflight':
            return self.private_gate(idents)
        if self.phase != 'final':
            refuse('policy', f'unexpected holder scan in phase {self.phase}')
        self.private_check('final')
        holders, unreadable = self.fx.scan_holders(idents)
        if holders:
            refuse('holders', f'image holders {holders} at the final scan')
        return self.private_scan(holders, unreadable)

    def private_gate(self, idents):
        """initial holder gate of the explicit alternative: pinned evidence, actual euid, every access chain from /, absent
        new names, then the REAL global scan.  Known holders refuse; unreadable process ids are retained as incomplete
        visibility (never replaced by an empty result) and do not alone refuse once the access boundary holds"""
        p, fx = self.p, self.fx
        hp = p['holderPolicy']
        raw = {}
        for key in ('pathAccess', 'coordination'):
            ref = hp['evidence'][key]
            self.safe_existing(ref['path'], 'file', 'policy')
            raw[key] = fx.read_bounded(ref['path'], EVIDENCE_LIMITS[key])
        access = validate_path_access(raw['pathAccess'], hp['evidence']['pathAccess']['sha256'], p)
        coord = validate_coordination(raw['coordination'], hp['evidence']['coordination']['sha256'], p)
        euid = fx.euid()
        if euid != hp['maintenanceUid']:
            refuse('policy', f'effective uid {euid} is not the declared non-root maintenance UID {hp["maintenanceUid"]}')
        self.private = {'access': access, 'work': None, 'marker': None, 'derivative': None,
                        'pinned': {(x['device'], x['inode']) for c in access['chains'].values() for x in c}}
        self.ev['privateBoundary'] = {
            'policy': POLICY_KIND, 'policySha256': policy_sha(hp), 'maintenanceUid': euid,
            'evidence': {k: dict(v) for k, v in hp['evidence'].items()},
            'coordination': {k: coord[k] for k in ('operator', 'lifecycleProducers', 'sameUidActorDiscovery',
                                                   'operatorAssertions')},
            'checks': {}}
        checks = self.private_chains('preflight')
        for path in (self.work, self.marker):
            try:
                fx.lstat(path)
            except FileNotFoundError:
                continue
            refuse('access', f'{path} already exists: the private work directory and marker must be new')
        checks['newNamesAbsent'] = [self.work, self.marker]
        holders, unreadable = fx.scan_holders(idents)
        if holders:
            refuse('holders', f'image holders {holders}: known holders refuse under the private-derivative policy too')
        return self.private_scan(holders, unreadable)

    def private_scan(self, holders, unreadable):
        unreadable = sorted(unreadable)
        return {'holders': sorted(holders), 'unreadable': unreadable, 'unreadableCount': len(unreadable),
                'completeHostHolderVisibility': False, 'policy': POLICY_KIND,
                'hostVisibility': 'incomplete-not-asserted' if unreadable else 'not-asserted',
                'note': 'actual global /proc scan; unreadable ids are retained, not disproven; supplementary to QEMU OFD '
                        'and workflow locks; no universal host-holder claim'}

    def private_chains(self, phase):
        """re-observe every pinned component of source, backup and destination parent; directory times/nlink are not
        pinned (our own marker/work creation changes them), security identity/permissions/ACL state are"""
        hp, out = self.p['holderPolicy'], {}
        for key in CHAIN_KEYS:
            chain, recs = self.private['access']['chains'][key], []
            for i, pin in enumerate(chain):
                perm = None
                if i == len(chain) - 1:
                    perm = 0o700 if key == 'destinationParent' else hp['inputModes'][key]
                recs.append(check_access(self.fx.access_meta(pin['path']), hp['maintenanceUid'], 'access', pin['type'],
                                         perm, pin))
            out[key] = recs
        self.ev['privateBoundary']['checks'][phase] = out
        return out

    def private_new(self, path, want, perm, ident):
        """an object THIS operation created: maintenance-UID owned with the exact mode, no ACL, on the reviewed destination
        filesystem, not any pinned pre-existing identity, and still the identity first recorded for it"""
        rec = check_access(self.fx.access_meta(path), self.p['holderPolicy']['maintenanceUid'], 'access', want, perm)
        got = (rec['device'], rec['inode'])
        if rec['device'] != self.p['destination']['device'] or got in self.private['pinned']:
            refuse('access', f'{path} is not a new object on the reviewed destination filesystem')
        if ident is not None and got != ident:
            refuse('access', f'{path} identity {got} is not the recorded {ident}')
        return rec

    def private_marker(self):
        pv = self.private
        rec = self.private_new(self.marker, 'regular', 0o444, pv['marker'])
        try:
            m = json.loads(self.fx.read_bounded(self.marker, 4096).decode('utf-8'), object_pairs_hook=_no_dupes)
        except (UnicodeDecodeError, ValueError):
            refuse('access', 'operation marker is not strict JSON')
        if not isinstance(m, dict) or m.get('operationId') != self.p['operationId'] or m.get('planSha256') != self.plan_sha:
            refuse('access', 'operation marker does not belong to this operation')
        pv['marker'] = (rec['device'], rec['inode'])
        return rec

    def private_check(self, phase, st=None):
        """inserted workflow check; without plan['holderPolicy'] it returns before touching any effect"""
        if 'holderPolicy' not in self.p:
            return None
        pv, p = getattr(self, 'private', None), self.p
        if phase not in ('work', 'derivative', 'mutate', 'final') or pv is None or \
                (pv['work'] is None) != (phase == 'work') or (phase in ('mutate', 'final') and pv['derivative'] is None):
            refuse('policy', f'private boundary check {phase} out of order')
        checks = self.private_chains(phase)
        if phase == 'work':
            pv['work'] = (st['dev'], st['ino'])
        checks['work'] = self.private_new(self.work, 'directory', 0o700, pv['work'])
        checks['marker'] = self.private_marker()
        if phase == 'work':
            return checks
        if phase == 'derivative':
            di, want = self.ev['derivativeInitial'], p['backup']['sha256']
            if di['sha256'] != want or self.ev['backupBefore'].get('sha256') != want:
                refuse('access', 'initial backup stream/derivative readback are not the trusted backup digest')
            if (st['dev'], st['ino']) != (di['dev'], di['ino']):
                refuse('access', 'derivative identity differs from the initial readback identity')
            pv['derivative'] = (di['dev'], di['ino'])
        checks['derivative'] = self.private_new(self.deriv, 'regular', 0o400 if phase == 'final' else 0o600,
                                                pv['derivative'])
        return checks

    def private_receipt(self, status, error=None):
        """never the default READY/publishable shape: a distinct format, publishable false, explicit scope of claims"""
        p, ev, hp = self.p, self.ev, self.p['holderPolicy']
        prepared, want = status == 'READY', p['backup']['sha256']
        body = {
            'format': FORMAT_PRIVATE_RECEIPT, 'status': 'PRIVATE-PREPARED' if prepared else 'FAILED',
            'operationId': p['operationId'], 'planSha256': self.plan_sha, 'writerSha256': p['writerSource']['sha256'],
            'unitPinsSha256': p['unitPins']['sha256'],
            'state': 'private-derivative-prepared-not-activated-not-published' if prepared else 'failed-private-nonpublishable',
            'artifactPreparedPrivately': prepared, 'publishable': False, 'publicationAuthorized': False,
            'activated': False, 'published': False, 'booted': False, 'running': False, 'rpcReady': False,
            'holderPolicy': {'kind': POLICY_KIND, 'policySha256': policy_sha(hp), 'maintenanceUid': hp['maintenanceUid'],
                             'evidence': {k: dict(v) for k, v in hp['evidence'].items()},
                             'trustBoundary': 'local host root and the maintenance UID trusted by explicit declaration; '
                                              'untrusted same-UID commands/plugins excluded by operator assertion, '
                                              'not discovered'},
            'hostVisibility': 'incomplete-not-asserted', 'completeHostHolderVisibility': False,
            'holderObservations': {'before': ev.get('holdersBefore'), 'after': ev.get('holdersAfter')},
            'accessChecks': ev.get('privateBoundary', {}).get('checks', {}),
            'claims': {
                'inputsOpenedReadOnlyByThisWriter': True,
                'initialBackupStreamAndDerivativeReadbackEqualExpectedDigest':
                    ev.get('derivativeInitial', {}).get('sha256') == want and ev.get('backupBefore', {}).get('sha256') == want,
                'endpointInputIdentitiesTimesDigestsMatch':
                    all(k + 'After' in ev and ev[k + 'After'] == ev.get(k + 'Before') for k in ('source', 'backup')),
                'finalDerivativeSha256RecordsResult': ev.get('derivativeFinal', {}).get('sha256'),
                'scopedGuestVerification': 'unit-tree semantic delta, rollback archive, superblock identity, GPT and '
                                           'outside-root byte hashes, e2fsck -f -n and qemu-img check as recorded'},
            'notClaimed': ['inputs continuously untouched by other actors between the endpoint checks',
                           'every guest root byte compared against a precomputed expected final output',
                           'complete host holder visibility or absence of unreadable holders',
                           'protection from hostile root or same-UID actors, ptrace or descriptor transfer',
                           'revocation of descriptors opened before chmod or private ancestry checks',
                           'publication, activation, boot or replacement authority'],
            'consumerRequirement': 'not a publication input: a consumer must separately admit publication and re-verify '
                                   'the final derivative identity and full sha256 itself',
            'unqualifiedPrimitivesAccepted': sorted(UNQUALIFIED), 'derivative': self.deriv,
            'mutationStarted': self.mutation_started, 'operationsCompleted': self.ops_done,
            'phase': self.phase, 'error': error, 'evidence': ev}
        return json.dumps(body, sort_keys=True, default=str).encode()

    def cleanup(self):
        problems = []
        _CANCEL['deferred'] = True      # a further cancel signal must not abort this same bounded teardown
        for h in list(self.handles):
            try:
                ev = self.fx.export_force_cleanup(h, self.t['fusermount3'])
                self.handles.remove(h)
                self.ev.setdefault('exporters', []).append(ev)
                if ev.get('fault'):
                    problems.append(f'exporter {ev["pid"]}: {ev["fault"]}')
            except Exception as e:      # identity mismatch / incomplete teardown: leave it alone and report it
                problems.append(str(e)[:300])
        for fd in self.qlocks:
            self.fx.release(fd)
        self.qlocks = []
        return problems


def operate(plan, plan_sha, lock_fds, fx, writer_path):
    """-> (exit code, receipt-or-refusal dict).  0 READY, 2 refused before any write, 3 FAILED (evidence in work dir)"""
    _CANCEL.update(deferred=False, pending=None)
    w = Writer(plan, plan_sha, lock_fds, fx, writer_path)
    status, error = 'FAILED', None
    try:
        status = w.execute()
    except Refusal as e:
        error = {'phase': e.phase, 'message': str(e)}
    except Exception as e:      # unknown failure is a failure, never success
        error = {'phase': w.phase, 'message': f'{type(e).__name__}: {str(e)[:500]}'}
    finally:
        try:
            leftovers = w.cleanup()
        finally:
            _CANCEL['deferred'] = False
    if _CANCEL['pending'] is not None:
        leftovers = leftovers + [f'cancelled by signal {_CANCEL["pending"]} during cleanup']
    if leftovers:
        status, error = 'FAILED', error or {'phase': 'cleanup', 'message': '; '.join(leftovers)}
        error['cleanup'] = leftovers
    if not w.work_created:
        return 2, {'refused': error}
    if status != 'READY':
        try:
            fx.chmod(w.deriv, 0o400)
        except OSError:
            pass
    name = 'RESULT.json'
    fx.write_excl(os.path.join(w.work, name), w.receipt(status, error), 0o444)
    return (0 if status == 'READY' else 3), {'status': status, 'receipt': os.path.join(w.work, name), 'error': error}


_CANCEL = {'deferred': False, 'pending': None}


def _cancel(signum, _frame):
    if _CANCEL['deferred']:
        _CANCEL['pending'] = signum     # cleanup is running: finish it, then the result is FAILED
        return
    raise Refusal('cancelled', f'signal {signum}')


def main(argv=None, fx=None):
    args, plan_path, digest, fds = list(sys.argv[1:] if argv is None else argv), None, None, []
    try:
        while args:
            flag = args.pop(0)
            if not args:
                refuse('usage', 'missing value')
            val = args.pop(0)
            if flag == '--plan' and plan_path is None:
                plan_path = safe_path(val, '--plan', ('/dev', '/proc', '/sys'))
            elif flag == '--plan-sha256' and digest is None:
                digest = val
            elif flag == '--lock-fd' and re.fullmatch(r'[3-9]|[1-9]\d{1,3}', val):
                fds.append(int(val))
            else:
                refuse('usage', f'unexpected argument {flag!r}')
        if plan_path is None or digest is None:
            refuse('usage', '--plan PATH --plan-sha256 HEX --lock-fd N are required')
        fx = fx or OsEffects()
        plan = load_plan(fx.read_bounded(plan_path, 1 << 20), digest)
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(s, _cancel)
        code, out = operate(plan, digest, fds, fx, os.path.realpath(__file__))
    except Refusal as e:
        code, out = 2, {'refused': {'phase': e.phase, 'message': str(e)}}
    except OSError as e:
        code, out = 2, {'refused': {'phase': 'io', 'message': str(e)[:500]}}
    print(json.dumps(out, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
