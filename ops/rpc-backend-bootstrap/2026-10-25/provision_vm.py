#!/usr/bin/env python3
"""Enclave RPC backend VM: one persistent local QEMU/KVM guest (Ubuntu noble cloud image) that will host the L1 pair
(reth v2.8.0 + Lighthouse v8.3.2) and the Base holder (base v1.5.1) on ext4 filesystems inside NEW qcow2 images
on the local HDD (/mnt/usb, ntfs3) for v1 manifests. Public chain data only, no confidential compute. v1 used no NVMe; the
former 250 GB NVMe cap no longer applies (2026-10-25 user override; see v2 below).

Commands (python3 -I provision_vm.py <cmd>):
  plan                      read-only: every host check + the exact layout and QEMU argv; creates nothing
  prepare                   creates files ONLY (state dir, SSH key, seed ISO, 3 disk images, manifest, user unit).
                            Never runs systemctl, never starts QEMU. Refuses if anything already exists.
  verify                    read-only: re-render every file from the manifest and compare; check images and seed ISO
  pin-host-key              after first boot: read the guest's ed25519 host key from the local serial console log
                            (requires the guest's ENCLAVE-RPC-DISKS: READY line) and write known_hosts (0600, once)
  stage-plan                after SSH is pinned: verify the pinned binaries/packages on the host and print the
                            reviewed copy commands (prints only; runs nothing)
  launch MANIFEST SHA256    unit ExecStart: re-check the host, then exec QEMU (never run by hand)
  powerdown MANIFEST        unit ExecStop: ACPI powerdown over QMP and wait for the guest to halt
  guard MANIFEST SHA256     v2 only, guard unit ExecStart: bounded thin-provisioning guard (never run by hand)
  resume-for-shutdown MANIFEST
                            v2 only, operator: after the guard paused the VM at its pause threshold, resume it ONLY to
                            ACPI-power it down; the guard then pauses again only at the hard floor

v2 manifests (2026-10-25 user override: NVMe chain STORAGE authorized, the former 250 GB NVMe cap removed) are written
only by the reviewed migration adapter, never by prepare. They pin an explicit backing policy per disk (mount, fs UUID,
source, leaf disk model + rotational) checked at every launch. 'bounded' backings (NVMe) are thin provisioned: launch
needs free >= floor + pause margin + shutdown margin + start headroom, and the guard unit (Requires/BindsTo of the VM
unit) pauses ONLY this VM over its own QMP monitor before the floor, after first asking for an ACPI powerdown. v1
manifests render and behave exactly as before.

Operator sequence (root reviews first):
  plan -> prepare -> verify -> systemctl --user daemon-reload -> systemctl --user start enclave-rpc-production-vm
  -> pin-host-key -> ssh -F <state>/ssh_config enclave-rpc -> stage-plan -> root: configs, JWT, checkpoint/snapshot,
  consumer switch.
Safe shutdown: systemctl --user stop enclave-rpc-production-vm   (ACPI powerdown, waits up to 38 min, disks kept)
Rollback: stop the unit (and `systemctl --user disable` it if root enabled it); root reverts consumers. Disks, state
  dir and manifest are kept; nothing is deleted by this script after a successful prepare.
Host reboot: stop the unit FIRST. user@.service's own stop timeout is shorter than a clean chain-client shutdown.
"""
import datetime
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path

FORMAT = 'enclave-rpc-backend-vm/v1'
FORMAT_V2 = 'enclave-rpc-backend-vm/v2'
NAME = 'enclave-rpc-production'
UNIT = 'enclave-rpc-production-vm.service'
GUARD_UNIT = 'enclave-rpc-production-guard.service'
HOME = Path(os.path.expanduser('~'))
STATE_DIR = HOME / '.local/state' / NAME            # POSIX fs: the 0600 key cannot live on ntfs3 (fmask=0022)
UNIT_PATH = HOME / '.config/systemd/user' / UNIT
UNIT_DIRS = [HOME / '.config/systemd/user', HOME / '.local/share/systemd/user', Path('/etc/systemd/user'),
             Path('/usr/lib/systemd/user')]
HDD_MOUNT = '/mnt/usb'
HDD_FSTYPE = 'ntfs3'
HDD_DIR = HDD_MOUNT + '/' + NAME
WORK = Path(__file__).resolve().parents[1]           # .../wo/work when run from the reviewed tree
BASE_IMAGE = WORK / 'storage-vm/image/noble-server-cloudimg-amd64.img'
BASE_IMAGE_SHA256 = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'

GIB = 1 << 30
GUEST_MEM = 64 * GIB
MEMORY_MAX = GUEST_MEM + 2 * GIB                    # guest RAM + QEMU overhead/page cache; MemorySwapMax=0
HOST_RESERVE = 16 * GIB                             # preserve the existing guestd/test host memory floor
VCPUS = 8
OS_BYTES = 32 * GIB
L1_BYTES = 4_000_000_000_000
BASE_BYTES = 3_100_000_000_000
HDD_FREE_MARGIN = 500_000_000_000
NVME_CAP = 250_000_000_000                          # v1 plan output only (historical; removed for v2 on 2026-10-25)

GUEST_IP = '10.0.2.15'
GUEST_ADMIN = 'rpcadmin'
SSH_PORT = 22850
# host 127.0.0.1:port -> QEMU hostfwd -> guest 10.0.2.15:port -> socket proxy -> guest 127.0.0.1:target.
# The pinned renders bind 127.0.0.1 inside the guest (hostfwd cannot reach guest loopback), and preflight's
# port_in_use() matches any address, so the proxy ports differ from the service ports.
FORWARDS = [
    {'name': 'base-rpc', 'port': 28545, 'target': 18545},  # holder rpc.port
    {'name': 'l1-el', 'port': 28645, 'target': 18645},     # l1pair execution.httpPort
    {'name': 'l1-cl', 'port': 25052, 'target': 15052},     # l1pair consensus.httpPort
]
DISK_ROLES = [
    {'role': 'l1', 'bytes': L1_BYTES, 'file': 'l1-origin.qcow2', 'label': 'enc-l1-origin', 'mount': '/srv/enclave-l1-pair',
     'units': ['enclave-l1-el.service', 'enclave-l1-cl.service']},
    {'role': 'base', 'bytes': BASE_BYTES, 'file': 'base-origin.qcow2', 'label': 'enc-base-origin',
     'mount': '/srv/enclave-base-holder', 'units': ['enclave-base-holder.service']},
]

# binary pins: work/rpc-hdd-client-recovery-20261023/{p/l1pair/PINS.json, s/holder/BINARY.json}
PINSET = WORK / 'rpc-hdd-client-recovery-20261023'
STAGE_BINARIES = [
    {'src': 'rpc-l1-source-package/bin/reth-v2.8.0', 'dst': '/opt/enclave-l1-pair/bin/reth',
     'sha256': '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250'},
    {'src': 'rpc-l1-source-package/bin-staging/lighthouse-v8.3.2/lighthouse', 'dst': '/opt/enclave-l1-pair/bin/lighthouse',
     'sha256': '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'},
    {'src': 'fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base', 'dst': '/opt/enclave-base-holder/bin/base',
     'sha256': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'},
]
L1PAIR_FILES = ['l1pair.py', 'PINS.json', 'l1pair.example.json', 'RUNBOOK.md', 'vendor/VENDOR.json'] + [
    'vendor/holder/' + f for f in ('holder.py', 'budget.py', 'storage_nbd.py', 'BINARY.json', 'FLAGS.json',
                                   'holder-storage.sh.in', 'holder.example.json', 'RUNBOOK-CACHE.md')]
HOLDER_FILES = ['holder.py', 'budget.py', 'storage_nbd.py', 'BINARY.json', 'FLAGS.json', 'holder-storage.sh.in',
                'holder.example.json', 'RUNBOOK-CACHE.md']


class Refuse(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text):
    return hashlib.sha256(text.encode()).hexdigest()


def canonical(obj):
    return json.dumps(obj, indent=1, sort_keys=True) + '\n'


def run(argv, **kw):
    r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=kw.pop('timeout', 3600), **kw)
    if r.returncode != 0:
        refuse(f'{argv[0]} exited {r.returncode}: {r.stderr.strip()[-400:]}')
    return r.stdout


# ---- host checks (read-only) ------------------------------------------------------------------------------------------
def mount_entry(target):
    for line in open('/proc/self/mountinfo'):
        left, right = line.rstrip('\n').split(' - ', 1)
        f, g = left.split(), right.split()
        if f[4] == target:
            return {'majmin': f[2], 'opts': f[5].split(','), 'fstype': g[0], 'source': g[1], 'superOpts': g[2].split(',')}
    return None


def whole_disk(dev_name):
    p = Path('/sys/class/block') / dev_name
    if not p.exists():
        refuse(f'/sys/class/block/{dev_name} missing')
    return p.resolve().parent.name if (p / 'partition').exists() else dev_name


