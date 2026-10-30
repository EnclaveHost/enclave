#!/usr/bin/python3 -I
"""postrestore-maintenance-stage/r1: ONE bounded maintenance boot of the STOPPED enclave-rpc-production OS disk that disables +
masks the guest's snapshot / retention / holder / L1 auto-start units (guest_mask.py), then powers off. Runs as uid 1000, never
root; never starts, stops, edits or renders the production VM/guard units or files. The chain disks (Base, L1) are NEVER attached.

  prepare --evidence NEW_DIR [--backup-root DIR]
      Pins: installed launcher 38f8dc89..., manifest a2843215... (canonical, qemuArgv re-derived), ssh_config == launcher render,
      seed ISO sha == manifest. Refuses unless production VM + guard are inactive/failed, no enclave-rpc-maint-* unit is active,
      no own process holds the OS disk/seed, `qemu-img info` (no -U) gets the lock, the OS disk identity (ino/size/mtime) is the
      one the root inventory 20261028 saw, the existing known_hosts has the production host key, port 22851 is free,
      MemAvailable >= 10 GiB cap + 16 GiB floor, NVMe free >= floorBytes + backup + full OS growth + 4 GiB.
      Derives the argv from the pinned launcher's own qemu_argv(): Base/L1 blockdev+device removed by exact node name, RAM 8 GiB,
      2 vCPU, private QMP/console, user net restrict=on with ONE hostfwd 127.0.0.1:22851 -> guest :22, -S; then validates the
      result against an allowlist (os0 + read-only seed0 only, no other path, device, netdev or option).
      OS backup on the SAME NVMe filesystem: new dir + O_EXCL file under an existing 0700 backup root, sparse copy hashed in the
      same pass (bounded time/bytes), source stat unchanged, fsync, fresh O_NOFOLLOW re-open (same new inode) + fadvise-dropped
      re-hash, qemu-img info/check. PREPARED.json is written last: any backup failure leaves no PREPARED.json -> launch refuses.
  launch --evidence DIR   single use. Repeats every check (OS identity == prepared, backup intact), starts ONE transient user
      service (MemoryMax 10 GiB, MemorySwapMax 0, RuntimeMaxSec) running QEMU -S, verifies over its own QMP + /proc + cgroup that
      it is exactly the planned argv/limits/block nodes BEFORE `cont`, waits for SSH (StrictHostKeyChecking=yes against the
      existing known_hosts via HostKeyAlias, existing identity), runs guest_mask.py, ACPI powerdown. success == guest verified AND
      SHUTDOWN(guest) event + QMP closed + unit inactive + QEMU pid gone. On any failure: owned QMP powerdown (or `quit` while
      still prelaunch), then `systemctl --user stop` of the exact unit ONLY if its InvocationID is ours. No pid is ever killed;
      backup and evidence are kept; nothing is restored automatically.
  finish --evidence DIR   read-only: unit gone, production still stopped + pinned, qemu-img check of the OS disk (no -U), backup intact.
"""
import argparse, datetime, errno, hashlib, json, os, re, secrets, socket, stat, subprocess, sys, time, types

STATE = '/home/steven/.local/state/enclave-rpc-production'
LAUNCHER_SHA = '38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7'
MANIFEST_SHA = 'a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'
OS_DISK = '/vm/enclave-volumes/rpc-production/os.qcow2'
OS_ID = {'ino': 147981797, 'size': 18581159936, 'mtimeNs': 1793030445722920013}   # logs/root-postrestore-mask-inventory-20261028.out
BACKUP_ROOT = '/vm/enclave-volumes/rpc-production-maint'
MASK_UNITS = ('enclave-rpc-base-snapshot.service', 'enclave-rpc-l1-snapshot.service', 'enclave-base-retention.service',
              'enclave-base-holder.path', 'enclave-base-holder.service', 'enclave-l1-el.path', 'enclave-l1-el.service',
              'enclave-l1-cl.service')
DROP_NODES = ('l10', 'base0')                      # role + '0' in the launcher's qemu_argv (checked against DISK_ROLES)
CHAIN_MARKERS = ('base-origin', 'l1-origin', '/mnt/usb')
PROD_UNITS = ('enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service')
MAINT = 'enclave-rpc-maint'
GIB = 1 << 30
GUEST_MEM, VCPUS, MEMORY_MAX, HOST_FLOOR, MARGIN = 8 * GIB, 2, 10 * GIB, 16 * GIB, 4 * GIB
SSH_PORT, GUEST_IP, HOSTKEY_ALIAS = 22851, '10.0.2.15', '[127.0.0.1]:22850'
QEMU, QEMU_IMG = '/usr/bin/qemu-system-x86_64', '/usr/bin/qemu-img'
SANDBOX = 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny'
FLAGS = {'-nodefaults': 0, '-no-user-config': 0, '-S': 0, **{f: 1 for f in (
    '-name', '-object', '-machine', '-cpu', '-smp', '-m', '-overcommit', '-rtc', '-display', '-sandbox', '-msg', '-chardev',
    '-serial', '-qmp', '-mon', '-device', '-blockdev', '-netdev')}}
NET_KEYS = {'id', 'restrict', 'ipv6', 'net', 'host', 'dhcpstart', 'dns', 'hostfwd'}
ACTIVE = ('active', 'activating', 'deactivating', 'reloading', 'refreshing')
HOSTKEY_ERRORS = ('Host key verification failed', 'IDENTIFICATION HAS CHANGED', 'Permission denied')
LIMITS = {'copyS': 1800, 'qmpS': 180, 'sshS': 600, 'guestS': 480, 'powerdownS': 300, 'unitGoneS': 60, 'stopS': 180,
          'runtimeMaxS': 3000, 'consoleBytes': 16 << 20, 'outBytes': 1 << 20}
CHUNK = 4 << 20
ZERO = bytes(CHUNK)
DEFAULT_CFG = {'launcher': f'{STATE}/provision_vm.py', 'launcherSha': LAUNCHER_SHA, 'manifest': f'{STATE}/manifest.json',
               'manifestSha': MANIFEST_SHA, 'osDisk': OS_DISK, 'osId': OS_ID, 'seedIso': f'{STATE}/seed.iso',
               'sshConfig': f'{STATE}/ssh_config', 'knownHosts': f'{STATE}/known_hosts', 'runtimeRoot': f'/run/user/{os.getuid()}',
               'proc': '/proc', 'cgroupRoot': '/sys/fs/cgroup', 'meminfo': '/proc/meminfo', 'nvmeMount': None,
               'guestScript': os.path.join(os.path.dirname(os.path.abspath(__file__)), 'guest_mask.py'), 'limits': LIMITS}


class Refuse(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


def default_run(argv, timeout=120, input=None):
    return subprocess.run(argv, input=input, stdin=None if input is not None else subprocess.DEVNULL, capture_output=True,
                          timeout=timeout)


class Ctx:
    """everything with a side effect outside this process goes through here (tests replace it)"""
    def __init__(self, cfg=None, run=default_run, qmp=None, clock=time.monotonic, sleep=time.sleep, mount=None, uuid_of=None,
                 free=None, stamp=None):
        self.cfg, self.run, self.clock, self.sleep = dict(cfg or DEFAULT_CFG), run, clock, sleep
        self.qmp, self.mount, self.uuid_of = qmp or QMP, mount, uuid_of
        self.free = free or (lambda p: os.statvfs(p).f_bavail * os.statvfs(p).f_frsize)
        self.stamp = stamp or (lambda: datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3))
        self.trace = None                                  # launch phase Trace (set by cmd_launch, read by main for REFUSED)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_nofollow(path, limit=1 << 20):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            refuse(f'{path} is not a regular file of at most {limit} bytes')
        chunks, n = [], 0
        while (b := os.read(fd, 1 << 20)):
            chunks.append(b); n += len(b)
            if n > limit:
                refuse(f'{path} grew past {limit} bytes')
        return b''.join(chunks), st
    finally:
        os.close(fd)


def read_json(path):
    return json.loads(read_nofollow(path)[0])


def write_new(path, obj):
    data = (json.dumps(obj, indent=1, sort_keys=True) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data); os.fsync(fd)
    finally:
        os.close(fd)
    return data


