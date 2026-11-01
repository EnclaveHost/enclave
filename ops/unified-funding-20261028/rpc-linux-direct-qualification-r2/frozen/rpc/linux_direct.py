"""One bounded direct-disk RPC startup on Linux; no retry or readiness claim.

The containing systemd unit owns the original 900-second lifetime, including
preparation. This first integration deliberately cannot release that deadline:
opening an SSH connection or seeing client PIDs is not production readiness.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('direct_volume', HERE/'server/volume_export.py')
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)
MIB = 1024**2


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def admit(row, initial):
    if row.get('authenticated') is not True or row.get('unreadUnits') != 0:
        raise ValueError('Authenticated complete host accounting required')
    for name in ('availableMiB', 'pendingMiB', 'floorMiB'):
        if type(row.get(name)) is not int or row[name] < 0:
            raise ValueError('Invalid resource accounting')
    reserve = 20480 + 512 if initial else 512
    if row['availableMiB'] - row['pendingMiB'] - reserve < max(27648, row['floorMiB']):
        raise ValueError('RPC host capacity refused')


def envelope(unit):
    raw = subprocess.check_output(['/usr/bin/systemctl', '--user', 'show', unit,
        '-p', 'MemoryMax', '-p', 'MemorySwapMax', '-p', 'RuntimeMaxUSec',
        '-p', 'TimeoutStopUSec', '-p', 'KillMode', '-p', 'Restart', '-p', 'MainPID',
        '-p', 'ControlGroup'], text=True, timeout=3)
    row = dict(line.split('=', 1) for line in raw.splitlines())
    if (row['MemoryMax'] != str(20*1024**3) or row['MemorySwapMax'] != '0'
            or row['RuntimeMaxUSec'] != '15min' or row['TimeoutStopUSec'] != '5s'
            or row['KillMode'] != 'control-group' or row['Restart'] != 'no'
            or row['MainPID'] != str(os.getpid())):
        raise ValueError('Independent startup envelope differs')
    actual = Path('/proc/self/cgroup').read_text().strip()
    if actual != '0::'+row['ControlGroup']:
        raise ValueError('Owner cgroup differs')
    cgroup = Path('/sys/fs/cgroup'+row['ControlGroup'])
    if (cgroup/'memory.max').read_text().strip() != str(20*1024**3) or (cgroup/'memory.swap.max').read_text().strip() != '0':
        raise ValueError('Kernel envelope differs')
    return cgroup


def launch(config):
    root = volume.directory(config['root'])
    if root.stat().st_mode & 0o077 or config['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise ValueError('Private original host context required')
    cgroup = envelope(config['unit'])
    origin = time.monotonic()
    deadline = origin + 895  # systemd's earlier 900-second clock remains authoritative
    required = {str(HERE/'linux_direct.py'), str(HERE/'server/volume_export.py'),
                str(HERE/'server/observe_resources.mjs'), config['resourceConfig'],
                '/usr/bin/node', '/usr/bin/qemu-img', '/usr/sbin/qemu-system-x86_64',
                '/usr/bin/bwrap', '/usr/bin/ssh', str(root/'boot.vhdx'), str(root/'direct-seed/seed.iso')}
    if set(config['pins']) != required or set(config['chains']) != {'l1', 'base'}:
        raise ValueError('Exact source/tool/media/volume closure required')
    for path, sha in config['pins'].items():
        if digest(path) != sha:
            raise ValueError('Reviewed input changed: '+path)
    def run(argv, timeout=5):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Original startup deadline')
        return subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=min(timeout, remaining))
    def resources(initial):
        row = json.loads(run(['/usr/bin/node', str(HERE/'server/observe_resources.mjs'), config['resourceConfig']], 2).stdout)
        admit(row, initial)
        return row
    initial = resources(True)
    port = config['sshPort']
    if type(port) is not int or not 20000 <= port <= 29999:
        raise ValueError('Explicit loopback control port required')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))  # QEMU independently must obtain the same port
    held = []
    child = None
    intent = {'originMonotonic': origin, 'deadlineMonotonic': deadline, 'hostBoot': config['bootId'],
              'unit': config['unit'], 'initialAdmission': initial, 'rpcReady': False}
    with (root/'START-INTENT.json').open('x') as out:
        json.dump(intent, out); out.flush(); os.fsync(out.fileno())
    dfd = os.open(root, os.O_DIRECTORY)
    try:
        os.fsync(dfd)
        for chain in config['chains'].values():
            for row in chain['originals']:
                path = Path(row['path']); volume.directory(path.parent)
                if path.resolve() != path or volume.metadata(path) != row['metadata']:
                    raise ValueError('Original identity changed')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC); held.append(fd)
                st = os.fstat(fd)
                if [st.st_dev, st.st_ino] != row['metadata'][:2]:
                    raise ValueError('Opened original differs')
                for byte in (201, 202, 203):
                    fcntl.fcntl(fd, fcntl.F_OFD_SETLK, struct.pack('@hhqqi4x', fcntl.F_RDLCK, os.SEEK_SET, byte, 1, 0))
                lock = fcntl.fcntl(fd, fcntl.F_OFD_GETLK, struct.pack('@hhqqi4x', fcntl.F_WRLCK, os.SEEK_SET, 100, 200, 0))
                if struct.unpack('@hhqqi4x', lock)[0] != fcntl.F_UNLCK:
                    raise ValueError('Conflicting original writer')
                if hashlib.sha256(os.pread(fd, 104, 0)).hexdigest() != row['headerSha256']:
                    raise ValueError('Original header changed')
                if 'sha256' in row and digest(path) != row['sha256']:
                    raise ValueError('Frozen backing digest changed')
            paths = [Path(r['path']) for r in chain['originals']]
            info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', '--backing-chain', str(paths[0])]).stdout)
            volume.validate_chain(info, paths, chain['virtualBytes'])
        for role in ('boot', 'l1', 'base'):
            parent = root/'boot.vhdx' if role == 'boot' else Path(config['chains'][role]['originals'][0]['path'])
            overlay = root/(role+'.qcow2')
            if overlay.exists():
                raise ValueError('Overlay already consumed')
            run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'vhdx' if role == 'boot' else 'qcow2', '-b', str(parent), str(overlay)])
            overlay.chmod(0o600)
        args = ['/usr/sbin/qemu-system-x86_64', '-name', config['instance'], '-machine', 'q35,accel=kvm',
                '-cpu', 'host', '-smp', '4', '-m', '19456', '-nodefaults', '-no-reboot', '-display', 'none',
                '-serial', 'file:'+str(root/'console.log'), '-monitor', 'none',
                '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
                '-drive', 'file='+str(root/'boot.qcow2')+',format=qcow2,if=virtio,cache=none',
                '-drive', 'file='+str(root/'direct-seed/seed.iso')+',format=raw,media=cdrom,readonly=on',
                '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:'+str(port)+'-:22',
                '-device', 'virtio-net-pci,netdev=net0']
        for role in ('l1', 'base'):
            paths = [root/(role+'.qcow2')]+[Path(r['path']) for r in config['chains'][role]['originals']]
            # JSON block nodes preserve explicit read-only parents without parsing a path as options.
            node = None
            for index, path in reversed(list(enumerate(paths))):
                current = {'driver': 'qcow2', 'file': {'driver': 'file', 'filename': str(path)}, 'read-only': index > 0}
                if node is not None: current['backing'] = node
                node = current
            node['node-name'] = role
            args += ['-blockdev', json.dumps(node), '-device', 'virtio-blk-pci,drive='+role+',serial=RPC-'+role]
        resources(True)
        # Kernel read-only namespace, including all original images. Only this
        # new private attempt directory is writable. The VM has no host mounts.
        args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
                '--ro-bind', '/', '/', '--bind', str(root), str(root),
                '--dev-bind', '/dev/kvm', '/dev/kvm', '--', *args]
        with (root/'qemu.log').open('xb') as log:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        pidfd = os.pidfd_open(child.pid)
        try:
            if Path('/proc', str(child.pid), 'cgroup').read_text() != Path('/proc/self/cgroup').read_text():
                raise ValueError('QEMU escaped owner cgroup')
            (root/'QEMU.json').write_text(json.dumps({'pid': child.pid, 'stat': Path('/proc', str(child.pid), 'stat').read_text(),
                                                   'pidfdHeld': True, 'rpcReady': False})+'\n')
            seed = root/'direct-seed'
            ssh = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=2',
                   '-oControlMaster=no', '-oControlPath=none', '-oIdentitiesOnly=yes', '-oHostKeyAlias=rpc-direct',
                   '-oUserKnownHostsFile='+str(seed/'known_hosts'), '-i', str(seed/'owner'), '-p', str(port), 'rpcadmin@127.0.0.1']
            started = False
            last_resource = 0
            while child.poll() is None and time.monotonic() < deadline:
                if time.monotonic()-last_resource >= 5:
                    resources(False); last_resource = time.monotonic()
                    disk = os.statvfs(root)
                    if disk.f_bavail*disk.f_frsize < 300*1024**3:
                        raise ValueError('NVMe reserve reached')
                    if sum((root/(r+'.qcow2')).stat().st_blocks*512 for r in ('boot', 'l1', 'base')) > 128*1024**3:
                        raise ValueError('COW growth bound reached')
                    for chain in config['chains'].values():
                        for row in chain['originals']:
                            if volume.metadata(row['path']) != row['metadata']:
                                raise ValueError('Original changed during startup')
                if not started:
                    try:
                        probe = subprocess.run(ssh+['test -f /var/lib/cloud/instance/boot-finished && sudo -n systemctl is-active --quiet enclave-rpc-identity.service'],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
                    except subprocess.TimeoutExpired:
                        continue  # read-only observation, never repeats a start
                    if probe.returncode == 0:
                        # Consume before transport. A lost response is never submitted again.
                        with (root/'CLIENT-INTENT').open('x') as out:
                            out.write('el cl only; Base remains coverage-gated\n'); out.flush(); os.fsync(out.fileno())
                        os.fsync(dfd); started = True
                        result = run(ssh+['sudo -n systemctl start enclave-rpc-el.service enclave-rpc-cl.service'], 30)
                        (root/'CLIENT-SUBMISSION.json').write_text(json.dumps({'sshExit': result.returncode, 'rpcReady': False})+'\n')
                time.sleep(1)
            if child.poll() is None:
                raise TimeoutError('Original startup window ended without production qualification')
            raise RuntimeError('QEMU exited before production qualification: '+str(child.returncode))
        finally:
            os.close(pidfd)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        for fd in held: os.close(fd)
        os.close(dfd)


if __name__ == '__main__':
    import sys
    launch(json.loads(Path(sys.argv[1]).read_text()))
