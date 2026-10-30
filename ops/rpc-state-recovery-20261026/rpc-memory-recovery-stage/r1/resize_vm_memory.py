#!/usr/bin/python3 -I
"""rpc-memory-recovery-stage/r1: reviewed, reversible guest-RAM change for the STOPPED enclave-rpc-production VM. Root runs it.

Only these may change, everything else is byte-identical and checked:
  * provision_vm.py: the single line `GUEST_MEM = 64 * GIB` -> `GUEST_MEM = <N> * GIB` (MEMORY_MAX = GUEST_MEM + 2 GiB follows);
  * manifest.json: vm.guestMemBytes, vm.memoryMaxBytes, files.launcher (new launcher sha), files.qemuArgv (new argv sha);
  * the two user units, re-rendered by the NEW launcher's own render_unit / render_guard_unit: the manifest sha in ExecStart, and
    MemoryMax in the VM unit (the guard's MemoryMax=256M is a constant).
Pinned origin: launcher sha 38f8dc89..., manifest sha a2843215... (as installed and as both units pin it).
Sizes: 48 GiB (default), 32 GiB, or 16 GiB = DOWNLOAD-ONLY: refused unless an offline OS-disk inspection record shows no L1
unit enabled. 64 GiB is never written by this tool; returning to it is `rollback` (restores the exact original files).
Commands (nothing ever starts, enables, reloads or stops a unit; `systemctl --user show` is the only systemctl call):
  stage   --gib N --out DIR            build + self-check the new files in DIR from the live originals (writes only DIR)
  install --staged DIR [--l1-off EVIDENCE.json]
                                       refuses unless both units are inactive, the live files are still the pinned originals,
                                       the staged files are exactly the plan, and MemAvailable >= new MemoryMax + 16 GiB;
                                       backs up the originals (new 0700 dir), installs atomically, re-verifies; any failure
                                       restores the originals. Then root runs daemon-reload and `provision_vm.py verify`.
  rollback --backup DIR                both units inactive; the backup is the exact pinned originals; restores them, re-verifies
  check-memory --gib N                 read-only: MemAvailable vs the launcher's own launch requirement for N
"""
import argparse, datetime, difflib, hashlib, importlib.util, json, os, re, shutil, subprocess, sys

GIB = 1 << 30
SIZES = {48: 'default', 32: 'reduced', 16: 'download-only'}
ORIG_LAUNCHER_SHA = '38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7'
ORIG_MANIFEST_SHA = 'a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'
MEM_LINE = 'GUEST_MEM = 64 * GIB\n'
HOST_RESERVE = 16 * GIB
L1_UNITS = ('enclave-l1-el.path', 'enclave-l1-el.service', 'enclave-l1-cl.service')
UNIT, GUARD = 'enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service'
DEFAULT = {'stateDir': os.path.expanduser('~/.local/state/enclave-rpc-production'),
           'unitDir': os.path.expanduser('~/.config/systemd/user'), 'meminfo': '/proc/meminfo'}
MODES = {'launcher': 0o500, 'manifest': 0o600, 'unit': 0o644, 'guard': 0o644}