def load_pinned(path, want):
    """execute exactly the pinned launcher bytes as a private module (read once, no import machinery, no .pyc)"""
    src, _ = read_nofollow(path)
    if sha(src) != want:
        refuse(f'{path} is not the pinned launcher {want[:8]}...')
    mod = types.ModuleType('pv_pinned_maint'); mod.__file__ = path
    exec(compile(src, path, 'exec'), mod.__dict__)
    return mod


# ---- pins + host checks (read-only) -------------------------------------------------------------------------------------
def load_pins(c):
    if os.geteuid() == 0:
        refuse('runs as the VM owner uid, never as root')
    L = load_pinned(c.cfg['launcher'], c.cfg['launcherSha'])
    text, _ = read_nofollow(c.cfg['manifest'])
    if sha(text) != c.cfg['manifestSha']:
        refuse(f"{c.cfg['manifest']} is not the pinned manifest {c.cfg['manifestSha'][:8]}...")
    m = json.loads(text)
    if L.canonical(m) != text.decode() or m['files']['launcher'] != c.cfg['launcherSha'] or m.get('uid') != os.getuid():
        refuse('manifest is not canonical, does not pin the launcher, or belongs to another uid')
    if L.sha256_text(L.canonical(L.qemu_argv(m))) != m['files']['qemuArgv']:
        refuse('the pinned launcher no longer renders the manifest qemuArgv')
    p = m['paths']
    if (m['disks']['os']['path'], p['seedIso'], p['sshConfig'], p['knownHosts']) != \
            (c.cfg['osDisk'], c.cfg['seedIso'], c.cfg['sshConfig'], c.cfg['knownHosts']):
        refuse('manifest OS/seed/ssh paths are not the reviewed ones (wrong path)')
    if sorted(m['disks']) != ['base', 'l1', 'os'] or sorted(r['role'] + '0' for r in L.DISK_ROLES) != sorted(DROP_NODES):
        refuse('manifest/launcher disk roles are not exactly os + l1 + base')
    cfgb, _ = read_nofollow(c.cfg['sshConfig'])
    if cfgb.decode() != L.render_ssh_config(m) or sha(cfgb) != m['files']['sshConfig']:
        refuse('ssh_config is not the launcher render pinned in the manifest')
    seed, st = read_nofollow(c.cfg['seedIso'], 16 << 20)
    if st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o022 or sha(seed) != m['files']['seedIso']:
        refuse('seed ISO is not the single-link, owner-only original pinned in the manifest')
    return L, m


def unit_state(c, unit):
    r = c.run(['systemctl', '--user', 'show', '--property=LoadState,ActiveState,SubState,Result,InvocationID,MainPID,ControlGroup',
               unit], timeout=30)
    if r.returncode:
        refuse(f'cannot read the state of {unit}')
    return dict(l.split('=', 1) for l in r.stdout.decode().splitlines() if '=' in l)


def quiet(c):
    for u in PROD_UNITS:
        s = unit_state(c, u)
        if s.get('ActiveState') not in ('inactive', 'failed'):
            refuse(f"{u} is {s.get('ActiveState')}: the production VM/guard must stay stopped")
    r = c.run(['systemctl', '--user', 'list-units', '--all', '--plain', '--no-legend', '--no-pager', f'{MAINT}-*'], timeout=30)
    busy = [l.split()[0] for l in r.stdout.decode().splitlines() if len(l.split()) > 2 and l.split()[2] not in ('inactive', 'failed')]
    if r.returncode or busy:
        refuse(f'another maintenance unit is active or unreadable: {busy}')


def holders(c):
    """own processes only (uid 1000 cannot read other uids' fds: QEMU's image lock in locks() covers writers)"""
    want, hits = {c.cfg['osDisk'], c.cfg['seedIso']}, []
    for pid in (d for d in os.listdir(c.cfg['proc']) if d.isdigit()):
        fdd = f"{c.cfg['proc']}/{pid}/fd"
        try:
            hits += [pid for fd in os.listdir(fdd) if os.readlink(f'{fdd}/{fd}') in want]
        except OSError:
            continue
    if hits:
        refuse(f'processes hold the OS disk or seed: {sorted(set(hits))}')


def os_identity(c, want):
    p = c.cfg['osDisk']
    if os.path.realpath(p) != p:
        refuse(f'{p} has a symlink component (wrong path)')
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o022:
        refuse(f'{p} is not the regular, single-link, owner-writable-only OS disk')
    got = {'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'ctimeNs': st.st_ctime_ns, 'dev': st.st_dev,
           'blocks': st.st_blocks}
    drift = {k: (want[k], got[k]) for k in want if want[k] != got.get(k)}
    if drift:
        refuse(f'OS disk identity drift {drift}: not the disk the root inventory / prepare saw')
    return got


def qemu_img_json(c, sub, path, timeout):
    r = c.run([QEMU_IMG, sub, '--output=json', path], timeout=timeout)
    try:
        return r.returncode, json.loads(r.stdout.decode() or '{}')
    except ValueError:
        return r.returncode, {}


def locks(c, m):
    rc, info = qemu_img_json(c, 'info', c.cfg['osDisk'], 120)
    if rc:
        refuse('qemu-img info (no -U) failed: the OS disk is locked by another QEMU or unreadable')
    if info.get('format') != 'qcow2' or info.get('virtual-size') != m['disks']['os']['bytes'] or 'backing-filename' in info:
        refuse('the OS disk is not the expected standalone qcow2')


def known_host(c):
    r = c.run(['/usr/bin/ssh-keygen', '-F', HOSTKEY_ALIAS, '-f', c.cfg['knownHosts']], timeout=30)   # stdout not kept
    if r.returncode or not r.stdout.strip():
        refuse(f'{c.cfg["knownHosts"]} has no host key for {HOSTKEY_ALIAS}: strict verification would fail')


def listening(c, port):
    for n in ('tcp', 'tcp6'):
        try:
            rows = open(f"{c.cfg['proc']}/net/{n}").read().splitlines()[1:]
        except OSError:
            continue
        if any(r.split()[3] == '0A' and int(r.split()[1].rsplit(':', 1)[1], 16) == port for r in rows):
            return True
    return False


def mem_available(c):
    for line in open(c.cfg['meminfo']):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    refuse('MemAvailable missing')


def nvme(c, L, m, need):
    b = m['backings']['nvme']; mnt = c.cfg['nvmeMount'] or b['mount']
    e = (c.mount or L.mount_entry)(mnt)
    if e is None or e['source'] != b['source'] or e['fstype'] != b['fstype'] or 'rw' not in e['opts']:
        refuse(f'{mnt} is not the manifest NVMe filesystem mounted read-write')
    if (c.uuid_of or L.fs_uuid_of)(e['source']) != b['fsUuid'] or os.stat(mnt).st_dev != os.stat(c.cfg['osDisk']).st_dev:
        refuse(f'{mnt} UUID or device differs from the OS disk filesystem')
    free, floor = c.free(mnt), b['capacity']['floorBytes']
    if free < floor + need:
        refuse(f'NVMe free {free} < floor {floor} + needed {need}')
    return {'free': free, 'floor': floor, 'need': need}


def host_checks(c, m, want_os):
    quiet(c); holders(c)
    osid = os_identity(c, want_os)
    locks(c, m); known_host(c)
    if listening(c, SSH_PORT):
        refuse(f'host port {SSH_PORT} is already listening')
    if mem_available(c) < MEMORY_MAX + HOST_FLOOR:
        refuse(f'MemAvailable < {MEMORY_MAX} cap + {HOST_FLOOR} host floor')
    return osid


# ---- argv: derive from the pinned launcher, then validate independently -------------------------------------------------
def parse(argv):
    if not argv or argv[0] != QEMU:
        refuse('argv does not start with the QEMU binary')
    out, i = [], 1
    while i < len(argv):
        f = argv[i]
        if f not in FLAGS or i + FLAGS[f] >= len(argv) + (0 if FLAGS[f] else 1):
            refuse(f'QEMU option {f!r} is not allowed')
        out.append((f, argv[i + 1] if FLAGS[f] else None)); i += 1 + FLAGS[f]
    return out


