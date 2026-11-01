#!/usr/bin/env python3
"""Assemble a pinned native RPC initramfs and two read-only root containers.

No VM, provider, module load, writable volume, owner key or catalog action.
The resulting candidate still requires accepted bootstrap/storage provisioning
and target qualification. Run in an independently bounded build allocation.
"""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


boot = load("rpc_boot_builder", HERE / "build-rpc-boot.py")
base = boot.base
rootbuild = load("rpc_root_builder", REPO / "rpc/native/assemble_root.py")
SCHEMA = "enclave-native-rpc-build/1"
MAX_ARCHIVE = 128 << 20
ROOT_DIRS = (".", "proc", "sys", "dev", "tmp", "run", "domains", "plat", "plat/rt", "plat/native-rpc", "plat/native-rpc/rootfs")


def pinned(pin, limit):
    base.check_pin(pin, "input")
    return base.read_pinned(pin, limit, "input")


def copy_checked(pin, size, output=None, prefix=b""):
    """Hash a held regular input in chunks; optionally copy with a fixed header."""
    base.check_pin(pin, "large input")
    fd = os.open(pin["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        before = os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != size:
            raise base.BuildError("large input geometry/type")
        content, artifact = hashlib.sha256(), hashlib.sha256(prefix)
        if output is not None:
            output.write(prefix)
        while block := f.read(1 << 20):
            content.update(block); artifact.update(block)
            if output is not None: output.write(block)
        after = os.fstat(f.fileno())
        fields = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
        if fields(before) != fields(after) or content.hexdigest() != pin["sha256"]:
            raise base.BuildError("large input changed or digest mismatch")
        return artifact.hexdigest()


def module_info(raw):
    """Require an amd64 relocatable NBD module with exact kernel vermagic."""
    if len(raw) < 64 or raw[:7] != b"\x7fELF\x02\x01\x01":
        raise base.BuildError("NBD ELF header")
    h = struct.unpack_from("<16sHHIQQQIHHHHHH", raw)
    if h[1:4] != (1, 62, 1) or h[8] != 64 or h[11] != 64 or not 0 < h[12] <= 256 or not 0 < h[13] < h[12]:
        raise base.BuildError("NBD section header")
    def section(n):
        off = h[6] + n * 64
        if off + 64 > len(raw): raise base.BuildError("NBD section range")
        row = struct.unpack_from("<IIQQQQIIQQ", raw, off)
        if row[1] != 8 and row[4] + row[5] > len(raw): raise base.BuildError("NBD data range")
        return row
    strings = section(h[13])
    if strings[1] != 3: raise base.BuildError("NBD section-name table type")
    names = raw[strings[4]:strings[4] + strings[5]]
    infos = []
    for i in range(h[12]):
        row = section(i)
        if row[0] >= len(names): raise base.BuildError("NBD section name")
        end = names.find(b"\0", row[0])
        if end < 0: raise base.BuildError("NBD unterminated section")
        if names[row[0]:end] == b".modinfo":
            if row[1] != 1: raise base.BuildError("NBD modinfo type")
            infos.append(raw[row[4]:row[4] + row[5]])
    if len(infos) != 1: raise base.BuildError("NBD modinfo required")
    fields = {}
    for item in infos[0].split(b"\0"):
        if not item: continue
        key, sep, value = item.partition(b"=")
        if not sep: raise base.BuildError("NBD modinfo field")
        fields.setdefault(key, []).append(value)
    if fields.get(b"name") != [b"nbd"] or fields.get(b"depends") != [b""] or len(fields.get(b"vermagic", [])) != 1:
        raise base.BuildError("NBD identity/dependencies")
    if not fields[b"vermagic"][0].startswith((base.KERNEL_RELEASE + " ").encode()):
        raise base.BuildError("NBD kernel mismatch")
    return fields[b"vermagic"][0].decode("ascii")


def closure(files, runtime=False):
    """Verify DT_NEEDED/interpreter closure without executing build inputs."""
    names = {}
    for path, (raw, _) in files.items():
        key = path.rsplit("/", 1)[-1]
        if key in names and names[key] != raw: raise base.BuildError("ambiguous library basename")
        names[key] = raw
    for path, (raw, _) in files.items():
        if path.endswith(".json"): continue
        interpreters, deps = rootbuild.elf(io.BytesIO(raw), len(raw))
        for interp in interpreters:
            key = interp.rsplit("/", 1)[-1] if runtime else interp
            if key not in (names if runtime else files): raise base.BuildError("missing ELF interpreter: " + path)
        for dep in deps:
            if dep not in names: raise base.BuildError("missing ELF library: " + dep)


def inputs(path):
    raw = base.read_bounded(str(path), 1 << 20)
    spec = base.loads_strict(raw, "RPC spec")
    base.exact_keys(spec, ("schema", "controller", "kernel", "root", "runtime", "storage", "nbd"), "RPC spec")
    if spec["schema"] != SCHEMA: raise base.BuildError("RPC spec schema")
    base.exact_keys(spec["kernel"], ("boot", "elf", "release"), "kernel")
    if spec["kernel"]["release"] != base.KERNEL_RELEASE: raise base.BuildError("kernel release")
    kernel = {}
    for role in ("boot", "elf"):
        data = pinned(spec["kernel"][role], 128 << 20)
        if role == "elf": base.require_elf(data, "kernel")
        elif len(data) < 0x206 or data[0x202:0x206] != b"HdrS": raise base.BuildError("kernel boot header")
        kernel[role + "Sha256"] = base.sha256(data)
    kernel["release"] = base.KERNEL_RELEASE
    controller = pinned(spec["controller"], 4 << 20)
    if not controller.startswith(b"\0asm\x0d\0\x01\0"): raise base.BuildError("component controller required")
    base.exact_keys(spec["root"], ("descriptor", "image", "hash"), "root")
    descriptor = pinned(spec["root"]["descriptor"], 16384)
    root = base.loads_strict(descriptor, "root descriptor")
    # Reuse the canonical profile decoder for all root/schema constraints.
    proto = {"controllerSha256": base.sha256(controller), "entrySha256": "1" * 64,
             "kernel": kernel, "profile": "ethereum-base-rpc-v1", "root": root,
             "schema": "enclave-native-rpc-profile/2", "wrapperSha256": "1" * 64}
    boot.profile(rootbuild.canonical(proto))
    for role in ("image", "hash"):
        base.check_pin(spec["root"][role], "root " + role)
        if spec["root"][role]["sha256"] != root[role + "Sha256"]: raise base.BuildError("root descriptor/input disagreement")
        copy_checked(spec["root"][role], root[role + "Bytes"])
    base.exact_keys(spec["runtime"], base.RUNTIME_NAMES, "runtime")
    runtime = {}
    for name in base.RUNTIME_NAMES:
        data = pinned(spec["runtime"][name], 64 << 20)
        if name == "runtime.json":
            if base.loads_strict(data, "runtime") != base.RUNTIME_IDENTITY: raise base.BuildError("runtime identity")
        runtime["plat/rt/" + name] = (data, 0o444 if name.endswith(".json") else 0o555)
    closure(runtime, runtime=True)
    if not isinstance(spec["storage"], dict): raise base.BuildError("storage object")
    base.check_storage_paths(spec["storage"])
    storage = {name: (pinned(pin, 32 << 20), 0o555) for name, pin in spec["storage"].items()}
    closure(storage)
    nbd = pinned(spec["nbd"], 8 << 20)
    vermagic = module_info(nbd)
    files = {**runtime, **storage, "plat/native-rpc/nbd.ko": (nbd, 0o444)}
    if sum(len(v[0]) for v in files.values()) > MAX_ARCHIVE: raise base.BuildError("input aggregate size")
    return spec, base.sha256(raw), proto, files, vermagic


def source_inventory(out):
    pins = base.inventory(str(out))
    for name in ("m3/build-rpc.py", "m3/build-rpc-boot.py", "m3/build-native.py", "../rpc/native/assemble_root.py", "../rpc/guest/chain_service.py"):
        pins[name] = base.sha256(base.read_bounded(str(HERE.parent / name), base.MAX_SOURCE))
    if os.path.lexists(HERE / "rpc-boot-profile.h"): raise base.BuildError("shadow RPC profile header")
    return dict(sorted(pins.items()))


def archive(out, files):
    """Stream deterministic rootless newc into gzip; no second full archive copy."""
    dirs = set(ROOT_DIRS)
    for path in files:
        if path == "TRAILER!!!" or "\0" in path or path.startswith("/") or any(x in ("", ".", "..") for x in path.split("/")): raise base.BuildError("archive path")
        data, mode = files[path]
        if type(mode) is not int or mode not in (0o444, 0o555) or not isinstance(data, bytes):
            raise base.BuildError("archive file type/mode")
        parts = path.split("/")[:-1]
        dirs.update("/".join(parts[:n]) for n in range(1, len(parts) + 1))
    if dirs & set(files): raise base.BuildError("archive path collision")
    if sum(len(v[0]) for v in files.values()) > MAX_ARCHIVE: raise base.BuildError("archive aggregate size")
    digest, count, records = hashlib.sha256(), 0, []
    with out.open("xb") as target, gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0, compresslevel=9) as stream:
        def emit(raw):
            nonlocal count
            count += len(raw); digest.update(raw); stream.write(raw)
        def entry(ino, mode, links, path, data=b""):
            name = path.encode() + b"\0"
            fields = (ino, mode, 0, 0, links, 0, len(data), 0, 0, 0, 0, len(name), 0)
            header = b"070701" + b"".join(b"%08x" % f for f in fields) + name
            emit(header); emit(b"\0" * (-len(header) % 4)); emit(data); emit(b"\0" * (-len(data) % 4))
        ordered = sorted(dirs, key=lambda d: (d != ".", d.encode()))
        ino = 0
        for path in ordered:
            ino += 1
            mode = 0o1777 if path == "tmp" else 0o755
            children = sum(1 for d in dirs if d not in (".", path) and (d.rsplit("/", 1)[0] if "/" in d else ".") == path)
            entry(ino, stat.S_IFDIR | mode, children + 2, path)
            records.append({"path": path, "type": "dir", "mode": mode})
        for path in sorted(files):
            ino += 1; data, mode = files[path]
            entry(ino, stat.S_IFREG | mode, 1, path, data)
            records.append({"path": path, "type": "file", "mode": mode, "bytes": len(data), "sha256": base.sha256(data)})
        entry(0, 0, 1, "TRAILER!!!")
        stream.close(); target.flush(); os.fsync(target.fileno())
    return {"cpioSha256": digest.hexdigest(), "cpioBytes": count, "entries": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", required=True); parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out).absolute()
    if out.exists(): raise base.BuildError("output already exists")
    spec, specsha, profile, files, vermagic = inputs(args.spec)
    before = source_inventory(out)
    out.mkdir(mode=0o700); (out / "build").mkdir(); (out / "include").mkdir()
    runner = base.Runner(str(out)); started = time.monotonic()
    def run(argv, cwd, env=None):
        # Fixed command/environment, clipped to this one finite build invocation.
        runner.log.append({"argv": argv, "cwd": str(cwd), "env": env or {}})
        subprocess.run(argv, cwd=cwd, env={**runner.env, **(env or {})}, stdin=subprocess.DEVNULL,
                       check=True, timeout=max(.01, 120 - (time.monotonic() - started)))
    go = [runner.go, "build", "-p", "1", "-mod=readonly", "-trimpath", "-buildvcs=false", base.GO_LDFLAGS]
    for name, package, directory, tags in (
            ("rpc-native-init", "./cmd/rpc-native-init", HERE, None),
            ("monitor", "./monitor", HERE, "native_rpc"),
            ("front", "./front", HERE.parent / "m2", "native_rpc,bootstrapdirect,shielddirect")):
        run(go + (["-tags", tags] if tags else []) + ["-o", str(out / "build" / name), package], directory, base.GO_ENV)
    for name, dest in (("rpc-native-init", "plat/native-rpc/rpc-native-init"), ("monitor", "monitor"), ("front", "plat/front")):
        data = base.read_bounded(str(out / "build" / name), 32 << 20); base.require_elf(data, name)
        base.add(files, dest, data, 0o555)
    wrapper = base.read_bounded(str(REPO / "rpc/guest/chain_service.py"), 1 << 20)
    profile["entrySha256"] = base.sha256(files["plat/native-rpc/rpc-native-init"][0])
    profile["wrapperSha256"] = base.sha256(wrapper)
    raw = rootbuild.canonical(profile); boot.profile(raw)
    base.write_new(str(out / "profile.json"), raw)
    base.write_new(str(out / "include/rpc-boot-profile.h"), boot.header(profile, base.sha256(raw)))
    for source, name, dest in (("dominit.c", "init", "init"), ("native-boot.c", "rpc-boot", "plat/rpc-boot")):
        run([runner.gcc, *base.CFLAGS, "-DNATIVE_RPC", "-I", str(out / "include"), "-o", str(out / "build" / name), str(HERE / source)], HERE)
        base.add(files, dest, base.read_bounded(str(out / "build" / name), 8 << 20), 0o555)
    base.add(files, "plat/native-rpc/profile.json", raw, 0o444)
    base.add(files, "plat/native-rpc/chain_service.py", wrapper, 0o444)
    base.add(files, base.MARKER_PATH, base.MARKER, 0o444)
    for path, (data, _) in files.items():
        if base.sha256(data) == profile["controllerSha256"] or path.startswith("plat/native-desktop"):
            raise base.BuildError("app/controller/desktop payload in platform")
    receipt = archive(out / "rpc.cpio.gz", files)
    containers = {}
    for role in ("image", "hash"):
        dest = out / (role + ".container")
        with dest.open("xb") as f:
            digest = copy_checked(spec["root"][role], profile["root"][role + "Bytes"], f, b"\0" * 65536)
            f.flush(); os.fsync(f.fileno())
        containers[role] = {"path": dest.name, "bytes": dest.stat().st_size, "sha256": digest, "headerBytes": 65536}
    after = source_inventory(out)
    if before != after: raise base.BuildError("source changed during build")
    receipt.update(schema="enclave-native-rpc-build-receipt/1", specSha256=specsha, inputPins=spec,
                   profileSha256=base.sha256(raw), sourceInventory=after, commands=runner.log,
                   tools=runner.versions(), nbdVermagic=vermagic, containers=containers,
                   initrd={"path": "rpc.cpio.gz", "bytes": (out / "rpc.cpio.gz").stat().st_size,
                           "sha256": base.sha256((out / "rpc.cpio.gz").read_bytes())},
                   platformAccepted=False, brokerProvisioned=False, rpcReady=False, deployed=False)
    base.write_new(str(out / "build.json"), json.dumps(receipt, sort_keys=True, indent=2).encode() + b"\n")
    rootbuild.sync_dir(out)
    print(json.dumps({"initrd": receipt["initrd"], "profileSha256": receipt["profileSha256"], "containers": containers, "deployed": False}))


if __name__ == "__main__":
    main()
