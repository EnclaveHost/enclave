"""Exclusive COW + authenticated NBD data path; no production launcher.

The caller owns independently enforced resource/deadline admission and credential
provisioning. This module neither admits a host nor adopts a running export.
Original images are never opened writable by this module. Failed attempts remain
consumed and their overlay is retained for recovery, never silently retried.
"""
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import time

TOOLS = {
    '/usr/bin/qemu-img': '3a57bce6765bfb73a75591dba2ac40d985cccde97d371e95537ecbf16d949d30',
    '/usr/sbin/qemu-nbd': 'b0f16ff7225e78469733132fce225b1d0af98f0b681a5092d85618936ff61934',
}


def metadata(path):
    s = Path(path).lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid not in (0, os.geteuid()) or s.st_mode & 0o022:
        raise ValueError('Owned regular image required')
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns]


def directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path or ',' in str(path):
        raise ValueError('Canonical directory required')
    for p in [path, *path.parents]:
        s = p.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0, os.geteuid()) or s.st_mode & 0o022:
            raise ValueError('Directory authority is not exclusive')
    return path


def tool_pins():
    for name, expected in TOOLS.items():
        with open(name, 'rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != expected:
                raise ValueError('Export tool pin changed')


def chain_options(paths):
    # Explicit read-only backing nodes. No shell or QemuOpts delimiter injection.
    out = []
    for index, path in enumerate(paths):
        if any(c in str(path) for c in [',', '\n', '\r', '\0']):
            raise ValueError('Unsafe block option path')
        prefix = 'backing.' * index
        out.extend([prefix + 'driver=qcow2', prefix + 'file.driver=file',
                    prefix + 'file.filename=' + str(path)])
        if index:
            out.extend([prefix + 'read-only=on', prefix + 'file.read-only=on'])
    return ','.join(out)


def validate_chain(rows, paths, size):
    if len(rows) != len(paths):
        raise ValueError('Unexpected backing chain')
    for i, (row, path) in enumerate(zip(rows, paths)):
        if row['filename'] != str(path) or row['format'] != 'qcow2' or row['virtual-size'] != size:
            raise ValueError('Wrong backing identity/format/size')
        data = row.get('format-specific', {}).get('data', {})
        if row.get('dirty-flag') is not False or data.get('corrupt') is not False or row.get('encrypted', False):
            raise ValueError('Unclean/encrypted backing refused')
        if any(k in data or k in row for k in ['data-file', 'data-file-raw', 'encrypt']):
            raise ValueError('External image data refused')
        children = row.get('children', [])
        if len(children) != 1 or children[0]['name'] != 'file':
            raise ValueError('Unexpected image children')
        child = children[0]['info']
        if child['filename'] != str(path) or child['format'] != 'file' or child.get('children') or child.get('backing-filename'):
            raise ValueError('Unexpected file driver')
        expected = str(paths[i+1]) if i+1 < len(paths) else None
        if row.get('backing-filename') != expected or row.get('full-backing-filename', expected) != expected:
            raise ValueError('Backing path changed')
        if expected is not None and row.get('backing-filename-format') != 'qcow2':
            raise ValueError('Backing format not explicit')


class CowExport:
    def __init__(self, parent, attempt, role, originals, size, tls, host, port, deadline):
        if not re.fullmatch('[a-f0-9]{32}', attempt) or role not in ('l1', 'base'):
            raise ValueError('Exact attempt and role required')
        if type(size) is not int or size <= 0 or size % 4096:
            raise ValueError('Aligned volume size required')
        ip = ipaddress.ip_address(host)
        if ip.is_unspecified or ip.is_multicast or ip.is_link_local:
            raise ValueError('Explicit unicast bind required')
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError('Invalid port')
        if not 0 < deadline - time.monotonic() <= 900:
            raise ValueError('Original finite deadline required')
        if not 1 <= len(originals) <= 3:
            raise ValueError('Bounded original chain required')
        self.parent = directory(parent)
        self.tls = directory(tls)
        for name in ('ca-cert.pem', 'server-cert.pem', 'server-key.pem'):
            p = self.tls / name
            metadata(p)
            if stat.S_IMODE(p.stat().st_mode) != 0o600 or not 0 < p.stat().st_size <= 16384:
                raise ValueError('Private bounded TLS files required')
        self.originals = [(Path(p), expected) for p, expected in originals]
        if len({str(p) for p, _ in self.originals}) != len(self.originals):
            raise ValueError('Repeated backing path')
        for p, expected in self.originals:
            directory(p.parent)
            if p.resolve(strict=True) != p or metadata(p) != expected:
                raise ValueError('Original image identity changed')
        self.root = self.parent / (attempt + '-' + role)
        self.overlay = self.root / 'overlay.qcow2'
        self.name = 'rpc-' + attempt + '-' + role
        self.client_dn = 'CN=rpc-client-' + attempt + '-' + role
        self.host, self.port, self.size, self.deadline = host, port, size, deadline
        self.held, self.proc, self.log = [], None, None
        self.consumed = False

    def check(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Original export deadline expired')
        for p, expected in self.originals:
            if metadata(p) != expected:
                raise ValueError('Original changed during export')

    def command(self, argv):
        self.check()
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=min(5, self.deadline-time.monotonic()), check=False)
        if len(result.stdout)+len(result.stderr) > 65536:
            raise ValueError('Tool output bound')
        if result.returncode:
            raise RuntimeError('Export preparation failed: ' + result.stderr.decode(errors='replace')[:2048])
        self.check()
        return result.stdout

    def start(self):
        if self.consumed:
            raise ValueError('Export attempt already consumed')
        self.consumed = True
        tool_pins()
        self.check()
        self.root.mkdir(mode=0o700)  # exclusive attempt; never reuse a partial overlay
        intent = {'export': self.name, 'bytes': self.size, 'originals': [str(p) for p, _ in self.originals]}
        with (self.root / 'intent.json').open('x') as f:
            json.dump(intent, f); f.flush(); os.fsync(f.fileno())
        fd = os.open(self.root, os.O_DIRECTORY | os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
        try:
            for p, expected in self.originals:
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                self.held.append(fd)
                if metadata(p) != expected or os.fstat(fd).st_ino != expected[1] or os.fstat(fd).st_dev != expected[0]:
                    raise ValueError('Original open identity changed')
                # QEMU file permission locking: reject writes, resize and graph changes.
                for byte in (201, 202, 203):
                    fcntl.fcntl(fd, fcntl.F_OFD_SETLK, struct.pack('@hhqqi4x', fcntl.F_RDLCK, os.SEEK_SET, byte, 1, 0))
                lock = fcntl.fcntl(fd, fcntl.F_OFD_GETLK, struct.pack('@hhqqi4x', fcntl.F_WRLCK, os.SEEK_SET, 100, 200, 0))
                if struct.unpack('@hhqqi4x', lock)[0] != fcntl.F_UNLCK:
                    raise ValueError('Original has a conflicting QEMU writer')
            paths = [p for p, _ in self.originals]
            rows = json.loads(self.command(['/usr/bin/qemu-img', 'info', '--output=json', '--backing-chain', str(paths[0])]))
            validate_chain(rows, paths, self.size)
            self.command(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', str(paths[0]), str(self.overlay)])
            os.chmod(self.overlay, 0o600)
            self.log = (self.root / 'server.log').open('xb')
            args = ['/usr/sbin/qemu-nbd', '--persistent', '--shared=1', '--handshake-limit=5',
                    '--bind', self.host, '--port', str(self.port), '--export-name', self.name,
                    '--cache=none', '--discard=ignore', '--detect-zeroes=off',
                    '--object', 'tls-creds-x509,id=tls0,endpoint=server,dir='+str(self.tls)+',verify-peer=on',
                    '--object', 'authz-simple,id=auth0,identity='+self.client_dn,
                    '--tls-creds', 'tls0', '--tls-authz', 'auth0', '--image-opts', chain_options([self.overlay]+paths)]
            self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log, close_fds=True)
            # Return the exact child; listening/authentication and mount qualification
            # belong to the caller. There is deliberately no fabricated READY receipt.
            return self.proc
        except BaseException:
            self.close()
            raise

    def close(self):
        forced = False
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.terminate()
            try: self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                forced = True
                self.proc.kill()
                self.proc.wait(timeout=3)
        if self.log is not None:
            self.log.close()
        for fd in self.held:
            os.close(fd)
        self.held = []
        unchanged = all(metadata(p) == expected for p, expected in self.originals)
        return {'exactChildExited': self.proc is None or self.proc.returncode is not None,
                'forced': forced, 'originalMetadataUnchanged': unchanged,
                'overlayRetained': self.overlay.exists(), 'writersFenced': False,
                'cleanFilesystemProven': False}