def opts(v):
    if ',,' in v:
        refuse(f'escaped comma in {v!r}')
    parts = v.split(',')
    head = parts.pop(0) if '=' not in parts[0] else None
    return head, [tuple(p.split('=', 1)) if '=' in p else (p, None) for p in parts]


def run_paths(rd):
    return {'qmp': f'{rd}/qmp.sock', 'console': f'{rd}/console.sock', 'consoleLog': f'{rd}/console.log'}


def derive(L, m, rd):
    p, n = m['paths'], run_paths(rd)
    fwd = ''.join(f",hostfwd=tcp:127.0.0.1:{f['port']}-{L.GUEST_IP}:{f['port']}" for f in L.FORWARDS)
    net = f'net=10.0.2.0/24,host=10.0.2.2,dhcpstart={GUEST_IP},dns=10.0.2.3'
    swap = {   # exact launcher value -> maintenance value (None = drop); any other shape of these options is refused
        ('-name', f'{L.NAME},debug-threads=on'): f'{MAINT},debug-threads=on',
        ('-object', f'memory-backend-ram,id=rpcmem,size={L.GUEST_MEM},prealloc=on'): f'memory-backend-ram,id=rpcmem,size={GUEST_MEM},prealloc=on',
        ('-smp', f'{L.VCPUS},sockets=1,cores={L.VCPUS},threads=1'): f'{VCPUS},sockets=1,cores={VCPUS},threads=1',
        ('-m', f'{L.GUEST_MEM >> 20}M'): f'{GUEST_MEM >> 20}M',
        ('-chardev', f"socket,id=con0,path={p['console']},server=on,wait=off,logfile={p['consoleLog']},logappend=on"):
            f"socket,id=con0,path={n['console']},server=on,wait=off,logfile={n['consoleLog']},logappend=off",
        ('-qmp', f"unix:{p['qmp']},server=on,wait=off"): f"unix:{n['qmp']},server=on,wait=off",
        ('-chardev', f"socket,id=qmpg,path={p['guardQmp']},server=on,wait=off"): None,
        ('-mon', 'chardev=qmpg,mode=control'): None,
        ('-netdev', f'user,id=net0,ipv6=off,{net},hostfwd=tcp:127.0.0.1:{L.SSH_PORT}-{L.GUEST_IP}:22{fwd}'):
            f'user,id=net0,restrict=on,ipv6=off,{net},hostfwd=tcp:127.0.0.1:{SSH_PORT}-{GUEST_IP}:22',
    }
    seen, dropped, out = [], [], [QEMU]
    for f, v in parse(L.qemu_argv(m)):
        if (f, v) in swap:
            seen.append((f, v)); v = swap[(f, v)]
            if v is None:
                continue
        elif f == '-blockdev' and json.loads(v).get('node-name') in DROP_NODES:
            dropped.append(json.loads(v)['node-name']); continue
        elif f == '-device' and dict(opts(v)[1]).get('drive') in DROP_NODES:
            dropped.append('device:' + dict(opts(v)[1])['drive']); continue
        elif f in ('-name', '-smp', '-m', '-chardev', '-qmp', '-mon', '-netdev') or (f == '-object' and v.startswith('memory-')):
            refuse(f'launcher option {f} {v!r} is not the reviewed shape')
        out += [f] + ([v] if v is not None else [])
    if sorted(seen) != sorted(swap) or sorted(dropped) != sorted([*DROP_NODES, *(f'device:{x}' for x in DROP_NODES)]):
        refuse(f'launcher argv shape changed: rewrote {len(seen)}/{len(swap)}, dropped {sorted(dropped)}')
    return out + ['-S']


def validate(argv, rd, m, cfg):
    """the final argv on its own: only os0 + read-only seed0, one restricted user netdev, private sockets, no other path"""
    pr, n = parse(argv), run_paths(rd)
    one = lambda flag: [v for f, v in pr if f == flag]
    allowed = {QEMU, cfg['osDisk'], cfg['seedIso'], '/dev/urandom', *n.values()}
    stray = sorted({t for t in re.findall(r'(?<![\w.])/[\w.+/-]+', ' '.join(argv)) if t not in allowed})
    if stray or any(x in a for a in argv for x in CHAIN_MARKERS):
        refuse(f'argv names paths outside the allowlist: {stray or "chain marker"}')
    want = {'os0': ('qcow2', cfg['osDisk'], False), 'seed0': ('raw', cfg['seedIso'], True)}
    blk = [json.loads(v) for v in one('-blockdev')]
    if sorted(b.get('node-name') for b in blk) != sorted(want):
        refuse(f"block nodes are {sorted(str(b.get('node-name')) for b in blk)}, not exactly os0 + seed0")
    for b in blk:
        drv, path, ro = want[b['node-name']]
        if b.get('driver') != drv or b.get('read-only') is not ro or 'backing' in b or \
                b.get('file') != {'driver': 'file', 'filename': path, 'locking': 'on', 'aio': 'threads'}:
            refuse(f"block node {b['node-name']} is not {drv} {path} read-only={ro}")
    devs = {'virtio-rng-pci': {}, 'virtio-scsi-pci': {}, 'scsi-hd': {'drive': 'os0', 'serial': m['disks']['os']['serial']},
            'scsi-cd': {'drive': 'seed0'}, 'virtio-net-pci': {'netdev': 'net0', 'mac': m['mac']}}
    heads = []
    for v in one('-device'):
        head, kv = opts(v); kv = dict(kv); heads.append(head)
        if head not in devs or any(kv.get(k) != x for k, x in devs[head].items()) or ('drive' in kv and 'drive' not in devs[head]):
            refuse(f'device {v!r} is not allowed')
    nets = one('-netdev')
    head, kv = opts(nets[0]) if len(nets) == 1 else (None, [])
    if sorted(heads) != sorted(devs) or head != 'user' or dict(kv).get('restrict') != 'on' or {k for k, _ in kv} - NET_KEYS or \
            [x for k, x in kv if k == 'hostfwd'] != [f'tcp:127.0.0.1:{SSH_PORT}-{GUEST_IP}:22']:
        refuse('devices/netdev are not exactly the restricted maintenance set')
    exact = {'-m': [f'{GUEST_MEM >> 20}M'], '-smp': [f'{VCPUS},sockets=1,cores={VCPUS},threads=1'], '-sandbox': [SANDBOX],
             '-object': [f'memory-backend-ram,id=rpcmem,size={GUEST_MEM},prealloc=on', 'rng-random,id=rng0,filename=/dev/urandom'],
             '-machine': ['q35,accel=kvm,memory-backend=rpcmem'], '-cpu': ['host'], '-display': ['none'], '-mon': [],
             '-qmp': [f"unix:{n['qmp']},server=on,wait=off"], '-serial': ['chardev:con0'], '-S': [None],
             '-chardev': [f"socket,id=con0,path={n['console']},server=on,wait=off,logfile={n['consoleLog']},logappend=off"]}
    bad = [f for f, v in exact.items() if one(f) != v]
    if bad:
        refuse(f'argv options {bad} differ from the maintenance plan')
    return True


def properties(c):
    return [f'MemoryMax={MEMORY_MAX}', 'MemorySwapMax=0', 'TasksMax=512', 'LimitNOFILE=4096', 'NoNewPrivileges=yes', 'UMask=0077',
            'KillMode=mixed', 'TimeoutStopSec=120', f"RuntimeMaxSec={c.cfg['limits']['runtimeMaxS']}", 'Restart=no',
            'CollectMode=inactive']


def ssh_argv(c):
    o = [f'Port={SSH_PORT}', f'HostKeyAlias={HOSTKEY_ALIAS}', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'BatchMode=yes',
         'ConnectTimeout=10', 'ClearAllForwardings=yes', 'ForwardAgent=no', 'ControlMaster=no', 'ControlPath=none',
         'PermitLocalCommand=no', 'RequestTTY=no']
    return ['/usr/bin/ssh', '-F', c.cfg['sshConfig'], *[x for v in o for x in ('-o', v)], 'enclave-rpc', '--']


