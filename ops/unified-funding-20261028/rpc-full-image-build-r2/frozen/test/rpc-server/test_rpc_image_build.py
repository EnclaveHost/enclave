"""RPC image assembly: inert file-format checks, no module/device execution."""
import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("rpc_image_build", ROOT / "isolation/m3/build-rpc.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def read_cpio(raw):
    """Independent strict newc reader, also used for actual artifact readback."""
    offset, result = 0, {}
    while True:
        header = raw[offset:offset + 110]
        if len(header) != 110 or header[:6] != b"070701": raise ValueError("newc header")
        row = [int(header[i:i + 8], 16) for i in range(6, 110, 8)]
        ino, mode, uid, gid, links, mtime, size, maj, minor, rmaj, rminor, namesize, crc = row
        offset += 110
        name = raw[offset:offset + namesize]
        if not namesize or not name.endswith(b"\0") or b"\0" in name[:-1]: raise ValueError("name")
        name = name[:-1].decode("utf-8")
        offset += namesize
        padding = -offset % 4
        if raw[offset:offset + padding] != b"\0" * padding: raise ValueError("name padding")
        offset += padding
        data = raw[offset:offset + size]
        if len(data) != size: raise ValueError("truncation")
        offset += size
        padding = -size % 4
        if raw[offset:offset + padding] != b"\0" * padding: raise ValueError("data padding")
        offset += padding
        if any((uid, gid, mtime, maj, minor, rmaj, rminor, crc)): raise ValueError("metadata")
        if name == "TRAILER!!!":
            if size or mode or offset != len(raw): raise ValueError("trailer")
            return result
        if name in result or name.startswith("/") or (name != "." and any(p in ("", ".", "..") for p in name.split("/"))): raise ValueError("path")
        kind = stat.S_IFMT(mode)
        if kind not in (stat.S_IFDIR, stat.S_IFREG): raise ValueError("file type")
        if kind == stat.S_IFDIR and (data or stat.S_IMODE(mode) != (0o1777 if name == "tmp" else 0o755)): raise ValueError("directory mode")
        if kind == stat.S_IFREG and (links != 1 or stat.S_IMODE(mode) not in (0o444, 0o555)): raise ValueError("file mode/links")
        result[name] = (data, stat.S_IMODE(mode), kind)


def module(name=b"nbd", release=None, depends=b""):
    release = release or build.base.KERNEL_RELEASE.encode() + b" SMP mod_unload modversions "
    strings = b"\0.shstrtab\0.modinfo\0"
    info = b"name=" + name + b"\0depends=" + depends + b"\0vermagic=" + release + b"\0"
    start = 64 + 3 * 64
    header = struct.pack("<16sHHIQQQIHHHHHH", b"\x7fELF\x02\x01\x01", 1, 62, 1, 0, 0, 64, 0, 64, 0, 0, 64, 3, 1)
    def section(n, t, off, size): return struct.pack("<IIQQQQIIQQ", n, t, 0, 0, off, size, 0, 0, 1, 0)
    return header + bytes(64) + section(1, 3, start, len(strings)) + section(11, 1, start + len(strings), len(info)) + strings + info


class RpcImageBuild(unittest.TestCase):
    def test_archive_independent_readback_determinism(self):
        files = {"init": (b"boot", 0o555), "plat/native-rpc/nbd.ko": (b"module", 0o444)}
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a.gz", Path(d) / "b.gz"
            receipt = build.archive(a, files); build.archive(b, dict(reversed(list(files.items()))))
            self.assertEqual(a.read_bytes(), b.read_bytes())
            raw = gzip.decompress(a.read_bytes()); parsed = read_cpio(raw)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), receipt["cpioSha256"])
            self.assertEqual(len(raw), receipt["cpioBytes"])
            self.assertEqual({p: (v[0], v[1]) for p, v in parsed.items() if v[2] == stat.S_IFREG}, files)
            self.assertEqual(set(parsed), {r["path"] for r in receipt["entries"]})

    def test_archive_refuses_aliases_types_and_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "out"
            for path, mode in (("../escape", 0o444), ("/absolute", 0o444), ("a//b", 0o444), ("a\0b", 0o444), ("TRAILER!!!", 0o444), ("plat", 0o444), ("setuid", 0o4555), ("link", stat.S_IFLNK | 0o777)):
                with self.subTest(path=path):
                    with self.assertRaises(build.base.BuildError): build.archive(out, {path: (b"x", mode)})
                    self.assertFalse(out.exists())
            build.archive(out, {})
            with self.assertRaises(FileExistsError): build.archive(out, {})

    def test_large_copy_rechecks_digest_geometry_type(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "input"; src.write_bytes(b"root data")
            pin = {"path": str(src), "sha256": hashlib.sha256(src.read_bytes()).hexdigest()}
            out = io.BytesIO(); digest = build.copy_checked(pin, 9, out, b"header")
            self.assertEqual(out.getvalue(), b"headerroot data")
            self.assertEqual(digest, hashlib.sha256(out.getvalue()).hexdigest())
            with self.assertRaises(build.base.BuildError): build.copy_checked(pin, 8)
            src.write_bytes(b"otherdata")
            with self.assertRaises(build.base.BuildError): build.copy_checked(pin, 9)
            alias = Path(d) / "alias"; alias.symlink_to(src)
            with self.assertRaises(OSError): build.copy_checked({**pin, "path": str(alias)}, 9)

    def test_copy_detects_mutation_during_write(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "input"; src.write_bytes(b"original")
            pin = {"path": str(src), "sha256": hashlib.sha256(src.read_bytes()).hexdigest()}
            class Mutator(io.BytesIO):
                def write(self, data):
                    src.write_bytes(b"modified")
                    return super().write(data)
            with self.assertRaises(build.base.BuildError): build.copy_checked(pin, 8, Mutator())

    def test_nbd_identity_architecture_and_sections(self):
        self.assertTrue(build.module_info(module()).startswith(build.base.KERNEL_RELEASE))
        bad = [module(name=b"other"), module(release=b"6.6.other SMP"), module(depends=b"other"), module()[:-1]]
        for offset, fmt, value in ((18, "H", 183), (52, "H", 63), (58, "H", 63), (64 + 64 + 4, "I", 8), (64 + 128 + 4, "I", 8), (40, "Q", 1 << 40)):
            data = bytearray(module()); struct.pack_into("<" + fmt, data, offset, value); bad.append(bytes(data))
        for i, data in enumerate(bad):
            with self.subTest(case=i):
                with self.assertRaises(build.base.BuildError): build.module_info(data)

    def test_dependency_closure_missing_and_ambiguous(self):
        # The ELF parser itself is separately qualified; these cases test its
        # dependency results against this builder's archive path rules.
        with patch.object(build.rootbuild, "elf", return_value=(["lib64/ld.so"], ["libc.so"])):
            files = {"tool": (b"tool", 0o555), "lib64/ld.so": (b"ld", 0o555), "usr/lib/libc.so": (b"c", 0o555)}
            build.closure(files)
            for missing in ("lib64/ld.so", "usr/lib/libc.so"):
                with self.subTest(missing=missing):
                    with self.assertRaises(build.base.BuildError): build.closure({k: v for k, v in files.items() if k != missing})
            with self.assertRaises(build.base.BuildError): build.closure({**files, "another/libc.so": (b"other", 0o555)})

    def test_storage_exact_loader_copy_and_alias_mismatch(self):
        pins = {n: n.encode() for n in build.base.STORAGE_FIXED}
        with patch.object(build, "pinned", side_effect=lambda p, limit: p), patch.object(build.rootbuild, "elf", return_value=(["usr/lib/ld-linux-x86-64.so.2"], [])):
            files = build.storage_files(pins)
            self.assertEqual(files["usr/lib/ld-linux-x86-64.so.2"], files["lib64/ld-linux-x86-64.so.2"])
            with self.assertRaises(build.base.BuildError):
                build.storage_files({**pins, "usr/lib64/ld-linux-x86-64.so.2": b"wrong-loader"})


if __name__ == "__main__": unittest.main()
