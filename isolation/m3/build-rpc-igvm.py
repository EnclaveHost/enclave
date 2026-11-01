#!/usr/bin/env python3
"""Package a pinned RPC guest into the reviewed, non-debug OpenHCL recipe.

Offline assembly only: run inside an independently admitted/bounded build unit.
This neither accepts a platform identity nor creates VMGS or boots a guest.
All partial outputs survive failure. No historical candidate or mutation replay.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import time
import zlib

PINS = {
    "igvmfilegen": "9375a04e0d4e94c8f7734b4f15f3faeadbee7a891ce7ba8a85afaebe11343262",
    "manifest": "0ce9d8a87582bb5d60200d7f98c67ee357dbd042aec7338649c981753753df61",
    "openhcl_boot": "18dbeae950c1c143364638892ace4c2cf2128eb12d67f3de05bdbe37b2fd16bc",
    "underhill_kernel": "4d6c417654d5d26374c3bc44ed1c6473d5a0d9e7b9773d2bb1dab2abe5306762",
    # Guest-only volatile report input patch; never substitute stock persistent NV.
    "underhill_initrd": "71a91101f8f9b870199946076db2b220c68167e029539d4619a6b7600432124e",
}
RESOURCES = ("openhcl_boot", "underhill_kernel", "underhill_initrd", "linux_kernel", "linux_initrd")
MAX_FILE = 128 << 20


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw, object_pairs_hook=object_pairs,
                      parse_constant=lambda _: require(False, "nonfinite JSON"))


def write_new(path, data, mode=0o400):
    with open(path, "xb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(path, mode)


def encode(value):
    return json.dumps(value, sort_keys=True, indent=2).encode() + b"\n"


def copy_pinned(binding, destination):
    require(set(binding) == {"path", "sha256"}, "exact input binding required")
    require(isinstance(binding["path"], str) and os.path.isabs(binding["path"]), "absolute input path required")
    require(isinstance(binding["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", binding["sha256"]), "SHA256 required")
    fd = os.open(binding["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as src, open(destination, "xb") as dst:
        before = os.fstat(src.fileno())
        require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_FILE, "bounded regular input required")
        digest = hashlib.sha256()
        size = 0
        while chunk := src.read(1 << 20):
            size += len(chunk)
            require(size <= MAX_FILE, "input grew beyond limit")
            dst.write(chunk)
            digest.update(chunk)
        after = os.fstat(src.fileno())
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), "input changed during copy")
        require(size == before.st_size and digest.hexdigest() == binding["sha256"], "input hash mismatch")
        dst.flush()
        os.fsync(dst.fileno())
    os.chmod(destination, 0o400)
    return {"bytes": size, "sha256": digest.hexdigest()}


def describe(path):
    with open(path, "rb") as src:
        size = os.fstat(src.fileno()).st_size
        require(0 < size <= MAX_FILE, "bounded output required")
        return {"bytes": size, "sha256": hashlib.file_digest(src, "sha256").hexdigest()}


def check_igvm(path):
    """Independent structural readback, not a recomputation of the VBS digest."""
    with open(path, "rb") as src:
        size = os.fstat(src.fileno()).st_size
        require(24 <= size <= MAX_FILE, "IGVM size")
        magic, version, offset, length, total, checksum = struct.unpack("<6I", src.read(24))
        require(magic == 0x4D564749 and version == 1 and total == size, "IGVM header")
        require(offset == 24 and 0 < length <= 16 << 20 and offset + length <= total, "IGVM header bounds")
        # IGVM v1 CRC covers the fixed header with its checksum zeroed plus
        # the variable headers, not the data section. Stream without copying
        # the complete firmware into the checking process.
        crc = zlib.crc32(struct.pack("<6I", magic, version, offset, length, total, 0))
        remaining = length
        while remaining:
            chunk = src.read(min(remaining, 65536))
            require(bool(chunk), "truncated IGVM checksum input")
            crc = zlib.crc32(chunk, crc)
            remaining -= len(chunk)
        require(crc == checksum, "IGVM header CRC mismatch")
        end, platforms, measurements = offset + length, [], 0
        while offset < end:
            require(offset + 8 <= end, "truncated IGVM entry")
            src.seek(offset)
            kind, count = struct.unpack("<II", src.read(8))
            next_offset = offset + 8 + ((count + 7) & ~7)
            require(next_offset <= end, "IGVM entry outside header")
            if kind == 1:
                require(count == 16, "platform header size")
                mask, vtl, platform, platform_version, boundary = struct.unpack("<IBBHQ", src.read(16))
                require(mask != 0 and vtl == 2 and platform == 1 and platform_version == 1, "VBS VTL2 platform required")
                platforms.append({"mask": mask, "highestVtl": vtl, "platform": platform, "version": platform_version, "sharedGpaBoundary": boundary})
            measurements += kind == 0x311
            offset = next_offset
        require(len(platforms) == 1, "exactly one VBS platform required")
        return {"version": version, "platforms": platforms, "measurementHeaders": measurements, "headerCrcVerified": True}


def build(spec, out):
    require(set(spec) == {"schema", "inputs"} and spec["schema"] == "enclave-rpc-igvm-build/1", "IGVM spec schema")
    bindings = spec["inputs"]
    require(set(bindings) == set(PINS) | {"linux_kernel", "linux_initrd", "profile", "guestReceipt"}, "complete fixed input set required")
    for name, digest in PINS.items():
        require(bindings[name]["sha256"] == digest, "unreviewed OpenHCL input: " + name)
    out.mkdir(mode=0o700)  # exclusive, never overwrite/retry an old attempt
    inputs = out / "inputs"
    inputs.mkdir(mode=0o700)
    pinned = {name: copy_pinned(binding, inputs / name) for name, binding in bindings.items()}
    for name in ("profile", "guestReceipt"):
        require(pinned[name]["bytes"] <= 1 << 20, "metadata limit")
    profile_raw = (inputs / "profile").read_bytes()
    profile = decode(profile_raw)
    receipt = decode((inputs / "guestReceipt").read_bytes())
    require(receipt["schema"] == "enclave-native-rpc-build-receipt/1", "guest receipt schema")
    require(profile["schema"] == "enclave-native-rpc-profile/2" and profile["profile"] == "ethereum-base-rpc-v1", "RPC profile/2 required")
    require(profile_raw == json.dumps(profile, sort_keys=True, separators=(",", ":")).encode() + b"\n", "canonical profile required")
    require(profile["kernel"]["elfSha256"] == pinned["linux_kernel"]["sha256"], "kernel/profile mismatch")
    require(receipt["profileSha256"] == pinned["profile"]["sha256"] and receipt["initrd"]["sha256"] == pinned["linux_initrd"]["sha256"] and receipt["initrd"]["bytes"] == pinned["linux_initrd"]["bytes"], "guest receipt mismatch")
    for flag in ("platformAccepted", "brokerProvisioned", "rpcReady", "deployed"):
        require(receipt[flag] is False, "assembly-only guest receipt required")
    # Recipe bytes are a fixed reviewed pin, not a caller-supplied command line.
    resources = {name: str(inputs / name) for name in RESOURCES}
    write_new(out / "resources.json", encode({"resources": resources}))
    tool = inputs / "igvmfilegen"
    os.chmod(tool, 0o500)
    argv = [str(tool), "manifest", "-m", str(inputs / "manifest"), "-r", str(out / "resources.json"), "-o", str(out / "rpc.bin")]
    write_new(out / "intent.json", encode({"schema": "enclave-rpc-igvm-intent/1", "inputs": pinned, "argv": argv}))
    started = time.monotonic()
    with open(out / "compiler.log", "xb") as log:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, timeout=60)
    require(result.returncode == 0, "igvmfilegen failed: " + str(result.returncode))
    metadata = check_igvm(out / "rpc.bin")
    require((out / "rpc-vbs.json").stat().st_size <= 16384, "VBS document limit")
    vbs = decode((out / "rpc-vbs.json").read_bytes())
    require(vbs["environment"]["class_id"] == "7fb00ee4-a7ff-11ed-9e2f-00155d09de56" and len(vbs["series"]) == 1, "VBS identity shape")
    series = vbs["series"][0]
    require(series["endorsement"]["vbs_isvsvn"] == 13 and series["endorsement"]["build_info"]["debug_build"] is False, "VBS endorsement metadata")
    digest = series["reference"]["vbs_boot_digest"]
    require(isinstance(digest, str) and re.fullmatch(r"[0-9A-Fa-f]{64}", digest) and int(digest, 16) != 0, "VBS digest")
    # Detect modified staged inputs before publishing a successful receipt.
    for name, pin in pinned.items():
        require(describe(inputs / name) == pin, "staged input changed")
    result = {"schema": "enclave-rpc-igvm-build-receipt/1", "inputs": pinned,
              "firmware": describe(out / "rpc.bin"), "vbsDocument": describe(out / "rpc-vbs.json"),
              "vbsBootDigest": digest.lower(), "igvm": metadata, "elapsedSeconds": time.monotonic() - started,
              "profileSha256": pinned["profile"]["sha256"], "platformAccepted": False,
              "hardwareMeasured": False, "vmgsCreated": False, "guestBooted": False, "rpcReady": False, "deployed": False}
    write_new(out / "build.json", encode(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.spec, "rb") as src:
        raw = src.read(65537)
    require(len(raw) <= 65536, "spec limit")
    print(json.dumps(build(decode(raw), Path(args.out).absolute()), sort_keys=True))