# ---- backup ---------------------------------------------------------------------------------------------------------------
def extents(fd, size):
    """(start, end, is_data) covering [0, size); holes come from SEEK_DATA/SEEK_HOLE"""
    off = 0
    while off < size:
        try:
            d = min(os.lseek(fd, off, os.SEEK_DATA), size)
        except OSError as e:
            if e.errno != errno.ENXIO:
                raise
            d = size
        if d > off:
            yield off, d, False
        if d >= size:
            return
        h = min(os.lseek(fd, d, os.SEEK_HOLE), size)
        if h <= d:
            refuse('SEEK_HOLE did not advance')
        yield d, h, True
        off = h


def hash_copy(src, size, deadline, clock, dst=None):
    """sha256 of [0, size) of src; with dst, writes every non-zero chunk at the same offset (holes stay holes)"""
    h, copied = hashlib.sha256(), 0
    for a, b, data in extents(src, size):
        pos = a
        while pos < b:
            if clock() > deadline:
                refuse('copy/checksum deadline exceeded')
            n = min(CHUNK, b - pos)
            buf = os.pread(src, n, pos) if data else ZERO[:n]
            if len(buf) != n:
                refuse(f'short read at {pos}')
            h.update(buf)
            if dst is not None and data and buf != ZERO[:n]:
                mv, w = memoryview(buf), 0
                while w < n:
                    w += os.pwrite(dst, mv[w:], pos + w)
                copied += n
            pos += n
    return h.hexdigest(), copied


def backup(c, osid, root, stamp):
    st = os.lstat(root)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or st.st_dev != osid['dev']:
        refuse(f'{root} must be an existing 0700 dir of this uid on the OS disk filesystem')
    lim, name = c.cfg['limits'], f'os-backup-{stamp}'
    deadline = c.clock() + lim['copyS']
    rfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if (os.fstat(rfd).st_dev, os.fstat(rfd).st_ino) != (st.st_dev, st.st_ino):
            refuse(f'{root} changed while opening')
        os.mkdir(name, 0o700, dir_fd=rfd)                                  # FileExistsError: never reused
        dfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rfd)
        src = os.open(c.cfg['osDisk'], os.O_RDONLY | os.O_NOFOLLOW)
        try:
            s0 = os.fstat(src)
            if (s0.st_ino, s0.st_size, s0.st_mtime_ns, s0.st_ctime_ns) != (osid['ino'], osid['size'], osid['mtimeNs'], osid['ctimeNs']):
                refuse('OS disk changed between the identity check and the copy')
            dst = os.open('os.qcow2', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                made = os.fstat(dst)
                digest, copied = hash_copy(src, s0.st_size, deadline, c.clock, dst)
                os.ftruncate(dst, s0.st_size); os.fchmod(dst, 0o400); os.fsync(dst)
            finally:
                os.close(dst)
            os.fsync(dfd); os.fsync(rfd)
            s1 = os.fstat(src)
            if (s1.st_ino, s1.st_size, s1.st_mtime_ns, s1.st_ctime_ns) != (s0.st_ino, s0.st_size, s0.st_mtime_ns, s0.st_ctime_ns):
                refuse('OS disk changed during the copy')
        finally:
            os.close(src)
        vfd = os.open('os.qcow2', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)    # fresh open of the new inode, cache dropped
        try:
            v = os.fstat(vfd)
            if (v.st_dev, v.st_ino, v.st_nlink, v.st_size) != (made.st_dev, made.st_ino, 1, s0.st_size) or v.st_ino == osid['ino'] \
                    or v.st_dev != osid['dev']:
                refuse('backup is not the fresh single-link inode on the OS filesystem')
            os.posix_fadvise(vfd, 0, 0, os.POSIX_FADV_DONTNEED)
            again, _ = hash_copy(vfd, v.st_size, deadline, c.clock)
        finally:
            os.close(vfd); os.close(dfd)
    finally:
        os.close(rfd)
    if again != digest:
        refuse('backup re-hash differs from the source hash')
    path = f'{root}/{name}/os.qcow2'
    rc, info = qemu_img_json(c, 'info', path, 120)
    crc, chk = qemu_img_json(c, 'check', path, 600)
    if rc or info.get('format') != 'qcow2' or 'backing-filename' in info or crc not in (0, 3) or chk.get('corruptions', 0) \
            or chk.get('check-errors', 0):
        refuse(f'qemu-img info/check of the backup failed (rc {rc}/{crc})')
    return {'path': path, 'ino': v.st_ino, 'dev': v.st_dev, 'size': v.st_size, 'mtimeNs': v.st_mtime_ns, 'sha256': digest,
            'copiedBytes': copied, 'allocatedBytes': v.st_blocks * 512, 'sourceAllocatedBytes': s0.st_blocks * 512,
            'qemuImgCheck': {k: chk.get(k) for k in ('check-errors', 'corruptions', 'leaks', 'image-end-offset')}}


def backup_intact(bk):
    st = os.lstat(bk['path'])
    if not stat.S_ISREG(st.st_mode) or (st.st_ino, st.st_dev, st.st_size, st.st_mtime_ns, st.st_nlink, stat.S_IMODE(st.st_mode)) != \
            (bk['ino'], bk['dev'], bk['size'], bk['mtimeNs'], 1, 0o400):
        refuse(f"backup {bk['path']} is not the verified file")


# ---- QMP (own private socket) ---------------------------------------------------------------------------------------------
QMP_CMD_S = 30                  # absolute bound of one command (formerly a per-recv timeout that every partial read restarted)
QMP_FRAME_MAX = 1 << 20         # one JSON line; the receive buffer never holds more than QMP_FRAME_MAX + QMP_RECV bytes
QMP_RECV = 65536
QMP_EVENTS_KEEP = 64            # retained event summaries (name + SHUTDOWN guest/reason only); older ones are dropped + counted
QMP_ABANDONED_MAX = 4           # ids sent without a verified reply whose late replies are absorbed once; more -> unusable
QMP_EINTR_MAX = 16              # interrupted send/recv retries per operation, each against the same absolute end
QMP_CONNECT_RETRY = frozenset((errno.ENOENT, errno.ECONNREFUSED, errno.EAGAIN))   # connect(2) only: not listening / backlog full
QMP_MUTATING = frozenset(('cont', 'system_powerdown', 'quit'))
QMP_EVENT = re.compile(r'[A-Z][A-Z0-9_]{0,63}')
QMP_REASON = re.compile(r'[a-z][a-z-]{0,31}')


def safe_text(v, n):
    return ''.join(ch if ' ' <= ch <= '~' else '?' for ch in str(v)[:n])


def errno_name(n):
    return errno.errorcode.get(n, str(n)) if isinstance(n, int) else None


def unix_stream():
    return socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)


class QMPError(Refuse):
    """QMP transport/protocol failure. stage = connect|greeting|capabilities|command|pump, op = the step that failed
    (socket|connect|send|recv|decode|frame|envelope|event|correlate|reply|eof|deadline|state|not-ready|unit-inactive).
    Carries only fixed strings, numbers and our own request ids: never peer payload bytes."""
    def __init__(self, stage, op, msg, err=None, command=None, rid=None, sent=None):
        self.stage, self.op, self.command, self.rid, self.sent = stage, op, command, rid, sent
        self.errno = err.errno if isinstance(err, OSError) and isinstance(err.errno, int) else None
        self.cause = type(err).__name__ if err is not None else None
        self.expired = op == 'deadline' or isinstance(err, socket.timeout)
        self.outcome = 'not-sent' if sent == 'none' else None      # 'unknown' | 'rejected' set where they become known
        super().__init__(f"QMP {stage}/{op}{f' {command} ({rid})' if command else ''}: {msg}"
                         f"{f' [{errno_name(self.errno)}]' if self.errno is not None else ''}")

    def diag(self):
        return {'stage': self.stage, 'op': self.op, 'errno': self.errno, 'errnoName': errno_name(self.errno), 'cause': self.cause,
                'expired': self.expired, 'command': self.command, 'requestId': self.rid, 'sent': self.sent, 'outcome': self.outcome}


