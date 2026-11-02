"""Run the measured SEV-SNP RPC guest on this host until stopped.

python3 -I rpc/snp/launch.py CONFIG.json   (as the main process of its systemd unit)

CONFIG: {"image": DIR with IMAGE.json, "run": private run dir, "memoryMiB", "cpus",
         "disks": [{"path": qcow2, "serial": "RPC-l1"}...], "hostfwd": [[host, guest]...]}

The image artifacts are checked against IMAGE.json before launch; the kernel,
initrd and the cmdline carrying the verity root hash are what SEV-SNP measures
(kernel-hashes=on), so a changed artifact either refuses here or changes the
attested measurement. Chain disks are ordinary writable disks owned by this host.
SIGTERM requests an ACPI power-off through QMP and waits for the guest's own
clean client stop before the unit's TimeoutStopSec escalates.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

OVMF = '/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd'


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def qmp(path, command):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(5)
        s.connect(path)
        f = s.makefile('rw')
        f.readline()
        for cmd in ('qmp_capabilities', command):
            f.write(json.dumps({'execute': cmd})+'\n'); f.flush()
            f.readline()


def main(config_path):
    c = json.loads(Path(config_path).read_text())
    image, run = Path(c['image']), Path(c['run'])
    meta = json.loads((image/'IMAGE.json').read_text())
    for name, row in meta['artifacts'].items():
        if (image/name).stat().st_size != row['bytes'] or sha(image/name) != row['sha256']:
            raise ValueError('Image artifact differs from IMAGE.json: '+name)
    run.mkdir(mode=0o700, exist_ok=True)
    fwd = ','.join('hostfwd=tcp:127.0.0.1:%d-:%d' % (h, g) for h, g in c['hostfwd'])
    args = ['/usr/sbin/qemu-system-x86_64', '-name', 'enclave-rpc-snp',
            '-machine', 'q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0', '-cpu', 'EPYC-v4',
            '-smp', str(c['cpus']), '-m', str(c['memoryMiB']),
            '-object', 'memory-backend-memfd,id=ram0,size=%dM,share=true,prealloc=false' % c['memoryMiB'],
            '-object', 'sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=/dev/sev',
            '-bios', OVMF, '-kernel', str(image/'vmlinuz'), '-initrd', str(image/'initrd.img'), '-append', meta['cmdline'],
            '-nodefaults', '-no-reboot', '-display', 'none', '-monitor', 'none',
            '-serial', 'file:'+str(run/'console.log'), '-qmp', 'unix:'+str(run/'qmp.sock')+',server=on,wait=off',
            '-drive', 'file=%s,format=raw,if=none,id=rootd,readonly=on' % (image/'root.img'),
            '-device', 'virtio-blk-pci,drive=rootd,serial=ROOT-DATA',
            '-drive', 'file=%s,format=raw,if=none,id=rooth,readonly=on' % (image/'root.verity'),
            '-device', 'virtio-blk-pci,drive=rooth,serial=ROOT-HASH',
            '-netdev', 'user,id=net0'+(','+fwd if fwd else ''), '-device', 'virtio-net-pci,netdev=net0']
    binds = []
    for i, d in enumerate(c.get('disks', [])):
        # A dedicated I/O thread per chain disk: in the main loop, completions competed with
        # user-mode networking and saturated it (rpc-snp-prod-r4: main thread ~85% CPU, D state).
        args += ['-object', 'iothread,id=io%d' % i,
                 '-drive', 'file=%s,format=qcow2,if=none,id=d%d,cache=none,aio=native' % (d['path'], i),
                 '-device', 'virtio-blk-pci,drive=d%d,serial=%s,iothread=io%d,num-queues=4' % (i, d['serial'], i)]
        binds += ['--bind', str(Path(d['path']).parent), str(Path(d['path']).parent)]
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--ro-bind', '/', '/',
            '--bind', str(run), str(run), *binds, '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm',
            '--dev-bind', '/dev/sev', '/dev/sev', '--', *args]
    with (run/'launch.jsonl').open('a') as log:
        log.write(json.dumps({'event': 'launch', 'at': time.time(), 'measuredCmdline': meta['cmdline'],
                              'imageArtifacts': meta['artifacts'], 'disks': c.get('disks', [])})+'\n')
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL)
    stopping = []

    def stop(*_):
        if not stopping:
            stopping.append(time.time())
            try:
                qmp(str(run/'qmp.sock'), 'system_powerdown')
            except OSError:
                child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    code = child.wait()
    with (run/'launch.jsonl').open('a') as log:
        log.write(json.dumps({'event': 'exit', 'at': time.time(), 'code': code, 'requestedStop': bool(stopping)})+'\n')
    sys.exit(0 if stopping else code or 1)


if __name__ == '__main__':
    main(sys.argv[1])
