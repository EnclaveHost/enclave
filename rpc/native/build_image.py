#!/usr/bin/env python3
"""Turn a reviewed RPC root archive into an offline ext4 + dm-verity pair.

No loop device, mount, VM, network or client process is used. This is a build
artifact, not an attested deployment. The complete platform descriptor must
still bind this root to its kernel, supervisor, controller and storage policy.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile

BLOCK = 4096
IMAGE_BYTES = 1 << 30
MAX_ARCHIVE = 1 << 30
TOOLS = ('/usr/sbin/mke2fs', '/usr/sbin/veritysetup')


def digest(stream):
    stream.seek(0)
    result = hashlib.file_digest(stream, 'sha256').hexdigest()
    stream.seek(0)
    return result


def identity(stream):
    s = os.fstat(stream.fileno())
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    stream = os.fdopen(fd, 'rb')
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or not 0 < s.st_size <= limit:
        stream.close()
        raise ValueError('bounded regular input required')
    return stream


def validate_archive(stream):
    """Reject tar features that could acquire authority outside a new image."""
    stream.seek(0)
    names, files, total = set(), set(), 0
    with tarfile.open(fileobj=stream, mode='r:') as archive:
        for entry in archive:
            name = entry.name
            if (not name or name.startswith('/') or '\\' in name or
                    any(p in ('', '.', '..') for p in name.split('/')) or
                    any(ord(c) < 32 or ord(c) > 126 for c in name) or
                    name in names or len(name) > 255 or len(names) >= 10000):
                raise ValueError('noncanonical or duplicate archive path')
            if (not (entry.isdir() or entry.isfile()) or entry.pax_headers or
                    entry.uid != 0 or entry.gid != 0 or entry.mtime != 0 or
                    entry.mode not in (0o444, 0o555, 0o700, 0o755) or
                    entry.linkname or entry.size < 0):
                raise ValueError('unsupported root archive metadata')
            parents = name.split('/')[:-1]
            if any('/'.join(parents[:i + 1]) in files for i in range(len(parents))):
                raise ValueError('file used as archive ancestor')
            if entry.isfile():
                if any(n.startswith(name + '/') for n in names):
                    raise ValueError('file replaces archive ancestor')
                files.add(name)
                total += entry.size
            elif entry.size:
                raise ValueError('directory payload')
            if entry.size > 512 << 20 or total > 768 << 20:
                raise ValueError('root payload exceeds fixed image budget')
            names.add(name)
        required = {'usr/bin/python3', 'usr/bin/findmnt',
                    'opt/enclave-rpc/chain_service.py', 'opt/enclave-rpc/manifest.json',
                    'opt/enclave-rpc/bin/reth', 'opt/enclave-rpc/bin/lighthouse',
                    'opt/enclave-rpc/bin/base', 'etc/enclave-rpc/native-root'}
        if not required <= files:
            raise ValueError('RPC runtime archive incomplete')
    stream.seek(0)
    return len(names), total


def tree_bytes(blocks):
    result = 0
    while blocks > 1:
        blocks = (blocks + 127) // 128
        result += blocks * BLOCK
    return result


def write_json(path, value):
    with path.open('x') as out:
        json.dump(value, out, sort_keys=True, indent=2)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())


def build(archive_path, expected, output):
    if not re.fullmatch('[0-9a-f]{64}', expected) or expected == '0' * 64:
        raise ValueError('explicit reviewed archive sha256 required')
    output = Path(output)
    with regular(archive_path, MAX_ARCHIVE) as archive:
        before = identity(archive)
        if digest(archive) != expected:
            raise ValueError('archive pin mismatch')
        count, payload = validate_archive(archive)
        tools = {}
        for path in TOOLS:
            with regular(Path(path).resolve(strict=True), 32 << 20) as f:
                tools[path] = digest(f)
        output.mkdir(mode=0o700)  # exclusive; all partial artifacts retained
        with (output / 'root.img').open('x+b') as root, (output / 'hash.img').open('x+b') as hashes:
            root.truncate(IMAGE_BYTES)
            root.flush()
            os.fsync(root.fileno())
            paths = [f'/proc/self/fd/{f.fileno()}' for f in (archive, root, hashes)]
            salt = hashlib.sha256(b'enclave-rpc-root-verity/1\0' + bytes.fromhex(expected)).hexdigest()
            env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
                   'HOME': '/nonexistent', 'MKE2FS_CONFIG': '/dev/null'}
            common = ['--no-superblock', '--format=1', '--hash=sha256',
                      '--data-block-size=4096', '--hash-block-size=4096', '--salt=' + salt]
            commands = [
                [TOOLS[0], '-q', '-F', '-t', 'ext4', '-b', str(BLOCK), '-I', '256', '-m', '0',
                 '-L', 'enclave-rpc-root', '-U', 'c0d687e2-4128-4eae-b245-93bef22df171',
                 '-O', 'none,extent,64bit,flex_bg,sparse_super,large_file,huge_file,dir_nlink,extra_isize,metadata_csum,filetype',
                 '-E', 'root_owner=0:0,lazy_itable_init=0,lazy_journal_init=0',
                 '-d', paths[0], paths[1], str(IMAGE_BYTES // BLOCK)],
                [TOOLS[1], 'format', *common, paths[1], paths[2]],
            ]
            write_json(output / 'BUILD-INTENT.json', {'archiveSha256': expected, 'tools': tools,
                       'commands': commands, 'imageBytes': IMAGE_BYTES, 'members': count,
                       'payloadBytes': payload, 'oneShot': True})
            for directory in (output, output.parent):
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)

            def run(command, name):
                # Whole build is additionally owned by a bounded outer cgroup.
                # Tools receive only these three regular-file descriptors.
                with (output / name).open('xb') as log:
                    subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   env=env, pass_fds=tuple(f.fileno() for f in (archive, root, hashes)),
                                   timeout=90, check=True)
                    log.flush()
                    os.fsync(log.fileno())

            run(commands[0], 'MKE2FS.log')
            run(commands[1], 'VERITY-FORMAT.log')
            with (output / 'VERITY-FORMAT.log').open('rb') as log:
                raw = log.read(16385)
            if len(raw) > 16384:
                raise ValueError('oversized verity receipt')
            matches = re.findall(rb'^Root hash:\s*([0-9a-f]{64})\s*$', raw, re.M)
            if len(matches) != 1:
                raise ValueError('missing unique verity root')
            root_hash = matches[0].decode('ascii')
            verify = [TOOLS[1], 'verify', *common, paths[1], paths[2], root_hash]
            run(verify, 'VERITY-VERIFY.log')
            for f in (root, hashes):
                f.flush()
                os.fsync(f.fileno())
            if os.fstat(root.fileno()).st_size != IMAGE_BYTES or os.fstat(hashes.fileno()).st_size != tree_bytes(IMAGE_BYTES // BLOCK):
                raise ValueError('unexpected image or hash-tree geometry')
            if identity(archive) != before or digest(archive) != expected:
                raise ValueError('archive changed during image construction')
            for path, pin in tools.items():
                with regular(Path(path).resolve(strict=True), 32 << 20) as f:
                    if digest(f) != pin:
                        raise ValueError('build tool changed')
            descriptor = {'dataBlocks': IMAGE_BYTES // BLOCK, 'hashBytes': os.fstat(hashes.fileno()).st_size,
                          'hashSha256': digest(hashes), 'imageBytes': IMAGE_BYTES, 'imageSha256': digest(root),
                          'rootHash': root_hash, 'salt': salt}
            write_json(output / 'root-volume.json', descriptor)
            receipt = {'schema': 'enclave-rpc-native-root-image/1', 'root': descriptor,
                       'archiveSha256': expected, 'tools': tools, 'verifyCommand': verify,
                       'verityVerified': True, 'mounted': False, 'attestationQualified': False,
                       'monitorIntegrated': False, 'storageBound': False, 'rpcReady': False}
            write_json(output / 'RESULT.json', receipt)
        fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.archive, args.sha256, args.output)))
