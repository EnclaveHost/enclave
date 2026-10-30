#!/usr/bin/env python3
"""Offline tests for build_init.py. Fixture sources and a fake compiler under a temp dir; the real original dominit.c
is only read (skipped if absent or not the pinned bytes). Never runs gcc, a release, a VM or a GPU."""
import hashlib, json, os, shutil, struct, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_init as B  # noqa: E402

REAL_M2 = "/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m2"


def sha(b):
    return hashlib.sha256(b).hexdigest()


def elf(tag=b"", interp=False, needed=False):
    h = bytearray(64)
    h[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", h, 16, 2, 62, 1)
    struct.pack_into("<H", h, 52, 64)
    phs, extra = [], b""
    if interp:
        phs.append(struct.pack("<IIQQQQQQ", 3, 4, 0, 0, 0, 0, 0, 1))
    if needed:
        off = 64 + 56 * (len(phs) + 1)
        extra = struct.pack("<qQqQ", 1, 0, 0, 0)
        phs.append(struct.pack("<IIQQQQQQ", 2, 6, off, 0, 0, len(extra), len(extra), 8))
    struct.pack_into("<Q", h, 32, 64 if phs else 0)
    struct.pack_into("<HH", h, 54, 56, len(phs))
    return bytes(h) + b"".join(phs) + extra + tag


SPAWN = (
    '#include "shield-memory.h"\n'
    '#include "shield-config.h"\n'
    'static pid_t spawn(char *const argv[], char *extra, int fd3, int flags);\n'
    'static pid_t spawn(char *const argv[], char *extra, int fd3, int flags) {\n'
    '        const int reclaim_sources = shield_on && shield_load_allowed && shield_large && drop &&\n'
    '            access("/rt/shield-original-source-reclaim.enabled", R_OK) == 0;\n'
    '        if (reclaim_sources) {\n'
    '        }\n'
    '            const char *bad = drop_to_app();\n'
    '        if ((flags & SPAWN_FILTER) && app_seccomp_install() != 0) {\n'
    '        }\n'
    '        char *envp[80] = {"HOME=/tmp", "PATH=/rt"};\n'
    '            if (reclaim_sources) {\n'
    '                envp[ei++] = "ENCLAVE_SHIELD_ORIGINAL_SOURCE=fd:199";\n'
    '                envp[ei++] = "ENCLAVE_SHIELD_PRIVATE_SOURCE=fd:198";\n'
    '            }\n'
    '        envp[ei++] = extra; envp[ei] = NULL;\n'
    '}\n'
    'int main(void) { return 0; }\n')
FIX = SPAWN.encode()
BASE_BIN = elf(b"baseline-init")
CAND_BIN = elf(b"candidate-init" + B.MARKER + b"\0" + B.ENV + b"\0")


class Transform(unittest.TestCase):
    def test_pure_insertions_in_order(self):
        c = B.make_candidate(FIX)
        self.assertEqual(B.check_candidate(FIX, c), 2 + 3 + 1 + 1)
        # removing the reviewed insertions gives the original bytes back
        back = c.decode()
        for _, add in B.INSERTIONS:
            self.assertEqual(back.count(add), 1)
            back = back.replace(add, "", 1)
        self.assertEqual(back.encode(), FIX)

    def test_anchor_missing_or_repeated(self):
        with self.assertRaisesRegex(B.Refused, "0 times"):
            B.make_candidate(FIX.replace(b'fd:198";', b'fd:197";'))
        with self.assertRaisesRegex(B.Refused, "2 times"):
            B.make_candidate(FIX.replace(b'#include "shield-config.h"\n', b'#include "shield-config.h"\n' * 2))

    def test_env_before_drop_is_refused(self):
        moved = FIX.replace(b"            const char *bad = drop_to_app();\n", b"").replace(
            b"        envp[ei++] = extra;", b"            const char *bad = drop_to_app();\n        envp[ei++] = extra;")
        with self.assertRaisesRegex(B.Refused, "order"):
            B.make_candidate(moved)

    def test_envp_bound(self):
        with self.assertRaisesRegex(B.Refused, "envp worst case"):
            B.make_candidate(FIX.replace(b"char *envp[80]", b"char *envp[6]"))
        with self.assertRaisesRegex(B.Refused, "envp worst case"):
            B.make_candidate(FIX.replace(b"        envp[ei++] = extra;", b"        envp[ei++] = \"X=1\";\n" * 80 +
                                         b"        envp[ei++] = extra;"))

    def test_tampered_candidate_rejected(self):
        c = B.make_candidate(FIX)
        with self.assertRaisesRegex(B.Refused, "pure insertions"):
            B.check_candidate(FIX, c.replace(b'"HOME=/tmp"', b'"HOME=/x"'))
        with self.assertRaisesRegex(B.Refused, "pure insertions|reviewed insertion"):
            B.check_candidate(FIX, c.replace(b"if (retire_budget == 1) ", b""))

    @unittest.skipUnless(os.path.isfile(os.path.join(REAL_M2, "dominit.c")), "original dominit.c not present")
    def test_real_original(self):
        with open(os.path.join(REAL_M2, "dominit.c"), "rb") as f:
            orig = f.read()
        if sha(orig) != B.ORIGINAL_SOURCE_SHA256:
            self.skipTest("original dominit.c is not the pinned bytes")
        c = B.make_candidate(orig)
        worst = B.check_candidate(orig, c)
        self.assertLessEqual(worst, B.ENVP_SLOTS)
        self.assertEqual(worst, 60)          # 56 original envp[ei++] + 1 new + 2 initial + NULL
        self.assertEqual(len(c) - len(orig), sum(len(a.encode()) for _, a in B.INSERTIONS))


class ElfGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="build-init-elf-")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def put(self, b):
        p = os.path.join(self.tmp, "x")
        with open(p, "wb") as f:
            f.write(b)
        return p

    def test_static_accepted(self):
        self.assertEqual(B.check_static_musl(self.put(BASE_BIN)), BASE_BIN)

    def test_dynamic_refused(self):
        for b, why in ((elf(interp=True), "interpreter"), (elf(needed=True), "shared library"),
                       (elf(b"GLIBC_2.34"), "glibc"), (b"#!/bin/sh\n" + bytes(60), "ELF64")):
            with self.subTest(why=why), self.assertRaisesRegex(B.Refused, why):
                B.check_static_musl(self.put(b))


