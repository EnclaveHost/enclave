#!/usr/bin/env python3
"""Build fresh Ubuntu RPC boot media; never create or start a VM.

Run inside an independently bounded unit. Inputs and private tool tree must be
owned by the operator. A failed output directory is retained and cannot resume.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    source = Path(config['source']).resolve(strict=True)
    tools = Path(config['tools']).resolve(strict=True)
    output = Path(config['output'])
    instance = config['instance']
    key = config['publicKey'].strip()
    if not re.fullmatch(r'rpc-[a-z0-9-]{8,60}', instance):
        raise ValueError('Unique RPC instance name required')
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?', key):
        raise ValueError('Single public Ed25519 key required')
    if config['deadlineSeconds'] > 600 or config['deadlineSeconds'] < 1:
        raise ValueError('Finite artifact deadline required')
    if config['memoryFloorBytes'] < 2 * 1024**3 or config['diskFloorBytes'] < 16 * 1024**3:
        raise ValueError('Preparation floor cannot be weakened')
    output.mkdir(mode=0o700)  # exclusive attempt; never overwrite/resume
    origin = time.monotonic()
    deadline = origin + config['deadlineSeconds']
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'LD_LIBRARY_PATH': str(tools / 'usr/lib/x86_64-linux-gnu')}
    binaries = {name: tools / 'usr/bin' / name for name in ['qemu-img', 'xorriso']}
    for name, path in binaries.items():
        if digest(path) != config['binaries'][name]:
            raise ValueError('Tool digest mismatch: ' + name)
    minimum_memory = 2**64
    minimum_disk = 2**64

    def guard():
        nonlocal minimum_memory, minimum_disk
        available = next(int(row.split()[1]) * 1024 for row in
                         Path('/proc/meminfo').read_text().splitlines()
                         if row.startswith('MemAvailable:'))
        disk = os.statvfs(output)
        free = disk.f_bavail * disk.f_frsize
        minimum_memory = min(minimum_memory, available)
        minimum_disk = min(minimum_disk, free)
        if (available < config['memoryFloorBytes'] or free < config['diskFloorBytes']
                or time.monotonic() >= deadline):
            raise RuntimeError('Preparation resource/deadline guard')
        for name, maximum in [('boot.vhdx', 4 * 1024**3), ('seed.iso', 64 * 1024**2)]:
            path = output / name
            if path.exists() and path.stat().st_size > maximum:
                raise RuntimeError('Output size limit: ' + name)

    def run(argv, result_name):
        guard()
        log = output / result_name
        with log.open('xb') as stream:
            proc = subprocess.Popen([str(v) for v in argv], stdout=stream,
                                    stderr=subprocess.STDOUT, env=env)
            try:
                while proc.poll() is None:
                    guard()
                    if log.stat().st_size > 1024**2:
                        raise RuntimeError('Diagnostic bound')
                    time.sleep(.1)
                if proc.returncode:
                    raise RuntimeError('Tool failed: ' + result_name + ':' + str(proc.returncode))
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        guard()
        return log.read_text()

    guard()
    before = source.stat()
    if digest(source) != config['sourceSha256']:
        raise ValueError('Source digest mismatch')
    qemu = binaries['qemu-img']
    info = json.loads(run([qemu, 'info', '--output=json', '-f', 'qcow2', source], 'source-info.json'))
    if (info.get('format') != 'qcow2' or info.get('backing-filename')
            or info.get('virtual-size') != 3758096384 or info.get('dirty-flag', False)):
        raise ValueError('Expected clean standalone 3.5GiB source')
    run([qemu, 'convert', '-m', '1', '-f', 'qcow2', '-O', 'vhdx', '-o',
         'subformat=dynamic,block_size=1048576', source, output / 'boot.vhdx'], 'convert.log')
    run([qemu, 'compare', '-f', 'qcow2', '-F', 'vhdx', source, output / 'boot.vhdx'], 'compare.log')
    final_info = json.loads(run([qemu, 'info', '--output=json', '-f', 'vhdx', output / 'boot.vhdx'], 'output-info.json'))
    if final_info.get('virtual-size') != info['virtual-size'] or final_info.get('backing-filename'):
        raise ValueError('Output geometry changed')
    seed = output / 'seed'
    seed.mkdir(mode=0o700)
    (seed / 'meta-data').write_text('instance-id: ' + instance + '\nlocal-hostname: ' + instance + '\n')
    (seed / 'user-data').write_text('#cloud-config\n' + json.dumps({
        'users': [{'name': 'rpcadmin', 'groups': ['sudo'], 'shell': '/bin/bash',
                   'sudo': 'ALL=(ALL) NOPASSWD:ALL', 'lock_passwd': True,
                   'ssh_authorized_keys': [key]}],
        'ssh_pwauth': False, 'disable_root': True, 'package_update': False,
        'package_upgrade': False,
        'write_files': [{'path': '/etc/ssh/sshd_config.d/00-rpc-key-only.conf',
                         'permissions': '0644', 'content': 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n'}]
    }, indent=2) + '\n')
    run([binaries['xorriso'], '-as', 'mkisofs', '-V', 'cidata', '-J', '-r',
         '-o', output / 'seed.iso', seed / 'user-data', seed / 'meta-data'], 'seed.log')
    extracted = output / 'seed-readback'
    run([binaries['xorriso'], '-osirrox', 'on', '-indev', output / 'seed.iso',
         '-extract', '/', extracted], 'seed-readback.log')
    for name in ['user-data', 'meta-data']:
        if (extracted / name).read_bytes() != (seed / name).read_bytes():
            raise RuntimeError('Seed media content mismatch: ' + name)
    after = source.stat()
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            or digest(source) != config['sourceSha256']):
        raise RuntimeError('Source changed')
    guard()
    result = {'schema': 'rpc-boot-media/1', 'instance': instance,
              'sourceSha256': config['sourceSha256'], 'logicalComparePassed': True,
              'sourceUnchanged': True, 'seedReadbackPassed': True,
              'virtualBytes': info['virtual-size'],
              'elapsedSeconds': time.monotonic() - origin,
              'minimumAvailableBytes': minimum_memory, 'minimumDiskFreeBytes': minimum_disk,
              'files': {name: {'sha256': digest(output / name), 'bytes': (output / name).stat().st_size}
                        for name in ['boot.vhdx', 'seed.iso']},
              'bootQualified': False, 'rpcReady': False,
              'invocation': os.environ.get('INVOCATION_ID')}
    with (output / 'RESULT.json').open('x') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
