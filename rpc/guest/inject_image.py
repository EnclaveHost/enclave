#!/usr/bin/env python3
"""Install a pinned public runtime into a new offline Ubuntu image, without mounts.

Only private new files are modified. Run under an independently bounded unit.
No VM, guest code, service, account migration or database operation is performed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import tarfile
import time
import zlib

GIB = 1024**3
SOURCE_SHA = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
VIRTUAL_BYTES = 3758096384


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def root_partition(stream, size):
    stream.seek(512)
    header = bytearray(stream.read(512))
    if header[:8] != b'EFI PART' or struct.unpack_from('<I', header, 12)[0] != 92:
        raise ValueError('Expected GPT header')
    crc = struct.unpack_from('<I', header, 16)[0]
    struct.pack_into('<I', header, 16, 0)
    if zlib.crc32(header[:92]) != crc:
        raise ValueError('GPT header checksum')
    table_lba, count, width, table_crc = struct.unpack_from('<QIII', header, 72)
    if not 1 <= count <= 128 or width != 128 or table_lba * 512 + count * width > size:
        raise ValueError('Bounded GPT table required')
    stream.seek(table_lba * 512)
    table = stream.read(count * width)
    if len(table) != count * width or zlib.crc32(table) != table_crc:
        raise ValueError('GPT table checksum')
    ranges = []
    for i in range(count):
        row = table[i*width:(i+1)*width]
        if row[:16] == bytes(16):
            continue
        first, last = struct.unpack_from('<QQ', row, 32)
        if first < 34 or last < first or (last+1)*512 > size-33*512:
            raise ValueError('Invalid partition bounds')
        ranges.append((first, last, i))
    for left, right in zip(sorted(ranges), sorted(ranges)[1:]):
        if left[1] >= right[0]:
            raise ValueError('Overlapping partitions')
    first, last, _ = next(row for row in ranges if row[2] == 0)
    offset, length = first*512, (last-first+1)*512
    stream.seek(offset+1024)
    sb = stream.read(1024)
    if sb[56:58] != b'\x53\xef' or sb[120:136].rstrip(b'\0') != b'cloudimg-rootfs':
        raise ValueError('Expected Ubuntu root ext4 label')
    return offset, length


def safe_member(name):
    p = PurePosixPath(name)
    if str(p) != name or p.is_absolute() or any(x in ('.', '..') for x in p.parts):
        raise ValueError('Unsafe archive path')
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or not name.startswith(('opt/enclave-rpc/', 'etc/enclave-rpc/', 'etc/enclave-rpc-vm/', 'etc/systemd/system/enclave-rpc-')):
        raise ValueError('Unexpected runtime destination')
    return name


def copy_range(source, target, length, guard, sparse=False):
    left = length
    while left:
        guard()
        raw = source.read(min(left, 1024**2))
        if not raw:
            raise ValueError('Short source')
        if sparse and not any(raw):
            target.seek(len(raw), 1)
        else:
            target.write(raw)
        left -= len(raw)
    if sparse:
        target.truncate(target.tell())


def install(config):
    source, bundle, receipt, output = (Path(config[k]) for k in ['source', 'bundle', 'receipt', 'output'])
    if any(p.is_symlink() or not p.is_file() for p in [source, bundle, receipt]):
        raise ValueError('Regular original inputs required')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(output)):
        raise ValueError('Unambiguous private output path required')
    output.mkdir(mode=0o700)
    origin = time.monotonic()
    deadline = origin + 600
    minimum_memory, minimum_disk = 2**64, 2**64
    tools = {k: Path(v['path']) for k, v in config['tools'].items()}
    if set(tools) != {'qemu-img', 'debugfs', 'e2fsck'}:
        raise ValueError('Exact offline tool closure required')
    for k, path in tools.items():
        if sha(path) != config['tools'][k]['sha256']:
            raise ValueError('Tool digest changed: '+k)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LD_LIBRARY_PATH': config['libraryPath']}

    def guard():
        nonlocal minimum_memory, minimum_disk
        mem = next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
        disk = os.statvfs(output); free = disk.f_bavail*disk.f_frsize
        minimum_memory, minimum_disk = min(minimum_memory, mem), min(minimum_disk, free)
        if mem < 2*GIB or free < 16*GIB or time.monotonic() >= deadline:
            raise RuntimeError('Offline preparation resource/deadline guard')
        vhd = output/'boot.vhdx'
        if vhd.exists() and vhd.stat().st_size > 4*GIB:
            raise RuntimeError('Boot artifact exceeds 4GiB')

    serial = 0
    def run(argv):
        nonlocal serial
        guard(); serial += 1; log = output/('step-%03d.txt' % serial)
        with log.open('xb') as f:
            proc = subprocess.Popen([str(a) for a in argv], stdout=f, stderr=subprocess.STDOUT, env=env)
            try:
                while proc.poll() is None:
                    guard()
                    if log.stat().st_size > 4*1024**2:
                        raise RuntimeError('Diagnostic limit')
                    time.sleep(.05)
                if proc.returncode:
                    raise RuntimeError('Offline tool failed at '+log.name+':'+str(proc.returncode))
            finally:
                if proc.poll() is None:
                    proc.kill(); proc.wait()
        guard()
        return log.read_text()

    guard(); before = source.stat()
    if sha(source) != SOURCE_SHA or sha(bundle) != config['bundleSha256'] or sha(receipt) != config['receiptSha256']:
        raise ValueError('Input digest mismatch')
    records = json.loads(receipt.read_text())
    if records['archiveSha256'] != config['bundleSha256'] or records['rpcReady'] is not False:
        raise ValueError('Unqualified runtime receipt required')
    qemu = tools['qemu-img']
    info = json.loads(run([qemu, 'info', '-f', 'qcow2', '--output=json', source]))
    if info.get('backing-filename') or info.get('dirty-flag', False) or info['virtual-size'] != VIRTUAL_BYTES:
        raise ValueError('Expected clean standalone Ubuntu source')
    raw, root = output/'disk.raw', output/'root.ext4'
    run([qemu, 'convert', '-m', '1', '-f', 'qcow2', '-O', 'raw', source, raw])
    with raw.open('rb') as f:
        offset, length = root_partition(f, raw.stat().st_size)
        f.seek(offset)
        with root.open('xb') as dst:
            copy_range(f, dst, length, guard, sparse=True)
    run([tools['e2fsck'], '-f', '-n', root])
    extracted, readback = output/'payload', output/'readback'
    extracted.mkdir(); readback.mkdir()
    with tarfile.open(bundle, 'r:') as archive:
        members = archive.getmembers()
        if len(members) != len(records['members']) or len(members) != 11 or {m.name for m in members} != set(records['members']):
            raise ValueError('Exact eleven runtime members required')
        for m in members:
            safe_member(m.name); row = records['members'][m.name]
            if not m.isfile() or m.uid or m.gid or m.size != row['bytes'] or m.mode != row['mode']:
                raise ValueError('Unexpected runtime member metadata')
            dst = extracted/m.name; dst.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(m) as src, dst.open('xb') as target:
                copy_range(src, target, m.size, guard)
            if sha(dst) != row['sha256']:
                raise ValueError('Runtime member hash mismatch')
    def stat_path(path):
        return run([tools['debugfs'], '-R', 'stat '+path, root])
    parents = set()
    for name in records['members']:
        parents.update('/'+str(p) for p in PurePosixPath(name).parents if str(p) != '.')
    for parent in sorted(parents, key=lambda x:(x.count('/'), x)):
        found = stat_path(parent)
        if 'File not found' in found:
            run([tools['debugfs'], '-w', '-R', 'mkdir '+parent, root])
            found = stat_path(parent)
        if 'Type: directory' not in found:
            raise ValueError('Guest parent is not a directory: '+parent)
    commands = []
    for name, row in records['members'].items():
        if 'File not found' not in stat_path('/'+name):
            raise ValueError('Refusing to overwrite guest file: '+name)
        commands += ['write '+str(extracted/name)+' /'+name,
                     'set_inode_field /'+name+' mode '+oct(0o100000 | row['mode'])[2:],
                     'set_inode_field /'+name+' uid 0', 'set_inode_field /'+name+' gid 0']
    # debugfs numeric mode parser accepts C-style octal with leading zero.
    commands = [re.sub(r' mode ([0-7]+)$', r' mode 0\1', c) for c in commands]
    script = output/'install.debugfs'; script.write_text('\n'.join(commands)+'\n')
    run([tools['debugfs'], '-w', '-f', script, root])
    for i, (name, row) in enumerate(records['members'].items()):
        dst = readback/str(i)
        run([tools['debugfs'], '-R', 'dump /'+name+' '+str(dst), root])
        meta = stat_path('/'+name)
        if sha(dst) != row['sha256'] or 'Type: regular' not in meta or not re.search(r'Mode:\s+0?'+format(row['mode'],'o')+r'\b', meta) or not re.search(r'User:\s+0\s+Group:\s+0\b', meta):
            raise ValueError('Installed file readback differs: '+name)
    run([tools['e2fsck'], '-f', '-n', root])
    root_sha = sha(root)
    with root.open('rb') as src, raw.open('r+b') as dst:
        dst.seek(offset); copy_range(src, dst, length, guard)
    with raw.open('rb') as src:
        src.seek(offset); h = hashlib.sha256(); left = length
        while left:
            guard(); chunk=src.read(min(left,1024**2)); h.update(chunk); left-=len(chunk)
        if h.hexdigest() != root_sha:
            raise ValueError('Partition reassembly mismatch')
    run([qemu, 'convert', '-m', '1', '-f', 'raw', '-O', 'vhdx', '-o', 'subformat=dynamic,block_size=1048576', raw, output/'boot.vhdx'])
    run([qemu, 'compare', '-f', 'raw', '-F', 'vhdx', raw, output/'boot.vhdx'])
    after = source.stat()
    if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or sha(source) != SOURCE_SHA:
        raise ValueError('Original source changed')
    guard()
    result={'schema':'rpc-offline-image/1','sourceSha256':SOURCE_SHA,'bundleSha256':config['bundleSha256'],'installedFiles':records['members'],'rootPartitionOffset':offset,'rootPartitionBytes':length,'filesystemChecksPassed':True,'installedReadbackPassed':True,'logicalComparePassed':True,'sourceUnchanged':True,'bytes':(output/'boot.vhdx').stat().st_size,'sha256':sha(output/'boot.vhdx'),'elapsedSeconds':time.monotonic()-origin,'minimumMemoryBytes':minimum_memory,'minimumDiskBytes':minimum_disk,'bootQualified':False,'accountsConfigured':False,'storageAttached':False,'rpcReady':False,'invocation':os.environ.get('INVOCATION_ID')}
    (output/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');return result

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--config',required=True)
    args=parser.parse_args();print(json.dumps(install(json.loads(Path(args.config).read_text()))))
