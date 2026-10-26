#!/usr/bin/env python3
"""journal-recovery-verifier-stage/r2 tests = r1 tests, FIXTURE/HARNESS-ONLY fix (root 1646: every fixture file is closed; the
verifier's own stdout/stderr are captured inside the tests; jbd2_verify.py is byte-identical to r1). (PREPARED; root runs them). Synthetic csum-v3 journals built with the reference
crc32c table (so fixture checksums and the verifier agree by construction: these test the WALK, bounds and refusal logic), plus
two NON-circular checks: the published CRC-32C check vector, and the REAL kernel-written journal superblock of the 1626 copy
(block 0, 1024 bytes; its s_checksum must verify with both implementations and give the expected seed)."""
import contextlib, importlib.util, io, json, os, signal, struct, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("jv", HERE.parent / "jbd2_verify.py")
V = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(V)
crc = V.crc32c_pure
BS, MAGIC = V.BS, V.MAGIC
UUID = bytes(range(16))


def vmain(args):
    """V.main with ITS output captured: the test log holds only unittest's own lines (root 1646)"""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return V.main(args)


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def sb(maxlen, first=1, seq=100, start=0, uuid=UUID, incompat=0x13, ctype=4, compat=0):
    b = bytearray(BS)
    struct.pack_into(">III", b, 0, MAGIC, V.SB_V2, 0)
    struct.pack_into(">IIIII", b, 0xC, BS, maxlen, first, seq, start)
    struct.pack_into(">III", b, 0x24, compat, incompat, 0)
    b[0x30:0x40] = uuid; b[0x50] = ctype
    t = bytearray(b[:1024]); t[0xFC:0x100] = bytes(4)
    struct.pack_into(">I", b, 0xFC, crc(0xFFFFFFFF, t))
    return b


class J:
    """a csum-v3 journal image of `maxlen` blocks; place() writes contiguous transactions and returns the next position"""
    def __init__(self, maxlen=16, first=1, seq=100, uuid=UUID):
        self.maxlen, self.first = maxlen, first
        self.b = bytearray(maxlen * BS); self.b[:BS] = sb(maxlen, first, seq, uuid=uuid)
        self.seed = crc(0xFFFFFFFF, uuid)

    def nxt(self, p):
        return p + 1 if p + 1 < self.maxlen else self.first

    def put(self, p, data):
        self.b[p * BS:(p + 1) * BS] = data

    def tail(self, blk):
        t = bytearray(blk); t[BS - 4:] = bytes(4)
        struct.pack_into(">I", blk, BS - 4, crc(self.seed, t))

    def place(self, pos, S, images=(), revokes=(), sec=1700000000, partial=False):
        if images:
            d = bytearray(BS); struct.pack_into(">III", d, 0, MAGIC, V.DESC, S)
            off, logged = 12, []
            for i, (fs, content) in enumerate(images):
                content = bytes(content).ljust(BS, b"\0")
                esc = content[:4] == V.MAGIC_BE
                lg = (bytes(4) + content[4:]) if esc else content
                flags = (V.F_ESCAPE if esc else 0) | (V.F_SAME_UUID if i else 0) | (V.F_LAST_TAG if i == len(images) - 1 else 0)
                c = crc(crc(self.seed, struct.pack(">I", S)), lg)
                struct.pack_into(">IIII", d, off, fs & 0xFFFFFFFF, flags, fs >> 32, c); off += 16
                if not i:
                    d[off:off + 16] = UUID; off += 16
                logged.append(lg)
            self.tail(d); self.put(pos, d)
            for lg in logged:
                pos = self.nxt(pos); self.put(pos, lg)
            pos = self.nxt(pos)
        if revokes:
            r = bytearray(BS); struct.pack_into(">IIII", r, 0, MAGIC, V.REVOKE, S, 16 + 8 * len(revokes))
            for i, fs in enumerate(revokes):
                struct.pack_into(">Q", r, 16 + 8 * i, fs)
            self.tail(r); self.put(pos, r); pos = self.nxt(pos)
        c = bytearray(BS); struct.pack_into(">III", c, 0, MAGIC, V.COMMIT, S)
        struct.pack_into(">QI", c, 0x30, sec, 7)
        if partial:
            p = bytearray(BS); p[:64] = c[:64]; struct.pack_into(">I", c, 0x10, crc(self.seed, p)); c[64:] = os.urandom(BS - 64)
        else:
            struct.pack_into(">I", c, 0x10, crc(self.seed, c))
        self.put(pos, c)
        return self.nxt(pos), pos


