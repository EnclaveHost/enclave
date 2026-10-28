#!/usr/bin/env python3
"""Offline tests for compose_loader_release.py. Tiny release fixtures under a temp dir only; never a real release,
model GGUF, device, service or network. The release-manifest tool is the source copy (read only), or
$RELEASE_MANIFEST_TOOL."""
import ast, contextlib, hashlib, io, json, os, shutil, stat, struct, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compose_loader_release as C  # noqa: E402

TOOL = os.environ.get("RELEASE_MANIFEST_TOOL") or os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "isolation", "m4", "release-manifest.py"))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def elf(tag, interp=False):
    h = bytearray(64)
    h[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", h, 16, 2, 62, 1)
    struct.pack_into("<H", h, 52, 64)
    if interp:
        struct.pack_into("<Q", h, 32, 64)
        struct.pack_into("<HH", h, 54, 56, 1)
        ph = bytearray(56)
        struct.pack_into("<I", ph, 0, 3)
        h += ph
    return bytes(h) + tag


OLD = elf(b"production-loader")
NEW = elf(b"candidate-loader-with-drop-cache")
FILES = {
    "kernel": b"kernel-bytes" * 3,
    "firmware.fd": b"\xff" * 64,
    "template/init": elf(b"dominit"),
    "template/front": elf(b"front"),
    "template/shieldmodel": OLD,
    "template/rt/wasmtime": elf(b"wasmtime"),
    "template/rt/runtime.json": b'{"runtime":"fixture"}\n',
    "template/rt/calib/a.calib": b"calib\n",
    "template/rt/shield-compact-weights.enabled": b"1\n",
    "template/models/m/tokenizer.json": b"{}\n",
}
EMPTY_DIRS = ("template/dev", "template/tmp")


def load_tool():
    with open(TOOL, "rb") as f:
        pin = sha(f.read())
    return C.load_manifest_tool(TOOL, pin), pin


def make_release(root, tool, extra=None):
    os.mkdir(root)
    for r, b in dict(FILES, **(extra or {})).items():
        p = os.path.join(root, r)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(b)
        os.chmod(p, 0o755 if b.startswith(b"\x7fELF") else 0o644)
    for d in EMPTY_DIRS:
        os.mkdir(os.path.join(root, d))
    with contextlib.redirect_stdout(io.StringIO()):
        tool.write(root, "console=ttyS0 rdinit=/init loglevel=3")
    with open(os.path.join(root, "release.json"), "rb") as f:
        return sha(f.read())


def snapshot(root):
    snap = {".": (os.lstat(root).st_mode, os.lstat(root).st_mtime_ns, os.lstat(root).st_ino)}
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = os.path.join(dp, n)
            st = os.lstat(p)
            e = (st.st_mode, st.st_size, st.st_mtime_ns, st.st_ino, st.st_nlink)
            if stat.S_ISREG(st.st_mode):
                with open(p, "rb") as f:
                    e += (sha(f.read()),)
            elif stat.S_ISLNK(st.st_mode):
                e += (os.readlink(p),)
            snap[os.path.relpath(p, root)] = e
    return snap


@unittest.skipUnless(os.path.isfile(TOOL), f"release-manifest tool not found at {TOOL}")
class Compose(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="compose-loader-test-")
        self.tool, self.tool_sha = load_tool()
        self.base = os.path.join(self.tmp, "base")
        self.base_id = make_release(self.base, self.tool)
        self.loader = os.path.join(self.tmp, "shieldmodel-candidate")
        with open(self.loader, "wb") as f:
            f.write(NEW)
        os.chmod(self.loader, 0o755)
        self.out = os.path.join(self.tmp, "new-release")
        self.receipt = os.path.join(self.tmp, "receipt.json")
        self.before = snapshot(self.base)
        self.loader_before = snapshot(os.path.dirname(self.loader))[os.path.basename(self.loader)]

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def compose(self, **over):
        kw = dict(base=self.base, base_id=self.base_id, loader=self.loader, loader_sha256=sha(NEW),
                  tool=TOOL, tool_sha256=self.tool_sha, out=self.out, receipt=self.receipt)
        kw.update(over)
        return C.compose(**kw)

    def refused(self, pattern, **over):
        with self.assertRaisesRegex(C.Refused, pattern):
            self.compose(**over)

    def assert_sources_unchanged(self):
        self.assertEqual(snapshot(self.base), self.before)
        self.assertEqual(snapshot(os.path.dirname(self.loader))[os.path.basename(self.loader)], self.loader_before)
        self.tool.verify(self.base, self.base_id)

    def assert_nothing_written(self):
        self.assertFalse(os.path.lexists(self.out))
        self.assertFalse(os.path.lexists(self.receipt))

    def manifest(self, root):
        with open(os.path.join(root, "release.json"), "rb") as f:
            return json.loads(f.read())

    # ------------------------------------------------------------ success

    def test_exact_two_file_delta(self):
        rec = self.compose()
        new_id = rec["new"]["release_id"]
        _, nm, n = self.tool.verify(self.out, new_id)
        om = self.manifest(self.base)
        self.assertNotEqual(new_id, self.base_id)
        self.assertEqual(n, len(FILES) + 1)
        changed = {k for k in set(om["files"]) | set(nm["files"]) if om["files"].get(k) != nm["files"].get(k)}
        self.assertEqual(changed, {C.LOADER, C.MARKER})
        self.assertEqual(nm["files"][C.LOADER], {"sha256": sha(NEW), "size": len(NEW)})
        self.assertEqual(nm["files"][C.MARKER], {"sha256": sha(b"1\n"), "size": 2})
        self.assertEqual((nm["dirs"], nm["cmdline"], nm["measure"], nm["format"]),
                         (om["dirs"], om["cmdline"], om["measure"], om["format"]))
        for d in EMPTY_DIRS:
            self.assertTrue(os.path.isdir(os.path.join(self.out, d)))
        with open(os.path.join(self.out, C.MARKER), "rb") as f:
            self.assertEqual(f.read(), b"1\n")
        for r, b in FILES.items():
            with open(os.path.join(self.out, r), "rb") as f:
                self.assertEqual(f.read(), NEW if r == C.LOADER else b, r)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(self.out, C.LOADER)).st_mode), 0o755)
        self.assert_sources_unchanged()

    def test_independent_expected_id(self):
        rec = self.compose()
        m = self.manifest(self.base)
        m["files"][C.LOADER] = {"sha256": sha(NEW), "size": len(NEW)}
        m["files"][C.MARKER] = {"sha256": sha(b"1\n"), "size": 2}
        want = json.dumps(m, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        self.assertEqual(rec["new"]["release_id"], sha(want))
        with open(os.path.join(self.out, "release.json"), "rb") as f:
            self.assertEqual(f.read(), want)

    def test_deterministic(self):
        a = self.compose()
        b = self.compose(out=os.path.join(self.tmp, "again"), receipt=os.path.join(self.tmp, "again.json"))
        self.assertEqual(a["new"]["release_id"], b["new"]["release_id"])
        for k in ("delta", "unchanged", "base", "loader", "rollback"):
            self.assertEqual(a[k], b[k], k)

    def test_copies_are_new_inodes(self):
        self.compose()
        for r in FILES:
            o = os.lstat(os.path.join(self.out, r))
            s = os.lstat(self.loader if r == C.LOADER else os.path.join(self.base, r))
            self.assertEqual(o.st_nlink, 1, r)
            self.assertNotEqual((o.st_dev, o.st_ino), (s.st_dev, s.st_ino), r)

    def test_receipt(self):
        rec = self.compose()
        with open(self.receipt) as f:
            self.assertEqual(json.load(f), rec)
        self.assertEqual(rec["kind"], C.RECEIPT_KIND)
        self.assertEqual(set(rec["delta"]["replaced"]), {C.LOADER})
        self.assertEqual(rec["delta"]["replaced"][C.LOADER]["old"], {"sha256": sha(OLD), "size": len(OLD)})
        self.assertEqual(set(rec["delta"]["added"]), {C.MARKER})
        self.assertEqual(rec["delta"]["added"][C.MARKER]["content_hex"], "310a")
        self.assertEqual(rec["delta"]["removed"], {})
        self.assertEqual(rec["unchanged"]["files"], len(FILES) - 1)
        self.assertEqual(rec["rollback"]["release_id"], self.base_id)
        self.assertTrue(rec["base"]["reverified_after_compose"])
        self.assertEqual(rec["production_pins"], {"base_id_is_prod": False, "loader_is_prod": False})
        self.assertEqual(rec["manifest_tool"]["sha256"], self.tool_sha)

    def test_streaming_reads_are_bounded(self):
        real, sizes = os.read, []

        def spy(fd, n):
            sizes.append(n)
            return real(fd, n)
        with mock.patch.object(C, "CHUNK", 7), mock.patch.object(C.os, "read", spy):
            self.compose()
        self.assertTrue(sizes)
        self.assertLessEqual(max(sizes), 7)
        self.tool.verify(self.out, self.manifest_id(self.out))

    def manifest_id(self, root):
        with open(os.path.join(root, "release.json"), "rb") as f:
            return sha(f.read())

    # ------------------------------------------------------------ pins

    def test_rejects_wrong_base_pin(self):
        self.refused("not the pinned release", base_id="0" * 64)
        self.assert_nothing_written()
        self.assert_sources_unchanged()

    def test_rejects_wrong_loader_pin(self):
        self.refused("not the pinned", loader_sha256=sha(b"other"))
        self.assert_nothing_written()

    def test_rejects_wrong_tool_pin(self):
        self.refused("release-manifest tool .* is not the pinned", tool_sha256="f" * 64)
        self.assert_nothing_written()

    def test_rejects_malformed_pins(self):
        for k in ("base_id", "loader_sha256", "tool_sha256"):
            self.refused("64 lowercase hex", **{k: self.base_id.upper()})
            self.refused("64 lowercase hex", **{k: self.base_id[:63]})
        self.assert_nothing_written()

    # ------------------------------------------------------------ destinations

    def test_refuses_existing_out(self):
        os.mkdir(self.out)
        with open(os.path.join(self.out, "sentinel"), "wb") as f:
            f.write(b"keep")
        self.refused("exists; refusing to overwrite")
        self.assertEqual(os.listdir(self.out), ["sentinel"])
        self.assertFalse(os.path.lexists(self.receipt))

    def test_refuses_dangling_symlink_out(self):
        os.symlink(os.path.join(self.tmp, "nowhere"), self.out)
        self.refused("exists; refusing to overwrite")
        self.assertFalse(os.path.lexists(os.path.join(self.tmp, "nowhere")))

    def test_refuses_existing_receipt(self):
        with open(self.receipt, "wb") as f:
            f.write(b"old receipt")
        self.refused("--receipt .* exists")
        with open(self.receipt, "rb") as f:
            self.assertEqual(f.read(), b"old receipt")
        self.assertFalse(os.path.lexists(self.out))

    def test_refuses_out_inside_base(self):
        self.refused("inside the base", out=os.path.join(self.base, "template", "new"))
        self.refused("inside the base", receipt=os.path.join(self.base, "r.json"))
        self.assert_sources_unchanged()

    def test_refuses_receipt_inside_out(self):
        self.refused("", receipt=os.path.join(self.out, "r.json"))
        self.assert_nothing_written()

    # ------------------------------------------------------------ base integrity

    def test_refuses_extra_file(self):
        with open(os.path.join(self.base, "template", "rt", "extra.enabled"), "wb") as f:
            f.write(b"1\n")
        self.refused("not in its manifest")
        self.assert_nothing_written()

    def test_refuses_extra_dir(self):
        os.mkdir(os.path.join(self.base, "template", "newdir"))
        self.refused("directory set differs")
        self.assert_nothing_written()

    def test_refuses_tampered_file(self):
        with open(os.path.join(self.base, "template", "front"), "ab") as f:
            f.write(b"x")
        self.refused("does not match its manifest entry")
        self.assert_nothing_written()

    def test_refuses_symlink_in_base(self):
        os.symlink("init", os.path.join(self.base, "template", "init-link"))
        self.refused("symlink")
        self.assert_nothing_written()

    def test_refuses_symlinked_base(self):
        link = os.path.join(self.tmp, "base-link")
        os.symlink(self.base, link)
        self.refused("not a symlink", base=link)
        self.assert_nothing_written()

    def test_refuses_base_already_with_marker(self):
        base2 = os.path.join(self.tmp, "base2")
        bid = make_release(base2, self.tool, extra={C.MARKER: b"1\n"})
        self.refused("already carries", base=base2, base_id=bid)
        self.assert_nothing_written()

    # ------------------------------------------------------------ candidate

    def _candidate(self, data):
        p = os.path.join(self.tmp, "cand2")
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_refuses_identical_loader(self):
        self.refused("byte-identical", loader=self._candidate(OLD), loader_sha256=sha(OLD))
        self.assert_nothing_written()

    def test_refuses_non_elf_loader(self):
        self.refused("not a little-endian ELF64", loader=self._candidate(b"#!/bin/sh\n"),
                     loader_sha256=sha(b"#!/bin/sh\n"))
        self.assert_nothing_written()

    def test_refuses_dynamic_loader(self):
        dyn = elf(b"dyn", interp=True)
        self.refused("program interpreter", loader=self._candidate(dyn), loader_sha256=sha(dyn))
        self.assert_nothing_written()

    def test_refuses_symlinked_loader(self):
        link = os.path.join(self.tmp, "loader-link")
        os.symlink(self.loader, link)
        self.refused("symlinks are refused", loader=link)
        self.assert_nothing_written()

    # ------------------------------------------------------------ failure keeps partial output

    def test_failure_preserves_partial_output(self):
        real, calls = C._copy_pinned, []

        def flaky(*a, **k):
            calls.append(a[0])
            if len(calls) == 4:
                raise OSError(5, "injected EIO")
            return real(*a, **k)
        with mock.patch.object(C, "_copy_pinned", flaky):
            self.refused("partial output preserved")
        self.assertTrue(os.path.isdir(self.out))
        self.assertFalse(os.path.lexists(os.path.join(self.out, "release.json")))
        self.assertFalse(os.path.lexists(self.receipt))
        for r in sorted(FILES)[:3]:
            with open(os.path.join(self.out, r), "rb") as f:
                self.assertEqual(f.read(), FILES[r])
        self.assert_sources_unchanged()

    def test_source_changed_after_verify_is_refused(self):
        # The fixture (not the composer) mutates a base file between the pinned verify and its copy.
        real = C._copy_pinned

        def mutate_then_copy(src, *a, **k):
            if src.endswith("template/front"):
                with open(src, "ab") as f:
                    f.write(b"x")
            return real(src, *a, **k)
        with mock.patch.object(C, "_copy_pinned", mutate_then_copy):
            self.refused("grew past its pinned size.*partial output preserved")
        self.assertFalse(os.path.lexists(os.path.join(self.out, "release.json")))
        self.assertFalse(os.path.lexists(self.receipt))

    def test_copy_pinned_rejects_mismatch(self):
        dst = os.path.join(self.tmp, "copy")
        with self.assertRaisesRegex(C.Refused, "no longer matches"):
            C._copy_pinned(os.path.join(self.base, "kernel"), dst, "0" * 64, len(FILES["kernel"]))
        os.unlink(dst)
        with self.assertRaisesRegex(C.Refused, "grew past"):
            C._copy_pinned(os.path.join(self.base, "kernel"), dst, sha(FILES["kernel"]), 3)
        self.assert_sources_unchanged()

    # ------------------------------------------------------------ CLI and source hygiene

    def argv(self, **over):
        a = {"--base": self.base, "--base-id": self.base_id, "--loader": self.loader, "--loader-sha256": sha(NEW),
             "--manifest-tool": TOOL, "--manifest-tool-sha256": self.tool_sha, "--out": self.out,
             "--receipt": self.receipt}
        a.update(over)
        return [x for kv in a.items() for x in kv]

    def test_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(C.main(self.argv()), 0)
        with open(self.receipt) as f:
            self.assertEqual(json.loads(out.getvalue()), json.load(f))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(C.main(self.argv(**{"--out": os.path.join(self.tmp, "o2"),
                                                 "--receipt": os.path.join(self.tmp, "r2"),
                                                 "--base-id": "1" * 64})), 1)
            self.assertEqual(C.main(self.argv(**{"--base-id": "XYZ"})), 2)
            self.assertEqual(C.main(self.argv()[:-2]), 2)
            bad = self.argv()
            bad[0] = "--bas"
            self.assertEqual(C.main(bad), 2)
            self.assertEqual(C.main(self.argv() + ["--extra", "x"]), 2)

    def test_no_shell_no_links_no_whole_reads(self):
        with open(C.__file__) as f:
            tree = ast.parse(f.read())
        imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imports |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertFalse(imports & {"subprocess", "shutil", "pty", "multiprocessing"})
        calls = {f"{n.func.value.id}.{n.func.attr}" for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute) and isinstance(n.func.value, ast.Name)}
        self.assertFalse(calls & {"os.system", "os.popen", "os.link", "os.symlink", "os.execv", "os.execve",
                                  "os.spawnv", "os.remove", "os.unlink", "os.rmdir", "os.replace"})
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "read" \
                    and not isinstance(n.func.value, ast.Attribute):
                self.assertTrue(n.args, f"unbounded .read() at line {n.lineno}")


if __name__ == "__main__":
    unittest.main()
