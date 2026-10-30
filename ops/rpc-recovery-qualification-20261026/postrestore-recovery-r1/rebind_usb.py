#!/usr/bin/python3 -I
"""postrestore-recovery-stage/r1: STAGE-ONLY rebind of the enclave-rpc-production v2 manifest to the restored TR-004 USB.

The restored USB filesystem has a new identity (fsUuid 489ED12D9ED11472 /dev/sda2 -> 702FE78A62B4C5DC /dev/sda1) and the
restored base-origin.qcow2 a new inode, so the launcher's check_backing/check_images refuse (correctly). This tool only
STAGES a manifest whose diff is exactly
    backings.hdd.fsUuid, backings.hdd.source, backings.hdd.leafDisks, disks.base.ino
plus the two user units re-rendered by the pinned launcher's own render_unit/render_guard_unit (only the manifest sha pin
changes). vm.* (memory, 16 GiB host floor), ports, keys, baseImage, seed, the NVMe os/l1 paths/inodes, guard settings and
files.* are byte-identical (checked; the QEMU argv sha must not change). It installs, starts, enables and reloads nothing.

Two different kinds of evidence, never mixed:
  receiptCopyProof    the pinned restoration + cleanup receipts (sha256 given by root). They attest that the database file
                      INSIDE the image (database_internal_path / database_bytes) was restored and that the restored USB
                      files were retained. They carry NO host inode, qcow2 file size, mtime or image hash.
  currentHostIdentity a fresh observation by this tool: the mount's fstype/source/fsUuid/leaf disks, the backing dir and the
                      base image's dev/ino/size/mtime/ctime/nlink/mode/uid + its qcow2 header (virtual size, no backing file).
                      No whole-image hash is taken.
Commands (each re-checks everything; the VM and guard units must be inactive with MainPID 0 and no process may have a disk
image open; the launcher is executed from its pinned bytes):
  observe     --out OBS.json                     write a new observation record (O_EXCL)
  stage       --observation OBS.json --out DIR   re-observe; refuse unless the identity equals OBS; write DIR (new) with
                                                 manifest.json, both units, evidence.json, NOT-INSTALLED.md, SHA256SUMS
  check-stage --stage DIR                        refuse an outdated/tampered stage: sums, pins, live manifest still the old
                                                 one, identity unchanged since staging, units == render(staged manifest)
All three need --manifest-sha, --restoration-sha and --cleanup-sha (root computes them independently with sha256sum).
Exit 0 ok, 2 refused.
"""
import argparse, copy, datetime, hashlib, json, os, stat, struct, subprocess, sys, types

FORMAT_OBS = 'enclave-rpc-usb-rebind-observation/r1'
FORMAT_STAGE = 'enclave-rpc-usb-rebind-stage/r1'
SYSTEMCTL = '/usr/bin/systemctl'
LAUNCHER_SHA = '38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7'
OLD = {'fsUuid': '489ED12D9ED11472', 'source': '/dev/sda2', 'baseIno': 3221}
NEW = {'fsUuid': '702FE78A62B4C5DC', 'source': '/dev/sda1'}
HDD_KEYS = ('fsUuid', 'source', 'leafDisks')
HOST_RESERVE = 16 << 30
STATE = os.path.expanduser('~/.local/state/enclave-rpc-production')
RECEIPTS = '/home/steven/Documents/Codex/2026-10-26/my/outputs'
STAGE_FILES = ('manifest.json', 'enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service', 'evidence.json',
               'NOT-INSTALLED.md')


class Refuse(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def read_pinned(path, want, what):
    with open(path, 'rb') as f:
        b = f.read()
    if sha(b) != want:
        refuse(f'{what} {path} sha256 {sha(b)} is not the pinned {want}')
    return b


def exec_pinned(data, path, name):
    """the launcher module built from exactly the pinned bytes already read (no re-open, no import machinery, no .pyc)"""
    mod = types.ModuleType(name)
    mod.__file__ = path
    exec(compile(data, path, 'exec'), mod.__dict__)
    return mod


def unit_state(unit):
    r = subprocess.run([SYSTEMCTL, '--user', 'show', '-p', 'ActiveState', '-p', 'MainPID', unit], stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=30)
    if r.returncode:
        return 'unknown', -1
    kv = dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)
    return kv.get('ActiveState', 'unknown'), int(kv.get('MainPID') or -1)


