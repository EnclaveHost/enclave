#!/usr/bin/env python3
"""postdelete-bitmap-stage/r3 tests (PREPARED; root runs them). r3 adds (review 1687, root 1698): extent-tree binding (root ->
[index ->] leaf images, extent block checksums with the old generation, newest image before the deletion, decoded map equality),
window completeness from the oldest bound tree image, observed SET->CLEAR vs clear-only ownership counts, the S0 orphan i_dtime check,
tree-block revokes, the single-transaction deletion shape of real tid 17170, and a REAL leaf vector (leaf 499155437 at tid 14665:
its kernel-written extent checksum must verify for inode 1950053 generation 3326586236 and fail for another generation).
r2 = r1 with a FIXTURE-ONLY fix (root 1682/1683): the synthetic
"unrelated" bitmap bits OTHER were (0, 10), overlapping 7 candidate bits of group 2 (E3B 0..1, E2 5..9), so the clean fixtures never
freed them; OTHER is now (100, 110), disjoint from every candidate bit (asserted), and the old overlap is kept as a NEGATIVE case.
Checker and runtime are byte-identical to r1. Synthetic csum-v3 journals built with the reference crc32c table,
carrying ext4 inode-table, inode-bitmap and block-bitmap images of a small fixture filesystem (4 groups); they exercise the
boundary derivation, window completeness, reuse logic, batching and refusals. Two NON-circular checks use real bytes: the REAL
256-byte inode slot of inode 1950053 from the proven tid-17169 image (its kernel-written ext4 inode checksum must verify with both
crc implementations) and the REAL fs-stats header lines (the parser must accept the real format)."""
import contextlib, hashlib, importlib.util, io, json, os, struct, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("pdb", HERE.parent / "postdelete_bitmap.py")
P = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(P)
V = P.V
crc = V.crc32c_pure
BS, MAGIC, M32 = V.BS, V.MAGIC, 0xFFFFFFFF
UUID = bytes(range(16))
FS_SEED = crc(0xFFFFFFFF, UUID)
OLD, NEW, INO = 1111, 2222, 357                     # INO: group 2, index 100 -> inode table block 46 + 6 = 52, offset 1024
IT, IBM, G1, G2 = 52, 22, 11, 12                    # inode table block of INO, its inode bitmap, block bitmaps of groups 1 and 2
OTHER, E1, E3A, E3B, E2 = (100, 110), (1000, 1100), (32760, 32768), (0, 2), (5, 55)  # bit ranges inside a group; OTHER disjoint
R1_OTHER = (0, 10)                                  # r1 fixture bug: overlaps group 2 candidate bits 0..1 and 5..9
EXTENTS = [{"logical": 0, "blocks": 100, "physical": 32768 + 1000, "unwritten": False},      # leaf tid 10
           {"logical": 100, "blocks": 50, "physical": 2 * 32768 + 5, "unwritten": False},     # leaf tid 10
           {"logical": 150, "blocks": 10, "physical": 32768 + 32760, "unwritten": False}]     # leaf tid 11, crosses group 1 -> 2
PICKED = [{"block": 70, "sequence": 10, "journalBlock": None, "entries": 2}, {"block": 71, "sequence": 11, "journalBlock": None, "entries": 1}]
IDX = 72                                            # extent index block of the depth-2 variant


def root(depth, ptrs):
    """inode i_block (60 bytes): extent header + index entries"""
    r = bytearray(60); struct.pack_into("<HHHH", r, 0, 0xF30A, len(ptrs), 4, depth)
    for i, (lb, blk) in enumerate(ptrs):
        struct.pack_into("<IIH", r, 12 + 12 * i, lb, blk & M32, blk >> 32)
    return bytes(r)


ROOT1, ROOT2, EMPTY_ROOT = root(1, [(0, 70), (150, 71)]), root(2, [(0, IDX)]), root(0, [])
ext = lambda es: [(e["logical"], e["blocks"], e["physical"], e["unwritten"]) for e in es]


def enode(depth, ents, gen=OLD, ino=INO):
    """an ext4 extent tree block (eh_max 340) with its metadata_csum tail: crc32c(crc32c(crc32c(fs seed, ino), gen), block[:4092])"""
    b = bytearray(BS); struct.pack_into("<HHHH", b, 0, 0xF30A, len(ents), 340, depth)
    for i, e in enumerate(ents):
        if depth == 0:
            lb, ln, ph, uw = e; struct.pack_into("<IHHI", b, 12 + 12 * i, lb, ln + (32768 if uw else 0), ph >> 32, ph & M32)
        else:
            lb, blk = e; struct.pack_into("<IIH", b, 12 + 12 * i, lb, blk & M32, blk >> 32)
    seed = crc(crc(FS_SEED, struct.pack("<I", ino)), struct.pack("<I", gen))
    struct.pack_into("<I", b, 4092, crc(seed, bytes(b[:4092])))
    return bytes(b)