def check_hdd(need_dir_absent=True):
    m = mount_entry(HDD_MOUNT)
    if m is None:
        refuse(f'{HDD_MOUNT} is not mounted: the HDD is required, a bare directory on the OS disk is never used')
    if m['fstype'] != HDD_FSTYPE or 'rw' not in m['opts'] or 'rw' not in m['superOpts']:
        refuse(f"{HDD_MOUNT} is {m['fstype']} {m['opts']}, not a read-write {HDD_FSTYPE} mount")
    if not m['source'].startswith('/dev/'):
        refuse(f"{HDD_MOUNT} source {m['source']} is not a block device")
    disk = whole_disk(os.path.basename(os.path.realpath(m['source'])))
    rot = Path(f'/sys/block/{disk}/queue/rotational').read_text().strip()
    if rot != '1':
        refuse(f'{HDD_MOUNT} sits on {disk} with rotational={rot}: chain data must be on the HDD, never NVMe')
    if need_dir_absent and os.path.lexists(HDD_DIR):
        refuse(f'{HDD_DIR} already exists: existing files are never reused or overwritten')
    vfs = os.statvfs(HDD_MOUNT)
    free = vfs.f_bavail * vfs.f_frsize
    return {'mount': HDD_MOUNT, 'fstype': m['fstype'], 'source': m['source'], 'disk': disk, 'rotational': True,
            'superOpts': m['superOpts'], 'freeBytes': free}


def mem_available():
    for line in open('/proc/meminfo'):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) * 1024
    refuse('MemAvailable missing from /proc/meminfo')


def check_memory():
    avail, need = mem_available(), MEMORY_MAX + HOST_RESERVE
    if avail < need:
        refuse(f'MemAvailable {avail} < VM MemoryMax {MEMORY_MAX} + host reserve {HOST_RESERVE} = {need} '
               '(existing VMs/services keep their memory)')
    return avail


def tcp_listening(port):
    for path in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            rows = open(path).read().splitlines()[1:]
        except OSError:
            continue
        for r in rows:
            p = r.split()
            if p[3] == '0A' and int(p[1].rsplit(':', 1)[1], 16) == port:
                return True
    return False


def check_ports():
    busy = [p for p in [SSH_PORT] + [f['port'] for f in FORWARDS] if tcp_listening(p)]
    if busy:
        refuse(f'host TCP ports already listening: {busy}')


def check_kvm():
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        refuse('/dev/kvm is not read-write for this user')


def check_tools():
    for t in ('/usr/bin/qemu-system-x86_64', '/usr/bin/qemu-img', '/usr/bin/xorriso', '/usr/bin/ssh-keygen'):
        if not os.access(t, os.X_OK):
            refuse(f'{t} is not executable')


def check_new_paths():
    if os.path.lexists(STATE_DIR):
        refuse(f'{STATE_DIR} already exists')
    for d in UNIT_DIRS:
        if os.path.lexists(d / UNIT):
            refuse(f'{d / UNIT} already exists: an existing unit is never replaced')
    for p in (STATE_DIR, Path(__file__).resolve()):
        if re.search(r'[\s%$\\"\']', str(p)):
            refuse(f'{p} contains characters that need unit-file quoting')
    st = os.statvfs(STATE_DIR.parent if STATE_DIR.parent.exists() else HOME)
    if st.f_bavail * st.f_frsize < 2 * GIB:
        refuse('less than 2 GiB free for the small state dir')


def check_base_image():
    if sha256_file(BASE_IMAGE) != BASE_IMAGE_SHA256:
        refuse(f'{BASE_IMAGE} sha256 differs from the pinned {BASE_IMAGE_SHA256}')
    info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', '-U', str(BASE_IMAGE)]))
    if info.get('format') != 'qcow2' or 'backing-filename' in info or info.get('virtual-size', 0) > OS_BYTES:
        refuse(f'{BASE_IMAGE} must be a standalone qcow2 no larger than {OS_BYTES}')


def host_checks(need_new=True):
    check_kvm()
    check_tools()
    hdd = check_hdd(need_dir_absent=need_new)
    total = OS_BYTES + L1_BYTES + BASE_BYTES
    if hdd['freeBytes'] < total + HDD_FREE_MARGIN:
        refuse(f"{HDD_MOUNT} free {hdd['freeBytes']} < images {total} + margin {HDD_FREE_MARGIN} (sparse images must "
               'be able to grow to full size)')
    avail = check_memory()
    check_ports()
    if need_new:
        check_new_paths()
    if os.cpu_count() < VCPUS + 2:
        refuse(f'{os.cpu_count()} host CPUs < {VCPUS} vCPUs + 2 for the host')
    return {'hdd': hdd, 'memAvailable': avail}


# ---- rendering (pure functions of the manifest) -----------------------------------------------------------------------
def paths(uid):
    run_dir = f'/run/user/{uid}/{NAME}'
    return {'stateDir': str(STATE_DIR), 'hddDir': HDD_DIR, 'unitPath': str(UNIT_PATH), 'runtimeDir': run_dir,
            'qmp': run_dir + '/qmp.sock', 'console': run_dir + '/console.sock', 'consoleLog': str(STATE_DIR / 'console.log'),
            'key': str(STATE_DIR / 'id_ed25519'), 'knownHosts': str(STATE_DIR / 'known_hosts'),
            'sshConfig': str(STATE_DIR / 'ssh_config'), 'seedDir': str(STATE_DIR / 'seed'), 'seedIso': str(STATE_DIR / 'seed.iso'),
            'manifest': str(STATE_DIR / 'manifest.json'), 'launcher': str(STATE_DIR / 'provision_vm.py'),
            'osDisk': HDD_DIR + '/os.qcow2'}


def blockdev(node, driver, filename, read_only=False, discard='ignore'):
    d = {'driver': driver, 'node-name': node, 'read-only': read_only, 'discard': discard, 'detect-zeroes': 'off',
         'cache': {'direct': False, 'no-flush': False},
         'file': {'driver': 'file', 'filename': filename, 'locking': 'on', 'aio': 'threads'}}
    return json.dumps(d, sort_keys=True, separators=(',', ':'))


def qemu_argv(m):
    p, d = m['paths'], m['disks']
    fwd = ''.join(f",hostfwd=tcp:127.0.0.1:{f['port']}-{GUEST_IP}:{f['port']}" for f in FORWARDS)
    a = ['/usr/bin/qemu-system-x86_64', '-name', f'{NAME},debug-threads=on', '-nodefaults', '-no-user-config',
         '-object', f'memory-backend-ram,id=rpcmem,size={GUEST_MEM},prealloc=on',
         '-machine', 'q35,accel=kvm,memory-backend=rpcmem', '-cpu', 'host', '-smp', f'{VCPUS},sockets=1,cores={VCPUS},threads=1',
         '-m', f'{GUEST_MEM >> 20}M', '-overcommit', 'mem-lock=off', '-rtc', 'base=utc', '-display', 'none',
         '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny', '-msg', 'timestamp=on',
         '-chardev', f"socket,id=con0,path={p['console']},server=on,wait=off,logfile={p['consoleLog']},logappend=on",
         '-serial', 'chardev:con0',
         '-qmp', f"unix:{p['qmp']},server=on,wait=off"]
    if is_v2(m):
        # a second QMP monitor owned by the guard unit, so the guard never competes with powerdown/operators
        a += ['-chardev', f"socket,id=qmpg,path={p['guardQmp']},server=on,wait=off", '-mon', 'chardev=qmpg,mode=control']
    a += ['-object', 'rng-random,id=rng0,filename=/dev/urandom', '-device', 'virtio-rng-pci,rng=rng0',
          '-device', 'virtio-scsi-pci,id=scsi0',
          '-blockdev', blockdev('os0', 'qcow2', d['os']['path'], discard=disk_discard(m, d['os'])),
          '-device', f"scsi-hd,bus=scsi0.0,drive=os0,serial={d['os']['serial']},bootindex=0,werror=stop,rerror=stop"]
    for r in DISK_ROLES:
        x = d[r['role']]
        # v1: rotation_rate=7200 because the host verified at prepare/launch that the backing disk is rotational.
        # v2: the backing policy's guestRotationRate (7200 HDD, 1 NVMe), verified against the leaf disks at launch.
        rate = m['backings'][x['backing']]['guestRotationRate'] if is_v2(m) else 7200
        a += ['-blockdev', blockdev(r['role'] + '0', 'qcow2', x['path'], discard=disk_discard(m, x)),
              '-device', f"scsi-hd,bus=scsi0.0,drive={r['role']}0,serial={x['serial']},rotation_rate={rate},werror=stop,rerror=stop"]
    a += ['-blockdev', blockdev('seed0', 'raw', p['seedIso'], read_only=True),
          '-device', 'scsi-cd,bus=scsi0.0,drive=seed0',
          '-netdev', f'user,id=net0,ipv6=off,net=10.0.2.0/24,host=10.0.2.2,dhcpstart={GUEST_IP},dns=10.0.2.3,'
                     f'hostfwd=tcp:127.0.0.1:{SSH_PORT}-{GUEST_IP}:22{fwd}',
          '-device', f"virtio-net-pci,netdev=net0,mac={m['mac']}"]
    return a


