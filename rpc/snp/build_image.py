"""Build the measured SEV-SNP RPC guest image from the reviewed RPC guest OS.

python3 -I rpc/snp/build_image.py OUT_DIR

One ordinary (non-confidential) KVM build VM boots a private overlay of the
pinned public boot image once; cloud-init applies every root-only change and
powers off. Then, on the host and without root:

  root.img      the guest root filesystem (ext4), clean, read-only at runtime
  root.verity   dm-verity hash tree of root.img
  vmlinuz, initrd.img   the image's kernel and the initramfs rebuilt in the VM
  IMAGE.json    sha256 of every artifact, the verity root hash and the exact
                kernel cmdline that SEV-SNP measures together with kernel/initrd

The runtime configuration is the direct-guest seed's own files (identity, mounts,
client drop-ins), plus: SNP report modules, a verity local-top script, chain
clients and the attested front enabled at boot, longer clean-stop timeouts, a
tmpfs overlay for all runtime writes, and SSH and cloud-init disabled so the
measured image is the only code path into the guest.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PRIVATE_SEED = Path('/vm/enclave-volumes/rpc-linux-direct-856ca36204b44e39816d6894807c8c6d/direct-seed')
BOOT_VHDX = Path('/vm/enclave-volumes/rpc-linux-direct-856ca36204b44e39816d6894807c8c6d/boot.vhdx')
BOOT_SHA256 = 'a76940c926985b91590ab5916c7996c23d7812ccc2277fe8188bb21f11a0ae2c'
ROOT_START, BOOT_START, BOOT_SECTORS = 2099200, 227328, 1869825  # GPT layout of the pinned image


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def run(argv, **kw):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kw)


def seed_config(owner_pub):
    raw = (PRIVATE_SEED/'files/user-data').read_text()
    base = json.loads(raw.split('\n', 1)[1])
    writes = [w for w in base['write_files'] if not w['path'].startswith('/etc/ssh/')]

    def add(path, data, mode='0644'):
        writes.append({'path': path, 'owner': 'root:root', 'permissions': mode, 'encoding': 'b64',
                       'content': base64.b64encode(data).decode()})
    add('/opt/enclave-rpc/front.py', (HERE/'front.py').read_bytes(), '0755')
    add('/etc/initramfs-tools/hooks/enclave-verity', (HERE/'enclave-verity-hook').read_bytes(), '0755')
    add('/etc/initramfs-tools/scripts/local-top/enclave-verity', (HERE/'enclave-verity-local-top').read_bytes(), '0755')
    add('/etc/modules-load.d/enclave-snp.conf', b'tsm\nsev-guest\n')
    add('/etc/systemd/system/enclave-rpc-front.service', (
        b'[Unit]\nDescription=Attested RPC front (SEV-SNP report bound TLS)\n'
        b'After=systemd-modules-load.service network-online.target\nWants=network-online.target\n'
        b'[Service]\nType=exec\nExecStart=/usr/bin/python3 -I /opt/enclave-rpc/front.py 8443\n'
        b'Restart=on-failure\nRestartSec=5\nMemoryMax=512M\nNoNewPrivileges=yes\nProtectHome=yes\n'
        b'StandardOutput=journal+console\nStandardError=journal+console\n'
        b'[Install]\nWantedBy=multi-user.target\n'))
    for side, stop in (('el', 300), ('cl', 300), ('base', 300)):
        add('/etc/systemd/system/enclave-rpc-%s.service.d/stop.conf' % side,
            b'[Service]\nTimeoutStopSec=%d\n' % stop)
    script = '\n'.join([
        'set -eux',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get -q update',
        'apt-get -qy install linux-modules-extra-$(uname -r)',
        'apt-get clean',
        'update-initramfs -u -k all',
        'for u in enclave-rpc-el enclave-rpc-cl enclave-rpc-base; do ln -sf /etc/systemd/system/$u.service /etc/systemd/system/multi-user.target.wants/$u.service; done',
        'systemctl enable enclave-rpc-front.service',
        'systemctl disable ssh.service ssh.socket || true',
        'systemctl mask ssh.service ssh.socket',
        'touch /etc/cloud/cloud-init.disabled',
        'rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/log/cloud-init*.log /root/.bash_history',
        'cp /boot/initrd.img-$(uname -r) /boot/initrd.enclave',
        # Last: a read-only root fstab must not apply while this build VM still writes.
        'echo "LABEL=cloudimg-rootfs / ext4 ro 0 0" > /etc/fstab',
        'echo build-complete > /var/lib/enclave-rpc-image-build',
        'sync', 'fstrim -av || true', 'sync',
    ])
    add('/opt/enclave-rpc/build-image.sh', script.encode()+b'\n', '0700')
    cloud = {'users': [{'name': 'rpcbuild', 'groups': ['sudo'], 'shell': '/bin/bash', 'sudo': 'ALL=(ALL) NOPASSWD:ALL',
                        'lock_passwd': True, 'ssh_authorized_keys': [owner_pub]}],
             'ssh_pwauth': False, 'disable_root': True, 'package_update': False, 'package_upgrade': False,
             'growpart': {'mode': 'auto', 'devices': ['/']}, 'resize_rootfs': True,
             'write_files': writes,
             'runcmd': [['bash', '-c', '/opt/enclave-rpc/build-image.sh > /var/log/enclave-image-build.log 2>&1']],
             'power_state': {'mode': 'poweroff', 'condition': 'test -f /var/lib/enclave-rpc-image-build', 'timeout': 30}}
    return cloud


def main(out):
    out = Path(out)
    out.mkdir(mode=0o700)
    if sha(BOOT_VHDX) != BOOT_SHA256:
        raise ValueError('Pinned boot image changed')
    run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(out/'build-key')])
    seed = out/'seed'
    seed.mkdir(mode=0o700)
    (seed/'user-data').write_text('#cloud-config\n'+json.dumps(seed_config((out/'build-key.pub').read_text().strip()))+'\n')
    (seed/'meta-data').write_text('instance-id: rpc-snp-build-%d\nlocal-hostname: rpc-snp-build\n' % time.time_ns())
    run(['/usr/bin/xorriso', '-as', 'mkisofs', '-V', 'cidata', '-J', '-r', '-o', str(out/'seed.iso'),
         str(seed/'user-data'), str(seed/'meta-data')])
    run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'vhdx', '-b', str(BOOT_VHDX), str(out/'build.qcow2'), '6G'])
    args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user', '--ro-bind', '/', '/',
            '--bind', str(out), str(out), '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm', '--',
            '/usr/sbin/qemu-system-x86_64', '-name', 'rpc-snp-image-build', '-machine', 'q35,accel=kvm', '-cpu', 'host',
            '-smp', '4', '-m', '4096', '-nodefaults', '-no-reboot', '-display', 'none', '-monitor', 'none',
            '-serial', 'file:'+str(out/'build-console.log'),
            '-drive', 'file='+str(out/'build.qcow2')+',format=qcow2,if=none,id=os0,cache=none',
            '-device', 'virtio-blk-pci,drive=os0,bootindex=0',
            '-drive', 'file='+str(out/'seed.iso')+',format=raw,media=cdrom,readonly=on',
            '-netdev', 'user,id=net0', '-device', 'virtio-net-pci,netdev=net0']
    t = time.time()
    r = subprocess.run(args, capture_output=True, text=True, timeout=1500)
    console = (out/'build-console.log').read_text(errors='replace')
    if r.returncode != 0:
        raise RuntimeError('build VM failed: '+r.stderr[-800:])
    run(['/usr/bin/qemu-img', 'convert', '-O', 'raw', str(out/'build.qcow2'), str(out/'disk.raw')])
    layout = run(['/usr/bin/sfdisk', '-J', str(out/'disk.raw')]).stdout
    root = next(p for p in json.loads(layout)['partitiontable']['partitions'] if p['start'] == ROOT_START)
    run(['/usr/bin/dd', 'if='+str(out/'disk.raw'), 'of='+str(out/'root.img'), 'bs=512', 'skip=%d' % ROOT_START,
         'count=%d' % root['size'], 'status=none'])
    run(['/usr/bin/dd', 'if='+str(out/'disk.raw'), 'of='+str(out/'boot.img'), 'bs=512', 'skip=%d' % BOOT_START,
         'count=%d' % BOOT_SECTORS, 'status=none'])
    (out/'disk.raw').unlink()
    marker = run(['/usr/sbin/debugfs', '-R', 'cat /var/lib/enclave-rpc-image-build', str(out/'root.img')]).stdout.strip()
    if marker != 'build-complete':
        raise RuntimeError('in-VM build did not complete; see build-console.log')
    run(['/usr/sbin/e2fsck', '-fn', str(out/'root.img')])
    kernels = [l.split()[-1] for l in run(['/usr/sbin/debugfs', '-R', 'ls -l /', str(out/'boot.img')]).stdout.splitlines()
               if l.split() and l.split()[-1].startswith('vmlinuz-')]
    kernel = sorted(kernels)[-1]
    run(['/usr/sbin/debugfs', '-R', 'dump /%s %s' % (kernel, out/'vmlinuz'), str(out/'boot.img')])
    run(['/usr/sbin/debugfs', '-R', 'dump /initrd.enclave %s' % (out/'initrd.img'), str(out/'boot.img')])
    (out/'boot.img').unlink()
    v = run(['/usr/sbin/veritysetup', 'format', str(out/'root.img'), str(out/'root.verity')]).stdout
    roothash = [l.split(':', 1)[1].strip() for l in v.splitlines() if l.startswith('Root hash:')][0]
    cmdline = 'root=/dev/mapper/vroot ro enclave.roothash=%s overlayroot=tmpfs console=ttyS0 panic=-1' % roothash
    image = {'schema': 'enclave-rpc-snp-image/1', 'kernel': kernel, 'cmdline': cmdline, 'rootHash': roothash,
             'buildSeconds': round(time.time()-t), 'bootImageSha256': BOOT_SHA256,
             'artifacts': {n: {'bytes': (out/n).stat().st_size, 'sha256': sha(out/n)}
                           for n in ('vmlinuz', 'initrd.img', 'root.img', 'root.verity')},
             'sources': {n: sha(HERE/n) for n in ('front.py', 'enclave-verity-hook', 'enclave-verity-local-top', 'build_image.py')}}
    (out/'IMAGE.json').write_text(json.dumps(image, indent=1)+'\n')
    for p in (out/'build-key', out/'build.qcow2'):
        p.unlink()
    print(json.dumps(image))


if __name__ == '__main__':
    main(sys.argv[1])
