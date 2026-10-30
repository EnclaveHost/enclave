#!/usr/bin/env python3
"""Offline tests for compose_init_release.py. Tiny release fixtures under a temp dir only; never a real release,
model GGUF, device, service or network. The release-manifest tool is the source copy (read only), or
$RELEASE_MANIFEST_TOOL (e.g. the production-pinned iso-sdshield-1c3cdbb8 copy, sha256 6facdb9a...)."""
import contextlib, hashlib, io, os, shutil, stat, struct, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compose_init_release as C  # noqa: E402

TOOL = os.environ.get("RELEASE_MANIFEST_TOOL") or os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "source", "isolation", "m4", "release-manifest.py"))
CMDLINE = "console=ttyS0 rdinit=/init loglevel=3"


def sha(b):
    return hashlib.sha256(b).hexdigest()


def meta(b):
    return {"sha256": sha(b), "size": len(b)}


def elf(tag, e_type=2, interp=False):
    h = bytearray(64)
    h[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", h, 16, e_type, 62, 1)
    struct.pack_into("<H", h, 52, 64)
    if interp:
        struct.pack_into("<Q", h, 32, 64)
        struct.pack_into("<HH", h, 54, 56, 1)
        ph = bytearray(56)
        struct.pack_into("<I", ph, 0, 3)
        h += ph
    return bytes(h) + tag


OLD_INIT = elf(b"dominit")
OLD_SHIM = elf(b"shim-default", 3)
NEW_INIT = elf(b"dominit-retire\0" + b"\0".join(C.INIT_NEEDS) + b"\0")
NEW_SHIM = elf(b"shim-bounded\0ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB\0", 3)
LOADER = elf(b"shieldmodel-drop-cache")
FILES = {
    "template/rt/runtime.json": b'{"name":"fixture"}\n',
    "kernel": b"kernel-bytes" * 3,
    "firmware.fd": b"\xff" * 64,
    "template/init": OLD_INIT,
    "template/front": elf(b"front"),
    "template/shieldmodel": LOADER,
    "template/rt/libenclave_llama.so": OLD_SHIM,
    "template/rt/backends/libggml-shielded.so": elf(b"backend", 3),
    "template/rt/wasmtime": elf(b"wasmtime"),
    "template/rt/calib/a.calib": b"calib\n",
    "template/rt/shield-original-source-reclaim.enabled": b"1\n",
    "template/rt/shield-model-drop-cache.enabled": b"1\n",
    "template/rt/shield-compact-weights.enabled": b"1\n",
    "template/models/m/tokenizer.json": b"{}\n",
}
EMPTY_DIRS = ("template/dev", "template/tmp")
DELTA = sorted((C.INIT, C.SHIM, C.MARKER))


def load_tool():
    with open(TOOL, "rb") as f:
        pin = sha(f.read())
    return C.load_manifest_tool(TOOL, pin), pin


def make_release(root, tool, extra=None, drop=()):
    os.mkdir(root)
    for r, b in dict(FILES, **(extra or {})).items():
        if r in drop:
            continue
        p = os.path.join(root, r)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(b)
        os.chmod(p, 0o755 if b.startswith(b"\x7fELF") else 0o644)
    for d in EMPTY_DIRS:
        os.mkdir(os.path.join(root, d))
    with contextlib.redirect_stdout(io.StringIO()):
        tool.write(root, CMDLINE)
    with open(os.path.join(root, "release.json"), "rb") as f:
        return sha(f.read())


def snapshot(root):
    snap = {}
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = os.path.join(dp, n)
            st = os.lstat(p)
            e = (st.st_mode, st.st_size, st.st_mtime_ns, st.st_ino, st.st_nlink)
            if stat.S_ISREG(st.st_mode):
                with open(p, "rb") as f:
                    e += (sha(f.read()),)
            snap[os.path.relpath(p, root)] = e
    return snap


@unittest.skipUnless(os.path.isfile(TOOL), f"release-manifest tool not found at {TOOL}")
class Compose(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="compose-init-test-")
        self.tool, self.tool_sha = load_tool()
        self.new_base()
        self.init = self.put("init-candidate", NEW_INIT)
        self.shim = self.put("libenclave_llama.so-candidate", NEW_SHIM)
        self.out = os.path.join(self.tmp, "new-release")
        self.receipt = os.path.join(self.tmp, "receipt.json")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def new_base(self, extra=None, drop=()):
        self.base = os.path.join(self.tmp, "base")
        if os.path.exists(self.base):
            shutil.rmtree(self.base)
        self.base_id = make_release(self.base, self.tool, extra, drop)
        self.expect = {"id": self.base_id, "files": {r: meta(FILES[r]) for r in
                                                     (C.INIT, C.SHIM, "template/shieldmodel")}}
        self.before = snapshot(self.base)

    def put(self, name, b, mode=0o755):
        p = os.path.join(self.tmp, name)
        with open(p, "wb") as f:
            f.write(b)
        os.chmod(p, mode)
        return p

    def compose(self, **over):
        kw = dict(base=self.base, base_id=self.base_id, init=self.init, init_sha256=sha(NEW_INIT), shim=self.shim,
                  shim_sha256=sha(NEW_SHIM), tool=TOOL, tool_sha256=self.tool_sha, out=self.out,
                  receipt=self.receipt, expect=self.expect)
        kw.update(over)
        return C.compose(**kw)

    def refused(self, pattern, **over):
        with self.assertRaisesRegex(C.Refused, pattern):
            self.compose(**over)
        self.assertFalse(os.path.lexists(self.receipt))

    # -- the one success path ------------------------------------------------------------------------------------
    def test_exact_three_path_delta(self):
        rec = self.compose()
        _, nm, n = self.tool.verify(self.out, rec["new"]["release_id"])
        _, bm, nb = self.tool.verify(self.base, self.base_id)
        changed = sorted(k for k in set(bm["files"]) | set(nm["files"]) if bm["files"].get(k) != nm["files"].get(k))
        self.assertEqual(changed, DELTA)
        self.assertEqual((nm["dirs"], nm["cmdline"], nm["measure"], n), (bm["dirs"], bm["cmdline"], bm["measure"], nb + 1))
        self.assertEqual(nm["files"][C.INIT], meta(NEW_INIT))
        self.assertEqual(nm["files"][C.SHIM], meta(NEW_SHIM))
        with open(os.path.join(self.out, C.MARKER), "rb") as f:
            self.assertEqual(f.read(), b"1\n")
        for r, b in FILES.items():                     # every other file byte for byte, same mode, own inode
            if r in (C.INIT, C.SHIM):
                continue
            p, q = os.path.join(self.out, r), os.path.join(self.base, r)
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b, r)
            self.assertEqual(os.lstat(p).st_mode, os.lstat(q).st_mode, r)
            self.assertNotEqual(os.lstat(p).st_ino, os.lstat(q).st_ino, r)
        for r in (C.INIT, C.SHIM):
            self.assertEqual(os.lstat(os.path.join(self.out, r)).st_mode & 0o777, 0o755)
        for dp, dns, fns in os.walk(self.out):
            for x in dns + fns:
                st = os.lstat(os.path.join(dp, x))
                self.assertFalse(stat.S_ISLNK(st.st_mode))
                if stat.S_ISREG(st.st_mode):
                    self.assertEqual(st.st_nlink, 1)
        self.assertEqual(snapshot(self.base), self.before)                  # base only read
        self.assertEqual(rec["rollback"]["release_id"], self.base_id)
        self.assertTrue(rec["base"]["reverified_after_compose"])
        self.assertEqual(sorted(rec["unchanged"]["retained_markers"]), sorted(C.REQUIRED_MARKERS))
        self.assertTrue(os.path.isfile(self.receipt))

    def test_independent_expected_id(self):
        _, bm, _ = self.tool.verify(self.base, self.base_id)
        files = dict(bm["files"], **{C.INIT: meta(NEW_INIT), C.SHIM: meta(NEW_SHIM), C.MARKER: meta(b"1\n")})
        want = sha(self.tool.canonical({"format": self.tool.FORMAT, "cmdline": CMDLINE, "measure": self.tool.MEASURE,
                                        "files": files, "dirs": bm["dirs"]}))
        self.assertEqual(self.compose()["new"]["release_id"], want)

    # -- output and pins -----------------------------------------------------------------------------------------
    def test_out_and_receipt_rules(self):
        os.mkdir(self.out)
        self.refused("--out .* exists")
        os.rmdir(self.out)
        self.refused("inside the base", out=os.path.join(self.base, "x"))
        self.refused("must not be inside --out", receipt=self.out)
        self.put("receipt.json", b"{}", 0o644)
        with self.assertRaisesRegex(C.Refused, "--receipt .* exists"):
            self.compose()
        self.assertFalse(os.path.lexists(self.out))

    def test_pins(self):
        self.refused("64 lowercase hex", init_sha256="ABC")
        self.refused("not the expected base", base_id="0" * 64)
        self.refused("release-manifest tool", tool_sha256="0" * 64)
        self.refused("candidate init sha256", init_sha256="0" * 64)
        self.refused("candidate shim sha256", shim_sha256="0" * 64)
        self.assertFalse(os.path.lexists(self.out))

    # -- the base must be exactly the reviewed af50d526 shape -------------------------------------------------------
    def test_base_tampered_or_extra(self):
        with open(os.path.join(self.base, "template/front"), "ab") as f:
            f.write(b"x")
        self.refused(".")
        self.new_base()
        self.put("base/template/unlisted", b"x", 0o644)
        self.refused(".")
        self.new_base()
        os.symlink("front", os.path.join(self.base, "template/front-link"))
        self.refused(".")

    def test_base_expected_binaries(self):
        for r in (C.INIT, C.SHIM, "template/shieldmodel"):
            with self.subTest(r=r):
                self.refused(f"base {r} is", expect=dict(self.expect, files=dict(self.expect["files"], **{
                    r: {"sha256": "0" * 64, "size": 1}})))

    def test_required_markers(self):
        for r in C.REQUIRED_MARKERS:
            with self.subTest(r=r, case="missing"):
                self.new_base(drop=(r,))
                self.refused("opt-in needs it unchanged")
            with self.subTest(r=r, case="content"):
                self.new_base(extra={r: b"0\n"})
                self.refused("opt-in needs it unchanged")

    def test_forbidden_and_preexisting(self):
        self.new_base(extra={"template/rt/shield-packed24.enabled": b"1\n"})
        self.refused("packed24/experimental")
        self.new_base(extra={"experimental-firmware.fd": b"\0"})
        self.refused("packed24/experimental")
        self.new_base(extra={C.MARKER: b"1\n"})
        self.refused("already carries")

    # -- candidates ---------------------------------------------------------------------------------------------------
    def test_candidate_init(self):
        p = self.put("same-init", OLD_INIT)
        self.refused("byte-identical", init=p, init_sha256=sha(OLD_INIT))
        b = elf(b"no-wiring")
        self.refused("not the opt-in build", init=self.put("i2", b), init_sha256=sha(b))
        b = elf(b"".join(C.INIT_NEEDS), interp=True)
        self.refused("program interpreter", init=self.put("i3", b), init_sha256=sha(b))
        b = b"#!/bin/sh\n" + b"".join(C.INIT_NEEDS)
        self.refused("ELF64", init=self.put("i4", b), init_sha256=sha(b))
        os.symlink(self.init, os.path.join(self.tmp, "init-link"))
        self.refused("symlinks are refused", init=os.path.join(self.tmp, "init-link"))

    def test_candidate_shim(self):
        p = self.put("same-shim", OLD_SHIM)
        self.refused("byte-identical", shim=p, shim_sha256=sha(OLD_SHIM))
        b = elf(b"ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB", 2)
        self.refused("type", shim=self.put("s2", b), shim_sha256=sha(b))
        b = elf(b"no-env", 3)
        self.refused("not the opt-in build", shim=self.put("s3", b), shim_sha256=sha(b))

    # -- failure after output starts ------------------------------------------------------------------------------
    def test_source_changed_during_copy(self):
        real = C._copy_pinned

        def racing(src, dst, *a, **k):
            if src.endswith("template/front"):
                with open(src, "ab") as f:
                    f.write(b"late")
            return real(src, dst, *a, **k)

        with mock.patch.object(C, "_copy_pinned", side_effect=racing):
            self.refused("partial output preserved")
        self.assertTrue(os.path.isdir(self.out))

    def test_candidate_changed_during_compose(self):
        real = C._copy_pinned

        def swap(src, dst, *a, **k):
            r = real(src, dst, *a, **k)
            if src == self.shim:
                with open(self.shim, "ab") as f:
                    f.write(b"x")
            return r

        with mock.patch.object(C, "_copy_pinned", side_effect=swap):
            self.refused("changed during compose")

    # -- CLI ------------------------------------------------------------------------------------------------------
    def test_cli(self):
        args = ["--base", self.base, "--base-id", self.base_id, "--init", self.init, "--init-sha256", sha(NEW_INIT),
                "--shim", self.shim, "--shim-sha256", sha(NEW_SHIM), "--manifest-tool", TOOL,
                "--manifest-tool-sha256", self.tool_sha, "--out", self.out, "--receipt", self.receipt]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(C.main(args[:-2]), 2)
            self.assertEqual(C.main([a if a != sha(NEW_INIT) else "x" for a in args]), 2)
            self.assertEqual(C.main(args), 1)        # the CLI only takes production af50d526, never a fixture
        self.assertFalse(os.path.lexists(self.out))


if __name__ == "__main__":
    unittest.main()