class QMP:
    """own private QMP monitor. One absolute end per operation (the constructor's covers connect + greeting + capabilities and
    every partial read/write/event inside them), per-connection request ids with exact reply correlation, bounded frame, buffer
    and event storage. A command is never resent; without a verified reply its outcome is recorded as unknown."""
    DEADLINE_AWARE = True          # explicit seam: legacy injected factories/fakes keep factory(path) / cmd(name) / pump(seconds)

    def __init__(self, path, *, end=None, clock=time.monotonic, sock=unix_stream):
        self.s, self.clock, self.buf, self.eof, self.broken, self.trailing, self.close_errno = None, clock, b'', False, None, 0, None
        self.next_id, self.abandoned, self.late, self.uncertain = 0, {}, {}, {}
        self.recent, self.shutdown_guest, self.events_seen, self.events_dropped = [], None, 0, 0
        end = clock() + QMP_CMD_S if end is None else end
        try:
            try:
                self.s = sock()
            except OSError as e:
                raise QMPError('connect', 'socket', 'cannot create the socket', e) from e
            self._io('connect', 'connect', end, lambda: self.s.connect(path), retry_eintr=False)
            g = self._frame('greeting', end)
            q = g.get('QMP') if g is not None else None
            if set(g or ()) != {'QMP'} or not isinstance(q, dict) or not isinstance(q.get('version'), dict) or \
                    not isinstance(q.get('capabilities'), list):
                raise self._fail('greeting', 'eof' if g is None else 'envelope', 'no valid QMP greeting')
            self.cmd('qmp_capabilities', end, stage='capabilities')
        except BaseException:
            self.close()                                     # never leaks the new socket; the original exception propagates
            raise

    def _fail(self, stage, op, msg, err=None, **ctx):
        """protocol/stream failure: the connection is unusable from now on (fail closed)"""
        if self.broken is None:
            self.broken = f'{stage}/{op}'
        return QMPError(stage, op, msg, err, **ctx)

    def _io(self, stage, op, end, fn, retry_eintr=True, **ctx):
        """one blocking socket call with the REMAINING time to `end` (end reached == expired); EINTR retries are capped"""
        last = None
        for _ in range(QMP_EINTR_MAX):
            left = end - self.clock()
            if left <= 0:
                raise QMPError(stage, 'deadline', 'operation deadline reached', **ctx)
            try:
                self.s.settimeout(left)
                return fn()
            except InterruptedError as e:
                if not retry_eintr:
                    raise self._fail(stage, op, 'interrupted', e, **ctx) from e
                last = e
            except socket.timeout as e:
                raise QMPError(stage, op, 'timed out', e, **ctx) from e
            except OSError as e:
                raise self._fail(stage, op, 'failed', e, **ctx) from e
        raise self._fail(stage, op, f'interrupted {QMP_EINTR_MAX} times', last, **ctx)

    def _frame(self, stage, end, **ctx):
        """next complete JSON object, or None on a clean EOF; already-buffered frames honour the same end"""
        while b'\n' not in self.buf:
            if len(self.buf) > QMP_FRAME_MAX:
                raise self._fail(stage, 'frame', f'frame exceeds {QMP_FRAME_MAX} bytes', **ctx)
            chunk = self._io(stage, 'recv', end, lambda: self.s.recv(QMP_RECV), **ctx)
            if not chunk:
                self.eof = True
                if self.buf:
                    self.trailing, self.buf = len(self.buf), b''
                    raise self._fail(stage, 'eof', f'peer closed inside a frame ({self.trailing} bytes)', **ctx)
                return None
            self.buf += chunk
        if end - self.clock() <= 0:
            raise QMPError(stage, 'deadline', 'operation deadline reached', **ctx)
        line, self.buf = self.buf.split(b'\n', 1)
        if len(line) > QMP_FRAME_MAX:
            raise self._fail(stage, 'frame', f'frame exceeds {QMP_FRAME_MAX} bytes', **ctx)
        try:
            msg = json.loads(line)
        except (ValueError, RecursionError) as e:
            raise self._fail(stage, 'decode', 'frame is not JSON', e, **ctx) from e
        if not isinstance(msg, dict):
            raise self._fail(stage, 'envelope', 'frame is not a JSON object', **ctx)
        return msg

    def _send(self, stage, data, end, command, rid):
        view, done = memoryview(data), 0
        try:
            while done < len(data):
                n = self._io(stage, 'send', end, lambda: self.s.send(view[done:]), command=command, rid=rid)
                if not isinstance(n, int) or n <= 0:
                    raise self._fail(stage, 'send', 'send made no progress', command=command, rid=rid)
                done += n
        except QMPError as e:
            e.sent, e.outcome = ('partial', 'unknown') if done else ('none', 'not-sent')
            if done:                                         # a partial request is on the wire: stream unusable, outcome unknown
                self.broken = self.broken or f'{stage}/send-partial'
                self._abandon(rid, command)
            raise

    def _event(self, msg, stage, **ctx):
        name, data = msg.get('event'), msg.get('data', {})
        if not isinstance(name, str) or not QMP_EVENT.fullmatch(name) or set(msg) - {'event', 'data', 'timestamp'} or \
                not isinstance(data, dict):
            raise self._fail(stage, 'event', 'malformed event', **ctx)
        self.events_seen += 1
        kept = {'event': name}
        if name == 'SHUTDOWN':
            g, why = data.get('guest'), data.get('reason')
            kept['data'] = {'guest': g if isinstance(g, bool) else None}
            if isinstance(why, str) and QMP_REASON.fullmatch(why):
                kept['data']['reason'] = why
            if g is True and self.shutdown_guest is None:
                self.shutdown_guest = kept                   # pinned: the evidence powerdown() needs is never evicted
        self.recent.append(kept)
        if len(self.recent) > QMP_EVENTS_KEEP:
            self.recent.pop(0); self.events_dropped += 1

    @property
    def events(self):
        """bounded summaries; the first SHUTDOWN with data.guest True, once actually received, stays even after eviction"""
        pin = self.shutdown_guest
        return ([pin] if pin is not None and not any(e is pin for e in self.recent) else []) + list(self.recent)

    def _reply(self, msg, stage, **ctx):
        kind, got = [k for k in ('return', 'error') if k in msg], msg.get('id')
        if len(kind) != 1 or set(msg) - {'id', 'return', 'error'} or not isinstance(got, str):
            raise self._fail(stage, 'envelope', 'reply without exactly one return/error and a request id', **ctx)
        if kind == ['return']:
            return got, True, msg['return']
        err = msg['error']
        if not isinstance(err, dict) or not isinstance(err.get('class'), str) or not isinstance(err.get('desc'), str):
            raise self._fail(stage, 'envelope', 'malformed error reply', **ctx)
        return got, False, 'peer rejected the command'

    def _late(self, got, ok, stage, **ctx):
        """a reply that is not for the outstanding request: only ONE late reply to an abandoned id is absorbed"""
        if got not in self.abandoned:
            raise self._fail(stage, 'correlate', 'reply id is not the outstanding request (unexpected, duplicate or stale)', **ctx)
        self.abandoned.pop(got)
        self.late[got] = 'return' if ok else 'error'
        while len(self.late) > QMP_ABANDONED_MAX:
            self.late.pop(next(iter(self.late)))

    def _abandon(self, rid, name):
        self.abandoned[rid] = name
        if name in QMP_MUTATING:
            self.uncertain[name] = rid
        if len(self.abandoned) > QMP_ABANDONED_MAX:
            self.broken = self.broken or 'too many unanswered requests'

    def usable(self):
        return self.s is not None and not self.eof and self.broken is None

    def cmd(self, name, end=None, *, stage='command'):
        """run `name` once, bounded by min(end, now + QMP_CMD_S); only the reply carrying this request's id counts"""
        now = self.clock()
        end = now + QMP_CMD_S if end is None else min(end, now + QMP_CMD_S)
        if not self.usable():
            raise QMPError(stage, 'state', f"connection unusable ({self.broken or ('peer closed' if self.eof else 'closed')})",
                           command=name, sent='none')
        self.next_id += 1
        rid = f'maint-{self.next_id}'
        self._send(stage, json.dumps({'execute': name, 'id': rid}).encode() + b'\n', end, name, rid)
        ctx = {'command': name, 'rid': rid, 'sent': 'full'}
        try:
            while True:
                msg = self._frame(stage, end, **ctx)
                if msg is None:
                    raise QMPError(stage, 'eof', 'monitor closed before the reply', **ctx)
                if 'event' in msg:
                    self._event(msg, stage, **ctx)
                    continue
                got, ok, val = self._reply(msg, stage, **ctx)
                if got != rid:
                    self._late(got, ok, stage, **ctx)
                    continue
                if ok:
                    return val
                e = QMPError(stage, 'reply', val, **ctx)
                e.outcome = 'rejected'
                raise e
        except QMPError as e:
            if e.op != 'reply':                              # transmitted, no verified reply: unknown outcome, never resent
                e.outcome = 'unknown'
                self._abandon(rid, name)
            raise

    def pump(self, seconds, end=None):
        """handle at most one frame within min(end, now + seconds); False once QEMU closed the monitor"""
        if self.eof:
            return False
        if not self.usable():
            raise QMPError('pump', 'state', f"connection unusable ({self.broken or 'closed'})")
        now = self.clock()
        stop = now + seconds if end is None else min(end, now + seconds)
        try:
            msg = self._frame('pump', stop)
        except QMPError as e:
            if e.expired:
                return True                                  # quiet window; a partial frame stays buffered; the caller owns its end
            raise
        if msg is None:
            return False
        if 'event' in msg:
            self._event(msg, 'pump')
        else:
            got, ok, _ = self._reply(msg, 'pump')
            self._late(got, ok, 'pump')
        return not self.eof

    def close(self):
        """idempotent; never raises, so it cannot replace a primary failure"""
        s, self.s, self.buf = self.s, None, b''
        if s is not None:
            try:
                s.close()
            except OSError as e:
                self.close_errno = e.errno if isinstance(e.errno, int) else -1

    def stats(self):
        return {'requests': self.next_id, 'eventsSeen': self.events_seen, 'eventsKept': len(self.recent),
                'eventsDropped': self.events_dropped, 'guestShutdownEvidence': self.shutdown_guest is not None,
                'abandoned': list(self.abandoned), 'lateReplies': dict(self.late), 'outcomeUnknown': dict(self.uncertain),
                'broken': self.broken, 'peerClosed': self.eof, 'trailingBytes': self.trailing, 'closed': self.s is None,
                'closeErrno': errno_name(self.close_errno)}


