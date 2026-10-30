#!/usr/bin/env python3
"""compose_init_release.py -- compose a NEW M4a release from af50d526 with the bounded-retirement opt-in (REVIEW.md).

Derived from prod-loader-rollout/compose_loader_release.py (that file is not modified or imported).

    compose_init_release.py --base DIR --base-id HEX --init FILE --init-sha256 HEX --shim FILE --shim-sha256 HEX \
        --manifest-tool FILE --manifest-tool-sha256 HEX --out DIR --receipt FILE

The new release is the base with exactly three differences:
  template/init                                       replaced by the pinned candidate init (build_init.py)
  template/rt/libenclave_llama.so                     replaced by the pinned candidate shim
  template/rt/shield-source-retire-budget-1024.enabled  added, content exactly "1\\n"
Every other file (the af50d526 shieldmodel loader and its drop-cache marker, source-reclaim marker, kernel, firmware,
front, runtime, backends, modules, model files, calib, profile markers), every directory and the kernel command line
are carried over byte for byte. The CLI only accepts the production base af50d526 with its reproduced init and shim;
compose() takes the expectations as an argument so the tests can use tiny fixtures.
Exit 0 composed, 1 refused, 2 usage.
"""
import argparse, contextlib, hashlib, io, json, os, stat, struct, sys, types

PROD_BASE = {
    "id": "af50d526be6deefcdd815968ff1dd2c04327f6c3b3f981c0aa90cc585b0effae",
    "files": {
        "template/init": {"sha256": "dffd093b8458e109c64756c26fe5efd8b8226da712fb03a81f28d50aaa27cb0b", "size": 116880},
        "template/rt/libenclave_llama.so": {
            "sha256": "5fce1b9e76824424e9d549bc2b784d946007067856d7530edb5ba958ead81b5c", "size": 73344},
        "template/shieldmodel": {"sha256": "acd688ecd7fdd1bca3a2e6269a948bab36fa066e8dca2b91b1886d4fe4c68d28",
                                 "size": 3010366},
    },
}
REVIEWED_SHIM_SHA256 = "dd7ad838ec6b1054f8b7f3e90a91d2b35fbcc68878b101e648aea4542001e136"
PROD_MANIFEST_TOOL_SHA256 = "6facdb9a77da31e6ddaf5a544f58a4966ea8dfdede87ad36e50818e22adbfd6b"
INIT = "template/init"
SHIM = "template/rt/libenclave_llama.so"
MARKER = "template/rt/shield-source-retire-budget-1024.enabled"
ONE = b"1\n"
ONE_META = {"sha256": hashlib.sha256(ONE).hexdigest(), "size": 2}
REQUIRED_MARKERS = ("template/rt/shield-original-source-reclaim.enabled", "template/rt/shield-model-drop-cache.enabled")
FORBIDDEN_WORDS = ("packed24", "experimental")
INIT_NEEDS = (b"/rt/shield-source-retire-budget-1024.enabled", b"ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024")
SHIM_NEEDS = (b"ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB",)
MANIFEST_KEYS = {"format", "cmdline", "measure", "files", "dirs"}
RECEIPT_KIND = "shield-init-retire-budget-release-receipt/1"
CHUNK = 1 << 20
TOOL_MAX = 1 << 20
MANIFEST_MAX = 16 << 20
BINARY_MAX = 64 << 20
HEX = frozenset("0123456789abcdef")


class Refused(Exception):
    pass


def _pin(s, what):
    if not (isinstance(s, str) and len(s) == 64 and set(s) <= HEX):
        raise Refused(f"{what} must be 64 lowercase hex")
    return s


def _open_regular(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as e:
        raise Refused(f"{path}: {e.strerror} (symlinks are refused)") from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f"{path} is not a regular file")
    return fd


def _read_bounded(path, limit):
    fd = _open_regular(path)
    with os.fdopen(fd, "rb") as f:
        b = f.read(limit + 1)
    if len(b) > limit:
        raise Refused(f"{path} is larger than {limit} bytes")
    return b


def _write_all(fd, b):
    mv = memoryview(b)
    while mv:
        mv = mv[os.write(fd, mv):]


def _create_new(path):
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)


