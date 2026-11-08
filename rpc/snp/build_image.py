"""Build the measured SEV-SNP RPC guest image from the reviewed RPC guest OS.

python3 -I rpc/snp/build_image.py OUT_DIR [COVERAGE_DIR]

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

COVERAGE_DIR (optional) activates Base: its receipt.json, verdict.json, origin.json
and snapshot-manifest.json become root-owned /etc/enclave-rpc/coverage/*, and
chain.json's baseBootstrap is replaced by COVERAGE_DIR/base-bootstrap.json. The
guest's chain service (coverage_activation) checks that this section pins those
exact bytes and that they bind this chain config, manifest and binaries.
An optional COVERAGE_DIR/blob-patch.json (the gate's --blob-patch, KZG-verified) adds
beacon-patch.py on 127.0.0.1:15053 and points the Base client's --l1-beacon at it.
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


COVERAGE_FILES = ('receipt.json', 'verdict.json', 'origin.json', 'snapshot-manifest.json')


# chain.json and manifest.json come from the pinned boot image, so the baseBootstrap swap runs in the build VM.
SET_BOOTSTRAP = (
    "import json,os; p='/etc/enclave-rpc/chain.json'; c=json.load(open(p)); "
    "c['baseBootstrap']=json.load(open('/etc/enclave-rpc/base-bootstrap.json')); "
    "open(p,'w').write(json.dumps(c,indent=1)+chr(10)); os.remove('/etc/enclave-rpc/base-bootstrap.json')")


BEACON_PATCH_SED = ("sed -i \"s|'--l1-beacon', 'http://127.0.0.1:15052'|'--l1-beacon', 'http://127.0.0.1:15053'|\" "
                    "/opt/enclave-rpc/chain_service.py")
# identity.py refuses to start the clients unless identity.json's runtimePins equal the
# shipped runtime files, so the image pins the chain_service.py it actually carries.
REPIN_IDENTITY = (
    "import json,hashlib; p='/etc/enclave-rpc/identity.json'; c=json.load(open(p)); "
    "f='/opt/enclave-rpc/chain_service.py'; c['runtimePins'][f]=hashlib.sha256(open(f,'rb').read()).hexdigest(); "
    "open(p,'w').write(json.dumps(c,sort_keys=True))")
CHECK_PINS = (
    "import json,hashlib; c=json.load(open('/etc/enclave-rpc/identity.json')); "
    "bad=[f for f,d in c['runtimePins'].items() if hashlib.sha256(open(f,'rb').read()).hexdigest()!=d]; "
    "assert not bad, bad")


def discard_mounts(writes):
    """The seed's chain-disk mount units, which the image gives `discard`; their options must be exactly rw,noatime."""
    mounts = []
    for w in writes:
        if not (w['path'].startswith('/etc/systemd/system/srv-enclave') and w['path'].endswith('.mount')):
            continue
        text = base64.b64decode(w['content']).decode() if w.get('encoding') == 'b64' else w['content']
        options = [l.split('=', 1)[1] for l in text.splitlines() if l.startswith('Options=')]
        if options != ['rw,noatime'] or 'Type=ext4' not in text.splitlines():
            raise ValueError('chain mount %s changed: Options %s' % (w['path'], options))
        mounts.append(w['path'])
    if len(mounts) != 2:
        raise ValueError('expected the L1 and Base chain mounts, found %s' % mounts)
    return mounts


