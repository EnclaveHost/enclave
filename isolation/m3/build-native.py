#!/usr/bin/env python3
"""Build the measured native desktop initramfs (isolation/m3/build-native.py).

usage: build-native.py --spec SPEC.json --out NEW_DIRECTORY

Every input file is named and sha256-pinned by the spec, which is trusted build-host
configuration; nothing in it is a guest selector. Everything is validated before the output
directory is created. The output directory is created exclusively and is kept on failure. It
holds build/ (the compiled binaries and the generated profile header), native.cpio.gz, and
build.json.

The receipt binds inputs, sources, commands and tool version strings to the output. It does not
claim a hermetic or fully pinned toolchain.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.realpath(__file__))  # isolation/m3
SOURCE_ROOT = os.path.dirname(HERE)                  # isolation
M2 = os.path.join(SOURCE_ROOT, "m2")
DOMINIT_C = os.path.join(HERE, "dominit.c")
DOMEXEC_C = os.path.join(HERE, "domexec.c")
NATIVE_BOOT_C = os.path.join(HERE, "native-boot.c")
# A quoted include searches the including file's directory before -I, so a header here would
# shadow the generated one. It must never exist.
SHADOW_HEADER = os.path.join(os.path.dirname(NATIVE_BOOT_C), "native-boot-profile.h")

SPEC_SCHEMA = "enclave-native-platform-build/1"
RECEIPT_SCHEMA = "enclave-native-platform-build-receipt/1"
PROFILE_SCHEMA = "enclave-native-desktop-profile/1"
DESKTOP_PROFILE = "kvm-box-masked-v1"  # contract.DesktopProfile
KERNEL_RELEASE = "6.6.87.2-enclave-kvm-box"
RUNTIME_NAMES = ("wasmtime", "ld-linux-x86-64.so.2", "libc.so.6", "libgcc_s.so.1", "libm.so.6", "runtime.json")
# Exact identity fields emitted by contract/runtime-identity.sh.
RUNTIME_IDENTITY = {
    "name": "wasmtime",
    "version": "49.0.3",
    "execution": "jit",
    "targetIsa": "x86_64",
    "hostIsa": "x86_64",
    "cpuFeatures": "host-detected",
    "wx": "enforced",
    "cache": "none",
}
STORAGE_FIXED = ("dmsetup", "veritysetup", "lib64/ld-linux-x86-64.so.2")
STORAGE_LOADER_ALIAS = "usr/lib64/ld-linux-x86-64.so.2"
STORAGE_LIB = re.compile(r"usr/lib(?:64)?/lib[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*\.so(?:\.[0-9]+)*")
HEX64 = re.compile(r"[0-9a-f]{64}")
MARKER_PATH, MARKER = "enclave_openhcl_tpm.builtin", b"ENCLAVE-OPENHCL-TPM/1\n"
PROFILE_PATH = "plat/native-desktop/profile.json"
FIXED_DIRS = (".", "proc", "sys", "dev", "tmp", "run", "domains", "plat", "plat/rt",
              "plat/native-desktop", "plat/native-desktop/rootfs")
# Never in a production image: test material, the rootfs-verified nsinit and modules, apps.
FORBIDDEN = re.compile(r"probe|fixture|test|nsinit|\.ko(?:\.|$)|\.wasm$|(?:^|/)app\.", re.IGNORECASE)

MAX_SPEC, MAX_PROFILE, MAX_JSON = 1 << 20, 16384, 65536
MAX_BINARY, MAX_SOURCE = 256 << 20, 16 << 20

SOURCE_TREES = ("contract", "m2", "m3")
SOURCE_SUFFIXES = (".go", ".c", ".h", ".nft")
SOURCE_NAMES = ("go.mod", "go.sum", "go.work", "go.work.sum")
PRUNE_DIRS = ("build", "output", ".git")
# Public roots embedded by the production front. These are build inputs even
# though their filenames are not Go/C source. Lab-only pins are not selected.
EMBED_INPUTS = (
    "m2/bootstrap/roots/gts-root-r4.pem", "m2/bootstrap/roots/digicert-global-root-g2.pem",
    "m2/release/roots/isrg-root-x1.pem", "m2/release/roots/isrg-root-x2.pem",
    "m2/release/roots/sectigo-public-server-root-e46.pem", "m2/release/roots/usertrust-ecc.pem",
)

CFLAGS = ["-static", "-O2", "-Wall", "-Wextra", "-Werror"]
GO_LDFLAGS = "-ldflags=-s -w -buildid="
GO_ENV = {"CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64", "GOTOOLCHAIN": "local",
          "GOPROXY": "off", "GOFLAGS": "", "GOENV": "off", "GOWORK": "off"}
HOST_ENV = ("PATH", "HOME", "TMPDIR", "GOCACHE", "GOMODCACHE", "GOPATH")


class BuildError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_bounded(path, limit):
    """Reads a regular file of at most limit bytes; the final component must not be a symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as e:
        raise BuildError(f"{path}: {e.strerror}") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise BuildError(f"{path}: not a regular file")
        if st.st_size > limit:
            raise BuildError(f"{path}: larger than {limit} bytes")
        chunks, total = [], 0
        while True:
            b = os.read(fd, min(1 << 20, limit + 1 - total))
            if not b:
                return b"".join(chunks)
            chunks.append(b)
            total += len(b)
            if total > limit:
                raise BuildError(f"{path}: grew past {limit} bytes")
    finally:
        os.close(fd)


