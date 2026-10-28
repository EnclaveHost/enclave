#!/usr/bin/env python3
"""compose_loader_release.py -- compose a NEW M4a domain release from a pinned base release (PROD-LOADER.md).

    compose_loader_release.py --base DIR --base-id HEX --loader FILE --loader-sha256 HEX \
        --manifest-tool FILE --manifest-tool-sha256 HEX --out DIR --receipt FILE

The new release is the base release with exactly two differences:
  template/shieldmodel                           replaced by the pinned candidate loader
  template/rt/shield-model-drop-cache.enabled    added, content exactly "1\\n"
Every other file (kernel, firmware, init, front, runtime, modules, model files, calib, profile markers), every
directory and the kernel command line are carried over byte for byte. No packed24, no experimental firmware, no RAM
change: those live in other inputs and none of them is touched.

Order of operations:
  1. strict pins (64 lowercase hex); --out and --receipt must not exist and must not lie inside the base.
  2. load the release-manifest tool from the exact bytes whose sha256 equals --manifest-tool-sha256.
  3. verify the base with that tool against --base-id (every file, every dir, no symlink, no unlisted entry).
  4. hash the candidate loader against --loader-sha256 and require a static amd64 ELF.
  5. mkdir --out (exclusive) and copy every file in bounded chunks into NEW inodes (O_EXCL, never linked), hashing
     the bytes written against the base manifest (or the loader pin) so a source changed since step 3 is refused.
  6. write the marker, let the tool write release.json, require it byte-equal to the expected canonical manifest,
     and verify the new release against its own id.
  7. re-verify the base against --base-id and re-hash the loader (proves the sources were only read), check the
     delta is exactly the two paths, then write the public receipt (exclusive) and print it.

A failure after step 5 starts leaves --out in place for inspection and writes no receipt. A release.json that does
not equal the expected bytes is renamed to release.json.rejected. Nothing under --base or --loader is ever written.
Exit 0 composed, 1 refused, 2 usage.
"""
import argparse, contextlib, hashlib, io, json, os, stat, struct, sys, types

PROD_BASE_ID = "5cab66e478a78adf69c5bb6f058117fcd91cddfb72ca3f6c5d47c109cc47ba17"
PROD_LOADER_SHA256 = "acd688ecd7fdd1bca3a2e6269a948bab36fa066e8dca2b91b1886d4fe4c68d28"
LOADER = "template/shieldmodel"
MARKER = "template/rt/shield-model-drop-cache.enabled"
MARKER_BYTES = b"1\n"
MANIFEST_KEYS = {"format", "cmdline", "measure", "files", "dirs"}
RECEIPT_KIND = "shield-prod-loader-release-receipt/1"
CHUNK = 1 << 20
TOOL_MAX = 1 << 20
MANIFEST_MAX = 16 << 20
HEX = frozenset("0123456789abcdef")


class Refused(Exception):
    pass


def _pin(s, what):
    if not (isinstance(s, str) and len(s) == 64 and set(s) <= HEX):
        raise Refused(f"{what} must be 64 lowercase hex")
    return s


