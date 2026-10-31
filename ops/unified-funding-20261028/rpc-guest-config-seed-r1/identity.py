#!/usr/bin/env python3
"""Initialize identities and local engine authentication in the exact RPC guest.

No storage ownership changes, service starts, network calls or secret output.
A partial JWT is refused on recovery; it is never silently replaced.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess

ACCOUNTS = {'rpcl1el': (997, 987), 'rpcl1cl': (995, 986), 'rpcbase': (994, 985)}
GROUPS = {name: pair[1] for name, pair in ACCOUNTS.items()} | {'rpcjwt': 50002}


def table(text, columns):
    rows = [line.split(':') for line in text.splitlines() if line and not line.startswith('#')]
    if any(len(row) != columns for row in rows) or len({r[0] for r in rows}) != len(rows):
        raise ValueError('Malformed or duplicate account table')
    return {row[0]: row for row in rows}


def validate_accounts(passwd, groups, complete=False):
    users, groups = table(passwd, 7), table(groups, 4)
    for name, (uid, gid) in ACCOUNTS.items():
        collisions = [row for row in users.values() if int(row[2]) == uid]
        if collisions and (len(collisions) != 1 or collisions[0][0] != name):
            raise ValueError('Reserved service UID already used')
        if name in users:
            row = users[name]
            if (int(row[2]), int(row[3]), row[5], row[6]) != (uid, gid, '/nonexistent', '/usr/sbin/nologin'):
                raise ValueError('Existing service identity differs')
        elif complete:
            raise ValueError('Missing service account')
    for name, gid in GROUPS.items():
        collisions = [row for row in groups.values() if int(row[2]) == gid]
        if collisions and (len(collisions) != 1 or collisions[0][0] != name):
            raise ValueError('Reserved service GID already used')
        if name in groups:
            row = groups[name]
            if int(row[2]) != gid:
                raise ValueError('Existing service group differs')
            members = set(row[3].split(',')) - {''}
            allowed = set() if name == 'rpcjwt' else {name}
            if members - allowed:
                raise ValueError('Unexpected service group member')
        elif complete:
            raise ValueError('Missing service group')
    for group, row in groups.items():
        for member in set(row[3].split(',')) & set(ACCOUNTS):
            if group != member:
                raise ValueError('Unexpected supplementary service membership')
    # Primary-group membership grants access even if absent from /etc/group.
    for row in users.values():
        if int(row[3]) in GROUPS.values() and GROUPS.get(row[0]) != int(row[3]):
            raise ValueError('Reserved primary group assigned to another account')
    return users, groups


def protected(path, *, mode=None):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or st.st_mode & 0o022:
        raise ValueError('Expected protected root-owned regular file')
    if mode is not None and stat.S_IMODE(st.st_mode) != mode:
        raise ValueError('Unexpected file mode')
    return st


def check_context(config):
    if os.geteuid() != 0:
        raise ValueError('Guest root required')
    if set(config) != {'schema', 'instance', 'runtimePins'} or config['schema'] != 'owned-rpc-identity/1':
        raise ValueError('Exact identity schema required')
    if not re.fullmatch(r'rpc-owned-[a-z0-9-]{8,64}', config['instance']):
        raise ValueError('Explicit owned guest instance required')
    instance = Path('/var/lib/cloud/data/instance-id')
    protected(instance)
    if instance.read_text().strip() != config['instance']:
        raise ValueError('Different guest instance')
    expected = {'/opt/enclave-rpc/manifest.json', '/opt/enclave-rpc/chain_service.py'}
    if set(config['runtimePins']) != expected:
        raise ValueError('Exact guest runtime bindings required')
    for name, digest in config['runtimePins'].items():
        if not re.fullmatch('[0-9a-f]{64}', digest):
            raise ValueError('Invalid runtime digest')
        path = Path(name); protected(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('Guest runtime changed')


def ensure_jwt(directory):
    st = directory.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError('Unprotected engine configuration directory')
    path = directory/'jwt.hex'
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'wb') as f:
            f.write(secrets.token_hex(32).encode('ascii'))
            f.flush(); os.fsync(f.fileno())
            os.fchown(f.fileno(), 0, GROUPS['rpcjwt'])
            os.fchmod(f.fileno(), 0o640)
            os.fsync(f.fileno())
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    st = protected(path, mode=0o640)
    if st.st_gid != GROUPS['rpcjwt'] or st.st_size != 64:
        raise ValueError('Existing JWT custody or size differs')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        actual = os.fstat(f.fileno())
        if (actual.st_dev, actual.st_ino) != (st.st_dev, st.st_ino) or not re.fullmatch(b'[0-9a-f]{64}', f.read(65)):
            raise ValueError('Invalid existing JWT; manual recovery required')


def initialize(config):
    check_context(config)
    users, groups = validate_accounts(Path('/etc/passwd').read_text(), Path('/etc/group').read_text())
    env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}
    def run(args):
        subprocess.run(args, check=True, timeout=5, env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for name, gid in GROUPS.items():
        if name not in groups:
            run(['/usr/sbin/groupadd', '--system', '--gid', str(gid), name])
    for name, (uid, gid) in ACCOUNTS.items():
        if name not in users:
            run(['/usr/sbin/useradd', '--system', '--uid', str(uid), '--gid', str(gid),
                 '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name])
    # Only unit-scoped SupplementaryGroups grants JWT access; no login membership.
    validate_accounts(Path('/etc/passwd').read_text(), Path('/etc/group').read_text(), complete=True)
    ensure_jwt(Path('/etc/enclave-rpc'))
    print(json.dumps({'identitiesVerified': True, 'engineSecretLocal': True, 'clientsStarted': False}))


if __name__ == '__main__':
    import sys
    path = Path(sys.argv[1]); protected(path, mode=0o644)
    initialize(json.loads(path.read_text()))
