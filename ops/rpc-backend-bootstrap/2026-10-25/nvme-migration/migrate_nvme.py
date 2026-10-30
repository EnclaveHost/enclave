#!/usr/bin/python3 -I
"""enclave-rpc-nvme-migration/v1: move chosen qcow2 disks (phase 1: os + l1) of the v1 RPC VM to an NVMe backing,
OFFLINE, and stage (never install) a v2 manifest + units + launcher for root review.

  plan     --manifest M --launcher L --target-mount /vm --target-dir D --roles os,l1 --out PLAN.json [--discard ignore]
           read-only: source stats, both backing identities, bounded-capacity admission, v2 render preview.
  copy     --plan PLAN.json --journal J.jsonl [--resume]
           VM unit + guard unit inactive (MainPID 0), source not write-locked, then per disk:
           qemu-img create (new file, inode journaled) -> convert -n --target-is-zero -> fsync -> source unchanged ->
           qemu-img compare -> sha256 -> qemu-img check (read-only, no -r) -> info -> link to final name.
           Aborts (source intact, partial kept for a validated --resume) if /vm free reaches the pause threshold or the
           copy outgrows its bound. Never a live copy, never a backing chain, never shrink/truncate, never writes a source.
  finalize --plan PLAN.json --journal J.jsonl --out DIR
           every disk verified -> v2 manifest (new paths/inodes, unchanged serial/uuid/mac/ssh/seed/pins), units,
           launcher copy, install.sh (backs up first), rollback.sh, SHA256SUMS. Installs nothing.
"""
import argparse
import copy as copymod
import datetime
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time

FORMAT = 'enclave-rpc-nvme-migration/v1'
QEMU_IMG = '/usr/bin/qemu-img'
SYSTEMCTL = '/usr/bin/systemctl'
GIB = 1 << 30
DEFAULT_CAPACITY = {'floorBytes': 300_000_000_000,          # operator policy floor: >= 300 GB free on /vm
                    'pauseMarginBytes': 64 * GIB,            # one resume-for-shutdown budget (~guest RAM) + overshoot
                    'shutdownMarginBytes': 100_000_000_000,  # room for a graceful ACPI powerdown before the pause
                    'startHeadroomBytes': 20_000_000_000,    # minimum growth room at (re)start
                    'shutdownLeadSeconds': 2400,             # 40 min: shut down early if growth would hit pause sooner
                    'pollSeconds': 1}