def _open_regular(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as e:
        raise Refused(f"{path}: {e.strerror} (symlinks are refused)") from None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise Refused(f"{path} is not a regular file")
    return fd


def _sha256_file(path):
    fd = _open_regular(path)
    try:
        h, n = hashlib.sha256(), 0
        while True:
            b = os.read(fd, CHUNK)
            if not b:
                return h.hexdigest(), n
            h.update(b)
            n += len(b)
    finally:
        os.close(fd)


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
    """Bounded streaming copy of src into a new inode at dst; the bytes written must hash to the pin.
    mode None keeps the source's permission bits (masked to 0755)."""
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


def _check_static_elf_amd64(path):
    fd = _open_regular(path)
    try:
        h = os.pread(fd, 64, 0)
        if len(h) != 64 or h[:4] != b"\x7fELF" or h[4] != 2 or h[5] != 1:
            raise Refused(f"{path} is not a little-endian ELF64 file")
        e_type, e_machine = struct.unpack_from("<HH", h, 16)
        if e_machine != 62 or e_type not in (2, 3):
            raise Refused(f"{path} is not an x86-64 executable")
        (e_phoff,) = struct.unpack_from("<Q", h, 32)
        e_phentsize, e_phnum = struct.unpack_from("<HH", h, 54)
        if e_phnum > 64 or (e_phnum and e_phentsize != 56):
            raise Refused(f"{path} has an implausible program header table")
        for i in range(e_phnum):
            ph = os.pread(fd, 4, e_phoff + i * 56)
            if len(ph) != 4:
                raise Refused(f"{path} program header {i} is truncated")
            if struct.unpack("<I", ph)[0] == 3:
                raise Refused(f"{path} requests a program interpreter; the loader must be static")
    finally:
        os.close(fd)


def load_manifest_tool(path, sha256):
    """Execute exactly the bytes that were hashed, so the tool cannot change between pin check and use."""
    fd = _open_regular(path)
    with os.fdopen(fd, "rb") as f:
        data = f.read(TOOL_MAX + 1)
    if len(data) > TOOL_MAX:
        raise Refused(f"{path} is larger than {TOOL_MAX} bytes; not a release-manifest tool")
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


def compose(base, base_id, loader, loader_sha256, tool, tool_sha256, out, receipt):
    _pin(base_id, "--base-id")
    _pin(loader_sha256, "--loader-sha256")
    _pin(tool_sha256, "--manifest-tool-sha256")
    base, loader, tool, out, receipt = map(os.path.abspath, (base, loader, tool, out, receipt))
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
    if LOADER not in files:
        raise Refused(f"base release has no {LOADER}")
    if MARKER in files or MARKER in dirset:
        raise Refused(f"base release already carries {MARKER}; it is not the pre-loader base")
    if os.path.dirname(MARKER) not in dirset:
        raise Refused(f"base release has no {os.path.dirname(MARKER)} directory for the marker")

    cand_sha, cand_size = _sha256_file(loader)
    if cand_sha != loader_sha256:
        raise Refused(f"candidate loader sha256 {cand_sha} is not the pinned {loader_sha256}")
    if cand_sha == files[LOADER]["sha256"]:
        raise Refused("candidate loader is byte-identical to the base loader; nothing to compose")
    _check_static_elf_amd64(loader)
    loader_mode = os.lstat(os.path.join(base, LOADER)).st_mode & 0o755

    marker_meta = {"sha256": hashlib.sha256(MARKER_BYTES).hexdigest(), "size": len(MARKER_BYTES)}
    new_files = dict(files)
    new_files[LOADER] = {"sha256": cand_sha, "size": cand_size}
    new_files[MARKER] = marker_meta
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
            if r == LOADER:
                _copy_pinned(loader, dst, cand_sha, cand_size, loader_mode)
            else:
                _copy_pinned(os.path.join(base, r), dst, files[r]["sha256"], files[r]["size"])
        _write_new(os.path.join(out, MARKER), MARKER_BYTES, 0o644)

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
            raise Refused(f"written manifest {new_id} is not the expected two-file delta of the base")
        if said.getvalue().strip() != f"release {new_id}":
            raise Refused(f"release-manifest reported {said.getvalue().strip()!r}, expected release {new_id}")
        _, nm, n_new = _tool(t.verify, out, new_id)
        for d in [os.path.join(out, d) for d in reversed(dirs)] + [out]:
            _fsync_dir(d)

        _tool(t.verify, base, base_id)
        if _sha256_file(loader) != (cand_sha, cand_size):
            raise Refused("candidate loader changed during compose")
        changed = sorted(k for k in set(files) | set(nm["files"]) if files.get(k) != nm["files"].get(k))
        if changed != sorted((LOADER, MARKER)) or nm["dirs"] != dirs or nm["cmdline"] != m["cmdline"] \
                or nm["measure"] != m["measure"] or nm["format"] != m["format"] or n_new != n_base + 1:
            raise Refused(f"new release differs from the base in {changed}, not exactly {sorted((LOADER, MARKER))}")
    except (Refused, OSError) as e:
        raise Refused(f"{e}; partial output preserved for inspection at {out}; no receipt written") from e

    unchanged = {k: v for k, v in files.items() if k != LOADER}
    rec = {
        "kind": RECEIPT_KIND,
        "base": {"path": base, "release_id": base_id, "files": n_base, "reverified_after_compose": True},
        "new": {"path": out, "release_id": new_id, "files": n_new},
        "manifest_tool": {"path": tool, "sha256": tool_sha256, "format": t.FORMAT},
        "loader": {"path": loader, "sha256": cand_sha, "size": cand_size},
        "delta": {"replaced": {LOADER: {"old": files[LOADER], "new": new_files[LOADER]}},
                  "added": {MARKER: dict(marker_meta, content_hex=MARKER_BYTES.hex())},
                  "removed": {}},
        "unchanged": {"files": len(unchanged), "files_canonical_sha256": hashlib.sha256(t.canonical(unchanged)).hexdigest(),
                      "dirs": dirs, "cmdline": m["cmdline"], "measure": m["measure"]},
        "production_pins": {"base_id_is_prod": base_id == PROD_BASE_ID, "loader_is_prod": cand_sha == PROD_LOADER_SHA256},
        "rollback": {"release_id": base_id, "path": base,
                     "how": "relaunch on the base release id; the base was only read and re-verified after compose"},
        "not_done": ["measurement not predicted", "release not installed or admitted", "no guest restarted"],
    }
    data = (json.dumps(rec, indent=2, sort_keys=True) + "\n").encode()
    try:
        _write_new(receipt, data, 0o644)
    except OSError as e:
        raise Refused(f"release {new_id} composed at {out} but the receipt could not be written: {e}") from None
    return rec


def main(argv=None):
    p = argparse.ArgumentParser(prog="compose_loader_release.py", allow_abbrev=False,
                                description="Compose base release + pinned shieldmodel + drop-cache marker.")
    for flag in ("--base", "--base-id", "--loader", "--loader-sha256", "--manifest-tool", "--manifest-tool-sha256",
                 "--out", "--receipt"):
        p.add_argument(flag, required=True)
    try:
        a = p.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    for flag, v in (("--base-id", a.base_id), ("--loader-sha256", a.loader_sha256),
                    ("--manifest-tool-sha256", a.manifest_tool_sha256)):
        if not (len(v) == 64 and set(v) <= HEX):
            print(f"compose_loader_release.py: {flag} must be 64 lowercase hex", file=sys.stderr)
            return 2
    try:
        rec = compose(a.base, a.base_id, a.loader, a.loader_sha256, a.manifest_tool, a.manifest_tool_sha256,
                      a.out, a.receipt)
    except (Refused, OSError) as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(rec, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
