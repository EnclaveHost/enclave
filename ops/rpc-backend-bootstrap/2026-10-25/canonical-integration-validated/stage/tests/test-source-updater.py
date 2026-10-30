#!/usr/bin/env python3
"""The FROZEN source updater (make-source-update.py 881df987) refuses malformed/mismatched provenance, and on the real
artifact deterministically regenerates the reviewed candidate (with tools/make-doc-edits.py) byte for byte."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"); IA = W / "canonical-integration-actual"
GEN = W / "canonical-verifier-binary-stage/integration/make-source-update.py"; DOC = IA / "tools/make-doc-edits.py"
OUT = W / "canonical-verifier-binary-stage/run/build-20261026T004633Z/out"; OLD = "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0"
sha = lambda b: hashlib.sha256(b).hexdigest()
def run(*a): return subprocess.run([sys.executable, "-I", *map(str, a)], capture_output=True, text=True)
class Updater(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert sha(GEN.read_bytes()).startswith("881df987"), "generator is not the frozen 881df987"
        cls.t = pathlib.Path(tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")))
    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.t)
    def fixture(self, name, prov=None, helios=None, sums=None):
        d = self.t / name / "build-FIXTURE" / "out"; d.mkdir(parents=True)
        p = json.loads((OUT / "provenance.json").read_text())
        (d / "provenance.json").write_text(prov(p) if prov else json.dumps(p))
        if helios is None: (d / "helios").symlink_to(OUT / "helios")
        else: (d / "helios").write_bytes(helios)
        (d / "SHA256SUMS").write_text(sums if sums is not None else (OUT / "SHA256SUMS").read_text())
        return d
    def refuse(self, d, msg):
        dst = d.parent.parent / "dst"; r = run(GEN, d, dst)
        self.assertNotEqual(r.returncode, 0, r.stdout); self.assertIn(msg, r.stderr + r.stdout); self.assertFalse(dst.exists(), "wrote output on refusal")
    def test_malformed_provenance(self): self.refuse(self.fixture("m", prov=lambda p: "{not json"), "JSONDecodeError")
    def test_missing_artifact_field(self): self.refuse(self.fixture("k", prov=lambda p: json.dumps({**p, "artifact": {}})), "KeyError")
    def test_non_hex_digest(self): self.refuse(self.fixture("h", prov=lambda p: json.dumps({**p, "artifact": {**p["artifact"], "sha256": "Z" * 64}})), "bad artifact sha")
    def test_old_digest_is_not_a_new_build(self): self.refuse(self.fixture("o", prov=lambda p: json.dumps({**p, "artifact": {**p["artifact"], "sha256": OLD}})), "bad artifact sha")
    def test_binary_does_not_hash_to_provenance(self): self.refuse(self.fixture("b", helios=b"not the artifact"), "does not hash")
    def test_sums_do_not_list_it(self): self.refuse(self.fixture("s", sums=""), "does not list")
    def test_wrong_base_commit(self): self.refuse(self.fixture("c", prov=lambda p: json.dumps({**p, "source": {**p["source"], "baseCommit": "0" * 40}})), "provenance is not")
    def test_wrong_patch(self): self.refuse(self.fixture("p", prov=lambda p: json.dumps({**p, "source": {**p["source"], "patch": {**p["source"]["patch"], "sha256": "ab" * 32}}})), "provenance is not")
    def test_existing_output_dir(self):
        d = self.fixture("e"); (d.parent.parent / "dst").mkdir(); r = run(GEN, d, d.parent.parent / "dst")
        self.assertNotEqual(r.returncode, 0); self.assertIn("exists", r.stderr)
    def test_real_artifact_regenerates_the_candidate_exactly_and_doc_edits_refuse_a_second_pass(self):
        g = self.t / "real" / "gen"; g.parent.mkdir(); r = run(GEN, OUT, g); self.assertEqual(r.returncode, 0, r.stderr)
        r = run(DOC, g); self.assertEqual(r.returncode, 0, r.stderr)
        files = (IA / "CHANGED-FILES.txt").read_text().split()
        self.assertEqual(len(files), 5)
        for f in files: self.assertEqual(sha((g / f).read_bytes()), sha((IA / "candidate" / f).read_bytes()), f)
        self.assertEqual(json.loads((g / "UPDATE.json").read_text())["newHelios"], sha((OUT / "helios").read_bytes()))
        r = run(DOC, g); self.assertNotEqual(r.returncode, 0); self.assertIn("expected exactly 1", r.stderr)
if __name__ == "__main__": unittest.main(verbosity=2)