def open_by(path):
    real, hits = os.path.realpath(path), set()
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            fds = os.listdir(f'/proc/{pid}/fd')
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(f'/proc/{pid}/fd/{fd}') == real:
                    hits.add(int(pid))
            except OSError:
                pass
    return sorted(hits)


def default_env(a):
    return {'launcher': f'{STATE}/provision_vm.py', 'manifest': f'{STATE}/manifest.json',
            'unitDir': os.path.expanduser('~/.config/systemd/user'),
            'restoration': f'{RECEIPTS}/tr004-restoration-complete.json',
            'cleanup': f'{RECEIPTS}/tr004-post-restore-cleanup-receipt.json',
            'pins': {'launcher': LAUNCHER_SHA, 'manifest': a.manifest_sha, 'restoration': a.restoration_sha,
                     'cleanup': a.cleanup_sha},
            'unit_state': unit_state, 'open_by': open_by, 'describe': None}


def utc(text):
    return datetime.datetime.fromisoformat(text).astimezone(datetime.timezone.utc)


def check_receipts(r, c, m):
    """pure: what the two receipts do (and do not) attest, bound to this manifest's base image path"""
    if r.get('complete') is not True or r.get('mount_uuid') != NEW['fsUuid']:
        refuse(f"restoration receipt is not complete for USB {NEW['fsUuid']} (complete={r.get('complete')!r}, "
               f"mount_uuid={r.get('mount_uuid')!r})")
    if r.get('database_image') != m['disks']['base']['path']:
        refuse(f"restoration receipt image {r.get('database_image')!r} is not the manifest base disk {m['disks']['base']['path']}")
    if not isinstance(r.get('database_bytes'), int) or r['database_bytes'] <= 0 or not isinstance(r.get('database_internal_path'), str):
        refuse('restoration receipt lacks database_internal_path/database_bytes')
    if c.get('complete') is not True or c.get('restored_usb_files_retained') is not True:
        refuse('cleanup receipt is not complete or did not retain the restored USB files')
    try:
        if utc(c['completed_at']) < utc(r['completed_at']):
            refuse('cleanup receipt predates the restoration receipt')
    except (KeyError, TypeError, ValueError):
        refuse('receipt completed_at missing or not ISO-8601')
    return {'restoration': {'completedAt': r['completed_at'], 'mountUuid': r['mount_uuid'], 'databaseImage': r['database_image'],
                            'databaseInternalPath': r['database_internal_path'], 'databaseBytes': r['database_bytes'],
                            'imageModifiedAfterCurrentFileCopy': r.get('image_modified_after_current_file_copy')},
            'cleanup': {'completedAt': c['completed_at'], 'restoredUsbFilesRetained': True},
            'attests': 'database file content inside the image (internal path + bytes) and retention of the restored USB files',
            'doesNotAttest': 'host inode, qcow2 file size, mtime or any image hash of base-origin.qcow2'}


