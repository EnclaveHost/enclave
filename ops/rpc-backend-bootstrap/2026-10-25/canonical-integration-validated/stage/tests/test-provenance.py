#!/usr/bin/env python3
"""Immutable artifact/input provenance: the actual build out/, its log, and every input it names still match the pins
recorded in jobs/INPUT-PINS.sha256, and provenance.json binds the artifact to the TESTED candidate source."""
import hashlib, json, pathlib, unittest
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"); IA = W / "canonical-integration-actual"
X = W / "canonical-verifier-binary-stage/run/build-20261026T004633Z"; NEW = "8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378"
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
class Provenance(unittest.TestCase):
    def test_every_recorded_input_is_unchanged(self):
        for l in (IA / "jobs/INPUT-PINS.sha256").read_text().splitlines():
            if l.startswith("#"): continue
            d, f = l.split("  ", 1); self.assertEqual(sha(W / f), d, f)
    def test_out_sums_and_artifact(self):
        for l in (X / "out/SHA256SUMS").read_text().splitlines():
            d, f = l.split("  ", 1); self.assertEqual(sha(X / "out" / f), d, f)
        self.assertEqual(sha(X / "out/helios"), NEW)
        p = json.loads((X / "out/provenance.json").read_text()); self.assertEqual(p["artifact"]["sha256"], NEW)
        self.assertEqual(p["artifact"]["bytes"], (X / "out/helios").stat().st_size)
    def test_provenance_binds_the_tested_source(self):
        p = json.loads((X / "out/provenance.json").read_text()); s = p["source"]; S = W / "verifier-canonical-stage"
        self.assertEqual((s["baseCommit"], s["baseTree"], s["cargoLockSha256Prefix"]), ("eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e", "2171ad2bfd3c97f2e0e029e866b1a8535cbbd187", "28f4400cef93f04c28c2"))
        self.assertEqual(s["patch"]["sha256"], sha(S / "canonical-block.patch")); self.assertTrue(s["patch"]["sha256"].startswith("41667ec9"))
        self.assertEqual(s["patchedFiles"], {l.split()[1]: l.split()[0] for l in (S / "PATCHED.sha256").read_text().splitlines()})
        self.assertEqual((s["vendor"]["sha256"][:8], s["vendor"]["extractionTreehash"][:8]), ("9784e20a", "c9301490"))
        b = p["build"]; self.assertIn("dev", b["profile"]); self.assertEqual((b["sourceDateEpoch"], b["jobs"], b["incremental"]), (1792720709, 1, 0))
        self.assertIn("rustc 1.96.0", b["toolchain"]); self.assertIn("NOT an independent reproduction", p["claims"])
        ev = {l.split("  ")[1]: l.split("  ")[0] for l in (W / "canonical-verifier-binary-stage/jobs/TESTED-EVIDENCE.sha256").read_text().splitlines()}
        self.assertEqual(p["testedBy"], ev)
        for f, d in ev.items(): self.assertEqual(sha(W / f), d, f)
    def test_build_log_and_rebuilt_path_packages(self):
        out = (W / "logs/root-canonical-helios-build-0046.out").read_text()
        self.assertIn(f"## rc=0 (canonical Helios artifact {NEW} built", out); self.assertTrue(out.rstrip().endswith("[queue] EXIT 0"))
        self.assertEqual((W / "logs/root-canonical-helios-build-0046.rc").read_text().strip(), "0")
        arts = [json.loads(l) for l in (X / "build.json").read_text().splitlines() if l.startswith('{"reason":"compiler-artifact"')]
        path = [a for a in arts if a["package_id"].startswith("path+file://")]
        self.assertEqual(len(path), 21); self.assertTrue(all(not a["fresh"] and a["manifest_path"].startswith(str(X) + "/") for a in path))
        h = [a for a in path if a["target"]["name"] == "helios" and a["target"]["kind"] == ["bin"]]; self.assertEqual(len(h), 1)
if __name__ == "__main__": unittest.main(verbosity=2)
