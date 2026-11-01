from pathlib import Path
import importlib.util
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_vmgs", Path(__file__).with_name("prepare_vmgs.py"))
vmgs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vmgs)


def fixture():
    raw = bytearray(vmgs.FILE_BYTES)
    raw[:4 * vmgs.BLOCK] = vmgs.fresh_prefix()
    footer = bytearray(512)
    footer[:8] = b"conectix"
    struct.pack_into(">IIQ", footer, 8, 2, 0x10000, 0xffffffffffffffff)
    struct.pack_into(">I", footer, 32, 0x000a0000)
    struct.pack_into(">QQ", footer, 40, vmgs.CAPACITY, vmgs.CAPACITY)
    struct.pack_into(">I", footer, 60, 2)
    footer[68:84] = bytes(range(16))
    struct.pack_into(">I", footer, 64, ~sum(footer) & 0xffffffff)
    raw[-512:] = footer
    return raw


class FreshVMGS(unittest.TestCase):
    def test_empty_store_and_inherited_state_refusals(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state"
            original = fixture()
            path.write_bytes(original)
            self.assertTrue(vmgs.check_fresh(path)["pristine"])
            # Metadata key, allocated TPM entry, blank extended table,
            # unreferenced payload and the unused alternate header all refuse.
            for offset in (40, 2 * 4096 + 3 * 64, 3 * 4096, 256 * 4096, 512):
                with self.subTest(offset=offset):
                    changed = original.copy()
                    changed[offset] ^= 1
                    path.write_bytes(changed)
                    with self.assertRaises(ValueError):
                        vmgs.check_fresh(path)

    def test_footer_corruption_and_truncation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state"
            for offset in (-512, -448, -428):
                changed = fixture()
                changed[offset] ^= 1
                path.write_bytes(changed)
                with self.assertRaises(ValueError):
                    vmgs.check_fresh(path)
            path.write_bytes(fixture()[:-1])
            with self.assertRaises(ValueError):
                vmgs.check_fresh(path)

    def test_existing_attempt_and_symlink_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(FileExistsError):
                vmgs.prepare(root / "missing-tool", root)
            target = root / "target"
            target.write_bytes(fixture())
            link = root / "link"
            link.symlink_to(target)
            with self.assertRaises(OSError):
                vmgs.check_fresh(link)


if __name__ == "__main__":
    unittest.main()