def inputs(env):
    """pinned launcher module + the pinned, still pre-restore-bound manifest + the pinned receipts"""
    p = env['pins']
    lb = read_pinned(env['launcher'], p['launcher'], 'launcher')
    mod = exec_pinned(lb, env['launcher'], 'provision_vm_pinned')
    mtext = read_pinned(env['manifest'], p['manifest'], 'manifest').decode()
    m = json.loads(mtext)
    if m.get('format') != mod.FORMAT_V2 or mod.canonical(m) != mtext:
        refuse('manifest is not a canonical v2 manifest')
    if m.get('uid') != os.getuid():
        refuse(f"run as uid {m.get('uid')} (the user unit owner)")
    if m['files']['launcher'] != p['launcher']:
        refuse('manifest does not pin the pinned launcher')
    mod.validate_v2(m)
    if m['vm']['hostReserveBytes'] != HOST_RESERVE or mod.HOST_RESERVE != HOST_RESERVE:
        refuse('the 16 GiB host floor is not the pinned one')
    hdd, base = m['backings']['hdd'], m['disks']['base']
    if (hdd['fsUuid'], hdd['source'], base['ino'], base['backing']) != (OLD['fsUuid'], OLD['source'], OLD['baseIno'], 'hdd'):
        refuse('manifest is not the pre-restore binding 489ED12D9ED11472 /dev/sda2 ino 3221 (outdated or already rebound)')
    r = json.loads(read_pinned(env['restoration'], p['restoration'], 'restoration receipt'))
    c = json.loads(read_pinned(env['cleanup'], p['cleanup'], 'cleanup receipt'))
    return mod, m, mtext, check_receipts(r, c, m)


def require_offline(mod, m, env):
    for u in (mod.UNIT, mod.GUARD_UNIT):
        state, pid = env['unit_state'](u)
        if state not in ('inactive', 'failed') or pid != 0:
            refuse(f'{u} is {state} with MainPID {pid}: the VM and guard must be stopped')
    for role, d in m['disks'].items():
        if pids := env['open_by'](d['path']):
            refuse(f"disk {role} {d['path']} is open by pid(s) {pids}")


def qcow2_header(path):
    """read-only: the first 104 bytes only (no qemu-img, no whole-image read)"""
    with open(path, 'rb') as f:
        h = f.read(104)
    if len(h) < 72 or h[:4] != b'QFI\xfb':
        refuse(f'{path} is not a qcow2 image')
    version, backing = struct.unpack_from('>I', h, 4)[0], struct.unpack_from('>Q', h, 8)[0]
    incompat = struct.unpack_from('>Q', h, 72)[0] if version >= 3 and len(h) >= 80 else 0
    if version not in (2, 3) or backing != 0 or incompat & 0b110:
        refuse(f'{path}: qcow2 v{version}, backing offset {backing}, incompatible features {incompat:#x} (corrupt/external data?)')
    return {'version': version, 'virtualSize': struct.unpack_from('>Q', h, 24)[0], 'backingFileOffset': 0, 'incompatibleFeatures': incompat}


def observe_identity(mod, m, env):
    hdd, base = m['backings']['hdd'], m['disks']['base']
    desc = (env.get('describe') or mod.describe_backing)(hdd['mount'])
    if not desc['rw'] or desc['fstype'] != hdd['fstype']:
        refuse(f"{hdd['mount']} is not a read-write {hdd['fstype']} mount ({desc['fstype']}, rw={desc['rw']})")
    if desc['fsUuid'] != NEW['fsUuid']:
        refuse(f"{hdd['mount']} fsUuid {desc['fsUuid']!r} is not the restored USB {NEW['fsUuid']} (unique /dev/disk/by-uuid)")
    if desc['source'] != NEW['source']:
        refuse(f"{hdd['mount']} is mounted from {desc['source']}, not {NEW['source']}")
    if not desc['leafDisks'] or any(l.get('rotational') is not True for l in desc['leafDisks']):
        refuse(f"{hdd['mount']} leaf disks {desc['leafDisks']} are not all rotational")
    mdev = os.stat(hdd['mount']).st_dev
    ds = os.lstat(hdd['dir'])
    if not stat.S_ISDIR(ds.st_mode) or ds.st_uid != os.getuid() or ds.st_dev != mdev:
        refuse(f"{hdd['dir']} is not a real directory of this user on {hdd['mount']}")
    st = os.lstat(base['path'])
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o022 or st.st_dev != mdev:
        refuse(f"{base['path']} is not a regular, single-link file of this user, not group/other-writable, on {hdd['mount']}")
    hdr = qcow2_header(base['path'])
    if hdr['virtualSize'] != base['bytes']:
        refuse(f"{base['path']} virtual size {hdr['virtualSize']} != manifest {base['bytes']}")
    nvme = {}
    for role, d in m['disks'].items():
        if role != 'base':
            ns = os.lstat(d['path'])
            if ns.st_ino != d['ino'] or not stat.S_ISREG(ns.st_mode) or ns.st_nlink != 1:
                refuse(f"disk {role} {d['path']} is not the manifest's inode {d['ino']}")
            nvme[role] = {'path': d['path'], 'ino': ns.st_ino}
    return {'backing': {k: desc[k] for k in ('mount', 'fstype', 'source', 'fsUuid', 'leafDisks', 'rw')},
            'hddDir': {'path': hdd['dir'], 'dev': ds.st_dev, 'ino': ds.st_ino, 'uid': ds.st_uid},
            'base': {'path': base['path'], 'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtimeNs': st.st_mtime_ns,
                     'ctimeNs': st.st_ctime_ns, 'nlink': st.st_nlink, 'mode': st.st_mode, 'uid': st.st_uid, 'qcow2': hdr},
            'otherDisks': nvme}


