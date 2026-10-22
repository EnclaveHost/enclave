"""Static/source tests of fresh_rehearsal.py (no docker, PostgreSQL, build or rehearsal). The real fresh receipts and input
bytes are only HASHED; every negative case uses a synthetic receipt chain built here from random bytes."""
import hashlib, json, os, shutil, subprocess, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG))
import fresh_rehearsal as F  # noqa: E402

RID = F.RUN_ID
h = lambda b: hashlib.sha256(b).hexdigest()


def _w(p, data, mode=0o600):
    p = Path(p)
    with open(p, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(p, mode)


class Chain:
    """A synthetic, internally consistent fresh-backup chain (receipts + archive + input dir) with random bytes."""
    n = 0

    def __init__(self):
        Chain.n += 1
        self.base = HERE / f"tmp-{os.getpid()}-{Chain.n}"
        self.base.mkdir()
        self.inp, self.arch = self.base / "inp", self.base / "arch"
        self.inp.mkdir(mode=0o700); self.arch.mkdir()
        (self.inp / "retirement-snapshot").mkdir(mode=0o700)
        self.data = {n: os.urandom(4096) for n in F.PERSIST}
        files = {n: {"sha256": h(b), "bytes": len(b)} for n, b in self.data.items()}
        files["indexd"]["sha256"] = F.ORIG_SHA          # the binary's hash is the pinned one; its bytes are checked below
        self.archive = os.urandom(8192)
        self.snap = {"runId": RID, "quiesced": True, "coupled": True, "sourceResumed": True, "writerWasActive": True, "dbVersion": 26,
                     "binarySha256": F.ORIG_SHA, "capturedAt": "2026-10-22T07:50:14Z", "counts": {"objects": 3, "slabs": 2, "contracts": 1, "accounts": 1},
                     "files": files, "stoppedSeconds": 1.0}
        self.backup = {"runId": RID, "file": f"indexd-minipc-fresh-{RID}.tar.gpg", "sha256": h(self.archive), "sourceSnapshot": self.snap,
                       "vmReceipt": {"outcome": "complete", "coupled": True, "sourceResumed": True}, "decryptionKeyReplicated": False,
                       "replicas": [], "location": "local workstation"}
        self.integ = {"runId": RID, "pass": True, "archive": self.backup["file"], "archiveSha256": self.backup["sha256"], "problems": [],
                      **{k: True for k in ("archiveSha256MatchesReceipt", "authenticatedDecryptionPassed", "membersExactlyExpected",
                                           "manifestEqualsPullTimeManifest", "allMemberHashesMatch", "coupledAndResumed")}}
        self.rr = {"runId": RID, "authenticatedArchive": self.backup["file"], "allArchiveMembersVerified": True,
                   "configAndOperationsSecretsExtracted": False, "persistedOnly": {n: files[n]["sha256"] for n in F.PERSIST},
                   "snapshotCounts": self.snap["counts"], "snapshotCapturedAt": self.snap["capturedAt"]}
        self.lr = {"mode": "coupled-quiesced", "file": f"live-indexd-{RID}.pgdump", "sha256": files["indexd.pgdump"]["sha256"],
                   "bytes": files["indexd.pgdump"]["bytes"], "sourceRestarted": True}

    def write(self, hash_binary_ok=False):
        for n, b in self.data.items():
            _w(self.inp / "retirement-snapshot" / n, b)
        _w(self.inp / f"live-indexd-{RID}.pgdump", self.data["indexd.pgdump"])
        _w(self.inp / "retirement-extraction-receipt.json", json.dumps(self.rr))
        _w(self.inp / "live-dump-receipt.json", json.dumps(self.lr))
        _w(self.arch / self.backup["file"], self.archive, 0o600)
        bp, ip = self.base / "backup.json", self.base / "integrity.json"
        _w(bp, json.dumps(self.backup), 0o644); _w(ip, json.dumps(self.integ), 0o644)
        return (bp, F.sha(bp)), (ip, F.sha(ip))

    def check(self, hash_inputs=False):
        b, i = self.write()
        return F.validate_fresh(self.inp, b, i, self.arch, hash_inputs=hash_inputs)

    def close(self):
        shutil.rmtree(self.base)


class FreshTests(unittest.TestCase):
    def tearDown(self):
        for c in getattr(self, "chains", []):
            c.close()

    def chain(self):
        c = Chain(); self.chains = getattr(self, "chains", []) + [c]; return c

    # ---------- reuse of the pinned module, five overrides only ----------
    def test_only_the_five_globals_are_rebound(self):
        a = F.load_base()
        before = {k: v for k, v in a.__dict__.items() if not k.startswith("__")}
        b = F.rebind(F.load_base(), F.FRESH["inputDir"])
        changed = sorted(k for k in before if k in b.__dict__ and not k.startswith("__") and type(before[k]).__name__ != "function"
                         and before[k] != b.__dict__[k] and k not in ("results",))
        self.assertEqual(changed, ["BINARIES", "INP", "LIVE", "RUNS", "SNAP"])
        self.assertEqual({k: v for k, v in b.BINARIES.items() if k != "indexd-original"}, {k: v for k, v in a.BINARIES.items() if k != "indexd-original"})
        self.assertEqual(b.BINARIES["indexd-original"], (F.FRESH["inputDir"] / "retirement-snapshot" / "indexd", a.ORIG_SHA))
        for k in ("CONTROLLER", "MIGRATIONS", "DIGEST_PRODUCTION", "TOOL_PINS", "TOOLS", "MAX_SCOPE", "PG_MEM_MIB", "TOOL_MEM_MIB", "ORIG_SHA", "FENCE_SHA", "C2_SHA"):
            self.assertEqual(getattr(a, k), getattr(b, k), k)
        self.assertEqual([p for p, _ in b.PHASES], [p for p, _ in a.PHASES]); self.assertEqual(len(b.PHASES), 20)
        self.assertEqual(b.RUNS, PKG / "runs"); self.assertNotIn("storage-enclave-rehearsal", str(b.RUNS))
        self.assertEqual(Path(b.__file__), F.BASE.resolve(), "pins() hashes the ORIGINAL module file")

    def test_a_changed_module_or_rhfx_is_refused(self):
        t = HERE / f"tmp-mod-{os.getpid()}"; shutil.copytree(F.BASE.parent, t)
        try:
            p = t / "rehearse-c2.py"; p.write_bytes(p.read_bytes() + b"\n# changed\n")
            with self.assertRaises(SystemExit) as e: F.load_base(p)
            self.assertIn("not the pinned rehearsal module", str(e.exception))
            shutil.copy(F.BASE, p); (t / "rhfx.py").write_bytes((t / "rhfx.py").read_bytes() + b"\n")
            with self.assertRaises(SystemExit) as e: F.load_base(p)
            self.assertIn("not the pinned rhfx", str(e.exception))
        finally:
            shutil.rmtree(t)

    # ---------- the real fresh chain (hashes only) ----------
    def test_the_actual_fresh_backup_chain_validates(self):
        facts, bad = F.validate_fresh(F.FRESH["inputDir"], F.FRESH["backupReceipt"], F.FRESH["integrity"], F.FRESH["archiveDir"])
        self.assertEqual(bad, []); self.assertTrue(facts["freshQuiescedCoupledBackup"]); self.assertTrue(facts["liveDumpIsSnapshotDump"])
        self.assertEqual(facts["dbVersion"], 26); self.assertFalse(facts["oldCapturesUsed"]); self.assertFalse(facts["configSecretsExtracted"])
        self.assertEqual(sorted(facts["inputSha256"]), sorted(F.PERSIST + [f"live-indexd-{RID}.pgdump"]))

    def test_the_old_captures_are_refused_as_fresh_input(self):
        old = F.WORK / "indexd-production-rehearsal"
        facts, bad = F.validate_fresh(old, F.FRESH["backupReceipt"], F.FRESH["integrity"], F.FRESH["archiveDir"], hash_inputs=False)
        self.assertTrue(any("extraction receipt is not this run" in x for x in bad), bad)
        self.assertTrue(any("coupled quiesced dump" in x for x in bad), bad)

    # ---------- synthetic chain: every gate ----------
    def test_synthetic_chain_validates_and_hashes(self):
        c = self.chain(); c.data["indexd"] = b"x"; c.snap["files"]["indexd"]["bytes"] = 1
        c.rr["persistedOnly"]["indexd"] = c.snap["files"]["indexd"]["sha256"]       # ORIG_SHA; bytes "x" -> mismatch when hashing
        facts, bad = c.check()
        self.assertEqual(bad, []); self.assertTrue(facts["freshQuiescedCoupledBackup"])
        facts, bad = c.check(hash_inputs=True)
        self.assertIn("input indexd bytes differ from the receipt", bad)

    def test_every_gate_refuses(self):
        cases = {
            "VM receipt is not complete+coupled+resumed": lambda c: c.backup["vmReceipt"].update(outcome="UNRESTORED:backup-complete"),
            "source snapshot is not a quiesced, coupled capture": lambda c: c.snap.update(coupled=False),
            "backup schema is not v26": lambda c: c.snap.update(dbVersion=27),
            "backup binary is not the deployed": lambda c: c.snap.update(binarySha256="0" * 64),
            "replicas or a replicated key": lambda c: c.backup.update(replicas=["us-west"]),
            "integrity result did not pass": lambda c: c.integ.update(authenticatedDecryptionPassed=False),
            "integrity result names another archive": lambda c: c.integ.update(archiveSha256="1" * 64),
            "run id differs": lambda c: c.integ.update(runId="20261022T000000Z-00000000"),
            "extraction receipt is not this run": lambda c: c.rr.update(authenticatedArchive="indexd-minipc-20261019.tar.gpg"),
            "configuration/operations secrets were extracted": lambda c: c.rr.update(configAndOperationsSecretsExtracted=True),
            "persisted set is not exactly": lambda c: c.rr["persistedOnly"].update({"indexd.yml": "2" * 64}),
            "persisted hashes differ from the archive manifest": lambda c: c.rr["persistedOnly"].update({"consensus.db": "3" * 64}),
            "extraction counts/capturedAt differ": lambda c: c.rr.update(snapshotCounts={"objects": 999}),
            "live-dump receipt is not this run's coupled quiesced dump": lambda c: c.lr.update(mode="live-separate"),
            "the live dump is not the archive's quiesced indexd.pgdump": lambda c: c.lr.update(sha256="4" * 64),
        }
        for want, mutate in cases.items():
            with self.subTest(want=want):
                c = self.chain(); mutate(c); _, bad = c.check()
                self.assertTrue(any(want in x for x in bad), (want, bad))
        c = self.chain(); c.write(); _w(c.inp / "indexd.yml", "not read")
        _, bad = F.validate_fresh(c.inp, (c.base / "backup.json", F.sha(c.base / "backup.json")), (c.base / "integrity.json", F.sha(c.base / "integrity.json")), c.arch, hash_inputs=False)
        self.assertIn("input dir holds other entries (e.g. indexd.yml)", bad)
        c = self.chain(); c.write(); os.chmod(c.inp / "live-dump-receipt.json", 0o644)
        _, bad = F.validate_fresh(c.inp, (c.base / "backup.json", F.sha(c.base / "backup.json")), (c.base / "integrity.json", F.sha(c.base / "integrity.json")), c.arch, hash_inputs=False)
        self.assertTrue(any("not 0600" in x for x in bad), bad)
        c = self.chain(); b, i = c.write(); c.archive = b"tampered"; _w(c.arch / c.backup["file"], c.archive)
        _, bad = F.validate_fresh(c.inp, b, i, c.arch, hash_inputs=True)
        self.assertIn("encrypted archive bytes differ from the receipt", bad)
        c = self.chain(); b, i = c.write()
        _, bad = F.validate_fresh(c.inp, (b[0], "5" * 64), i, c.arch)
        self.assertTrue(bad and "is not the pinned" in bad[0], bad)

    # ---------- the CLI: plan has no side effects, execute refuses without creating anything ----------
    def cli(self, *a):
        r = subprocess.run([sys.executable, "-B", str(PKG / "fresh_rehearsal.py"), *a], capture_output=True, text=True, timeout=600)
        return r.returncode, r.stdout

    def test_plan_and_refused_execute_create_nothing(self):
        self.assertFalse((PKG / "runs").exists())
        rc, out = self.cli("--plan"); plan = json.loads(out)
        self.assertEqual(plan["freshProblems"], []); self.assertIn(rc, (0, 2))
        self.assertEqual(rc == 0, plan["baseProblems"] == [])
        self.assertTrue(plan["freshInput"]["freshQuiescedCoupledBackup"])
        self.assertEqual(plan["basePins"]["rehearse-c2.py"], F.BASE_SHA)
        rc, out = self.cli("--execute", "0" * 64); self.assertEqual(rc, 2); self.assertIn("usage", out)
        rc, out = self.cli("--execute", plan["manifest"]); self.assertEqual(rc, 2, out)   # pins pending or not isolated: the module refuses
        self.assertFalse((PKG / "runs").exists(), "a refused execute creates no runs dir, journal or stage")

    def test_run_sh_is_the_base_run_sh_with_only_the_entry_point_changed(self):
        base = (F.BASE.parent / "run.sh").read_text().splitlines(); ours = (PKG / "run.sh").read_text().splitlines()
        tail = lambda L: L[L.index("set -u"):]
        diff = [(x, y) for x, y in zip(tail(base), tail(ours)) if x != y]
        self.assertEqual(len(tail(base)), len(tail(ours)))
        self.assertEqual(diff, [(tail(base)[1], tail(base)[1].replace('"$H/../../.."', '"$H/../.."')),
                                (tail(base)[5], tail(base)[5].replace('"$H/rehearse-c2.py"', '"$H/fresh_rehearsal.py"'))])


if __name__ == "__main__":
    unittest.main()