GUEST_DISKS_PY = r'''#!/usr/bin/python3 -I
# Formats ONLY the serial-pinned new virtual disks in the config, and only after verifying each is blank.
# Every disk is verified before any is formatted. A disk that already holds the expected ext4 (UUID + label) is
# adopted; any other signature is refused. Never uses mkfs -F, never touches the OS disk.
import json, os, subprocess, sys
CFG = json.load(open(sys.argv[1]))
STATE = '/var/lib/enclave-rpc-vm'

def say(msg):
    line = 'ENCLAVE-RPC-DISKS: ' + msg
    print(line, flush=True)
    try:
        with open('/dev/console', 'w') as c:
            c.write(line + '\n')
    except OSError:
        pass

def die(msg):
    say('FAILED ' + msg)
    sys.exit(1)

def run(argv, ok=(0,)):
    r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if r.returncode not in ok:
        die(f'{argv[0]} exit {r.returncode}: {r.stderr.strip()[-300:]}')
    return r

def vpd_serial(dev):
    try:
        b = open(f'/sys/block/{dev}/device/vpd_pg80', 'rb').read()
    except OSError:
        return None
    if len(b) < 4 or b[1] != 0x80:
        return None
    return b[4:4 + int.from_bytes(b[2:4], 'big')].decode('ascii', 'replace').strip(' \x00')

def signature(path):
    r = run(['blkid', '-p', '-o', 'export', path], ok=(0, 2))
    if r.returncode == 2:
        return None
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)

def zeros(b):
    return b.count(0) == len(b)

def check(d):
    hits = [x for x in sorted(os.listdir('/sys/block')) if x.startswith('sd') and vpd_serial(x) == d['serial']]
    if len(hits) != 1:
        die(f"serial {d['serial']}: expected exactly one disk, found {hits}")
    dev = hits[0]
    path, sysd = '/dev/' + dev, f'/sys/block/{dev}'
    if open(sysd + '/device/model').read().strip() != 'QEMU HARDDISK':
        die(f'{path} is not a QEMU virtual disk')
    size = int(open(sysd + '/size').read()) * 512
    if size != d['bytes']:
        die(f"{path} is {size} bytes, not {d['bytes']}")
    if [p for p in os.listdir(sysd) if p.startswith(dev)] or os.listdir(sysd + '/holders'):
        die(f'{path} has partitions or holders')
    majmin = open(sysd + '/dev').read().strip()
    if majmin in {l.split()[2] for l in open('/proc/self/mountinfo')}:
        die(f'{path} is mounted')
    sig = signature(path)
    if sig is None:
        if run(['wipefs', '--no-act', '--noheadings', path]).stdout.strip():
            die(f'{path}: wipefs reports signatures')
        with open(path, 'rb') as f:
            head = f.read(1 << 20)
            f.seek(size - (1 << 20))
            tail = f.read(1 << 20)
        if not (zeros(head) and zeros(tail)):
            die(f'{path}: first/last MiB not zero, not a new disk')
        return 'blank', path
    if sig.get('TYPE') == 'ext4' and sig.get('UUID') == d['uuid'] and sig.get('LABEL') == d['label']:
        return 'ours', path
    die(f"{d['role']} disk {path} carries a foreign signature {sig}; it is never formatted")

def main():
    plan = [(d,) + check(d) for d in CFG['disks']]
    fstab = open('/etc/fstab').read()
    lines = fstab.splitlines()
    for d, state, path in plan:
        if state == 'blank':
            run(['mkfs.ext4', '-q', '-L', d['label'], '-U', d['uuid'], '-m', '1', '-T', 'largefile', '-E', 'nodiscard', path])
            sig = signature(path) or {}
            if (sig.get('TYPE'), sig.get('UUID'), sig.get('LABEL')) != ('ext4', d['uuid'], d['label']):
                die(f'{path}: mkfs result {sig} differs from the expected filesystem')
        want = f"UUID={d['uuid']} {d['mount']} ext4 noauto,noatime,errors=remount-ro,x-systemd.device-timeout=120s 0 2"
        have = [l for l in lines if l.split()[1:2] == [d['mount']] or d['uuid'] in l]
        if have and have != [want]:
            die(f"/etc/fstab already has a different entry for {d['mount']}: {have}")
        if not have:
            lines.append(want)
    if any('nofail' in l for l in lines if any(d['mount'] in l for d in CFG['disks'])):
        die('nofail is prohibited for chain data mounts')
    text = '\n'.join(lines) + '\n'
    if text != fstab:
        with open('/etc/fstab.enclave-rpc.tmp', 'w') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace('/etc/fstab.enclave-rpc.tmp', '/etc/fstab')
    run(['systemctl', 'daemon-reload'])
    out = []
    for d, state, path in plan:
        mnt = d['mount']
        if not os.path.ismount(mnt):
            os.makedirs(mnt, 0o755, exist_ok=True)
            run(['chattr', '+i', mnt])          # nothing can write into the bare mount point while unmounted
            run(['mount', mnt])
        got = run(['findmnt', '-n', '-o', 'UUID,FSTYPE', '--mountpoint', mnt]).stdout.split()
        if got != [d['uuid'], 'ext4']:
            die(f'{mnt} is mounted from {got}, not UUID {d["uuid"]}')
        out.append({'role': d['role'], 'device': path, 'serial': d['serial'], 'uuid': d['uuid'], 'mount': mnt, 'formatted': state == 'blank'})
    os.makedirs(STATE, 0o755, exist_ok=True)
    with open(STATE + '/disks.json', 'w') as f:
        json.dump(out, f, sort_keys=True)
    say('READY ' + json.dumps(out, sort_keys=True))

main()
'''


def guest_disk_config(m):
    return canonical({'disks': [{k: m['disks'][r['role']][k] for k in ('role', 'serial', 'bytes', 'uuid', 'label', 'mount')}
                                for r in DISK_ROLES]})


def proxy_units(f):
    sock = f"""[Unit]
Description=Enclave RPC forward {f['name']} (host 127.0.0.1:{f['port']} via QEMU hostfwd)

[Socket]
ListenStream={GUEST_IP}:{f['port']}
FreeBind=yes

[Install]
WantedBy=sockets.target
"""
    svc = f"""[Unit]
Description=Enclave RPC forward {f['name']} to guest loopback 127.0.0.1:{f['target']}
Requires=enclave-rpc-fwd-{f['name']}.socket
After=enclave-rpc-fwd-{f['name']}.socket

[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:{f['target']}
DynamicUser=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
"""
    return sock, svc


def chain_dropin(mount):
    # 10.0.2.2 is QEMU user-net's alias for the HOST loopback: chain clients never need it.
    return f"""[Unit]
RequiresMountsFor={mount}

[Service]
IPAddressDeny=10.0.2.2/32
"""


def render_user_data(m):
    wf = [
        {'path': '/etc/ssh/sshd_config.d/10-enclave-rpc.conf', 'permissions': '0644', 'owner': 'root:root',
         'content': f'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n'
                    f'AuthenticationMethods publickey\nAllowUsers {GUEST_ADMIN}\nAllowTcpForwarding no\n'
                    'AllowAgentForwarding no\nX11Forwarding no\n'},
        {'path': '/usr/local/sbin/enclave-rpc-disks', 'permissions': '0755', 'owner': 'root:root', 'content': GUEST_DISKS_PY},
        {'path': '/etc/enclave-rpc-vm/disks.json', 'permissions': '0644', 'owner': 'root:root', 'content': guest_disk_config(m)},
    ]
    for r in DISK_ROLES:
        for u in r['units']:
            wf.append({'path': f'/etc/systemd/system/{u}.d/50-enclave-rpc-vm.conf', 'permissions': '0644',
                       'owner': 'root:root', 'content': chain_dropin(r['mount'])})
    for f in FORWARDS:
        sock, svc = proxy_units(f)
        wf.append({'path': f"/etc/systemd/system/enclave-rpc-fwd-{f['name']}.socket", 'permissions': '0644',
                   'owner': 'root:root', 'content': sock})
        wf.append({'path': f"/etc/systemd/system/enclave-rpc-fwd-{f['name']}.service", 'permissions': '0644',
                   'owner': 'root:root', 'content': svc})
    cfg = {
        'hostname': 'enclave-rpc', 'manage_etc_hosts': True,
        'users': [{'name': GUEST_ADMIN, 'groups': ['adm', 'sudo'], 'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'shell': '/bin/bash',
                   'lock_passwd': True, 'ssh_authorized_keys': [m['sshPublicKey']]}],
        'disable_root': True, 'ssh_pwauth': False, 'ssh_deletekeys': True, 'ssh_genkeytypes': ['ed25519'],
        'package_update': False, 'package_upgrade': False,
        'write_files': wf,
        'runcmd': [['passwd', '-l', 'root'],
                   ['/usr/local/sbin/enclave-rpc-disks', '/etc/enclave-rpc-vm/disks.json'],
                   ['systemctl', 'daemon-reload'],
                   ['systemctl', 'enable', '--now'] + [f"enclave-rpc-fwd-{f['name']}.socket" for f in FORWARDS],
                   ['systemctl', 'try-reload-or-restart', 'ssh']],
    }
    return '#cloud-config\n' + json.dumps(cfg, indent=1, sort_keys=True) + '\n'   # JSON is valid YAML: no quoting traps