def rebind(m, ident):
    m2 = copy.deepcopy(m)
    for k in HDD_KEYS:
        m2['backings']['hdd'][k] = copy.deepcopy(ident['backing'][k])
    m2['disks']['base']['ino'] = ident['base']['ino']
    return m2


def allowed_diff(m1, m2):
    """refuse any manifest change outside backings.hdd.{fsUuid,source,leafDisks} and disks.base.ino"""
    a, b = copy.deepcopy(m1), copy.deepcopy(m2)
    try:
        for x in (a, b):
            for k in HDD_KEYS:
                del x['backings']['hdd'][k]
            del x['disks']['base']['ino']
    except (KeyError, TypeError):
        refuse('manifest lacks a rebind field')
    if a != b:
        refuse('manifest diff is not limited to backings.hdd.{fsUuid,source,leafDisks} + disks.base.ino')
    return {f'backings.hdd.{k}': [m1['backings']['hdd'][k], m2['backings']['hdd'][k]] for k in HDD_KEYS} | \
        {'disks.base.ino': [m1['disks']['base']['ino'], m2['disks']['base']['ino']]}


def only_pin_changed(t1, t2, s1, s2, name):
    if s1 not in t1 or t1.replace(s1, s2) != t2:
        refuse(f'{name}: the re-render differs beyond the manifest sha pin')


def render_checked(mod, m1, mtext1, m2, env):
    """installed units are the pinned launcher's render of the live manifest; the new render changes only the pin"""
    msha1 = mod.sha256_text(mtext1)
    u1, g1 = mod.render_unit(m1, msha1), mod.render_guard_unit(m1, msha1)
    for name, want in ((mod.UNIT, u1), (mod.GUARD_UNIT, g1)):
        with open(os.path.join(env['unitDir'], name)) as f:
            if f.read() != want:
                refuse(f'installed {name} is not the pinned launcher render of the live manifest')
    mod.validate_v2(m2)
    if mod.sha256_text(mod.canonical(mod.qemu_argv(m2))) != m1['files']['qemuArgv']:
        refuse('the QEMU argv would change')
    if mod.seed_files(m2) != mod.seed_files(m1) or mod.guest_disk_config(m2) != mod.guest_disk_config(m1):
        refuse('seed/guest disk config render would change')
    mtext2 = mod.canonical(m2)
    msha2 = mod.sha256_text(mtext2)
    u2, g2 = mod.render_unit(m2, msha2), mod.render_guard_unit(m2, msha2)
    only_pin_changed(u1, u2, msha1, msha2, mod.UNIT)
    only_pin_changed(g1, g2, msha1, msha2, mod.GUARD_UNIT)
    return {'from': {'manifestSha256': msha1, 'vmUnitSha256': sha(u1.encode()), 'guardUnitSha256': sha(g1.encode())},
            'to': {'manifestSha256': msha2, 'vmUnitSha256': sha(u2.encode()), 'guardUnitSha256': sha(g2.encode()),
                   'qemuArgvSha256': m1['files']['qemuArgv']}}, {'manifest.json': mtext2, mod.UNIT: u2, mod.GUARD_UNIT: g2}


