#!/usr/bin/env python3
"""ext4-recovery-checksum-stage/r1: offline tests of ext4_candidate_checksums.py (prepared by Claude 1643; NOT run by Claude).
SYNTHETIC fixtures only: inode and extent blocks are built here and checksummed with the LOCAL libext2fs ext2fs_crc32c_le (an
implementation independent of the checker's pure table), following the pinned kernel v6.12 / e2fsprogs v1.47.2 rules. They prove the
checker reproduces those rules and its strict choice conditions; not that any real candidate is valid. No device, image or USB."""
import json, os, signal, stat, struct, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.dont_write_bytecode = True
import ext4_candidate_checksums as C  # noqa: E402

LIB = C.libext2fs_crc32c()
UUID = "11c6bbac-f823-4052-a87a-066eed6ad590"
U16 = bytes.fromhex(UUID.replace("-", ""))
INO, GEN, OTHER_GEN = 1950053, 3326586236, 3941633993
TABLE_BLOCK, OFFSET, FS_BLOCKS = 499122230, 1024, 976562500
B = C.BLOCK


def seed(gen=GEN, ino=INO):
    s = LIB(0xFFFFFFFF, U16)
    return LIB(LIB(s, struct.pack("<I", ino)), struct.pack("<I", gen))


def node(depth, entries, *, emax=340, gen=GEN, corrupt=False):
    b = bytearray(B); struct.pack_into("<HHHHI", b, 0, C.EXT_MAGIC, len(entries), emax, depth, 0)
    for i, e in enumerate(entries):
        if depth == 0:
            lb, n, p, unw = e; struct.pack_into("<IHHI", b, 12 + 12 * i, lb, n + (C.INIT_MAX_LEN if unw else 0), p >> 32, p & 0xFFFFFFFF)
        else:
            lb, child = e; struct.pack_into("<IIHH", b, 12 + 12 * i, lb, child & 0xFFFFFFFF, child >> 32, 0)
    tail = 12 + 12 * emax
    if tail + 4 <= B:                                              # eh_max 341 has no room for a tail: refused on eh_max first
        struct.pack_into("<I", b, tail, LIB(seed(gen), bytes(b[:tail])))
    if corrupt:
        b[12] ^= 0xFF
    return bytes(b)


def root(depth, entries):
    r = bytearray(60); struct.pack_into("<HHHHI", r, 0, C.EXT_MAGIC, len(entries), 4, depth, 0)
    for i, e in enumerate(entries):
        if depth == 0:
            lb, n, p, unw = e; struct.pack_into("<IHHI", r, 12 + 12 * i, lb, n + (C.INIT_MAX_LEN if unw else 0), p >> 32, p & 0xFFFFFFFF)
        else:
            lb, child = e; struct.pack_into("<IIHH", r, 12 + 12 * i, lb, child & 0xFFFFFFFF, child >> 32, 0)
    return bytes(r)


def inode(iblock, *, size, sectors, gen=GEN, links=1, dtime=0, corrupt=False):
    r = bytearray(256)
    struct.pack_into("<HHI", r, 0, 0o100644, 994, size & 0xFFFFFFFF); struct.pack_into("<I", r, 0x14, dtime)
    struct.pack_into("<H", r, 0x1A, links); struct.pack_into("<I", r, 0x1C, sectors & 0xFFFFFFFF); struct.pack_into("<I", r, 0x20, C.EXTENTS_FL)
    r[0x28:0x64] = iblock; struct.pack_into("<I", r, 0x64, gen); struct.pack_into("<I", r, 0x6C, size >> 32)
    struct.pack_into("<H", r, 0x74, sectors >> 32); struct.pack_into("<H", r, 0x80, 32)
    c = LIB(seed(gen), bytes(r))                                   # both checksum fields are still zero here
    struct.pack_into("<H", r, C.OFF_CSUM_LO, c & 0xFFFF); struct.pack_into("<H", r, C.OFF_CSUM_HI, c >> 16)
    if corrupt:
        r[0x10] ^= 1
    return bytes(r)


def table_block(ino_bytes):
    b = bytearray(B); b[OFFSET:OFFSET + 256] = ino_bytes; return bytes(b)


