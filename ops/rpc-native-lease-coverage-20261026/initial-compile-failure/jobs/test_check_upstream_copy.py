#!/usr/bin/env python3
"""Offline tests of check_upstream_copy.py on the REAL pinned tarball and the REAL v3 harness (and mutations of it)."""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check_upstream_copy as c  # noqa: E402

TB = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz"
HARNESS = os.path.join(HERE, "..", "src", "zk-utils", "examples", "derivation_harness_lease_v3.rs")


class UpstreamCopy(unittest.TestCase):
    def setUp(self):
        self.text = open(HARNESS, encoding="utf-8").read()

    def test_real_harness_is_verbatim_plus_three_capture_lines(self):
        self.assertEqual(c.check(TB, self.text), [])

    def test_an_edited_upstream_line_is_found(self):
        t = self.text.replace("                    continue;\n                }\n\n                if !E::is_deposit_only_retryable",
                              "                    break;\n                }\n\n                if !E::is_deposit_only_retryable", 1)
        self.assertNotEqual(t, self.text)
        self.assertTrue(any("differs from upstream" in e for e in c.check(TB, t)))

    def test_an_unmarked_inserted_line_is_found(self):
        t = self.text.replace("        intermediate_roots.push(output_root);\n", "        intermediate_roots.push(output_root);\n        let _x = 1;\n", 1)
        self.assertTrue(c.check(TB, t))

    def test_a_dropped_upstream_line_is_found(self):
        t = self.text.replace("        ensure_derived_block_matches_claim(derived_l2_block_number, boot.claimed_l2_block_number)?;\n", "", 1)
        self.assertTrue(c.check(TB, t))

    def test_an_extra_capture_marker_is_refused(self):
        t = self.text.replace("        intermediate_roots.push(output_root);\n", "        intermediate_roots.push(output_root);\n        target = None; // v3-capture\n", 1)
        self.assertTrue(any("exactly 3" in e for e in c.check(TB, t)))

    def test_a_missing_region_marker_is_refused(self):
        with self.assertRaises(ValueError):
            c.check(TB, self.text.replace("// END upstream advance_to_target", "// END", 1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