def env_paths(env):
    return {k: os.path.abspath(env[k]) for k in ('launcher', 'manifest', 'unitDir', 'restoration', 'cleanup')}


def cmd_observe(env, out):
    mod, m, _, receipts = inputs(env)
    require_offline(mod, m, env)
    rec = {'format': FORMAT_OBS, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'uid': os.getuid(),
           'pins': env['pins'], 'paths': env_paths(env), 'receiptCopyProof': receipts,
           'currentHostIdentity': observe_identity(mod, m, env),
           'note': 'currentHostIdentity is observed now by this tool; it is NOT attested by the receipts'}
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f, indent=1, sort_keys=True)
        f.write('\n')
    return rec


def diff_keys(a, b, prefix=''):
    if isinstance(a, dict) and isinstance(b, dict):
        return [k for key in sorted(set(a) | set(b)) for k in diff_keys(a.get(key), b.get(key), f'{prefix}{key}.')]
    return [] if a == b else [prefix.rstrip('.')]


NOT_INSTALLED = '''# NOT INSTALLED

Staged by postrestore-recovery-stage/r1/rebind_usb.py ({fmt}) at {at}. Nothing was installed, started, enabled or reloaded.

Live (unchanged): manifest {m1}, units {u1} / {g1}.
Staged: manifest {m2}, units {u2} / {g2} (only the manifest sha pin differs in the units).
Manifest diff (only these fields):
{diff}

The receipts attest the database file inside the image and USB-file retention; they do NOT attest the host inode,
qcow2 file size or any image hash. The base inode {ino} comes from this tool's own observation (evidence.json).

Before any install root must, with the VM and guard stopped: re-run `rebind_usb.py check-stage --stage <this dir>`
(refuses if the live manifest, the receipts, the mount identity or the base image dev/ino/size/mtime/ctime changed),
back up the live manifest and both units, install exactly these three files, daemon-reload, and run
`provision_vm.py verify`. No install script is provided by this stage.
'''


def cmd_stage(env, obs_path, out):
    mod, m1, mtext1, receipts = inputs(env)
    with open(obs_path, 'rb') as f:
        ob = f.read()
    obs = json.loads(ob)
    if obs.get('format') != FORMAT_OBS or obs.get('pins') != env['pins'] or obs.get('paths') != env_paths(env) \
            or obs.get('receiptCopyProof') != receipts:
        refuse('the observation was made against other pinned inputs (outdated observation)')
    require_offline(mod, m1, env)
    ident = observe_identity(mod, m1, env)
    if ident != obs['currentHostIdentity']:
        refuse(f'host identity changed since the observation: {diff_keys(obs["currentHostIdentity"], ident)}')
    m2 = rebind(m1, ident)
    diff = allowed_diff(m1, m2)
    shas, files = render_checked(mod, m1, mtext1, m2, env)
    if os.path.lexists(out):
        refuse(f'{out} exists: every stage goes to a new directory')
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    evidence = {'format': FORMAT_STAGE, 'stagedAt': at, 'installed': False, 'pins': env['pins'], 'paths': env_paths(env),
                **shas, 'diff': diff, 'receiptCopyProof': receipts,
                'observation': {'path': os.path.abspath(obs_path), 'sha256': sha(ob), 'observedAt': obs['observedAt'],
                                'currentHostIdentity': ident}}
    files['evidence.json'] = json.dumps(evidence, indent=1, sort_keys=True) + '\n'
    files['NOT-INSTALLED.md'] = NOT_INSTALLED.format(
        fmt=FORMAT_STAGE, at=at, m1=shas['from']['manifestSha256'], u1=shas['from']['vmUnitSha256'],
        g1=shas['from']['guardUnitSha256'], m2=shas['to']['manifestSha256'], u2=shas['to']['vmUnitSha256'],
        g2=shas['to']['guardUnitSha256'], ino=ident['base']['ino'],
        diff='\n'.join(f'- {k}: {json.dumps(v[0])} -> {json.dumps(v[1])}' for k, v in diff.items()))
    os.mkdir(out, 0o700)
    for n in STAGE_FILES:
        with open(os.path.join(out, n), 'x') as f:
            f.write(files[n])
    with open(os.path.join(out, 'SHA256SUMS'), 'x') as f:
        f.write(''.join(f'{sha(files[n].encode())}  {n}\n' for n in STAGE_FILES))
    return evidence


