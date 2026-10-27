#!/usr/bin/env python3
"""multipart-validation-view-stage/r1 tests (prepared by Claude 1751; NOT run by Claude). Tiny fixture parts in TWO directories,
the pinned qemu-io / qemu-img / qemu-nbd 11.1.2 (checked by jobs/tests.sh). Unprivileged, not in a user namespace (0444 parts must
really be unwritable). No network; unix socket in a private temp dir; every child is ended and reaped."""
import contextlib, hashlib, io, json, os, re, shutil, signal, subprocess, sys, tempfile, time, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import view_descriptor as V  # noqa: E402

TMP = os.environ.get("MVV_TEST_TMP", "")         # stage-specific; TMPDIR/HOME and other defaults are left alone
if not (os.path.isabs(TMP) and os.path.isdir(TMP)):
    raise SystemExit("MVV_TEST_TMP must name an existing absolute directory")
tempfile.tempdir = TMP

QIO, QIMG, QNBD = "/usr/bin/qemu-io", "/usr/bin/qemu-img", "/usr/sbin/qemu-nbd"
K = 1024
SIZES = [64 * K, 64 * K, 64 * K, 3 * 512]          # the final part is short: a whole number of 512-byte sectors
BOUNDS = [64 * K, 128 * K, 192 * K]


def pattern(i, n):
    out, k = b"", 0
    while len(out) < n:
        out += hashlib.sha256(f"part{i}:{k}".encode()).digest(); k += 1
    data = out[:n]
    if i == 2:                                      # a qcow2 header at an extent start: must be served RAW, never probed
        data = b"QFI\xfb\x00\x00\x00\x03" + bytes(504) + data[512:]
    return data


def vm(argv):
    """view_descriptor.main with its JSON stdout captured (the job requires an empty test stdout); refusals go to stderr"""
    with contextlib.redirect_stdout(io.StringIO()):
        return V.main(argv)


def run(cmd, timeout=60):
    return subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)


def dump(out, off, n):
    """the bytes of a qemu-io `read -v` hexdump, offsets checked"""
    got = bytearray()
    for line in out.splitlines():
        m = re.match(r"^([0-9a-f]{8,}):  ((?:[0-9a-f]{2} ){1,16})", line)
        if m:
            assert int(m.group(1), 16) == off + len(got), line
            got += bytes.fromhex(m.group(2).replace(" ", ""))
    assert len(got) == n, (len(got), n)
    return bytes(got)