class Fixture:
    """a fixture 'journal copy' (block 0 unused) + an r1-format inventory naming the image of each fs block"""
    def __init__(self, d):
        self.d, self.blocks, self.cands = d, [bytes(B)], {}

    def add(self, fs_block, data, seq, *, committed=True, intact=True, escaped=False):
        self.blocks.append(data)
        self.cands.setdefault(str(fs_block), []).append({"sequence": seq, "imageJournalBlock": len(self.blocks) - 1, "committed": committed,
                                                          "txIntact": intact, "escaped": escaped, "checksum": "unchecked"})

    def write(self, tag):
        j, inv = os.path.join(self.d, f"{tag}.journal"), os.path.join(self.d, f"{tag}.inventory.json")
        with open(j, "wb") as f:
            f.write(b"".join(self.blocks))
        with open(inv, "w") as f:
            json.dump({"format": C.INVENTORY_FORMAT, "targets": {"candidates": self.cands, "revokedBy": {}}}, f)
        os.chmod(j, 0o600); os.chmod(inv, 0o600); return j, inv


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ext4csum-"); self.n = 0

    def run_q(self, fx, *, bound=10, extra=(), expect_rc=0):
        self.n += 1; j, inv = fx.write(f"f{self.n}"); out = os.path.join(self.d, f"out{self.n}.json")
        argv = ["--journal", j, "--inventory", inv, "--uuid", UUID, "--ino", str(INO), "--gen", str(GEN), "--inode-size", "256",
                "--inode-table-block", str(TABLE_BLOCK), "--inode-offset", str(OFFSET), "--at-or-before-seq", str(bound),
                "--fs-blocks", str(FS_BLOCKS), "--huge-file", "yes", "--no-csum-seed", "--out", out, "--fixture", *extra]
        self.assertEqual(C.main(argv), expect_rc)
        if expect_rc:
            self.assertFalse(os.path.exists(out)); return None
        with open(out) as f:
            return json.load(f)

    def depth2(self, fx, *, leaf_a=None, seq=5):
        """root -> index 900 -> leaves 901 (lblk 0) and 902 (lblk 100); data 10 + 5 (unwritten) + 50 blocks; i_size 200 blocks"""
        a = [(0, 10, 5000, False), (20, 5, 6000, True)]
        fx.add(900, node(1, [(0, 901), (100, 902)]), seq)
        fx.add(901, leaf_a or node(0, a), seq)
        fx.add(902, node(0, [(100, 50, 7000, False)]), seq)
        fx.add(TABLE_BLOCK, table_block(inode(root(2, [(0, 900)]), size=200 * B, sectors=(65 + 3) * 8)), seq)
        return a