def aware(q):
    return getattr(q, 'DEADLINE_AWARE', False) is True


def qmp_cmd(q, name, end):
    """explicit seam: deadline-aware connections get the caller's phase end; legacy injected fakes keep cmd(name)"""
    return q.cmd(name, end) if aware(q) else q.cmd(name)


def qmp_pump(q, seconds, end):
    return q.pump(seconds, end) if aware(q) else q.pump(seconds)   # legacy fakes: the caller's own loop bound still applies


def qmp_usable(q):
    return q.usable() if aware(q) else not q.eof


def qmp_uncertain(q):
    return dict(q.uncertain) if aware(q) else {}


def qmp_close(q):
    """close + safe status; never raises"""
    if aware(q):
        q.close()
        return {'closed': True, 'closeErrno': errno_name(q.close_errno)}
    close = getattr(q, 'close', None)
    if not callable(close):
        return {'closed': None}
    try:
        close()
    except Exception as e:
        return {'closed': False, 'closeError': type(e).__name__}
    return {'closed': True}


def guest_shutdown_seen(q):
    return any(e.get('event') == 'SHUTDOWN' and (e.get('data') or {}).get('guest') is True for e in q.events)


# ---- launch helpers --------------------------------------------------------------------------------------------------------
def same_process(c, pid, argv):
    try:
        with open(f"{c.cfg['proc']}/{pid}/cmdline", 'rb') as f:
            return [x.decode() for x in f.read().split(b'\0')[:-1]] == argv
    except FileNotFoundError:
        return False


def verify_prelaunch(c, q, st, argv):
    s = q.cmd('query-status') or {}
    if not isinstance(s, dict):
        refuse('QEMU query-status is not an object')
    if s.get('status') != 'prelaunch' or s.get('running'):
        refuse(f"QEMU is {safe_text(s.get('status'), 32)!r} running={s.get('running') is True}, not stopped in prelaunch")
    pid, cg = int(st.get('MainPID') or 0), st.get('ControlGroup') or ''
    if pid <= 0 or not same_process(c, pid, argv):
        refuse('the unit main process is not exactly the planned QEMU argv')
    with open(f"{c.cfg['proc']}/{pid}/cgroup") as f:
        if [l[3:] for l in f.read().splitlines() if l.startswith('0::')] != [cg]:
            refuse('QEMU is not in the transient unit cgroup')
    base = c.cfg['cgroupRoot'] + cg
    if open(f'{base}/memory.max').read().strip() != str(MEMORY_MAX) or open(f'{base}/memory.swap.max').read().strip() != '0':
        refuse('unit cgroup memory.max/swap.max are not 10 GiB / 0')
    nodes = q.cmd('query-named-block-nodes') or []
    if not isinstance(nodes, list) or not all(isinstance(x, dict) for x in nodes):
        refuse('QEMU query-named-block-nodes is not a list of objects')
    named = {x.get('node-name'): x for x in nodes}
    if {x.get('file') for x in nodes} - {c.cfg['osDisk'], c.cfg['seedIso']} or named.get('os0', {}).get('ro') is not False \
            or named.get('seed0', {}).get('ro') is not True:
        refuse('QEMU opened block nodes outside os0 (rw) + seed0 (ro)')
    return pid


def guard(c, plan, m):
    if mem_available(c) < HOST_FLOOR:
        refuse('host MemAvailable fell below the 16 GiB floor')
    log = run_paths(plan['runDir'])['consoleLog']
    if os.path.exists(log) and os.lstat(log).st_size > c.cfg['limits']['consoleBytes']:
        refuse('console log exceeded its cap')
    b = m['backings']['nvme']
    if c.free(c.cfg['nvmeMount'] or b['mount']) < b['capacity']['floorBytes']:
        refuse('NVMe free space reached the floor')


def wait_ssh(c, q, plan, m):
    deadline = c.clock() + c.cfg['limits']['sshS']
    while True:
        if not qmp_pump(q, 1, deadline):                  # never waits past the SSH phase end
            refuse('QEMU exited during boot')
        guard(c, plan, m)
        r = c.run(plan['ssh'] + ['true'], timeout=40)
        if r.returncode == 0:
            return
        err = r.stderr.decode('utf-8', 'replace')
        if any(x in err for x in HOSTKEY_ERRORS):
            refuse(f'SSH identity check failed: {err.strip()[-200:]}')
        if c.clock() >= deadline:
            refuse('SSH did not come up in time')
        c.sleep(5)


def run_guest(c, plan, script):
    r = c.run(plan['ssh'] + ['sudo', '-n', '/usr/bin/python3', '-I', '-', plan['stamp']], input=script,
              timeout=c.cfg['limits']['guestS'])
    lines = [l for l in (r.stdout or b'')[-c.cfg['limits']['outBytes']:].decode('utf-8', 'replace').splitlines() if l.strip()]
    try:
        rec = json.loads(lines[-1])
    except (IndexError, ValueError):
        rec = {'ok': False, 'error': 'no JSON result line'}
    rec['rc'] = r.returncode
    ver = rec.get('verified') or {}
    rec['accepted'] = r.returncode == 0 and rec.get('ok') is True and sorted(ver) == sorted(MASK_UNITS) and \
        all(v is True for v in ver.values())
    return rec


def wait_unit_inactive(c, unit, seconds):
    end, s = c.clock() + seconds, {}
    while True:
        s = unit_state(c, unit)
        if s.get('ActiveState') not in ACTIVE or c.clock() > end:
            return s
        c.sleep(1)


def powerdown(c, q, plan, pid):
    q.cmd('system_powerdown')
    end = c.clock() + c.cfg['limits']['powerdownS']
    while c.clock() < end and qmp_pump(q, 1, end):        # each pump is bounded by the same phase end
        pass
    s = wait_unit_inactive(c, plan['unit'], c.cfg['limits']['unitGoneS'])
    r = {'shutdownEvent': guest_shutdown_seen(q), 'qmpClosed': q.eof, 'unit': s.get('ActiveState'), 'loadState': s.get('LoadState'),
         'result': s.get('Result'), 'pidGone': not same_process(c, pid, plan['argv'])}
    r['verified'] = r['shutdownEvent'] and r['qmpClosed'] and r['pidGone'] and r['unit'] == 'inactive' and \
        (r['loadState'] == 'not-found' or r['result'] == 'success')
    return r