def render_meta_data(m):
    return f"instance-id: {m['instanceId']}\nlocal-hostname: enclave-rpc\n"


def render_network_config(m):
    return canonical({'version': 2, 'ethernets': {'nic0': {'match': {'macaddress': m['mac']}, 'dhcp4': True, 'dhcp6': False}}})


def render_ssh_config(m):
    p = m['paths']
    return f"""Host enclave-rpc
  HostName 127.0.0.1
  Port {SSH_PORT}
  User {GUEST_ADMIN}
  IdentityFile {p['key']}
  IdentitiesOnly yes
  UserKnownHostsFile {p['knownHosts']}
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  UpdateHostKeys no
  ForwardAgent no
  ForwardX11 no
  BatchMode yes
  ServerAliveInterval 30
"""


def render_unit(m, manifest_sha):
    p = m['paths']
    if is_v2(m):
        head = (f"# rendered by provision_vm.py ({FORMAT_V2}) from a migration-adapter manifest; never enabled or started "
                f"by a script.\n[Unit]\nDescription=Enclave RPC backend VM ({NAME}: reth+lighthouse L1, Base holder; "
                f"per-disk backing policy)\nRequires={GUARD_UNIT}\nBindsTo={GUARD_UNIT}\nAfter={GUARD_UNIT}\n")
    else:
        head = (f"# rendered by provision_vm.py ({FORMAT}). prepare never enables or starts this unit.\n[Unit]\n"
                f"Description=Enclave RPC backend VM ({NAME}: reth+lighthouse L1, Base holder; local HDD images)\n")
    return head + f"""StartLimitIntervalSec=3600
StartLimitBurst=3

[Service]
Type=simple
ExecStart=/usr/bin/python3 -I {p['launcher']} launch {p['manifest']} {manifest_sha}
ExecStop=/usr/bin/python3 -I {p['launcher']} powerdown {p['manifest']}
TimeoutStartSec=300
TimeoutStopSec=2400
KillMode=mixed
KillSignal=SIGTERM
Restart=on-failure
RestartSec=60
RuntimeDirectory={NAME}
RuntimeDirectoryMode=0700
MemoryMax={MEMORY_MAX}
MemorySwapMax=0
TasksMax=4096
LimitNOFILE=65536
NoNewPrivileges=yes
UMask=0077

[Install]
WantedBy=default.target
"""


def seed_files(m):
    return {'user-data': render_user_data(m), 'meta-data': render_meta_data(m), 'network-config': render_network_config(m)}


# ---- prepare ----------------------------------------------------------------------------------------------------------
class Created:
    """Everything this run created (path + inode), removed in reverse order only if prepare fails."""

    def __init__(self):
        self.items = []

    def add(self, path, is_dir=False):
        st = os.lstat(path)
        self.items.append((str(path), st.st_dev, st.st_ino, is_dir))

    def unwind(self):
        for path, dev, ino, is_dir in reversed(self.items):
            try:
                st = os.lstat(path)
                if (st.st_dev, st.st_ino) != (dev, ino):
                    continue
                if is_dir:
                    os.rmdir(path)        # only if empty: anything else stays for the operator
                else:
                    os.unlink(path)
            except OSError as e:
                print(f'unwind: left {path}: {e}', file=sys.stderr)


def write_new(path, text, mode, created):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    created.add(path)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(path, mode)


def set_ntfs_sparse(fd):
    """ntfs3 (mounted without `sparse`): mark the EMPTY new file sparse via its NTFS attribute xattr; otherwise writes
    past the valid-data length zero-fill the gap. Verified by the caller, never assumed."""
    cur = struct.unpack('<I', os.getxattr(fd, 'system.ntfs_attrib'))[0]
    os.setxattr(fd, 'system.ntfs_attrib', struct.pack('<I', cur | 0x200))
    if not struct.unpack('<I', os.getxattr(fd, 'system.ntfs_attrib'))[0] & 0x200:
        refuse('ntfs3 did not keep FILE_ATTRIBUTE_SPARSE_FILE')


def new_sparse(path, nbytes, created):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    created.add(path)
    try:
        set_ntfs_sparse(fd)
        os.ftruncate(fd, nbytes)
        os.fsync(fd)
        st = os.fstat(fd)
    finally:
        os.close(fd)
    if st.st_size != nbytes or st.st_blocks * 512 > (64 << 20):
        refuse(f'{path}: size {st.st_size}, allocated {st.st_blocks * 512}: not a sparse {nbytes}-byte image')
    if st.st_nlink != 1 or st.st_mode & 0o022:
        refuse(f'{path} must have one link and not be group/other writable')
    return st


def sparse_probe(created):
    """A 1 GiB sparse file with one 4 KiB write at its end must stay ~unallocated (no ntfs3 zero-fill)."""
    p = HDD_DIR + '/.sparse-probe'
    new_sparse(p, GIB, created)
    fd = os.open(p, os.O_RDWR | os.O_NOFOLLOW)
    try:
        os.pwrite(fd, b'\x01' * 4096, GIB - 4096)
        os.fsync(fd)
        st = os.fstat(fd)
        ok = os.pread(fd, 4096, 0) == bytes(4096) and os.pread(fd, 4096, GIB - 4096) == b'\x01' * 4096
    finally:
        os.close(fd)
    os.unlink(p)
    created.items = [i for i in created.items if i[0] != p]
    if not ok or st.st_blocks * 512 > (16 << 20):
        refuse(f'{HDD_MOUNT}: a write at the end of a sparse probe allocated {st.st_blocks * 512} bytes (ntfs3 zero-fill); '
               'root must enable sparse files (ntfs3 `sparse` mount option) before prepare')


def build_seed(m, created):
    p = m['paths']
    os.mkdir(p['seedDir'], 0o700)
    created.add(p['seedDir'], is_dir=True)
    files = seed_files(m)
    for n, t in files.items():
        write_new(f"{p['seedDir']}/{n}", t, 0o600, created)
    run(['/usr/bin/xorriso', '-as', 'mkisofs', '-quiet', '-V', 'cidata', '-J', '-r', '-o', p['seedIso'],
         'user-data', 'meta-data', 'network-config'], cwd=p['seedDir'])
    created.add(p['seedIso'])
    os.chmod(p['seedIso'], 0o600)
    verify_seed(m)


def verify_seed(m):
    p = m['paths']
    pvd = subprocess.run(['/usr/bin/xorriso', '-indev', p['seedIso'], '-pvd_info'], stdin=subprocess.DEVNULL,
                         capture_output=True, text=True, timeout=120)
    if not re.search(r'^Volume Id\s*:\s*cidata\s*$', pvd.stdout + pvd.stderr, re.M):
        refuse('seed ISO volume id is not cidata')
    tmp = Path(p['stateDir']) / f'.seed-check-{secrets.token_hex(4)}'
    os.mkdir(tmp, 0o700)
    try:
        for n, t in seed_files(m).items():
            run(['/usr/bin/xorriso', '-osirrox', 'on', '-indev', p['seedIso'], '-extract', '/' + n, str(tmp / n)])
            if sha256_file(tmp / n) != sha256_text(t):
                refuse(f'seed ISO {n} differs from the rendered file')
    finally:
        for f in tmp.iterdir():
            os.chmod(f, 0o600)
            f.unlink()
        tmp.rmdir()


def cmd_plan():
    checks = host_checks(need_new=True)
    m = skeleton(placeholder=True)
    print(canonical({'format': FORMAT + '-plan', 'checks': checks, 'layout': m, 'qemuArgv': qemu_argv(m),
                     'unit': {'path': str(UNIT_PATH), 'MemoryMax': MEMORY_MAX, 'enabled': False, 'started': False},
                     'nvme': {'cacheBytes': 0, 'capBytes': NVME_CAP}}), end='')