class Checksums(Base):
    def test_crc32c_pure_table_equals_libext2fs_and_the_check_vector(self):
        self.assertIsNotNone(LIB, "the local libext2fs is required")
        self.assertEqual((~C.crc32c(0xFFFFFFFF, b"123456789")) & 0xFFFFFFFF, 0xE3069283)
        for s, data in ((0xFFFFFFFF, U16), (7, os.urandom(4096)), (0, b""), (0xFFFFFFFF, bytes(256))):
            self.assertEqual(C.crc32c(s, data), LIB(s, data))
        self.assertEqual(C.inode_seed(U16, INO, GEN), seed())
        self.assertIn("libext2fs", C.crc_self_check())

    def test_depth2_tree_all_checksums_valid_map_accounted_holes_and_sparse_tail_only_then(self):
        fx = Fixture(self.d); self.depth2(fx)
        r = self.run_q(fx)
        self.assertTrue(r["metadataChecksumsValid"], r["problems"]); self.assertFalse(r["recoveryProven"])
        self.assertTrue(r["dataIntact"].startswith("NOT ASSESSED"))
        self.assertEqual((r["chosenInode"]["sequence"], r["chosenInode"]["checksumValid"], r["chosenInode"]["checksumHiUsed"]), (5, True, True))
        m = r["map"]
        self.assertEqual((m["extents"], m["unwrittenExtents"], m["dataBlocks"], m["treeBlocks"], m["accounted"]), (3, 1, 65, 3, True))
        self.assertEqual((m["holes"], m["holeBlocks"], m["sparseTailBytes"]), (2, 10 + 75, 50 * B))
        self.assertEqual([n["block"] for n in r["tree"]], [900, 901, 902])
        self.assertEqual({n["versions"][0]["tailOffset"] for n in r["tree"]}, {12 + 12 * 340})

    def test_choice_is_the_newest_valid_image_at_or_before_the_inode_and_a_newer_invalid_one_blocks(self):
        fx = Fixture(self.d); a = self.depth2(fx, leaf_a=node(0, [(0, 10, 5000, False)]), seq=3)   # an OLDER leaf content at seq 3
        fx.add(901, node(0, a), 6)                                     # the newer valid leaf content
        fx.add(TABLE_BLOCK, table_block(inode(root(2, [(0, 900)]), size=200 * B, sectors=(65 + 3) * 8)), 9)
        fx.add(901, node(0, [], emax=340), 20)                         # after the chosen inode (e.g. the deletion): ignored, listed
        r = self.run_q(fx)
        leaf = [n for n in r["tree"] if n["block"] == 901][0]
        self.assertEqual(leaf["chosen"]["sequence"], 6); self.assertEqual(leaf["distinctValidContents"], 2)
        self.assertTrue([v for v in leaf["versions"] if v.get("afterChosenInode") and v["sequence"] == 20])
        self.assertTrue(r["metadataChecksumsValid"], r["problems"]); self.assertEqual(r["chosenInode"]["sequence"], 9)
        fx.add(901, node(0, a, corrupt=True), 8)                       # a newer image at or before the inode FAILS: ambiguous
        r = self.run_q(fx)
        self.assertFalse(r["metadataChecksumsValid"]); self.assertIn("ambiguous", [n for n in r["tree"] if n["block"] == 901][0])
        self.assertTrue(r["map"]["holes"].startswith("NOT INTERPRETED"))

    def test_inode_versions_bad_checksum_other_generation_and_bounds(self):
        fx = Fixture(self.d); self.depth2(fx)
        fx.add(TABLE_BLOCK, table_block(inode(root(2, [(0, 900)]), size=200 * B, sectors=68 * 8, corrupt=True)), 8)
        fx.add(TABLE_BLOCK, table_block(inode(root(0, []), size=0, sectors=0, gen=OTHER_GEN)), 9)   # the inode number reused later
        r = self.run_q(fx)
        self.assertEqual(r["otherGenerationImages"], 1)
        self.assertEqual([(v["sequence"], v["checksumValid"]) for v in r["inodeVersions"]], [(5, True), (8, False)])
        self.assertEqual(r["chosenInode"]["sequence"], 5); self.assertFalse(r["metadataChecksumsValid"])
        self.assertTrue([p for p in r["problems"] if "fail the checksum" in p])
        r = self.run_q(fx, bound=4)                                    # nothing at or before the bound
        self.assertIsNone(r["chosenInode"]); self.assertFalse(r["metadataChecksumsValid"])
        r = self.run_q(fx, extra=("--expect-size", str(123)))          # the expected finalized size must match
        self.assertIsNone(r["chosenInode"])

    def test_extent_blocks_bound_to_the_inode_generation_and_kernel_structure_rules(self):
        cases = [(node(0, [(0, 10, 5000, False), (20, 5, 6000, True)], gen=OTHER_GEN), "checksum mismatch"),
                 (node(0, [(1, 10, 5000, False)]), "first logical block"),
                 (node(0, [(0, 10, 5000, False), (5, 5, 6000, False)]), "overlapping"),
                 (node(0, [(0, 10, 5000, False)], emax=341), "invalid eh_max"),
                 (node(1, [(0, 77)]), "unexpected eh_depth"),
                 (node(0, [(0, 0, 5000, False)]), "invalid extent"),
                 (node(0, [(0, 10, FS_BLOCKS, False)]), "invalid extent"),
                 (node(0, [(0, 10, 5000, False), (95, 10, 6000, False)]), "beyond the parent range")]
        for leaf, why in cases:
            fx = Fixture(self.d); self.depth2(fx, leaf_a=leaf)
            r = self.run_q(fx)
            v = [n for n in r["tree"] if n["block"] == 901][0]["versions"][0]
            self.assertFalse(r["metadataChecksumsValid"]); self.assertIn(why, v["why"] or "", (why, v))
        fx = Fixture(self.d); self.depth2(fx, leaf_a=node(0, [(0, 10, 5000, False), (20, 5, 6000, True)], emax=100))
        r = self.run_q(fx)                                             # a smaller eh_max moves the tail: still valid
        self.assertTrue(r["metadataChecksumsValid"], r["problems"])
        self.assertEqual([n for n in r["tree"] if n["block"] == 901][0]["versions"][0]["tailOffset"], 12 + 12 * 100)
        fx = Fixture(self.d); fx.add(TABLE_BLOCK, table_block(inode(struct.pack("<HHHHI", C.EXT_MAGIC, 1, 4, 3, 0) + bytes(48), size=B, sectors=8)), 5)
        r = self.run_q(fx)
        self.assertFalse(r["metadataChecksumsValid"]); self.assertTrue([p for p in r["problems"] if "depth 3" in p])

    def test_block_accounting_must_match_and_depth0_depth1_trees_qualify(self):
        fx = Fixture(self.d); self.depth2(fx)
        fx.add(TABLE_BLOCK, table_block(inode(root(2, [(0, 900)]), size=200 * B, sectors=(65 + 3) * 8 + 8)), 6)   # one block too many
        r = self.run_q(fx)
        self.assertFalse(r["metadataChecksumsValid"]); self.assertFalse(r["map"]["accounted"])
        fx = Fixture(self.d); fx.add(TABLE_BLOCK, table_block(inode(root(0, [(0, 4, 800, False), (8, 2, 900, False)]), size=16 * B, sectors=6 * 8)), 5)
        r = self.run_q(fx)
        self.assertTrue(r["metadataChecksumsValid"], r["problems"])
        self.assertEqual((r["map"]["extents"], r["map"]["treeBlocks"], r["map"]["holes"], r["map"]["sparseTailBytes"]), (2, 0, 1, 6 * B))
        fx = Fixture(self.d); fx.add(950, node(0, [(0, 4, 800, False)]), 4)
        fx.add(TABLE_BLOCK, table_block(inode(root(1, [(0, 950)]), size=4 * B, sectors=5 * 8)), 5)
        r = self.run_q(fx)
        self.assertTrue(r["metadataChecksumsValid"], r["problems"]); self.assertEqual(r["map"]["treeBlocks"], 1)
        fx = Fixture(self.d); fx.add(950, node(0, [(0, 4, 800, False)]), 4, committed=False)
        fx.add(TABLE_BLOCK, table_block(inode(root(1, [(0, 950)]), size=4 * B, sectors=5 * 8)), 5)
        r = self.run_q(fx)                                             # an uncommitted image is never chosen
        self.assertFalse(r["metadataChecksumsValid"])