def loads_strict(raw, what):
    def pairs(items):
        obj = {}
        for k, v in items:
            if k in obj:
                raise BuildError(f"{what}: duplicate key {k!r}")
            obj[k] = v
        return obj

    def constant(name):
        raise BuildError(f"{what}: {name} is not JSON")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BuildError(f"{what}: {e}") from None


def exact_keys(obj, keys, what):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise BuildError(f"{what}: keys must be exactly {sorted(keys)}")


def nonzero_hash(s):
    return isinstance(s, str) and HEX64.fullmatch(s) is not None and s != "0" * 64


def check_pin(pin, what):
    exact_keys(pin, ("path", "sha256"), what)
    path = pin["path"]
    if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path or os.path.normpath(path) != path:
        raise BuildError(f"{what}: path must be absolute and normalized")
    if not nonzero_hash(pin["sha256"]):
        raise BuildError(f"{what}: sha256 must be 64 lowercase hex, not all zero")


def read_pinned(pin, limit, what):
    data = read_bounded(pin["path"], limit)
    if sha256(data) != pin["sha256"]:
        raise BuildError(f"{what}: {pin['path']} does not match its pinned sha256")
    return data


def require_elf(data, what):
    # x86-64 little-endian ELF64
    if data[:4] != b"\x7fELF" or data[4:6] != b"\x02\x01" or data[18:20] != b"\x3e\x00":
        raise BuildError(f"{what}: not an x86-64 ELF file")


# --- profile (mirrors isolation/m3/desktop/profile.go) ---

def hash_tree_bytes(blocks):
    total = 0
    while blocks > 1:
        blocks = (blocks + 127) // 128
        total += blocks * 4096
    return total


