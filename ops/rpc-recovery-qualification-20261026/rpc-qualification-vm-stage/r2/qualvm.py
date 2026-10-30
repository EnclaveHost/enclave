#!/usr/bin/python3 -I
"""rpc-qualification-vm-stage/r2 (r1 + literal GRUB parser fix, no outbound mode): a TEMPORARY 8 GiB qualification boot of the SAME RPC guest OS (root runs every step; PREPARED).

Purpose: tiny-fixture guest qualification only (guest-state-install review Q1-Q3: the real b3sum tool, extract confinement with the
real base binary on a small hostile .tar.zst, guard ordering via systemctl show). NOT a chain backend: no L1/Base service may run.
Nothing of the production VM is modified:
  * production launcher/manifest/units are only READ (pinned sha 38f8dc89... / a2843215...; re-checked before and after);
  * the OS disk is booted through a NEW qcow2 overlay (backing = the production os.qcow2, opened read-only): every guest write lands in
    the overlay, which `discard` deletes; the L1 and Base disks are attached READ-ONLY (no overlay, zero writes possible);
  * every chain unit is masked for THIS boot only by systemd.mask= on the kernel command line (systemd-debug-generator, runtime
    masks in /run): no OS-disk unit file or symlink is changed. The kernel/initrd/cmdline are the OS disk's own (read-only extraction
    of its default GRUB entry; nothing guessed) plus the masks;
  * memory: guest 8 GiB (prealloc), transient user unit MemoryMax 10 GiB, MemorySwapMax 0; launch refuses unless host MemAvailable
    >= 10 GiB + 16 GiB floor = 26 GiB, and unless the production VM and guard are inactive;
  * network: user-mode, ONLY the SSH forward (127.0.0.1:22850, the guest's own pinned host key), ALWAYS `restrict=on`: no outbound
    (r2 removed r1's `--network apt`). Packages (b3sum) come in over SSH and are verified offline in the guest (plan report).
Commands: prepare OUT | plan OUT | launch OUT | prove OUT | stop | discard OUT
Labels: everything done in this VM happens in the OS OVERLAY (a scratch copy); it qualifies the same OS/kernel/systemd/binaries, not
the production disk's installation, and data disks are read-only and their mounts masked.
"""
import argparse, hashlib, importlib.util, json, os, re, shlex, socket, subprocess, sys, tempfile, time

GIB = 1 << 30
GUEST_MEM, MEMORY_MAX, HOST_FLOOR = 8 * GIB, 10 * GIB, 16 * GIB
PROD = os.path.expanduser('~/.local/state/enclave-rpc-production')
PROD_UNITS = os.path.expanduser('~/.config/systemd/user')
PINS = {f'{PROD}/provision_vm.py': '38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7',
        f'{PROD}/manifest.json': 'a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'}
INSPECTOR = ('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-memory-recovery-stage/r1/inspect_os_disk.py',
             '287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531')      # frozen r1 (root 1442/1443/1444)
PROD_UNIT_NAMES = ('enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service')
QUAL_UNIT, NAME = 'enclave-rpc-qual-vm.service', 'enclave-rpc-qual'
RUN = f'/run/user/{os.getuid()}/{NAME}'
MASKS = ('enclave-l1-cl.service', 'enclave-l1-el.path', 'enclave-l1-el.service', 'enclave-rpc-l1-snapshot.service',
         'enclave-rpc-base-snapshot.service', 'enclave-base-holder.path', 'enclave-base-holder.service', 'enclave-base-retention.service')
SSH_FWD = 'hostfwd=tcp:127.0.0.1:22850-10.0.2.15:22'


def mount_unit(path):
    """systemd path escaping (systemd-escape --path --suffix=mount)"""
    out = ''.join(c if c.isalnum() or c in ':_.' else ('-' if c == '/' else f'\\x{ord(c):02x}') for c in path.strip('/'))
    return out + '.mount'


class Refuse(Exception):
    pass


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 22), b''):
            h.update(b)
    return h.hexdigest()


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def production(run=subprocess.run):
    """the pinned production launcher + manifest (read only) and proof that its unit files are still its renders"""
    for p, h in PINS.items():
        if sha(p) != h:
            raise Refuse(f'{p} is not the pinned production file')
    pv = load(f'{PROD}/provision_vm.py', 'pv_prod')
    text = open(f'{PROD}/manifest.json').read(); m = json.loads(text); msha = pv.sha256_text(text)
    if open(f'{PROD_UNITS}/{PROD_UNIT_NAMES[0]}').read() != pv.render_unit(m, msha) or \
            open(f'{PROD_UNITS}/{PROD_UNIT_NAMES[1]}').read() != pv.render_guard_unit(m, msha):
        raise Refuse('production unit files differ from the pinned renders')
    return pv, m


