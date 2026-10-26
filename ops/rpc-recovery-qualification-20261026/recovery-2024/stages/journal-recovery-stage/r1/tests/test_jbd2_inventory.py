#!/usr/bin/env python3
"""journal-recovery-stage/r1: offline tests of jbd2_inventory.py (prepared by Claude 1624; NOT run by Claude). Standard library only.
SYNTHETIC journals built here with the parser's own documented layout (jbd2.h structs + its listed INFERRED placements): these tests
show that the parser is bounded, strict and consistent with that layout. They can NOT show that the layout matches a real kernel
journal; an independent decoder (debugfs logdump -O -f COPY) must agree on the real copy first. No device, image, USB or network."""
import json, os, signal, stat, struct, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.dont_write_bytecode = True
import jbd2_inventory as J  # noqa: E402

UUID = bytes(range(16))
OK_INC = J.INC_REVOKE | J.INC_64BIT | J.INC_CSUM_V3


def sb(maxlen, *, first=1, seq=100, start=0, incompat=OK_INC, compat=0, csum_type=J.CRC32C_CHKSUM, bs=J.BLOCK, btype=J.SB_V2, magic=J.MAGIC):
    b = bytearray(J.BLOCK)
    struct.pack_into(">III", b, 0, magic, btype, 0)
    struct.pack_into(">IIIII", b, 0x0C, bs, maxlen, first, seq, start)
    struct.pack_into(">III", b, 0x24, compat, incompat, 0)
    b[0x30:0x40] = UUID; b[0x50] = csum_type
    struct.pack_into(">I", b, 0xFC, 0x12345678)
    return bytes(b)


def desc(seq, tags, *, csum=0xDEADBEEF, tail=0xCAFEBABE):
    """tags: [(fs block, flags)]; a UUID follows every tag without SAME_UUID"""
    b = bytearray(J.BLOCK); struct.pack_into(">III", b, 0, J.MAGIC, J.DESCRIPTOR, seq); off = 12
    for blk, flags in tags:
        struct.pack_into(">IIII", b, off, blk & 0xFFFFFFFF, flags, blk >> 32, csum); off += 16
        if not flags & J.F_SAME_UUID:
            b[off:off + 16] = UUID; off += 16
    struct.pack_into(">I", b, J.BLOCK - 4, tail)
    return bytes(b)


def commit(seq, sec, nsec=0, *, csum=0x0BADF00D):
    b = bytearray(J.BLOCK); struct.pack_into(">III", b, 0, J.MAGIC, J.COMMIT, seq); b[0x0C] = 4; b[0x0D] = 4
    struct.pack_into(">I", b, 0x10, csum); struct.pack_into(">QI", b, 0x30, sec, nsec)
    return bytes(b)


def revoke(seq, blocks, *, count=None):
    b = bytearray(J.BLOCK); struct.pack_into(">III", b, 0, J.MAGIC, J.REVOKE, seq)
    struct.pack_into(">I", b, 12, 16 + 8 * len(blocks) if count is None else count)
    for i, x in enumerate(blocks):
        struct.pack_into(">Q", b, 16 + 8 * i, x)
    return bytes(b)


def data(fill):
    return bytes([fill]) * J.BLOCK


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="jbd2inv-"); self.n = 0

    def journal(self, blocks, maxlen=None, **sbkw):
        maxlen = maxlen or len(blocks) + 1
        body = [sb(maxlen, **sbkw)] + list(blocks) + [bytes(J.BLOCK)] * (maxlen - 1 - len(blocks))
        self.n += 1; p = os.path.join(self.d, f"j{self.n}.bin")
        with open(p, "wb") as f:
            f.write(b"".join(body))
        os.chmod(p, 0o600); return p

    def inv(self, path, targets=(), fixture=True):
        return J.inventory(path, targets=targets, fixture=fixture)

    def refused(self, needle, path, fixture=True):
        with self.assertRaises(J.Refused) as c:
            self.inv(path, fixture=fixture)
        self.assertIn(needle, str(c.exception)); return c.exception