def _write_new(path, data, mode):
    fd = _create_new(path)
    try:
        _write_all(fd, data)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def _copy_pinned(src, dst, sha256, size, mode=None):
    """Bounded streaming copy of src into a new inode at dst; the bytes written must hash to the pin."""
    sfd = _open_regular(src)
    try:
        if mode is None:
            mode = os.fstat(sfd).st_mode & 0o755
        dfd = _create_new(dst)
        try:
            h, n = hashlib.sha256(), 0
            while True:
                b = os.read(sfd, CHUNK)
                if not b:
                    break
                n += len(b)
                if n > size:
                    raise Refused(f"{src} grew past its pinned size {size} while copying")
                h.update(b)
                _write_all(dfd, b)
            if n != size or h.hexdigest() != sha256:
                raise Refused(f"{src} no longer matches its pin while copying (size {n}, sha256 {h.hexdigest()})")
            os.fchmod(dfd, mode)
            os.fsync(dfd)
            if os.fstat(dfd).st_nlink != 1:
                raise Refused(f"{dst} is linked elsewhere")
        finally:
            os.close(dfd)
    finally:
        os.close(sfd)


def _elf64_amd64(b, path, want_types, static):
    if len(b) < 64 or b[:4] != b"\x7fELF" or b[4] != 2 or b[5] != 1:
        raise Refused(f"{path} is not a little-endian ELF64 file")
    e_type, e_machine = struct.unpack_from("<HH", b, 16)
    if e_machine != 62 or e_type not in want_types:
        raise Refused(f"{path} is not an x86-64 ELF of type {want_types}")
    (e_phoff,) = struct.unpack_from("<Q", b, 32)
    e_phentsize, e_phnum = struct.unpack_from("<HH", b, 54)
    if e_phnum > 64 or (e_phnum and e_phentsize != 56) or e_phoff + 56 * e_phnum > len(b):
        raise Refused(f"{path} has an implausible program header table")
    for i in range(e_phnum):
        (p_type,) = struct.unpack_from("<I", b, e_phoff + 56 * i)
        if static and p_type == 3:
            raise Refused(f"{path} requests a program interpreter; the init must be static")


def _candidate(path, sha, base_meta, what, want_types, static, needs):
    b = _read_bounded(path, BINARY_MAX)
    got = hashlib.sha256(b).hexdigest()
    if got != sha:
        raise Refused(f"candidate {what} sha256 {got} is not the pinned {sha}")
    if got == base_meta["sha256"]:
        raise Refused(f"candidate {what} is byte-identical to the base's; nothing to compose")
    _elf64_amd64(b, path, want_types, static)
    for n in needs:
        if n not in b:
            raise Refused(f"candidate {what} does not carry {n.decode()}; not the opt-in build")
    return {"sha256": got, "size": len(b)}


def load_manifest_tool(path, sha256):
    """Execute exactly the bytes that were hashed, so the tool cannot change between pin check and use."""
    data = _read_bounded(path, TOOL_MAX)
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        raise Refused(f"release-manifest tool {path} sha256 {got} is not the pinned {sha256}")
    mod = types.ModuleType("release_manifest_pinned")
    mod.__file__ = path
    exec(compile(data, path, "exec"), mod.__dict__)
    for name in ("FORMAT", "MEASURE", "canonical", "walk", "write", "verify"):
        if not hasattr(mod, name):
            raise Refused(f"{path} has no {name}; not the release-manifest tool")
    return mod


def _tool(fn, *a):
    try:
        return fn(*a)
    except SystemExit as e:
        raise Refused(f"release-manifest: {e}") from None


def _safe_rel(r):
    if not isinstance(r, str) or not r or "\0" in r or r.startswith("/") or os.path.normpath(r) != r \
            or ".." in r.split("/"):
        raise Refused(f"manifest path {r!r} is not a plain relative path")


def _real_target(p):
    parent = os.path.dirname(p)
    if not os.path.isdir(parent):
        raise Refused(f"parent directory of {p} does not exist")
    return os.path.join(os.path.realpath(parent), os.path.basename(p))


def _under(p, root):
    return p == root or p.startswith(root + os.sep)


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _no_extras(out, files, dirs):
    """Independent of the tool: the output tree is exactly the listed files and dirs, all real, none linked."""
    want_f, want_d, seen_f, seen_d = set(files) | {"release.json"}, set(dirs), set(), set()
    for dp, dns, fns in os.walk(out):
        for n in dns + fns:
            p = os.path.join(dp, n)
            r = os.path.relpath(p, out)
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode):
                seen_d.add(r)
            elif stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                seen_f.add(r)
            else:
                raise Refused(f"output entry {r} is not a plain directory or a single-link regular file")
    if seen_f != want_f or seen_d != want_d:
        raise Refused(f"output has extra or missing entries: {sorted((seen_f ^ want_f) | (seen_d ^ want_d))}")


