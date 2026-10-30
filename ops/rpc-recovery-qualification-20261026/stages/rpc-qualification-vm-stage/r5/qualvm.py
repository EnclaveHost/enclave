#!/usr/bin/python3 -I
"""rpc-qualification-vm-stage/r5 (r4 + review N1a/N1b + post-start floor recheck + read-only `inventory`): TEMPORARY 8 GiB qualification boot of the SAME RPC guest OS, owned end to end by ONE controller.
Root runs every step (PREPARED; nothing run by Claude). NOT a chain backend: every enclave-* unit and both data mounts are masked.

r5 (logs/claude-qualvm-r4-review.md):
  N1a  every unit dir is RESOLVED component by component (parents listed, fast symlinks followed, bounded) and classified:
       absent (a path component does not exist in its successfully listed parent) | listed | alias (same real dir) | ERROR.
       A listing must contain its own '.' and '..' entries, else it is an error (never "empty"). Required: /etc/systemd/system and
       /usr/lib/systemd/system must exist AND list at least one entry. Optional dirs may be absent, never erroneous.
  N1b  + /usr/local/lib/systemd/system and every *.wants/*.requires dir of every listed system dir; user-manager units cannot be
       masked by systemd.mask=, so any enclave-* name in /etc|/usr/lib|/usr/local/lib systemd/user, /root or /home/*/.config/
       systemd/user (and their wants dirs) or ANY entry in /var/lib/systemd/linger refuses.
  N2'  after the VM unit starts, the floor unit is re-read: not active with the recorded InvocationID -> stop OUR VM, OUR floor, refuse.
  inventory OUT  read-only metadata inventory while production is off: the same production pins, loaded+stopped production units,
       absent qual units, OS disk not open, identity (size, mtime, ctime, ino) equal before/after, inside a <= 512 MiB queue lane;
       NO overlay, NO kernel/initrd extraction, NO capacity requirement (it writes one small JSON). The nbdfuse/qemu-nbd -r mapping is
       torn down and VERIFIED (fusermount rc 0, nbdfuse exited 0 without a kill, not mounted, dir removed, disk no longer open);
       unclean teardown, a changed identity or any scan problem -> rc 2 with the record still written.

r3 = r2 + the independent review's B1-B7 (logs/claude-qualvm-independent-review.md):
  controller OUT  runs INSIDE root's 512 MiB main queue lane for the whole qualification (refuses any other cgroup cap). Admission:
                  MemAvailable >= 16 GiB floor + 10 GiB VM cap + 512 MiB lane + 256 MiB floor/misc + 1 GiB margin (27.75 GiB), NVMe
                  avail >= production guard pause threshold + OVERLAY_MAX, production units loaded+inactive, qual units absent, OS
                  disk not open. It records its PID + /proc start time (start token), starts the FLOOR unit, then the VM unit with
                  BindsTo=/After= the floor unit, records both InvocationIDs, waits; on SIGTERM / deadline / VM exit: ACPI powerdown,
                  bounded grace, then a stop of ITS OWN VM invocation only (InvocationID re-read and compared), then its floor unit.
  floor OUT       the 64 MiB watcher (systemd unit, Restart=no, RuntimeMaxSec). Every 1 s: MemAvailable unreadable or < 18 GiB
                  (proactive: the physical 16 GiB floor is never reached), controller PID/start token gone, overlay ALLOCATED bytes
                  > OVERLAY_MAX, or NVMe avail < the production guard's pause threshold -> it EXITS 4. The VM is BindsTo= it, so systemd
                  stops the VM (SIGTERM; TimeoutStopSec 30 then SIGKILL: the overlay is disposable, the original disks are read-only).
  There is NO detached launch: the VM cannot outlive the floor unit, and the floor unit cannot outlive the controller.
  prepare OUT     read-only extraction (frozen r1 inspector); the GRUB entry's `search --fs-uuid` must equal the partition the files
                  are read from; `root=` must match a real partition (LABEL/UUID/PARTUUID); kernel/initrd must be REGULAR files;
                  bzImage `HdrS`; initrd >= 1 MiB; then the overlay. prove OUT: read-only, rc 3 on ANY failure. stop OUT: SIGTERM to
                  the recorded controller (start token checked). discard OUT: receipt; refuses while anything of ours is alive.
Scope labels: all guest writes go to the disposable OS OVERLAY; the production os.qcow2 is its read-only backing, L1/Base read-only,
their mounts masked. It qualifies this OS/kernel/systemd/binaries; NOT the production disk installation. Q3 (retention drop-in
ordering on the ORIGINAL masked unit) cannot be qualified here.
"""
import argparse, hashlib, importlib.util, json, os, posixpath, re, shlex, signal, socket, struct, subprocess, sys, tempfile, time, uuid

GIB, MIB = 1 << 30, 1 << 20
GUEST_MEM, VM_MAX = 8 * GIB, 10 * GIB
HOST_FLOOR, STOP_BELOW = 16 * GIB, 18 * GIB
LANE, FLOOR_UNIT_MAX, MISC, MARGIN = 512 * MIB, 64 * MIB, 256 * MIB, 1 * GIB
ADMIT = HOST_FLOOR + VM_MAX + LANE + MISC + MARGIN                      # 27.75 GiB
OVERLAY_MAX = 16 * GIB                                                   # overlay + console together (N3)
CONSOLE_MAX = 256 * MIB                                                  # the serial console log on its own (N3)
CMDLINE_MAX = 2047                                                       # x86 COMMAND_LINE_SIZE 2048 incl. NUL (N1)
FLOOR_READY_S = 15
UNIT_SUFFIXES = ('.service', '.timer', '.path', '.socket', '.target', '.mount', '.automount', '.slice', '.swap', '.device', '.scope')
UNIT_NAME = re.compile(r'^enclave-[A-Za-z0-9:_.@\\-]+$')
SYSTEM_DIRS = (('/etc/systemd/system', True), ('/usr/lib/systemd/system', True),                 # (path, required)
               ('/lib/systemd/system', False), ('/usr/local/lib/systemd/system', False))
USER_DIRS = ('/etc/systemd/user', '/usr/lib/systemd/user', '/usr/local/lib/systemd/user', '/root/.config/systemd/user')
LINGER_DIR, HOME_DIR, MAX_HOMES = '/var/lib/systemd/linger', '/home', 64
MAX_DEBUGFS, MAX_LINK_HOPS = 600, 8
LITERAL_COMPONENT = re.compile(r'^[A-Za-z0-9@:_.+-]+$')                     # safe inside a debugfs -R request (no space/quote)
LS_LINE = re.compile(r'^/(\d+)/(\d+)/(\d+)/(\d+)/(.*)/(\d*)/$')               # debugfs `ls -p`
S_IFMT, S_IFDIR, S_IFLNK = 0o170000, 0o040000, 0o120000
TEARDOWN_WAIT_S, EXPOSE_WAIT_S = 30, 60
ACPI_GRACE_S, VM_STOP_TIMEOUT_S, MAX_LIFETIME_S = 180, 30, 4 * 3600
PROD = os.path.expanduser('~/.local/state/enclave-rpc-production')
PROD_UNITS = os.path.expanduser('~/.config/systemd/user')
PINS = {f'{PROD}/provision_vm.py': '38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7',
        f'{PROD}/manifest.json': 'a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'}
INSPECTOR = ('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-memory-recovery-stage/r1/inspect_os_disk.py',
             '287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531')
