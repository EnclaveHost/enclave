#!/usr/bin/env python3
"""Offline tests for derive_client.py. No node, VM or network. The input is the real pinned client.mjs bytes (the
tests skip when they are absent or differ); dependency modules in the temp tree are hash-only stubs, never executed.
No test claims an attestation verified: the timeout split is proven from the source text the judge gate runs."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import derive_client as D  # noqa: E402

# a directory name a naive string splice would break on
NASTY = "it's \"q\" ${x} back\\slash\nnl"


def real_original():
    try:
        raw = D.read_bytes(D.ORIGINAL)
    except OSError:
        return None
    return raw if D.sha256(raw) == D.ORIGINAL_SHA256 else None


def body_of(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i)]


class Tree(unittest.TestCase):
    def setUp(self):
        self.raw = real_original()
        if self.raw is None:
            self.skipTest("the pinned original client.mjs is not present here")
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d)
        self.root = os.path.join(self.d, NASTY)
        self.m2 = os.path.join(self.root, "isolation", "m2")
        os.makedirs(self.m2)
        os.makedirs(os.path.join(self.root, "relay"))
        self.client = self.put("isolation/m2/client.mjs", self.raw)
        self.put("isolation/m2/judge.mjs", b"// hash-only stub\nimport { x } from '../../relay/snp-verify.mjs';\n")
        self.put("isolation/m2/port-connector.mjs", b"// hash-only stub\nimport net from 'node:net';\n")
        self.put("relay/snp-verify.mjs", b"// hash-only stub\n")

    def put(self, rel, data):
        p = os.path.join(self.root, rel)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def derive(self, raw=None):
        if raw is not None:
            with open(self.client, "wb") as f:
                f.write(raw)
            return D.derive(self.client, D.sha256(raw))   # a different pin, to reach the checks after the pin
        return D.derive(self.client)


class Allowlist(Tree):
    def test_exact_diff(self):
        gen, m = self.derive()
        a, b = self.raw.decode().split("\n"), gen.decode().split("\n")
        self.assertEqual(len(a), len(b))
        changed = [i + 1 for i, (x, y) in enumerate(zip(a, b)) if x != y]
        self.assertEqual(changed, sorted(e["line"] for e in m["edits"]))
        self.assertEqual(changed, [53, 54, 55, 144])                  # the three imports and request()'s timeout
        self.assertEqual(b[143], D.TIMEOUT_NEW)
        base = "file://" + __import__("urllib.parse").parse.quote(os.fsencode(os.path.realpath(self.root)), safe="/")
        self.assertEqual(b[52], f"import {{ judge }} from '{base}/isolation/m2/judge.mjs';")
        self.assertEqual(b[53], f"import {{ startConnector, parseBindings }} from '{base}/isolation/m2/port-connector.mjs';")
        self.assertEqual(b[54], f"import {{ seedCertChain }} from '{base}/relay/snp-verify.mjs';")

    def test_check_allowlist_rejects_any_other_change(self):
        gen, m = self.derive()
        text = gen.decode()
        for bad in (text.replace("if (!j1.gateOpen) finish(3);", "finish(0);"),
                    text.replace("rejectUnauthorized: false,", "rejectUnauthorized: false, "),
                    text + "\n",
                    text.replace(D.TIMEOUT_NEW, D.TIMEOUT_NEW.replace("60000", "61000"))):
            with self.assertRaises(D.DerivationError):
                D.check_allowlist(self.raw.decode(), bad, m["edits"])

    def test_reproducible(self):
        self.assertEqual(self.derive()[0], self.derive()[0])

    def test_real_tree(self):
        gen, m = D.derive()                                         # the real original and its real modules, read-only
        self.assertEqual(m["original"]["sha256"], D.ORIGINAL_SHA256)
        self.assertEqual([e["line"] for e in m["edits"]], [144, 53, 54, 55])
        self.assertTrue(any(p.endswith("/relay/snp-verify.mjs") for p in m["dependencies_sha256"]))


class Rejection(Tree):
    def test_one_changed_byte_refused(self):
        raw = self.raw.replace(b"finish(3)", b"finish(0)", 1)
        with open(self.client, "wb") as f:
            f.write(raw)
        with self.assertRaisesRegex(D.DerivationError, "is not the pinned"):
            D.derive(self.client)

    def test_change_count_mismatch_refused(self):
        line = D.TIMEOUT_OLD.encode()
        for raw in (self.raw.replace(line, line + b"\n" + line),                    # two candidates
                    self.raw.replace(line, b"    r.setTimeout(30000, () => r.destroy(new Error('timeout')));"),
                    self.raw.replace(b"import { judge } from './judge.mjs';\n", b""),
                    self.raw.replace(b"{ app = true } = {}", b"{ app = false } = {}"),  # `app` would no longer mean app
                    self.raw.replace(b"null, { app: false });", b"null);"),
                    self.raw.replace(b"import fs from 'node:fs';", b"import fs from './fs.mjs';"),
                    self.raw + b"\nawait import('./x.mjs');\n"):
            with self.assertRaises(D.DerivationError):
                self.derive(raw)

    def test_missing_dependency_refused(self):
        os.unlink(os.path.join(self.root, "relay", "snp-verify.mjs"))
        with self.assertRaisesRegex(D.DerivationError, "dependency"):
            self.derive()


class Timeouts(Tree):
    def test_attestation_60s_application_840s(self):
        text = self.derive()[0].decode()
        req = body_of(text, "function request(", "\nasync function attest")
        self.assertIn("{ app = true } = {}", req)                                  # default: application request
        self.assertEqual(req.count("setTimeout("), 1)
        self.assertIn("r.setTimeout(app ? 840000 : 60000,", req)
        attest = body_of(text, "async function attest", "\n}\n")
        self.assertIn("null, { app: false });", attest)                            # attestation: 60 s, as before
        self.assertEqual(text.count("request(agent, 'GET', appPath)"), 1)          # application GET: no option -> 840 s
        self.assertEqual(text.count("840000"), 1)

    def test_other_timeouts_unchanged(self):
        text = self.derive()[0].decode()
        for s in ("Date.now() + 60000", "req.setTimeout(10000,", "socket.setTimeout(0)", ": 180000;",
                  "Date.now() + answerMs"):
            self.assertEqual(text.count(s), self.raw.decode().count(s), s)


class GateUnchanged(Tree):
    def test_gate_source_byte_identical(self):
        old, new = self.raw.decode(), self.derive()[0].decode()
        for start, end in (("class PinnedAgent", "function request("),
                           ("async function attest", None),
                           ("const args = process.argv", "function request(")):
            o = old[old.index(start):old.index(end) if end else None]
            n = new[new.index(start):new.index(end) if end else None]
            self.assertEqual(o, n, start)
        for s in ("await judge(", "if (!j1.gateOpen) finish(3);", "key.equals(this.pin)", "if (app && tripped)",
                  "replay_rejected", "second_nonce_verdict", "--min-tcb", "--runtime", "app_on_pinned_key"):
            self.assertEqual(new.count(s), old.count(s), s)
            self.assertGreater(new.count(s), 0, s)


class Paths(Tree):
    def test_nasty_path_quoted_safely(self):
        gen, _ = self.derive()
        for line in gen.decode().split("\n")[52:55]:
            spec = line[line.index("'") + 1:line.rindex("'")]
            self.assertRegex(spec, r"^file:///[A-Za-z0-9._~/%-]+$")
            for ch in ("'", '"', "\\", "\n", "${", " "):
                self.assertNotIn(ch, spec)
            self.assertEqual(line.count("'"), 2)
        self.assertIn("%27", gen.decode())                                         # the quote in NASTY, encoded

    def test_unsafe_url_refused(self):
        with self.assertRaises(D.DerivationError):
            D.module_url("relative/judge.mjs")
        self.assertIsNone(D.SAFE_URL.fullmatch("file:///a'b.mjs"))


class Outputs(Tree):
    def test_write_new_only_and_verify(self):
        gen, m = self.derive()
        out = os.path.join(self.d, "out")
        os.mkdir(out)
        D.write_outputs(out, gen, m)
        mf = os.path.join(out, D.MANIFEST)
        self.assertEqual(json.load(open(mf))["generated"]["sha256"], D.sha256(gen))
        self.assertEqual(D.verify(mf), [])
        with self.assertRaises(D.DerivationError):
            D.write_outputs(out, gen, m)                                           # never overwrites
        with self.assertRaises(D.DerivationError):
            D.write_outputs(self.m2, gen, m)                                       # never beside the original
        self.put("relay/snp-verify.mjs", b"// changed\n")
        self.assertTrue(any("dependencies changed" in p for p in D.verify(mf)))
        self.put("relay/snp-verify.mjs", b"// hash-only stub\n")
        with open(os.path.join(out, D.GENERATED), "ab") as f:
            f.write(b"//")
        self.assertTrue(any("on disk differs" in p for p in D.verify(mf)))


if __name__ == "__main__":
    unittest.main()