class Refuse(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


def load_launcher(path):
    spec = importlib.util.spec_from_file_location('provision_vm_v2', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if getattr(mod, 'FORMAT_V2', None) != 'enclave-rpc-backend-vm/v2':
        refuse(f'{path} is not a v2-capable launcher')
    return mod


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(argv, ok=(0,), timeout=None):
    r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    if r.returncode not in ok:
        refuse(f'{argv[0]} {argv[1] if len(argv) > 1 else ""} exited {r.returncode}: {r.stderr.strip()[-500:]}')
    return r


def src_stat(path):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        refuse(f'{path} is not a regular single-link file')
    return {'path': path, 'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'allocated': st.st_blocks * 512,
            'mtimeNs': st.st_mtime_ns}


def unit_state(unit):
    """(ActiveState, MainPID) of a user unit; tests replace this."""
    r = run([SYSTEMCTL, '--user', 'show', '-p', 'ActiveState', '-p', 'MainPID', unit])
    kv = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
    return kv.get('ActiveState'), int(kv.get('MainPID', '-1'))


def require_offline(mod, disks):
    for u in (mod.UNIT, mod.GUARD_UNIT):
        state, pid = unit_state(u)
        if state not in ('inactive', 'failed') or pid != 0:
            refuse(f'{u} is {state} with MainPID {pid}: the VM must be stopped (no live qcow2 copy)')
    for d in disks:
        # without -U, qemu-img must get the shared locks: refused while any QEMU holds the image for writing
        run([QEMU_IMG, 'info', '--output=json', d], timeout=600)


def backing_policy(mod, kind, mount, directory, discard):
    desc = mod.describe_backing(mount)
    if not desc['rw']:
        refuse(f'{mount} is not mounted read-write')
    want_rot = mod.BACKING_KINDS[kind]['rotational']
    if any(leaf['rotational'] != want_rot for leaf in desc['leafDisks']):
        refuse(f"{mount}: leaf disks {desc['leafDisks']} are not all {'rotational' if want_rot else 'non-rotational'}")
    if desc['fsUuid'] is None:
        refuse(f"{mount}: no unique /dev/disk/by-uuid entry for {desc['source']}")
    return {'kind': kind, 'growth': mod.BACKING_KINDS[kind]['growth'], 'mount': mount, 'dir': directory,
            'fstype': desc['fstype'], 'source': desc['source'], 'fsUuid': desc['fsUuid'], 'leafDisks': desc['leafDisks'],
            'guestRotationRate': 7200 if want_rot else 1, 'discard': discard}


def copy_bound(allocated):
    return allocated + max(allocated // 100, GIB)


# ---- plan --------------------------------------------------------------------------------------------------------------
def cmd_plan(a):
    mod = load_launcher(a.launcher)
    mtext = open(a.manifest).read()
    m = json.loads(mtext)
    if m.get('format') != mod.FORMAT:
        refuse(f"manifest format {m.get('format')!r}: only a v1 manifest is migrated by this adapter")
    roles = a.roles.split(',')
    if not roles or any(r not in m['disks'] for r in roles) or len(set(roles)) != len(roles):
        refuse(f'roles {roles} must be distinct keys of the manifest disks {sorted(m["disks"])}')
    tdir = os.path.normpath(a.target_dir)
    if not tdir.startswith(a.target_mount.rstrip('/') + '/'):
        refuse(f'{tdir} is not inside {a.target_mount}')
    parent = os.path.dirname(tdir)
    pst = os.lstat(parent)
    if not stat.S_ISDIR(pst.st_mode) or pst.st_uid != os.getuid() or pst.st_dev != os.stat(a.target_mount).st_dev:
        refuse(f'{parent} must be a real directory of this user on the {a.target_mount} filesystem')
    pre_existing = os.path.lexists(tdir)
    if pre_existing:                   # accepted only as an EMPTY private directory of this user (e.g. made by root)
        st = os.lstat(tdir)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or \
                st.st_dev != os.stat(a.target_mount).st_dev or os.listdir(tdir):
            refuse(f'{tdir} already exists and is not an empty 0700 directory of this user on {a.target_mount} '
                   '(existing files are never reused by plan; resume is decided by copy against its journal)')
    cap = dict(DEFAULT_CAPACITY)
    for k in cap:
        v = getattr(a, k, None)
        if v is not None:
            cap[k] = v
    nvme = backing_policy(mod, 'nvme', a.target_mount, tdir, a.discard)
    nvme['capacity'] = cap
    hdd = backing_policy(mod, 'hdd', mod.HDD_MOUNT, m['paths']['hddDir'], 'ignore')
    if hdd['fstype'] != mod.HDD_FSTYPE:
        refuse(f'{mod.HDD_MOUNT} is not {mod.HDD_FSTYPE}')
    disks = {}
    for r in roles:
        src = src_stat(m['disks'][r]['path'])
        if src['ino'] != m['disks'][r]['ino']:
            refuse(f"{src['path']} inode {src['ino']} differs from the manifest's {m['disks'][r]['ino']}")
        name = os.path.basename(src['path'])
        disks[r] = {'src': src, 'dst': f'{tdir}/{name}', 'partial': f'{tdir}/.{name}.partial',
                    'boundBytes': copy_bound(src['allocated'])}
    free = mod.fs_free(a.target_mount)
    t = mod.thresholds(cap)
    need = sum(d['boundBytes'] for d in disks.values())
    after = free - need
    if after < t['start']:
        refuse(f'{a.target_mount} free {free} - copy bound {need} = {after} < start threshold {t["start"]}: the copied '
               'VM could not start under the bounded thin-provisioning policy')
    plan = {'format': FORMAT, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'manifest': {'path': os.path.abspath(a.manifest), 'sha256': hashlib.sha256(mtext.encode()).hexdigest()},
            'launcher': {'path': os.path.abspath(a.launcher), 'sha256': sha256_file(a.launcher)},
            'roles': roles, 'targetDir': tdir, 'targetDirPreExisting': pre_existing, 'backings': {'hdd': hdd, 'nvme': nvme}, 'disks': disks,
            'capacity': {'freeNow': free, 'copyBoundTotal': need, 'freeAfterCopyBound': after, 'thresholds': t,
                         'growthRoomBeforeShutdownRequest': after - t['shutdown'],
                         'growthRoomBeforePause': after - t['pause'],
                         'note': 'bounded thin provisioning: the 4 TB virtual L1 can NOT grow fully on this NVMe; '
                                 'the guard pauses/powers down only this VM before the floor'}}
    m2 = build_v2(mod, m, plan, {r: {'ino': None} for r in roles}, preview=True)
    plan['preview'] = {'qemuArgv': mod.qemu_argv(m2), 'vmUnit': mod.render_unit(m2, '<manifest-sha-after-copy>'),
                       'guardUnit': mod.render_guard_unit(m2, '<manifest-sha-after-copy>')}
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(plan, f, indent=1, sort_keys=True)
        f.write('\n')
    print(json.dumps({'plan': a.out, 'capacity': plan['capacity'], 'disks': {r: {'src': d['src']['path'],
                      'dst': d['dst'], 'boundBytes': d['boundBytes']} for r, d in disks.items()}}, indent=1))


def load_plan(path):
    text = open(path).read()
    plan = json.loads(text)
    if plan.get('format') != FORMAT:
        refuse('not a migration plan')
    return plan, hashlib.sha256(text.encode()).hexdigest()


# ---- journal -------------------------------------------------------------------------------------------------------------
def journal_read(path):
    if not os.path.exists(path):
        return []
    return [json.loads(line) for line in open(path) if line.strip()]


def journal_add(path, rec):
    rec = dict(rec, at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(json.dumps(rec, sort_keys=True) + '\n')
        f.flush()
        os.fsync(f.fileno())


def fsync_path(path, directory=False):
    fd = os.open(path, (os.O_RDONLY | os.O_DIRECTORY) if directory else os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def last(recs, role, event, plan_sha):
    hits = [r for r in recs if r.get('role') == role and r.get('event') == event and r.get('planSha256') == plan_sha]
    return hits[-1] if hits else None


# ---- copy ----------------------------------------------------------------------------------------------------------------
def check_check(info):
    bad = {k: info.get(k) for k in ('corruptions', 'leaks', 'check-errors', 'corruptions-fixed', 'leaks-fixed')
           if info.get(k)}
    if bad:
        refuse(f'qemu-img check reports {bad}')


def convert_guarded(mod, plan, d, nvme):
    """Run the convert while watching free space and the copy's own allocation; terminate on breach."""
    t = mod.thresholds(nvme['capacity'])
    p = subprocess.Popen([QEMU_IMG, 'convert', '-n', '--target-is-zero', '-f', 'qcow2', '-O', 'qcow2',
                          d['src']['path'], d['partial']], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.PIPE, text=True)
    breach = []

    def watch():
        while p.poll() is None:
            try:
                free = mod.fs_free(nvme['mount'])
                alloc = os.stat(d['partial']).st_blocks * 512
            except OSError as e:
                breach.append(f'watch failed: {e}')
            else:
                if free <= t['pause']:
                    breach.append(f"{nvme['mount']} free {free} reached the pause threshold {t['pause']}")
                elif alloc > d['boundBytes']:
                    breach.append(f"copy allocated {alloc} > bound {d['boundBytes']}")
            if breach:
                p.terminate()
                return
            time.sleep(2)

    w = threading.Thread(target=watch, daemon=True)
    w.start()
    err = p.communicate()[1]
    w.join(10)
    if breach:
        refuse('copy aborted: ' + '; '.join(breach))
    if p.returncode != 0:
        refuse(f'qemu-img convert exited {p.returncode}: {err.strip()[-500:]}')


def copy_one(mod, plan, plan_sha, role, journal, resume):
    d, nvme = plan['disks'][role], plan['backings']['nvme']
    recs = journal_read(journal)
    if os.path.lexists(d['dst']):
        v = last(recs, role, 'verified', plan_sha)
        st = os.lstat(d['dst'])
        if not resume or v is None or (st.st_dev, st.st_ino) != (v['dev'], v['ino']):
            refuse(f"{d['dst']} exists: only --resume with a matching verified journal record for this plan may skip it")
        if sha256_file(d['dst']) != v['sha256']:
            refuse(f"{d['dst']} no longer matches its verified sha256")
        return {'role': role, 'skipped': 'already verified', 'sha256': v['sha256']}
    if os.path.lexists(d['partial']):
        s = last(recs, role, 'started', plan_sha)
        st = os.lstat(d['partial'])
        if not resume or s is None or (st.st_dev, st.st_ino) != (s['dev'], s['ino']) or not stat.S_ISREG(st.st_mode):
            refuse(f"{d['partial']} exists: only --resume with a matching started journal record for this plan may "
                   'discard it (refusing to touch it)')
        os.unlink(d['partial'])        # a qemu-img convert cannot resume: our own partial is discarded and redone
        journal_add(journal, {'role': role, 'event': 'discarded-partial', 'planSha256': plan_sha, 'ino': s['ino']})
    t = mod.thresholds(nvme['capacity'])
    free = mod.fs_free(nvme['mount'])
    rest = sum(plan['disks'][r]['boundBytes'] for r in plan['roles'] if not os.path.lexists(plan['disks'][r]['dst']))
    if free - rest < t['start']:
        refuse(f"{nvme['mount']} free {free} - remaining copy bound {rest} < start threshold {t['start']}")
    before = src_stat(d['src']['path'])
    if (before['dev'], before['ino']) != (d['src']['dev'], d['src']['ino']):
        refuse(f"{d['src']['path']} is not the planned file")
    sinfo = json.loads(run([QEMU_IMG, 'info', '--output=json', d['src']['path']]).stdout)
    if sinfo.get('format') != 'qcow2' or 'backing-filename' in sinfo:
        refuse(f"{d['src']['path']} is not a standalone qcow2")
    run([QEMU_IMG, 'create', '-q', '-f', 'qcow2', '-o', 'compat=1.1,preallocation=off,lazy_refcounts=off,'
         f"cluster_size={sinfo['cluster-size']}", d['partial'], str(sinfo['virtual-size'])])
    st = os.lstat(d['partial'])
    journal_add(journal, {'role': role, 'event': 'started', 'planSha256': plan_sha, 'dev': st.st_dev, 'ino': st.st_ino,
                          'source': before})
    convert_guarded(mod, plan, d, nvme)
    fsync_path(d['partial'])
    fsync_path(os.path.dirname(d['partial']), directory=True)
    after = src_stat(d['src']['path'])
    if after != before:
        refuse(f"source changed during the copy ({before} -> {after}): it was not offline")
    run([QEMU_IMG, 'compare', '-f', 'qcow2', '-F', 'qcow2', d['src']['path'], d['partial']])
    digest = sha256_file(d['partial'])
    chk = json.loads(run([QEMU_IMG, 'check', '--output=json', '-f', 'qcow2', d['partial']]).stdout)
    check_check(chk)
    info = json.loads(run([QEMU_IMG, 'info', '--output=json', d['partial']]).stdout)
    if info.get('format') != 'qcow2' or 'backing-filename' in info or \
            info.get('virtual-size') != json.loads(run([QEMU_IMG, 'info', '--output=json', d['src']['path']]).stdout)['virtual-size']:
        refuse(f"{d['partial']} is not a standalone qcow2 of the source's virtual size")
    if src_stat(d['src']['path']) != before:
        refuse('source changed during verification')
    os.link(d['partial'], d['dst'])        # exclusive: fails if the final name appeared meanwhile
    os.unlink(d['partial'])
    fsync_path(os.path.dirname(d['dst']), directory=True)
    fin = os.lstat(d['dst'])
    if (fin.st_dev, fin.st_ino) != (st.st_dev, st.st_ino) or fin.st_nlink != 1:
        refuse(f"{d['dst']} is not the verified copy")
    rec = {'role': role, 'event': 'verified', 'planSha256': plan_sha, 'dev': fin.st_dev, 'ino': fin.st_ino,
           'sha256': digest, 'size': fin.st_size, 'allocated': fin.st_blocks * 512, 'compare': 'identical',
           'check': {k: chk.get(k) for k in ('image-end-offset', 'allocated-clusters', 'total-clusters', 'check-errors')},
           'source': before}
    journal_add(journal, rec)
    return rec


def cmd_copy(a):
    plan, plan_sha = load_plan(a.plan)
    mod = load_launcher(plan['launcher']['path'])
    if sha256_file(plan['launcher']['path']) != plan['launcher']['sha256']:
        refuse('launcher changed since the plan')
    if sha256_file(plan['manifest']['path']) != plan['manifest']['sha256']:
        refuse('manifest changed since the plan')
    nvme = plan['backings']['nvme']
    got = mod.describe_backing(nvme['mount'])
    for k in ('fstype', 'fsUuid', 'leafDisks'):
        if got[k] != nvme[k]:
            refuse(f"{nvme['mount']} {k} changed since the plan")
    require_offline(mod, [plan['disks'][r]['src']['path'] for r in plan['roles']])
    tdir = plan['targetDir']
    if not os.path.lexists(tdir):
        os.mkdir(tdir, 0o700)
    st = os.lstat(tdir)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077 or \
            st.st_dev != os.stat(nvme['mount']).st_dev:
        refuse(f'{tdir} must be this user\'s 0700 directory on {nvme["mount"]}')
    out = [copy_one(mod, plan, plan_sha, r, a.journal, a.resume) for r in plan['roles']]
    print(json.dumps({'copied': out}, indent=1, sort_keys=True))


# ---- finalize ------------------------------------------------------------------------------------------------------------
IMMUTABLE = ('name', 'uid', 'mac', 'instanceId', 'sshPublicKey', 'sshKeyFingerprint', 'baseImage', 'ports', 'vm')


def build_v2(mod, m1, plan, verified, preview=False, copy_method=None):
    m = copymod.deepcopy(m1)
    m['format'] = mod.FORMAT_V2
    m['backings'] = plan['backings']
    for role, d in m['disks'].items():
        if role in plan['roles']:
            d['path'] = plan['disks'][role]['dst']
            d['ino'] = verified[role]['ino']
            d['backing'] = 'nvme'
        else:
            d['backing'] = 'hdd'
    p = m['paths']
    p.update(guardQmp=p['runtimeDir'] + '/guard-qmp.sock', guardStatus=p['stateDir'] + '/guard-status.json',
             guardMode=p['stateDir'] + '/guard-mode.json',
             guardUnitPath=os.path.join(os.path.dirname(p['unitPath']), mod.GUARD_UNIT))
    if 'os' in plan['roles']:
        p['osDisk'] = plan['disks']['os']['dst']
    m['nvme'] = {'chainStorageAuthorized': True, 'capBytes': None, 'cacheBytes': 0,
                 'override': '2026-10-25 user: fastest NVMe chain storage authorized; the former 250 GB cap removed',
                 'freeFloorPolicy': 'operator policy (not a user cap): keep >= 300 GB free on the NVMe filesystem'}
    m['migration'] = {'format': FORMAT, 'fromManifestSha256': plan['manifest']['sha256'], 'copyMethod': copy_method,
                      'disks': {r: {'from': {'path': plan['disks'][r]['src']['path'], 'ino': plan['disks'][r]['src']['ino']},
                                    'to': {'path': plan['disks'][r]['dst'], **verified[r]}} for r in plan['roles']}}
    if not preview:
        mod.validate_v2(m)
    for k in IMMUTABLE:
        if m.get(k) != m1.get(k):
            refuse(f'{k} changed')
    for role, d in m['disks'].items():
        for k in ('serial', 'uuid', 'label', 'mount', 'bytes', 'role', 'format'):
            if d.get(k) != m1['disks'][role].get(k):
                refuse(f'disks.{role}.{k} changed')
    if mod.seed_files(m) != mod.seed_files(m1) or mod.guest_disk_config(m) != mod.guest_disk_config(m1):
        refuse('seed/guest disk config render changed')
    m['files'] = dict(m1['files'], launcher=plan['launcher']['sha256'],
                      qemuArgv=mod.sha256_text(mod.canonical(mod.qemu_argv(m))))
    return m


INSTALL = r'''#!/bin/bash
# Staged by migrate_nvme.py ({fmt}). ROOT REVIEWS FIRST. Run as uid {uid} (the user unit owner), never as root.
# Backs up the current v1 files, installs the staged v2 files, daemon-reloads and runs `provision_vm.py verify`.
# It never starts, stops or enables any unit and never touches a disk image.
set -euo pipefail
umask 077
STAGE={stage}
STATE={state}
VM_UNIT={vm_unit}
GUARD_UNIT={guard_unit}
UNITDIR={unitdir}
BK="$STATE/backup-{mid}"
[ "$(id -u)" = {uid} ] || {{ echo "run as uid {uid}"; exit 1; }}
for u in "$VM_UNIT" "$GUARD_UNIT"; do
  s=$(systemctl --user show -p ActiveState --value "$u"); p=$(systemctl --user show -p MainPID --value "$u")
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop the VM first"; exit 1;; esac
  [ "$p" = 0 ] || {{ echo "$u MainPID $p"; exit 1; }}
done
(cd "$STAGE" && sha256sum -c --quiet SHA256SUMS)
echo "{old_manifest}  $STATE/manifest.json" | sha256sum -c --quiet -
echo "{old_launcher}  $STATE/provision_vm.py" | sha256sum -c --quiet -
echo "{old_unit}  $UNITDIR/$VM_UNIT" | sha256sum -c --quiet -
[ ! -e "$UNITDIR/$GUARD_UNIT" ] || {{ echo "$UNITDIR/$GUARD_UNIT already exists"; exit 1; }}
for f in {images}; do [ -f "$f" ] || {{ echo "missing $f"; exit 1; }}; done
mkdir -m 0700 "$BK"
cp -a "$STATE/manifest.json" "$STATE/provision_vm.py" "$BK/"
cp -a "$UNITDIR/$VM_UNIT" "$BK/$VM_UNIT"
(cd "$BK" && sha256sum manifest.json provision_vm.py "$VM_UNIT" > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$STAGE/provision_vm.py" "$STATE/.provision_vm.py.new" && mv -f "$STATE/.provision_vm.py.new" "$STATE/provision_vm.py"
install -m 0600 "$STAGE/manifest.json" "$STATE/.manifest.json.new" && mv -f "$STATE/.manifest.json.new" "$STATE/manifest.json"
install -m 0644 "$STAGE/$VM_UNIT" "$UNITDIR/.$VM_UNIT.new" && mv -f "$UNITDIR/.$VM_UNIT.new" "$UNITDIR/$VM_UNIT"
install -m 0644 "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT"
cmp "$STAGE/provision_vm.py" "$STATE/provision_vm.py"; cmp "$STAGE/manifest.json" "$STATE/manifest.json"
cmp "$STAGE/$VM_UNIT" "$UNITDIR/$VM_UNIT"; cmp "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT"
systemctl --user daemon-reload
if ! /usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-install.json"; then
  echo "verify FAILED after install: run $STAGE/rollback.sh"; exit 1
fi
echo "installed v2 (backup $BK). Start only after review: systemctl --user start $VM_UNIT (pulls $GUARD_UNIT)"
'''

ROLLBACK = r'''#!/bin/bash
# Restores the v1 files backed up by install.sh. Run as uid {uid}, VM and guard stopped. The HDD images were never
# modified by the migration, but any chain progress made while running on the NVMe copies is NOT on the HDD copies.
set -euo pipefail
umask 077
STAGE={stage}
STATE={state}
VM_UNIT={vm_unit}
GUARD_UNIT={guard_unit}
UNITDIR={unitdir}
BK="$STATE/backup-{mid}"
[ "$(id -u)" = {uid} ] || {{ echo "run as uid {uid}"; exit 1; }}
for u in "$VM_UNIT" "$GUARD_UNIT"; do
  s=$(systemctl --user show -p ActiveState --value "$u"); p=$(systemctl --user show -p MainPID --value "$u")
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop it first"; exit 1;; esac
  [ "$p" = 0 ] || {{ echo "$u MainPID $p"; exit 1; }}
done
(cd "$BK" && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$BK/provision_vm.py" "$STATE/.provision_vm.py.new" && mv -f "$STATE/.provision_vm.py.new" "$STATE/provision_vm.py"
install -m 0600 "$BK/manifest.json" "$STATE/.manifest.json.new" && mv -f "$STATE/.manifest.json.new" "$STATE/manifest.json"
install -m 0644 "$BK/$VM_UNIT" "$UNITDIR/.$VM_UNIT.new" && mv -f "$UNITDIR/.$VM_UNIT.new" "$UNITDIR/$VM_UNIT"
if [ -e "$UNITDIR/$GUARD_UNIT" ]; then
  cmp "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT" && rm -f "$UNITDIR/$GUARD_UNIT"
fi
rm -f "$STATE/guard-status.json" "$STATE/guard-mode.json"
systemctl --user daemon-reload
/usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-rollback.json"
echo "rolled back to the v1 HDD manifest; the NVMe copies are left in place for root to keep or delete"
'''


def stage_v2(mod, plan, plan_sha, m1, verified, out, launcher_path, launcher_sha, old_unit=None, copy_method=None):
    """Build + self-check the v2 manifest, then write ONLY into the new `out` dir (installs nothing).
    files.launcher is ALWAYS the accepted launcher sha (plan pin, or an explicit re-pin, also at the same path)."""
    m2 = build_v2(mod, m1, plan, verified, copy_method=copy_method)
    m2['files']['launcher'] = launcher_sha
    mtext2 = mod.canonical(m2)
    msha2 = mod.sha256_text(mtext2)
    os.mkdir(out, 0o700)
    files = {'manifest.json': mtext2, mod.UNIT: mod.render_unit(m2, msha2),
             mod.GUARD_UNIT: mod.render_guard_unit(m2, msha2)}
    for n, t in files.items():
        with open(os.path.join(out, n), 'x') as f:
            f.write(t)
    with open(launcher_path, 'rb') as src, open(os.path.join(out, 'provision_vm.py'), 'xb') as dst:
        dst.write(src.read())
    if sha256_file(os.path.join(out, 'provision_vm.py')) != m2['files']['launcher']:
        refuse('staged launcher differs from the manifest pin')
    p1 = m1['paths']
    fmt = dict(fmt=FORMAT, uid=m1['uid'], stage=out, state=p1['stateDir'], vm_unit=mod.UNIT, guard_unit=mod.GUARD_UNIT,
               unitdir=os.path.dirname(p1['unitPath']), mid=plan_sha[:12], old_manifest=plan['manifest']['sha256'],
               old_launcher=m1['files']['launcher'], old_unit=sha256_file(p1['unitPath']) if old_unit is None
               else old_unit, images=' '.join(plan['disks'][r]['dst'] for r in plan['roles']))
    for n, t in (('install.sh', INSTALL), ('rollback.sh', ROLLBACK)):
        with open(os.path.join(out, n), 'x') as f:
            f.write(t.format(**fmt))
        os.chmod(os.path.join(out, n), 0o700)
    names = sorted(os.listdir(out))
    with open(os.path.join(out, 'SHA256SUMS'), 'x') as f:
        for n in names:
            f.write(f'{sha256_file(os.path.join(out, n))}  {n}\n')
    return m2, msha2


def load_plan_inputs(a, plan):
    """Plan, pinned launcher (or an explicitly accepted re-pin) and the unchanged input manifest."""
    launcher, launcher_sha = plan['launcher']['path'], plan['launcher']['sha256']
    if getattr(a, 'launcher', None):
        got = sha256_file(a.launcher)
        if not HEX64.fullmatch(a.accept_launcher_sha or '') or got != a.accept_launcher_sha:
            refuse(f'--launcher {a.launcher} sha256 {got} != --accept-launcher-sha')
        launcher, launcher_sha = a.launcher, got
    elif sha256_file(launcher) != launcher_sha:
        refuse('launcher changed since the plan (re-pin only with --launcher + --accept-launcher-sha)')
    mod = load_launcher(launcher)
    mtext = open(plan['manifest']['path']).read()
    if hashlib.sha256(mtext.encode()).hexdigest() != plan['manifest']['sha256']:
        refuse('manifest changed since the plan')
    return mod, launcher, launcher_sha, json.loads(mtext)


def cmd_finalize(a):
    plan, plan_sha = load_plan(a.plan)
    mod, launcher, launcher_sha, m1 = load_plan_inputs(a, plan)
    recs = journal_read(a.journal)
    verified = {}
    for r in plan['roles']:
        v = last(recs, r, 'verified', plan_sha)
        if v is None:
            refuse(f'disk {r} has no verified copy for this plan')
        st = os.lstat(plan['disks'][r]['dst'])
        if (st.st_dev, st.st_ino) != (v['dev'], v['ino']):
            refuse(f"{plan['disks'][r]['dst']} is not the verified inode")
        verified[r] = {'ino': v['ino'], 'sha256': v['sha256'], 'allocated': v['allocated']}
    m2, msha2 = stage_v2(mod, plan, plan_sha, m1, verified, a.out, launcher, launcher_sha, a.old_unit,
                         copy_method='migrate_nvme.py qemu-img convert + compare')
    print(json.dumps({'staged': a.out, 'manifestSha256': msha2, 'qemuArgvSha256': m2['files']['qemuArgv'],
                      'disks': {r: {'path': m2['disks'][r]['path'], 'ino': m2['disks'][r]['ino']} for r in plan['roles']},
                      'next': f'root reviews, then (VM stopped) {a.out}/install.sh'}, indent=1, sort_keys=True))


# ---- finalize from the root-reviewed external copy helper's receipts -------------------------------------------------
RECEIPT_FORMAT = 'enclave-nvme-copy-receipt/v1'
HELPER_SHA256 = 'e48a7cb8b954059e6530a3cca56b03e688f8239d0c42c68d658126fd8dfc6561'   # nvme-copy-root-review/nvme_copy.py
MIN_RESERVE = 300_000_000_000          # operator policy free-space floor on the target (not a user cap)
STAT_KEYS = ('dev', 'ino', 'size', 'mtime_ns', 'ctime_ns', 'nlink', 'mode')
HEX64 = re.compile(r'[0-9a-f]{64}')


def utc_s(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()


def check_receipt(plan, role, rec, unit, helper_sha=HELPER_SHA256):
    """Pure: the receipt is the pinned helper's successful byte-for-byte copy of exactly this plan's source to exactly
    this plan's target, with the VM unit stopped throughout and the source unchanged across the copy."""
    d, src = plan['disks'][role], plan['disks'][role]['src']
    if not isinstance(rec, dict) or rec.get('format') != RECEIPT_FORMAT:
        refuse(f'{role}: not an {RECEIPT_FORMAT} receipt')
    if rec.get('helperSha256') != helper_sha:
        refuse(f"{role}: receipt helper {rec.get('helperSha256')} is not the root-reviewed helper {helper_sha}")
    if rec.get('status') != 'ok':
        refuse(f"{role}: receipt status {rec.get('status')!r}")
    rp = rec.get('plan') or {}
    rs, rt = rp.get('source') or {}, rp.get('target') or {}
    if [rs.get(k) for k in ('path', 'dev', 'ino', 'size')] != [src[k] for k in ('path', 'dev', 'ino', 'size')]:
        refuse(f'{role}: receipt source {rs} is not the planned source')
    if os.path.join(str(rt.get('dir')), str(rt.get('name'))) != d['dst'] or rec.get('final') != d['dst']:
        refuse(f"{role}: receipt target {rt}/{rec.get('final')} is not the planned {d['dst']}")
    if rp.get('unit') != unit:
        refuse(f"{role}: receipt checked unit {rp.get('unit')!r}, not {unit}")
    if not isinstance(rp.get('reserveBytes'), int) or rp['reserveBytes'] < MIN_RESERVE:
        refuse(f'{role}: receipt reserve below the {MIN_RESERVE} B operator floor')
    before, after = rec.get('sourceBefore') or {}, rec.get('sourceAfter') or {}
    if any(before.get(k) is None for k in STAT_KEYS) or before != after:
        refuse(f'{role}: source stat changed across the copy (or is incomplete)')
    if [before[k] for k in ('dev', 'ino', 'size', 'mtime_ns')] != [src[k] for k in ('dev', 'ino', 'size', 'mtimeNs')]:
        refuse(f'{role}: the copied source is not the source state the plan recorded (modified since the plan)')
    for k in ('unitBefore', 'unitAfterLock', 'unitAfterCopy'):
        u = rec.get(k) or {}
        if u.get('ActiveState') not in ('inactive', 'failed') or str(u.get('MainPID')) != '0':
            refuse(f'{role}: {k} shows the unit {u}')
    h = rec.get('copySha256')
    if not (isinstance(h, str) and HEX64.fullmatch(h)) or rec.get('sourceSha256') != h:
        refuse(f'{role}: copySha256 must be 64 lowercase hex digits and equal sourceSha256')
    if rec.get('bytes') != src['size'] or not isinstance(rec.get('finalInode'), int):
        refuse(f'{role}: receipt size/inode fields are wrong')
    if not isinstance(rec.get('allocatedBytes'), int) or rec['allocatedBytes'] > d['boundBytes']:
        refuse(f"{role}: copy allocated {rec.get('allocatedBytes')} > planned bound {d['boundBytes']}")
    return utc_s(rec['finished'])


def check_current(mod, plan, role, rec, finished, rehash_if_stale):
    """Host checks at finalize time: source untouched since the receipt, target is the receipt's inode, unmodified since
    the receipt (mtime/ctime), and a read-only qemu-img info + check pass. Re-hash only if the timestamps cannot vouch."""
    d, nvme = plan['disks'][role], plan['backings']['nvme']
    cur = os.lstat(d['src']['path'])
    if [getattr(cur, 'st_' + k) for k in STAT_KEYS] != [rec['sourceAfter'][k] for k in STAT_KEYS]:
        refuse(f"{role}: source {d['src']['path']} changed after the copy receipt")
    st = os.lstat(d['dst'])
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o077 or \
            st.st_dev != os.stat(nvme['mount']).st_dev:
        refuse(f"{role}: {d['dst']} is not a private single-link regular file of this user on {nvme['mount']}")
    if st.st_ino != rec['finalInode'] or st.st_size != rec['bytes']:
        refuse(f"{role}: {d['dst']} inode/size {st.st_ino}/{st.st_size} != receipt {rec['finalInode']}/{rec['bytes']}")
    limit = int((finished + 1) * 1e9)
    how = 'receipt inode+size+mtime/ctime<=finished'
    if st.st_mtime_ns > limit or st.st_ctime_ns > limit:
        if not rehash_if_stale:
            refuse(f"{role}: {d['dst']} was modified/relinked after the receipt (mtime/ctime later than "
                   f"{rec['finished']}): stale or substituted copy; re-run with --rehash-if-stale to re-verify the hash")
        if sha256_file(d['dst']) != rec['copySha256']:
            refuse(f"{role}: {d['dst']} no longer matches the receipt sha256")
        how = 'full re-hash (timestamps later than the receipt)'
    info = json.loads(run([QEMU_IMG, 'info', '--output=json', d['dst']]).stdout)     # no -U: refuses a held image
    if info.get('format') != 'qcow2' or 'backing-filename' in info or info.get('virtual-size') != plan['disks'][role]['virtualSize']:
        refuse(f"{role}: {d['dst']} is not a standalone qcow2 of {plan['disks'][role]['virtualSize']} B")
    chk = json.loads(run([QEMU_IMG, 'check', '--output=json', '-f', 'qcow2', d['dst']], ok=(0,)).stdout)  # never -r
    check_check(chk)
    return {'ino': st.st_ino, 'sha256': rec['copySha256'], 'allocated': st.st_blocks * 512, 'identity': how,
            'qemuImgCheck': {k: chk.get(k) for k in ('check-errors', 'allocated-clusters', 'image-end-offset')}}


def cmd_finalize_receipts(a):
    plan, plan_sha = load_plan(a.plan)
    mod, launcher, launcher_sha, m1 = load_plan_inputs(a, plan)
    for r in plan['roles']:
        plan['disks'][r]['virtualSize'] = m1['disks'][r]['bytes']
    receipts = dict(x.split('=', 1) for x in a.receipt)
    if sorted(receipts) != sorted(plan['roles']):
        refuse(f'receipts for {sorted(receipts)} but the plan migrates {sorted(plan["roles"])}: every disk needs one')
    for u in (mod.UNIT, mod.GUARD_UNIT):
        state, pid = unit_state(u)
        if state not in ('inactive', 'failed') or pid != 0:
            refuse(f'{u} is {state} with MainPID {pid}: finalize only with the VM stopped')
    verified = {}
    for r in plan['roles']:
        text = open(receipts[r], 'rb').read()
        rec = json.loads(text)
        finished = check_receipt(plan, r, rec, mod.UNIT, a.helper_sha)
        v = check_current(mod, plan, r, rec, finished, a.rehash_if_stale)
        v['copy'] = {'receipt': os.path.abspath(receipts[r]), 'receiptSha256': hashlib.sha256(text).hexdigest(),
                     'helperSha256': rec['helperSha256'], 'finished': rec['finished']}
        verified[r] = v
    m2, msha2 = stage_v2(mod, plan, plan_sha, m1, verified, a.out, launcher, launcher_sha, a.old_unit,
                         copy_method='root-reviewed nvme_copy.py byte-for-byte copy (receipts)')
    t = mod.thresholds(plan['backings']['nvme']['capacity'])
    free = mod.fs_free(plan['backings']['nvme']['mount'])
    print(json.dumps({'staged': a.out, 'manifestSha256': msha2, 'qemuArgvSha256': m2['files']['qemuArgv'],
                      'launcherSha256': m2['files']['launcher'],
                      'disks': {r: {'path': m2['disks'][r]['path'], 'ino': m2['disks'][r]['ino'],
                                    'identity': verified[r]['identity']} for r in plan['roles']},
                      'capacity': {'freeNow': free, 'startThreshold': t['start'], 'startAdmitted': free >= t['start']},
                      'next': f'root reviews, then (VM stopped) {a.out}/install.sh'}, indent=1, sort_keys=True))


def main(argv):
    ap = argparse.ArgumentParser(prog='migrate_nvme.py')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('plan')
    p.add_argument('--manifest', required=True)
    p.add_argument('--launcher', required=True)
    p.add_argument('--target-mount', required=True)
    p.add_argument('--target-dir', required=True)
    p.add_argument('--roles', default='os,l1')
    p.add_argument('--discard', choices=('ignore', 'unmap'), default='ignore')
    p.add_argument('--out', required=True)
    for k in DEFAULT_CAPACITY:
        p.add_argument('--' + k, dest=k, type=int)
    c = sub.add_parser('copy')
    c.add_argument('--plan', required=True)
    c.add_argument('--journal', required=True)
    c.add_argument('--resume', action='store_true')
    f = sub.add_parser('finalize')
    f.add_argument('--plan', required=True)
    f.add_argument('--journal', required=True)
    f.add_argument('--out', required=True)
    f.add_argument('--old-unit', help='expected sha256 of the installed v1 unit (default: hash it now)')
    r = sub.add_parser('finalize-receipts')
    r.add_argument('--plan', required=True)
    r.add_argument('--receipt', action='append', default=[], metavar='ROLE=RECEIPT.json', required=True)
    r.add_argument('--out', required=True)
    r.add_argument('--old-unit')
    r.add_argument('--helper-sha', default=HELPER_SHA256)
    r.add_argument('--rehash-if-stale', action='store_true')
    for x in (f, r):
        x.add_argument('--launcher', help='re-pin a launcher other than the plan\'s (needs --accept-launcher-sha)')
        x.add_argument('--accept-launcher-sha')
    a = ap.parse_args(argv)
    try:
        {'plan': cmd_plan, 'copy': cmd_copy, 'finalize': cmd_finalize,
         'finalize-receipts': cmd_finalize_receipts}[a.cmd](a)
    except Refuse as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