def skeleton(placeholder=False):
    gen = (lambda n: '<generated-at-prepare>') if placeholder else (lambda n: secrets.token_hex(n).upper())
    m = {'format': FORMAT, 'name': NAME, 'uid': os.getuid(), 'paths': paths(os.getuid()),
         'vm': {'guestMemBytes': GUEST_MEM, 'memoryMaxBytes': MEMORY_MAX, 'hostReserveBytes': HOST_RESERVE, 'vcpus': VCPUS},
         'ports': {'ssh': SSH_PORT, 'forwards': FORWARDS},
         'mac': '<generated-at-prepare>' if placeholder else '52:54:00:' + ':'.join(secrets.token_hex(1) for _ in range(3)),
         'instanceId': f'{NAME}-' + (gen(4).lower() if not placeholder else gen(4)),
         'baseImage': {'path': str(BASE_IMAGE), 'sha256': BASE_IMAGE_SHA256},
         'disks': {'os': {'path': HDD_DIR + '/os.qcow2', 'bytes': OS_BYTES, 'serial': 'ERPC-OS-' + gen(4), 'format': 'qcow2'}},
         'nvme': {'cacheBytes': 0, 'capBytes': NVME_CAP}}
    for r in DISK_ROLES:
        m['disks'][r['role']] = {'role': r['role'], 'path': f"{HDD_DIR}/{r['file']}", 'bytes': r['bytes'],
                                 'serial': f"ERPC-{r['role'].upper()}-" + gen(4), 'label': r['label'], 'mount': r['mount'],
                                 'uuid': '<generated-at-prepare>' if placeholder else str(uuid.uuid4()), 'format': 'qcow2'}
    return m


def cmd_prepare():
    checks = host_checks(need_new=True)
    check_base_image()
    created = Created()
    try:
        STATE_DIR.parent.mkdir(parents=True, exist_ok=True)
        os.mkdir(STATE_DIR, 0o700)
        created.add(STATE_DIR, is_dir=True)
        os.mkdir(HDD_DIR, 0o700)
        created.add(HDD_DIR, is_dir=True)
        if os.stat(HDD_DIR).st_dev != os.stat(HDD_MOUNT).st_dev:
            refuse(f'{HDD_DIR} is not on the {HDD_MOUNT} filesystem')
        # ntfs3 is mounted with prealloc: truncate allocates the entire raw file
        # despite FILE_ATTRIBUTE_SPARSE_FILE (measured by the failed bounded probe).
        # qcow2 maps virtual offsets to allocated clusters, avoiding multi-TB holes.
        m = skeleton()
        p = m['paths']
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', f'{NAME}-admin', '-f', p['key']])
        created.add(p['key'])
        created.add(p['key'] + '.pub')
        if stat.S_IMODE(os.stat(p['key']).st_mode) != 0o600:
            refuse('generated SSH private key is not 0600')
        pub = Path(p['key'] + '.pub').read_text().strip()
        if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+ \S+', pub):
            refuse('generated public key has an unexpected shape')
        m['sshPublicKey'] = pub
        m['sshKeyFingerprint'] = run(['/usr/bin/ssh-keygen', '-l', '-E', 'sha256', '-f', p['key'] + '.pub']).split()[1]
        build_seed(m, created)
        tmp = p['osDisk'] + '.tmp'
        run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'qcow2', '-o', 'compat=1.1', str(BASE_IMAGE), tmp])
        created.add(tmp)
        run(['/usr/bin/qemu-img', 'resize', '-f', 'qcow2', tmp, str(OS_BYTES)])
        info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', tmp]))
        if info.get('virtual-size') != OS_BYTES or 'backing-filename' in info or info.get('format') != 'qcow2':
            refuse('OS disk is not a standalone 32 GiB qcow2')
        os.link(tmp, p['osDisk'])          # exclusive: fails if the name exists
        created.add(p['osDisk'])
        os.unlink(tmp)
        created.items = [i for i in created.items if i[0] != tmp]
        m['disks']['os']['ino'] = os.stat(p['osDisk']).st_ino
        for r in DISK_ROLES:
            d = m['disks'][r['role']]
            run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', '-o',
                 'compat=1.1,preallocation=off,lazy_refcounts=off', d['path'], str(d['bytes'])])
            created.add(d['path'])
            st = os.stat(d['path'])
            if st.st_blocks * 512 > 64 * (1 << 20):
                refuse('new qcow2 unexpectedly allocated more than 64 MiB')
            d['ino'] = st.st_ino
        shutil.copyfile(__file__, p['launcher'], follow_symlinks=False)
        created.add(p['launcher'])
        os.chmod(p['launcher'], 0o500)
        write_new(p['sshConfig'], render_ssh_config(m), 0o600, created)
        m['files'] = {'launcher': sha256_file(p['launcher']), 'sshConfig': sha256_text(render_ssh_config(m)),
                      'seedIso': sha256_file(p['seedIso']), 'qemuArgv': sha256_text(canonical(qemu_argv(m))),
                      **{'seed/' + n: sha256_text(t) for n, t in seed_files(m).items()}}
        m['createdAt'] = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        m['hostAtPrepare'] = checks
        mtext = canonical(m)
        write_new(p['manifest'], mtext, 0o600, created)
        msha = sha256_text(mtext)
        UNIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        write_new(str(UNIT_PATH), render_unit(m, msha), 0o644, created)
    except BaseException:
        created.unwind()
        raise
    print(canonical({'prepared': True, 'manifest': p['manifest'], 'manifestSha256': msha, 'unit': str(UNIT_PATH),
                     'sshKeyFingerprint': m['sshKeyFingerprint'], 'disks': {k: v['path'] for k, v in m['disks'].items()},
                     'next': ['python3 -I provision_vm.py verify',
                              'systemctl --user daemon-reload',
                              f'systemctl --user start {UNIT}',
                              'python3 -I provision_vm.py pin-host-key',
                              f"ssh -F {p['sshConfig']} enclave-rpc"],
                     'stop': f'systemctl --user stop {UNIT}   # ACPI powerdown; disks kept'}), end='')


# ---- verify / launch / powerdown ----------------------------------------------------------------------------------------
def load_manifest(path, want_sha=None):
    text = Path(path).read_text()
    if want_sha and sha256_text(text) != want_sha:
        refuse('manifest differs from the sha256 pinned in the unit')
    m = json.loads(text)
    if m.get('format') not in (FORMAT, FORMAT_V2) or m.get('uid') != os.getuid():
        refuse('manifest format/uid mismatch')
    if is_v2(m):
        validate_v2(m)
    return m, sha256_text(text)


def check_images(m):
    for k, d in m['disks'].items():
        st = os.lstat(d['path'])
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_ino != d['ino'] or st.st_mode & 0o022:
            refuse(f"{d['path']} is not the regular, single-link, non-writable-by-others file created at prepare")
        info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', '-U', d['path']]))
        if info.get('format') != 'qcow2' or info.get('virtual-size') != d['bytes'] or 'backing-filename' in info:
            refuse(f"{d['path']} is not the expected standalone qcow2")
    if is_v2(m):
        return check_capacity(m)
    grow = sum(max(0, d['bytes'] - os.stat(d['path']).st_blocks * 512) for d in m['disks'].values())
    vfs = os.statvfs(HDD_MOUNT)
    if vfs.f_bavail * vfs.f_frsize < grow + 100_000_000_000:
        refuse(f'{HDD_MOUNT} cannot absorb the remaining sparse growth {grow} + 100 GB (ENOSPC would pause the VM)')


def cmd_verify():
    m, msha = load_manifest(paths(os.getuid())['manifest'])
    p = m['paths']
    if is_v2(m):
        for b in used_backings(m).values():
            check_backing(b)
        if Path(p['guardUnitPath']).read_text() != render_guard_unit(m, msha):
            refuse('guard unit file differs from its render')
    else:
        check_hdd(need_dir_absent=False)
    check_images(m)
    if sha256_file(p['launcher']) != m['files']['launcher']:
        refuse('installed launcher differs from the manifest')
    if Path(p['sshConfig']).read_text() != render_ssh_config(m):
        refuse('ssh_config differs from its render')
    for n, t in seed_files(m).items():
        if Path(p['seedDir'], n).read_text() != t:
            refuse(f'seed/{n} differs from its render')
    if sha256_file(p['seedIso']) != m['files']['seedIso']:
        refuse('seed ISO differs from the manifest')
    verify_seed(m)
    if Path(p['unitPath']).read_text() != render_unit(m, msha):
        refuse('unit file differs from its render')
    if stat.S_IMODE(os.stat(p['key']).st_mode) != 0o600:
        refuse('SSH private key is not 0600')
    if run(['/usr/bin/ssh-keygen', '-l', '-E', 'sha256', '-f', p['key'] + '.pub']).split()[1] != m['sshKeyFingerprint']:
        refuse('SSH public key differs from the manifest')
    if sha256_text(canonical(qemu_argv(m))) != m['files']['qemuArgv']:
        refuse('QEMU argv render differs from the manifest')
    print(canonical({'verified': True, 'manifestSha256': msha, 'qemuArgv': qemu_argv(m)}), end='')


def own_cgroup_limits():
    rel = [l for l in open('/proc/self/cgroup').read().splitlines() if l.startswith('0::')][0][3:]
    base = Path('/sys/fs/cgroup' + rel)
    return (base / 'memory.max').read_text().strip(), (base / 'memory.swap.max').read_text().strip()


