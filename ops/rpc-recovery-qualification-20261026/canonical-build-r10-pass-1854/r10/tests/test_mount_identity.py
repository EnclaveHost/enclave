#!/usr/bin/env python3
"""base-state-readonly-stage/r7 tests of jobs/mount_identity.py (PREPARED by Claude 1735; NOT run by Claude). Pure parser fixtures
(no findmnt, no mount): the exact padded shape root observed for the r5 build (two trailing spaces), unpadded, missing / extra
fields, every single-field mismatch, several lines / empty output, and the CLI refusing whitespace in a pinned value."""
import contextlib, importlib.util, io, unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("mount_identity", Path(__file__).resolve().parent.parent / "jobs" / "mount_identity.py")
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)
WANT = {"uuid": "aaae081c-f829-4484-a50f-a9bbb87d31f9", "source": "/dev/mapper/cryptvm", "fstype": "ext4", "majmin": "253:1"}
ROW = "aaae081c-f829-4484-a50f-a9bbb87d31f9 /dev/mapper/cryptvm ext4   253:1"


class Parser(unittest.TestCase):
    def test_padded_valid_line_as_observed_by_root(self):
        self.assertEqual(M.check(ROW + "  \n", WANT)[0], True)                      # two trailing spaces (root's r5 build)
        self.assertEqual(M.check("  " + ROW.replace(" ", "\t", 1) + "   \n\n", WANT)[0], True)   # any column padding

    def test_missing_field_refused(self):
        ok, why = M.check("aaae081c-f829-4484-a50f-a9bbb87d31f9 /dev/mapper/cryptvm ext4  \n", WANT)
        self.assertFalse(ok); self.assertIn("exactly 4 fields", why)

    def test_extra_field_refused(self):
        ok, why = M.check(ROW + " extra  \n", WANT)
        self.assertFalse(ok); self.assertIn("exactly 4 fields", why)

    def test_wrong_device_each_field_refused(self):
        for field, other in (("uuid", "00000000-0000-0000-0000-000000000000"), ("source", "/dev/mapper/other"), ("fstype", "xfs"), ("majmin", "253:2")):
            with self.subTest(field=field):
                row = ROW.split(); row[M.FIELDS.index(field)] = other
                ok, why = M.check(" ".join(row) + "  \n", WANT)
                self.assertFalse(ok); self.assertTrue(why.startswith(field), why)

    def test_several_lines_or_no_output_refused(self):
        self.assertFalse(M.check(ROW + "\n" + ROW + "\n", WANT)[0])
        self.assertFalse(M.check("", WANT)[0]); self.assertFalse(M.check("  \n", WANT)[0])

    def test_cli_refuses_whitespace_in_pinned_value(self):
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            rc = M.main(["--target", "/nonexistent", "--uuid", WANT["uuid"] + " ", "--source", WANT["source"],
                         "--fstype", WANT["fstype"], "--majmin", WANT["majmin"]])
        self.assertEqual(rc, 9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