LEAF70, LEAF71, INDEX72 = enode(0, ext(EXTENTS[:2])), enode(0, ext(EXTENTS[2:])), enode(1, [(0, 70), (150, 71)])
FEATS = "has_journal ext_attr resize_inode dir_index filetype extent 64bit flex_bg sparse_super large_file huge_file dir_nlink extra_isize metadata_csum"


def pmain(args):
    """P.main ONCE with its output captured (the test log holds only unittest's own lines)"""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return P.main(args)


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


# ---- fixture journal ----------------------------------------------------------------------------------------------------------
def sb(maxlen, seq, head, first=1, uuid=UUID):
    b = bytearray(BS)
    struct.pack_into(">III", b, 0, MAGIC, V.SB_V2, 0)
    struct.pack_into(">IIIII", b, 0xC, BS, maxlen, first, seq, 0)
    struct.pack_into(">III", b, 0x24, 0, 0x13, 0)
    b[0x30:0x40] = uuid; b[0x50] = 4
    struct.pack_into(">I", b, 0x58, head)
    t = bytearray(b[:1024]); t[0xFC:0x100] = bytes(4)
    struct.pack_into(">I", b, 0xFC, crc(0xFFFFFFFF, t))
    return b


class J:
    def __init__(self, maxlen=64, first=1):
        self.maxlen, self.first, self.commits, self.where = maxlen, first, {}, {}
        self.b = bytearray(maxlen * BS)
        self.seed = crc(0xFFFFFFFF, UUID)

    def nxt(self, p):
        return p + 1 if p + 1 < self.maxlen else self.first

    def put(self, p, data):
        self.b[p * BS:(p + 1) * BS] = data

    def place(self, pos, S, images, revokes=()):
        if revokes:                                        # a csum-v3 revoke block (r_count incl. the 16-byte header, be64 records)
            r = bytearray(BS); struct.pack_into(">IIII", r, 0, MAGIC, V.REVOKE, S, 16 + 8 * len(revokes))
            for i, x in enumerate(revokes):
                struct.pack_into(">Q", r, 16 + 8 * i, x)
            t = bytearray(r); t[BS - 4:] = bytes(4); struct.pack_into(">I", r, BS - 4, crc(self.seed, t)); self.put(pos, r)
            pos = self.nxt(pos)
        d = bytearray(BS); struct.pack_into(">III", d, 0, MAGIC, V.DESC, S)
        off, logged = 12, []
        for i, (fs, content) in enumerate(images):
            content = bytes(content).ljust(BS, b"\0")
            esc = content[:4] == V.MAGIC_BE
            lg = (bytes(4) + content[4:]) if esc else content
            flags = (V.F_ESCAPE if esc else 0) | (V.F_SAME_UUID if i else 0) | (V.F_LAST_TAG if i == len(images) - 1 else 0)
            struct.pack_into(">IIII", d, off, fs & M32, flags, fs >> 32, crc(crc(self.seed, struct.pack(">I", S)), lg)); off += 16
            if not i:
                d[off:off + 16] = UUID; off += 16
            logged.append(lg)
        t = bytearray(d); t[BS - 4:] = bytes(4); struct.pack_into(">I", d, BS - 4, crc(self.seed, t)); self.put(pos, d)
        for (fs, _), lg in zip(images, logged):
            pos = self.nxt(pos); self.put(pos, lg); self.where[(S, fs)] = pos
        pos = self.nxt(pos)
        c = bytearray(BS); struct.pack_into(">III", c, 0, MAGIC, V.COMMIT, S); struct.pack_into(">QI", c, 0x30, 1700000000 + S, 7)
        struct.pack_into(">I", c, 0x10, crc(self.seed, c)); self.put(pos, c); self.commits[S] = pos
        return self.nxt(pos)


def build(txs, sseq=None, head=None):
    j, pos = J(), 1
    for t in txs:                                          # (tid, images) or (tid, images, revoked fs blocks)
        pos = j.place(pos, *t)
    j.put(0, sb(j.maxlen, txs[-1][0] + 2 if sseq is None else sseq, pos if head is None else head))
    return j


# ---- fixture filesystem content -------------------------------------------------------------------------------------------------
def bits(*ranges):
    v = 0
    for lo, hi in ranges:
        v |= ((1 << (hi - lo)) - 1) << lo
    return v.to_bytes(BS, "little")


def ibm(used):
    """inode bitmap of group 2: inodes 0..9 used, INO (bit 100) per `used`, padding bits 128.. set as ext4 does"""
    return bits((0, 10), (128, 8 * BS), *([(100, 101)] if used else []))


