#!/usr/bin/env python3
"""Compile the distinct RPC boot stages, not a complete or accepted guest image.

The caller provides a canonical profile/2. Its digests are build inputs, not
owner acceptance. No app, keys, volumes, media or installed service is changed.
Run under the build host's independently bounded, admitted build unit.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_build", HERE / "build-native.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def profile(raw):
    p = base.loads_strict(raw, "RPC profile")
    base.exact_keys(p, ("controllerSha256", "entrySha256", "kernel", "profile", "root", "schema", "wrapperSha256"), "RPC profile")
    base.exact_keys(p["kernel"], ("bootSha256", "elfSha256", "release"), "kernel")
    base.exact_keys(p["root"], ("dataBlocks", "hashBytes", "hashSha256", "imageBytes", "imageSha256", "rootHash", "salt"), "root")
    if p["schema"] != "enclave-native-rpc-profile/2" or p["profile"] != "ethereum-base-rpc-v1" or p["kernel"]["release"] != base.KERNEL_RELEASE:
        raise base.BuildError("distinct RPC profile/2 required")
    r = p["root"]
    for key, value in (("dataBlocks", 262144), ("imageBytes", 1073741824), ("hashBytes", 8458240)):
        if type(r[key]) is not int or r[key] != value:
            raise base.BuildError("fixed RPC root geometry required")
    pins = [p["controllerSha256"], p["entrySha256"], p["wrapperSha256"], p["kernel"]["bootSha256"], p["kernel"]["elfSha256"]]
    pins += [r[k] for k in ("hashSha256", "imageSha256", "rootHash", "salt")]
    if not all(base.nonzero_hash(x) for x in pins):
        raise base.BuildError("nonzero RPC digests required")
    if raw != json.dumps(p, sort_keys=True, separators=(",", ":")).encode() + b"\n":
        raise base.BuildError("canonical RPC profile required")
    return p


def header(p, digest):
    r = p["root"]
    # Values came only from the strict profile decoder; no C text is accepted.
    return (f'/* RPC profile sha256 {digest}; no acceptance claim. */\n'
            '#define IMAGE_BYTES 1073741824ULL\n#define HASH_BYTES 8458240ULL\n'
            '#define DATA_BLOCKS "262144"\n'
            f'#define VERITY_ROOT "{r["rootHash"]}"\n#define VERITY_SALT "{r["salt"]}"\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = base.read_bounded(args.profile, 16384)
    p = profile(raw)
    out = Path(args.out).absolute()
    sources = ("dominit.c", "native-boot.c", "rpc-boot-clock.h", "rpc-boot-guardian.h", "vtpm-boot.h", "build-rpc-boot.py", "build-native.py")
    if any((HERE / n).exists() for n in ("rpc-boot-profile.h", "native-boot-profile.h")):
        raise base.BuildError("source-local profile header would shadow generated input")
    pins = {n: base.sha256(base.read_bounded(str(HERE / n), base.MAX_SOURCE)) for n in sources}
    out.mkdir(mode=0o700)  # exclusive; retain all partial results on failure
    base.write_new(str(out / "profile.json"), raw)
    base.write_new(str(out / "rpc-boot-profile.h"), header(p, base.sha256(raw)))
    started = time.monotonic()
    commands = []
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "SOURCE_DATE_EPOCH": "0"}
    for source, binary in (("dominit.c", "init"), ("native-boot.c", "rpc-boot")):
        argv = ["/usr/bin/gcc", *base.CFLAGS, "-DNATIVE_RPC", "-I", str(out), "-o", str(out / binary), str(HERE / source)]
        commands.append(argv)
        subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, check=True, timeout=max(.01, 60 - (time.monotonic() - started)))
    for n, pin in pins.items():
        if base.sha256(base.read_bounded(str(HERE / n), base.MAX_SOURCE)) != pin:
            raise base.BuildError("source changed during compilation")
    binaries = {n: {"sha256": base.sha256(base.read_bounded(str(out / n), base.MAX_BINARY)), "bytes": (out / n).stat().st_size} for n in ("init", "rpc-boot")}
    receipt = {"schema": "enclave-rpc-boot-stages/1", "profileSha256": base.sha256(raw), "sources": pins,
               "binaries": binaries, "commands": commands, "completeGuestImage": False, "platformAccepted": False, "deployed": False}
    base.write_new(str(out / "build.json"), json.dumps(receipt, sort_keys=True, indent=2).encode() + b"\n")
    print(json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
