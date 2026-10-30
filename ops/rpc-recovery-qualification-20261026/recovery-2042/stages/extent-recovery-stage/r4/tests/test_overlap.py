#!/usr/bin/env python3
"""extent-recovery-stage/r1 offline tests (PREPARED; NOT run by Claude). Unprivileged: a tiny ext4 IMAGE FILE made by mke2fs, a file
written into it by `debugfs -w` (on the image only), its real block list from `debugfs blocks`, and independent free/used checks
from `debugfs testb`. No device, no mount, no root, no network. OVERLAP_BIN = the compiled tool (jobs/tests.sh builds it)."""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(HERE)
sys.path.insert(0, f"{STAGE}/src")
sys.dont_write_bytecode = True
import overlap as O  # noqa: E402

BIN = os.environ.get("OVERLAP_BIN", "")
MKE2FS, DEBUGFS = "/usr/sbin/mke2fs", "/usr/sbin/debugfs"
NBLOCKS = 4096                                                  # 16 MiB of 4 KiB blocks


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


TESTB = re.compile(r"^Block (\d+) (marked in use|not in use)$")


def debugfs_used(img, blocks, tmpdir):
    """r3 oracle (root 1647: `testb START COUNT` reports an AGGREGATE, not one line per block): ONE batch `debugfs -f` run with ONE
    `testb BLOCK` per requested block; every block must be answered EXACTLY once, as "marked in use" or "not in use"; any other
    non-echo output line fails. -> the set of blocks marked in use (an independent view of the same on-disk bitmap)."""
    blocks = list(blocks)
    cmd = os.path.join(tmpdir, f"testb-{len(os.listdir(tmpdir))}.cmds")
    with open(cmd, "w") as f:
        f.write("".join(f"testb {b}\n" for b in blocks if b != 0))
    p = subprocess.run([DEBUGFS, "-f", cmd, img], capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stderr[-2000:]
    seen, used = {}, set()
    if 0 in blocks:
        # debugfs rejects block zero even on this 4 KiB filesystem whose bitmap starts at zero.
        # Read its group-zero bitmap bit directly; do not omit it or assume its allocation.
        stats = subprocess.run([DEBUGFS, "-R", "stats", img], check=True, capture_output=True, text=True).stdout
        match = re.search(r"Group\s+0: block bitmap at (\d+)", stats)
        assert match, "group-zero bitmap location unavailable"
        with open(img, "rb") as raw:
            raw.seek(int(match.group(1)) * 4096)
            value = raw.read(1)
        assert len(value) == 1
        seen[0] = "marked in use" if value[0] & 1 else "not in use"
        if value[0] & 1:
            used.add(0)
    for line in p.stdout.splitlines():
        if not line.strip() or line.startswith("debugfs:"):            # the batch echo ("debugfs: testb N")
            continue
        m = TESTB.match(line)
        assert m, f"unexpected debugfs output line: {line!r}"
        b = int(m.group(1))
        assert b not in seen, f"block {b} answered twice"
        seen[b] = m.group(2)
        if m.group(2) == "marked in use":
            used.add(b)
    assert sorted(seen) == sorted(blocks), f"debugfs answered {len(seen)} of {len(blocks)} blocks"
    return used


class Fixture:                                                  # r3: a mixin, NOT a TestCase (no setUpClass on a class with 0 tests)
    @classmethod
    def setUpClass(cls):
        assert BIN and os.access(BIN, os.X_OK), "OVERLAP_BIN must name the compiled tool"
        cls.tmp = tempfile.mkdtemp(prefix="eov", dir=os.environ.get("TEST_TMP"))
        cls.img = f"{cls.tmp}/fx.img"
        subprocess.run([MKE2FS, "-q", "-F", "-t", "ext4", "-b", "4096", "-L", "fx", cls.img, str(NBLOCKS)], check=True, capture_output=True)
        src = f"{cls.tmp}/payload"
        with open(src, "wb") as f:
            f.write(os.urandom(300 * 1024))                    # 75 blocks of real data
        subprocess.run([DEBUGFS, "-w", "-R", f"write {src} f1", cls.img], check=True, capture_output=True)
        out = subprocess.run([DEBUGFS, "-R", "blocks /f1", cls.img], check=True, capture_output=True, text=True).stdout.split()
        cls.fblocks = sorted(int(x) for x in out)
        assert len(cls.fblocks) == 75, cls.fblocks
        runs, start = [], cls.fblocks[0]                       # the file's real contiguous runs
        for a, b in zip(cls.fblocks, cls.fblocks[1:] + [None]):
            if b != a + 1:
                runs.append((start, a - start + 1)); start = b
        cls.runs = runs
        cls.used = debugfs_used(cls.img, range(NBLOCKS), cls.tmp)          # every block answered exactly once
        assert set(cls.fblocks) <= cls.used
        cls.free_start = next(b for b in range(NBLOCKS - 150) if not cls.used & set(range(b, b + 150)))   # a debugfs-verified free window
        os.chmod(cls.img, 0o444)                                # the tool must work on a read-only image
        cls.img_sha, cls.img_mtime = sha(cls.img), os.stat(cls.img).st_mtime_ns

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    def tearDown(self):                                         # every test: the image is byte-identical and untouched
        self.assertEqual((sha(self.img), os.stat(self.img).st_mtime_ns), (self.img_sha, self.img_mtime))

    def tool(self, lines, *opts, dev=None):
        p = subprocess.run([BIN, *opts, dev or self.img], input="".join(lines).encode(), capture_output=True, timeout=120)
        out = p.stdout.decode()
        summary = None
        if out.splitlines() and out.splitlines()[-1].startswith("summary "):
            summary = {k: int(v) for k, v in (x.split("=") for x in out.splitlines()[-1].split()[1:])}
        ov = [tuple(map(int, l.split()[1:])) for l in out.splitlines() if l.startswith("overlap ")]
        return p.returncode, summary, ov, p.stderr.decode()

    def testb(self, start, count):                              # r3: per-block batch oracle, sorted list of blocks in use
        return sorted(debugfs_used(self.img, range(start, start + count), self.tmp))

    def header(self):
        p = subprocess.run([BIN, self.img], input=b"", capture_output=True)
        h = [l for l in p.stdout.decode().splitlines() if l.startswith("# ")][0]
        return {k: v for k, v in (x.split("=", 1) for x in h.split()[4:])}   # after "# ext4-extent-overlap r1 read-only"


class Overlap(Fixture, unittest.TestCase):
    def test_an_allocated_file_run_is_reported_exactly_and_crosschecked(self):
        s, n = self.runs[0]
        rc, sm, ov, err = self.tool([f"0 100 {s} {n} 0\n"], "--crosscheck")
        self.assertEqual(rc, 0, err)
        self.assertEqual(ov, [(0, 100, s, n, 0)])
        self.assertEqual((sm["overlapBlocks"], sm["overlapRanges"], sm["crosscheckMismatches"], sm["truncated"]), (n, 1, 0, 0))

    def test_a_partial_extent_reports_only_the_allocated_subrange(self):
        s, n = self.runs[-1]
        tail = [b for b in range(s + n, s + n + 40) if b < NBLOCKS]
        used_after = self.testb(s + n, len(tail))               # what debugfs independently says about the blocks after the file
        rc, sm, ov, err = self.tool([f"7 0 {s - 0} {n + len(tail)} 1\n"], "--crosscheck")
        self.assertEqual(rc, 0, err); self.assertEqual(sm["crosscheckMismatches"], 0)
        got = {b for (_, _, p, c, _) in ov for b in range(p, p + c)}
        self.assertEqual(got, set(range(s, s + n)) | set(used_after))
        self.assertEqual(sm["overlapUnwrittenBlocks"], sm["overlapBlocks"])  # the unwritten flag is carried, not interpreted

    def test_a_free_region_reports_no_overlap(self):
        start = self.free_start
        self.assertEqual(self.testb(start, 150), [], "fixture: the region must be free per debugfs")
        rc, sm, ov, err = self.tool([f"0 0 {start} 150 0\n"], "--crosscheck")
        self.assertEqual((rc, ov, sm["overlapBlocks"], sm["crosscheckMismatches"]), (0, [], 0, 0))

    def test_the_whole_filesystem_overlap_equals_the_allocated_count_no_false_negative(self):
        h = self.header()
        rc, sm, ov, err = self.tool([f"0 0 0 {NBLOCKS} 0\n"], "--crosscheck")
        self.assertEqual(rc, 0, err)
        self.assertEqual(sm["overlapBlocks"], int(h["blocksCount"]) - int(h["freeBlocks"]))   # bitmap == superblock accounting
        self.assertEqual({b for (_, _, p, c, _) in ov for b in range(p, p + c)}, self.used)     # == debugfs's independent view
        self.assertEqual(sm["crosscheckMismatches"], 0)
        self.assertTrue(set(self.fblocks) <= {b for (_, _, p, c, _) in ov for b in range(p, p + c)})


class Validation(Fixture, unittest.TestCase):
    def test_out_of_range_zero_and_oversize_extents_are_invalid_not_searched(self):
        lines = [f"0 0 {NBLOCKS - 10} 11 0\n", "1 0 100 0 0\n", "2 0 100 32769 0\n", f"3 0 {NBLOCKS} 1 0\n", f"4 0 {2**63} 1 0\n",
                 f"5 0 {self.runs[0][0]} 1 0\n"]
        rc, sm, ov, err = self.tool(lines)
        self.assertEqual(rc, 3, err)
        self.assertEqual((sm["extents"], sm["invalid"], sm["overlapBlocks"]), (6, 5, 1))     # only the valid one is searched

    def test_malformed_input_and_bad_paths_are_refused(self):
        for lines in (["0 0 100 1\n"], ["0 0 -1 1 0\n"], ["0 0 100 1 2\n"], ["x 0 100 1 0\n"], ["0 0 100 1 0"], ["0 0 100 1 0 9\n"],
                      ["0 0 " + "9" * 300 + " 1 0\n"]):
            rc, sm, ov, err = self.tool(lines)
            self.assertEqual((rc, sm), (1, None), lines); self.assertIn("REFUSED", err)
        os.symlink(self.img, f"{self.tmp}/link.img")
        self.assertIn("REFUSED", self.tool(["0 0 100 1 0\n"], dev=f"{self.tmp}/link.img")[3])
        self.assertIn("REFUSED", self.tool(["0 0 100 1 0\n"], dev=self.tmp)[3])
        self.assertIn("REFUSED", self.tool(["0 0 100 1 0\n"], "--max-output-bytes", str((16 << 20) + 1))[3])

    def test_output_is_capped_while_counting_stays_complete(self):
        lines = [f"{i} 0 {b} 1 0\n" for i, b in enumerate(self.fblocks)]                  # 75 one-block overlaps
        rc, full, ov_full, _ = self.tool(lines)
        rc2, capped, ov_capped, _ = self.tool(lines, "--max-output-bytes", "400")
        self.assertEqual((rc, rc2), (0, 0))
        self.assertEqual((full["truncated"], capped["truncated"]), (0, 1))
        self.assertEqual(capped["overlapRanges"], full["overlapRanges"]); self.assertEqual(capped["overlapBlocks"], 75)
        self.assertLess(len(ov_capped), len(ov_full))


class Refusals(unittest.TestCase):
    def test_a_journal_needing_recovery_is_refused_no_stale_bitmap(self):
        tmp = tempfile.mkdtemp(prefix="eovr", dir=os.environ.get("TEST_TMP")); self.addCleanup(shutil.rmtree, tmp, True)
        img = f"{tmp}/nr.img"
        subprocess.run([MKE2FS, "-q", "-F", "-t", "ext4", "-b", "4096", img, "2048"], check=True, capture_output=True)
        subprocess.run([DEBUGFS, "-w", "-R", "feature needs_recovery", img], check=True, capture_output=True)
        p = subprocess.run([BIN, img], input=b"0 0 0 1 0\n", capture_output=True)
        self.assertEqual(p.returncode, 1); self.assertIn(b"needs recovery", p.stderr); self.assertNotIn(b"summary", p.stdout)


class Wrapper(Fixture, unittest.TestCase):
    def cand(self, extents, **over):
        doc = {"authentication": "unchecked candidates only", "extents": extents}; doc.update(over)
        p = f"{self.tmp}/cand-{len(os.listdir(self.tmp))}.json"
        with open(p, "w") as f:
            json.dump(doc, f)
        return p

    def test_end_to_end_report_is_bounded_and_carries_the_interpretation(self):
        s, n = self.runs[0]
        c = self.cand([{"logical": 0, "blocks": n, "physical": s, "unwritten": False}, {"logical": n, "blocks": 10, "physical": self.free_start, "unwritten": False}])
        out = f"{self.tmp}/report.json"
        self.assertEqual(O.main(["overlap.py", "--tool", BIN, "--candidate", c, "--device", self.img, "--crosscheck", "--out", out]), 0)
        r = json.load(open(out))
        self.assertEqual((r["summary"]["overlapBlocks"], r["summary"]["extents"], r["complete"]), (n, 2, True))
        self.assertEqual(r["overlaps"], [{"index": 0, "logical": 0, "physical": s, "count": n, "unwritten": 0}])
        self.assertEqual(r["candidate"]["authentication"], "unchecked candidates only")
        self.assertTrue(any("NOT proof of overwritten" in x for x in r["interpretation"]))
        self.assertEqual(O.main(["overlap.py", "--tool", BIN, "--candidate", c, "--device", self.img, "--out", out]), 1)   # never overwrite

    def test_malformed_candidates_are_refused_before_the_tool_runs(self):
        good = {"logical": 0, "blocks": 1, "physical": 100, "unwritten": False}
        for bad in ([{**good, "blocks": True}], [{**good, "physical": -1}], [{**good, "extra": 1}], [{k: v for k, v in good.items() if k != "unwritten"}],
                    [{**good, "unwritten": 0}], []):
            self.assertEqual(O.main(["overlap.py", "--tool", BIN, "--candidate", self.cand(bad), "--device", self.img]), 1, bad)


if __name__ == "__main__":
    unittest.main()