def slot(gen=OLD, links=1, size=655360, iblocks=1296, dtime=0, root=None, bad_csum=False):
    s = bytearray(256)
    struct.pack_into("<H", s, 0x00, 0o100640)
    struct.pack_into("<I", s, 0x04, size & M32); struct.pack_into("<I", s, 0x6C, size >> 32)
    struct.pack_into("<I", s, 0x14, dtime); struct.pack_into("<H", s, 0x1A, links)
    struct.pack_into("<I", s, 0x1C, iblocks & M32); struct.pack_into("<H", s, 0x74, iblocks >> 32)
    struct.pack_into("<I", s, 0x20, 0x80000)
    s[0x28:0x28 + 60] = ROOT1 if root is None else root                          # r3: the extent root (depth-1 index by default)
    struct.pack_into("<I", s, 0x64, gen); struct.pack_into("<H", s, 0x80, 32)
    c = crc(crc(crc(FS_SEED, struct.pack("<I", INO)), struct.pack("<I", gen)), bytes(s))     # whole inode, checksum fields still 0
    struct.pack_into("<H", s, 0x7C, (c ^ (1 if bad_csum else 0)) & 0xFFFF); struct.pack_into("<H", s, 0x82, c >> 16)
    return bytes(s)


def table(**kw):
    b = bytearray(BS); b[1024:1280] = slot(**kw); return bytes(b)


UNLINKED = dict(links=0)                                                      # orphan: i_dtime = next orphan (0)
DELETING = dict(links=0, size=0, iblocks=648)
FREED = dict(links=0, size=0, iblocks=0, root=EMPTY_ROOT, dtime=1700000500)
REUSED = dict(gen=NEW, links=1, size=4096, iblocks=8, root=EMPTY_ROOT)


def clean_txs(other=OTHER, depth=1):
    lv = dict(root=ROOT2, iblocks=1304) if depth == 2 else {}                    # depth 2: + index block 72 = 3 metadata blocks
    return [(10, [(G1, bits(other, E1)), (G2, bits(other, E2)), (IBM, ibm(True)), (IT, table(**lv)), (70, LEAF70)]),
            (11, [(G1, bits(other, E1, E3A)), (G2, bits(other, E2, E3B)), (IT, table(**lv)), (71, LEAF71)]
             + ([(IDX, INDEX72)] if depth == 2 else [])),
            (12, [(IT, table(**lv))]),                                               # P: last live image
            (13, [(IT, table(**UNLINKED, **lv)), (G1, bits(other))]),               # S0, group 1 freed
            (14, [(IT, table(**FREED)), (IBM, ibm(False)), (G2, bits(other))]),     # C: completion, group 2 freed
            (15, [(G1, bits(other, (5000, 5001)))]),                                 # unrelated allocation in group 1
            (16, [(IT, table(**REUSED)), (IBM, ibm(True))])]                         # slot reuse


def fs_stats(ngroups=4, feats=FEATS, bs=4096, group_line=None):
    h = ["Filesystem volume name:   fixture", "Filesystem UUID:          00010203-0405-0607-0809-0a0b0c0d0e0f",
         f"Filesystem features:      {feats}", "Filesystem state:         clean", f"Inode count:              {128 * ngroups}",
         f"Block count:              {32768 * ngroups}", "First block:              0", f"Block size:               {bs}",
         "Blocks per group:         32768", "Inodes per group:         128", "Inode blocks per group:   8", "Inode size:               256",
         "Last write time:          Mon Oct 26 09:00:38 2026", "Checksum type:            crc32c"]
    for g in range(ngroups):
        line = group_line(g) if group_line else None
        h += [line or f" Group {g:2d}: block bitmap at {10 + g}, inode bitmap at {20 + g}, inode table at {30 + 8 * g}",
              "           0 free blocks, 0 free inodes, 0 used directories, 0 unused inodes", "           [Checksum 0x0000]"]
    return ("\n".join(h) + "\n").encode()