def cmd_launch(manifest, want_sha):
    m, _ = load_manifest(manifest, want_sha)
    p = m['paths']
    if os.environ.get('RUNTIME_DIRECTORY') != p['runtimeDir']:
        refuse('launch runs only as the systemd user unit (RUNTIME_DIRECTORY mismatch)')
    if own_cgroup_limits() != (str(MEMORY_MAX), '0'):
        refuse(f'unit cgroup memory.max/swap.max are {own_cgroup_limits()}, not ({MEMORY_MAX}, 0): no uncapped VM')
    check_kvm()
    if is_v2(m):
        for b in used_backings(m).values():
            check_backing(b)
        check_guard_armed(m, want_sha)
    else:
        check_hdd(need_dir_absent=False)
    check_images(m)
    check_memory()
    check_ports()
    if sha256_file(p['seedIso']) != m['files']['seedIso']:
        refuse('seed ISO differs from the manifest')
    argv = qemu_argv(m)
    if sha256_text(canonical(argv)) != m['files']['qemuArgv']:
        refuse('QEMU argv differs from the manifest')
    print('launch: checks passed; exec ' + json.dumps(argv), flush=True)
    os.execv(argv[0], argv)


def cmd_powerdown(manifest, wait_s=2280):
    m, _ = load_manifest(manifest)
    path = m['paths']['qmp']
    if not os.path.exists(path):
        print('powerdown: no QMP socket, QEMU not running')
        return 0
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(10)
    try:
        s.connect(path)
    except (FileNotFoundError, ConnectionRefusedError):
        print('powerdown: stale QMP socket, QEMU not running')
        return 0
    except OSError as e:
        print(f'powerdown: QMP connect failed ({e}); systemd will SIGTERM QEMU')
        return 1
    f = s.makefile('rwb')

    def cmd(name):
        f.write(json.dumps({'execute': name}).encode() + b'\n')
        f.flush()
        while True:
            line = f.readline()
            if not line:
                return None
            msg = json.loads(line)
            if 'return' in msg or 'error' in msg:
                return msg

    try:                                        # bounded by the 10 s socket timeout: a QEMU that never greets (still
        if not f.readline():                    # preallocating, wedged) is a controlled failure, never a traceback
            raise OSError('QMP closed before greeting')
        cmd('qmp_capabilities')
        st = (cmd('query-status') or {}).get('return', {}).get('status')
    except (OSError, ValueError) as e:
        f.close()
        s.close()
        print(f'powerdown: QMP handshake failed ({e or type(e).__name__}); systemd will SIGTERM QEMU', flush=True)
        return 1
    if st != 'running':
        print(f'powerdown: VM status {st!r} (paused on I/O error?); cannot ACPI-shutdown, systemd will SIGTERM QEMU')
        return 1
    cmd('system_powerdown')
    print(f'powerdown: ACPI powerdown sent, waiting up to {wait_s}s for the guest to halt', flush=True)
    deadline = time.monotonic() + wait_s
    # v2: keep watching the bounded backings while the guest shuts down (the guard may be the reason we are stopping)
    bounded = {n: b for n, b in used_backings(m).items() if b['growth'] == 'bounded'} if is_v2(m) else {}
    s.settimeout(1 if bounded else 30)
    while time.monotonic() < deadline:
        try:
            if not s.recv(65536):
                print('powerdown: QEMU exited after guest shutdown')
                return 0
        except (socket.timeout, TimeoutError):
            pass
        if bounded:
            budget = guard_mode(m) == 'shutdown-budget'
            for n, b in sorted(bounded.items()):
                t = thresholds(b['capacity'])
                try:
                    free = fs_free(b['mount'])
                except OSError:
                    free = None
                if free is None or free <= (t['floor'] if budget else t['pause']):
                    cmd('stop')
                    print(f"powerdown: {b['mount']} free {free} at/below {'floor' if budget else 'pause threshold'} "
                          'during shutdown: VM PAUSED; systemd will SIGTERM QEMU (crash-consistent stop)', flush=True)
                    return 1
    print('powerdown: guest did not halt in time; systemd will SIGTERM QEMU')
    return 1


# ---- v2: per-disk backing policies + bounded thin provisioning ----------------------------------------------------------
# A 4 TB virtual L1 cannot be guaranteed full growth on the NVMe, so a 'bounded' backing makes NO full-growth claim:
#   floor     never planned to be crossed (operator policy, not a user cap: >= 300 GB free stays for the host and
#             other apps)
#   pause     floor + pauseMarginBytes: the guard pauses the VM (QMP stop). The margin is the budget for ONE
#             operator `resume-for-shutdown` plus poll overshoot; it is NOT a guarantee that a guest shutdown fits.
#   shutdown  pause + shutdownMarginBytes, or earlier when the measured 60 s growth rate would reach `pause` within
#             shutdownLeadSeconds: the guard asks for an ACPI powerdown and keeps watching.
#   start     shutdown + startHeadroomBytes: launch and the guard's own start refuse below this.
# Errors fail closed: a failed identity/free-space check pauses the VM; if the guard cannot reach QEMU it exits 3 and the
# VM unit (BindsTo) is stopped through powerdown, which itself pauses at the threshold while waiting.
BACKING_KINDS = {'hdd': {'growth': 'full', 'rotational': True}, 'nvme': {'growth': 'bounded', 'rotational': False}}
CAPACITY_KEYS = ('floorBytes', 'pauseMarginBytes', 'shutdownMarginBytes', 'startHeadroomBytes', 'shutdownLeadSeconds',
                 'pollSeconds')
V2_PATHS = ('guardQmp', 'guardStatus', 'guardMode', 'guardUnitPath')


def is_v2(m):
    return m.get('format') == FORMAT_V2


def disk_discard(m, d):
    return m['backings'][d['backing']]['discard'] if is_v2(m) else 'ignore'


def used_backings(m):
    return {d['backing']: m['backings'][d['backing']] for d in m['disks'].values()}


def validate_v2(m):
    """Structural checks only (no host access): every disk names a known policy with complete, sane fields."""
    for k in V2_PATHS:
        if not isinstance(m['paths'].get(k), str):
            refuse(f'v2 manifest lacks paths.{k}')
    for name, b in m.get('backings', {}).items():
        kind = BACKING_KINDS.get(b.get('kind'))
        if kind is None or b.get('growth') != kind['growth'] or b.get('discard') not in ('ignore', 'unmap'):
            refuse(f'backing {name}: unknown kind/growth/discard')
        if b.get('guestRotationRate') != (7200 if kind['rotational'] else 1):
            refuse(f'backing {name}: guestRotationRate must match its kind')
        if not b.get('dir', '').startswith(b.get('mount', '//').rstrip('/') + '/') or not b.get('leafDisks'):
            refuse(f'backing {name}: dir must be inside its mount and leaf disks must be pinned')
        if kind['growth'] == 'bounded':
            c = b.get('capacity') or {}
            if any(not isinstance(c.get(k), int) or c[k] <= 0 for k in CAPACITY_KEYS):
                refuse(f'backing {name}: capacity needs positive integers {CAPACITY_KEYS}')
    for role, d in m['disks'].items():
        b = m.get('backings', {}).get(d.get('backing'))
        if b is None or not d['path'].startswith(b['dir'] + '/'):
            refuse(f'disk {role}: no backing policy, or its path is outside the policy dir')


def leaf_disks(dev_name):
    p = Path('/sys/class/block') / dev_name
    if not p.exists():
        refuse(f'/sys/class/block/{dev_name} missing')
    slaves = sorted(os.listdir(p / 'slaves')) if (p / 'slaves').is_dir() else []
    if slaves:
        return sorted({leaf for s in slaves for leaf in leaf_disks(s)})
    return [whole_disk(dev_name)]


def fs_uuid_of(source):
    real, d = os.path.realpath(source), Path('/dev/disk/by-uuid')
    hits = sorted(e.name for e in d.iterdir() if os.path.realpath(e) == real) if d.is_dir() else []
    return hits[0] if len(hits) == 1 else None


def describe_backing(mount):
    """Read-only identity of the filesystem mounted exactly at `mount`."""
    m = mount_entry(mount)
    if m is None:
        refuse(f'{mount} is not mounted')
    if not m['source'].startswith('/dev/'):
        refuse(f"{mount} source {m['source']} is not a block device")
    leaves = []
    for disk in leaf_disks(os.path.basename(os.path.realpath(m['source']))):
        q = Path('/sys/block') / disk
        model = (q / 'device/model').read_text().strip() if (q / 'device/model').exists() else ''
        leaves.append({'name': disk, 'model': model, 'rotational': (q / 'queue/rotational').read_text().strip() == '1'})
    return {'mount': mount, 'fstype': m['fstype'], 'source': m['source'], 'fsUuid': fs_uuid_of(m['source']),
            'leafDisks': leaves, 'rw': 'rw' in m['opts'] and 'rw' in m['superOpts']}


def fs_free(mount):
    v = os.statvfs(mount)
    return v.f_bavail * v.f_frsize