def seed_config(owner_pub, coverage=None):
    raw = (PRIVATE_SEED/'files/user-data').read_text()
    writes = [w for w in json.loads(raw.split('\n', 1)[1])['write_files'] if not w['path'].startswith('/etc/ssh/')]

    def add(path, data, mode='0644'):
        writes.append({'path': path, 'owner': 'root:root', 'permissions': mode, 'encoding': 'b64',
                       'content': base64.b64encode(data).decode()})
    if coverage is not None:
        add('/etc/enclave-rpc/base-bootstrap.json', (coverage/'base-bootstrap.json').read_bytes())
        for name in COVERAGE_FILES:
            add('/etc/enclave-rpc/coverage/'+name, (coverage/name).read_bytes())
        if (coverage/'blob-patch.json').exists():
            add('/etc/enclave-rpc/blob-patch.json', (coverage/'blob-patch.json').read_bytes())
            add('/opt/enclave-rpc/beacon-patch.py', (HERE/'beacon-patch.py').read_bytes(), '0755')
            add('/etc/systemd/system/enclave-rpc-beacon-patch.service', (
                b'[Unit]\nDescription=Beacon API view for Base that fills KZG-verified patched slots\n'
                b'After=enclave-rpc-cl.service\n[Service]\nType=exec\n'
                b'ExecStart=/usr/bin/python3 -I /opt/enclave-rpc/beacon-patch.py /etc/enclave-rpc/blob-patch.json\n'
                b'Restart=always\nRestartSec=5\nMemoryMax=256M\nNoNewPrivileges=yes\nProtectHome=yes\nDynamicUser=yes\n'
                b'[Install]\nWantedBy=multi-user.target\n'))
            add('/etc/systemd/system/enclave-rpc-base.service.d/beacon-patch.conf',
                b'[Unit]\nWants=enclave-rpc-beacon-patch.service\nAfter=enclave-rpc-beacon-patch.service\n')
    # The production L1 disk has pre-merge history expired; see l1_identity_patch.py.
    add('/opt/enclave-rpc-build/l1_identity_patch.py', (HERE/'l1_identity_patch.py').read_bytes(), '0700')
    # Base restarts after L1 prunes the snapshot origin; see base_restart_patch.py.
    add('/opt/enclave-rpc-build/base_restart_patch.py', (HERE/'base_restart_patch.py').read_bytes(), '0700')
    # Base's merkle stage goes incremental instead of rebuilding the trie; see base_merkle_patch.py.
    add('/opt/enclave-rpc-build/base_merkle_patch.py', (HERE/'base_merkle_patch.py').read_bytes(), '0700')
    # Base keeps a rolling window of history instead of everything since historyFromBlock; see base_history_patch.py.
    # reth fixes its prune flags at start, so a weekly restart of Base alone advances the floor (Base replays a few
    # minutes of blocks; the gateway serves public Base from its fallbacks meanwhile).
    add('/opt/enclave-rpc-build/base_history_patch.py', (HERE/'base_history_patch.py').read_bytes(), '0700')
    add('/etc/systemd/system/enclave-rpc-base-history.service', (
        b'[Unit]\nDescription=Restart Base so its history floor advances (base_history_patch.py)\n'
        b'[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl try-restart enclave-rpc-base.service\n'))
    add('/etc/systemd/system/enclave-rpc-base-history.timer', (
        b'[Unit]\nDescription=Weekly Base restart for its history floor\n'
        b'[Timer]\nOnCalendar=Sun *-*-* 06:00:00 UTC\nRandomizedDelaySec=1h\n'
        b'[Install]\nWantedBy=timers.target\n'))
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
    # Measured limits (ops/rpc-l1-catchup): the image's 4.5/6.5 GiB MemoryHigh throttled
    # Lighthouse into thrashing during range sync. Base's page cache counts against its limit: at
    # 7/8 GiB it re-read its database at 1.5 GB/s with every vCPU busy and could not execute one
    # block within reth's 5-minute read timeout (prod r10, 2026-11-05 16:37Z). Sized for a 64 GiB
    # guest; memory is not in the SNP measurement, but these limits are.
    for side, high, cap in (('el', 11264, 12288), ('cl', 10240, 11264), ('base', 30720, 32768)):
        add('/etc/systemd/system/enclave-rpc-%s.service.d/limits.conf' % side,
            b'[Service]\nTimeoutStopSec=300\nMemoryHigh=%dM\nMemoryMax=%dM\n' % (high, cap))
    # Base's start checks need L1 synced and answering, which after a restart can take reth
    # minutes (prod r8, 2026-11-03: refused once with ECONNREFUSED and stayed down). Each
    # retry re-runs every fail-closed check; a refusal still refuses, it is just asked again.
    # Always, not on-failure: when its L1 watcher exhausted retries the rollup node exited 0 and
    # Base stayed down for 4.5 hours (prod r10, 2026-11-05 10:32Z).
    add('/etc/systemd/system/enclave-rpc-base.service.d/restart.conf',
        b'[Unit]\nStartLimitIntervalSec=0\n[Service]\nRestart=always\nRestartSec=60\n')
    add('/etc/systemd/system/enclave-rpc-clients.slice.d/limits.conf',
        b'[Slice]\nMemoryHigh=59392M\nMemoryMax=61440M\n')
    # The chain disks hand freed blocks back to the host as they are freed. The qcow2 on /vm otherwise keeps
    # every block the clients ever wrote: L1 held 673 GiB for 427 GiB of data and regrew 16 GiB in 2.5 h after
    # an offline trim (prod r11, 2026-11-08). The stock fstrim.service never reached these disks: it trims
    # only /etc/fstab, which names just the read-only root. A daily fstrim over every mount catches what
    # online discard misses (frees smaller than a 64 KiB qcow2 cluster); the read-only root is skipped.
    chain_mounts = discard_mounts(writes)
    for path in chain_mounts:
        add(path + '.d/discard.conf', b'[Mount]\nOptions=rw,noatime,discard\n')
    add('/etc/systemd/system/fstrim.service.d/chain-disks.conf',
        b'[Service]\nExecStart=\nExecStart=/sbin/fstrim --listed-in /proc/self/mountinfo --verbose --quiet-unsupported\n')
    add('/etc/systemd/system/fstrim.timer.d/daily.conf', b'[Timer]\nOnCalendar=\nOnCalendar=daily\nRandomizedDelaySec=1h\n')
    script = '\n'.join([
        'set -eux',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get -q update',
        'apt-get -qy install linux-modules-extra-$(uname -r)',
        'apt-get clean',
        *(['python3 -I -c "%s"' % SET_BOOTSTRAP, 'chmod 0755 /etc/enclave-rpc/coverage'] if coverage is not None else []),
        *([BEACON_PATCH_SED, "grep -q \"'--l1-beacon', 'http://127.0.0.1:15053'\" /opt/enclave-rpc/chain_service.py",
           'systemctl enable enclave-rpc-beacon-patch.service']
          if coverage is not None and (coverage/'blob-patch.json').exists() else []),
        'python3 -I /opt/enclave-rpc-build/l1_identity_patch.py /opt/enclave-rpc/chain_service.py',
        'python3 -I /opt/enclave-rpc-build/base_restart_patch.py /opt/enclave-rpc/chain_service.py',
        'python3 -I /opt/enclave-rpc-build/base_merkle_patch.py /opt/enclave-rpc/chain_service.py',
        'python3 -I /opt/enclave-rpc-build/base_history_patch.py /opt/enclave-rpc/chain_service.py',
        'systemctl enable enclave-rpc-base-history.timer',
        'rm -r /opt/enclave-rpc-build',
        'python3 -I -c "%s"' % REPIN_IDENTITY,
        'python3 -I -c "%s"' % CHECK_PINS,
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


def main(out, coverage=None):
    out = Path(out)
    coverage = Path(coverage) if coverage else None
    if coverage is not None:
        # A verdict that patched slots covered them only with that blob patch; the guest does not check it, so
        # an image without exactly those bytes would stall Base at the first patched slot (activation-r4 REVIEW.md (a)).
        verdict = json.loads((coverage/'verdict.json').read_text())
        if verdict.get('patchedSlots') and not ((coverage/'blob-patch.json').exists()
                                                and sha(coverage/'blob-patch.json') == verdict['blobPatch']['sha256']):
            raise ValueError('coverage verdict patched slots but blob-patch.json is missing or differs')
    out.mkdir(mode=0o700)
    if sha(BOOT_VHDX) != BOOT_SHA256:
        raise ValueError('Pinned boot image changed')
    run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(out/'build-key')])
    seed = out/'seed'
    seed.mkdir(mode=0o700)
    (seed/'user-data').write_text('#cloud-config\n'+json.dumps(seed_config((out/'build-key.pub').read_text().strip(), coverage))+'\n')
    # identity.py binds the guest to /var/lib/cloud/data/instance-id, which cloud-init
    # records from this meta-data: use the runtime identity's own instance.
    config = json.loads((seed/'user-data').read_text().split('\n', 1)[1])
    ident = next(w for w in config['write_files'] if w['path'] == '/etc/enclave-rpc/identity.json')
    instance = json.loads(base64.b64decode(ident['content']))['instance']
    (seed/'meta-data').write_text('instance-id: %s\nlocal-hostname: %s\n' % (instance, instance))
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
             'sources': {n: sha(HERE/n) for n in ('front.py', 'enclave-verity-hook', 'enclave-verity-local-top', 'build_image.py',
                                                    'l1_identity_patch.py', 'base_restart_patch.py', 'base_merkle_patch.py',
                                                    'base_history_patch.py')},
             'coverage': {n: sha(coverage/n) for n in COVERAGE_FILES + ('base-bootstrap.json', 'blob-patch.json')
                          if (coverage/n).exists()} if coverage else None}
    (out/'IMAGE.json').write_text(json.dumps(image, indent=1)+'\n')
    for p in (out/'build-key', out/'build.qcow2'):
        p.unlink()
    print(json.dumps(image))


if __name__ == '__main__':
    main(*sys.argv[1:3])
