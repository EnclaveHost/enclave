"""Catch one L1 COW up to chain head on Warden NVMe, then stop cleanly.

Stale chain state cannot become ready inside an enclave's 15-minute startup
window, so the state is brought near head first, outside any serving role. This
reuses the direct-guest recipe (linux_direct.py): the same RPC guest OS, seed and
SSH identity, a kernel read-only namespace where only the new attempt directory
is writable, and OFD read locks on every frozen backing. It starts only L1 EL+CL,
never Base, publishes nothing and is not production readiness. The result is a
new COW over the previous one, frozen for the next attachment.

python3 -B rpc/linux_catchup.py CONFIG.json   (inside its own systemd unit)
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('direct_volume', HERE/'server/volume_export.py')
volume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volume)
GIB = 1024**3
FIELDS = {'root', 'unit', 'bootId', 'resourceConfig', 'sshPort', 'previous', 'chain', 'memoryMiB', 'cpus',
          'elMemoryMiB', 'clMemoryMiB', 'maxSeconds', 'pins'}
EL, CL = 'http://127.0.0.1:18645', 'http://127.0.0.1:15052'


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def admit(row, reserve_mib):
    if row.get('authenticated') is not True or row.get('unreadUnits') != 0:
        raise ValueError('Authenticated complete host accounting required')
    for name in ('availableMiB', 'pendingMiB', 'floorMiB'):
        if type(row.get(name)) is not int or row[name] < 0:
            raise ValueError('Invalid resource accounting')
    if row['availableMiB'] - row['pendingMiB'] - reserve_mib < max(27648, row['floorMiB']):
        raise ValueError('Host capacity refused')


class Stop(Exception):
    pass


def launch(config, log):
    if set(config) != FIELDS:
        raise ValueError('Exact catch-up configuration required')
    root = volume.directory(config['root'])
    previous = volume.directory(config['previous'])
    if root.stat().st_mode & 0o077 or config['bootId'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise ValueError('Private original host context required')
    for path, sha in config['pins'].items():
        if digest(path) != sha:
            raise ValueError('Reviewed input changed: '+path)
    if not {str(HERE/'linux_catchup.py'), str(HERE/'server/volume_export.py'), str(previous/'boot.vhdx')} <= set(config['pins']):
        raise ValueError('Runner, volume validator and boot media must be pinned')
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append('SIGTERM'))
    started_at = time.monotonic()

    def run(argv, timeout=10, check=True):
        return subprocess.run(argv, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

    def resources(reserve):
        row = json.loads(run(['/usr/bin/node', str(HERE/'server/observe_resources.mjs'), config['resourceConfig']], 5).stdout)
        admit(row, reserve)
        return row

    initial = resources(config['memoryMiB'] + 512)
    log(event='admission', **initial)
    port = config['sshPort']
    if type(port) is not int or not 20000 <= port <= 29999:
        raise ValueError('Explicit loopback control port required')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))
    held = []
    child = None
    with (root/'START-INTENT.json').open('x') as out:
        json.dump({'config': config, 'initialAdmission': initial, 'rpcReady': False, 'serving': False}, out)
        out.flush(); os.fsync(out.fileno())
    dfd = os.open(root, os.O_DIRECTORY)
    try:
        os.fsync(dfd)
        # Every frozen backing is checked, read-locked and must have no writer.
        chain = [Path(r['path']) for r in config['chain']]
        for row, path in zip(config['chain'], chain):
            volume.directory(path.parent)
            if path.resolve() != path or volume.metadata(path) != row['metadata']:
                raise ValueError('Frozen backing identity changed: '+str(path))
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC); held.append(fd)
            st = os.fstat(fd)
            if [st.st_dev, st.st_ino] != row['metadata'][:2]:
                raise ValueError('Opened backing differs')
            for byte in (201, 202, 203):
                fcntl.fcntl(fd, fcntl.F_OFD_SETLK, struct.pack('@hhqqi4x', fcntl.F_RDLCK, os.SEEK_SET, byte, 1, 0))
            lock = fcntl.fcntl(fd, fcntl.F_OFD_GETLK, struct.pack('@hhqqi4x', fcntl.F_WRLCK, os.SEEK_SET, 100, 200, 0))
            if struct.unpack('@hhqqi4x', lock)[0] != fcntl.F_UNLCK:
                raise ValueError('Conflicting backing writer: '+str(path))
        info = json.loads(run(['/usr/bin/qemu-img', 'info', '--output=json', '--backing-chain', str(chain[0])]).stdout)
        volume.validate_chain(info, chain, 4_000_000_000_000)
        boot_parent = previous/'boot.qcow2'
        for name, parent, fmt in (('boot', boot_parent, 'qcow2'), ('l1', chain[0], 'qcow2')):
            overlay = root/(name+'.qcow2')
            if overlay.exists():
                raise ValueError('Overlay already consumed')
            run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', fmt, '-b', str(parent), str(overlay)])
            overlay.chmod(0o600)
        seed = previous/'direct-seed'

        def node(paths, name):
            current = None
            for index, path in reversed(list(enumerate(paths))):
                n = {'driver': 'qcow2', 'file': {'driver': 'file', 'filename': str(path)}, 'read-only': index > 0}
                if path.suffix == '.vhdx':
                    n['driver'] = 'vhdx'
                if current is not None:
                    n['backing'] = current
                current = n
            current['node-name'] = name
            return json.dumps(current)
        args = ['/usr/sbin/qemu-system-x86_64', '-name', 'rpc-l1-catchup', '-machine', 'q35,accel=kvm',
                '-cpu', 'host', '-smp', str(config['cpus']), '-m', str(config['memoryMiB']), '-nodefaults',
                '-no-reboot', '-display', 'none', '-no-user-config', '-serial', 'file:'+str(root/'console.log'),
                '-monitor', 'none', '-qmp', 'unix:'+str(root/'qmp.sock')+',server=on,wait=off',
                '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
                '-blockdev', node([root/'boot.qcow2', boot_parent, previous/'boot.vhdx'], 'os0'),
                '-device', 'virtio-blk-pci,drive=os0,id=osdisk,bootindex=0',
                '-drive', 'file='+str(seed/'seed.iso')+',format=raw,media=cdrom,readonly=on',
                '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:'+str(port)+'-:22',
                '-device', 'virtio-net-pci,netdev=net0',
                '-blockdev', node([root/'l1.qcow2', *chain], 'l1'), '-device', 'virtio-blk-pci,drive=l1,serial=RPC-l1']
        args = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
                '--ro-bind', '/', '/', '--bind', str(root), str(root), '--dev', '/dev',
                '--dev-bind', '/dev/kvm', '/dev/kvm', '--', *args]
        resources(config['memoryMiB'] + 512)
        with (root/'qemu.log').open('xb') as qlog:
            child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=qlog, stderr=qlog)
        if Path('/proc', str(child.pid), 'cgroup').read_text() != Path('/proc/self/cgroup').read_text():
            raise ValueError('QEMU escaped owner cgroup')
        log(event='qemu-started', pid=child.pid)
        ssh = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=3',
               '-oControlMaster=no', '-oControlPath=none', '-oIdentitiesOnly=yes', '-oHostKeyAlias=rpc-direct',
               '-oUserKnownHostsFile='+str(seed/'known_hosts'), '-i', str(seed/'owner'), '-p', str(port), 'rpcadmin@127.0.0.1']

        def guest(cmd, timeout=20):
            return subprocess.run(ssh+[cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, text=True)

        def status():
            probe = ("curl -s -m 4 -H content-type:application/json "
                     "-d '[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_syncing\",\"params\":[]},"
                     "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}]' "
                     + EL + "; echo; curl -s -m 4 " + CL + "/eth/v1/node/syncing; echo; "
                     "systemctl show -p ActiveState -p MemoryCurrent enclave-rpc-el.service enclave-rpc-cl.service | tr '\\n' ' '")
            r = guest(probe)
            lines = r.stdout.split('\n')
            out = {'units': lines[2] if len(lines) > 2 else ''}
            try:
                el = {x['id']: x.get('result') for x in json.loads(lines[0])}
                out['elSyncing'] = el[1]
                out['elHead'] = int(el[2]['number'], 16)
                out['elHeadAge'] = int(time.time()) - int(el[2]['timestamp'], 16)
            except Exception:
                out['el'] = lines[0][:200]
            try:
                out['cl'] = json.loads(lines[1])['data']
            except Exception:
                out['cl'] = lines[1][:200] if len(lines) > 1 else ''
            return out

        started = False
        synced = 0
        last = 0
        reason = None
        while child.poll() is None:
            if stopping:
                reason = 'external stop: '+stopping[0]; break
            if time.monotonic() - started_at > config['maxSeconds']:
                reason = 'maximum catch-up time'; break
            if time.monotonic() - last >= 30:
                last = time.monotonic()
                resources(512)
                disk = os.statvfs(root)
                if disk.f_bavail*disk.f_frsize < 300*GIB:
                    reason = 'NVMe reserve reached'; break
                if sum((root/(r+'.qcow2')).stat().st_blocks*512 for r in ('boot', 'l1')) > 400*GIB:
                    reason = 'COW growth bound reached'; break
                for row in config['chain']:
                    if volume.metadata(row['path']) != row['metadata']:
                        raise ValueError('Frozen backing changed during catch-up')
                if started:
                    try:
                        s = status()
                    except subprocess.TimeoutExpired:
                        s = {'probe': 'timeout'}
                    log(event='progress', elapsed=round(time.monotonic()-started_at), **s)
                    cl = s.get('cl') if isinstance(s.get('cl'), dict) else {}
                    ok = s.get('elSyncing') is False and s.get('elHeadAge', 1e9) < 60 and cl.get('is_syncing') is False
                    synced = synced + 1 if ok else 0
                    if synced >= 3:
                        reason = 'synced to head'; break
            if not started:
                try:
                    probe = guest('systemctl is-active --quiet multi-user.target', 6)  # identity is pulled in by Requires=
                except subprocess.TimeoutExpired:
                    continue
                if probe.returncode == 0:
                    with (root/'CLIENT-INTENT').open('x') as out:
                        out.write('l1 el+cl catch-up only; Base not started\n'); out.flush(); os.fsync(out.fileno())
                    os.fsync(dfd); started = True
                    caps = ('sudo -n systemctl set-property --runtime enclave-rpc-el.service MemoryMax=%dM && '
                            'sudo -n systemctl set-property --runtime enclave-rpc-cl.service MemoryMax=%dM && '
                            '(sudo -n systemctl set-property --runtime enclave-rpc-clients.slice MemoryMax=%dM || true) && '
                            'sudo -n systemctl start enclave-rpc-el.service enclave-rpc-cl.service'
                            % (config['elMemoryMiB'], config['clMemoryMiB'], config['elMemoryMiB']+config['clMemoryMiB']))
                    r = guest(caps, 60)
                    log(event='clients-started', exit=r.returncode, stderr=r.stderr[-500:])
                    if r.returncode != 0:
                        reason = 'client start failed'; break
            time.sleep(2)
        log(event='stopping', reason=reason, qemuAlive=child.poll() is None)
        if child.poll() is None:
            # Clean client stop first: a killed EL is not a clean database checkpoint.
            for unit in ('enclave-rpc-cl.service', 'enclave-rpc-el.service'):
                try:
                    r = guest('sudo -n systemctl stop '+unit+'; systemctl show -p Result -p ExecMainStatus '+unit, 200)
                    log(event='client-stopped', unit=unit, exit=r.returncode, state=r.stdout.strip().replace('\n', ' '))
                except subprocess.TimeoutExpired:
                    log(event='client-stop-timeout', unit=unit)
            try:
                guest('sudo -n sync; sudo -n systemctl poweroff', 30)
            except subprocess.TimeoutExpired:
                pass
            try:
                child.wait(timeout=180)
            except subprocess.TimeoutExpired:
                log(event='poweroff-timeout')
        return reason
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()
        if child is not None:
            log(event='qemu-exited', code=child.returncode)
        for fd in held:
            os.close(fd)
        os.close(dfd)


if __name__ == '__main__':
    import sys
    cfg = json.loads(Path(sys.argv[1]).read_text())
    out = Path(cfg['root'])/'progress.jsonl'

    def log(**row):
        row['at'] = time.time()
        with out.open('a') as f:
            f.write(json.dumps(row)+'\n')
    log(event='result', reason=launch(cfg, log))