def cleanup(c, q, plan, inv, pid):
    """graceful first (owned QMP), then stop ONLY the exact unit of OUR invocation; never a signal to a pid. The graceful part
    has ONE end bounding every command/pump inside it, never resends a mutating command whose outcome on this connection is
    unknown, and any failure in it (of any type) still reaches the owned stop below"""
    out, lim = {}, c.cfg['limits']
    try:
        if q is not None and qmp_usable(q):
            qend = c.clock() + 2 * QMP_CMD_S + lim['powerdownS']
            s = qmp_cmd(q, 'query-status', qend)
            st = s.get('status') if isinstance(s, dict) else None
            out['qmpStatus'] = safe_text(st, 32) if isinstance(st, str) else None
            unknown = qmp_uncertain(q)
            if st == 'prelaunch':
                if 'quit' in unknown:
                    out['notResent'] = 'quit'
                else:
                    qmp_cmd(q, 'quit', qend)             # the guest never ran
            elif st == 'running':
                if 'system_powerdown' in unknown:        # sent earlier without a verified reply: observe only
                    out['notResent'] = 'system_powerdown'
                else:
                    qmp_cmd(q, 'system_powerdown', qend)
                end = min(c.clock() + lim['powerdownS'], qend)
                while c.clock() < end and qmp_pump(q, 1, end):
                    pass
            out['shutdownEvent'] = guest_shutdown_seen(q)  # paused/other: ACPI cannot work, the owned stop below SIGTERMs
        elif q is not None:
            out['qmpSkipped'] = 'monitor closed or unusable'
    except Exception as e:
        out['qmpError'] = str(e)
        out['qmpDiag'] = exc_info(e)
    try:
        s = wait_unit_inactive(c, plan['unit'], 30)
        if s.get('ActiveState') in ACTIVE:
            if not inv or s.get('InvocationID') != inv:
                out['stop'] = 'refused: the unit is not our invocation; operator action needed'
            else:
                out['stop'] = c.run(['systemctl', '--user', 'stop', plan['unit']], timeout=lim['stopS']).returncode
                s = unit_state(c, plan['unit'])
        out['final'] = {k: s.get(k) for k in ('LoadState', 'ActiveState', 'Result', 'InvocationID')}
    except (Refuse, OSError, subprocess.SubprocessError) as e:
        out['stateError'] = str(e)
    out['pidGone'] = not pid or not same_process(c, pid, plan['argv'])
    return out


def open_qmp(c, plan, end, t):
    """ONE absolute readiness end for every connect attempt, the greeting and qmp_capabilities. Only connect(2) finding nothing
    listening yet (ENOENT/ECONNREFUSED) or a full AF_UNIX backlog (EAGAIN) is retried: that attempt's socket is already closed,
    the owned unit must still be active and the pause never passes `end`. Any other error (any errno at greeting/capabilities/
    recv/send, permission, protocol) fails at once."""
    path, r, new = run_paths(plan['runDir'])['qmp'], t.readiness, aware(c.qmp)
    while True:
        r['attempts'] += 1
        try:
            return c.qmp(path, end=end, clock=c.clock) if new else c.qmp(path)
        except QMPError as e:
            if not new or (e.stage, e.op) != ('connect', 'connect') or e.errno not in QMP_CONNECT_RETRY:
                raise
            last = e.errno
        except (FileNotFoundError, ConnectionRefusedError) as e:   # legacy injected factory only: unambiguous not-listening
            if new:
                raise
            last = e.errno
        name = errno_name(last) or 'unknown'
        r['connectErrnos'][name] = r['connectErrnos'].get(name, 0) + 1
        left = end - c.clock()
        if left <= 0:
            raise QMPError('connect', 'not-ready', f"QMP never came up before the readiness end ({r['attempts']} attempts)")
        if unit_state(c, plan['unit']).get('ActiveState') not in ACTIVE:
            raise QMPError('connect', 'unit-inactive', f"QMP never came up: the owned unit is not active ({r['attempts']} attempts)")
        r['sleeps'] += 1
        c.sleep(min(1, left))


# ---- launch diagnostics: fixed vocabulary, class names, errno numbers, our own ids; no messages/payloads/locals/source -------
LAUNCH_PHASES = ('load-prepared', 'single-use', 'pins', 'host-checks', 'backup-intact', 'capacity', 'plan-match', 'unit-absent',
                 'run-dir', 'systemd-run', 'unit-state', 'qmp-ready', 'prelaunch-verify', 'cont', 'ssh-wait', 'guest', 'powerdown',
                 'done', 'cleanup', 'qmp-close', 'console-tail', 'result-write')
TB_FRAMES = 8


def exc_brief(e):
    n = e.errno if isinstance(e, OSError) and isinstance(e.errno, int) else None
    return {'class': type(e).__name__[:64], 'errno': n, 'errnoName': errno_name(n)}


def exc_info(e):
    """class/errno (+ QMP fields, one cause level) and the innermost frame locations as file basename/function/line"""
    d = exc_brief(e)
    if isinstance(e, QMPError):
        d['qmp'] = e.diag()
    cause = e.__cause__ if e.__cause__ is not None else (None if e.__suppress_context__ else e.__context__)
    d['cause'] = exc_brief(cause) if cause is not None else None
    frames, tb = [], e.__traceback__
    while tb is not None:
        co = tb.tb_frame.f_code
        frames.append({'file': os.path.basename(co.co_filename)[:64], 'func': co.co_name[:64], 'line': tb.tb_lineno})
        tb = tb.tb_next
    d['where'] = frames[-TB_FRAMES:]
    return d


class Trace:
    """the launch phase currently running (never changes which steps run)"""
    def __init__(self):
        self.phase, self.reached, self.cont, self.pid_verified = None, [], 'not-attempted', False
        self.readiness = {'attempts': 0, 'connectErrnos': {}, 'sleeps': 0}

    def enter(self, name):
        self.phase = name if name in LAUNCH_PHASES else 'unknown'           # evidence carries the fixed vocabulary only
        self.reached.append(self.phase)

    def snapshot(self, e=None):
        unit = 'systemd-run' in self.reached
        d = {'format': 'enclave-rpc-maint-diag/r1', 'phase': self.phase, 'phasesReached': list(self.reached),
             'unitRequested': unit, 'pidVerified': self.pid_verified, 'cont': self.cont,
             'readiness': {**self.readiness, 'connectErrnos': dict(self.readiness['connectErrnos'])}}
        if e is not None:
            d['preLaunch'] = not unit                    # failed before any unit/VM was requested: not a guest/VM failure
            d['error'] = exc_info(e)
        return d


# ---- phases ----------------------------------------------------------------------------------------------------------------
def cmd_prepare(c, ev, backup_root):
    L, m = load_pins(c)
    osid = host_checks(c, m, c.cfg['osId'])
    stamp = c.stamp()
    if not re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{6}', stamp):
        refuse('bad stamp')
    rd = f"{c.cfg['runtimeRoot']}/{MAINT}-{stamp}"
    argv = derive(L, m, rd); validate(argv, rd, m, c.cfg)
    script, _ = read_nofollow(c.cfg['guestScript'])
    cap = nvme(c, L, m, osid['size'] + m['disks']['os']['bytes'] + MARGIN)
    plan = {'format': 'enclave-rpc-maint-plan/r1', 'stamp': stamp, 'unit': f'{MAINT}-{stamp}.service', 'runDir': rd, 'argv': argv,
            'properties': properties(c), 'ssh': ssh_argv(c), 'guestScriptSha256': sha(script), 'maskUnits': list(MASK_UNITS),
            'launcherSha256': c.cfg['launcherSha'], 'manifestSha256': c.cfg['manifestSha'], 'capacity': cap,
            'limits': c.cfg['limits']}
    pb = write_new(f'{ev}/plan.json', plan)
    try:
        bk = backup(c, osid, backup_root, stamp)
    except (Refuse, OSError, subprocess.SubprocessError, ValueError) as e:
        write_new(f'{ev}/BACKUP-FAILED.json', {'error': str(e)})
        refuse(f'backup failed, boot refused (any partial backup is left for review): {e}')
    os_identity(c, {k: osid[k] for k in ('ino', 'size', 'mtimeNs', 'ctimeNs')})
    write_new(f'{ev}/PREPARED.json', {'format': 'enclave-rpc-maint-prepared/r1', 'planSha256': sha(pb), 'os': osid, 'backup': bk})
    return {'prepared': True, 'unit': plan['unit'], 'backup': bk['path'], 'next': f'launch --evidence {ev}'}


