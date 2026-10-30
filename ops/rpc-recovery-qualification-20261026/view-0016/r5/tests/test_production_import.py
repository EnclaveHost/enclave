#!/usr/bin/env python3
"""multipart-validation-view-stage/r5 records-import tests (prepared by Claude 1759/1767; NOT run by Claude). r5 = r4 + root 1765 fix:
the "default-production" case now omits --expect-kind (it passed `--expect-kind fixture` in r4, so the CLI default was never tested). REAL recovery-multipart r3
records: each fixture is planned, copied and verified by the PINNED r3 multipart.py CLI itself (fixture kind, --source-file) on a
tiny 204,800-byte source with map holes (r3's own fixture layout: 3 x 64 KiB parts + an 8 KiB all-hole tail part, two target dirs).
Expected bytes come from the fixture source, never from the tools. Everything lives under $MVV_TEST_TMP; nothing is chmod'ed."""
import contextlib, hashlib, io, json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

TMP = os.environ.get("MVV_TEST_TMP", "")
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("MVV_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import production_import as P  # noqa: E402

R3 = os.path.join(P.R3_DIR, "multipart.py")
QIO, QIMG, QNBD = "/usr/bin/qemu-io", "/usr/bin/qemu-img", "/usr/sbin/qemu-nbd"
BS, PART = 4096, 65536
EXTENTS = [[0, 10, 900, False], [12, 19, 950, False], [33, 8, 990, False]]     # = r3 tests: holes 10-11, 31-32, 41-49 (tail)
L = 50 * BS                                                                     # 204800 = 3 x 65536 + 8192
RUN = "20261027T000000Z-1"


def det(seed, n):
    out, i = bytearray(), 0
    while len(out) < n:
        out += hashlib.sha256(f"{seed}-{i}".encode()).digest(); i += 1
    return bytes(out[:n])


def r3cli(*args):
    return subprocess.run([sys.executable, "-I", "-B", R3, *args], capture_output=True, text=True, timeout=120, env={"PATH": "/usr/bin:/bin"})


def pim(*args):
    """production_import.main with stdout captured (the job requires an empty test stdout)"""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return P.main(list(args))


def run(cmd, timeout=60):
    return subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)


class Fx:
    """one r3 fixture: plan (+ optional copy / verify of a part range) through the pinned r3 CLI"""
    def __init__(self, copy="0-3", verify="0-3"):
        self.d = tempfile.mkdtemp(prefix="pi", dir=TMP)
        j = lambda *x: os.path.join(self.d, *x)
        self.src = j("source.img")
        with open(self.src, "wb") as f:
            f.truncate(L)
            for lb, n, _pb, _u in EXTENTS:
                f.seek(lb * BS); f.write(det(f"data{lb}", n * BS))
        with open(self.src, "rb") as f:
            self.bytes = f.read()
        with open(j("map.json"), "w") as f:
            json.dump({"format": "ext4-recovery-checksum-r1/v1", "map": {"extentList": EXTENTS, "extents": len(EXTENTS)}}, f)
        with open(j("journal.bin"), "wb") as f:
            f.write(det("journal", 65536))
        with open(j("original.qcow2"), "wb") as f:
            f.write(det("qcow2", 12345))
        with open(j("plan.json"), "w") as f:
            json.dump({"format": "recovery-overlay-plan/v1", "mode": "fixture", "inputs": {"captureSha256": "00" * 32},
                       "target": {"size": L, "path": "/data/db/mdbx.dat"}, "map": {"extents": len(EXTENTS)},
                       "patches": [{"kind": "inode", "fsBlock": 7, "byteOffset": 1024, "length": 256, "sha256": "ab" * 32, "source": "000.bin"}]}, f)
        self.ta, self.tb = j("target-a"), j("target-b")
        for t in (self.ta, self.tb):
            os.mkdir(t, 0o700)
        self.manifest = j("manifest.json")
        r = r3cli("plan", "--original", j("original.qcow2"), "--map", j("map.json"), "--overlay-plan", j("plan.json"),
                  "--journal", j("journal.bin"), "--out", self.manifest, "--target", f"a={self.ta}", "--target", f"b={self.tb}",
                  "--assign", "a:0-1", "--assign", "b:2-3", "--logical-size", str(L), "--part-size", str(PART),
                  "--chunk-bytes", "8192", "--checkpoint-bytes", "16384")
        assert r.returncode == 0, r.stderr
        self.msha = json.loads(r.stdout)["manifestSha256"]
        m = ["--manifest", self.manifest, "--manifest-sha256", self.msha, "--source-file", self.src]
        if copy:
            r = r3cli("copy", *m, "--parts", copy); assert r.returncode == 0, r.stderr
        if verify:
            r = r3cli("verify", *m, "--parts", verify); assert r.returncode == 0, r.stderr

    def part(self, i):
        return os.path.join(self.ta if i < 2 else self.tb, f"part-{i:04d}.bin")

    def tdir(self, i):
        return self.ta if i < 2 else self.tb

    def imp(self, name="view", kind="fixture", sha=None, manifest=None):
        """kind=None OMITS --expect-kind, exercising the CLI default (production)"""
        out = os.path.join(self.d, name)
        rc = pim("import", "--manifest", manifest or self.manifest, "--manifest-sha256", sha or self.msha, "--out-dir", out,
                 *(() if kind is None else ("--expect-kind", kind)))
        return rc, out

    def opts(self, out):
        with open(os.path.join(out, "receipt.json")) as f:
            return json.load(f)["imageOpts"]

    def idents(self):
        return [(os.lstat(self.part(i)).st_ino, os.lstat(self.part(i)).st_mode, os.lstat(self.part(i)).st_ctime_ns) for i in range(4)]