class View(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="mvv-", dir=TMP)
        self.dirs = [os.path.join(self.t, "rootfs"), os.path.join(self.t, "vmfs")]
        for d in self.dirs:
            os.mkdir(d, 0o700)
        self.parts, self.expected = [], b""
        for i, n in enumerate(SIZES):
            data = pattern(i, n); self.expected += data
            p = os.path.join(self.dirs[0 if i < 2 else 1], f"part-{i:04d}.bin")
            with open(p, "wb") as f:
                f.write(data)
            os.chmod(p, 0o444)
            self.parts.append({"index": i, "path": p, "size": n, "sha256": hashlib.sha256(data).hexdigest()})
        self.children = []

    def tearDown(self):
        for c in self.children:
            if c.poll() is None:
                os.killpg(c.pid, signal.SIGKILL)
            c.wait(timeout=30)
        shutil.rmtree(self.t)                        # every dir is ours and 0700; read-only files in it are removable

    def spec(self, parts=None, **over):
        d = {"format": V.FMT_PARTS, "kind": "fixture", "logicalSize": sum(SIZES), "parts": parts if parts is not None else self.parts}
        d.update(over)
        f = tempfile.mktemp(prefix="parts-", suffix=".json", dir=self.t)
        with open(f, "w") as h:
            json.dump(d, h)
        return f

    def build(self, spec=None, name="view"):
        out = os.path.join(self.t, name)
        return vm(["build", "--parts", spec or self.spec(), "--out-dir", out]), out

    def opts(self, out):
        with open(os.path.join(out, V.RECEIPT)) as f:
            return json.load(f)["imageOpts"]

    def qread(self, out, off, n):
        r = run([QIO, "-r", "--image-opts", self.opts(out), "-c", f"read -v {off} {n}"])
        self.assertEqual(r.returncode, 0, r.stderr); self.assertIn(f"read {n}/{n} bytes at offset {off}", r.stdout)
        return dump(r.stdout, off, n)

    def test_1_reads_across_every_flat_boundary_equal_the_known_bytes(self):
        rc, out = self.build(); self.assertEqual(rc, 0)
        with open(os.path.join(out, V.DESC)) as handle:
            text = handle.read()
        self.assertEqual([l for l in text.splitlines() if l.startswith("RW ")],
                         [f'RW {p["size"] // 512} FLAT "{p["path"]}" 0' for p in self.parts])
        self.assertNotIn("parentFileNameHint", text); self.assertIn('createType="monolithicFlat"', text)
        self.assertEqual(oct(os.stat(out).st_mode & 0o777), "0o700"); self.assertEqual(sorted(os.listdir(out)), sorted([V.DESC, V.RECEIPT]))
        info = json.loads(run([QIMG, "info", "--output=json", "--image-opts", self.opts(out)]).stdout)
        self.assertEqual(info["virtual-size"], sum(SIZES))
        for b in BOUNDS:                                   # each single read straddles one extent boundary
            self.assertEqual(self.qread(out, b - 1024, 2048), self.expected[b - 1024:b + 1024], b)
        self.assertEqual(self.qread(out, 64 * K - 512, 128 * K + 1024), self.expected[64 * K - 512:192 * K + 512])   # 2 boundaries
        self.assertEqual(self.qread(out, sum(SIZES) - 512, 512), self.expected[-512:])                                 # short tail
        self.assertEqual(self.qread(out, 0, sum(SIZES)), self.expected)  # every logical byte, independent of allocation status
        raw = os.path.join(self.t, "expected.raw")
        with open(raw, "wb") as f:
            f.write(self.expected)
        r = run([QIMG, "compare", "--image-opts", self.opts(out), f"driver=raw,file.driver=file,file.filename={raw}"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(vm(["recheck", "--view-dir", out, "--hash"]), 0)
        self.assertEqual([p["sha256"] for p in self.parts], [hashlib.sha256(pattern(i, n)).hexdigest() for i, n in enumerate(SIZES)])

    def test_2_a_part_that_looks_like_qcow2_is_served_raw(self):
        rc, out = self.build(); self.assertEqual(rc, 0)
        self.assertEqual(self.qread(out, 128 * K, 512)[:8], b"QFI\xfb\x00\x00\x00\x03")
        # the extents.N.driver options are really consumed: an option for a non-existent extent is refused loudly
        self.assertNotEqual(run([QIO, "-r", "--image-opts", self.opts(out) + ",extents.9.driver=file", "-c", "read 0 512"]).returncode, 0)

    def test_3_corrupt_missing_short_or_unsafe_parts_are_refused_and_nothing_is_written(self):
        P = lambda **kw: [dict(p, **kw) if p["index"] == 1 else dict(p) for p in self.parts]
        bad = os.path.join(self.dirs[1], "corrupt.bin")
        with open(bad, "wb") as f:
            f.write(bytes([pattern(1, SIZES[1])[0] ^ 1]) + pattern(1, SIZES[1])[1:])
        os.chmod(bad, 0o444)
        short = os.path.join(self.dirs[1], "short.bin")
        with open(short, "wb") as f:
            f.write(b"x" * 1500)
        os.chmod(short, 0o444)
        rw = os.path.join(self.dirs[1], "rw.bin"); shutil.copy(self.parts[1]["path"], rw); os.chmod(rw, 0o644)
        link = os.path.join(self.t, "link"); os.symlink(self.dirs[0], link)
        hard = os.path.join(self.dirs[0], "hardlink.bin"); os.link(self.parts[0]["path"], hard)
        hint = os.path.join(self.t, "parentFileNameHint"); os.mkdir(hint)
        cases = {
            "missing": self.spec(P(path=os.path.join(self.dirs[0], "absent.bin"))),
            "corrupt": self.spec(P(path=bad)),
            "size": self.spec(P(size=SIZES[1] - 512), logicalSize=sum(SIZES) - 512),
            "not512": self.spec([dict(p) for p in self.parts[:3]] + [dict(self.parts[3], path=short, size=1500)], logicalSize=sum(SIZES[:3]) + 1500),
            "logical": self.spec(logicalSize=sum(SIZES) + 512),
            "gap": self.spec([p for p in self.parts if p["index"] != 1]),
            "relative": self.spec(P(path="rootfs/part-0001.bin")),
            "comma": self.spec(P(path=self.parts[1]["path"] + ",x")),
            "quote": self.spec(P(path=self.parts[1]["path"] + '"')),
            "hint": self.spec(P(path=os.path.join(hint, "p.bin"))),
            "long": self.spec(P(path="/" + "a" * 600)),
            "symlink": self.spec(P(path=os.path.join(link, "part-0001.bin"))),
            "writable": self.spec(P(path=rw)),
            "duplicate": self.spec(P(path=self.parts[0]["path"], sha256=self.parts[0]["sha256"])),
            "hardlink": self.spec(P(path=hard, sha256=self.parts[0]["sha256"])),    # same inode as part 0
            "production": self.spec(kind="production"),
        }
        r1 = os.path.join(self.t, "r1.json")
        with open(r1, "w") as f:
            json.dump({"format": "recovery-multipart-manifest/v1", "kind": "fixture", "parts": []}, f)
        cases["r1-manifest"] = r1
        for name, spec in cases.items():
            rc, out = self.build(spec, name="out-" + name)
            self.assertEqual(rc, 3, name); self.assertFalse(os.path.lexists(out), name)
        rc, out = self.build(); self.assertEqual(rc, 0)
        self.assertEqual(self.build(name="view")[0], 3)                        # the out dir must be new

    def test_4_truncation_reads_zeros_in_qemu_so_recheck_refuses(self):
        rc, out = self.build(); self.assertEqual(rc, 0)
        p = self.parts[1]["path"]; os.chmod(p, 0o644)
        os.truncate(p, SIZES[1] - 1024); os.chmod(p, 0o444)
        # QEMU does not notice: the missing 1 KiB of part 1 reads as zeros (the descriptor proves nothing)
        self.assertEqual(self.qread(out, 128 * K - 1024, 1024), bytes(1024))
        self.assertEqual(vm(["recheck", "--view-dir", out]), 3)
        self.assertEqual(vm(["opts", "--view-dir", out]), 3)

    def start_nbd(self, out):
        name = f"s{len(self.children)}.sock"         # a NEW socket per server: it exists only after the image is open
        sock = os.path.join(self.t, name)             # bound as /proc/self/cwd/NAME in cwd = self.t (sun_path is 108 bytes)
        c = subprocess.Popen([QNBD, "--read-only", "--shared=1", f"--socket=/proc/self/cwd/{name}", "--image-opts", self.opts(out)],
                             cwd=self.t, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.children.append(c)
        end = time.monotonic() + 30
        while not os.path.exists(sock):
            self.assertIsNone(c.poll(), "qemu-nbd exited before listening"); self.assertLess(time.monotonic(), end); time.sleep(0.05)
        return c

    def test_5_the_running_server_must_hold_exactly_the_verified_inodes(self):
        rc, out = self.build(); self.assertEqual(rc, 0)
        c = self.start_nbd(out)
        self.assertEqual(vm(["check-held", "--view-dir", out, "--pid", str(c.pid)]), 0)
        os.killpg(c.pid, signal.SIGTERM); c.wait(timeout=30)
        # a server of ANOTHER view (byte-identical copies, other inodes) is not this view's server: the fd check alone refuses
        cdir = os.path.join(self.t, "copyfs"); os.mkdir(cdir, 0o700); copies = []
        for q in self.parts:
            n = os.path.join(cdir, os.path.basename(q["path"])); shutil.copy(q["path"], n); os.chmod(n, 0o444); copies.append(dict(q, path=n))
        rc, other = self.build(self.spec(copies), name="other"); self.assertEqual(rc, 0)
        c = self.start_nbd(other)
        self.assertEqual(vm(["recheck", "--view-dir", out]), 0)
        self.assertEqual(vm(["check-held", "--view-dir", out, "--pid", str(c.pid)]), 3)
        os.killpg(c.pid, signal.SIGTERM); c.wait(timeout=30)
        # swap part 2 for a byte-identical NEW inode after the build: same bytes, but not the verified file
        p = self.parts[2]["path"]; tmp = p + ".new"
        shutil.copy(p, tmp); os.chmod(tmp, 0o444); os.replace(tmp, p)
        c = self.start_nbd(out)
        self.assertEqual(vm(["check-held", "--view-dir", out, "--pid", str(c.pid)]), 3)
        self.assertEqual(vm(["recheck", "--view-dir", out]), 3)


if __name__ == "__main__":
    unittest.main()
