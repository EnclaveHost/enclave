#!/usr/bin/env python3
"""Create a fresh, unprovisioned RPC VMGS candidate; never copy guest state.

Run only inside an independently admitted, bounded offline preparation unit.
The result is a format-checked input, not Windows acceptance or TPM identity.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import time
import zlib

TOOL_SHA256 = "46e0eefcbcac4d32cbcf89c52bff75a57ff6871052346fd07a156d0038ce856a"
CAPACITY = 4 * 1024 * 1024
FILE_BYTES = CAPACITY + 512
BLOCK = 4096
HEADER = struct.Struct("<QIIIIIIHH64s64sI")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def identity(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def regular(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    f = os.fdopen(fd, "rb")
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or not 0 < st.st_size <= maximum:
        f.close()
        raise ValueError("bounded ordinary file required")
    return f, st


def fresh_prefix():
    # vmgs_format v3 and Vmgs::format_new_inner: first header sequence1,
    # other header blank; file table at block2 and blank extended table3.
    prefix = bytearray(4 * BLOCK)
    header = bytearray(HEADER.pack(int.from_bytes(b"GUESTRTS", "little"),
        0x30000, 0, 1, HEADER.size, 2, 1, 0, 0, bytes(64), bytes(64), 0))
    struct.pack_into("<I", header, 12, zlib.crc32(header))
    prefix[:HEADER.size] = header
    for file_id, offset in ((0, 2), (63, 3)):
        struct.pack_into("<IIQ", prefix, 2 * BLOCK + file_id * 64, offset, 1, BLOCK)
    return prefix


def check_fresh(path):
    """Strict pristine format, not a general parser for provisioned VMGS.

    Compare every body byte, including unallocated blocks: valid headers alone
    cannot exclude inherited credentials in an unreferenced allocation.
    """
    f, before = regular(path, FILE_BYTES)
    with f:
        require(before.st_size == FILE_BYTES, "exact fresh VMGS size required")
        h = hashlib.sha256()
        prefix = f.read(4 * BLOCK)
        h.update(prefix)
        require(prefix == fresh_prefix(), "VMGS is not pristine v3 metadata with empty state")
        left = CAPACITY - len(prefix)
        while left:
            block = f.read(min(left, 65536))
            require(bool(block) and not any(block), "nonzero or truncated unallocated VMGS state")
            h.update(block)
            left -= len(block)
        footer = f.read(512)
        require(len(footer) == 512 and f.read(1) == b"", "fixed VHD footer length")
        h.update(footer)
        require(footer[:8] == b"conectix", "fixed VHD cookie")
        require(struct.unpack_from(">IIQ", footer, 8) == (2, 0x10000, 0xffffffffffffffff), "fixed VHD format")
        require(struct.unpack_from(">QQ", footer, 40) == (CAPACITY, CAPACITY), "fixed VHD capacity")
        require(footer[24:40] == bytes(8) + struct.pack(">I", 0x000a0000) + bytes(4)
                and footer[56:60] == bytes(4), "fresh VHD creator metadata")
        require(struct.unpack_from(">I", footer, 60)[0] == 2, "fixed VHD disk type")
        checksum = struct.unpack_from(">I", footer, 64)[0]
        require(checksum == (~(sum(footer) - sum(footer[64:68])) & 0xffffffff), "fixed VHD checksum")
        require(any(footer[68:84]) and footer[84:] == bytes(428), "fresh VHD identity and no saved state")
        require(identity(os.fstat(f.fileno())) == identity(before), "VMGS changed during readback")
        return {"bytes": before.st_size, "sha256": h.hexdigest(), "capacityBytes": CAPACITY,
                "format": "vmgs-v3-fixed-vhd", "pristine": True, "allocatedFileIds": [0, 63],
                "encrypted": False, "provisioned": False}


def write_new(path, value):
    with path.open("xb") as f:
        f.write((json.dumps(value, sort_keys=True, indent=2) + "\n").encode())
        f.flush()
        os.fsync(f.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prepare(tool, output):
    output = Path(output).absolute()
    output.mkdir(mode=0o700)  # one attempt, no overwrite or force-create
    staged = output / "vmgstool"
    f, before = regular(tool, 128 << 20)
    with f, staged.open("xb") as dst:
        digest = hashlib.sha256()
        while block := f.read(1 << 20):
            digest.update(block)
            dst.write(block)
        require(identity(os.fstat(f.fileno())) == identity(before), "tool changed during snapshot")
        require(digest.hexdigest() == TOOL_SHA256, "unreviewed VMGS tool")
        dst.flush()
        os.fsync(dst.fileno())
    staged.chmod(0o500)
    state = output / "guest-state.vmgs"
    argv = [str(staged), "create", "--file-path", str(state), "--file-size", str(CAPACITY)]
    write_new(output / "intent.json", {"schema": "enclave-rpc-fresh-vmgs-intent/1",
        "toolSha256": TOOL_SHA256, "argv": argv, "force": False, "inheritedState": False})
    started = time.monotonic()
    with (output / "create.log").open("xb") as log:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=20, umask=0o077)
    require(result.returncode == 0, "VMGS creation failed; retain consumed attempt")
    f, _ = regular(state, FILE_BYTES)
    with f:
        os.fsync(f.fileno())
    checked = check_fresh(state)
    with staged.open("rb") as f:
        require(hashlib.file_digest(f, "sha256").hexdigest() == TOOL_SHA256, "staged tool changed")
    receipt = {"schema": "enclave-rpc-fresh-vmgs-receipt/1", "state": checked,
        "toolSha256": TOOL_SHA256, "elapsedSeconds": time.monotonic() - started,
        "windowsAccepted": False, "providerSharingQualified": False,
        "growthQualified": False, "hardwareIdentity": False, "deployed": False}
    write_new(output / "build.json", receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.tool, args.out), sort_keys=True))