def compose(base, base_id, init, init_sha256, shim, shim_sha256, tool, tool_sha256, out, receipt, expect=PROD_BASE):
    for v, what in ((base_id, "--base-id"), (init_sha256, "--init-sha256"), (shim_sha256, "--shim-sha256"),
                    (tool_sha256, "--manifest-tool-sha256")):
        _pin(v, what)
    if base_id != expect["id"]:
        raise Refused(f"--base-id {base_id} is not the expected base {expect['id']}")
    base, init, shim, tool, out, receipt = map(os.path.abspath, (base, init, shim, tool, out, receipt))
    if os.path.islink(base) or not os.path.isdir(base):
        raise Refused(f"base {base} must be a real directory, not a symlink")
    for p, what in ((out, "--out"), (receipt, "--receipt")):
        if os.path.lexists(p):
            raise Refused(f"{what} {p} exists; refusing to overwrite")
    rbase = os.path.realpath(base)
    rout, rrec = _real_target(out), _real_target(receipt)
    for p, what in ((rout, "--out"), (rrec, "--receipt")):
        if _under(p, rbase):
            raise Refused(f"{what} {p} is inside the base release; the base is never written")
    if _under(rrec, rout):
        raise Refused("--receipt must not be inside --out; it would be an unlisted release file")

    t = load_manifest_tool(tool, tool_sha256)
    if not stat.S_ISREG(os.lstat(os.path.join(base, "release.json")).st_mode):
        raise Refused("base release.json is not a regular file")
    _, m, n_base = _tool(t.verify, base, base_id)
    if set(m) != MANIFEST_KEYS or not isinstance(m["cmdline"], str):
        raise Refused(f"base manifest keys {sorted(m)} are not exactly {sorted(MANIFEST_KEYS)}")
    files, dirs = m["files"], m["dirs"]
    dirset = set(dirs)
    for r in list(files) + dirs:
        _safe_rel(r)
    for r in files:
        if os.path.dirname(r) and os.path.dirname(r) not in dirset:
            raise Refused(f"{r} has no listed parent directory")
    for r, meta in expect["files"].items():
        if files.get(r) != meta:
            raise Refused(f"base {r} is {files.get(r)}, not the expected {meta}")
    for r in REQUIRED_MARKERS:
        if files.get(r) != ONE_META:
            raise Refused(f"base {r} is {files.get(r)}, not exactly \"1\\n\"; the opt-in needs it unchanged")
    bad = sorted(r for r in list(files) + dirs if any(w in r.lower() for w in FORBIDDEN_WORDS))
    if bad:
        raise Refused(f"base carries {bad}; packed24/experimental inputs must be absent")
    if MARKER in files or MARKER in dirset:
        raise Refused(f"base release already carries {MARKER}")
    if os.path.dirname(MARKER) not in dirset:
        raise Refused(f"base release has no {os.path.dirname(MARKER)} directory for the marker")

    new_init = _candidate(init, init_sha256, files[INIT], "init", (2, 3), True, INIT_NEEDS)
    new_shim = _candidate(shim, shim_sha256, files[SHIM], "shim", (3,), False, SHIM_NEEDS)
    modes = {r: os.lstat(os.path.join(base, r)).st_mode & 0o755 for r in (INIT, SHIM)}

    new_files = dict(files)
    new_files[INIT], new_files[SHIM], new_files[MARKER] = new_init, new_shim, dict(ONE_META)
    expected = t.canonical({"format": t.FORMAT, "cmdline": m["cmdline"], "measure": t.MEASURE,
                            "files": new_files, "dirs": dirs})

    try:
        os.mkdir(out, 0o755)
    except FileExistsError:
        raise Refused(f"--out {out} appeared concurrently; refusing to overwrite") from None
    try:
        for d in dirs:
            os.mkdir(os.path.join(out, d), 0o755)
        for r in sorted(files):
            dst = os.path.join(out, r)
            if r == INIT:
                _copy_pinned(init, dst, new_init["sha256"], new_init["size"], modes[INIT])
            elif r == SHIM:
                _copy_pinned(shim, dst, new_shim["sha256"], new_shim["size"], modes[SHIM])
            else:
                _copy_pinned(os.path.join(base, r), dst, files[r]["sha256"], files[r]["size"])
        _write_new(os.path.join(out, MARKER), ONE, 0o644)

        said = io.StringIO()
        with contextlib.redirect_stdout(said):
            _tool(t.write, out, m["cmdline"])
        rj = os.path.join(out, "release.json")
        st = os.lstat(rj)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MANIFEST_MAX:
            raise Refused("written release.json is not a small regular file")
        with open(rj, "rb") as f:
            written = f.read(MANIFEST_MAX + 1)
        new_id = hashlib.sha256(written).hexdigest()
        if written != expected:
            os.rename(rj, rj + ".rejected")
            raise Refused(f"written manifest {new_id} is not the expected three-path delta of the base")
        if said.getvalue().strip() != f"release {new_id}":
            raise Refused(f"release-manifest reported {said.getvalue().strip()!r}, expected release {new_id}")
        _, nm, n_new = _tool(t.verify, out, new_id)
        _no_extras(out, new_files, dirs)
        for r in files:
            if r not in (INIT, SHIM) and os.lstat(os.path.join(out, r)).st_mode & 0o7777 != \
                    os.lstat(os.path.join(base, r)).st_mode & 0o755:
                raise Refused(f"{r} mode differs from the base")
        for d in [os.path.join(out, d) for d in reversed(dirs)] + [out]:
            _fsync_dir(d)

        _tool(t.verify, base, base_id)
        for p, meta in ((init, new_init), (shim, new_shim)):
            b = _read_bounded(p, BINARY_MAX)
            if {"sha256": hashlib.sha256(b).hexdigest(), "size": len(b)} != meta:
                raise Refused(f"{p} changed during compose")
        changed = sorted(k for k in set(files) | set(nm["files"]) if files.get(k) != nm["files"].get(k))
        if changed != sorted((INIT, SHIM, MARKER)) or nm["dirs"] != dirs or nm["cmdline"] != m["cmdline"] \
                or nm["measure"] != m["measure"] or nm["format"] != m["format"] or n_new != n_base + 1:
            raise Refused(f"new release differs from the base in {changed}, not exactly {sorted((INIT, SHIM, MARKER))}")
    except (Refused, OSError) as e:
        raise Refused(f"{e}; partial output preserved for inspection at {out}; no receipt written") from e

    unchanged = {k: v for k, v in files.items() if k not in (INIT, SHIM)}
    rec = {
        "kind": RECEIPT_KIND,
        "base": {"path": base, "release_id": base_id, "files": n_base, "reverified_after_compose": True},
        "new": {"path": out, "release_id": new_id, "files": n_new},
        "manifest_tool": {"path": tool, "sha256": tool_sha256, "format": t.FORMAT,
                          "is_prod_pinned": tool_sha256 == PROD_MANIFEST_TOOL_SHA256},
        "delta": {"replaced": {INIT: {"old": files[INIT], "new": new_init, "path": init},
                               SHIM: {"old": files[SHIM], "new": new_shim, "path": shim}},
                  "added": {MARKER: dict(ONE_META, content_hex=ONE.hex())},
                  "removed": {}},
        "unchanged": {"files": len(unchanged), "files_canonical_sha256": hashlib.sha256(t.canonical(unchanged)).hexdigest(),
                      "dirs": dirs, "cmdline": m["cmdline"], "measure": m["measure"],
                      "retained_markers": {r: files[r] for r in REQUIRED_MARKERS}},
        "production_pins": {"base_is_prod": base_id == PROD_BASE["id"], "shim_is_reviewed": shim_sha256 == REVIEWED_SHIM_SHA256},
        "rollback": {"release_id": base_id, "path": base,
                     "how": "relaunch on the base release id; the base was only read and re-verified after compose"},
        "not_done": ["measurement not predicted", "release not installed or admitted", "no guest restarted",
                     "not GPU, memory or throughput qualified"],
    }
    data = (json.dumps(rec, indent=2, sort_keys=True) + "\n").encode()
    try:
        _write_new(receipt, data, 0o644)
    except OSError as e:
        raise Refused(f"release {new_id} composed at {out} but the receipt could not be written: {e}") from None
    return rec


FLAGS = ("--base", "--base-id", "--init", "--init-sha256", "--shim", "--shim-sha256", "--manifest-tool",
         "--manifest-tool-sha256", "--out", "--receipt")


def main(argv=None):
    p = argparse.ArgumentParser(prog="compose_init_release.py", allow_abbrev=False,
                                description="Compose af50d526 + pinned init + pinned shim + retire-budget marker.")
    for flag in FLAGS:
        p.add_argument(flag, required=True)
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    for flag in ("--base-id", "--init-sha256", "--shim-sha256", "--manifest-tool-sha256"):
        v = getattr(a, flag[2:].replace("-", "_"))
        if not (len(v) == 64 and set(v) <= HEX):
            print(f"compose_init_release.py: {flag} must be 64 lowercase hex", file=sys.stderr)
            return 2
    try:
        rec = compose(a.base, a.base_id, a.init, a.init_sha256, a.shim, a.shim_sha256, a.manifest_tool,
                      a.manifest_tool_sha256, a.out, a.receipt)
    except (Refused, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(rec, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