def unit_state(unit, run=subprocess.run):
    r = run(['systemctl', '--user', 'show', '--property=ActiveState', '--value', unit], capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 else 'unknown'


def require_inactive(units, run=subprocess.run):
    for u in units:
        if (s := unit_state(u, run)) not in ('inactive', 'failed'):
            raise Refuse(f'{u} is {s}')


def mem_available():
    for l in open('/proc/meminfo'):
        if l.startswith('MemAvailable:'):
            return int(l.split()[1]) * 1024
    raise Refuse('no MemAvailable')


# ---- prepare: overlay + the OS disk's own kernel/initrd/cmdline (read-only extraction) -------------------------------------
LIT_PATH = re.compile(r'^/[A-Za-z0-9._+/-]+$')
LIT_ARG = re.compile(r'^[A-Za-z0-9._+=:,/@-]+$')


def parse_grub(text, grubenv=''):
    """-> (kernel path, initrd path, args) of the DEFAULT (= first top-level) menuentry, taken literally, or Refuse.
    r2: one initrd FILE exactly (r1 took the first character of it); literal absolute paths; literal args (only Ubuntu's
    $vt_handoff is dropped); the default must provably be entry 0 (set default only "0" or the stock "${next_entry}" branch, and
    grubenv's next_entry/saved_entry empty); the first top-level entry must be a menuentry, not a submenu."""
    for v in re.findall(r'^\s*set\s+default=(\S+)\s*$', text, re.M):
        if v not in ('0', '"0"', '"${next_entry}"'):
            raise Refuse(f'grub default is {v}: not provably the first entry')
    for k in ('next_entry', 'saved_entry'):
        if re.search(rf'^{k}=\S', grubenv, re.M):
            raise Refuse(f'grubenv sets {k}: the default entry is not provably the first')
    first = re.search(r'^(menuentry|submenu)\s', text, re.M)
    if not first or first.group(1) != 'menuentry':
        raise Refuse('the first top-level GRUB entry is not a menuentry')
    m = re.search(r"^menuentry\s.*?\{(.*?)^\}", text, re.S | re.M)
    if not m:
        raise Refuse('the first menuentry has no closing brace at line start')
    body = m.group(1)
    lk = re.findall(r'^\s*linux(?:efi)?\s+(.*)$', body, re.M)
    li = re.findall(r'^\s*initrd(?:efi)?\s+(.*)$', body, re.M)
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
    return ktoks[0], itoks[0], args


def cmd_prepare(out, run=subprocess.run):
    pv, m = production(run)
    require_inactive(PROD_UNIT_NAMES + (QUAL_UNIT,), run)
    if sha(INSPECTOR[0]) != INSPECTOR[1]:
        raise Refuse('the frozen OS-disk inspector is not the pinned r1 bytes')
    I = load(INSPECTOR[0], 'inspect_r1')
    osd = m['disks']['os']['path']
    if (pids := I.open_by_others(osd)):
        raise Refuse(f'{osd} is open by {pids}')
    os.makedirs(out, mode=0o700, exist_ok=False)
    st = os.stat(osd); mnt = tempfile.mkdtemp(prefix='rpc-qual-prep-'); raw = os.path.join(mnt, 'os.raw'); proc = None
    try:
        proc = subprocess.Popen(['nbdfuse', '-r', raw, '[', 'qemu-nbd', '-r', '-f', 'qcow2', osd, ']'], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        t0 = time.monotonic()
        while not (os.path.exists(raw) and os.path.getsize(raw) > 0):
            if time.monotonic() - t0 > 60 or proc.poll() not in (None, 0):
                raise Refuse('nbdfuse did not expose the OS disk')
            time.sleep(0.2)
        with open(raw, 'rb') as f:
            parts = [(p, I.ext4_label(f, p['first'] * 512)) for p in I.gpt_partitions(f)]
        byl = {lab: p for p, lab in parts if lab in ('cloudimg-rootfs', 'BOOT')}
        cands = ([('BOOT', '/grub/grub.cfg')] if 'BOOT' in byl else []) + [('cloudimg-rootfs', '/boot/grub/grub.cfg')]
        dev = cfg = None
        for lab, path in cands:
            d = f"{raw}?offset={byl[lab]['first'] * 512}"
            rc, txt = I.debugfs(d, f'cat {path}', run)
            if txt.strip():
                dev, cfg, part = d, txt.decode('utf-8', 'replace'), lab
                env = I.debugfs(d, f'cat {path.rsplit("/", 1)[0]}/grubenv', run)[1].decode('utf-8', 'replace'); break
        if not cfg:
            raise Refuse('no grub.cfg on the BOOT or root partition')
        kern, initrd, args = parse_grub(cfg, env)
        got = {}
        for name, src in (('vmlinuz', kern), ('initrd', initrd)):
            dst = os.path.join(out, name)
            run(['debugfs', '-c', '-R', f'dump {src} {dst}', dev], capture_output=True, timeout=120)
            if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
                raise Refuse(f'could not extract {src}')
            os.chmod(dst, 0o400); got[name] = {'source': f'{part}:{src}', 'sha256': sha(dst), 'size': os.path.getsize(dst)}
        rcf, fstab = I.debugfs(f"{raw}?offset={byl['cloudimg-rootfs']['first'] * 512}", 'cat /etc/fstab', run)
    finally:
        subprocess.run(['fusermount3', '-u', mnt], capture_output=True, timeout=30)
        if proc:
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
        try:
            os.rmdir(mnt)
        except OSError:
            pass
    fst = fstab.decode('utf-8', 'replace')
    auto = [l for l in fst.splitlines() if l.strip() and not l.startswith('#') and len(l.split()) >= 4
            and l.split()[1] not in ('/', '/boot', '/boot/efi', 'none', 'swap') and 'noauto' not in l.split()[3].split(',')]
    overlay = os.path.join(out, 'os-qual.qcow2')
    r = run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', osd, overlay], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise Refuse(f'qemu-img create failed: {r.stderr[-300:]}')
    if (os.stat(osd).st_mtime_ns, os.stat(osd).st_ino, os.stat(osd).st_size) != (st.st_mtime_ns, st.st_ino, st.st_size):
        raise Refuse('the production OS disk changed during prepare')
    rec = {'format': 'enclave-rpc-qual-prepared/r1', 'osDisk': osd, 'osDiskMtimeNs': st.st_mtime_ns, 'osDiskIno': st.st_ino,
           'overlay': overlay, 'kernel': got['vmlinuz'], 'initrd': got['initrd'], 'grubPartition': part, 'cmdlineFromGrub': args,
           'fstab': fst.splitlines(), 'fstabAutoDataMounts': auto, 'production': {p: h for p, h in PINS.items()}}
    json.dump(rec, open(os.path.join(out, 'PREPARED.json'), 'w'), indent=1, sort_keys=True)
    if auto:
        raise Refuse(f'fstab auto-mounts data filesystems {auto}: review before launch (they would mount read-only or fail)')
    return rec


# ---- the derived argv -----------------------------------------------------------------------------------------------------
def qual_argv(pv, m, prep):
    a = list(pv.qemu_argv(m))
    def at(i, want):
        if not a[i].startswith(want) if isinstance(want, str) else a[i] != want:
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
    keep = [t for t in a[58].split(',') if not t.startswith('hostfwd=')]
    if SSH_FWD not in a[58].split(','):
        raise Refuse('production netdev lacks the reviewed SSH forward')
    a[58] = ','.join(keep + [SSH_FWD, 'restrict=on'])                    # r2: never outbound
    del a[31:35]                                                              # no guard monitor (no NVMe guard for this boot)
    d = os.path.dirname(prep['overlay'])
    # the data mounts (noauto in fstab, checked at prepare) are masked too: no RequiresMountsFor pull can mount them, even read-only
    mounts = [mount_unit(m['disks'][k]['mount']) for k in ('l1', 'base')]
    cmdline = prep['cmdlineFromGrub'] + [f'systemd.mask={u}' for u in MASKS + tuple(mounts)]
    return a + ['-kernel', f'{d}/vmlinuz', '-initrd', f'{d}/initrd', '-append', ' '.join(cmdline)]


def checked(out, run=subprocess.run):
    pv, m = production(run)
    prep = json.load(open(os.path.join(out, 'PREPARED.json')))
    for k in ('kernel', 'initrd'):
        if sha(os.path.join(out, 'vmlinuz' if k == 'kernel' else 'initrd')) != prep[k]['sha256']:
            raise Refuse(f'{k} changed since prepare')
    st = os.stat(prep['osDisk'])
    if (st.st_mtime_ns, st.st_ino) != (prep['osDiskMtimeNs'], prep['osDiskIno']) or prep['fstabAutoDataMounts']:
        raise Refuse('the production OS disk changed since prepare (or fstab auto-mounts data)')
    return pv, m, prep


def systemd_run(argv):
    return ['systemd-run', '--user', f'--unit={QUAL_UNIT}', '--collect', '--quiet', f'-pMemoryMax={MEMORY_MAX}', '-pMemorySwapMax=0',
            '-pTasksMax=4096', '-pNoNewPrivileges=yes', '-pKillMode=mixed', '-pTimeoutStopSec=600', f'-pRuntimeDirectory={NAME}',
            '-pRuntimeDirectoryMode=0700', '-pUMask=0077', '--'] + argv


def cmd_plan(out, run=subprocess.run):
    pv, m, prep = checked(out, run)
    avail = mem_available()
    return {'argv': qual_argv(pv, m, prep), 'systemdRun': systemd_run(qual_argv(pv, m, prep)),
            'memAvailable': avail, 'launchNeeds': MEMORY_MAX + HOST_FLOOR, 'launchWouldPass': avail >= MEMORY_MAX + HOST_FLOOR,
            'masks': list(MASKS), 'network': 'restrict=on (SSH forward only)', 'scope': 'OS overlay only; data disks read-only, mounts masked'}


def cmd_launch(out, run=subprocess.run):
    pv, m, prep = checked(out, run)
    require_inactive(PROD_UNIT_NAMES + (QUAL_UNIT,), run)
    if (avail := mem_available()) < MEMORY_MAX + HOST_FLOOR:
        raise Refuse(f'MemAvailable {avail} < {MEMORY_MAX + HOST_FLOOR} (10 GiB cap + 16 GiB floor)')
    r = run(systemd_run(qual_argv(pv, m, prep)), capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise Refuse(f'systemd-run failed: {r.stderr[-300:]}')
    production(run)                                                           # unchanged after the start
    return {'started': QUAL_UNIT, 'next': 'prove OUT (read-only), then the qualification steps, then stop + discard'}


def cmd_prove(out, run=subprocess.run):
    """read-only over the guest's pinned SSH: every chain unit masked and inactive, the masks came from /proc/cmdline, memory"""
    ssh = ['ssh', '-F', f'{PROD}/ssh_config', '-o', 'BatchMode=yes', '-o', f'UserKnownHostsFile={PROD}/known_hosts',
           '-o', 'StrictHostKeyChecking=yes', 'enclave-rpc']
    q = 'cat /proc/cmdline; free -b | sed -n 2p; ' + '; '.join(f'echo "{u} $(systemctl is-enabled {u} 2>&1) $(systemctl is-active {u} 2>&1)"' for u in MASKS) \
        + '; findmnt -rno TARGET,OPTIONS /srv/enclave-l1-pair /srv/enclave-base-holder || true'
    r = run(ssh + [q], capture_output=True, text=True, timeout=60)
    lines = r.stdout.splitlines()
    cmd = lines[0] if lines else ''
    units = {l.split()[0]: l.split()[1:] for l in lines[2:2 + len(MASKS)] if l.split()}
    ok = r.returncode == 0 and all(f'systemd.mask={u}' in cmd.split() for u in MASKS) and \
        all(units.get(u, [''])[0] == 'masked-runtime' and units[u][-1] in ('inactive', 'unknown') for u in MASKS)
    mounts = lines[2 + len(MASKS):]
    return {'ok': ok and not mounts, 'cmdline': cmd, 'units': units, 'free': lines[1] if len(lines) > 1 else None, 'mounts': mounts,
            'scope': 'OS overlay boot: qualifies this OS/systemd/kernel/binaries, NOT the production disk installation'}


def cmd_stop(run=subprocess.run):
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(f'{RUN}/qmp.sock'); f = s.makefile('rwb')
    f.readline()
    for c in ('qmp_capabilities', 'system_powerdown'):
        f.write(json.dumps({'execute': c}).encode() + b'\n'); f.flush(); f.readline()
    return {'powerdown': 'sent', 'next': f'wait for `systemctl --user show -p ActiveState {QUAL_UNIT}` == inactive, then discard'}


def cmd_discard(out, run=subprocess.run):
    require_inactive((QUAL_UNIT,), run)
    prep = json.load(open(os.path.join(out, 'PREPARED.json')))
    for n in ('os-qual.qcow2', 'vmlinuz', 'initrd'):
        p = os.path.join(out, n)
        if os.path.exists(p):
            os.chmod(p, 0o600); os.unlink(p)
    production(run)
    st = os.stat(prep['osDisk'])
    return {'discarded': out, 'productionOsDiskUnchanged': (st.st_mtime_ns, st.st_ino) == (prep['osDiskMtimeNs'], prep['osDiskIno'])}


def main(argv=None, run=subprocess.run):
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    for c in ('prepare', 'plan', 'launch', 'prove', 'discard'):
        p = sub.add_parser(c); p.add_argument('out')
    sub.add_parser('stop')
    a = ap.parse_args(argv)
    try:
        out = {'prepare': lambda: cmd_prepare(a.out, run), 'plan': lambda: cmd_plan(a.out, run),
               'launch': lambda: cmd_launch(a.out, run), 'prove': lambda: cmd_prove(a.out, run),
               'stop': lambda: cmd_stop(run), 'discard': lambda: cmd_discard(a.out, run)}[a.cmd]()
    except (Refuse, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(json.dumps({'refused': f'{type(e).__name__}: {e}'})); return 2
    print(json.dumps(out, indent=1, sort_keys=True)); return 0


if __name__ == '__main__':
    sys.exit(main())
