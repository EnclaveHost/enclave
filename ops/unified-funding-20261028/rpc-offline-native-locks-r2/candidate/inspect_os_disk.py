#!/usr/bin/python3 -I
"""rpc-memory-recovery-stage/r1: READ-ONLY, rootless offline inspection of the STOPPED enclave-rpc-production OS disk (root runs).

Resolves, from the authoritative OS disk (not from the payload source), whether a reboot can run the first-download unit
enclave-rpc-base-snapshot.service and which L1/holder units start at boot:
  1. refuses unless the VM and guard user units are inactive and no process has the OS qcow2 open (/proc/*/fd);
  2. exposes the qcow2 READ-ONLY as a raw FUSE file: nbdfuse -r <tmp>/os.raw [ qemu-nbd -r -f qcow2 <os.qcow2> ] (systemd socket
     activation; QEMU's own image locking also refuses a disk another QEMU holds); never writes, copies or converts the image;
  3. parses the GPT, picks the ext4 partition labelled cloudimg-rootfs (exactly one), and reads files with
     debugfs -c (read-only, catastrophic mode) on "<raw>?offset=<bytes>";
  4. reports: the installed unit's bytes/sha vs payload-v2's, its drop-ins, its Condition*/RequiresMountsFor lines, every
     .wants symlink of the L1/holder/snapshot/retention units (enabled true/false), and the /etc/fstab line for the base mount;
  5. always unmounts (fusermount3 -u) and waits for nbdfuse/qemu-nbd to exit.
Output: one JSON record (format enclave-rpc-os-disk-inspection/r1) on stdout; exit 0 inspected, 2 refused/failed.
`bootSnapshotSafe` is true only if the unit is byte-identical to payload-v2's (RequiresMountsFor + ConditionPathIsMountPoint +
ConditionPathExists=!snapshot-complete) with no drop-in; the marker itself lives on the BASE disk and is not read here.
"""
import argparse, hashlib, json, os, re, shutil, struct, subprocess, sys, tempfile, time, uuid

UNIT_DIR = '/etc/systemd/system'
SNAPSHOT_UNIT = 'enclave-rpc-base-snapshot.service'
WATCH = ('enclave-rpc-base-snapshot.service', 'enclave-rpc-l1-snapshot.service', 'enclave-l1-el.path', 'enclave-l1-el.service',
         'enclave-l1-cl.service', 'enclave-base-holder.path', 'enclave-base-holder.service', 'enclave-base-retention.service')
VM_UNITS = ('enclave-rpc-production-vm.service', 'enclave-rpc-production-guard.service')
LINUX_FS = uuid.UUID('0fc63daf-8483-4772-8e79-3d69d8477de4')
DEFAULT_PAYLOAD = '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/payload-v2/units/enclave-rpc-base-snapshot.service'


class Refuse(Exception):
    pass


def gpt_partitions(f, sector=512):
    """-> [{index, type, first, last, name}] from the primary GPT of a read-only file object"""
    f.seek(sector); h = f.read(92)
    if h[:8] != b'EFI PART':
        raise Refuse('no GPT header at LBA 1')
    entries_lba, count, size = struct.unpack_from('<QII', h, 72)
    if not (0 < count <= 512 and 128 <= size <= 4096):
        raise Refuse('implausible GPT entry table')
    f.seek(entries_lba * sector); table = f.read(count * size)
    out = []
    for i in range(count):
        e = table[i * size:(i + 1) * size]
        t = uuid.UUID(bytes_le=e[:16])
        if t.int == 0:
            continue
        first, last = struct.unpack_from('<QQ', e, 32)
        out.append({'index': i + 1, 'type': str(t), 'first': first, 'last': last, 'name': e[56:128].decode('utf-16-le').rstrip('\0')})
    return out


def ext4_label(f, offset):
    f.seek(offset + 1024); sb = f.read(1024)
    if len(sb) < 0x88 or struct.unpack_from('<H', sb, 0x38)[0] != 0xEF53:
        return None
    return sb[0x78:0x88].rstrip(b'\0').decode('utf-8', 'replace')


def root_offset(raw, sector=512):
    with open(raw, 'rb') as f:
        parts = [p for p in gpt_partitions(f, sector) if uuid.UUID(p['type']) == LINUX_FS]
        roots = [p for p in parts if ext4_label(f, p['first'] * sector) == 'cloudimg-rootfs']
    if len(roots) != 1:
        raise Refuse(f'expected exactly one ext4 cloudimg-rootfs partition, found {len(roots)}')
    return roots[0]['first'] * sector, roots[0]


def parse_ls_p(text):
    """debugfs `ls -p`: /inode/mode/uid/gid/name/size/ -> [{name, mode}]"""
    out = []
    for line in text.splitlines():
        m = re.match(r'^/(\d+)/(\d+)/(\d+)/(\d+)/(.*)/(\d*)/$', line.strip())
        if m and m.group(5) not in ('.', '..'):
            out.append({'name': m.group(5), 'mode': int(m.group(2), 8)})
    return out


def enabled_map(listing):
    """listing: {wants_dir: [entries]} -> {unit: bool} (True = a symlink of that name in some .wants dir)"""
    return {u: any(e['name'] == u and (e['mode'] & 0o170000) == 0o120000 for es in listing.values() for e in es) for u in WATCH}


def debugfs(dev, request, run=subprocess.run):
    r = run(['debugfs', '-c', '-R', request, dev], capture_output=True, timeout=60)
    return r.returncode, r.stdout