class Inventory(Base):
    def test_transactions_targets_commit_times_revokes_and_the_unauthenticated_label(self):
        p = self.journal([desc(7, [(1000, 0), ((5 << 32) | 2000, J.F_SAME_UUID | J.F_LAST_TAG)]), data(1), data(2), commit(7, 1_761_500_000, 5),
                          revoke(8, [1000]), commit(8, 1_761_500_010)], maxlen=16)
        r = self.inv(p, targets=[1000, (5 << 32) | 2000, 3000])
        self.assertEqual(r["authentication"], "UNAUTHENTICATED CANDIDATES"); self.assertTrue(r["acceptance"].startswith("refused"))
        c = r["targets"]["candidates"]
        self.assertEqual([(x["sequence"], x["imageJournalBlock"], x["imageByteOffset"], x["committed"], x["commitSec"], x["txIntact"], x["checksum"])
                          for x in c["1000"]], [(7, 2, 2 * 4096, True, 1_761_500_000, True, "unchecked")])
        self.assertEqual([x["imageJournalBlock"] for x in c[str((5 << 32) | 2000)]], [3], "64-bit block number from t_blocknr_high")
        self.assertEqual(c["3000"], [])
        self.assertEqual(r["targets"]["revokedBy"]["1000"], [{"sequence": 8, "journalBlock": 5}])
        s = r["summary"]
        self.assertEqual((s["descriptors"], s["commits"], s["revokeBlocks"], s["transactions"], s["intactTransactions"], s["images"]), (1, 2, 1, 2, 2, 2))
        self.assertEqual((s["sequenceRange"], s["commitTimeRange"], r["clean"], s["staleOnly"]), ([7, 8], [1_761_500_000, 1_761_500_010], True, True))
        self.assertIn("INFERRED (not stated in jbd2.h)", r["layoutBasis"]); self.assertIn("NOT DERIVABLE LOCALLY", r["layoutBasis"])

    def test_a_descriptor_near_the_end_wraps_its_images_to_s_first(self):
        blocks = [data(0)] * 5 + [desc(9, [(11, 0), (12, J.F_SAME_UUID), (13, J.F_SAME_UUID | J.F_LAST_TAG)]), data(3)]
        p = self.journal([data(1), data(2), commit(9, 1_761_600_000)] + blocks[3:], maxlen=8)
        r = self.inv(p, targets=[11, 12, 13])
        pos = [r["targets"]["candidates"][str(b)][0]["imageJournalBlock"] for b in (11, 12, 13)]
        self.assertEqual(pos, [7, 1, 2]); self.assertTrue(r["targets"]["candidates"]["13"][0]["txIntact"])

    def test_escape_and_deleted_tag_flags_are_reported_not_interpreted(self):
        p = self.journal([desc(3, [(21, J.F_ESCAPE), (22, J.F_SAME_UUID | J.F_DELETED | J.F_LAST_TAG)]), bytes(J.BLOCK), data(9), commit(3, 1)])
        c = self.inv(p, targets=[21, 22])["targets"]["candidates"]
        self.assertEqual((c["21"][0]["escaped"], c["21"][0]["deletedFlag"], c["22"][0]["escaped"], c["22"][0]["deletedFlag"]), (True, False, False, True))

    def test_truncated_stale_and_uncommitted_transactions_are_marked_never_intact(self):
        # seq 4 claims 3 images, but its 2nd image position holds seq 5's commit header (overwritten by a later session): conflict
        p = self.journal([desc(4, [(31, 0), (32, J.F_SAME_UUID), (33, J.F_SAME_UUID | J.F_LAST_TAG)]), data(1), commit(5, 50), data(3),
                          desc(6, [(41, J.F_LAST_TAG)]), data(4)])
        r = self.inv(p, targets=[32, 41]); tx = {t["sequence"]: t for t in r["transactions"]}
        self.assertEqual((tx[4]["committed"], tx[4]["conflictingImages"], tx[4]["intact"]), (False, 1, False))
        self.assertTrue(r["targets"]["candidates"]["32"][0]["imageIsMetadataHeader"])
        self.assertEqual((tx[6]["committed"], tx[6]["intact"], tx[5]["committed"], tx[5]["tags"]), (False, False, True, 0))
        with open(p, "ab") as f:
            f.write(b"x")
        self.refused("multiple of 4096", p)
        self.refused("exactly 1073741824 bytes", self.journal([commit(1, 1)]), fixture=False)
        big = os.path.join(self.d, "big.bin")                     # the production size gate: a sparse 1 GiB copy with a valid superblock
        with open(big, "wb") as f:
            f.write(sb(J.MAX_BLOCKS)); f.truncate(J.JOURNAL_BYTES)
        os.chmod(big, 0o600)
        r = self.inv(big, fixture=False)
        self.assertEqual((r["journal"]["blocks"], r["summary"]["metadataBlocks"], r["journal"]["fixtureMode"]), (J.MAX_BLOCKS, 0, False))

    def test_overflowing_or_unknown_descriptors_and_bad_revokes_are_undecodable_and_map_nothing(self):
        full = [(100 + i, J.F_SAME_UUID if i else 0) for i in range(254)]           # 12+32+253*16 = 4092: fills up to the tail, no LAST_TAG
        p = self.journal([desc(1, full), commit(1, 1), desc(2, [(7, 0x10 | J.F_LAST_TAG)]), commit(2, 2),
                          desc(3, [(8, J.F_SAME_UUID | J.F_LAST_TAG)]), revoke(4, [], count=5000), revoke(5, [1], count=17)])
        r = self.inv(p, targets=[100, 7, 8])
        whys = sorted(u["why"] for u in r["undecodable"])
        self.assertEqual(len(whys), 5, whys)
        for needle in ("overflow", "unknown tag flags", "first tag claims SAME_UUID", "r_count 5000", "r_count 17"):
            self.assertTrue([w for w in whys if needle in w], (needle, whys))
        self.assertEqual(r["summary"]["images"], 0); self.assertTrue(all(v == [] for v in r["targets"]["candidates"].values()))

    def test_a_bad_checksum_changes_nothing_but_the_raw_field_everything_stays_unchecked(self):
        mk = lambda cs, tail, cc: self.journal([desc(7, [(1000, J.F_LAST_TAG)], csum=cs, tail=tail), data(1), commit(7, 99, csum=cc)])
        a, b = self.inv(mk(0xDEADBEEF, 1, 2), targets=[1000]), self.inv(mk(0, 0xFFFFFFFF, 0), targets=[1000])
        ca, cb = a["targets"]["candidates"]["1000"][0], b["targets"]["candidates"]["1000"][0]
        self.assertEqual(ca, cb); self.assertEqual((ca["checksum"], a["authentication"], b["authentication"]), ("unchecked",) + ("UNAUTHENTICATED CANDIDATES",) * 2)

    def test_unsupported_formats_are_refused(self):
        for kw, needle in (({"bs": 1024}, "blocksize"), ({"incompat": J.INC_REVOKE | J.INC_64BIT | J.INC_CSUM_V2}, "incompat"),
                           ({"incompat": OK_INC | J.INC_ASYNC}, "incompat"), ({"incompat": OK_INC | J.INC_FAST_COMMIT}, "incompat"),
                           ({"incompat": J.INC_REVOKE | J.INC_CSUM_V3}, "incompat"), ({"compat": J.COMPAT_CHECKSUM}, "compat"),
                           ({"btype": J.SB_V1}, "superblock type"), ({"magic": 0}, "magic"), ({"csum_type": 1}, "checksum type"),
                           ({"first": 0}, "first/start"), ({"start": 99}, "first/start")):
            self.refused(needle, self.journal([commit(1, 1)], maxlen=8, **kw))
        p = self.journal([commit(1, 1)], maxlen=8)
        with open(p, "r+b") as f:
            f.seek(0x10); f.write(struct.pack(">I", 9))           # maxlen != file blocks
        self.refused("maxlen", p)