def coverage(extents=None, picked=None):
    return {"authentication": "unchecked candidates only", "recoveryProven": False,
            "extents": EXTENTS if extents is None else extents, "picked": [dict(p) for p in (PICKED if picked is None else picked)]}


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=os.environ.get("TEST_TMP")); self.n = 0
        self.saved = (V.ENTRY_BUDGET, P.INITIAL_BATCH, P.MAX_VERIFY_CALLS)

    def tearDown(self):
        V.ENTRY_BUDGET, P.INITIAL_BATCH, P.MAX_VERIFY_CALLS = self.saved
        for root, ds, fs in os.walk(self.d, topdown=False):
            for f in fs: os.unlink(os.path.join(root, f))
            for x in ds: os.rmdir(os.path.join(root, x))
        os.rmdir(self.d)

    def file(self, data, name=None):
        self.n += 1; p = os.path.join(self.d, name or f"f{self.n}")
        with open(p, "wb") as f: f.write(data)
        os.chmod(p, 0o600); return p

    def paths(self, j=None, fs=None, cov=None, case_over=None, expect_over=None):
        j = j or build(clean_txs()); cov = cov or coverage()
        for p in cov["picked"]:                                        # the journal position of each leaf image, as the real map records it
            if p.get("journalBlock") is None:
                p["journalBlock"] = j.where.get((p["sequence"], p["block"]), 0)
        jp = self.file(bytes(j.b)); fp = self.file(fs or fs_stats()); cp = self.file(json.dumps(cov).encode())
        sha = lambda p: hashlib.sha256(read_bytes(p)).hexdigest()
        c = {"format": "postdelete-bitmap-case/r1", "inode": INO, "oldGeneration": OLD, "metadataBlocks": 2,
             "inputs": {"journalSha256": sha(jp), "fsStatsSha256": sha(fp), "coverageSha256": sha(cp)},
             "expect": {"fsUuid": UUID.hex(), "inodeTableBlock": IT, "slotOffset": 1024, "lastLiveSequence": 12,
                        "deletionStartSequence": 13, "oldSize": 655360}}
        c["expect"].update(expect_over or {}); c.update(case_over or {})
        return ["--journal", jp, "--fs-stats", fp, "--coverage", cp, "--case", self.file(json.dumps(c).encode()),
                "--out", os.path.join(self.d, f"out{self.n}.json"), "--fixture", "--crc", "pure"]

    def run_p(self, expect, **kw):
        args = self.paths(**kw)
        self.assertEqual(pmain(args), expect)
        return read_json(args[args.index("--out") + 1]) if expect in (0, 4, 5) else None