def check_backing(b):
    got = describe_backing(b['mount'])
    if not got['rw']:
        refuse(f"{b['mount']} is not mounted read-write")
    for k in ('fstype', 'fsUuid', 'leafDisks'):
        if got[k] != b[k]:
            refuse(f"{b['mount']} {k} is {got[k]!r}; the {b['kind']} policy pins {b[k]!r}")
    if os.path.realpath(got['source']) != os.path.realpath(b['source']):
        refuse(f"{b['mount']} is mounted from {got['source']}, the policy pins {b['source']}")
    if any(leaf['rotational'] != BACKING_KINDS[b['kind']]['rotational'] for leaf in got['leafDisks']):
        refuse(f"{b['mount']} leaf disks {got['leafDisks']} contradict kind {b['kind']}")
    try:
        st = os.lstat(b['dir'])
    except OSError as e:
        refuse(f"backing dir {b['dir']}: {e}")
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_dev != os.stat(b['mount']).st_dev:
        refuse(f"{b['dir']} is not a real directory of this user on the {b['mount']} filesystem")
    return dict(got, freeBytes=fs_free(b['mount']))


def thresholds(cap):
    pause = cap['floorBytes'] + cap['pauseMarginBytes']
    shutdown = pause + cap['shutdownMarginBytes']
    return {'floor': cap['floorBytes'], 'pause': pause, 'shutdown': shutdown, 'start': shutdown + cap['startHeadroomBytes']}


def check_capacity(m):
    out = {}
    for name, b in sorted(used_backings(m).items()):
        free = fs_free(b['mount'])
        if b['growth'] == 'full':      # the v1 HDD rule, now only over the disks that still live on this backing
            grow = sum(max(0, d['bytes'] - os.stat(d['path']).st_blocks * 512)
                       for d in m['disks'].values() if d['backing'] == name)
            if free < grow + 100_000_000_000:
                refuse(f"{b['mount']} cannot absorb the remaining sparse growth {grow} + 100 GB (ENOSPC would pause the VM)")
        else:
            t = thresholds(b['capacity'])
            if free < t['start']:
                refuse(f"{b['mount']} free {free} < start threshold {t['start']} (floor {t['floor']}, pause {t['pause']}, "
                       f"shutdown {t['shutdown']}): bounded thin provisioning refuses to start; free space first")
        out[name] = free
    return out


def guard_decide(free, rate, mode, t, lead_s):
    """Pure policy. free None = measurement failed -> pause (fail closed). rate = bytes/s consumed (>= 0)."""
    if free is None:
        return 'pause'
    if free <= (t['floor'] if mode == 'shutdown-budget' else t['pause']):
        return 'pause'
    if mode == 'shutdown-budget':
        return 'ok'                    # an operator-requested powerdown is already running under the hard floor
    if free <= t['shutdown'] or (rate > 0 and (free - t['pause']) / rate < lead_s):
        return 'shutdown'
    return 'ok'


def guard_mode(m):
    try:
        d = json.loads(Path(m['paths']['guardMode']).read_text())
    except (OSError, ValueError):
        return None
    return d.get('mode') if isinstance(d, dict) else None


def write_json_atomic(path, obj, mode=0o600):
    tmp = f'{path}.tmp-{os.getpid()}'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as f:
        f.write(canonical(obj))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# QMP reachability. Before the guard's FIRST successful monitor connection QEMU may still be preallocating guest RAM
# (64 GiB at ~400 MB/s ~ 160 s) and does not accept: the guard keeps polling storage and the watchdog, tries one fresh
# QMP_INITIAL_HANDSHAKE_S handshake per poll, and fails closed after QMP_INITIAL_GRACE_S, or at once when the capacity
# decision is not 'ok'. After a successful connection the runtime policy is unchanged (QMP_RECONNECT_GRACE_S, pause).
QMP_INITIAL_GRACE_S = 300
QMP_INITIAL_HANDSHAKE_S = 1
QMP_RECONNECT_GRACE_S = 60


class Qmp:
    def __init__(self, path, timeout=10, handshake_timeout=None):
        """handshake_timeout bounds connect + greeting + qmp_capabilities (default: timeout). Any failure closes the
        socket AND its makefile before raising: a leaked half-open connection stays in QEMU's monitor accept queue, and
        a few of them fill it (EAGAIN on every later connect)."""
        self.s, self.f = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM), None
        try:
            self.s.settimeout(timeout if handshake_timeout is None else handshake_timeout)
            self.s.connect(path)
            self.f = self.s.makefile('rwb')
            if not self.f.readline():
                raise OSError('QMP closed before greeting')
            self.cmd('qmp_capabilities')
            self.s.settimeout(timeout)
        except BaseException:
            self.close()
            raise

    def cmd(self, name, args=None):
        msg = {'execute': name}
        if args is not None:
            msg['arguments'] = args
        self.f.write(json.dumps(msg).encode() + b'\n')
        self.f.flush()
        while True:
            line = self.f.readline()
            if not line:
                raise OSError(f'QMP closed during {name}')
            try:
                r = json.loads(line)
            except ValueError:
                raise OSError(f'QMP sent a malformed reply during {name}') from None
            if 'return' in r:
                return r['return']
            if 'error' in r:
                raise OSError(f"QMP {name}: {r['error']}")

    def close(self):
        if self.f is not None:
            self.f.close()                     # the makefile holds a socket reference: close both or QEMU keeps
        self.s.close()                         # the (single-client) monitor connection open


def sd_notify(msg):
    addr = os.environ.get('NOTIFY_SOCKET')
    if not addr:
        return False
    addr = '\0' + addr[1:] if addr.startswith('@') else addr
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC) as s:
        s.connect(addr)
        s.sendall(msg.encode())
    return True


class GuardIO:
    """Real host effects for guard_loop; tests substitute every method."""

    def __init__(self, m):
        self.m = m

    def check(self, b):
        check_backing(b)

    def free(self, mount):
        return fs_free(mount)

    def qemu_present(self):
        return os.path.exists(self.m['paths']['guardQmp'])

    def qmp(self, handshake_timeout=None):
        return Qmp(self.m['paths']['guardQmp'], handshake_timeout=handshake_timeout)

    def mode(self):
        return guard_mode(self.m)

    def notify(self, msg):
        sd_notify(msg)

    def status(self, obj):
        write_json_atomic(self.m['paths']['guardStatus'], obj)

    def log(self, msg):
        print('ENCLAVE-RPC-GUARD: ' + msg, flush=True)

    now = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)


def guard_loop(m, msha, io, max_loops=None):
    """Returns the process exit code: 0 QEMU gone after being seen, 3 fail closed (cannot act on QEMU)."""
    bounded = {n: b for n, b in used_backings(m).items() if b['growth'] == 'bounded'}
    t = {n: thresholds(b['capacity']) for n, b in bounded.items()}
    poll = min([b['capacity']['pollSeconds'] for b in bounded.values()] or [5])
    lead = min([b['capacity']['shutdownLeadSeconds'] for b in bounded.values()] or [0])
    hist = {n: [] for n in bounded}
    q, seen, absent_since, shutdown_sent, loops, last = None, False, None, False, 0, None
    while max_loops is None or loops < max_loops:
        loops += 1
        now, decision, why, frees, rates = io.now(), 'ok', [], {}, {}
        try:
            for b in used_backings(m).values():
                io.check(b)
            mode = io.mode()
            for n, b in sorted(bounded.items()):
                free = io.free(b['mount'])
                h = hist[n]
                h.append((now, free))
                while len(h) > 1 and now - h[0][0] > 60:
                    h.pop(0)
                rate = max(0.0, (h[0][1] - free) / (now - h[0][0])) if now - h[0][0] >= 10 else 0.0
                frees[n], rates[n] = free, round(rate)
                d = guard_decide(free, rate, mode, t[n], lead)
                if d != 'ok':
                    why.append(f'{n} free {free} rate {round(rate)} B/s -> {d}')
                decision = max(decision, d, key=('ok', 'shutdown', 'pause').index)
        except Exception as e:                  # noqa: BLE001 - any measurement failure fails closed
            mode, decision = None, 'pause'
            why.append(f'check failed: {e}')
        present = io.qemu_present()
        if not present:
            q = None
            if seen:
                io.status({'state': 'stopped', 'manifestSha': msha, 'free': frees, 'reasons': why})
                io.log('QEMU gone; guard exits')
                return 0
        elif q is None:
            try:
                # before the first successful monitor: one fresh short handshake per poll (QEMU accepts the monitor
                # only after preallocating guest RAM); after it: the unchanged runtime reconnect
                q = io.qmp() if seen else io.qmp(QMP_INITIAL_HANDSHAKE_S)
                seen, absent_since = True, None
            except OSError as e:
                absent_since = absent_since if absent_since is not None else now
                if seen:
                    unsafe, grace = decision == 'pause', QMP_RECONNECT_GRACE_S
                else:                           # initial startup: never wait while capacity is not ok
                    unsafe, grace = decision != 'ok', QMP_INITIAL_GRACE_S
                if unsafe or now - absent_since > grace:
                    io.log(f'FAIL-CLOSED: cannot reach the guard QMP monitor ({e}); '
                           f"{'capacity ' + decision if unsafe else f'no monitor within {grace} s'}"
                           f"{'' if seen else ' (QEMU startup)'}; exiting so the VM unit stops")
                    return 3
        state = 'armed'
        if q is not None:
            try:
                st = q.cmd('query-status')['status']
                if decision == 'pause':
                    if st == 'running':
                        q.cmd('stop')
                        io.log('PAUSED VM: ' + '; '.join(why) + ' -- operator: free space and `cont`, or '
                               '`provision_vm.py resume-for-shutdown`; a paused VM cannot ACPI-shutdown')
                    state = 'paused'
                elif decision == 'shutdown':
                    if not shutdown_sent and st == 'running':
                        q.cmd('system_powerdown')
                        shutdown_sent = True
                        io.log('ACPI POWERDOWN requested: ' + '; '.join(why))
                    state = 'shutdown-requested'
            except OSError as e:
                q = None
                if not io.qemu_present():
                    continue
                io.log(f'FAIL-CLOSED: guard QMP failed ({e}); exiting so the VM unit stops')
                return 3
        cur = {'state': state, 'manifestSha': msha, 'free': frees, 'rateBytesPerS': rates, 'mode': mode,
               'reasons': why, 'thresholds': t, 'qemuSeen': seen, 'wallTime': time.time()}
        io.status(cur)
        if (state, tuple(why)) != last:
            io.notify(f'STATUS={state}: ' + ('; '.join(why) or 'within bounds'))
            last = (state, tuple(why))
        io.notify('WATCHDOG=1')
        io.sleep(poll)
    return None


