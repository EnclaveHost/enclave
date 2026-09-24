#!/usr/bin/env python3
"""release-manifest.py -- write and verify the manifest of an M4a DOMAIN RELEASE.

A domain release is every input of a per-app guest's launch measurement EXCEPT the app: the image template (init,
front, runtime set, modules), the guest kernel, the verifying firmware, the kernel command line and the CPU
parameters the SNP launch digest depends on. A verifier holding a release and an app's bundle reconstructs the
expected measurement without this host's binaries (expected-measurement.sh).

    release-manifest.py write <release dir> --cmdline <s>     writes <dir>/release.json, prints "release <id>"
    release-manifest.py verify <release dir> [--expect <id>]  prints "release <id> verified <n> files", or refuses
    release-manifest.py field <release dir> <key>             one value from a VERIFIED manifest

The release id is sha256 of release.json, and release.json must be CANONICAL (sorted keys, no whitespace): a
manifest with the same meaning in another byte form is refused, so one release has exactly one id. Verification
refuses anything a reconstruction could silently depend on: a file not listed, a listed file missing or changed, a
directory not listed, a symlink or any other non-regular entry. Modes, owners and times are not recorded - the
image packer normalises them (pack-initrd.sh), so they cannot reach a measurement.
"""
import hashlib, json, os, stat, sys

FORMAT = "enclave-m4a-domain-release/1"
MEASURE = {"mode": "snp", "vcpuFamily": 26, "vcpuModel": 2, "vcpuStepping": 1, "vmmType": "QEMU"}


def canonical(o):
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def walk(root):
    files, dirs = {}, []
    for dp, dns, fns in os.walk(root, followlinks=False):
        rel = os.path.relpath(dp, root)
        for d in dns:
            p = os.path.join(dp, d)
            if os.path.islink(p):
                raise SystemExit(f"REFUSED: {os.path.relpath(p, root)} is a symlink")
            dirs.append(os.path.normpath(os.path.join(rel, d)))
        for f in fns:
            p = os.path.join(dp, f)
            r = os.path.normpath(os.path.join(rel, f))
            if r == "release.json":
                continue
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                raise SystemExit(f"REFUSED: {r} is a symlink")
            if not stat.S_ISREG(st.st_mode):
                raise SystemExit(f"REFUSED: {r} is not a regular file")
            h = hashlib.sha256()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            files[r] = {"sha256": h.hexdigest(), "size": st.st_size}
    return files, sorted(dirs)


def write(root, cmdline):
    if os.path.exists(os.path.join(root, "release.json")):
        raise SystemExit("REFUSED: release.json exists; a release is written once")
    files, dirs = walk(root)
    for need in ("kernel", "firmware.fd", "template/init", "template/front", "template/rt/wasmtime", "template/rt/runtime.json"):
        if need not in files:
            raise SystemExit(f"REFUSED: a release needs {need}")
    m = {"format": FORMAT, "cmdline": cmdline, "measure": MEASURE, "files": files, "dirs": dirs}
    b = canonical(m)
    with open(os.path.join(root, "release.json"), "wb") as f:
        f.write(b)
    print("release", hashlib.sha256(b).hexdigest())


def verify(root, expect=None):
    try:
        b = open(os.path.join(root, "release.json"), "rb").read()
        m = json.loads(b)
    except Exception as e:
        raise SystemExit(f"REFUSED: release.json: {e}")
    if canonical(m) != b:
        raise SystemExit("REFUSED: release.json is not canonical, so it would not have one id")
    rid = hashlib.sha256(b).hexdigest()
    if expect is not None and rid != expect:
        raise SystemExit(f"REFUSED: release {rid} is not the pinned release {expect}")
    if m.get("format") != FORMAT or m.get("measure") != MEASURE:
        raise SystemExit("REFUSED: unknown release format or measurement parameters")
    files, dirs = walk(root)
    listed = m.get("files") or {}
    for r in sorted(set(files) | set(listed)):
        if r not in listed:
            raise SystemExit(f"REFUSED: {r} is in the release directory but not in its manifest")
        if r not in files:
            raise SystemExit(f"REFUSED: {r} is in the manifest but missing")
        if files[r] != listed[r]:
            raise SystemExit(f"REFUSED: {r} does not match its manifest entry")
    if dirs != (m.get("dirs") or []):
        raise SystemExit("REFUSED: the directory set differs from the manifest")
    return rid, m, len(files)


def main():
    a = sys.argv[1:]
    if len(a) == 4 and a[0] == "write" and a[2] == "--cmdline":
        write(a[1], a[3])
    elif a[:1] == ["verify"] and len(a) in (2, 4):
        rid, _, n = verify(a[1], a[3] if len(a) == 4 and a[2] == "--expect" else None)
        print("release", rid, "verified", n, "files")
    elif len(a) == 3 and a[0] == "field":
        _, m, _ = verify(a[1])
        v = m
        for k in a[2].split("."):
            v = v[k]
        print(v)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
