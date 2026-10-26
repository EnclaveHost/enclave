#!/usr/bin/env python3
"""Fixture tests of manifest-staleness.py (synthetic git repo; offline; run by the root job before the auditor is trusted)."""
import hashlib, importlib.util, json, os, subprocess, tempfile, unittest
spec = importlib.util.spec_from_file_location("ms", os.path.join(os.path.dirname(__file__), "manifest-staleness.py")); ms = importlib.util.module_from_spec(spec); spec.loader.exec_module(ms)
sha = lambda b: hashlib.sha256(b).hexdigest()
class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); g = lambda *a: subprocess.run(["git", "-C", self.d, *a], check=True, capture_output=True)
        os.makedirs(f"{self.d}/relay/fixtures"); os.makedirs(f"{self.d}/metal")
        open(f"{self.d}/net-guard.mjs", "wb").write(b"export const real = 1;\n" * 50)
        os.symlink("../net-guard.mjs", f"{self.d}/relay/net-guard.mjs"); os.symlink("/etc/passwd", f"{self.d}/relay/abs.mjs")
        os.symlink("../../outside.mjs", f"{self.d}/relay/escape.mjs"); os.symlink("loop-b.mjs", f"{self.d}/relay/loop-a.mjs"); os.symlink("loop-a.mjs", f"{self.d}/relay/loop-b.mjs")
        open(f"{self.d}/relay/fixtures/tpm-roots.pem", "wb").write(b"PEM\n")
        self.content = open(f"{self.d}/net-guard.mjs", "rb").read()
        self.g = g
    def manifest(self, obj):
        open(f"{self.d}/metal/x.bundle.mjs.manifest.json", "w").write(json.dumps(obj)); self.g("init", "-q"); self.g("add", "-A")
        self.g("-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "f"); t = ms.Tree(f"{self.d}/.git", "HEAD")
        return ms.audit(t, "metal/x.bundle.mjs.manifest.json")
    def test_symlinked_input_is_judged_by_its_RESOLVED_content(self):
        r = self.manifest({"inputs": {"relay/net-guard.mjs": sha(self.content)}}); self.assertEqual((r["stale"], r["broken"]), ([], []))
        r2 = self.manifest({"inputs": {"relay/net-guard.mjs": sha(b"../net-guard.mjs")}}); self.assertEqual(r2["stale"], ["relay/net-guard.mjs"], "the link TEXT is not the content")
    def test_absolute_escaping_and_looping_links_are_failures(self):
        r = self.manifest({"inputs": {"relay/abs.mjs": "0" * 64, "relay/escape.mjs": "0" * 64, "relay/loop-a.mjs": "0" * 64}})
        self.assertEqual(len(r["broken"]), 3, r["broken"]); self.assertEqual(r["stale"], [])
    def test_runtime_files_map_image_destination_to_source(self):
        pem = sha(b"PEM\n")
        r = self.manifest({"runtimeFiles": {"opt/metal/fixtures/tpm-roots.pem": {"source": "relay/fixtures/tpm-roots.pem", "sha256": pem}}, "sidecars": {"fixtures/tpm-roots.pem": {"source": "relay/fixtures/tpm-roots.pem", "sha256": pem}}})
        self.assertEqual((r["stale"], r["absent"], r["broken"]), ([], [], [])); self.assertEqual(len(r["runtime"]), 2)
        r2 = self.manifest({"sidecars": {"fixtures/tpm-roots.pem": {"source": "relay/fixtures/tpm-roots.pem", "sha256": "1" * 64}}}); self.assertEqual(len(r2["stale"]), 1)
        r3 = self.manifest({"runtimeFiles": {"opt/x": {"sha256": pem}}}); self.assertEqual(len(r3["broken"]), 1, "a record without a source is a failure")
        r4 = self.manifest({"runtimeFiles": {"opt/x": {"source": "relay/missing.pem", "sha256": pem}}}); self.assertEqual(len(r4["absent"]), 1)
if __name__ == "__main__": unittest.main(verbosity=2)
