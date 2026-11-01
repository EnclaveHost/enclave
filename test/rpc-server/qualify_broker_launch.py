#!/usr/bin/env python3
"""Actual broker launch qualification; only inside a bounded delegated user unit.

No VM, production namespace, owner service, export, chain or root attachment.
The Go fixture and release broker are previously built, separately hash-pinned.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main(spec_path):
    spec = json.loads(Path(spec_path).read_text())
    if set(spec) != {'schema', 'fixture', 'broker', 'output'} or spec['schema'] != 'enclave-rpc-broker-launch-test/1':
        raise RuntimeError('exact native qualification spec required')
    for key in ('fixture', 'broker'):
        p = Path(spec[key]['path'])
        if not p.is_file() or p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest() != spec[key]['sha256']:
            raise RuntimeError('compiled input pin differs')
    output = Path(spec['output'])
    output.mkdir(mode=0o700)  # Exclusive result namespace; no rerun.
    own = Path('/proc/self/cgroup').read_text().strip()
    if not own.startswith('0::/') or '\n' in own or not own.endswith('/controller'):
        raise RuntimeError('independent unit DelegateSubgroup=controller required')
    parent = Path('/sys/fs/cgroup' + own[3:]).parent
    if not parent.name.startswith('enclave-rpc-broker-launch-native-') or not parent.name.endswith('.service'):
        raise RuntimeError('exact disposable fixture delegation required')
    expected = {'memory.max': '536870912', 'memory.swap.max': '0', 'cpu.max': '100000 100000', 'pids.max': '64', 'cgroup.procs': ''}
    actual = {key: (parent/key).read_text().strip() for key in expected}
    if actual != expected or parent.stat().st_uid != os.getuid():
        raise RuntimeError('outer native limits/delegation differ: ' + str(actual))
    # Only this independently bounded unit's empty parent. All test actors are
    # already in controller. Never write ancestor or unrelated cgroup controls.
    (parent/'cgroup.subtree_control').write_text('+cpu +memory +pids')
    controllers = (parent/'cgroup.subtree_control').read_text().split()
    if not {'cpu', 'memory', 'pids'} <= set(controllers):
        raise RuntimeError('actual delegation controllers unavailable')
    (output/'envelope.json').write_text(json.dumps({'parent': str(parent), 'actual': actual, 'controllers': controllers})+'\n')
    rows = []
    for case in ('normal', 'deadline'):
        # Keep cgroup namespace shared so the broker's actual /proc/self/cgroup
        # resolves beneath the real read-only cgroup root. Only this unit is RW.
        cmd = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--clearenv', '--uid', '0', '--gid', '0',
               '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
               '--ro-bind', '/sys/fs/cgroup', '/sys/fs/cgroup', '--bind', str(parent), str(parent),
               '--ro-bind', spec['fixture']['path'], '/launch-test', '--ro-bind', spec['broker']['path'], '/plat/native-rpc/rpc-storage-broker',
               '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
               '--setenv', 'GOMAXPROCS', '1', '--setenv', 'RPC_LAUNCH_TEST_CGROUP', str(parent), '--setenv', 'RPC_LAUNCH_TEST_CASE', case,
               '/launch-test', '-test.v', '-test.timeout=4s', '-test.run=^TestLaunchActualBroker$']
        (output/(case+'-command.json')).write_text(json.dumps(cmd)+'\n')
        start = time.monotonic()
        with (output/(case+'.log')).open('x') as log:
            result = subprocess.run(cmd, stdout=log, stderr=log, timeout=6)
        rows.append({'case': case, 'exit': result.returncode, 'elapsed': time.monotonic()-start})
        (output/'result.json').write_text(json.dumps({'rows': rows, 'rootGrant': False, 'production': False})+'\n')
        if result.returncode:
            raise RuntimeError('native case failed; no later cases or retries')
    print(json.dumps({'rows': rows, 'rootGrant': False, 'production': False}))


if __name__ == '__main__':
    main(sys.argv[1])