def open_by_others(path):
    real, hits = os.path.realpath(path), []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            for fd in os.listdir(f'/proc/{pid}/fd'):
                try:
                    if os.readlink(f'/proc/{pid}/fd/{fd}') == real:
                        hits.append(int(pid))
                except OSError:
                    pass
        except OSError:
            continue
    return sorted(set(hits))


def unit_active(unit, run=subprocess.run):
    r = run(['systemctl', '--user', 'show', '--property=ActiveState', '--value', unit], capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 else 'unknown'


def inspect(dev, payload, run=subprocess.run):
    """dev = '<raw>?offset=N' (or any debugfs-readable ext4 image); -> the record body"""
    rc, unit = debugfs(dev, f'cat {UNIT_DIR}/{SNAPSHOT_UNIT}', run)
    rc_d, dropins = debugfs(dev, f'ls -p {UNIT_DIR}/{SNAPSHOT_UNIT}.d', run)
    _, top = debugfs(dev, f'ls -p {UNIT_DIR}', run)
    wants = [e['name'] for e in parse_ls_p(top.decode('utf-8', 'replace')) if e['name'].endswith('.wants') and (e['mode'] & 0o170000) == 0o040000]
    listing = {w: parse_ls_p(debugfs(dev, f'ls -p {UNIT_DIR}/{w}', run)[1].decode('utf-8', 'replace')) for w in wants}
    links = {}
    for w, es in listing.items():
        for e in es:
            if e['name'] in WATCH:
                st = debugfs(dev, f'stat {UNIT_DIR}/{w}/{e["name"]}', run)[1].decode('utf-8', 'replace')
                m = re.search(r'Fast link dest: "([^"]*)"', st)
                links[f'{w}/{e["name"]}'] = m.group(1) if m else None
    _, fstab = debugfs(dev, 'cat /etc/fstab', run)
    ptext = open(payload, 'rb').read()
    text = unit.decode('utf-8', 'replace')
    drops = [e['name'] for e in parse_ls_p(dropins.decode('utf-8', 'replace'))] if rc_d == 0 else []
    same = bool(unit) and hashlib.sha256(unit).hexdigest() == hashlib.sha256(ptext).hexdigest()
    return {'snapshotUnit': {'present': bool(unit.strip()), 'sha256': hashlib.sha256(unit).hexdigest() if unit else None,
                             'payloadSha256': hashlib.sha256(ptext).hexdigest(), 'identicalToPayload': same, 'dropIns': drops,
                             'guards': [l for l in text.splitlines() if l.startswith(('Condition', 'RequiresMountsFor', 'ExecStartPre', 'ExecStart='))]},
            'enabled': enabled_map(listing), 'wantsLinks': links, 'wantsDirs': sorted(wants),
            'fstabBaseMount': [l for l in fstab.decode('utf-8', 'replace').splitlines() if '/srv/enclave-base-holder' in l],
            'bootSnapshotSafe': same and not drops}


def main(argv=None, run=subprocess.run):
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default=os.path.expanduser('~/.local/state/enclave-rpc-production/manifest.json'))
    ap.add_argument('--payload-unit', default=DEFAULT_PAYLOAD)
    ap.add_argument('--timeout', type=int, default=60)
    a = ap.parse_args(argv)
    mnt = proc = None
    try:
        osd = json.load(open(a.manifest))['disks']['os']['path']
        for u in VM_UNITS:
            if (s := unit_active(u, run)) not in ('inactive', 'failed'):
                raise Refuse(f'{u} is {s}: inspect only the stopped VM')
        if (pids := open_by_others(osd)):
            raise Refuse(f'{osd} is open by pid(s) {pids}')
        st = os.stat(osd)
        with open(osd, 'rb') as f:
            prefix = hashlib.sha256(f.read(1 << 20)).hexdigest()
        mnt = tempfile.mkdtemp(prefix='rpc-os-inspect-'); os.chmod(mnt, 0o700)
        raw, pidfile = os.path.join(mnt, 'os.raw'), mnt + '.pid'
        proc = subprocess.Popen(['nbdfuse', '-r', '-P', pidfile, raw, '[', 'qemu-nbd', '-r', '-f', 'qcow2', osd, ']'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + a.timeout
        while not (os.path.exists(raw) and os.path.getsize(raw) > 0):
            if time.monotonic() > deadline or (proc.poll() not in (None, 0)):
                raise Refuse(f'nbdfuse did not expose the image: {proc.stderr.read().decode()[-300:] if proc.poll() is not None else "timeout"}')
            time.sleep(0.2)
        off, part = root_offset(raw)
        body = inspect(f'{raw}?offset={off}', a.payload_unit, run)
        rec = {'format': 'enclave-rpc-os-disk-inspection/r1', 'osDisk': osd, 'osDiskSize': st.st_size, 'osDiskMtimeNs': st.st_mtime_ns,
               'osDiskIno': st.st_ino, 'osDiskSha256Prefix': prefix, 'rootPartition': part, 'rootOffset': off, **body,
               'note': 'read-only; the snapshot-complete marker is on the base disk (not read); verify it in the guest before any holder start'}
        print(json.dumps(rec, indent=1, sort_keys=True)); return 0
    except (Refuse, OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(json.dumps({'refused': str(e)})); return 2
    finally:
        if mnt:
            subprocess.run(['fusermount3', '-u', mnt], capture_output=True, timeout=30)
            if proc is not None:
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
            try:
                os.rmdir(mnt)
            except OSError:
                pass
            if os.path.exists(mnt + '.pid'):
                os.unlink(mnt + '.pid')


if __name__ == '__main__':
    sys.exit(main())