def cmd_guard(manifest, want_sha):
    m, msha = load_manifest(manifest, want_sha)
    if not is_v2(m):
        refuse('the guard runs only for v2 manifests')
    try:
        os.unlink(m['paths']['guardMode'])     # a shutdown budget never survives a guard restart
    except FileNotFoundError:
        pass
    for b in used_backings(m).values():
        check_backing(b)
    check_capacity(m)
    io = GuardIO(m)
    io.status({'state': 'armed', 'manifestSha': msha, 'wallTime': time.time(), 'reasons': ['start admission passed']})
    sd_notify('READY=1')
    return guard_loop(m, msha, io)


def check_guard_armed(m, want_sha):
    try:
        st = json.loads(Path(m['paths']['guardStatus']).read_text())
    except (OSError, ValueError):
        refuse(f'{GUARD_UNIT} has not written its status: no unguarded start')
    if st.get('manifestSha') != want_sha or st.get('state') != 'armed' or time.time() - st.get('wallTime', 0) > 30:
        refuse(f'{GUARD_UNIT} status is not a fresh `armed` for this manifest: no unguarded start')


def cmd_resume_for_shutdown(manifest):
    m, msha = load_manifest(manifest)
    if not is_v2(m):
        refuse('resume-for-shutdown is v2 only')
    for b in used_backings(m).values():
        if b['growth'] == 'bounded' and fs_free(b['mount']) <= thresholds(b['capacity'])['floor']:
            refuse(f"{b['mount']} is at/below the hard floor: free space first (or stop QEMU: crash-consistent)")
    q = Qmp(m['paths']['qmp'])
    if q.cmd('query-status')['status'] != 'paused':
        refuse('VM is not paused')
    write_json_atomic(m['paths']['guardMode'], {'mode': 'shutdown-budget', 'manifestSha': msha,
                                                'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    q.cmd('cont')
    q.cmd('system_powerdown')
    q.close()
    print('resumed ONLY for ACPI powerdown; the guard now pauses again at the hard floor. Then: '
          f'systemctl --user stop {UNIT} (a paused VM is stopped by SIGTERM: crash-consistent)')


def render_guard_unit(m, manifest_sha):
    p = m['paths']
    return f"""# rendered by provision_vm.py ({FORMAT_V2}): bounded thin-provisioning guard for {UNIT}
[Unit]
Description=Enclave RPC VM capacity guard (pauses or powers down ONLY {UNIT} before its NVMe floor)
PartOf={UNIT}
StartLimitIntervalSec=3600
StartLimitBurst=3

[Service]
Type=notify
NotifyAccess=main
ExecStart=/usr/bin/python3 -I {p['launcher']} guard {p['manifest']} {manifest_sha}
WatchdogSec=30
TimeoutAbortSec=10
TimeoutStopSec=30
Restart=no
TimeoutStartSec=120
MemoryMax=256M
NoNewPrivileges=yes
UMask=0077
"""


# ---- after first boot ---------------------------------------------------------------------------------------------------
def cmd_pin_host_key():
    m, _ = load_manifest(paths(os.getuid())['manifest'])
    p = m['paths']
    if os.path.lexists(p['knownHosts']):
        refuse(f"{p['knownHosts']} already exists (pinned once)")
    log = Path(p['consoleLog']).read_text(errors='replace').replace('\r', '')
    if 'ENCLAVE-RPC-DISKS: FAILED' in log:
        refuse('guest disk setup FAILED (see console log); do not stage')
    if 'ENCLAVE-RPC-DISKS: READY' not in log:
        refuse('guest disk setup has not reported READY yet')
    keys = set()
    for block in re.findall(r'-----BEGIN SSH HOST KEY KEYS-----\n(.*?)-----END SSH HOST KEY KEYS-----', log, re.S):
        keys |= set(re.findall(r'^(ssh-ed25519 [A-Za-z0-9+/=]+)', block, re.M))
    if len(keys) != 1:
        refuse(f'expected exactly one guest ed25519 host key on the console, found {len(keys)}')
    fd = os.open(p['knownHosts'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(f'[127.0.0.1]:{SSH_PORT} {keys.pop()}\n')
    print(f"pinned guest host key; connect with: ssh -F {p['sshConfig']} enclave-rpc")


def cmd_stage_plan():
    m, _ = load_manifest(paths(os.getuid())['manifest'])
    p = m['paths']
    if not os.path.exists(p['knownHosts']):
        refuse('run pin-host-key first')
    pins = json.loads((PINSET / 'p/l1pair/PINS.json').read_text())
    binary = json.loads((PINSET / 's/holder/BINARY.json').read_text())
    if [pins['execution']['binarySha256'], pins['consensus']['binarySha256'], binary['binary']['sha256']] != \
            [b['sha256'] for b in STAGE_BINARIES]:
        refuse('script binary pins differ from PINS.json/BINARY.json')
    vendor = json.loads((PINSET / 'p/l1pair/vendor/VENDOR.json').read_text())['files']
    items = [dict(b, src=str(WORK / b['src']), mode='0755') for b in STAGE_BINARIES]
    for rel in L1PAIR_FILES:
        items.append({'src': str(PINSET / 'p/l1pair' / rel), 'dst': '/opt/enclave-l1-pair/' + rel, 'mode': '0644',
                      'sha256': vendor.get(rel[len('vendor/'):]) if rel.startswith('vendor/holder/') else None})
    for rel in HOLDER_FILES:
        items.append({'src': str(PINSET / 's/holder' / rel), 'dst': '/opt/enclave-base-holder/' + rel, 'mode': '0644', 'sha256': None})
    for it in items:
        got = sha256_file(it['src'])
        if it['sha256'] and got != it['sha256']:
            refuse(f"{it['src']} sha256 {got} differs from its pin {it['sha256']}")
        it['sha256'] = got
    ssh = f"ssh -F {p['sshConfig']} enclave-rpc"
    cmds = [f"{ssh} 'sudo install -d -m 0755 -o root -g root {os.path.dirname(it['dst'])} && "
            f"sudo sh -c \"umask 022; cat > {it['dst']}.stage\" && echo \"{it['sha256']}  {it['dst']}.stage\" | sha256sum -c - && "
            f"sudo chmod {it['mode']} {it['dst']}.stage && test ! -e {it['dst']} && sudo mv {it['dst']}.stage {it['dst']}' "
            f"< {it['src']}" for it in items]
    print(canonical({'stage': items, 'commands': cmds,
                     'note': 'prints only. Root then writes configs (storage cache none), the JWT, users, checkpoint '
                             'files and the Base snapshot inside the guest, and runs each package preflight there.'}), end='')


def main(argv):
    try:
        if argv[:1] == ['plan']:
            cmd_plan()
        elif argv[:1] == ['prepare']:
            cmd_prepare()
        elif argv[:1] == ['verify']:
            cmd_verify()
        elif argv[:1] == ['pin-host-key']:
            cmd_pin_host_key()
        elif argv[:1] == ['stage-plan']:
            cmd_stage_plan()
        elif argv[:1] == ['launch'] and len(argv) == 3:
            cmd_launch(argv[1], argv[2])
        elif argv[:1] == ['powerdown'] and len(argv) == 2:
            return cmd_powerdown(argv[1])
        elif argv[:1] == ['guard'] and len(argv) == 3:
            return cmd_guard(argv[1], argv[2])
        elif argv[:1] == ['resume-for-shutdown'] and len(argv) == 2:
            cmd_resume_for_shutdown(argv[1])
        else:
            print(__doc__, file=sys.stderr)
            return 64
    except Refuse as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
