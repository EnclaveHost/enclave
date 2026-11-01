#!/usr/bin/env python3
"""Assemble public native RPC client code and its pinned runtime dependencies.

Build-host tooling only: no mounts, subprocesses, network or client execution.
The result is input to a measured-image build, not proof of app admission.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile

ARCHIVE_SHA = '3f0bb020ee6c8b67217c55b4bd0208dd1a6c83ed76df21dbfdf34c6daa718e6c'
ARCHIVE_BYTES = 397926400
WRAPPER_SHA = '75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92'
BINARY_PINS = {'base': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f',
               'reth': '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250',
               'lighthouse': '11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96'}
PAYLOAD = {'opt/enclave-rpc/bin/' + n: h for n, h in BINARY_PINS.items()}
PAYLOAD['opt/enclave-rpc/chain_service.py'] = WRAPPER_SHA
PUBLIC_CONFIG = {'opt/enclave-rpc/manifest.json', 'etc/enclave-rpc/chain.json'}
OMIT = {'etc/enclave-rpc-vm/disks.json', *('etc/systemd/system/' + n for n in
        ('enclave-rpc-clients.slice', 'enclave-rpc-el.service', 'enclave-rpc-cl.service', 'enclave-rpc-base.service'))}
EXPECTED = set(PAYLOAD) | PUBLIC_CONFIG | OMIT
LIB_DIRS = ('usr/lib', 'lib', 'usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'lib64', 'usr/lib64')
SKIP = {'site-packages', 'dist-packages', 'test', 'tests', '__pycache__', 'idlelib', 'tkinter', 'ensurepip', 'turtledemo'}
MAX_FILE = 512 << 20
MAX_TOTAL = 768 << 20
MAX_COUNT = 10000
SONAME = re.compile(r'[A-Za-z0-9_+.-]+\.so(?:\.[A-Za-z0-9_+.-]+)*')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def snapshot(f):
    s = os.fstat(f.fileno())
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def open_file(path, limit=MAX_FILE):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    f = os.fdopen(fd, 'rb')
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o6000 or not 0 <= s.st_size <= limit:
        f.close()
        raise ValueError('bounded regular non-setid input required')
    return f


def sha(f):
    f.seek(0)
    h = hashlib.file_digest(f, 'sha256').hexdigest()
    f.seek(0)
    return h


def file_pin(path):
    with open_file(path) as f:
        before = snapshot(f)
        h = sha(f)
        if snapshot(f) != before:
            raise ValueError('source changed while hashing')
        return {'source': str(path), 'bytes': before[2], 'sha256': h}


def inside(root, relative):
    if relative.startswith('/'):
        relative = relative[1:]
    name(relative)
    resolved = (root / relative).resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError('source symlink escapes sysroot')
    return resolved


def name(value):
    if (not isinstance(value, str) or not value or len(value) > 255 or
            value.startswith('/') or '\\' in value or
            any(c in ('', '.', '..') for c in value.split('/')) or
            any(ord(c) < 32 or ord(c) > 126 for c in value)):
        raise ValueError('canonical relative path required')
    return value


def elf(f, size):
    """Read only bounded ELF64 program/dynamic tables, never execute an input."""
    def read(offset, length):
        if offset < 0 or length < 0 or offset + length > size or length > 1 << 20:
            raise ValueError('ELF range outside file/bound')
        f.seek(offset)
        data = f.read(length)
        if len(data) != length:
            raise ValueError('truncated ELF')
        return data
    header = read(0, 64)
    if header[:7] != b'\x7fELF\x02\x01\x01':
        raise ValueError('ELF64 little-endian version1 required')
    fields = struct.unpack('<16sHHIQQQIHHHHHH', header)
    if fields[1] not in (2, 3) or fields[2] != 62 or fields[3] != 1 or fields[8] != 64 or fields[9] != 56 or not 0 < fields[10] <= 256:
        raise ValueError('unsupported ELF header')
    loads, dynamics, interpreters = [], [], []
    for i in range(fields[10]):
        kind, flags, off, va, pa, length, mem, align = struct.unpack('<IIQQQQQQ', read(fields[5] + i * 56, 56))
        if off + length > size or length > mem:
            raise ValueError('invalid ELF segment')
        if kind == 1:
            loads.append((off, va, length))
        elif kind == 2:
            dynamics.append((off, length))
        elif kind == 3:
            raw = read(off, length)
            if not raw.endswith(b'\0') or b'\0' in raw[:-1]:
                raise ValueError('invalid ELF interpreter')
            path = raw[:-1].decode('ascii')
            if not path.startswith('/'):
                raise ValueError('absolute ELF interpreter required')
            name(path[1:])
            if not any(path.startswith('/' + d + '/') for d in LIB_DIRS):
                raise ValueError('interpreter outside library paths')
            interpreters.append(path[1:])
    if len(interpreters) > 1 or len(dynamics) > 1:
        raise ValueError('duplicate ELF interpreter/dynamic segment')
    if not dynamics:
        return interpreters, []
    off, length = dynamics[0]
    if not length or length % 16:
        raise ValueError('invalid dynamic table')
    raw = read(off, length)
    tags, needed, terminated = {}, [], False
    for i in range(0, length, 16):
        tag, value = struct.unpack_from('<qQ', raw, i)
        if tag == 0:
            terminated = True
            break
        if tag in (15, 29, 0x7fffffff, 0x7ffffffd):
            raise ValueError('ELF search overrides/filter libraries refused')
        if tag == 1:
            needed.append(value)
        elif tag in (5, 10):
            if tag in tags:
                raise ValueError('duplicate ELF string-table tag')
            tags[tag] = value
    if not terminated or len(needed) > 256:
        raise ValueError('unterminated/oversized dynamic dependencies')
    if not needed:
        return interpreters, []
    if set(tags) != {5, 10} or not 0 < tags[10] <= 1 << 20:
        raise ValueError('ELF string table missing or oversized')
    mappings = [off + tags[5] - va for off, va, length in loads if va <= tags[5] and tags[5] + tags[10] <= va + length]
    if len(mappings) != 1:
        raise ValueError('ambiguous/unmapped ELF string table')
    strings = read(mappings[0], tags[10])
    dependencies = []
    for offset in needed:
        if offset >= len(strings) or (end := strings.find(b'\0', offset)) < 0:
            raise ValueError('invalid ELF dependency string')
        dep = strings[offset:end].decode('ascii')
        if not SONAME.fullmatch(dep):
            raise ValueError('dependency must be a plain library soname')
        dependencies.append(dep)
    return interpreters, dependencies


def checked_runtime(stream):
    before = snapshot(stream)
    if before[2] != ARCHIVE_BYTES or sha(stream) != ARCHIVE_SHA:
        raise ValueError('reviewed runtime archive pin mismatch')
    result = {}
    with tarfile.open(fileobj=stream, mode='r:') as archive:
        for entry in archive:
            if (entry.name not in EXPECTED or entry.name in result or not entry.isfile() or
                    entry.pax_headers or entry.linkname or entry.uid or entry.gid or entry.mtime or
                    entry.mode != (0o755 if entry.name in PAYLOAD else 0o644) or
                    not 0 < entry.size <= MAX_FILE):
                raise ValueError('unexpected runtime archive member/metadata')
            with archive.extractfile(entry) as f:
                h = sha(f)
                if entry.name in PAYLOAD and h != PAYLOAD[entry.name]:
                    raise ValueError('maintained client/wrapper pin mismatch')
                result[entry.name] = {'bytes': entry.size, 'sha256': h}
        if set(result) != EXPECTED:
            raise ValueError('runtime archive member set incomplete')
    if snapshot(stream) != before:
        raise ValueError('runtime archive changed')
    stream.seek(0)
    return result


def publish(path, raw):
    with Path(path).open('xb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    sync_dir(Path(path).parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def plan(sysroot, runtime, output):
    root = Path(sysroot).resolve(strict=True)
    inputs, pending, parsed = {}, [], set()

    def add(virtual, source, executable=False):
        name(virtual)
        row = {**file_pin(source), 'mode': 0o555 if executable else 0o444}
        if virtual in inputs and inputs[virtual] != row:
            raise ValueError('conflicting root input')
        inputs[virtual] = row
        if executable and source not in parsed:
            parsed.add(source)
            with open_file(source) as f:
                before = snapshot(f)
                if sha(f) != row['sha256']:
                    raise ValueError('ELF source changed')
                pending.append(elf(f, row['bytes']))
                if before != snapshot(f):
                    raise ValueError('ELF changed during parsing')
        if len(inputs) > MAX_COUNT or sum(v['bytes'] for v in inputs.values()) > MAX_TOTAL:
            raise ValueError('root dependency bound exceeded')

    python = inside(root, 'usr/bin/python3')
    if not re.fullmatch(r'python3\.(11|12|13|14)', python.name):
        raise ValueError('supported explicit Python interpreter required')
    version = python.name[6:]
    stdlib = 'usr/lib/python' + version
    stdroot = inside(root, stdlib)
    add('usr/bin/python3', python, True)
    add('usr/bin/findmnt', inside(root, 'usr/bin/findmnt'), True)
    cert = inside(root, 'etc/ssl/certs/ca-certificates.crt')
    add('etc/ssl/certs/ca-certificates.crt', cert)
    add('etc/ssl/cert.pem', cert)  # OpenSSL default CA file, without host symlinks
    for source in sorted(stdroot.rglob('*')):
        rel = source.relative_to(stdroot)
        if (set(rel.parts) & SKIP or rel.name.startswith(('_test', '_ctypes_test', '_tkinter')) or
                rel.name in ('sitecustomize.py', 'usercustomize.py') or
                source.suffix not in ('.py', '.so')):
            continue
        add(stdlib + '/' + str(rel), inside(root, stdlib + '/' + str(rel)), source.suffix == '.so')
    for required in ('os.py', 'ssl.py', 'hashlib.py', 'tomllib/__init__.py', 'urllib/request.py', 'json/__init__.py', 'ctypes/__init__.py'):
        if stdlib + '/' + required not in inputs:
            raise ValueError('Python standard library incomplete')
    with open_file(runtime) as f:
        runtime_rows = checked_runtime(f)
        with tarfile.open(fileobj=f, mode='r:') as tar:
            for binary in BINARY_PINS:
                path = 'opt/enclave-rpc/bin/' + binary
                with tar.extractfile(path) as data:
                    pending.append(elf(data, runtime_rows[path]['bytes']))

    resolved_libraries = set()

    def library(dep, optional=False):
        if dep in resolved_libraries:
            return
        candidates = []
        for directory in LIB_DIRS:
            relative = directory + '/' + dep
            try:
                source = inside(root, relative)
            except FileNotFoundError:
                continue
            candidates.append((relative, source, file_pin(source)['sha256']))
        if not candidates:
            if optional:
                return
            raise ValueError('missing library: ' + dep)
        if len({c[2] for c in candidates}) != 1:
            raise ValueError('ambiguous library: ' + dep)
        resolved_libraries.add(dep)
        virtual, source, _ = candidates[0]
        add(virtual, source, True)

    for dep in ('libnss_dns.so.2', 'libnss_files.so.2'):
        library(dep, optional=True)
    while pending:
        interpreters, dependencies = pending.pop()
        for path in interpreters:
            add(path, inside(root, path), True)
        for dep in dependencies:
            library(dep)
    result = {'schema': 'enclave-rpc-native-root-plan/1', 'sysroot': str(root),
              'runtime': {'source': str(Path(runtime).resolve(strict=True)), 'bytes': ARCHIVE_BYTES, 'sha256': ARCHIVE_SHA},
              'pythonVersion': version, 'inputs': inputs,
              'payload': {k: v for k, v in runtime_rows.items() if k not in OMIT}}
    raw = canonical(result)
    if len(raw) > 4 << 20:
        raise ValueError('plan size bound')
    publish(output, raw)
    return result


def generated():
    passwd = 'root:x:0:0:root:/root:/nonexistent\n'
    group = 'root:x:0:\n'
    for i, role in enumerate(('el', 'cl', 'base', 'probe'), 2101):
        passwd += f'rpc{role}:x:{i}:{i}:RPC {role}:/nonexistent:/nonexistent\n'
        group += f'rpc{role}:x:{i}:\n'
    return {'etc/passwd': passwd.encode(), 'etc/group': group.encode(),
            'etc/enclave-rpc/native-root': b'enclave-rpc-native-root/1\nprofile=ethereum-base-rpc-v1\n',
            'etc/nsswitch.conf': b'passwd: files\ngroup: files\nhosts: files dns\n',
            'etc/hosts': b'127.0.0.1 localhost\n::1 localhost\n'}


def allowed_input(path, version):
    if path in ('usr/bin/python3', 'usr/bin/findmnt', 'etc/ssl/certs/ca-certificates.crt', 'etc/ssl/cert.pem'):
        return True
    prefix = 'usr/lib/python' + version + '/'
    if path.startswith(prefix):
        rel = PurePosixPath(path[len(prefix):])
        return not (set(rel.parts) & SKIP) and rel.suffix in ('.py', '.so') and not rel.name.startswith(('_test', '_ctypes_test', '_tkinter')) and rel.name not in ('sitecustomize.py', 'usercustomize.py')
    return any(path.startswith(d + '/') and SONAME.fullmatch(path[len(d) + 1:]) for d in LIB_DIRS)


def load_plan(path):
    with open_file(path, 4 << 20) as f:
        raw = f.read((4 << 20) + 1)
    p = json.loads(raw)
    if canonical(p) != raw or set(p) != {'schema', 'sysroot', 'runtime', 'pythonVersion', 'inputs', 'payload'} or p['schema'] != 'enclave-rpc-native-root-plan/1':
        raise ValueError('canonical native root plan required')
    version = p['pythonVersion']
    if version not in ('3.11', '3.12', '3.13', '3.14') or not isinstance(p['inputs'], dict) or not 1 <= len(p['inputs']) <= MAX_COUNT:
        raise ValueError('invalid root plan')
    required = {'usr/bin/python3', 'usr/bin/findmnt', 'etc/ssl/cert.pem', 'etc/ssl/certs/ca-certificates.crt'}
    required |= {'usr/lib/python' + version + '/' + part for part in
                 ('os.py', 'ssl.py', 'hashlib.py', 'tomllib/__init__.py', 'urllib/request.py', 'json/__init__.py', 'ctypes/__init__.py')}
    if not required <= set(p['inputs']):
        raise ValueError('planned Python runtime incomplete')
    root = Path(p['sysroot'])
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError('canonical sysroot required')
    for path, row in p['inputs'].items():
        name(path)
        if not allowed_input(path, version) or set(row) != {'source', 'bytes', 'sha256', 'mode'}:
            raise ValueError('unexpected planned root input')
        source = Path(row['source'])
        if not source.is_absolute() or source.resolve(strict=True) != source or not source.is_relative_to(root):
            raise ValueError('planned source escaped or changed resolution')
        if type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_FILE or row['mode'] not in (0o444, 0o555) or not re.fullmatch('[0-9a-f]{64}', row['sha256']):
            raise ValueError('invalid planned pin')
    if set(p['runtime']) != {'source', 'bytes', 'sha256'} or p['runtime']['sha256'] != ARCHIVE_SHA or p['runtime']['bytes'] != ARCHIVE_BYTES:
        raise ValueError('runtime plan pin changed')
    if set(p['payload']) != set(PAYLOAD) | PUBLIC_CONFIG:
        raise ValueError('planned payload set changed')
    return p


def write_member(tar, path, f, size, expected, mode, records):
    name(path)
    if path in records or size < 0 or size > MAX_FILE or len(records) >= MAX_COUNT:
        raise ValueError('duplicate/oversized root member')
    if sum(row['bytes'] for row in records.values()) + size > MAX_TOTAL:
        raise ValueError('total root size exceeded')
    f.seek(0)
    if sha(f) != expected:
        raise ValueError('source pin changed before copy')
    info = tarfile.TarInfo(path)
    info.size, info.mode = size, mode
    info.uid = info.gid = info.mtime = 0
    tar.addfile(info, f)
    if sha(f) != expected:
        raise ValueError('source pin changed after copy')
    records[path] = {'bytes': size, 'sha256': expected, 'mode': mode, 'uid': 0, 'gid': 0}


def readback(path, files, directories):
    seen = set()
    with tarfile.open(path, 'r:') as archive:
        for entry in archive:
            if entry.name in seen or entry.uid or entry.gid or entry.mtime or entry.pax_headers or entry.linkname:
                raise ValueError('root readback metadata mismatch')
            seen.add(entry.name)
            if entry.name in directories:
                if not entry.isdir() or entry.size or entry.mode != directories[entry.name]:
                    raise ValueError('root directory readback mismatch')
            elif entry.name in files:
                row = files[entry.name]
                if not entry.isfile() or entry.size != row['bytes'] or entry.mode != row['mode']:
                    raise ValueError('root file readback mismatch')
                with archive.extractfile(entry) as f:
                    if sha(f) != row['sha256']:
                        raise ValueError('root bytes readback mismatch')
            else:
                raise ValueError('unexpected root member')
    if seen != set(files) | set(directories):
        raise ValueError('missing root member')


def assemble(plan_path, output):
    p = load_plan(plan_path)
    output = Path(output)
    g = generated()
    all_files = set(p['inputs']) | set(p['payload']) | set(g)
    if len(all_files) != len(p['inputs']) + len(p['payload']) + len(g):
        raise ValueError('overlapping root inputs')
    dirs = {d: 0o755 for d in ('proc', 'sys', 'dev', 'run', 'tmp', 'var/tmp', 'root',
            'srv/enclave-l1-pair', 'srv/enclave-base-holder', 'etc/enclave-rpc/coverage', 'etc/enclave-rpc-vm')}
    for path in all_files | set(dirs):
        for parent in PurePosixPath(path).parents:
            if str(parent) != '.':
                dirs[str(parent)] = 0o755
    dirs['root'] = 0o700
    if all_files & set(dirs):
        raise ValueError('file/directory collision')
    with open_file(p['runtime']['source']) as runtime:
        original = snapshot(runtime)
        rows = checked_runtime(runtime)
        if {k: v for k, v in rows.items() if k not in OMIT} != p['payload']:
            raise ValueError('runtime plan differs from reviewed bytes')
        output.mkdir(mode=0o700)
        publish(output / 'PLAN.json', canonical(p))
        records = {}
        path = output / 'root.tar'
        with path.open('xb') as destination:
            with tarfile.open(fileobj=destination, mode='w', format=tarfile.USTAR_FORMAT) as tar:
                for directory, mode in sorted(dirs.items()):
                    entry = tarfile.TarInfo(directory)
                    entry.type, entry.mode = tarfile.DIRTYPE, mode
                    tar.addfile(entry)
                for virtual, row in sorted(p['inputs'].items()):
                    with open_file(row['source']) as f:
                        before = snapshot(f)
                        if before[2] != row['bytes']:
                            raise ValueError('source size changed')
                        write_member(tar, virtual, f, row['bytes'], row['sha256'], row['mode'], records)
                        if snapshot(f) != before:
                            raise ValueError('source changed during copy')
                runtime.seek(0)
                with tarfile.open(fileobj=runtime, mode='r:') as source_tar:
                    for virtual, row in sorted(p['payload'].items()):
                        with source_tar.extractfile(virtual) as f:
                            write_member(tar, virtual, f, row['bytes'], row['sha256'], 0o555 if virtual in PAYLOAD else 0o444, records)
                for virtual, raw in sorted(g.items()):
                    write_member(tar, virtual, io.BytesIO(raw), len(raw), hashlib.sha256(raw).hexdigest(), 0o444, records)
            destination.flush()
            os.fsync(destination.fileno())
        if snapshot(runtime) != original or sha(runtime) != ARCHIVE_SHA:
            raise ValueError('runtime archive changed during assembly')
    readback(path, records, dirs)
    inventory = {'files': records, 'directories': dirs, 'planSha256': hashlib.sha256(canonical(p)).hexdigest()}
    publish(output / 'INVENTORY.json', canonical(inventory))
    with open_file(path, 1 << 30) as f:
        receipt = {'schema': 'enclave-rpc-native-root/1', 'rootTarSha256': sha(f), 'rootTarBytes': snapshot(f)[2],
                   'files': len(records), 'directories': len(dirs), 'planSha256': inventory['planSha256'],
                   'inventorySha256': hashlib.sha256(canonical(inventory)).hexdigest(), 'runtimeArchiveSha256': ARCHIVE_SHA,
                   'readbackVerified': True, 'attestationQualified': False, 'storageBound': False,
                   'monitorIntegrated': False, 'rpcReady': False}
    publish(output / 'RESULT.json', canonical(receipt))
    sync_dir(output.parent)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('plan')
    p.add_argument('--sysroot', type=Path, required=True)
    p.add_argument('--runtime-tar', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = commands.add_parser('assemble')
    a.add_argument('--plan', type=Path, required=True)
    a.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'plan':
        result = plan(args.sysroot, args.runtime_tar, args.output)
        print(json.dumps({'plannedInputs': len(result['inputs']), 'nativeClientsExecuted': False}))
    else:
        print(json.dumps(assemble(args.plan, args.output)))
