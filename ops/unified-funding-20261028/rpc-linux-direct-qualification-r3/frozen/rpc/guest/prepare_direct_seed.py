"""Private NoCloud seed for the direct local-disk RPC guest. No guest launch."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def build(root, instance, runtime_pins):
    root = Path(root)
    if root.resolve() != root or root.stat().st_mode & 0o077:
        raise ValueError('Private canonical output parent required')
    if not re.fullmatch(r'rpc-owned-[a-f0-9]{32}', instance):
        raise ValueError('Exact independent guest instance required')
    output = root / 'direct-seed'
    output.mkdir(mode=0o700)
    old = os.umask(0o077)
    try:
        for name in ('owner', 'host'):
            subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '',
                            '-C', instance, '-f', str(output/name)], check=True, timeout=5)
        owner = (output/'owner.pub').read_text().strip()
        host = (output/'host.pub').read_text().strip()
        writes = []

        def add(path, data, mode='0644'):
            writes.append({'path': path, 'owner': 'root:root', 'permissions': mode,
                           'encoding': 'b64', 'content': base64.b64encode(data).decode()})

        here = Path(__file__).resolve().parent
        add('/opt/enclave-rpc/identity.py', (here/'identity.py').read_bytes(), '0755')
        add('/etc/enclave-rpc/identity.json', json.dumps({
            'schema': 'owned-rpc-identity/1', 'instance': instance,
            'runtimePins': runtime_pins}, sort_keys=True).encode())
        # Direct disks have no NBD attachment/credential service dependency.
        identity = (here/'units/enclave-rpc-identity.service').read_text()
        identity = identity.replace('Requires=enclave-rpc-storage-client.service\n', '')
        identity = identity.replace('After=cloud-config.service enclave-rpc-storage-client.service',
                                    'After=cloud-config.service')
        add('/etc/systemd/system/enclave-rpc-identity.service', identity.encode())
        for role, uuid, mount in (
            ('l1', 'a2f2a8b5-06ac-4612-95a0-f48a00a7f6e0', '/srv/enclave-l1-pair'),
            ('base', '11c6bbac-f823-4052-a87a-066eed6ad590', '/srv/enclave-base-holder')):
            unit = subprocess.check_output(['/usr/bin/systemd-escape', '--path', '--suffix=mount', mount], text=True).strip()
            add('/etc/systemd/system/'+unit, (
                '[Unit]\nDescription=Exclusive RPC '+role+' COW disk\n'
                '[Mount]\nWhat=/dev/disk/by-uuid/'+uuid+'\nWhere='+mount+
                '\nType=ext4\nOptions=rw,noatime\nTimeoutSec=20\n').encode())
        for side in ('el', 'cl', 'base'):
            name = 'enclave-rpc-'+side+'.service.d/identity.conf'
            add('/etc/systemd/system/'+name, (here/'units'/name).read_bytes())
        # Prevent guest traffic from reaching host-local management services.
        for side in ('el', 'cl', 'base'):
            add('/etc/systemd/system/enclave-rpc-'+side+'.service.d/host.conf',
                b'[Service]\nIPAddressDeny=10.0.2.2/32\n')
        add('/etc/ssh/sshd_config.d/00-rpc.conf',
            b'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n')
        cloud = {'users': [{'name': 'rpcadmin', 'groups': ['sudo'], 'shell': '/bin/bash',
                           'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'lock_passwd': True,
                           'ssh_authorized_keys': [owner]}],
                 'ssh_pwauth': False, 'disable_root': True, 'package_update': False,
                 'package_upgrade': False, 'ssh_deletekeys': True,
                 'ssh_publish_hostkeys': {'enabled': False},
                 'ssh_keys': {'ed25519_private': (output/'host').read_text(), 'ed25519_public': host},
                 'write_files': writes,
                 'runcmd': [['systemctl', 'daemon-reload'],
                            ['systemctl', 'start', 'enclave-rpc-identity.service']]}
        seed = output/'files'; seed.mkdir(mode=0o700)
        (seed/'user-data').write_text('#cloud-config\n'+json.dumps(cloud)+'\n')
        (seed/'meta-data').write_text('instance-id: '+instance+'\nlocal-hostname: '+instance+'\n')
        (output/'known_hosts').write_text('rpc-direct '+host+'\n')
        with (output/'build.log').open('xb') as log:
            subprocess.run(['/usr/bin/xorriso', '-as', 'mkisofs', '-V', 'cidata', '-J', '-r',
                            '-o', str(output/'seed.iso'), str(seed/'user-data'), str(seed/'meta-data')],
                           stdout=log, stderr=log, check=True, timeout=20)
            subprocess.run(['/usr/bin/xorriso', '-osirrox', 'on', '-indev', str(output/'seed.iso'),
                            '-extract', '/', str(output/'readback')], stdout=log, stderr=log,
                           check=True, timeout=20)
        for name in ('user-data', 'meta-data'):
            if (seed/name).read_bytes() != (output/'readback'/name).read_bytes():
                raise ValueError('Seed readback mismatch')
        result = {'instance': instance, 'seedSha256': hashlib.sha256((output/'seed.iso').read_bytes()).hexdigest(),
                  'seedBytes': (output/'seed.iso').stat().st_size, 'readbackVerified': True,
                  'privateMedia': True, 'clientsStarted': False}
        (output/'RESULT.json').write_text(json.dumps(result)+'\n')
        return result
    finally:
        os.umask(old)