class Safety(Base):
    def test_inputs_bounded_no_follow_and_refusals_write_nothing(self):
        fx = Fixture(self.d); self.depth2(fx); j, inv = fx.write("s")
        out = os.path.join(self.d, "o.json")
        base = ["--uuid", UUID, "--ino", str(INO), "--gen", str(GEN), "--inode-size", "256", "--inode-table-block", str(TABLE_BLOCK),
                "--inode-offset", str(OFFSET), "--at-or-before-seq", "10", "--fs-blocks", str(FS_BLOCKS), "--huge-file", "yes", "--out", out]
        link = os.path.join(self.d, "l.journal"); os.symlink(j, link)
        fifo = os.path.join(self.d, "p.journal"); os.mkfifo(fifo)
        bad_inv = os.path.join(self.d, "bad.json")
        with open(bad_inv, "w") as f:
            json.dump({"format": "x", "targets": {"candidates": {}}}, f)
        os.chmod(bad_inv, 0o600)

        def alarm(*_):
            raise AssertionError("an input open blocked")
        old = signal.signal(signal.SIGALRM, alarm); signal.alarm(20)
        try:
            for argv in (["--journal", link, "--inventory", inv, "--no-csum-seed", "--fixture"],
                         ["--journal", fifo, "--inventory", inv, "--no-csum-seed", "--fixture"],
                         ["--journal", j, "--inventory", inv, "--no-csum-seed"],                     # not the 1 GiB production size
                         ["--journal", j, "--inventory", bad_inv, "--no-csum-seed", "--fixture"],
                         ["--journal", j, "--inventory", inv, "--fixture"]):                         # metadata_csum_seed not asserted absent
                self.assertEqual(C.main(base + argv), 3, argv); self.assertFalse(os.path.exists(out))
        finally:
            signal.alarm(0); signal.signal(signal.SIGALRM, old)
        self.assertEqual(C.main(base + ["--journal", j, "--inventory", inv, "--no-csum-seed", "--fixture"]), 0)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        before = os.stat(out).st_mtime_ns
        self.assertEqual(C.main(base + ["--journal", j, "--inventory", inv, "--no-csum-seed", "--fixture"]), 3)
        self.assertEqual(os.stat(out).st_mtime_ns, before, "never overwritten")


if __name__ == "__main__":
    unittest.main()