class Real(Base):
    def test_real_inode_slot_checksum_and_size_vector(self):
        s = bytes.fromhex((HERE / "real-inode-1950053-seq17169-slot256.hex").read_text().strip())
        self.assertEqual(len(s), 256)
        uuid = bytes.fromhex("11c6bbacf8234052a87a066eed6ad590")
        fn, _ = V.crc_impl("libext2fs")
        for f in (crc, fn):
            self.assertEqual(P.inode_csum(f, f(0xFFFFFFFF, uuid), 1950053, s, 256), (True, 0x72B56BBA))      # kernel-written
            self.assertEqual(P.inode_csum(f, f(0xFFFFFFFF, uuid), 1950054, s, 256)[0], False)                # bound to the inode number
        r = P.inode_fields(s, 256, True)
        self.assertEqual((r["generation"], r["links"], r["size"], r["extentMagic"], r["extentEntries"], r["extentDepth"]),
                         (3326586236, 1, 1138166333440, 0xF30A, 1, 2))
        self.assertEqual(r["allocatedBytes"], 1134426460160)
        self.assertEqual(r["allocatedBytes"], (276959557 + 28) * 4096)          # candidate map data blocks + 28 metadata blocks

    def test_real_leaf_extent_checksum_and_decode(self):
        b = bytes.fromhex((HERE / "real-leaf-499155437-seq14665.hex").read_text().strip())
        self.assertEqual(len(b), BS)
        uuid = bytes.fromhex("11c6bbacf8234052a87a066eed6ad590")
        fn, _ = V.crc_impl("libext2fs")
        for f in (crc, fn):
            seed = lambda gen: f(f(f(0xFFFFFFFF, uuid), struct.pack("<I", 1950053)), struct.pack("<I", gen))
            self.assertTrue(P.extent_block_csum_ok(f, seed(3326586236), b))                        # kernel-written, old generation
            self.assertFalse(P.extent_block_csum_ok(f, seed(3941633993), b))                       # the slot's NEW generation
        mag, n, mx, depth, ents = P.extent_node(b)
        self.assertEqual((mag, n, mx, depth, ents[0]), (0xF30A, 337, 340, 0, (0, 2048, 248373248, False)))

    def test_real_fs_stats_header_format(self):
        head = (HERE / "real-fs-stats-header.txt").read_bytes()
        real = {15234: " Group 15234: block bitmap at 499122178, inode bitmap at 499122194, inode table at 499122224"}
        lines = []
        for g in range(29803):
            lines += [real.get(g) or f" Group {g:2d}: block bitmap at {1_000_000 + g}, inode bitmap at {2_000_000 + g}, inode table at {3_000_000 + 8 * g}",
                      "           0 free blocks, 128 free inodes, 0 used directories, 128 unused inodes", "           [Inode not init, Checksum 0x0000]"]
        geo, bb, ib, it, _ = P.parse_fs_stats(head + ("\n".join(lines) + "\n").encode())
        self.assertEqual((geo["uuid"], geo["groups"], geo["inodeCount"], geo["blockCount"], geo["inodeSize"]),
                         ("11c6bbacf8234052a87a066eed6ad590", 29803, 3814784, 976562500, 256))
        self.assertIn("metadata_csum", geo["features"]); self.assertEqual(geo["state"], "clean")
        ig, idx = divmod(1950053 - 1, geo["inodesPerGroup"])
        self.assertEqual((ig, it[ig] + idx * 256 // BS, idx * 256 % BS, ib[ig], bb[ig]), (15234, 499122230, 1024, 499122194, 499122178))


class Parsers(Base):
    def test_fs_stats_refusals(self):
        bad = [fs_stats(feats=FEATS + " orphan_file"), fs_stats(feats=FEATS + " bigalloc"), fs_stats(feats=FEATS.replace(" metadata_csum", "")),
               fs_stats(bs=1024), fs_stats(ngroups=4).replace(b" Group  3:", b" Group  4:"),
               fs_stats(group_line=lambda g: f" Group {g:2d}: block bitmap at {10 + g}, inode bitmap at {20 + g}" if g == 1 else None),
               fs_stats(group_line=lambda g: f" Group {g:2d}: block bitmap at 33, inode bitmap at {20 + g}, inode table at {30 + 8 * g}" if g == 1 else None),
               fs_stats() + b"trailing junk\n"]
        for i, raw in enumerate(bad):
            with self.assertRaises(V.Refuse, msg=str(i)):
                P.parse_fs_stats(raw)
        geo, bb, ib, it, meta = P.parse_fs_stats(fs_stats())
        self.assertEqual((bb[2], ib[2], it[2], geo["groups"]), (12, 22, 46, 4))

    def test_coverage_refusals_and_group_split(self):
        geo, _, _, _, meta = P.parse_fs_stats(fs_stats())
        e = lambda **kw: [{**EXTENTS[0], **kw}, EXTENTS[1], EXTENTS[2]]
        bad = [coverage(extents=e(physical=2 * 32768 + 50)),                       # physically overlaps extent 2
               coverage(extents=e(physical=40)),                                   # overlaps an inode table
               coverage(extents=e(physical=4 * 32768 - 10)),                       # beyond the block count
               coverage(extents=e(blocks=True)), coverage(extents=e(logical=120)), # bool; logical overlap
               coverage(picked=[{**PICKED[0], "entries": 1}, PICKED[1]]), {"extents": EXTENTS}]
        for i, c in enumerate(bad):
            with self.assertRaises(V.Refuse, msg=str(i)):
                P.parse_coverage(json.dumps(c).encode(), geo, meta)
        _, phys = P.parse_coverage(json.dumps(coverage()).encode(), geo, meta)
        g = P.group_pieces(phys)
        self.assertEqual(sorted(g), [1, 2])
        self.assertEqual(bin(g[1][0]).count("1"), 108); self.assertEqual(bin(g[2][0]).count("1"), 52)
        self.assertEqual(sorted(ls for _, ls in g[2][1]), [10, 11])                # E2 from leaf tid 10, E3's tail from leaf tid 11

    def test_fixture_unrelated_bits_disjoint_and_r1_overlap_still_blocks(self):
        """root 1683: with r1's overlapping OTHER the checker correctly BLOCKS (7 candidate bits never seen freed, set again at C)"""
        geo, _, _, _, meta = P.parse_fs_stats(fs_stats())
        _, phys = P.parse_coverage(json.dumps(coverage()).encode(), geo, meta)
        other, r1_other = int.from_bytes(bits(OTHER), "little"), int.from_bytes(bits(R1_OTHER), "little")
        masks = {g: m for g, (m, _) in P.group_pieces(phys).items()}
        self.assertEqual(sorted(masks), [1, 2])
        for g, m in masks.items():
            self.assertEqual(m & other, 0, f"fixture OTHER overlaps candidate bits of group {g}")
            self.assertEqual(m & (1 << 5000), 0, f"fixture unrelated allocation overlaps group {g}")
        self.assertEqual((bin(masks[1] & r1_other).count("1"), bin(masks[2] & r1_other).count("1")), (0, 7))
        r = self.run_p(5, j=build(clean_txs(other=R1_OTHER)))
        self.assertEqual(r["verdict"], "BLOCKED")
        self.assertEqual((r["bitmaps"]["notObservedFreedBlocks"], r["bitmaps"]["reusedBlocks"]), (7, 7))
        self.assertEqual(r["bitmaps"]["reusedGroups"], [{"group": 2, "bitmapBlock": 12, "blocks": 7, "firstReuseTid": 14,
                                                         "sample": [65536, 65537, 65541, 65542, 65543, 65544, 65545]}])


class Scenarios(Base):
    def test_clean_deletion_no_reuse(self):
        r = self.run_p(0)
        self.assertEqual(r["verdict"], "NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY"); self.assertEqual(r["blockers"], [])
        self.assertTrue(r["acceptance"].startswith("NOT A RECOVERY ACCEPTANCE"))
        b = r["boundary"]
        self.assertEqual((b["lastLiveTid"], b["deletionStartTid"], b["completionTid"], b["slotReuseTid"]), (12, 13, 14, 16))
        self.assertEqual(b["inodeBitmapRows"], [[14, 0], [16, 1]])
        self.assertTrue(all(row["inodeChecksumValid"] for row in b["slotRows"]))
        w = r["journal"]["window"]
        self.assertTrue(w["contiguous"]); self.assertIn("clean unmount", w["tail"]); self.assertEqual(w["sSequence"], 18)
        m = r["bitmaps"]
        self.assertEqual((m["reusedBlocks"], m["notObservedFreedBlocks"], m["preDeletionClearBlocks"]), (0, 0, 0))
        self.assertEqual(m["perGroup"], [[1, 11, 108, 4, 2, 13, None, 108, 0], [2, 12, 52, 3, 1, 14, None, 52, 0]])
        self.assertEqual(r["map"]["dataBlocks"], 160)
        r2 = self.run_p(0, j=build(clean_txs(), sseq=17))                          # newest proven = s_sequence - 1 also explains the tail
        self.assertEqual(r2["journal"]["window"]["tail"], "newest proven tid = s_sequence - 1")

    def test_reuse_after_completion(self):
        txs = clean_txs(); txs[5] = (15, [(G1, bits(OTHER, (5000, 5001), (1050, 1051)))])
        r = self.run_p(4, j=build(txs))
        self.assertEqual(r["verdict"], "REUSE_OBSERVED"); self.assertEqual(r["bitmaps"]["reusedBlocks"], 1)
        self.assertEqual(r["bitmaps"]["reusedGroups"], [{"group": 1, "bitmapBlock": 11, "blocks": 1, "firstReuseTid": 15, "sample": [32768 + 1050]}])

    def test_reuse_inside_deletion_window_and_not_yet_freed_is_not_reuse(self):
        txs = clean_txs()[:4] + [
            (14, [(IT, table(**DELETING)), (G1, bits(OTHER, (1000, 1001))), (G2, bits(OTHER, E2, E3B))]),   # g1 block reallocated; g2 not yet freed
            (15, [(IT, table(**FREED)), (IBM, ibm(False)), (G2, bits(OTHER))]),                              # C
            (16, [(IT, table(**REUSED)), (IBM, ibm(True))])]
        r = self.run_p(4, j=build(txs))
        self.assertEqual(r["boundary"]["completionTid"], 15)
        self.assertEqual(r["bitmaps"]["reusedGroups"], [{"group": 1, "bitmapBlock": 11, "blocks": 1, "firstReuseTid": 14, "sample": [32768 + 1000]}])
        self.assertEqual(r["bitmaps"]["notObservedFreedBlocks"], 0)

    def test_blocks_never_seen_freed_or_freed_before_deletion_block(self):
        txs = clean_txs(); txs[4] = (14, [(IT, table(**FREED)), (IBM, ibm(False))])           # group 2's freeing never journaled
        r = self.run_p(5, j=build(txs))
        self.assertEqual(r["verdict"], "BLOCKED"); self.assertEqual(r["bitmaps"]["notObservedFreedBlocks"], 52)
        txs = clean_txs(); txs[2] = (12, [(IT, table()), (G1, bits(OTHER, (1001, 1100), E3A))])  # block 1000 clear after its leaf tid
        r = self.run_p(5, j=build(txs))
        self.assertEqual(r["bitmaps"]["preDeletionClearBlocks"], 1); self.assertEqual(r["bitmaps"]["preDeletionClearGroups"][0]["sample"], [32768 + 1000])

    def test_no_explicit_completion_blocks(self):
        txs = clean_txs(); txs[4] = (14, [(IT, table(**FREED)), (G2, bits(OTHER))])            # freed shape, no inode-bitmap image
        r = self.run_p(5, j=build(txs)); self.assertIsNone(r["boundary"]["completionTid"])
        txs = clean_txs(); txs[4] = (14, [(IT, table(**DELETING)), (G2, bits(OTHER))])         # slot reused without a freed image
        r = self.run_p(5, j=build(txs))
        self.assertIsNone(r["boundary"]["completionTid"]); self.assertEqual(r["boundary"]["slotReuseTid"], 16)
        txs = clean_txs(); txs[3] = (13, [(IT, table(**UNLINKED, bad_csum=True)), (G1, bits(OTHER))])
        r = self.run_p(5, j=build(txs)); self.assertTrue(any("checksum invalid" in x for x in r["blockers"]))
        r = self.run_p(5, expect_over={"lastLiveSequence": 11})                                 # disagrees with the prior finding
        self.assertTrue(any("differ from the prior finding" in x for x in r["blockers"]))

    def test_window_gaps_strays_and_tail(self):
        j = build(clean_txs()); j.b[j.commits[15] * BS + 0x10] ^= 1                              # tid 15 unproven
        r = self.run_p(5, j=j)
        self.assertEqual(r["journal"]["window"]["gaps"], [15]); self.assertIn(15, r["journal"]["window"]["failedTids"])
        r = self.run_p(5, j=build(clean_txs(), sseq=19))                                        # s_sequence - 3: not explained
        self.assertIsNone(r["journal"]["window"]["tail"])
        r = self.run_p(5, j=build(clean_txs(), head=5))                                         # s_head not after the newest commit
        self.assertIsNone(r["journal"]["window"]["tail"])
        j = build(clean_txs() + [(17, [(G1, bits(OTHER))])], sseq=18); j.b[j.commits[17] * BS + 0x10] ^= 1
        r = self.run_p(5, j=j)                                                                  # a header of tid s_sequence-1 exists
        self.assertIn(17, r["journal"]["window"]["strayHeaderTids"]); self.assertTrue(r["journal"]["unprovenReferencesTotal"] >= 1)


def swap(txs, tid, fs, content):
    """replace (or add) the image of fs block `fs` in transaction `tid` only"""
    return [(t[0], ([x for x in t[1] if x[0] != fs] + [(fs, content)]) if t[0] == tid else t[1], *t[2:]) for t in txs]


class Tree(Base):
    """r3 (review 1687 F1/F3, root 1698): the map is bound to the proven extent tree; ownership counts; window from the oldest leaf"""

    def test_tree_bound_ownership_observed_and_window_from_oldest_leaf(self):
        r = self.run_p(0)
        self.assertEqual(r["tree"], {"depth": 1, "indexBlocks": [], "leaves": 2, "boundLeaves": 2, "bound": True})
        self.assertEqual((r["journal"]["window"]["from"], r["journal"]["window"]["lastLiveTid"]), (10, 12))
        self.assertEqual(r["boundary"]["mode"], "separate-images")
        self.assertEqual((r["bitmaps"]["observedSetToClearBlocks"], r["bitmaps"]["clearWithoutObservedSetBlocks"]), (160, 0))
        self.assertIn("newestCommitSec", r["journal"]["window"])
        self.assertTrue(any("e2fsprogs" in x and "fuse2fs" in x and "discard" in x for x in r["limits"]))

    def test_depth2_index_tree_binds_through_a_second_verifier_phase(self):
        r = self.run_p(0, j=build(clean_txs(depth=2)), case_over={"metadataBlocks": 3})
        self.assertEqual(r["tree"], {"depth": 2, "indexBlocks": [{"block": IDX, "tid": 11}], "leaves": 2, "boundLeaves": 2, "bound": True})
        self.assertEqual(r["verdict"], "NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY")
        r = self.run_p(5, j=build(swap(clean_txs(depth=2), 11, IDX, enode(1, [(0, 70), (150, 73)]))), case_over={"metadataBlocks": 3})
        self.assertTrue(any("leaf pointers" in x for x in r["blockers"]))                         # index points elsewhere

    def test_tree_binding_negatives_block(self):
        cases = [
            (swap(clean_txs(), 10, 70, enode(0, [(0, 99, 33768, False), (100, 50, 65541, False)])), {}, "proven extents differ"),
            (swap(clean_txs(), 10, 70, enode(0, ext(EXTENTS[:2]), gen=NEW)), {}, "checksum invalid"),
            (swap(clean_txs(), 12, 70, LEAF70), {}, "newest proven image before the deletion is tid 12"),         # re-logged later
            (clean_txs()[:1] + [(11, [x for x in clean_txs()[1][1] if x[0] != 71])] + clean_txs()[2:], {},
             "no proven image before the deletion"),
            (clean_txs(), {"metadataBlocks": 3}, "differ from metadataBlocks"),
        ]
        for i, (txs, over, want) in enumerate(cases):
            with self.subTest(i=i):
                r = self.run_p(5, j=build(txs), case_over=over)
                self.assertTrue(any(want in x for x in r["blockers"]), r["blockers"])
                self.assertFalse(r["tree"]["bound"])

    def test_window_from_the_oldest_leaf_sees_a_gap_before_the_last_live_image(self):
        txs = [(10, clean_txs()[0][1] + [(71, LEAF71)])] + [(11, [x for x in clean_txs()[1][1] if x[0] != 71])] + clean_txs()[2:]
        j = build(txs); j.b[j.commits[11] * BS + 0x10] ^= 1                                       # tid 11 (< P = 12) unproven
        r = self.run_p(5, j=j, cov=coverage(picked=[PICKED[0], {**PICKED[1], "sequence": 10}]))
        self.assertEqual(r["journal"]["window"]["from"], 10); self.assertEqual(r["journal"]["window"]["gaps"], [11])
        self.assertTrue(r["tree"]["bound"])

    def test_unobserved_ownership_is_reported_not_invented(self):
        txs = clean_txs(); txs[0] = (10, [x for x in txs[0][1] if x[0] != G2]); txs[1] = (11, [x for x in txs[1][1] if x[0] != G2])
        r = self.run_p(0, j=build(txs))                                                            # group 2: no SET image before its free
        m = r["bitmaps"]
        self.assertEqual((m["observedSetToClearBlocks"], m["clearWithoutObservedSetBlocks"]), (108, 52))
        self.assertEqual(m["perGroup"][1][-2:], [0, 52]); self.assertIn("never counted as observed", m["ownershipNote"])

    def test_single_transaction_deletion_and_slot_reuse(self):
        one = lambda g2: clean_txs()[:3] + [(13, [(IT, table(**REUSED)), (IBM, ibm(True)), (G1, bits(OTHER)), (G2, g2)]),
                                            (14, [(G1, bits(OTHER, (5000, 5001)))])]
        r = self.run_p(0, j=build(one(bits(OTHER))))                                               # the real tid-17170 shape
        b = r["boundary"]
        self.assertEqual((b["mode"], b["lastLiveTid"], b["deletionStartTid"], b["completionTid"], b["slotReuseTid"]),
                         ("single-transaction", 12, 13, 13, 13))
        self.assertEqual(b["inodeBitmapRows"], [[13, 1]])
        r = self.run_p(5, j=build(one(bits(OTHER, E3B))))                                          # 2 old bits still set at that tid
        self.assertEqual((r["bitmaps"]["notObservedFreedBlocks"], r["bitmaps"]["reusedBlocks"]), (2, 2))
        r = self.run_p(5, j=build(one(bits(OTHER)) + [(15, [(IT, table())])]))                    # old generation seen again
        self.assertTrue(any("seen again" in x for x in r["blockers"]))

    def test_s0_orphan_dtime_and_tree_block_revokes(self):
        txs = clean_txs(); txs[3] = (13, [(IT, table(links=0, dtime=1700000400)), (G1, bits(OTHER))])
        r = self.run_p(5, j=build(txs))                                                            # S0 i_dtime is a time, not an orphan ino
        self.assertTrue(any("orphan i_dtime" in x for x in r["blockers"]))
        txs = clean_txs(); txs[4] = (*txs[4], [70])                                                # the truncate revokes its own leaf
        self.assertEqual(self.run_p(0, j=build(txs))["journal"]["unprovenReferencesTotal"], 0)
        txs = clean_txs(); txs[2] = (*txs[2], [70])                                                # a revoke of the leaf BEFORE the deletion
        r = self.run_p(5, j=build(txs)); self.assertGreaterEqual(r["journal"]["unprovenReferencesTotal"], 1)


class Bounds(Base):
    def test_batches_split_on_incomplete_listing_and_call_cap(self):
        base = self.run_p(0)
        V.ENTRY_BUDGET, P.INITIAL_BATCH = 5000, 4
        r = self.run_p(0)
        self.assertTrue(any(not c["listingComplete"] for c in r["runtime"]["verifierCalls"]))
        self.assertEqual((r["verdict"], r["boundary"], r["bitmaps"]), (base["verdict"], base["boundary"], base["bitmaps"]))
        P.MAX_VERIFY_CALLS = 1
        self.run_p(3)

    def test_input_pins_output_and_crc_refusals(self):
        args = self.paths()
        bad = list(args); bad[bad.index("--case") + 1] = self.file(json.dumps({"format": "x"}).encode())
        self.assertEqual(pmain(bad), 3)
        a2 = self.paths(case_over={"inputs": {"journalSha256": "0" * 64, "fsStatsSha256": "0" * 64, "coverageSha256": "0" * 64}})
        self.assertEqual(pmain(a2), 3)
        self.assertEqual(pmain(args), 0)
        out = args[args.index("--out") + 1]
        self.assertEqual(os.stat(out).st_mode & 0o777, 0o600)
        before = read_bytes(out)
        self.assertEqual(pmain(args), 3); self.assertEqual(read_bytes(out), before)            # never overwritten
        a3 = self.paths(); a3[a3.index("--out") + 1] += ".x"
        self.assertEqual(pmain([x for x in a3 if x != "--fixture"]), 3)                          # pure crc / fixture journal refused
        link = os.path.join(self.d, "link"); os.symlink(args[1], link)
        a4 = self.paths(); a4[1] = link; a4[a4.index("--out") + 1] += ".y"
        self.assertEqual(pmain(a4), 3)                                                            # nofollow


if __name__ == "__main__":
    unittest.main(verbosity=2)