class Refuse(Exception):
    pass


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def load_launcher(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def files_of(env):
    s, u = env['stateDir'], env['unitDir']
    return {'launcher': os.path.join(s, 'provision_vm.py'), 'manifest': os.path.join(s, 'manifest.json'),
            'unit': os.path.join(u, UNIT), 'guard': os.path.join(u, GUARD)}


def read(p):
    with open(p, 'rb') as f:
        return f.read()


def check_original(env):
    """the live files are exactly the pinned origin, self-consistent under the ORIGINAL launcher"""
    f = files_of(env)
    b = {k: read(p) for k, p in f.items()}
    if sha_bytes(b['launcher']) != ORIG_LAUNCHER_SHA:
        raise Refuse('installed launcher is not the pinned original 38f8dc89...')
    if sha_bytes(b['manifest']) != ORIG_MANIFEST_SHA:
        raise Refuse('installed manifest is not the pinned original a2843215...')
    old = load_launcher(f['launcher'], 'pv_orig')
    text = b['manifest'].decode(); man = json.loads(text)
    if old.canonical(man) != text or man['files']['launcher'] != ORIG_LAUNCHER_SHA:
        raise Refuse('the original manifest is not canonical or does not pin the original launcher')
    if old.sha256_text(old.canonical(old.qemu_argv(man))) != man['files']['qemuArgv']:
        raise Refuse('the original manifest qemuArgv does not match the original launcher')
    if b['unit'].decode() != old.render_unit(man, ORIG_MANIFEST_SHA) or b['guard'].decode() != old.render_guard_unit(man, ORIG_MANIFEST_SHA):
        raise Refuse('an installed unit file differs from the original launcher render')
    if man['vm']['guestMemBytes'] != 64 * GIB or man['vm']['memoryMaxBytes'] != 66 * GIB or man['vm']['hostReserveBytes'] != HOST_RESERVE:
        raise Refuse('the original manifest vm sizes are not the reviewed 64/66/16 GiB')
    return b, man


def build(orig, gib):
    """-> {name: bytes} of the new launcher/manifest/units + the plan (all derived by the NEW launcher's own functions)"""
    if gib not in SIZES:
        raise Refuse(f'size {gib} GiB is not one of the reviewed {sorted(SIZES)}')
    lt = orig['launcher'].decode()
    if lt.count(MEM_LINE) != 1:
        raise Refuse('the launcher does not contain exactly one reviewed GUEST_MEM line')
    new_launcher = lt.replace(MEM_LINE, f'GUEST_MEM = {gib} * GIB\n').encode()
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        p = os.path.join(t, 'provision_vm.py')
        with open(p, 'wb') as f:
            f.write(new_launcher)
        new = load_launcher(p, f'pv_{gib}')
    if new.GUEST_MEM != gib * GIB or new.MEMORY_MAX != (gib + 2) * GIB or new.HOST_RESERVE != HOST_RESERVE:
        raise Refuse('the new launcher constants are not the reviewed ones')
    man = json.loads(orig['manifest'].decode())
    man['vm']['guestMemBytes'], man['vm']['memoryMaxBytes'] = new.GUEST_MEM, new.MEMORY_MAX
    man['files']['launcher'] = sha_bytes(new_launcher)
    man['files']['qemuArgv'] = new.sha256_text(new.canonical(new.qemu_argv(man)))
    mtext = new.canonical(man); msha = new.sha256_text(mtext)
    out = {'launcher': new_launcher, 'manifest': mtext.encode(), 'unit': new.render_unit(man, msha).encode(),
           'guard': new.render_guard_unit(man, msha).encode()}
    plan = {'format': 'enclave-rpc-memory-resize/r1', 'gib': gib, 'mode': SIZES[gib], 'guestMemBytes': new.GUEST_MEM,
            'memoryMaxBytes': new.MEMORY_MAX, 'hostReserveBytes': HOST_RESERVE, 'launchNeedsMemAvailable': new.MEMORY_MAX + HOST_RESERVE,
            'original': {'launcher': ORIG_LAUNCHER_SHA, 'manifest': ORIG_MANIFEST_SHA, 'unit': sha_bytes(orig['unit']), 'guard': sha_bytes(orig['guard'])},
            'new': {k: sha_bytes(v) for k, v in out.items()}, 'manifestSha256': msha}
    allowed_diff(orig, out, gib)
    return out, plan


def _changed(a, b):
    return [(x, y) for x, y in zip(a, b) if x != y] if len(a) == len(b) else None


def allowed_diff(orig, out, gib):
    """refuse anything but the reviewed changes"""
    la, lb = orig['launcher'].decode().splitlines(), out['launcher'].decode().splitlines()
    if _changed(la, lb) != [(MEM_LINE.rstrip('\n'), f'GUEST_MEM = {gib} * GIB')]:
        raise Refuse('launcher diff is not exactly the GUEST_MEM line')
    a, b = json.loads(orig['manifest']), json.loads(out['manifest'])
    for k in ('vm', 'files'):
        a.setdefault(k, {}); b.setdefault(k, {})
    va, vb, fa, fb = a.pop('vm'), b.pop('vm'), a.pop('files'), b.pop('files')
    if a != b or set(va) != set(vb) or {k for k in va if va[k] != vb[k]} != {'guestMemBytes', 'memoryMaxBytes'} \
            or set(fa) != set(fb) or {k for k in fa if fa[k] != fb[k]} != {'launcher', 'qemuArgv'}:
        raise Refuse('manifest diff is not exactly vm.guestMemBytes/memoryMaxBytes + files.launcher/qemuArgv')
    for name, keys in (('unit', ('ExecStart=', 'MemoryMax=')), ('guard', ('ExecStart=',))):
        ch = _changed(orig[name].decode().splitlines(), out[name].decode().splitlines())
        if ch is None or not ch or any(not x.startswith(keys) or x.split('=', 1)[0] != y.split('=', 1)[0] for x, y in ch) \
                or len(ch) != len(keys):
            raise Refuse(f'{name} diff is not exactly {keys}')


def mem_available(path):
    for line in open(path):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    raise Refuse('MemAvailable missing')


def unit_state(unit, run=subprocess.run):
    r = run(['systemctl', '--user', 'show', '--property=ActiveState,SubState', unit], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise Refuse(f'cannot read {unit}')
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def require_stopped(run):
    for u in (UNIT, GUARD):
        s = unit_state(u, run)
        if s.get('ActiveState') not in ('inactive', 'failed'):
            raise Refuse(f'{u} is {s.get("ActiveState")}/{s.get("SubState")}: stop the VM (its own ExecStop) first')


def l1_off(evidence_path, env):
    """the offline OS-disk inspection record (inspect_os_disk.py) of THIS, unchanged OS disk must show every L1 unit not enabled"""
    if not evidence_path:
        raise Refuse('16 GiB is download-only: pass --l1-off with the offline OS-disk inspection record')
    ev = json.loads(read(evidence_path))
    if ev.get('format') != 'enclave-rpc-os-disk-inspection/r1' or ev.get('osDiskSha256Prefix') is None:
        raise Refuse('not an OS-disk inspection record')
    osd = json.loads(read(files_of(env)['manifest']))['disks']['os']['path']
    st = os.stat(osd)
    if ev.get('osDisk') != osd or ev.get('osDiskIno') != st.st_ino or ev.get('osDiskMtimeNs') != st.st_mtime_ns:
        raise Refuse('the inspection record is not of the current, unchanged OS disk (path/inode/mtime)')
    en = ev.get('enabled', {})
    if any(en.get(u) is not False for u in L1_UNITS):
        raise Refuse(f'L1 units are (or may be) enabled in the guest: {{{", ".join(f"{u}: {en.get(u)}" for u in L1_UNITS)}}}; 16 GiB refused')


def atomic_write(path, data, mode):
    tmp = f'{path}.resize-{os.getpid()}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.write(fd, data); os.fchmod(fd, mode); os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, path)
    d = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY); os.fsync(d); os.close(d)


def verify_installed(env, want):
    """installed bytes == `want`, and they are self-consistent under the INSTALLED launcher's own render/hash functions"""
    f = files_of(env)
    for k, h in want.items():
        if sha_bytes(read(f[k])) != h or (os.stat(f[k]).st_mode & 0o777) != MODES[k]:
            raise Refuse(f'installed {k} is not the expected bytes/mode')
    mod = load_launcher(f['launcher'], 'pv_installed')
    text = read(f['manifest']).decode(); man = json.loads(text); msha = mod.sha256_text(text)
    if man['files']['launcher'] != want['launcher'] or mod.sha256_text(mod.canonical(mod.qemu_argv(man))) != man['files']['qemuArgv'] \
            or read(f['unit']).decode() != mod.render_unit(man, msha) or read(f['guard']).decode() != mod.render_guard_unit(man, msha) \
            or man['vm']['guestMemBytes'] != mod.GUEST_MEM or man['vm']['memoryMaxBytes'] != mod.MEMORY_MAX:
        raise Refuse('installed files are not consistent under the installed launcher')
    return msha


def restore(env, backup, names=('launcher', 'manifest', 'unit', 'guard')):
    f = files_of(env)
    for k in names:
        atomic_write(f[k], read(os.path.join(backup, k)), MODES[k])


def cmd_stage(env, gib, out):
    orig, _ = check_original(env)
    files, plan = build(orig, gib)
    os.makedirs(out, mode=0o700, exist_ok=False)
    for k, b in files.items():
        with open(os.path.join(out, k), 'wb') as fh:
            fh.write(b)
    diffs = {k: ''.join(difflib.unified_diff(orig[k].decode().splitlines(True), files[k].decode().splitlines(True), f'a/{k}', f'b/{k}', n=0))
             for k in files if k != 'manifest'}
    with open(os.path.join(out, 'PLAN.json'), 'w') as fh:
        json.dump({**plan, 'diffs': diffs}, fh, indent=1, sort_keys=True); fh.write('\n')
    return plan


def cmd_install(env, staged, evidence=None, run=subprocess.run, fail_after=None):
    plan = json.loads(read(os.path.join(staged, 'PLAN.json')))
    if plan.get('format') != 'enclave-rpc-memory-resize/r1' or plan.get('gib') not in SIZES:
        raise Refuse('not a resize plan')
    require_stopped(run)
    orig, _ = check_original(env)
    files, fresh = build(orig, plan['gib'])                          # rebuilt from the live originals: the staged copy must equal it
    if {k: sha_bytes(read(os.path.join(staged, k))) for k in files} != fresh['new'] or fresh['new'] != plan['new']:
        raise Refuse('the staged files are not exactly the plan rebuilt from the live originals')
    if plan['gib'] == 16:
        l1_off(evidence, env)
    avail = mem_available(env['meminfo'])
    if avail < plan['launchNeedsMemAvailable']:
        raise Refuse(f"MemAvailable {avail} < new MemoryMax + 16 GiB = {plan['launchNeedsMemAvailable']}: the launcher would refuse")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = os.path.join(env['stateDir'], f'backup-memory-{stamp}-{ORIG_MANIFEST_SHA[:12]}')
    os.makedirs(backup, mode=0o700, exist_ok=False)
    f = files_of(env)
    for k in f:
        shutil.copyfile(f[k], os.path.join(backup, k)); os.chmod(os.path.join(backup, k), 0o400)
    rec = {'format': 'enclave-rpc-memory-backup/r1', 'paths': f, 'sha256': {k: sha_bytes(read(os.path.join(backup, k))) for k in f}, 'modes': {k: oct(MODES[k]) for k in f}}
    if rec['sha256'] != plan['original']:
        raise Refuse('backup copy is not the pinned original (nothing installed)')
    atomic_write(os.path.join(backup, 'BACKUP.json'), (json.dumps(rec, indent=1, sort_keys=True) + '\n').encode(), 0o400)
    done = []
    try:
        for k in ('launcher', 'manifest', 'unit', 'guard'):          # failure at any point restores every original
            if fail_after is not None and len(done) == fail_after:
                raise Refuse('injected failure (test)')
            atomic_write(f[k], files[k], MODES[k]); done.append(k)
        msha = verify_installed(env, plan['new'])
    except Exception as e:
        restore(env, backup)
        verify_installed(env, plan['original'])
        raise Refuse(f'install failed and the originals were restored: {e}')
    return {'installed': True, 'gib': plan['gib'], 'manifestSha256': msha, 'backup': backup,
            'next': ['systemctl --user daemon-reload', f"/usr/bin/python3 -I {f['launcher']} verify",
                     'then (root decision) the normal start of the guard + VM units; nothing was started']}


def cmd_rollback(env, backup, run=subprocess.run):
    require_stopped(run)
    rec = json.loads(read(os.path.join(backup, 'BACKUP.json')))
    want = {'launcher': ORIG_LAUNCHER_SHA, 'manifest': ORIG_MANIFEST_SHA}
    got = {k: sha_bytes(read(os.path.join(backup, k))) for k in ('launcher', 'manifest', 'unit', 'guard')}
    if rec.get('format') != 'enclave-rpc-memory-backup/r1' or got != rec['sha256'] or any(got[k] != v for k, v in want.items()) or rec['paths'] != files_of(env):
        raise Refuse('the backup is not the exact pinned original set for these paths')
    restore(env, backup)
    verify_installed(env, got)
    check_original(env)
    return {'rolledBack': True, 'next': ['systemctl --user daemon-reload',
            'a 64 GiB start needs MemAvailable >= 66 GiB + 16 GiB (the launcher refuses otherwise); nothing was started']}


def main(argv=None, env=None, run=subprocess.run):
    env = env or DEFAULT
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('stage'); s.add_argument('--gib', type=int, default=48); s.add_argument('--out', required=True)
    i = sub.add_parser('install'); i.add_argument('--staged', required=True); i.add_argument('--l1-off')
    r = sub.add_parser('rollback'); r.add_argument('--backup', required=True)
    c = sub.add_parser('check-memory'); c.add_argument('--gib', type=int, default=48)
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'stage':
            out = cmd_stage(env, a.gib, a.out)
        elif a.cmd == 'install':
            out = cmd_install(env, a.staged, a.l1_off, run)
        elif a.cmd == 'rollback':
            out = cmd_rollback(env, a.backup, run)
        else:
            if a.gib not in SIZES:
                raise Refuse('size not reviewed')
            need, avail = (a.gib + 2) * GIB + HOST_RESERVE, mem_available(env['meminfo'])
            out = {'gib': a.gib, 'memAvailable': avail, 'launchNeeds': need, 'launchWouldPass': avail >= need,
                   'projectedHostAvailableAfterStartBytes': avail - (a.gib + 2) * GIB, 'floorBytes': HOST_RESERVE}
    except Refuse as e:
        print(json.dumps({'refused': str(e)})); return 2
    print(json.dumps(out, indent=1, sort_keys=True)); return 0


if __name__ == '__main__':
    sys.exit(main())
