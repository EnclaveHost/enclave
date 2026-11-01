"""Packaging refusals and independent malformed IGVM structural readback."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

spec = importlib.util.spec_from_file_location("rpc_igvm", Path(__file__).resolve().parents[2] / "isolation/m3/build-rpc-igvm.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class RpcIgvmBuild(unittest.TestCase):
    def test_old_stock_paravisor_refused_before_output(self):
        inputs = {name: {"path": "/unused", "sha256": pin} for name, pin in build.PINS.items()}
        inputs.update({name: {"path": "/unused", "sha256": "1" * 64} for name in ("linux_kernel", "linux_initrd", "profile", "guestReceipt")})
        inputs["underhill_initrd"]["sha256"] = "aa84ff85dc457f88009c34e443f231fd48df5170199d2496d71681bdf79acdb4"
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "out"
            with self.assertRaisesRegex(ValueError, "unreviewed OpenHCL"):
                build.build({"schema": "enclave-rpc-igvm-build/1", "inputs": inputs}, out)
            self.assertFalse(out.exists())

    def test_duplicate_json_and_changed_pin_refuse(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            build.decode(b'{"inputs":{},"inputs":{}}')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "source").write_bytes(b"different input")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                build.copy_pinned({"path": str(root / "source"), "sha256": "1" * 64}, root / "copy")
            self.assertTrue((root / "copy").exists())  # retain partial evidence

    def test_platform_and_truncation_refuse(self):
        def image(platform=1, length=16):
            entry = struct.pack("<IIIBBHQ", 1, length, 1, 2, platform, 1, 0)
            header = struct.pack("<6I", 0x4D564749, 1, 24, len(entry), 24 + len(entry), 0)
            return header[:20] + struct.pack("<I", zlib.crc32(header + entry)) + entry
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "image"
            path.write_bytes(image())
            self.assertEqual(build.check_igvm(path)["platforms"][0]["highestVtl"], 2)
            for bad in (image(platform=0), image(length=32), image()[:-1]):
                path.write_bytes(bad)
                with self.assertRaises(ValueError):
                    build.check_igvm(path)

    def test_header_corruption_refused_by_crc(self):
        entry = struct.pack("<IIIBBHQ", 1, 16, 1, 2, 1, 1, 0)
        header = struct.pack("<6I", 0x4D564749, 1, 24, len(entry), 24 + len(entry), 0)
        raw = bytearray(header[:20] + struct.pack("<I", zlib.crc32(header + entry)) + entry)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "image"
            path.write_bytes(raw)
            self.assertTrue(build.check_igvm(path)["headerCrcVerified"])
            raw[-1] ^= 1
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "CRC"):
                build.check_igvm(path)


if __name__ == "__main__":
    unittest.main()
