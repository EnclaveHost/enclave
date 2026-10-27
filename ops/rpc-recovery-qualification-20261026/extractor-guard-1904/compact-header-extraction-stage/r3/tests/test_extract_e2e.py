#!/usr/bin/env python3
"""compact-header-extraction-stage/r3 FIXTURE end-to-end tests (PREPARED by Claude 1881/1892; NOT run by Claude). Real r9 sessions
(qemu-nbd --read-only, nbdfuse -r, pinned fuse2fs ro,norecovery,fakeroot) over the r9 fixture parent-clean.qcow2 and the r2 METADATA
fixture meta.qcow2 (both built fresh in $CHE_WORK, a /vm E2E workspace); never the backup. The pinned floors and the 1024 MiB lane
apply (extract.py checks them in every run). Env: CHE_WORK, CHE_FUSE2FS, CHE_FUSE2FS_SHA256. Expected: "Ran 8 tests", OK.
r2 (1885 B3): tests 7-8 carry EVERY production metadata field (mode/uid/gid/nanosecond mtime_ns/nlink/size/sha256) through the real
fakeroot view; a mismatch must REFUSE (production checks are never weakened)."""
import hashlib, importlib.util, json, os, shutil, signal, subprocess, sys, time, unittest
from pathlib import Path

ST = Path(__file__).resolve().parent.parent
EXTRACT = str(ST / "extract.py")
R9 = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9"
WORK = os.environ["CHE_WORK"]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("make_fixture", R9 + "/fixture/make_fixture.py")
MF = importlib.util.module_from_spec(spec); spec.loader.exec_module(MF)
spec = importlib.util.spec_from_file_location("make_meta_fixture", str(ST / "tests" / "make_meta_fixture.py"))
MM = importlib.util.module_from_spec(spec); spec.loader.exec_module(MM)
OTHER = MF.content(3)[:5000]
OTHER_SHA = hashlib.sha256(OTHER).hexdigest()
EMPTY_SHA = hashlib.sha256(b"").hexdigest()


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class E(unittest.TestCase):
    n = 0

    @classmethod
    def setUpClass(cls):
        cls.fx = os.path.join(WORK, "fixture")
        cls.summary = MF.build(cls.fx)
        cls.parent = os.path.join(cls.fx, "parent-clean.qcow2")
        cls.parent_sha = cls.summary["parents"]["parent-clean.qcow2"]

    def run_x(self, allow, parent=None, uuid=MF.UUID, view=("data/db/other.dat", OTHER_SHA), term_at=None, fs_blocks=MF.FS_BLOCKS,
              parent_sha=None):
        E.n += 1
        dp = os.path.join(WORK, f"dest-{E.n}"); os.mkdir(dp, 0o700)
        al = os.path.join(WORK, f"allow-{E.n}.json"); Path(al).write_text(json.dumps(allow))
        cmd = [sys.executable, "-I", "-B", EXTRACT, "run", "--fixture", "--dest-parent", dp, "--backup", parent or self.parent,
               "--allowlist", al, "--uuid", uuid, "--fs-blocks", str(fs_blocks), "--fuse2fs", os.environ["CHE_FUSE2FS"],
               "--fuse2fs-sha256", os.environ["CHE_FUSE2FS_SHA256"],
               "--parent-sha256", parent_sha if parent_sha else (self.parent_sha if parent is None else ""),
               "--view-target", view[0], "--view-target-sha256", view[1], "--hold-seconds", "120"]   # r2: the pinned floors (defaults)
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, text=True)
        if term_at:
            end = time.monotonic() + 120
            while time.monotonic() < end and not any(os.path.isdir(os.path.join(dp, r, term_at)) for r in os.listdir(dp)):
                time.sleep(0.02)
            p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=900)
        runs = os.listdir(dp)
        rec = None
        if runs:
            self.assertEqual(len(runs), 1)
            run = os.path.join(dp, runs[0])
            rec = json.loads(Path(run, "EXTRACTION-RECEIPT.json").read_text())
            self.assertEqual(rec["session"]["reasons"], [], err)       # the r9 session always ended clean, whatever our outcome
            self.assertNotIn(run, Path("/proc/self/mountinfo").read_text())
            for pid in filter(str.isdigit, os.listdir("/proc")):
                try:
                    self.assertNotIn(run.encode(), Path(f"/proc/{pid}/cmdline").read_bytes())
                except OSError:
                    pass
            self.assertFalse(rec["canonicalAuthority"] or rec["resetAuthority"])
        self.assertEqual(sha(self.parent), self.parent_sha)
        return p.returncode, rec, (os.path.join(dp, runs[0]) if runs else None), out + err

    def test_1_clean_extraction(self):
        allow = [{"path": "data/db/other.dat", "size": 5000, "nlink": 1, "sha256": OTHER_SHA},
                 {"path": "data/db/mdbx.dat", "size": 0, "nlink": 1}]
        rc, rec, run, err = self.run_x(allow)
        self.assertEqual((rc, rec["outcome"], rec["totalBytes"]), (0, "CLEAN", 5000), err)
        self.assertEqual(Path(run, "files/data/db/other.dat").read_bytes(), OTHER)
        self.assertEqual(Path(run, "files/data/db/mdbx.dat").read_bytes(), b"")
        self.assertEqual([(f["path"], f["sha256"]) for f in rec["files"]], [("data/db/other.dat", OTHER_SHA), ("data/db/mdbx.dat", EMPTY_SHA)])
        self.assertEqual(sorted(os.listdir(os.path.join(run, "files/data/db"))), ["mdbx.dat", "other.dat"])
        pre, post = rec["sourcePre"], rec["sourcePost"]
        self.assertEqual({k: pre[k] for k in ("dev", "ino", "size", "mtimeNs", "ctimeNs")}, {k: post[k] for k in ("dev", "ino", "size", "mtimeNs", "ctimeNs")})
        self.assertEqual(rec["view"]["source"], os.path.join(run, "session/work/view/nbd"))

    def test_2_missing_path_refused_nothing_copied(self):
        rc, rec, run, err = self.run_x([{"path": "data/db/other.dat", "size": 5000, "nlink": 1}, {"path": "data/db/nope", "size": 1, "nlink": 1}])
        self.assertEqual((rc, rec["outcome"]), (3, "REFUSED"), err)
        self.assertEqual(os.listdir(os.path.join(run, "files")), [])

    def test_3_metadata_mismatch_refused_before_any_copy(self):
        rc, rec, run, err = self.run_x([{"path": "data/db/other.dat", "size": 5000, "nlink": 1}, {"path": "data/db/mdbx.dat", "size": 1, "nlink": 1}])
        self.assertEqual((rc, rec["outcome"]), (3, "REFUSED"), err)
        self.assertIn("differs from the allowlist", rec["error"])
        self.assertEqual(os.listdir(os.path.join(run, "files")), [])

    def test_4_wrong_filesystem_uuid_refused(self):
        rc, rec, run, err = self.run_x([{"path": "data/db/other.dat", "size": 5000, "nlink": 1}], uuid="11c6bbac-f823-4052-a87a-066eed6ad590")
        self.assertEqual((rc, rec["outcome"]), (3, "REFUSED"), err)
        self.assertIn("UUID", rec["error"]); self.assertEqual(os.listdir(os.path.join(run, "files")), [])

    def test_5_writable_backup_refused_before_anything(self):
        w = os.path.join(WORK, "writable.qcow2"); shutil.copyfile(self.parent, w); os.chmod(w, 0o644)
        rc, rec, run, err = self.run_x([{"path": "data/db/other.dat", "size": 5000, "nlink": 1}], parent=w)
        self.assertEqual((rc, rec, run), (3, None, None), err)
        self.assertIn("WRITABLE", err)

    def test_6_sigterm_during_session_start_stops_cleanly(self):
        rc, rec, run, err = self.run_x([{"path": "data/db/other.dat", "size": 5000, "nlink": 1}], term_at="session/work")
        self.assertEqual((rc, rec["outcome"]), (5, "STOPPED"), err)
        self.assertEqual(os.listdir(os.path.join(run, "files")), [])

    # ---- r2 (review 1885 B3): production metadata through r9's real fakeroot view ------------------------------------------------
    @classmethod
    def meta(cls):
        if not hasattr(cls, "_meta"):
            cls._meta = MM.build(os.path.join(WORK, "meta"))
        return cls._meta

    def run_meta(self, allow):
        m = self.meta()
        reth = next(e for e in m["allowlist"] if e["path"] == "data/reth.toml")
        return self.run_x(allow, parent=m["parent"], uuid=MM.UUID, view=("data/reth.toml", reth["sha256"]), fs_blocks=MM.FS_BLOCKS,
                          parent_sha=m["parentSha256"])

    def test_7_production_metadata_exact_through_fakeroot(self):
        allow = self.meta()["allowlist"]
        self.assertEqual(allow[0]["mtime_ns"] % 10**9, 98139981)          # NON-ZERO nanoseconds, as production's reth.toml
        rc, rec, run, err = self.run_meta(allow)
        self.assertEqual((rc, rec["outcome"]), (0, "CLEAN"), err)
        for f, e in zip(rec["files"], allow):
            self.assertEqual((f["path"], f["mode"], f["uid"], f["gid"], f["mtimeNs"], f["nlink"], f["size"], f["sha256"]),
                             (e["path"], e["mode"], e["uid"], e["gid"], e["mtime_ns"], 1, e["size"], e["sha256"]))
            self.assertEqual(MM.content(e["path"], e["size"]), Path(run, "files", e["path"]).read_bytes())

    def test_8_metadata_mismatch_refuses_never_hidden(self):
        base = self.meta()["allowlist"]
        for k, v in (("mtime_ns", base[0]["mtime_ns"] + 1), ("uid", 0), ("gid", 0), ("mode", 0o100644)):
            allow = json.loads(json.dumps(base)); allow[0][k] = v
            rc, rec, run, err = self.run_meta(allow)
            self.assertEqual((rc, rec["outcome"]), (3, "REFUSED"), (k, err))
            self.assertIn("differs from the allowlist", rec["error"]); self.assertEqual(os.listdir(os.path.join(run, "files")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