PROD_UNIT_NAMES = ('enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service')
VM_UNIT, FLOOR_UNIT, NAME = 'enclave-rpc-qual-vm.service', 'enclave-rpc-qual-floor.service', 'enclave-rpc-qual'
RUN = f'/run/user/{os.getuid()}/{NAME}'
MASKS = ('enclave-l1-cl.service', 'enclave-l1-el.path', 'enclave-l1-el.service', 'enclave-rpc-l1-snapshot.service',
         'enclave-rpc-base-snapshot.service', 'enclave-base-holder.path', 'enclave-base-holder.service', 'enclave-base-retention.service')
SSH_FWD = 'hostfwd=tcp:127.0.0.1:22850-10.0.2.15:22'
HERE = os.path.abspath(__file__)


class Refuse(Exception):
    pass


def mount_unit(path):
    """systemd path escaping (systemd-escape --path --suffix=mount)"""
    return ''.join(c if c.isalnum() or c in ':_.' else ('-' if c == '/' else f'\\x{ord(c):02x}') for c in path.strip('/')) + '.mount'


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def production():
    """the pinned production launcher + manifest (read only), and proof that its unit files are still its renders"""
    for p, h in PINS.items():
        if sha(p) != h:
            raise Refuse(f'{p} is not the pinned production file')
    pv = load(f'{PROD}/provision_vm.py', 'pv_prod')
    text = open(f'{PROD}/manifest.json').read(); m = json.loads(text); msha = pv.sha256_text(text)
    if open(f'{PROD_UNITS}/{PROD_UNIT_NAMES[0]}').read() != pv.render_unit(m, msha) or \
            open(f'{PROD_UNITS}/{PROD_UNIT_NAMES[1]}').read() != pv.render_guard_unit(m, msha):
        raise Refuse('production unit files differ from the pinned renders')
    return pv, m