def cmd_check_stage(env, d):
    with open(os.path.join(d, 'SHA256SUMS')) as f:
        sums = dict(reversed(l.rstrip('\n').split('  ', 1)) for l in f if l.strip())
    if sorted(sums) != sorted(STAGE_FILES) or sorted(os.listdir(d)) != sorted(STAGE_FILES + ('SHA256SUMS',)):
        refuse('the stage directory does not hold exactly the staged files')
    data = {}
    for n in STAGE_FILES:
        with open(os.path.join(d, n), 'rb') as f:
            data[n] = f.read()
        if sha(data[n]) != sums[n]:
            refuse(f'{n} differs from SHA256SUMS')
    ev = json.loads(data['evidence.json'])
    if ev.get('format') != FORMAT_STAGE or ev.get('installed') is not False or ev.get('pins') != env['pins'] \
            or ev.get('paths') != env_paths(env):
        refuse('the stage was made against other pinned inputs (outdated stage)')
    mod, m1, mtext1, receipts = inputs(env)
    if receipts != ev['receiptCopyProof']:
        refuse('receipt facts differ from the stage')
    require_offline(mod, m1, env)
    ident = observe_identity(mod, m1, env)
    if ident != ev['observation']['currentHostIdentity']:
        refuse(f"host identity changed since the stage: {diff_keys(ev['observation']['currentHostIdentity'], ident)}")
    m2 = rebind(m1, ident)
    allowed_diff(m1, m2)
    shas, files = render_checked(mod, m1, mtext1, m2, env)
    if {k: shas[k] for k in ('from', 'to')} != {k: ev[k] for k in ('from', 'to')}:
        refuse('the render pins differ from the stage')
    for n, t in files.items():
        if data[n] != t.encode():
            refuse(f'staged {n} is not the current render')
    return {'stage': os.path.abspath(d), 'current': True, 'installed': False, **shas}


def main(argv, env=None):
    ap = argparse.ArgumentParser(prog='rebind_usb.py')
    sub = ap.add_subparsers(dest='cmd', required=True)
    o = sub.add_parser('observe')
    o.add_argument('--out', required=True)
    s = sub.add_parser('stage')
    s.add_argument('--observation', required=True)
    s.add_argument('--out', required=True)
    c = sub.add_parser('check-stage')
    c.add_argument('--stage', required=True)
    for x in (o, s, c):
        for k in ('manifest-sha', 'restoration-sha', 'cleanup-sha'):
            x.add_argument('--' + k, required=True)
    a = ap.parse_args(argv)
    env = env or default_env(a)
    try:
        if a.cmd == 'observe':
            r = cmd_observe(env, a.out)
            r = {'observation': a.out, 'currentHostIdentity': r['currentHostIdentity']}
        elif a.cmd == 'stage':
            r = cmd_stage(env, a.observation, a.out)
            r = {'staged': a.out, 'installed': False, 'diff': r['diff'], 'to': r['to']}
        else:
            r = cmd_check_stage(env, a.stage)
    except (Refuse, OSError, ValueError, KeyError) as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return 2
    print(json.dumps(r, indent=1, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
