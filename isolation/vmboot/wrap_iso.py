#!/usr/bin/env python3
"""Wrap a raw disk image as the labelled ISO 9660 container a Hyper-V host can attach as a DVD.

python3 -I isolation/vmboot/wrap_iso.py LABEL SOURCE DESTINATION --sha256 HEX

Hyper-V's DVD backend refuses a raw image, so on an Enclave Shield host each disk of a whole-VM app is presented in
this container: a 65536-byte ISO 9660 header, then the image, byte for byte. LABEL (ROOT_DATA, ROOT_HASH, MODELS) is
the volume identifier, which is how vm-init tells the disks apart; on a QEMU host the same label is the virtio
serial and there is no container. The header is a function of the label and the payload size alone.

The guest reads the volume identifier as a hint and nothing else from the header; dm-verity authenticates the
payload. The layout is the one kvm-box/guest/native/build_iso.py (enclave-apps) established for the native desktop,
with the label in place of its fixed identifier: ECMA-119 sections 8.4, 9.1 and 9.4, no boot catalog, Joliet or UDF.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct

SECTOR = 2048
PAYLOAD_OFFSET = 32 * SECTOR
MAX_BYTES = 128 << 30
EXTENT_MAX = 0xFFFFF800
LABEL = re.compile(r'[A-Z0-9_]{1,32}')   # ISO 9660 d-characters


def both16(v):
    return struct.pack('<H', v) + struct.pack('>H', v)


def both32(v):
    return struct.pack('<I', v) + struct.pack('>I', v)


def record(name, extent, size, flags):
    length = 33 + len(name) + (len(name) % 2 == 0)
    r = bytearray(length)
    r[0] = length
    r[2:10] = both32(extent)
    r[10:18] = both32(size)
    r[18:25] = bytes([70, 1, 1, 0, 0, 0, 0])
    r[25] = flags
    r[28:32] = both16(1)
    r[32] = len(name)
    r[33:33+len(name)] = name
    return r


def header(label, size):
    if not LABEL.fullmatch(label):
        raise ValueError('label must be 1 to 32 of A-Z, 0-9 and underscore')
    if type(size) is not int or not 0 < size <= MAX_BYTES or size % 4096:
        raise ValueError('payload must be 4096-aligned and at most 128 GiB')
    h = bytearray(PAYLOAD_OFFSET)
    p = bytearray(SECTOR)
    p[:7] = b'\x01CD001\x01'
    p[8:40] = b'ENCLAVE'.ljust(32, b' ')
    p[40:72] = label.encode().ljust(32, b' ')
    p[80:88] = both32(32 + size // SECTOR)
    p[120:124] = both16(1)
    p[124:128] = both16(1)
    p[128:132] = both16(SECTOR)
    p[132:140] = both32(10)
    p[140:144] = struct.pack('<I', 18)
    p[148:152] = struct.pack('>I', 19)
    p[156:190] = record(b'\x00', 20, SECTOR, 2)
    p[190:813] = b' ' * (813 - 190)
    p[574:702] = b'ENCLAVE WHOLE VM DISK WRAPPER'.ljust(128, b' ')
    for offset in (813, 830, 864):
        p[offset:offset+17] = b'1970010100000000\x00'
    p[847:864] = b'0000000000000000\x00'
    p[881] = 1
    h[16*SECTOR:17*SECTOR] = p
    h[17*SECTOR:17*SECTOR+7] = b'\xffCD001\x01'
    h[18*SECTOR:18*SECTOR+10] = b'\x01\x00' + struct.pack('<I', 20) + struct.pack('<H', 1) + b'\x00\x00'
    h[19*SECTOR:19*SECTOR+10] = b'\x01\x00' + struct.pack('>I', 20) + struct.pack('>H', 1) + b'\x00\x00'
    directory = record(b'\x00', 20, SECTOR, 2) + record(b'\x01', 20, SECTOR, 2)
    remaining, extent = size, 32
    while remaining:
        length = min(remaining, EXTENT_MAX)
        remaining -= length
        directory += record(b'PAYLOAD.BIN;1', extent, length, 0x80 if remaining else 0)
        extent += length // SECTOR
    if len(directory) > SECTOR:
        raise ValueError('payload extent records exceed the directory sector')
    h[20*SECTOR:20*SECTOR+len(directory)] = directory
    return bytes(h)


def wrap(label, source, destination, expected):
    if not re.fullmatch('[0-9a-f]{64}', expected):
        raise ValueError('expected sha256 must be lowercase hex')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as src:
        st = os.fstat(src.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise ValueError('regular payload file required')
        prefix = header(label, st.st_size)
        payload, container = hashlib.sha256(), hashlib.sha256(prefix)
        with open(destination, 'xb') as dst:   # never overwrite
            try:
                dst.write(prefix)
                total = 0
                while data := src.read(1 << 20):
                    payload.update(data)
                    container.update(data)
                    total += len(data)
                    dst.write(data)
                if total != st.st_size or payload.hexdigest() != expected:
                    raise ValueError('payload changed or does not match its pin')
                dst.flush()
                os.fsync(dst.fileno())
                os.fchmod(dst.fileno(), 0o444)
            except BaseException:
                os.unlink(destination)
                raise
    return {'schema': 'enclave-vm-disk-iso/1', 'label': label, 'payloadOffset': PAYLOAD_OFFSET, 'payloadBytes': st.st_size,
            'payloadSha256': expected, 'containerBytes': PAYLOAD_OFFSET + st.st_size, 'containerSha256': container.hexdigest(),
            'headerSha256': hashlib.sha256(prefix).hexdigest()}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('label')
    ap.add_argument('source', type=Path)
    ap.add_argument('destination', type=Path)
    ap.add_argument('--sha256', required=True)
    a = ap.parse_args()
    print(json.dumps(wrap(a.label, a.source, a.destination, a.sha256), sort_keys=True))