def blk(tag, first_magic=False):
    b = bytearray((tag.encode() * (BS // len(tag) + 1))[:BS])
    if first_magic:
        b[:4] = V.MAGIC_BE
    return bytes(b)


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")); self.n = 0

    def tearDown(self):
        for root, ds, fs in os.walk(self.d, topdown=False):
            for f in fs: os.unlink(os.path.join(root, f))
            for x in ds: os.rmdir(os.path.join(root, x))
        os.rmdir(self.d)

    def file(self, data, name=None):
        self.n += 1; p = os.path.join(self.d, name or f"f{self.n}")
        with open(p, "wb") as f: f.write(data)
        os.chmod(p, 0o600); return p

    def run_v(self, j, targets, expect=0, **kw):
        jp = self.file(bytes(j.b) if isinstance(j, J) else j)
        tp = self.file(json.dumps({"blocks": targets}).encode())
        out = os.path.join(self.d, f"out{self.n}.json")
        args = ["--journal", jp, "--targets", tp, "--out", out, "--fixture", "--crc", "pure"] + kw.get("extra", [])
        rc = vmain(args)
        self.assertEqual(rc, expect)
        return read_json(out) if rc == 0 else None


class Crc(Base):
    def test_check_vector_and_libext2fs_agreement(self):
        self.assertEqual(crc(0xFFFFFFFF, b"123456789"), 0x1CF96D7C)
        fn, info = V.crc_impl("libext2fs")                       # the production implementation (pinned path, sha recorded)
        self.assertEqual(fn(0xFFFFFFFF, b"123456789"), 0x1CF96D7C); self.assertEqual(len(info["sha256"]), 64)

    def test_real_kernel_superblock_checksum_and_seed(self):
        b = bytes.fromhex((HERE / "real-journal-8-superblock-1024.hex").read_text().strip())
        self.assertEqual(len(b), 1024)
        t = bytearray(b); t[0xFC:0x100] = bytes(4)
        fn, _ = V.crc_impl("libext2fs")
        for f in (crc, fn):
            self.assertEqual(f(0xFFFFFFFF, t), struct.unpack_from(">I", b, 0xFC)[0])     # 0x8a0d7489, kernel-written
            self.assertEqual(f(0xFFFFFFFF, b[0x30:0x40]), 0x5B64088C)                   # j_csum_seed of this journal
        self.assertEqual(struct.unpack_from(">I", b, 0x28)[0], 0x13); self.assertEqual(b[0x50], 4)


class Walk(Base):
    def test_proven_images_escape_wrap_partial_commit_and_latest(self):
        j = J(maxlen=16)
        j.place(2, 10, [(100, blk("a")), (200, blk("e", first_magic=True))], sec=1700000010)     # 2 desc, 3-4 images, 5 commit
        j.place(12, 11, [(100, blk("b")), (300, blk("c")), (2**40 + 5, blk("d"))], partial=True)   # 12 desc, 13-15, wraps: commit at 1
        r = self.run_v(j, [100, 200, 2**40 + 5, 999])
        t100 = r["targets"]["100"]
        self.assertEqual([i["sequence"] for i in t100["provenImages"]], [10, 11]); self.assertEqual(t100["latestProvenUnrevokedSequence"], 11)
        self.assertIn("NOT current-state proof", t100["status"]); self.assertTrue(r["acceptance"].startswith("NOT A RECOVERY ACCEPTANCE"))
        i11 = t100["provenImages"][1]; self.assertTrue(i11["partialCommit"]); self.assertEqual(i11["commitBlock"], 1)
        jp = self.file(bytes(j.b)); tp = self.file(json.dumps({"blocks": [100], "journalBlocks": [4, 13, 7]}).encode()); out = os.path.join(self.d, "jb.json")
        self.assertEqual(vmain(["--journal", jp, "--targets", tp, "--out", out, "--fixture", "--crc", "pure"]), 0)
        jb = read_json(out)["journalBlocks"]
        self.assertEqual((jb["4"]["provenAs"][0]["fsBlock"], jb["4"]["provenAs"][0]["sequence"]), (200, 10))     # slot 4 = escaped fs block 200 of tx 10
        self.assertEqual(jb["13"]["provenAs"][0]["fsBlock"], 100); self.assertEqual(jb["7"], {"provenAs": [], "unverifiedMappings": [], "entriesTotal": 0})
        self.assertTrue(jb["4"]["unverifiedMappings"][0]["descriptorChecksumValid"])
        e = r["targets"]["200"]["provenImages"][0]
        self.assertTrue(e["escaped"]); self.assertEqual(e["contentSha256"], __import__("hashlib").sha256(blk("e", first_magic=True)).hexdigest())
        self.assertEqual(r["targets"][str(2**40 + 5)]["provenImages"][0]["imageJournalBlock"], 15)   # 64-bit block number via blocknr_high
        self.assertEqual(r["targets"]["999"]["status"], "NO PROVEN UNREVOKED IMAGE")
        self.assertTrue(r["superblock"]["checksumVerified"]); self.assertEqual(r["summary"]["provenTransactions"], 2)

    def test_image_overwritten_by_later_data_is_not_proven(self):
        """the r1 inventory flaw: an image slot overwritten by a later transaction's DATA (no JBD2 header) still looks intact by
        grouping; only the per-tag checksum (which binds the sequence and content) exposes it"""
        j = J(maxlen=16)
        j.place(2, 20, [(500, blk("x")), (501, blk("y"))])
        j.put(4, blk("later-data"))                                   # 501's image slot overwritten, no header
        r = self.run_v(j, [500, 501])
        self.assertEqual(r["targets"]["500"]["status"], "NO PROVEN UNREVOKED IMAGE")       # a transaction is all-or-nothing
        self.assertEqual(r["targets"]["501"]["unverifiedReferences"][0]["sequence"], 20)
        self.assertIn("tag checksum mismatch", r["failedTransactions"][0]["reasons"][0])

    def test_checksum_and_structure_failures_prove_nothing(self):
        def j0():
            j = J(maxlen=16); j.place(2, 40, [(700, blk("p"))]); return j       # desc 2, image 3, commit 4
        cases = {"descriptor": (2, 20), "commit": (4, 0x10), "image": (3, 100)}
        for name, (p, off) in cases.items():
            j = j0(); j.b[p * BS + off] ^= 1
            r = self.run_v(j, [700])
            self.assertEqual(r["targets"]["700"]["status"], "NO PROVEN UNREVOKED IMAGE", name)
        j = j0(); j.put(4, bytes(BS))                                   # no commit at all
        r = self.run_v(j, [700]); self.assertEqual(r["summary"]["commitSequences"], 0); self.assertEqual(len(r["targets"]["700"]["unverifiedReferences"]), 1)
        j = J(maxlen=16); j.place(2, 41, [(701, blk("q")), (702, blk("r"))]); j.place(3, 99, [(1, blk("z"))])  # a foreign tx inside 41
        self.assertEqual(self.run_v(j, [701])["targets"]["701"]["status"], "NO PROVEN UNREVOKED IMAGE")

    def test_revoke_precedence_and_newer_unproven(self):
        j = J(maxlen=32)
        p, _ = j.place(1, 30, [(600, blk("v")), (800, blk("w"))])
        p, _ = j.place(p, 31, revokes=[600])                               # proven revoke at a later sequence
        p, _ = j.place(p, 32, [(800, blk("w2"))])
        q, c = j.place(p, 33, [(800, blk("w3"))]); j.b[c * BS + 0x10] ^= 1  # 33's commit is corrupt: unproven
        r = self.run_v(j, [600, 800])
        self.assertEqual(r["targets"]["600"]["provenImages"][0]["revokedByProvenSequence"], [31])
        self.assertEqual(r["targets"]["600"]["status"], "NO PROVEN UNREVOKED IMAGE")
        t = r["targets"]["800"]
        self.assertEqual(t["latestProvenUnrevokedSequence"], 32); self.assertEqual(t["newerOrUnprovenReferenceSequences"], [33])


class Refusals(Base):
    def test_superblock_and_feature_gates(self):
        j = J(maxlen=8); j.b[0x30] ^= 1                                   # UUID changed without its checksum
        self.run_v(j, [1], expect=3)
        for kw in ({"incompat": 0x1B}, {"incompat": 0x11}, {"ctype": 1}, {"compat": 1}):   # csum_v2, no 64bit, crc32 type, compat checksum
            j = J(maxlen=8); j.b[:BS] = sb(8, **kw); self.run_v(j, [1], expect=3)
        j = J(maxlen=8); j.b[:BS] = sb(9); self.run_v(j, [1], expect=3)        # maxlen != file blocks
        self.assertEqual(vmain(["--journal", self.file(bytes(J(maxlen=8).b)), "--targets", self.file(b'{"blocks":[1]}'),
                                 "--out", os.path.join(self.d, "o"), "--crc", "pure"]), 3)   # pure crc / fixture size refused in production

    def test_inputs_outputs_bounded_and_nofollow(self):
        jp = self.file(bytes(J(maxlen=8).b)); tp = self.file(b'{"blocks":[1]}')
        os.symlink(jp, os.path.join(self.d, "link"))
        os.mkfifo(os.path.join(self.d, "fifo"))
        signal.signal(signal.SIGALRM, lambda *a: (_ for _ in ()).throw(AssertionError("blocked on a FIFO"))); signal.alarm(10)
        try:
            for bad in (os.path.join(self.d, "link"), os.path.join(self.d, "fifo"), "relative.bin"):
                self.assertEqual(vmain(["--journal", bad, "--targets", tp, "--out", os.path.join(self.d, "o1"), "--fixture", "--crc", "pure"]), 3)
        finally:
            signal.alarm(0)
        for t in (b'{"blocks":[]}', b'{"blocks":[-1]}', b'{"blocks":[true]}', b'{"x":1}', b"\xff", b'{"blocks":[1],"journalBlocks":[0]}', b'{"blocks":[1],"journalBlocks":[99]}'):
            self.assertEqual(vmain(["--journal", jp, "--targets", self.file(t), "--out", os.path.join(self.d, "o2"), "--fixture", "--crc", "pure"]), 3)
        out = os.path.join(self.d, "o3")
        self.assertEqual(vmain(["--journal", jp, "--targets", tp, "--out", out, "--fixture", "--crc", "pure"]), 0)
        self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
        before = read_bytes(out)
        self.assertEqual(vmain(["--journal", jp, "--targets", tp, "--out", out, "--fixture", "--crc", "pure"]), 3)   # never overwritten
        self.assertEqual(read_bytes(out), before)

    def test_listing_budget_is_enforced_while_accumulating_and_read_budget_is_explicit(self):
        j = J(maxlen=64); p = 1
        for s in range(50, 60):
            p, _ = j.place(p, s, [(1000 + s, blk(f"i{s}"))])
        old = V.ENTRY_BUDGET; V.ENTRY_BUDGET = 1500
        try:
            r = self.run_v(j, list(range(1050, 1060)))
        finally:
            V.ENTRY_BUDGET = old
        self.assertLessEqual(r["summary"]["listedBytes"], 1500)
        self.assertEqual(r["summary"]["listedTransactionsTotal"], 10, "everything is still counted")
        self.assertLess(len(r["transactions"]), 10)
        old = V.READ_FACTOR; V.READ_FACTOR = 0
        try:
            r = self.run_v(j, [1050])
        finally:
            V.READ_FACTOR = old
        self.assertTrue(r["summary"]["walkBudgetExhausted"]); self.assertFalse(r["targets"]["1050"]["newerOrUnprovenComplete"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
