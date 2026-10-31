#!/usr/bin/env python3
"""Package exact public RPC client inputs; never install, mount or start them."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import uuid

BINARY_PINS = {
    'base': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f',
    'reth': '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250',
    'lighthouse': '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96',
}
MOUNTS = {'l1': '/srv/enclave-l1-pair', 'base': '/srv/enclave-base-holder'}
MAXIMUM_BYTES = 512 * 1024**2


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def public_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > 65536:
            raise ValueError('Bounded regular public configuration required')
        raw = stream.read(65537)
        after = os.fstat(stream.fileno())
        if len(raw) > 65536 or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Public configuration changed during read')
        return json.loads(raw)


def disk_config(value):
    if not isinstance(value, dict) or set(value) != {'disks'}:
        raise ValueError('Explicit two-volume configuration required')
    rows = value['disks']
    if not isinstance(rows, list) or len(rows) != 2:
        raise ValueError('Both L1 and Base volumes required')
    roles, ids = set(), set()
    for row in rows:
        if set(row) != {'role', 'mount', 'uuid'}:
            raise ValueError('Exact volume fields required')
        role, identity = row['role'], row['uuid']
        if role not in MOUNTS or role in roles or row['mount'] != MOUNTS[role]:
            raise ValueError('Volume role/mount differs')
        if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity or identity in ids or uuid.UUID(identity).int == 0:
            raise ValueError('Distinct canonical filesystem UUIDs required')
        roles.add(role)
        ids.add(identity)
    return value


def add_bytes(archive, name, data, mode, records):
    if name in records:
        raise ValueError('Duplicate member')
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), mode
    info.uid = info.gid = info.mtime = 0
    archive.addfile(info, io.BytesIO(data))
    records[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mode': mode}


def add_binary(archive, name, path, expected, records):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAXIMUM_BYTES:
            raise ValueError('Bounded regular binary required')
        if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
            raise ValueError('Binary digest mismatch: ' + name)
        stream.seek(0)
        info = tarfile.TarInfo(name)
        info.size, info.mode = before.st_size, 0o755
        info.uid = info.gid = info.mtime = 0
        archive.addfile(info, stream)
        after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Binary changed during packaging')
        records[name] = {'bytes': before.st_size, 'sha256': expected, 'mode': 0o755}


def verify_archive(path, records):
    with tarfile.open(path, 'r:') as archive:
        members = archive.getmembers()
        if len(members) != len(records) or {m.name for m in members} != set(records):
            raise ValueError('Archive members differ')
        for member in members:
            row = records[member.name]
            if not member.isfile() or member.size != row['bytes'] or member.mode != row['mode'] or member.uid != 0 or member.gid != 0:
                raise ValueError('Archive metadata differs')
            with archive.extractfile(member) as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != row['sha256']:
                    raise ValueError('Archived bytes differ')


def prepare(binary_dir, manifest_path, chain_path, disks_path, output):
    manifest, chain = public_config(manifest_path), public_config(chain_path)
    disks = disk_config(public_config(disks_path))
    if manifest.get('format') != 'enclave-rpc-production-bootstrap/v1' or manifest.get('binaries') != BINARY_PINS or manifest.get('mounts') != MOUNTS or manifest.get('servingProduction') is not False:
        raise ValueError('Exact reviewed client/mount manifest required')
    if set(chain) != {'checkpoint', 'txForwarding', 'baseBootstrap', 'baseRetention'}:
        raise ValueError('Explicit chain configuration required')
    output.mkdir(mode=0o700)  # A partial attempt is retained, never overwritten.
    records, source = {}, Path(__file__).resolve().parent
    path = output / 'runtime.tar'
    with path.open('xb') as destination, tarfile.open(fileobj=destination, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, digest in sorted(BINARY_PINS.items()):
            add_binary(archive, 'opt/enclave-rpc/bin/' + name, binary_dir / name, digest, records)
        add_bytes(archive, 'opt/enclave-rpc/chain_service.py', (source / 'chain_service.py').read_bytes(), 0o755, records)
        for name, value in [('opt/enclave-rpc/manifest.json', manifest), ('etc/enclave-rpc/chain.json', chain), ('etc/enclave-rpc-vm/disks.json', disks)]:
            add_bytes(archive, name, encoded(value), 0o644, records)
        for name in ['enclave-rpc-clients.slice', 'enclave-rpc-el.service', 'enclave-rpc-cl.service', 'enclave-rpc-base.service']:
            file = source / 'units' / name
            add_bytes(archive, 'etc/systemd/system/' + file.name, file.read_bytes(), 0o644, records)
        if sum(r['bytes'] for r in records.values()) > MAXIMUM_BYTES:
            raise ValueError('Runtime payload exceeds 512MiB packaging bound')
    verify_archive(path, records)
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = {'schema': 'owned-rpc-guest-bundle/1', 'archiveSha256': digest,
              'archiveBytes': path.stat().st_size, 'members': records,
              'clientsBudgetBytes': 17 * 1024**3, 'guestOsBudgetBytes': 2 * 1024**3,
              'hostSupportBudgetBytes': 1024**3, 'wholeStackBudgetBytes': 20 * 1024**3,
              'readbackVerified': True, 'installed': False, 'rpcReady': False,
              'baseCoverageApproved': False,
              'remaining': ['offline guest installation and UID mapping',
                            'guest-local engine JWT generation with scoped access',
                            'exclusive state export and authenticated attachment',
                            'actual client startup and whole-stack fit',
                            'Base coverage validation, sync and finality',
                            'consumer cutover and independent recovery proofs']}
    (output / 'RESULT.json').write_bytes(encoded(result))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['binaries', 'manifest', 'chain', 'disks', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    result = prepare(args.binaries, args.manifest, args.chain, args.disks, args.output)
    print(json.dumps({k: v for k, v in result.items() if k != 'members'}))