def unit_props(unit, run=subprocess.run, props=('LoadState', 'ActiveState', 'SubState', 'InvocationID', 'BindsTo', 'MemoryMax', 'MemorySwapMax', 'Result')):
    r = run(['systemctl', '--user', 'show', '--property=' + ','.join(props), unit], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise Refuse(f'cannot read {unit} (fail closed)')
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def require_production_stopped(run):
    for u in PROD_UNIT_NAMES:                                              # B7: an unloaded production unit is not "stopped"
        p = unit_props(u, run)
        if p.get('LoadState') != 'loaded' or p.get('ActiveState') not in ('inactive', 'failed'):
            raise Refuse(f'{u} is {p.get("LoadState")}/{p.get("ActiveState")}: production must be loaded and stopped')


def require_qual_absent(run):
    for u in (VM_UNIT, FLOOR_UNIT):
        p = unit_props(u, run)
        if p.get('ActiveState') not in ('inactive', 'failed') or p.get('LoadState') not in ('not-found', 'loaded'):
            raise Refuse(f'{u} is {p.get("LoadState")}/{p.get("ActiveState")}')


def mem_available(path='/proc/meminfo'):
    """bytes, or None when unreadable (callers fail closed)"""
    try:
        for l in open(path):
            if l.startswith('MemAvailable:'):
                return int(l.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def nvme_policy(m, out):
    """B4: OUT must be on the production NVMe backing filesystem; trip = the production guard's own pause threshold"""
    b = m['backings']['nvme']; cap = b['capacity']
    if os.stat(out).st_dev != os.stat(b['dir']).st_dev:
        raise Refuse(f'{out} is not on the NVMe backing filesystem of {b["dir"]}')
    return {'tripAvailBytes': cap['floorBytes'] + cap['pauseMarginBytes'], 'admitAvailBytes': cap['floorBytes'] + cap['pauseMarginBytes'] + OVERLAY_MAX}


def avail_bytes(path):
    v = os.statvfs(path); return v.f_bavail * v.f_frsize


def cgroup_max():
    rel = [l for l in open('/proc/self/cgroup').read().splitlines() if l.startswith('0::')][0][3:]
    return open(f'/sys/fs/cgroup{rel}/memory.max').read().strip()


def start_token(pid):
    """/proc/<pid>/stat field 22 (start time in clock ticks): a PID that was reused has another token"""
    try:
        s = open(f'/proc/{pid}/stat').read()
        return s[s.rindex(')') + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


# ---- GRUB (r2 parser + review B6c) -------------------------------------------------------------------------------------------
LIT_PATH = re.compile(r'^/[A-Za-z0-9._+/-]+$')
LIT_ARG = re.compile(r'^[A-Za-z0-9._+=:,/@-]+$')


def parse_grub(text, grubenv=''):
    """-> {kernel, initrd, args, searchUuid} of the DEFAULT (= first top-level) menuentry, taken literally, or Refuse"""
    for v in re.findall(r'^\s*set\s+default=(\S+)\s*$', text, re.M):
        if v not in ('0', '"0"', '"${next_entry}"'):
            raise Refuse(f'grub default is {v}: not provably the first entry')
    for k in ('next_entry', 'saved_entry'):
        if re.search(rf'^{k}=\S', grubenv, re.M):
            raise Refuse(f'grubenv sets {k}: the default entry is not provably the first')
    first = re.search(r'^(menuentry|submenu)\s', text, re.M)
    if not first or first.group(1) != 'menuentry':
        raise Refuse('the first top-level GRUB entry is not a menuentry')
    if re.search(r'^\s+(menuentry|submenu)\s', text[:first.start()], re.M):    # B6c: an indented entry before it
        raise Refuse('an indented menuentry/submenu precedes the first top-level entry')
    m = re.search(r"^menuentry\s.*?\{(.*?)^\}", text, re.S | re.M)
    if not m:
        raise Refuse('the first menuentry has no closing brace at line start')
    body = m.group(1)
    lk = re.findall(r'^\s*linux(?:efi)?\s+(.*)$', body, re.M)
    li = re.findall(r'^\s*initrd(?:efi)?\s+(.*)$', body, re.M)
    se = re.findall(r'^\s*search\s+(.*)$', body, re.M)
    if len(lk) != 1 or len(li) != 1:
        raise Refuse('the first menuentry does not have exactly one linux and one initrd line')
    ktoks, itoks = lk[0].split(), li[0].split()
    if any('..' in t.split('/') for t in ktoks[:1] + itoks):
        raise Refuse('a kernel/initrd path contains ..')
    if len(itoks) != 1 or not LIT_PATH.match(itoks[0]):
        raise Refuse(f'initrd is not exactly one literal absolute path: {li[0]!r}')
    if not ktoks or not LIT_PATH.match(ktoks[0]):
        raise Refuse(f'kernel is not a literal absolute path: {lk[0]!r}')
    args = [t for t in ktoks[1:] if t != '$vt_handoff']
    if not all(LIT_ARG.match(t) for t in args) or sum(t.startswith('root=') for t in args) != 1:
        raise Refuse(f'kernel args are not literal or lack exactly one root=: {lk[0]!r}')
    if len(se) != 1:                                                            # B6a: the entry must name its partition
        raise Refuse('the first menuentry does not have exactly one search line')
    st = se[0].split()
    if '--set=root' not in st or not ({'--fs-uuid', '-u'} & set(st)) or not re.fullmatch(r'[0-9A-Fa-f-]{8,36}', st[-1]):
        raise Refuse(f'the search line is not a literal --fs-uuid --set=root <uuid>: {se[0]!r}')
    ver = re.fullmatch(r'.*/vmlinuz-([0-9A-Za-z._+-]+)', ktoks[0])
    if not ver:
        raise Refuse('the kernel path does not carry a version (vmlinuz-<version>)')
    return {'kernel': ktoks[0], 'initrd': itoks[0], 'args': args, 'searchUuid': st[-1].lower(), 'kernelVersion': ver.group(1)}


def ext4_uuid(f, offset):
    f.seek(offset + 1024); sb = f.read(1024)
    if len(sb) < 0x78 or struct.unpack_from('<H', sb, 0x38)[0] != 0xEF53:
        return None
    return str(uuid.UUID(bytes=sb[0x68:0x78]))


def root_matches(arg, parts):
    """`root=` must name exactly one real partition: LABEL= ext4 label, UUID= ext4 uuid, PARTUUID= GPT unique GUID"""
    kind, _, val = arg[len('root='):].partition('=')
    key = {'LABEL': 'label', 'UUID': 'fsUuid', 'PARTUUID': 'partUuid'}.get(kind)
    return key is not None and sum(1 for p in parts if str(p.get(key, '')).lower() == val.lower()) == 1


def is_regular(stat_text):
    return re.search(r'Type:\s+regular', stat_text) is not None


def check_kernel(path):
    with open(path, 'rb') as f:
        f.seek(0x202); hdrs = f.read(4)
    if hdrs != b'HdrS':
        raise Refuse('the extracted kernel is not a bzImage (no HdrS at 0x202)')


def inspector():
    if sha(INSPECTOR[0]) != INSPECTOR[1]:
        raise Refuse('the frozen OS-disk inspector is not the pinned r1 bytes')
    return load(INSPECTOR[0], 'inspect_r1')


class Exposure:
    """the OS disk exposed READ-ONLY (nbdfuse -r over qemu-nbd -r) for debugfs -c; teardown is always attempted and VERIFIED:
    fusermount3 -u rc 0, nbdfuse exits 0 by itself (no kill), the dir is no longer a mount point and is removed, and the OS disk is
    no longer open by any process. `.teardown` records each fact; `.clean` is True only if all hold."""
    def __init__(self, I, osd, run=subprocess.run, popen=subprocess.Popen, ismount=os.path.ismount, sleep=time.sleep):
        self.I, self.osd, self.run, self.popen, self.ismount, self.sleep = I, osd, run, popen, ismount, sleep
        self.proc, self.mnt, self.teardown, self.clean = None, None, None, False

    def __enter__(self):
        self.mnt = tempfile.mkdtemp(prefix='rpc-qual-ro-'); self.raw = os.path.join(self.mnt, 'os.raw')
        try:
            self.proc = self.popen(['nbdfuse', '-r', self.raw, '[', 'qemu-nbd', '-r', '-f', 'qcow2', self.osd, ']'],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            t0 = time.monotonic()
            while not (os.path.exists(self.raw) and os.path.getsize(self.raw) > 0):
                if time.monotonic() - t0 > EXPOSE_WAIT_S or self.proc.poll() not in (None, 0):
                    raise Refuse('nbdfuse did not expose the OS disk')
                self.sleep(0.2)
        except BaseException:
            self.__exit__(None, None, None)                                    # `with` never calls __exit__ when __enter__ raises
            raise
        return self

    def __exit__(self, *exc):
        t = {'fusermountRc': None, 'nbdfuseExit': None, 'killed': False, 'stillMounted': None, 'dirRemoved': False, 'openAfter': None}
        try:
            t['fusermountRc'] = self.run(['fusermount3', '-u', self.mnt], capture_output=True, timeout=30).returncode
        except (OSError, subprocess.SubprocessError) as e:
            t['fusermountRc'] = f'error: {e}'
        if self.proc is not None:
            try:
                t['nbdfuseExit'] = self.proc.wait(timeout=TEARDOWN_WAIT_S)
            except subprocess.TimeoutExpired:
                self.proc.kill(); t['killed'] = True
                try:
                    t['nbdfuseExit'] = self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    t['nbdfuseExit'] = 'unreaped'
        t['stillMounted'] = bool(self.ismount(self.mnt))
        try:
            os.rmdir(self.mnt); t['dirRemoved'] = True
        except OSError as e:
            t['dirRemoved'] = f'no: {e}'
        try:
            t['openAfter'] = self.I.open_by_others(self.osd)
        except OSError as e:
            t['openAfter'] = f'error: {e}'
        self.teardown = t
        self.clean = (t['fusermountRc'] == 0 and t['nbdfuseExit'] == 0 and not t['killed'] and t['stillMounted'] is False
                      and t['dirRemoved'] is True and t['openAfter'] == [])
        return False


def read_partitions(I, raw):
    parts = []
    with open(raw, 'rb') as f:
        f.seek(512); hdr = f.read(92); ent_lba, cnt, esz = struct.unpack_from('<QII', hdr, 72)
        f.seek(ent_lba * 512); table = f.read(cnt * esz)
        for p in I.gpt_partitions(f):
            e = table[(p['index'] - 1) * esz:p['index'] * esz]
            parts.append({**p, 'partUuid': str(uuid.UUID(bytes_le=e[16:32])), 'label': I.ext4_label(f, p['first'] * 512),
                          'fsUuid': ext4_uuid(f, p['first'] * 512)})
    byl = {p['label']: p for p in parts if p['label'] in ('cloudimg-rootfs', 'BOOT')}
    if 'cloudimg-rootfs' not in byl:
        raise Refuse('no cloudimg-rootfs partition')
    return parts, byl


def read_grub(I, raw, parts, byl, run):
    """-> (parsed default entry, partition label, its debugfs device), bound to the partition and to root= (B6a)"""
    cands = ([('BOOT', '/grub')] if 'BOOT' in byl else []) + [('cloudimg-rootfs', '/boot/grub')]
    for lab, d in cands:
        dev = f"{raw}?offset={byl[lab]['first'] * 512}"
        txt = I.debugfs(dev, f'cat {d}/grub.cfg', run)[1]
        if txt.strip():
            env = I.debugfs(dev, f'cat {d}/grubenv', run)[1].decode('utf-8', 'replace')
            g = parse_grub(txt.decode('utf-8', 'replace'), env)
            if g['searchUuid'] != (byl[lab]['fsUuid'] or '').lower():
                raise Refuse(f'the entry searches fs-uuid {g["searchUuid"]}, but its files were read from {lab} ({byl[lab]["fsUuid"]})')
            if not root_matches(next(t for t in g['args'] if t.startswith('root=')), parts):
                raise Refuse('root= does not name exactly one real partition')
            return g, lab, dev
    raise Refuse('no grub.cfg on the BOOT or root partition')


def make_dbg(dev, run, budget=MAX_DEBUGFS):
    """-> dbg(request) -> (rc, stdout text); read-only `debugfs -c`; at most `budget` invocations (bounded scan)"""
    n = [0]
    def dbg(request):
        n[0] += 1
        if n[0] > budget:
            raise Refuse(f'debugfs request budget {budget} exceeded (unbounded unit tree refused)')
        r = run(['debugfs', '-c', '-R', request, dev], capture_output=True, timeout=60)
        out = r.stdout.decode('utf-8', 'replace') if isinstance(r.stdout, bytes) else (r.stdout or '')
        return r.returncode, out
    return dbg


def list_dir(dbg, path):
    """entries of an EXISTING directory; an error, unless the listing carries its own '.' and '..' (never mistaken for empty)"""
    rc, txt = dbg(f'ls -p {path}')
    es = []
    for line in txt.splitlines():
        m = LS_LINE.match(line.strip())
        if m:
            es.append({'name': m.group(5), 'mode': int(m.group(2), 8)})
    names = [e['name'] for e in es]
    if rc != 0 or '.' not in names or '..' not in names:
        raise Refuse(f'debugfs listing of {path} failed or is incomplete (rc {rc}; no ./.. entries): unreadable, never treated as empty')
    return [e for e in es if e['name'] not in ('.', '..')]


def link_target(dbg, path):
    rc, txt = dbg(f'stat {path}')
    m = re.search(r'Fast link dest: "([^"]*)"', txt)
    if rc != 0 or not m or not m.group(1):
        raise Refuse(f'{path} is a symlink whose target cannot be read (fast link required)')
    return m.group(1)


def resolve_dir(dbg, path):
    """-> ('dir', real path) | ('absent', first missing path). Every parent is LISTED (so absence is proven by a good listing,
    not inferred from an error); fast symlinks are followed (bounded); anything else that exists but is not a directory refuses."""
    comps, cur, hops, i = [c for c in path.split('/') if c], '/', 0, 0
    while i < len(comps):
        c = comps[i]
        if not LITERAL_COMPONENT.match(c) or c in ('.', '..'):
            raise Refuse(f'path component {c!r} of {path} is not literal')
        e = {x['name']: x for x in list_dir(dbg, cur)}.get(c)
        nxt = posixpath.join(cur, c)
        if e is None:
            return 'absent', nxt
        t = e['mode'] & S_IFMT
        if t == S_IFDIR:
            cur, i = nxt, i + 1
        elif t == S_IFLNK:
            hops += 1
            if hops > MAX_LINK_HOPS:
                raise Refuse(f'too many symlinks resolving {path}')
            tgt = link_target(dbg, nxt)
            new = posixpath.normpath(posixpath.join('/' if tgt.startswith('/') else cur, tgt))
            comps, cur, i = [x for x in new.split('/') if x] + comps[i + 1:], '/', 0
        else:
            raise Refuse(f'{nxt} exists but is not a directory')
    return 'dir', cur


def scan_units(dbg):
    """N1a/N1b: -> {'system': {unit: [where]}, 'user': {unit: [where]}, 'linger': [names], 'dirs': {path: state}, 'problems': [...]}.
    Raises Refuse only for errors that make the scan itself untrustworthy (unreadable/corrupt listings, required dir absent/empty)."""
    dirs, real_of, problems = {}, {}, []
    system, user, linger = {}, {}, []

    def take(path, required, unit_names, depth_wants=True):
        st, real = resolve_dir(dbg, path)
        if st == 'absent':
            if required:
                raise Refuse(f'required unit dir {path} is absent ({real} missing)')
            dirs[path] = {'state': 'absent', 'missing': real}; return
        if real in real_of:
            dirs[path] = {'state': 'alias', 'of': real_of[real]}; return
        es = list_dir(dbg, real)
        if required and not es:
            raise Refuse(f'required unit dir {path} lists no entries (fail closed)')
        real_of[real] = path; dirs[path] = {'state': 'listed', 'real': real, 'entries': len(es)}
        collect(real, es, unit_names)
        if depth_wants:
            for e in es:
                if (e['mode'] & S_IFMT) == S_IFDIR and e['name'].endswith(('.wants', '.requires', '.upholds')):
                    if not LITERAL_COMPONENT.match(e['name']):
                        problems.append(f'{real}/{e["name"]}: dependency dir name is not literal'); continue
                    sub = posixpath.join(real, e['name'])
                    dirs[sub] = {'state': 'listed', 'real': sub}
                    sub_es = list_dir(dbg, sub); dirs[sub]['entries'] = len(sub_es)
                    collect(sub, sub_es, unit_names)

    def collect(where, es, unit_names):
        for e in es:
            n, t = e['name'], e['mode'] & S_IFMT
            if not n.startswith('enclave-'):
                continue
            unit = n
            if t == S_IFDIR:
                for suf in ('.d', '.wants', '.requires', '.upholds'):
                    if n.endswith(suf):
                        unit = n[:-len(suf)]; break
            if not unit.endswith(UNIT_SUFFIXES):
                continue
            if not UNIT_NAME.match(unit):
                problems.append(f'unit name {unit!r} in {where} is not literal (cannot be masked verbatim)'); continue
            unit_names.setdefault(unit, []).append(posixpath.join(where, n))

    for d, req in SYSTEM_DIRS:
        take(d, req, system)
    for d in USER_DIRS:
        take(d, False, user)
    st, real = resolve_dir(dbg, HOME_DIR)
    if st == 'dir':
        homes = [e['name'] for e in list_dir(dbg, real) if (e['mode'] & S_IFMT) == S_IFDIR]
        if len(homes) > MAX_HOMES:
            raise Refuse(f'more than {MAX_HOMES} home directories (bounded scan)')
        for h in homes:
            if not LITERAL_COMPONENT.match(h):
                problems.append(f'home directory name {h!r} is not literal (cannot be scanned)'); continue
            take(f'{real}/{h}/.config/systemd/user', False, user)
    else:
        dirs[HOME_DIR] = {'state': 'absent', 'missing': real}
    st, real = resolve_dir(dbg, LINGER_DIR)
    if st == 'dir':
        linger = sorted(e['name'] for e in list_dir(dbg, real)); dirs[LINGER_DIR] = {'state': 'listed', 'real': real, 'entries': len(linger)}
    else:
        dirs[LINGER_DIR] = {'state': 'absent', 'missing': real}
    if user:
        problems.append(f'user-manager enclave units exist (systemd.mask= cannot mask them): {sorted(user)}')
    if linger:
        problems.append(f'lingering users exist (their user managers start at boot): {linger}')
    return {'system': {k: sorted(v) for k, v in sorted(system.items())}, 'user': {k: sorted(v) for k, v in sorted(user.items())},
            'linger': linger, 'dirs': dirs, 'problems': problems}


def cmd_prepare(out, run=subprocess.run, popen=subprocess.Popen):
    pv, m = production()
    require_production_stopped(run); require_qual_absent(run)
    I = inspector()
    osd = m['disks']['os']['path']
    if (pids := I.open_by_others(osd)):
        raise Refuse(f'{osd} is open by {pids}')
    os.makedirs(out, mode=0o700, exist_ok=False)
    pol = nvme_policy(m, out)                                                  # capacity thresholds unchanged (prepare creates the overlay)
    if avail_bytes(out) < pol['admitAvailBytes']:
        raise Refuse(f'NVMe avail {avail_bytes(out)} < pause threshold + OVERLAY_MAX {pol["admitAvailBytes"]}')
    st = os.stat(osd)
    with Exposure(I, osd, run, popen) as ex:
        parts, byl = read_partitions(I, ex.raw)
        g, part, dev = read_grub(I, ex.raw, parts, byl, run)
        got = {}
        for name, src in (('vmlinuz', g['kernel']), ('initrd', g['initrd'])):
            if not is_regular(I.debugfs(dev, f'stat {src}', run)[1].decode('utf-8', 'replace')):     # B6b: never a symlink's text
                raise Refuse(f'{part}:{src} is not a regular file')
            dst = os.path.join(out, name)
            run(['debugfs', '-c', '-R', f'dump {src} {dst}', dev], capture_output=True, timeout=120)
            if not os.path.isfile(dst):
                raise Refuse(f'could not extract {src}')
            os.chmod(dst, 0o400); got[name] = {'source': f'{part}:{src}', 'sha256': sha(dst), 'size': os.path.getsize(dst)}
        check_kernel(os.path.join(out, 'vmlinuz'))
        if got['initrd']['size'] < MIB:
            raise Refuse('the extracted initrd is implausibly small')
        rootdev = f"{ex.raw}?offset={byl['cloudimg-rootfs']['first'] * 512}"
        fstab = I.debugfs(rootdev, 'cat /etc/fstab', run)[1].decode('utf-8', 'replace')
        scan = scan_units(make_dbg(rootdev, run))
    if not ex.clean:
        raise Refuse(f'the read-only OS-disk mapping was not torn down cleanly: {ex.teardown}')
    if scan['problems']:
        raise Refuse(f'unit scan problems: {scan["problems"]}')
    auto = [l for l in fstab.splitlines() if l.strip() and not l.startswith('#') and len(l.split()) >= 4
            and l.split()[1] not in ('/', '/boot', '/boot/efi', 'none', 'swap') and 'noauto' not in l.split()[3].split(',')]
    overlay = os.path.join(out, 'os-qual.qcow2')
    r = run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', osd, overlay], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise Refuse(f'qemu-img create failed: {r.stderr[-300:]}')
    if ident(osd) != ident_of(st):
        raise Refuse('the production OS disk changed during prepare')
    rec = {'format': 'enclave-rpc-qual-prepared/r5', 'osDisk': osd, 'osDiskIdent': ident_of(st), 'overlay': overlay,
           'kernel': got['vmlinuz'], 'initrd': got['initrd'], 'kernelVersion': g['kernelVersion'], 'grubPartition': part,
           'searchUuid': g['searchUuid'], 'cmdlineFromGrub': g['args'], 'fstab': fstab.splitlines(), 'fstabAutoDataMounts': auto,
           'partitions': parts, 'production': dict(PINS), 'unitInventory': scan['system'], 'unitScan': scan, 'teardown': ex.teardown}
    cmdline_ok(m, rec)
    json.dump(rec, open(os.path.join(out, 'PREPARED.json'), 'w'), indent=1, sort_keys=True)
    if auto:
        raise Refuse(f'fstab auto-mounts data filesystems {auto}: review before any controller run')
    return rec


def cmd_inventory(out, run=subprocess.run, popen=subprocess.Popen):
    """read-only metadata only: NO overlay, NO kernel/initrd extraction, NO capacity requirement; one small JSON in a NEW 0700 dir"""
    lim = cgroup_max()
    if not lim.isdigit() or int(lim) > LANE:
        raise Refuse(f'inventory must run inside a queue lane of at most {LANE} bytes (memory.max {lim})')
    if not os.path.isabs(out) or os.path.lexists(out):
        raise Refuse(f'{out} must be a NEW absolute path (an inventory never reuses an output dir)')
    pv, m = production()
    require_production_stopped(run); require_qual_absent(run)
    I = inspector()
    osd = m['disks']['os']['path']
    if (pids := I.open_by_others(osd)):
        raise Refuse(f'{osd} is open by {pids}')
    os.makedirs(out, mode=0o700, exist_ok=False)
    st, t0 = os.stat(osd), time.time()
    rec = {'format': 'enclave-rpc-qual-inventory/r5', 'osDisk': osd, 'osDiskIdentBefore': ident_of(st), 'startedAt': t0,
           'production': dict(PINS), 'scope': 'read-only metadata of the production OS disk; no overlay, no extraction, no capacity use'}
    problems = []
    ex = Exposure(I, osd, run, popen)
    try:
        with ex:
            parts, byl = read_partitions(I, ex.raw)
            rec['partitions'] = parts
            try:
                g, part, _ = read_grub(I, ex.raw, parts, byl, run)
                rec['grub'] = {'partition': part, 'kernelVersion': g['kernelVersion'], 'cmdlineFromGrub': g['args'], 'searchUuid': g['searchUuid']}
            except Refuse as e:
                rec['grub'] = {'refused': str(e)}; problems.append(f'grub: {e}')
            rootdev = f"{ex.raw}?offset={byl['cloudimg-rootfs']['first'] * 512}"
            scan = scan_units(make_dbg(rootdev, run))
            rec['unitScan'] = scan; problems += scan['problems']
    except (Refuse, OSError, ValueError, KeyError, struct.error, subprocess.SubprocessError) as e:
        problems.append(f'scan refused: {type(e).__name__}: {e}')
    rec['teardown'] = ex.teardown
    if not ex.clean:
        problems.append('the read-only mapping was not torn down cleanly')
    rec['osDiskIdentAfter'] = ident(osd)
    if rec['osDiskIdentAfter'] != rec['osDiskIdentBefore']:
        problems.append('the production OS disk identity changed during the inventory')
    if 'unitScan' in rec and 'cmdlineFromGrub' in rec.get('grub', {}):
        prep = {'cmdlineFromGrub': rec['grub']['cmdlineFromGrub'], 'unitInventory': rec['unitScan']['system']}
        rec['maskSet'] = mask_set(m, prep)
        rec['cmdlineBytes'] = len(' '.join(expected_cmdline(m, prep)).encode()); rec['cmdlineMax'] = CMDLINE_MAX
        if rec['cmdlineBytes'] > CMDLINE_MAX:
            problems.append(f'the masked kernel command line would be {rec["cmdlineBytes"]} bytes > {CMDLINE_MAX}')
    rec['problems'], rec['ok'], rec['endedAt'] = problems, not problems, time.time()
    with open(os.path.join(out, 'INVENTORY.json'), 'x') as f:
        json.dump(rec, f, indent=1, sort_keys=True); f.write('\n')
    return rec


def ident_of(st):
    return [st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino]


def ident(p):
    return ident_of(os.stat(p))


# ---- argv / units -------------------------------------------------------------------------------------------------------------
def qual_argv(pv, m, prep):
    a = list(pv.qemu_argv(m))
    def at(i, want):
        if not a[i].startswith(want):
            raise Refuse(f'production argv[{i}] is {a[i][:60]!r}, not the reviewed shape')
    at(2, 'enclave-rpc-production,'); a[2] = f'{NAME},debug-threads=on'
    at(6, 'memory-backend-ram,id=rpcmem,size='); a[6] = f'memory-backend-ram,id=rpcmem,size={GUEST_MEM},prealloc=on'
    at(14, '65536M'); a[14] = f'{GUEST_MEM >> 20}M'
    at(26, 'socket,id=con0,'); a[26] = f'socket,id=con0,path={RUN}/console.sock,server=on,wait=off,logfile={os.path.dirname(prep["overlay"])}/console.log,logappend=on'
    at(30, 'unix:'); a[30] = f'unix:{RUN}/qmp.sock,server=on,wait=off'
    at(31, '-chardev'); at(32, 'socket,id=qmpg,'); at(33, '-mon')
    blk = {}
    for i in (42, 46, 50, 54):
        d = json.loads(a[i]); blk[d['node-name']] = (i, d)
    if set(blk) != {'os0', 'l10', 'base0', 'seed0'} or blk['os0'][1]['file']['filename'] != prep['osDisk']:
        raise Refuse('production blockdevs are not the reviewed four')
    i, d = blk['os0']; d['file']['filename'] = prep['overlay']; a[i] = json.dumps(d, sort_keys=True, separators=(',', ':'))
    for n in ('l10', 'base0'):
        i, d = blk[n]; d['read-only'] = True; d['discard'] = 'ignore'; a[i] = json.dumps(d, sort_keys=True, separators=(',', ':'))
    at(58, 'user,id=net0,')
    if SSH_FWD not in a[58].split(','):
        raise Refuse('production netdev lacks the reviewed SSH forward')
    a[58] = ','.join([t for t in a[58].split(',') if not t.startswith('hostfwd=')] + [SSH_FWD, 'restrict=on'])
    del a[31:35]
    d = os.path.dirname(prep['overlay'])
    return a + ['-kernel', f'{d}/vmlinuz', '-initrd', f'{d}/initrd', '-append', ' '.join(expected_cmdline(m, prep))]


def mask_set(m, prep):
    """N1: the union of the reviewed MASKS and EVERY enclave-* unit found on the disk, then both data mount units (ordered)"""
    extra = sorted(set(prep['unitInventory']) - set(MASKS))
    return list(MASKS) + extra + [mount_unit(m['disks'][k]['mount']) for k in ('l1', 'base')]


def expected_cmdline(m, prep):
    return prep['cmdlineFromGrub'] + [f'systemd.mask={u}' for u in mask_set(m, prep)]


def cmdline_ok(m, prep):
    n = len(' '.join(expected_cmdline(m, prep)).encode())
    if n > CMDLINE_MAX:
        raise Refuse(f'the kernel command line would be {n} bytes > {CMDLINE_MAX} (COMMAND_LINE_SIZE)')
    return n


def floor_unit_cmd(out, pid, token):
    return ['systemd-run', '--user', f'--unit={FLOOR_UNIT}', '--collect', '--quiet', f'-pMemoryMax={FLOOR_UNIT_MAX}', '-pMemorySwapMax=0',
            '-pRestart=no', f'-pRuntimeMaxSec={MAX_LIFETIME_S + 600}', '-pNoNewPrivileges=yes', '--',
            '/usr/bin/python3', '-I', HERE, 'floor', out, '--controller-pid', str(pid), '--controller-token', token]


def vm_unit_cmd(argv):
    return ['systemd-run', '--user', f'--unit={VM_UNIT}', '--collect', '--quiet', f'-pBindsTo={FLOOR_UNIT}', f'-pAfter={FLOOR_UNIT}',
            f'-pMemoryMax={VM_MAX}', '-pMemorySwapMax=0', '-pTasksMax=4096', '-pNoNewPrivileges=yes', '-pKillMode=mixed',
            f'-pTimeoutStopSec={VM_STOP_TIMEOUT_S}', f'-pRuntimeMaxSec={MAX_LIFETIME_S}', '-pRestart=no', f'-pRuntimeDirectory={NAME}',
            '-pRuntimeDirectoryMode=0700', '-pUMask=0077', '--'] + argv


def checked(out):
    pv, m = production()
    prep = json.load(open(os.path.join(out, 'PREPARED.json')))
    if prep.get('format') != 'enclave-rpc-qual-prepared/r5' or not isinstance(prep.get('unitInventory'), dict):
        raise Refuse('not an r5 PREPARED record (with the r5 disk unit scan)')
    cmdline_ok(m, prep)
    for k, n in (('kernel', 'vmlinuz'), ('initrd', 'initrd')):
        if sha(os.path.join(out, n)) != prep[k]['sha256']:
            raise Refuse(f'{k} changed since prepare')
    if ident(prep['osDisk']) != prep['osDiskIdent'] or prep['fstabAutoDataMounts']:
        raise Refuse('the production OS disk changed since prepare (or fstab auto-mounts data)')
    return pv, m, prep


# ---- floor watcher ------------------------------------------------------------------------------------------------------------
def floor_reasons(out, ctl_pid, ctl_token, trip_avail, meminfo='/proc/meminfo'):
    why = []
    ma = mem_available(meminfo)
    if ma is None:
        why.append('MemAvailable unreadable')
    elif ma < STOP_BELOW:
        why.append(f'MemAvailable {ma} < {STOP_BELOW} (proactive stop above the 16 GiB floor)')
    if start_token(ctl_pid) != ctl_token:
        why.append('the controller is gone (PID/start token)')
    try:
        alloc = os.stat(os.path.join(out, 'os-qual.qcow2')).st_blocks * 512
        con_p = os.path.join(out, 'console.log')
        con = os.stat(con_p).st_blocks * 512 if os.path.lexists(con_p) else 0
        if con > CONSOLE_MAX:
            why.append(f'console.log allocated {con} > {CONSOLE_MAX}')
        if alloc + con > OVERLAY_MAX:
            why.append(f'overlay + console allocated {alloc + con} > {OVERLAY_MAX}')
        if avail_bytes(out) < trip_avail:
            why.append(f'NVMe avail {avail_bytes(out)} < production pause threshold {trip_avail}')
    except OSError as e:
        why.append(f'overlay/filesystem unreadable: {e}')
    return why


def cmd_floor(out, ctl_pid, ctl_token, interval=1.0, max_loops=None, meminfo='/proc/meminfo', sleep=time.sleep):
    _, m = production()
    trip = nvme_policy(m, out)['tripAvailBytes']
    n, inv = 0, os.environ.get('INVOCATION_ID', '')
    while max_loops is None or n < max_loops:
        why = floor_reasons(out, ctl_pid, ctl_token, trip, meminfo)
        if why:
            json.dump({'at': time.time(), 'reasons': why}, open(os.path.join(out, 'floor-trip.json'), 'w'))
            print(json.dumps({'floorTrip': why}), flush=True)
            return 4                                                        # exiting stops the BindsTo'd VM (systemd)
        if n == 0:                                                          # N2: ready only AFTER the first clean check
            if not re.fullmatch(r'[0-9a-f]{32}', inv):
                print(json.dumps({'floorTrip': ['no systemd INVOCATION_ID: not running as the owned floor unit']}), flush=True)
                return 4
            tmp = os.path.join(out, 'floor-ready.json.tmp')
            json.dump({'invocation': inv, 'pid': os.getpid(), 'startToken': start_token(os.getpid()), 'firstCheck': [], 'at': time.time()}, open(tmp, 'w'))
            os.rename(tmp, os.path.join(out, 'floor-ready.json'))
        n += 1; sleep(interval)
    return 0


def floor_ready(out, invocation, run, wait_s=FLOOR_READY_S, sleep=time.sleep):
    """N2: the floor unit wrote its ready receipt for THIS invocation, its process is alive, and the unit is still that invocation"""
    t0, p = time.monotonic(), os.path.join(out, 'floor-ready.json')
    while time.monotonic() - t0 < wait_s:
        if os.path.exists(p):
            try:
                r = json.load(open(p))
            except ValueError:
                r = {}
            u = unit_props(FLOOR_UNIT, run)
            tok = r.get('startToken')                                                 # a dead/reused PID has no/another token
            return (r.get('invocation') == invocation and bool(invocation) and bool(tok) and start_token(r.get('pid', -1)) == tok
                    and u.get('ActiveState') == 'active' and u.get('InvocationID') == invocation)
        sleep(0.5)
    return False


# ---- controller ---------------------------------------------------------------------------------------------------------------
STOP = {'flag': False}


def qmp(cmd):
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(f'{RUN}/qmp.sock'); f = s.makefile('rwb'); f.readline()
    out = []
    for c in ('qmp_capabilities', cmd):
        f.write(json.dumps({'execute': c}).encode() + b'\n'); f.flush()
        while True:
            r = json.loads(f.readline())
            if 'return' in r or 'error' in r:
                out.append(r); break
    s.close(); return out[-1]


def own_stop(unit, invocation, run):
    """stop ONLY our own invocation of `unit` (InvocationID re-read); never a foreign one"""
    p = unit_props(unit, run)
    if p.get('ActiveState') in ('inactive', 'failed') and p.get('LoadState') in ('not-found', 'loaded'):
        return 'already-stopped'
    if p.get('InvocationID') != invocation:
        return f'NOT stopped: {unit} InvocationID {p.get("InvocationID")} is not ours ({invocation})'
    run(['systemctl', '--user', 'stop', unit], capture_output=True, text=True, timeout=VM_STOP_TIMEOUT_S + 60)
    return 'stopped'


def wait_inactive(unit, seconds, run, sleep=time.sleep):
    t0 = time.monotonic()
    while time.monotonic() - t0 < seconds:
        if unit_props(unit, run).get('ActiveState') in ('inactive', 'failed'):
            return True
        sleep(2)
    return False


def cmd_controller(out, run=subprocess.run, sleep=time.sleep, lifetime=MAX_LIFETIME_S):
    if cgroup_max() != str(LANE):
        raise Refuse(f'the controller must run in root\'s 512 MiB main queue lane (memory.max {cgroup_max()} != {LANE})')
    pv, m, prep = checked(out)
    require_production_stopped(run); require_qual_absent(run)
    I = inspector()                                                         # r5: the pinned bytes, as in prepare/inventory
    if (pids := I.open_by_others(prep['osDisk'])):                         # B7: re-checked at launch
        raise Refuse(f'{prep["osDisk"]} is open by {pids}')
    pol = nvme_policy(m, out)
    ma = mem_available()
    if ma is None or ma < ADMIT:
        raise Refuse(f'MemAvailable {ma} < admission {ADMIT} (16 GiB floor + 10 GiB VM + 512 MiB lane + 256 MiB + 1 GiB margin)')
    if avail_bytes(out) < pol['admitAvailBytes']:
        raise Refuse(f'NVMe avail {avail_bytes(out)} < {pol["admitAvailBytes"]}')
    me, tok = os.getpid(), start_token(os.getpid())
    rec = {'format': 'enclave-rpc-qual-controller/r3', 'pid': me, 'startToken': tok, 'startedAt': time.time(), 'memAvailableAtAdmission': ma,
           'nvmeAvailAtAdmission': avail_bytes(out), 'production': {p: sha(p) for p in PINS}, 'osDiskIdent': ident(prep['osDisk'])}
    def save():
        json.dump(rec, open(os.path.join(out, 'controller.json'), 'w'), indent=1, sort_keys=True)
    save()
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, lambda *_: STOP.__setitem__('flag', True))
    for n in ('floor-ready.json', 'floor-ready.json.tmp', 'floor-trip.json'):        # never a previous run's receipt
        if os.path.lexists(os.path.join(out, n)):
            os.unlink(os.path.join(out, n))
    r = run(floor_unit_cmd(out, me, tok), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise Refuse(f'floor unit did not start: {r.stderr[-200:]}')
    rec['floorInvocation'] = unit_props(FLOOR_UNIT, run).get('InvocationID'); save()
    if not floor_ready(out, rec['floorInvocation'], run, wait_s=FLOOR_READY_S, sleep=sleep):          # N2: no VM before a proven-ready floor
        rec['floorStop'] = own_stop(FLOOR_UNIT, rec['floorInvocation'], run); save()
        raise Refuse(f'the floor unit did not become ready for invocation {rec["floorInvocation"]} within {FLOOR_READY_S} s: no VM started')
    rec['floorReady'] = json.load(open(os.path.join(out, 'floor-ready.json'))); save()
    r = run(vm_unit_cmd(qual_argv(pv, m, prep)), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        rec['floorStop'] = own_stop(FLOOR_UNIT, rec['floorInvocation'], run); save()
        raise Refuse(f'VM unit did not start: {r.stderr[-200:]}')
    rec['vmInvocation'] = unit_props(VM_UNIT, run).get('InvocationID'); save()
    f = unit_props(FLOOR_UNIT, run)                                           # r5: the VM is bound to OUR proven floor, or it stops
    if f.get('ActiveState') != 'active' or f.get('InvocationID') != rec['floorInvocation']:
        rec['postStartFloor'] = {k: f.get(k) for k in ('ActiveState', 'InvocationID')}
        rec['vmStop'] = own_stop(VM_UNIT, rec['vmInvocation'], run)
        rec['floorStop'] = own_stop(FLOOR_UNIT, rec['floorInvocation'], run); save()
        raise Refuse(f'after the VM start the floor unit is {f.get("ActiveState")}/{f.get("InvocationID")}, not our ready invocation '
                     f'{rec["floorInvocation"]}: our VM was stopped')
    t0 = time.monotonic(); end = 'vm-exited'
    while True:
        if STOP['flag']:
            end = 'stop-requested'; break
        if time.monotonic() - t0 > lifetime:
            end = 'lifetime'; break
        p = unit_props(VM_UNIT, run)
        if p.get('ActiveState') in ('inactive', 'failed') or p.get('InvocationID') != rec['vmInvocation']:
            break
        sleep(2)
    rec['end'] = end
    if end != 'vm-exited':
        try:
            rec['acpi'] = qmp('system_powerdown')
        except (OSError, ValueError) as e:
            rec['acpi'] = f'failed: {e}'
        if not wait_inactive(VM_UNIT, ACPI_GRACE_S, run, sleep):
            rec['vmStop'] = own_stop(VM_UNIT, rec['vmInvocation'], run)     # bounded force: the overlay is disposable
    rec['floorStop'] = own_stop(FLOOR_UNIT, rec['floorInvocation'], run)
    rec['floorTrip'] = json.load(open(os.path.join(out, 'floor-trip.json'))) if os.path.exists(os.path.join(out, 'floor-trip.json')) else None
    rec['endedAt'] = time.time(); rec['productionAfter'] = {p: sha(p) for p in PINS}; rec['osDiskIdentAfter'] = ident(prep['osDisk'])
    rec['productionUnchanged'] = rec['productionAfter'] == rec['production'] and rec['osDiskIdentAfter'] == rec['osDiskIdent']
    rec['overlayAllocated'] = os.stat(prep['overlay']).st_blocks * 512; rec['nvmeAvailAfter'] = avail_bytes(out); save()
    return {'controller': rec, 'rc': 0 if rec['productionUnchanged'] and not rec['floorTrip'] else 4}


# ---- prove (read-only; rc 3 on any failure) ----------------------------------------------------------------------------------
def ssh(cmd, run):
    return run(['ssh', '-F', f'{PROD}/ssh_config', '-o', 'BatchMode=yes', '-o', f'UserKnownHostsFile={PROD}/known_hosts',
                '-o', 'StrictHostKeyChecking=yes', 'enclave-rpc', cmd], capture_output=True, text=True, timeout=60)


def guest_checks(m, prep, sections):
    """sections: {cmdline, uname, memtotal_kb, unitfiles, units, findmnt:{mount: out}, lsblk} -> list of failures"""
    bad = []
    if sections['cmdline'].strip() != ' '.join(expected_cmdline(m, prep)):
        bad.append('the guest /proc/cmdline is not EXACTLY the prepared cmdline + masks')
    if sections['uname'].strip() != prep['kernelVersion']:
        bad.append(f'uname -r {sections["uname"].strip()} != prepared kernel {prep["kernelVersion"]}')
    mt = int(sections['memtotal_kb']) * 1024 if sections['memtotal_kb'].strip().isdigit() else None
    if mt is None or mt > GUEST_MEM or mt < GUEST_MEM - GIB:
        bad.append(f'guest MemTotal {mt} is not ~8 GiB')
    names = set()
    for l in sections['unitfiles'].splitlines():                                 # every enclave-* unit FILE: masked-runtime
        t = l.split()
        if t:
            names.add(t[0])
            if len(t) < 2 or t[1] != 'masked-runtime':
                bad.append(f'{t[0]} is {t[1:] or "?"}, not masked-runtime')
    for l in sections['units'].splitlines():                                     # every loaded enclave-* unit: inactive
        t = l.split()
        if t and (len(t) < 4 or t[2] != 'inactive'):
            bad.append(f'unit {t[0]} is not inactive: {t[1:4]}')
    want = set(mask_set(m, prep))                                                # N1: EQUAL to the masked set (disk + reviewed + mounts)
    if names != want:
        bad.append(f'guest unit inventory != prepared mask set: missing {sorted(want - names)}, unrecorded {sorted(names - want)}')
    for mnt, txt in sections['findmnt'].items():
        if txt.strip():
            bad.append(f'{mnt} is mounted: {txt.strip()[:80]}')
    serial = {v['serial']: k for k, v in m['disks'].items()}
    seen = set()
    for l in sections['lsblk'].splitlines():
        t = l.split()
        if len(t) >= 3 and t[1] in serial:
            seen.add(serial[t[1]])
            if serial[t[1]] != 'os' and (t[2] != '1' or len(t) > 3):
                bad.append(f'{serial[t[1]]} disk {t[0]} is not read-only or has a mountpoint: {t[2:]}')
    if seen != {'os', 'l1', 'base'}:
        bad.append(f'disks by serial seen {sorted(seen)}, expected os/l1/base')
    return bad


def guest_query(mounts):
    """one read-only shell line, 8 sections separated by '@@' lines (names shell-quoted: mount units contain backslashes)"""
    q = shlex.quote
    return ('cat /proc/cmdline; echo @@; uname -r; echo @@; awk ' + q('/^MemTotal:/{print $2}') + ' /proc/meminfo; echo @@; '
            'systemctl list-unit-files --no-legend ' + q('enclave-*') + ' ' + ' '.join(q(mount_unit(x)) for x in mounts) + '; echo @@; '
            'systemctl list-units --all --no-legend --plain ' + q('enclave-*') + '; echo @@; '
            + ' '.join(f'findmnt -rn --mountpoint {q(x)}; echo @@;' for x in mounts) + ' lsblk -rndo NAME,SERIAL,RO,MOUNTPOINTS')


def sections_of(parts, mounts):
    return {'cmdline': parts[0], 'uname': parts[1], 'memtotal_kb': parts[2].strip(), 'unitfiles': parts[3], 'units': parts[4],
            'findmnt': {mounts[0]: parts[5], mounts[1]: parts[6]}, 'lsblk': parts[7]}


def cmd_prove(out, run=subprocess.run):
    pv, m, prep = checked(out)
    ctl = json.load(open(os.path.join(out, 'controller.json')))
    bad = []
    require_production_stopped(run)
    if start_token(ctl['pid']) != ctl['startToken']:
        bad.append('the controller is not running')
    v, f = unit_props(VM_UNIT, run), unit_props(FLOOR_UNIT, run)
    if v.get('ActiveState') != 'active' or v.get('InvocationID') != ctl.get('vmInvocation'):
        bad.append(f'VM unit is not OUR active invocation: {v.get("ActiveState")} {v.get("InvocationID")}')
    if f.get('ActiveState') != 'active' or f.get('InvocationID') != ctl.get('floorInvocation'):
        bad.append(f'floor unit is not OUR active invocation: {f.get("ActiveState")}')
    if FLOOR_UNIT not in v.get('BindsTo', '').split() or v.get('MemoryMax') != str(VM_MAX) or v.get('MemorySwapMax') != '0':
        bad.append(f'VM unit BindsTo/MemoryMax/MemorySwapMax are {v.get("BindsTo")}/{v.get("MemoryMax")}/{v.get("MemorySwapMax")}')
    if bad:                                                                       # never SSH into a guest that may not be ours
        return {'ok': False, 'failures': bad}
    try:
        qb = qmp('query-block').get('return', [])
    except (OSError, ValueError) as e:
        qb = []; bad.append(f'QMP query-block failed: {e}')
    mounts = [m['disks'][k]['mount'] for k in ('l1', 'base')]
    r = ssh(guest_query(mounts), run)
    parts = r.stdout.split('@@\n')
    if r.returncode != 0 or len(parts) != 8:
        bad.append(f'guest query failed (rc {r.returncode}, {len(parts)} sections)')
    else:
        bad += guest_checks(m, prep, sections_of(parts, mounts))
    for node in ('l10', 'base0'):
        b = next((x for x in qb if x.get('inserted', {}).get('node-name') == node), None)
        if not b or b['inserted'].get('ro') is not True:
            bad.append(f'QMP: {node} is not read-only')
    return {'ok': not bad, 'failures': bad, 'scope': 'OS overlay boot only; data disks read-only; NOT the production disk installation'}


def cmd_stop(out):
    ctl = json.load(open(os.path.join(out, 'controller.json')))
    if start_token(ctl['pid']) != ctl['startToken']:
        raise Refuse('the recorded controller is not running (nothing of ours to stop through it)')
    os.kill(ctl['pid'], signal.SIGTERM)
    return {'signalled': ctl['pid'], 'next': 'the controller powers the VM down (ACPI, bounded force) and stops its floor unit'}


def cmd_discard(out, run=subprocess.run):
    for u in (VM_UNIT, FLOOR_UNIT):
        if unit_props(u, run).get('ActiveState') not in ('inactive', 'failed'):
            raise Refuse(f'{u} is still active')
    ctl = json.load(open(os.path.join(out, 'controller.json'))) if os.path.exists(os.path.join(out, 'controller.json')) else {}
    if ctl and start_token(ctl['pid']) == ctl['startToken']:
        raise Refuse('the controller is still running')
    prep = json.load(open(os.path.join(out, 'PREPARED.json')))
    removed = []
    for n in ('os-qual.qcow2', 'vmlinuz', 'initrd'):
        p = os.path.join(out, n)
        if os.path.exists(p):
            os.chmod(p, 0o600); os.unlink(p); removed.append(n)
    production()
    rec = {'discarded': removed, 'osDiskIdent': ident(prep['osDisk']), 'productionUnchanged': ident(prep['osDisk']) == prep['osDiskIdent']}
    json.dump(rec, open(os.path.join(out, 'discard-receipt.json'), 'w'), indent=1, sort_keys=True)
    if not rec['productionUnchanged']:
        raise Refuse(f'production OS disk identity changed: {rec}')
    return rec


def main(argv=None, run=subprocess.run):
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    for c in ('prepare', 'controller', 'prove', 'stop', 'discard', 'inventory'):
        sub.add_parser(c).add_argument('out')
    f = sub.add_parser('floor'); f.add_argument('out'); f.add_argument('--controller-pid', type=int, required=True); f.add_argument('--controller-token', required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'floor':
            return cmd_floor(a.out, a.controller_pid, a.controller_token)
        out = {'prepare': lambda: cmd_prepare(a.out, run), 'controller': lambda: cmd_controller(a.out, run),
               'prove': lambda: cmd_prove(a.out, run), 'stop': lambda: cmd_stop(a.out), 'discard': lambda: cmd_discard(a.out, run),
               'inventory': lambda: cmd_inventory(a.out, run)}[a.cmd]()
    except (Refuse, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(json.dumps({'refused': f'{type(e).__name__}: {e}'})); return 2
    print(json.dumps(out, indent=1, sort_keys=True, default=str))
    if a.cmd == 'prove' and out.get('ok') is not True:                            # B2: a failed proof is never rc 0
        return 3
    if a.cmd == 'controller':
        return out['rc']
    if a.cmd == 'inventory' and out.get('ok') is not True:                       # the record is written; problems are never rc 0
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