class Safety(Base):
    def test_inputs_are_regular_no_follow_non_blocking_and_outputs_never_overwritten(self):
        p = self.journal([desc(1, [(5, J.F_LAST_TAG)]), data(1), commit(1, 1)])
        link = os.path.join(self.d, "link.bin"); os.symlink(p, link)
        self.refused("symlink", link)
        fifo = os.path.join(self.d, "fifo.bin"); os.mkfifo(fifo)

        def alarm(*_):
            raise AssertionError("opening a FIFO blocked (O_NONBLOCK missing)")
        old = signal.signal(signal.SIGALRM, alarm); signal.alarm(10)
        try:
            self.refused("regular file", fifo)
        finally:
            signal.alarm(0); signal.signal(signal.SIGALRM, old)
        os.chmod(p, 0o666); self.refused("world-writable", p); os.chmod(p, 0o600)
        self.refused("absolute", "rel/j.bin")
        out = os.path.join(self.d, "inv.json"); tg = os.path.join(self.d, "t.json")
        with open(tg, "w") as f:
            json.dump({"blocks": [5]}, f)
        os.chmod(tg, 0o600)
        self.assertEqual(J.main(["--journal", p, "--out", out, "--targets", tg, "--fixture"]), 0)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        with open(out) as f:
            r = json.load(f)
        self.assertEqual(r["targets"]["candidates"]["5"][0]["imageJournalBlock"], 2)
        before = os.stat(out).st_mtime_ns
        self.assertEqual(J.main(["--journal", p, "--out", out, "--fixture"]), 3); self.assertEqual(os.stat(out).st_mtime_ns, before)
        self.assertEqual(J.main(["--journal", p, "--out", os.path.join(self.d, "inv2.json")]), 3, "a fixture without --fixture is refused")
        for bad in ({"blocks": [-1]}, {"blocks": [True]}, {"blocks": "5"}, {"blocks": [5], "x": 1}, {"blocks": list(range(J.MAX_TARGETS + 1))}):
            with open(tg, "w") as f:
                json.dump(bad, f)
            with self.assertRaises(J.Refused):
                J.load_targets(tg)
        self.assertEqual(sorted(os.listdir(self.d)), sorted(["fifo.bin", "inv.json", "j1.bin", "link.bin", "t.json"]), "nothing else written")

    def test_output_is_bounded_truncation_is_explicit_and_too_large_refuses(self):
        blocks = []
        for s in range(1, 41):
            blocks += [desc(s, [(s, J.F_LAST_TAG)]), data(s), commit(s, s)]
        r = self.inv(self.journal(blocks))
        old = J.OUT_MAX
        try:
            J.OUT_MAX = len(json.dumps(r, sort_keys=True)) - 1
            t = json.loads(J.bounded_json(r))
            self.assertTrue(t["truncated"]); self.assertEqual(t["truncated"]["transactionsTotal"], 40)
            self.assertLess(t["truncated"]["transactionsListed"], 40)
            J.OUT_MAX = 100
            with self.assertRaises(J.Refused):
                J.bounded_json(r)
        finally:
            J.OUT_MAX = old


if __name__ == "__main__":
    unittest.main()