def validate_profile(raw):
    if not raw or len(raw) > MAX_PROFILE:
        raise BuildError("profile: size")
    p = loads_strict(raw, "profile")
    exact_keys(p, ("controllerSha256", "kernel", "models", "profile", "root", "schema"), "profile")
    exact_keys(p["kernel"], ("bootSha256", "elfSha256", "release"), "profile.kernel")
    exact_keys(p["root"], ("dataBlocks", "hashBytes", "hashSha256", "imageBytes", "imageSha256", "rootHash", "salt"),
               "profile.root")
    exact_keys(p["models"], ("dataBlocks", "hashStartBlock", "imageBytes", "imageSha256", "rootHash", "salt"),
               "profile.models")
    k, r, m = p["kernel"], p["root"], p["models"]
    if p["schema"] != PROFILE_SCHEMA or p["profile"] != DESKTOP_PROFILE or k["release"] != KERNEL_RELEASE:
        raise BuildError("profile: unsupported desktop profile")
    for s in (p["controllerSha256"], k["bootSha256"], k["elfSha256"], r["hashSha256"], r["imageSha256"],
              r["rootHash"], r["salt"], m["imageSha256"], m["rootHash"], m["salt"]):
        if not nonzero_hash(s):
            raise BuildError("profile: invalid digest")
    for v in (r["dataBlocks"], r["hashBytes"], r["imageBytes"], m["dataBlocks"], m["hashStartBlock"], m["imageBytes"]):
        if type(v) is not int or not 0 <= v < 1 << 64:
            raise BuildError("profile: geometry values must be uint64")
    rb, mb = r["dataBlocks"], m["dataBlocks"]
    if not 2 <= rb <= (8 << 30) // 4096 or r["imageBytes"] != rb * 4096 or r["hashBytes"] != hash_tree_bytes(rb):
        raise BuildError("profile: invalid root geometry")
    if (not 2 <= mb <= (128 << 30) // 4096 or m["hashStartBlock"] != mb + 1
            or m["imageBytes"] != m["hashStartBlock"] * 4096 + hash_tree_bytes(mb)):
        raise BuildError("profile: invalid model geometry")
    # native-boot tells the three media apart by size alone
    if len({r["imageBytes"], r["hashBytes"], m["imageBytes"]}) != 3:
        raise BuildError("profile: media sizes must differ")
    if max(r["imageBytes"], r["hashBytes"], m["imageBytes"]) > 128 << 30:
        raise BuildError("profile: payload exceeds native optical container bound")
    canonical = (json.dumps(p, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if raw != canonical:
        raise BuildError("profile: noncanonical")
    return p


def render_header(p, profile_sha):
    """Every value is a validated integer or 64-hex string, so the profile cannot inject C."""
    r, m = p["root"], p["models"]
    strings = [("DATA_BLOCKS", str(r["dataBlocks"])), ("MODEL_BLOCKS", str(m["dataBlocks"])),
               ("MODEL_HASH_START", str(m["hashStartBlock"])), ("VERITY_ROOT", r["rootHash"]),
               ("VERITY_SALT", r["salt"]), ("MODEL_ROOT", m["rootHash"]), ("MODEL_SALT", m["salt"])]
    numbers = [("IMAGE_BYTES", r["imageBytes"]), ("HASH_BYTES", r["hashBytes"]),
               ("MODEL_IMAGE_BYTES", m["imageBytes"]), ("MODEL_BYTES", m["dataBlocks"] * 4096)]
    lines = [f"/* Generated by build-native.py from native desktop profile sha256 {profile_sha}. */",
             "#ifndef NATIVE_BOOT_PROFILE_H", "#define NATIVE_BOOT_PROFILE_H"]
    for name, value in strings:
        if not re.fullmatch(r"[1-9][0-9]*|[0-9a-f]{64}", value):
            raise BuildError(f"header: {name} value is not a plain number or digest")
        lines.append(f'#define {name} "{value}"')
    for name, value in numbers:
        lines.append(f"#define {name} {int(value)}ULL")
    lines += ["#endif", ""]
    return "\n".join(lines).encode()


# --- spec and pinned inputs ---

def check_storage_paths(paths):
    for g in paths:
        if g not in STORAGE_FIXED and g != STORAGE_LOADER_ALIAS and not STORAGE_LIB.fullmatch(g):
            raise BuildError(f"storage: {g!r} is not a fixed tool or a usr/lib(64) shared library")
    missing = set(STORAGE_FIXED) - set(paths)
    if missing:
        raise BuildError(f"storage: missing {sorted(missing)}")
    seen = {}
    for g in paths:
        if g.startswith("usr/"):
            base = g.rsplit("/", 1)[1]
            if base in seen:
                raise BuildError(f"storage: {g} collides with {seen[base]}")
            seen[base] = g


def load_spec(path):
    raw = read_bounded(path, MAX_SPEC)
    spec = loads_strict(raw, "spec")
    exact_keys(spec, ("schema", "profile", "runtime", "storage"), "spec")
    if spec["schema"] != SPEC_SCHEMA:
        raise BuildError("spec: unsupported schema")
    check_pin(spec["profile"], "spec.profile")
    exact_keys(spec["runtime"], RUNTIME_NAMES, "spec.runtime")
    for name in RUNTIME_NAMES:
        check_pin(spec["runtime"][name], f"spec.runtime.{name}")
    if not isinstance(spec["storage"], dict):
        raise BuildError("spec.storage: must be an object")
    check_storage_paths(spec["storage"])
    for g, pin in spec["storage"].items():
        check_pin(pin, f"spec.storage.{g}")
    return spec, sha256(raw)


def load_inputs(spec):
    profile_raw = read_pinned(spec["profile"], MAX_PROFILE, "profile")
    profile = validate_profile(profile_raw)
    files = {}
    for name in RUNTIME_NAMES:
        what = f"runtime {name}"
        if name == "runtime.json":
            data = read_pinned(spec["runtime"][name], MAX_JSON, what)
            if loads_strict(data, what) != RUNTIME_IDENTITY:
                raise BuildError(f"{what}: not the pinned wasmtime runtime identity")
            files["plat/rt/" + name] = (data, 0o444)
        else:
            data = read_pinned(spec["runtime"][name], MAX_BINARY, what)
            require_elf(data, what)
            files["plat/rt/" + name] = (data, 0o555)
    for g in sorted(spec["storage"]):
        data = read_pinned(spec["storage"][g], MAX_BINARY, f"storage {g}")
        require_elf(data, f"storage {g}")
        files[g] = (data, 0o555)
    check_archive(files, profile["controllerSha256"])
    return profile_raw, profile, files


# --- sources ---

def inventory(out):
    inv = {}
    for tree in SOURCE_TREES:
        top = os.path.join(SOURCE_ROOT, tree)
        if not os.path.isdir(top) or os.path.islink(top):
            raise BuildError(f"source tree {tree} missing")

        def fail(e):
            raise BuildError(f"source walk: {e}")

        for dirpath, dirnames, filenames in os.walk(top, onerror=fail):
            dirnames[:] = sorted(d for d in dirnames if d not in PRUNE_DIRS
                                 and os.path.realpath(os.path.join(dirpath, d)) != out)
            for f in sorted(filenames):
                if f.endswith(SOURCE_SUFFIXES) or f in SOURCE_NAMES:
                    p = os.path.join(dirpath, f)
                    inv[os.path.relpath(p, SOURCE_ROOT)] = sha256(read_bounded(p, MAX_SOURCE))
    for name in EMBED_INPUTS:
        inv[name] = sha256(read_bounded(os.path.join(SOURCE_ROOT, name), MAX_SOURCE))
    for src in (DOMINIT_C, DOMEXEC_C, NATIVE_BOOT_C):
        if os.path.relpath(src, SOURCE_ROOT) not in inv:
            raise BuildError(f"source {src} missing")
    if os.path.relpath(SHADOW_HEADER, SOURCE_ROOT) in inv or os.path.lexists(SHADOW_HEADER):
        raise BuildError(f"{SHADOW_HEADER} would shadow the generated profile header")
    return dict(sorted(inv.items()))


def inventory_digest(inv):
    return sha256(json.dumps(inv, sort_keys=True, separators=(",", ":")).encode())


# --- commands ---

class Runner:
    def __init__(self, out):
        self.out, self.log = out, []
        self.env = {k: os.environ[k] for k in HOST_ENV if k in os.environ}
        self.env.update(LC_ALL="C", TZ="UTC", SOURCE_DATE_EPOCH="0")
        self.gcc = self.which("gcc")
        self.go = self.which("go")

    def which(self, tool):
        path = shutil.which(tool, path=self.env.get("PATH", ""))
        if not path:
            raise BuildError(f"{tool} not found on PATH")
        return os.path.realpath(path)

    def redact(self, s):
        return s.replace(self.out, "$OUT").replace(SOURCE_ROOT, "$SRC")

    def run(self, argv, cwd, extra=None, record=True):
        env = dict(self.env, **(extra or {}))
        if record:
            self.log.append({"argv": [self.redact(a) for a in argv], "cwd": self.redact(cwd),
                             "env": dict(sorted((extra or {}).items()))})
        r = subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True)
        if r.returncode != 0:
            tail = r.stderr.decode(errors="replace")[-4000:]
            raise BuildError(f"{' '.join(argv)} failed with status {r.returncode}:\n{tail}")
        return r.stdout.decode(errors="replace").strip()

    def versions(self):
        return {
            "gcc": {"path": self.gcc, "version": self.run([self.gcc, "--version"], HERE, record=False).splitlines()[0],
                    "target": self.run([self.gcc, "-dumpmachine"], HERE, record=False)},
            "go": {"path": self.go, "version": self.run([self.go, "version"], HERE, GO_ENV, record=False)},
            "python": sys.version.split()[0],
            "zlib": zlib.ZLIB_RUNTIME_VERSION,
        }


def build(runner, bindir, incdir):
    gcc, go = runner.gcc, runner.go
    runner.run([gcc, *CFLAGS, "-DNATIVE_DESKTOP", "-o", os.path.join(bindir, "init"), DOMINIT_C], HERE)
    runner.run([gcc, *CFLAGS, "-DNATIVE_DESKTOP", "-o", os.path.join(bindir, "domexec"), DOMEXEC_C], HERE)
    runner.run([gcc, *CFLAGS, "-I", incdir, "-o", os.path.join(bindir, "native-boot"), NATIVE_BOOT_C], HERE)
    gobuild = [go, "build", "-mod=readonly", "-trimpath", "-buildvcs=false", GO_LDFLAGS]
    runner.run([*gobuild, "-tags", "native_desktop", "-o", os.path.join(bindir, "monitor"), "./monitor"], HERE, GO_ENV)
    runner.run([*gobuild, "-tags", "native_desktop", "-o", os.path.join(bindir, "front"), "./front"], M2, GO_ENV)
    runner.run([*gobuild, "-o", os.path.join(bindir, "secretrun"), "./secretrun"], HERE, GO_ENV)
    built = {}
    for name, path in (("init", "init"), ("domexec", "plat/domexec"), ("native-boot", "plat/native-boot"),
                       ("monitor", "monitor"), ("front", "plat/front"), ("secretrun", "plat/secretrun")):
        data = read_bounded(os.path.join(bindir, name), MAX_BINARY)
        require_elf(data, f"built {name}")
        built[path] = data
    return built


# --- archive ---

def add(files, path, data, mode):
    if path in files:
        raise BuildError(f"archive: {path} collides")
    files[path] = (data, mode)


def archive_dirs(files):
    dirs = set(FIXED_DIRS)
    for path in files:
        parts = path.split("/")[:-1]
        dirs.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    if dirs & set(files):
        raise BuildError("archive: a file collides with a directory")
    return sorted(dirs, key=lambda d: (d != ".", d.encode()))


def check_archive(files, controller_sha):
    for path, (data, _) in files.items():
        if FORBIDDEN.search(path):
            raise BuildError(f"archive: {path} is not allowed in a production image")
        if sha256(data) == controller_sha:
            raise BuildError(f"archive: {path} is the controller")


def newc(dirs, files):
    """Rootless newc: owner 0:0, mtime 0, sequential inodes, directories first, no links or devices."""
    def entry(ino, mode, nlink, name, data=b""):
        nb = name.encode() + b"\0"
        fields = (ino, mode, 0, 0, nlink, 0, len(data), 0, 0, 0, 0, len(nb), 0)
        head = b"070701" + b"".join(b"%08x" % f for f in fields) + nb
        return head + b"\0" * (-len(head) % 4) + data + b"\0" * (-len(data) % 4)

    def parent(d):
        return d.rsplit("/", 1)[0] if "/" in d else "."

    out, ino = [], 0
    for d in dirs:
        ino += 1
        subdirs = sum(1 for c in dirs if c not in (".", d) and parent(c) == d)
        mode = stat.S_IFDIR | (0o1777 if d == "tmp" else 0o755)
        out.append(entry(ino, mode, 2 + subdirs, d))
    for path in sorted(files, key=str.encode):
        ino += 1
        data, mode = files[path]
        out.append(entry(ino, stat.S_IFREG | mode, 1, path, data))
    out.append(entry(0, 0, 1, "TRAILER!!!"))
    return b"".join(out)


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    ap = argparse.ArgumentParser(description="Build the measured native desktop initramfs.")
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True, help="new directory; must not exist")
    args = ap.parse_args()
    out = os.path.realpath(args.out)
    created = False
    try:
        if os.path.lexists(args.out):
            raise BuildError(f"{args.out} exists; refusing to overwrite")
        spec, spec_sha = load_spec(args.spec)
        profile_raw, profile, inputs = load_inputs(spec)
        check_archive(inputs, profile["controllerSha256"])
        profile_sha = sha256(profile_raw)
        header = render_header(profile, profile_sha)
        before = inventory(out)
        runner = Runner(out)
        tools = runner.versions()

        os.mkdir(out, 0o755)  # exclusive: fails if anything appeared meanwhile
        created = True
        bindir, incdir = os.path.join(out, "build"), os.path.join(out, "build", "include")
        os.mkdir(bindir, 0o755)
        os.mkdir(incdir, 0o755)
        write_new(os.path.join(incdir, "native-boot-profile.h"), header)
        built = build(runner, bindir, incdir)

        after = inventory(out)
        if after != before:
            changed = sorted({p for p, _ in set(before.items()) ^ set(after.items())})
            raise BuildError(f"sources changed during the build: {changed}")

        files = {}
        for path, data in built.items():
            add(files, path, data, 0o555)
        for path, (data, mode) in inputs.items():
            add(files, path, data, mode)
        add(files, PROFILE_PATH, profile_raw, 0o444)
        add(files, MARKER_PATH, MARKER, 0o444)
        check_archive(files, profile["controllerSha256"])
        dirs = archive_dirs(files)
        cpio = newc(dirs, files)
        initrd = gzip.compress(cpio, compresslevel=9, mtime=0)
        write_new(os.path.join(out, "native.cpio.gz"), initrd)

        entries = [{"path": d, "type": "dir", "mode": "1777" if d == "tmp" else "0755"} for d in dirs]
        entries += [{"path": p, "type": "file", "mode": f"{files[p][1]:04o}", "size": len(files[p][0]),
                     "sha256": sha256(files[p][0])} for p in sorted(files, key=str.encode)]
        receipt = {
            "schema": RECEIPT_SCHEMA,
            "scope": ("Binds the pinned inputs, the source inventory, the commands and the recorded tool "
                      "version strings to native.cpio.gz. gcc, the static C library, the Go toolchain and "
                      "module cache, Python and zlib come from the build host and are identified only by "
                      "path and version string: this is not a hermetic or fully pinned toolchain build."),
            "builder": {"path": "m3/build-native.py",
                        "sha256": sha256(read_bounded(os.path.realpath(__file__), MAX_SOURCE))},
            "specSha256": spec_sha,
            "profileSha256": profile_sha,
            "profileHeaderSha256": sha256(header),
            "inputPins": {"profile": spec["profile"], "runtime": spec["runtime"], "storage": spec["storage"]},
            "sourceInventory": after,
            "sourceInventorySha256": {"before": inventory_digest(before), "after": inventory_digest(after)},
            "tools": tools,
            "commands": runner.log,
            "archive": entries,
            "cpioSha256": sha256(cpio),
            "initrd": {"path": "native.cpio.gz", "size": len(initrd), "sha256": sha256(initrd)},
        }
        write_new(os.path.join(out, "build.json"), (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
        print(f"native initrd {out}/native.cpio.gz sha256 {receipt['initrd']['sha256']}")
        return 0
    except (BuildError, OSError) as e:
        print(f"build-native: {e}", file=sys.stderr)
        if created:
            print(f"build-native: partial output kept at {out}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