def load_prepared(ev):
    prep = read_json(f'{ev}/PREPARED.json')
    pb, _ = read_nofollow(f'{ev}/plan.json')
    if sha(pb) != prep.get('planSha256'):
        refuse('plan.json differs from the one PREPARED.json pinned')
    return prep, json.loads(pb)


def cmd_launch(c, ev):
    t = c.trace = Trace()
    t.enter('load-prepared'); prep, plan = load_prepared(ev)
    t.enter('single-use'); write_new(f'{ev}/LAUNCHED.json', {'at': time.time()})                    # single use
    t.enter('pins'); L, m = load_pins(c)
    t.enter('host-checks'); host_checks(c, m, {k: prep['os'][k] for k in ('ino', 'size', 'mtimeNs', 'ctimeNs', 'dev')})
    t.enter('backup-intact'); backup_intact(prep['backup'])
    t.enter('capacity'); nvme(c, L, m, m['disks']['os']['bytes'] + MARGIN)
    t.enter('plan-match')
    script, _ = read_nofollow(c.cfg['guestScript'])
    argv = derive(L, m, plan['runDir'])
    if sha(script) != plan['guestScriptSha256'] or argv != plan['argv'] or not validate(argv, plan['runDir'], m, c.cfg):
        refuse('guest script or derived argv differ from the prepared plan')
    t.enter('unit-absent')
    if unit_state(c, plan['unit']).get('LoadState') != 'not-found':
        refuse(f"{plan['unit']} already exists")
    t.enter('run-dir'); os.mkdir(plan['runDir'], 0o700)
    res, q, inv, pid = {'format': 'enclave-rpc-maint-result/r1', 'unit': plan['unit'], 'success': False}, None, None, 0
    try:
        t.enter('systemd-run')
        r = c.run(['systemd-run', '--user', '--quiet', f"--unit={plan['unit']}", '--description=enclave-rpc maintenance boot (no chain disks)',
                   *[f'--property={p}' for p in plan['properties']], '--', *argv], timeout=60)
        t.enter('unit-state')
        st = unit_state(c, plan['unit']); inv = st.get('InvocationID') or None   # unique fresh name: any invocation is ours
        res['invocationId'] = inv
        if r.returncode or not inv:
            refuse(f'systemd-run failed (rc {r.returncode})')
        t.enter('qmp-ready')
        q = open_qmp(c, plan, c.clock() + c.cfg['limits']['qmpS'], t)        # one absolute end, not a fresh one per attempt/recv
        t.enter('prelaunch-verify')
        pid = verify_prelaunch(c, q, unit_state(c, plan['unit']), argv)
        res['pid'] = pid; t.pid_verified = True
        t.enter('cont'); t.cont = 'outcome-unknown'                            # from here until QEMU's correlated reply
        q.cmd('cont')
        t.cont = 'acknowledged'
        t.enter('ssh-wait'); wait_ssh(c, q, plan, m)
        t.enter('guest')
        res['guest'] = run_guest(c, plan, script)
        if not res['guest']['accepted']:
            refuse(f"guest step not verified: {res['guest'].get('error')}")
        t.enter('powerdown')
        res['shutdown'] = powerdown(c, q, plan, pid)
        if not res['shutdown']['verified']:
            refuse('guest shutdown not verified')
        t.enter('done')
        res['success'] = True
    except Exception as e:                                                   # always reach the owned cleanup
        res['error'] = f'{type(e).__name__}: {e}'
        if t.cont == 'outcome-unknown' and isinstance(e, QMPError) and e.command == 'cont':
            t.cont = {'not-sent': 'not-transmitted', 'rejected': 'rejected'}.get(e.outcome, 'outcome-unknown')
        res['diagnostics'] = t.snapshot(e)
        t.enter('cleanup')
        try:
            res['cleanup'] = cleanup(c, q, plan, inv, pid)
        except Exception as ce:                                              # recorded beside, never instead of, the primary error
            res['cleanupError'] = exc_info(ce)
    finally:
        diag = res.setdefault('diagnostics', t.snapshot())
        if q is not None:
            t.enter('qmp-close')
            diag['qmp'] = q.stats() if aware(q) else None
            diag['qmpClose'] = qmp_close(q)
        t.enter('console-tail')
        try:
            fd = os.open(run_paths(plan['runDir'])['consoleLog'], os.O_RDONLY | os.O_NOFOLLOW)
            try:
                size = os.fstat(fd).st_size
                res['consoleTail'] = os.pread(fd, 1 << 20, max(0, size - (1 << 20))).decode('utf-8', 'replace')[-65536:]
            finally:
                os.close(fd)
        except OSError as e:
            res['consoleTail'] = f'unavailable: {e}'
        t.enter('result-write')
        write_new(f'{ev}/RESULT.json', res)
    return res


def cmd_finish(c, ev):
    prep, plan = load_prepared(ev)
    res = read_json(f'{ev}/RESULT.json')
    L, m = load_pins(c)
    quiet(c); holders(c)
    if unit_state(c, plan['unit']).get('ActiveState') in ACTIVE:
        refuse(f"{plan['unit']} is still active")
    osnow = os_identity(c, {'ino': prep['os']['ino'], 'dev': prep['os']['dev']})
    rc, chk = qemu_img_json(c, 'check', c.cfg['osDisk'], 600)
    backup_intact(prep['backup'])
    fin = {'format': 'enclave-rpc-maint-finish/r1', 'launchSuccess': res.get('success') is True, 'osAfter': osnow,
           'osCheck': {'rc': rc, **{k: chk.get(k) for k in ('check-errors', 'corruptions', 'leaks')}},
           'osCheckOk': rc in (0, 3) and not chk.get('corruptions') and not chk.get('check-errors'), 'backup': prep['backup']['path'],
           'next': ['root: re-run postrestore-recovery-stage/r1/inspect_units.py offline; expect the 8 units masked, no links',
                    'production start, unmask and USB rebind stay separate root decisions']}
    fin['ok'] = fin['launchSuccess'] and fin['osCheckOk']
    write_new(f'{ev}/FINISH.json', fin)
    return fin


def main(argv=None, c=None):
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    for n in ('prepare', 'launch', 'finish'):
        s = sub.add_parser(n); s.add_argument('--evidence', required=True)
        if n == 'prepare':
            s.add_argument('--backup-root', default=BACKUP_ROOT)
    a = ap.parse_args(argv)
    c, ev = c or Ctx(), os.path.abspath(a.evidence)
    try:
        if a.cmd == 'prepare':
            os.mkdir(ev, 0o700)                                               # FileExistsError: evidence is never reused
            out = cmd_prepare(c, ev, a.backup_root)
        else:
            out = cmd_launch(c, ev) if a.cmd == 'launch' else cmd_finish(c, ev)
    except (Refuse, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        rec, t = {'refused': f'{type(e).__name__}: {e}'}, getattr(c, 'trace', None)
        if t is not None:
            rec['diagnostics'] = t.snapshot(e)                                # launch: which phase refused (pre-launch or not)
        try:
            write_new(f'{ev}/REFUSED-{a.cmd}-{time.time_ns()}.json', rec)
        except OSError:
            pass
        print(json.dumps({'refused': f'{type(e).__name__}: {e}'})); return 2
    print(json.dumps(out, indent=1, sort_keys=True, default=str))
    return 0 if out.get('success', out.get('prepared', out.get('ok'))) else 1


if __name__ == '__main__':
    sys.exit(main())