class Build(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="build-init-test-")
        self.m2 = os.path.join(self.tmp, "m2")
        self.musl = os.path.join(self.tmp, "musl")
        os.makedirs(os.path.join(self.musl, "lib"))
        os.mkdir(self.m2)
        self.files = {os.path.join(self.m2, "dominit.c"): FIX, os.path.join(self.m2, "shield-config.h"): b"/* c */\n",
                      os.path.join(self.m2, "shield-memory.h"): b"/* m */\n",
                      os.path.join(self.musl, "lib", "musl-gcc.specs"): b"specs\n",
                      os.path.join(self.musl, "lib", "libc.a"): b"!<arch>\n"}
        for p, b in self.files.items():
            with open(p, "wb") as f:
                f.write(b)
        self.installed = os.path.join(self.tmp, "installed-init")
        with open(self.installed, "wb") as f:
            f.write(BASE_BIN)
        self.pins = dict(source=sha(FIX), specs=sha(b"specs\n"), libc=sha(b"!<arch>\n"), init=sha(BASE_BIN))
        self.out = os.path.join(self.tmp, "out")
        self.calls = []
        self.base_bin, self.cand_bin = BASE_BIN, CAND_BIN

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def fake_gcc(self, workdir, specs):
        self.calls.append(os.path.basename(workdir))
        with open(os.path.join(workdir, "dominit.c"), "rb") as f:
            src = f.read()
        with open(os.path.join(workdir, "init"), "xb") as f:
            f.write(self.cand_bin if b"retire_budget" in src else self.base_bin)
        return ["fake-gcc", workdir]

    def build(self, **over):
        kw = dict(m2=self.m2, musl=self.musl, out=self.out, installed=self.installed, pins=self.pins,
                  compile_fn=self.fake_gcc)
        kw.update(over)
        return B.build(**kw)

    def test_happy_path(self):
        res = self.build()
        self.assertTrue(res["reproduced"])
        self.assertEqual(self.calls, ["baseline", "candidate"])
        self.assertEqual(res["baselineBuiltSha256"], sha(BASE_BIN))
        self.assertEqual(res["candidateInitSha256"], sha(CAND_BIN))
        for side in ("baseline", "candidate"):
            for n in ("shield-config.h", "shield-memory.h"):
                with open(os.path.join(self.out, side, n), "rb") as f:
                    self.assertEqual(f.read(), self.files[os.path.join(self.m2, n)])
        self.assertTrue(os.path.isfile(os.path.join(self.out, "candidate", B.HEADER)))
        self.assertFalse(os.path.exists(os.path.join(self.out, "baseline", B.HEADER)))
        with open(os.path.join(self.out, "baseline", "dominit.c"), "rb") as f:
            self.assertEqual(f.read(), FIX)
        with open(os.path.join(self.out, "dominit-retire-budget.diff")) as f:
            body = [l for l in f.read().splitlines() if l[:1] in "+-" and not l.startswith(("+++", "---"))]
        self.assertTrue(body and all(l.startswith("+") for l in body))
        with open(os.path.join(self.out, "RESULT.json")) as f:
            self.assertEqual(json.load(f)["candidateInitSha256"], sha(CAND_BIN))
        for p, b in self.files.items():                      # inputs only read
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b)

    def test_baseline_not_reproduced_stops_before_candidate(self):
        self.base_bin = elf(b"some-other-init")
        with self.assertRaisesRegex(B.Refused, "reproduction not established"):
            self.build()
        self.assertEqual(self.calls, ["baseline"])
        self.assertFalse(os.path.exists(os.path.join(self.out, "candidate", "init")))
        with open(os.path.join(self.out, "RESULT.json")) as f:
            self.assertIn("refused", json.load(f))

    def test_input_pins(self):
        for key, pat in (("source", "reproduced original"), ("specs", "musl-gcc.specs"), ("libc", "libc.a"),
                         ("init", "installed init")):
            with self.subTest(key=key):
                with self.assertRaisesRegex(B.Refused, pat):
                    self.build(pins=dict(self.pins, **{key: "0" * 64}))
                self.assertFalse(os.path.lexists(self.out))
                self.assertEqual(self.calls, [])

    def test_out_rules(self):
        os.mkdir(self.out)
        with self.assertRaisesRegex(B.Refused, "exists"):
            self.build()
        with self.assertRaisesRegex(B.Refused, "inside --m2"):
            self.build(out=os.path.join(self.m2, "out"))
        with self.assertRaisesRegex(B.Refused, "inside --musl"):
            self.build(out=os.path.join(self.musl, "out"))

    def test_symlinked_source_refused(self):
        real = os.path.join(self.tmp, "real.c")
        os.rename(os.path.join(self.m2, "dominit.c"), real)
        os.symlink(real, os.path.join(self.m2, "dominit.c"))
        with self.assertRaisesRegex(B.Refused, "symlinks are refused"):
            self.build()

    def test_existing_marker_header_refused(self):
        with open(os.path.join(self.m2, B.HEADER), "wb") as f:
            f.write(b"/* not ours */\n")
        with self.assertRaisesRegex(B.Refused, "already has"):
            self.build()

    def test_candidate_without_wiring_refused(self):
        self.cand_bin = elf(b"candidate-without-strings")
        with self.assertRaisesRegex(B.Refused, "marker path and env"):
            self.build()

    def test_baseline_already_wired_refused(self):
        self.base_bin = CAND_BIN
        with self.assertRaisesRegex(B.Refused, "already carries"):
            self.build(pins=dict(self.pins, init=sha(CAND_BIN)), installed=None)

    def test_dynamic_baseline_refused(self):
        self.base_bin = elf(b"x", interp=True)
        with self.assertRaisesRegex(B.Refused, "interpreter"):
            self.build(pins=dict(self.pins, init=sha(self.base_bin)), installed=None)


if __name__ == "__main__":
    unittest.main()