class Import(unittest.TestCase):
    def setUp(self):
        self.children = []

    def tearDown(self):
        for c in self.children:
            if c.poll() is None:
                os.killpg(c.pid, signal.SIGKILL)
            c.wait(timeout=30)

    def refused(self, fx, name, **kw):
        rc, out = fx.imp(name=name, **kw)
        self.assertEqual(rc, 3, name); self.assertFalse(os.path.lexists(out), name)

    def qread(self, opts, off, n):
        r = run([QIO, "-r", "--image-opts", opts, "-c", f"read -v {off} {n}"])
        self.assertEqual(r.returncode, 0, r.stderr); self.assertIn(f"read {n}/{n} bytes at offset {off}", r.stdout)
        got = bytearray()
        for line in r.stdout.splitlines():
            head, sep, rest = line.partition(":  ")
            if sep and len(head) >= 8 and all(c in "0123456789abcdef" for c in head):
                self.assertEqual(int(head, 16), off + len(got))
                got += bytes.fromhex(rest[:48].strip().replace(" ", ""))
        self.assertEqual(len(got), n)
        return bytes(got)

    def nbd(self, fx, out):
        name = f"s{len(self.children)}.sock"
        c = subprocess.Popen([QNBD, "--read-only", "--shared=1", f"--socket=/proc/self/cwd/{name}", "--image-opts", fx.opts(out)],
                             cwd=fx.d, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.children.append(c)
        end = time.monotonic() + 30
        while not os.path.exists(os.path.join(fx.d, name)):
            self.assertIsNone(c.poll(), "qemu-nbd exited before listening"); self.assertLess(time.monotonic(), end); time.sleep(0.05)
        return c

    def test_1_complete_verified_r3_records_give_an_exact_read_only_view_without_touching_parts(self):
        fx = Fx(); before = fx.idents()
        rc, out = fx.imp(); self.assertEqual(rc, 0)
        with open(os.path.join(out, "receipt.json")) as f:
            rec = json.load(f)
        self.assertEqual((rec["kind"], rec["manifestSha256"], rec["r3MultipartSha256"], rec["partsChmodded"]), ("fixture", fx.msha, P.R3_MULTIPART_SHA256, False))
        self.assertEqual(rec["statusAtImport"], {"parts": 4, "partsCommitted": 4, "partsVerifiedRecorded": 4, "copyComplete": True, "verificationCompleteRecorded": True})
        self.assertEqual([p["path"] for p in rec["parts"]], [fx.part(i) for i in range(4)])
        self.assertTrue(rec["imageOpts"].startswith("driver=vmdk,read-only=on,"))
        opts = fx.opts(out)
        for b in (PART, 2 * PART, 3 * PART):                       # single reads straddling each FLAT boundary
            self.assertEqual(self.qread(opts, b - 1024, 2048), fx.bytes[b - 1024:b + 1024], b)
        self.assertEqual(self.qread(opts, 0, L), fx.bytes)         # every logical byte, holes included
        self.assertEqual(run([QIMG, "compare", "--image-opts", opts, f"driver=raw,file.driver=file,file.filename={fx.src}"]).returncode, 0)
        self.assertEqual(pim("recheck", "--view-dir", out, "--hash"), 0)
        for extra in ([], ["-r"]):                                 # a write through the view never reaches a part
            run([QIO, *extra, "--image-opts", opts, "-c", "write -P 0x55 0 512"])
        self.assertEqual(self.qread(opts, 0, 512), fx.bytes[:512])
        c = self.nbd(fx, out)
        self.assertEqual(pim("check-held", "--view-dir", out, "--pid", str(c.pid)), 0)
        self.assertEqual(fx.idents(), before)                     # no chmod, no write: inode, mode and ctime unchanged
        self.assertEqual(pim("recheck", "--view-dir", out), 0)

    def test_2_manifest_sha_kind_and_production_pins_are_enforced(self):
        fx = Fx()
        self.refused(fx, "default-production", kind=None)          # NO --expect-kind: the default is production, so a fixture manifest refuses
        fx2 = os.path.join(fx.d, "prod.json")
        with open(fx.manifest) as f:
            d = json.load(f)
        d["kind"] = "production"
        raw = (json.dumps(d, indent=1, sort_keys=True) + "\n").encode()
        with open(fx2, "wb") as f:
            f.write(raw)
        self.refused(fx, "prod-pins", kind="production", manifest=fx2, sha=hashlib.sha256(raw).hexdigest())   # r3 check_production
        self.refused(fx, "wrong-sha", sha="0" * 64)
        self.refused(fx, "fixture-as-prod", kind="production")
        parts = os.path.join(fx.d, "parts.json")
        with open(parts, "w") as f:
            json.dump({"format": "multipart-view-parts/v1", "kind": "fixture", "logicalSize": L, "parts": []}, f)
        with open(parts, "rb") as f:
            self.refused(fx, "generic-parts", manifest=parts, sha=hashlib.sha256(f.read()).hexdigest())
        rc, out = fx.imp(); self.assertEqual(rc, 0)
        self.assertEqual(fx.imp()[0], 3)                           # the out dir must be new

    def test_3_partial_copy_or_partial_verification_is_refused(self):
        for copy, verify in (("0-2", "0-2"), ("0-3", "0-1"), ("0-3", None), (None, None)):
            fx = Fx(copy=copy, verify=verify)
            self.refused(fx, "partial")

    def test_4_unconfirmed_failed_or_malformed_records_are_refused(self):
        fx = Fx()
        vdir = fx.tdir(1)
        vname = [n for n in os.listdir(vdir) if n.startswith("part-0001.verify-")][0]
        vpath = os.path.join(vdir, vname)
        with open(vpath) as f:
            good = json.load(f)

        def put(path, obj):                                       # private 0600 like r3's own records
            with open(path, "w", opener=lambda q, fl: os.open(q, fl, 0o600)) as f:
                json.dump(obj, f)
        put(vpath, {**good, "source": {"kind": "session", "sessionId": RUN}})      # verified in a session never CONFIRMED here
        self.refused(fx, "unconfirmed")
        put(vpath, good)
        extra = os.path.join(vdir, f"part-0001.verify-{RUN}.json")
        put(extra, {**good, "run": RUN, "status": "FAIL", "reason": "differs", "sourceSha256": None, "destinationSha256": None})
        self.refused(fx, "failed")
        put(extra, {**good, "run": RUN, "unexpected": 1})
        self.refused(fx, "malformed-verify")
        os.unlink(extra)
        rpath = os.path.join(fx.tdir(2), "part-0002.json")
        with open(rpath) as f:
            rgood = json.load(f)
        put(rpath, {**rgood, "logicalSha256": "0" * 64})
        self.refused(fx, "mismatched-record")
        put(rpath, rgood)
        rc, out = fx.imp(name="restored"); self.assertEqual(rc, 0)            # positive control after every restore

    def test_5_stale_replaced_or_modified_parts_are_refused_before_and_after_import(self):
        fx = Fx(); p = fx.part(2); tmp = p + ".copy"
        shutil.copy2(p, tmp); os.replace(tmp, p)                   # byte-identical NEW inode
        self.refused(fx, "replaced")
        fx = Fx(); os.utime(fx.part(0), ns=(1, 1))
        self.refused(fx, "touched")
        fx = Fx(); os.link(fx.part(3), os.path.join(fx.d, "extra-link"))
        self.refused(fx, "hardlinked")
        fx = Fx(); rc, out = fx.imp(); self.assertEqual(rc, 0)
        c = self.nbd(fx, out)
        self.assertEqual(pim("check-held", "--view-dir", out, "--pid", str(c.pid)), 0)
        with open(fx.part(1), "r+b") as f:                          # same inode, same size, one byte changed in place
            b = f.read(1); f.seek(0); f.write(bytes([b[0] ^ 0xff]))
        self.assertEqual(pim("recheck", "--view-dir", out), 3)
        self.assertEqual(pim("opts", "--view-dir", out), 3)
        self.assertEqual(pim("check-held", "--view-dir", out, "--pid", str(c.pid)), 3)


if __name__ == "__main__":
    unittest.main()
