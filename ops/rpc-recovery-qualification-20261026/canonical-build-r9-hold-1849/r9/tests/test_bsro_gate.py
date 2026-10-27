#!/usr/bin/env python3
"""base-state-readonly-stage/r9 tests/test_bsro_gate.py (prepared by Claude 1839/1844; NOT run by Claude). 14 unit tests of jobs/bsro_gate.py
and the r8 env.sh placement: no compilation (test 11 runs only `rustc -V`/`cargo -V`), no mount, no namespace change, no part or production
state, no network. Synthetic receipts / stages / guard run dirs under $TEST_TMP; every child process is owned and reaped."""
import importlib.util, io, json, os, signal, stat, subprocess, sys, tempfile, time, unittest
from pathlib import Path

STAGE = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("bsro_gate", STAGE / "jobs" / "bsro_gate.py")
G = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(G)
TMP = os.environ.get("TEST_TMP")
DROP = object()


def group_members(pgid):
    """live (non-zombie) processes of process group pgid"""
    out = []
    for e in os.listdir("/proc"):
        if e.isdigit():
            try:
                with open(f"/proc/{e}/stat") as f:
                    st = f.read()
            except OSError:
                continue
            rest = st[st.rfind(")") + 2:].split()
            if int(rest[2]) == pgid and rest[0] != "Z":
                out.append(int(e))
    return out
MIB, GIB = 1 << 20, 1 << 30
DONE = {"parts": 265, "partsCommitted": 265, "partsVerifiedRecorded": 265, "copyComplete": True, "verificationCompleteRecorded": True,
        "stale": [], "unconfirmed": [], "invalidRecords": [], "failedVerification": [], "note": "x"}


def mkd(prefix):
    return tempfile.mkdtemp(prefix=prefix, dir=TMP)


class Gate(unittest.TestCase):
    def test_01_completion_requires_all_265_verified_and_zero_remaining(self):
        fp = G.completion(DONE, {"root": 0, "vm": 0})
        self.assertRegex(fp, r"^[0-9a-f]{64}$")
        self.assertEqual(fp, G.completion({**DONE, "note": "other"}, {"vm": 0, "root": 0}))      # the note is not identity
        bad = [({**DONE, "partsVerifiedRecorded": 264}, {"root": 0, "vm": 0}), ({**DONE, "partsCommitted": 264}, {"root": 0, "vm": 0}),
               ({**DONE, "verificationCompleteRecorded": False}, {"root": 0, "vm": 0}), ({**DONE, "copyComplete": False}, {"root": 0, "vm": 0}),
               ({**DONE, "stale": [3]}, {"root": 0, "vm": 0}), ({**DONE, "unconfirmed": [7]}, {"root": 0, "vm": 0}),
               ({**DONE, "invalidRecords": [9]}, {"root": 0, "vm": 0}), ({**DONE, "failedVerification": [1]}, {"root": 0, "vm": 0}),
               (DONE, {"root": 0, "vm": 4096}), (DONE, {"root": False, "vm": 0}), (DONE, {"root": 0}), (None, {"root": 0, "vm": 0})]
        for status, rem in bad:
            with self.assertRaises(G.Refused, msg=(status and {k: status[k] for k in status if status[k] != DONE.get(k)}, rem)):
                G.completion(status, rem)

    def test_02_exact_id_maps_inside_and_outside(self):
        self.assertTrue(G.maps_inside("         0       1000          1\n", "0 1000 1\n", "deny\n", 1000, 1000))
        for um, gm, sg, u, g in (("0 1000 1", "0 1000 1", "allow", 1000, 1000), ("0 1001 1", "0 1000 1", "deny", 1000, 1000),
                                 ("0 1000 2", "0 1000 1", "deny", 1000, 1000), ("0 1000 1\n1 100000 65536", "0 1000 1", "deny", 1000, 1000),
                                 ("0 1000 1", "0 1001 1", "deny", 1000, 1000), ("0 0 4294967295", "0 0 4294967295", "deny", 1000, 1000),
                                 ("x 1000 1", "0 1000 1", "deny", 1000, 1000)):
            with self.assertRaises(G.Refused, msg=(um, gm, sg)):
                G.maps_inside(um, gm, sg, u, g)
        self.assertTrue(G.maps_outside("0 0 4294967295\n", "0 0 4294967295\n", 1000, 1000))
        for args in (("0 1000 1", "0 1000 1", 0, 0), ("0 0 4294967295", "0 0 4294967295", 0, 1000), ("0 0 4294967295", "0 0 4294967295", 1000, 0)):
            with self.assertRaises(G.Refused):
                G.maps_outside(*args)

    def test_03_mount_propagation_must_be_private(self):
        priv = "22 1 253:0 / / rw,relatime - ext4 /dev/mapper/cryptroot rw\n30 22 0:31 / /tmp rw,nosuid - tmpfs tmpfs rw\n"
        self.assertTrue(G.propagation_private(priv))
        for tag in ("shared:1", "master:7", "propagate_from:3"):
            with self.assertRaises(G.Refused, msg=tag):
                G.propagation_private(f"22 1 253:0 / / rw,relatime {tag} - ext4 /dev/mapper/cryptroot rw\n")
        # r9 PB1: the visible tree at/under each read-only root (a stacked /tmp; an rbind copy of an inherited fuse submount; a shadowed
        # rw original that is no longer reachable by path)
        mi = ("22 1 253:0 / / rw - ext4 /dev/mapper/cryptroot rw\n40 22 0:50 / /home/steven/x/usb ro - fuseblk /dev/sda2 ro\n"
              "41 22 0:51 / /home/steven/y rw - ext4 /dev/x rw\n90 22 253:0 /home/steven /home/steven ro - ext4 /dev/mapper/cryptroot rw\n"
              "91 90 0:50 / /home/steven/x/usb ro - fuseblk /dev/sda2 ro\n92 90 0:51 / /home/steven/y\\040z ro - ext4 /dev/x rw\n"
              "30 22 0:31 / /tmp rw,nosuid - tmpfs tmpfs rw\n95 30 0:31 / /tmp ro,nosuid - tmpfs tmpfs rw\n")
        self.assertTrue(G.ro_tree_ok(mi, ["/home/steven", "/tmp"]))
        self.assertEqual(G.parse_mountinfo(mi)[5]["mp"], "/home/steven/y z")
        for bad in (mi.replace("92 90 0:51 / /home/steven/y\\040z ro", "92 90 0:51 / /home/steven/y\\040z rw"),   # a writable submount
                    mi.replace("95 30 0:31 / /tmp ro", "95 30 0:31 / /tmp rw"),                                      # the top is writable
                    mi.replace("90 22 253:0 /home/steven /home/steven ro", "90 22 253:0 /home/steven /home/steven2 ro"),   # no bind
                    mi + "96 30 0:31 / /tmp ro - tmpfs tmpfs rw\n"):                                                # two tops
            with self.assertRaises(G.Refused):
                G.ro_tree_ok(bad, ["/home/steven", "/tmp"])

    def test_04_lane_and_explicit_root_floor(self):
        self.assertTrue(G.lane_ok(f"{4096 * MIB}\n", 20736))
        for mm, av in ((str(2560 * MIB), 30000), ("max", 30000), (str(4096 * MIB), 20735)):
            with self.assertRaises(G.Refused):
                G.lane_ok(mm, av)
        need = 40 * GIB + 8 * GIB + 16 * MIB
        self.assertTrue(G.root_floor_ok(need))
        with self.assertRaises(G.Refused):
            G.root_floor_ok(need - 1)

    def test_05_qualifying_receipts_both_suites_exact(self):
        st = mkd("stage"); os.mkdir(os.path.join(st, "runs"))
        with open(os.path.join(st, "SHA256SUMS"), "w") as f:
            f.write("x  y\n")
        sums = G.sha(b"x  y\n")

        def receipt(name, fmt, suites, ran_override=None):
            d = os.path.join(st, "runs", name); os.mkdir(d)
            r = {"format": fmt, "pass": True, "stageSums": sums,
                 "suites": {k: {"pass": True, "ran": [str(ran_override or n)]} for k, n in suites.items()}}
            with open(os.path.join(d, "receipt.json"), "w") as f:
                json.dump(r, f)
        receipt("guard-tests-1", "bsro-guard-test-receipt/r9", G.GUARD_SUITES)
        with self.assertRaises(G.Refused):
            G.qualified(st)                                              # the ns-tests receipt is ALSO required
        receipt("ns-tests-1", "bsro-ns-test-receipt/r9", G.NS_SUITES, ran_override=3)
        with self.assertRaises(G.Refused):
            G.qualified(st)                                              # a short ns run never qualifies
        receipt("ns-tests-2", "bsro-ns-test-receipt/r9", G.NS_SUITES)
        self.assertEqual(G.qualified(st), sums)
        self.assertFalse(G.receipt_ok({"format": "bsro-guard-test-receipt/r7", "pass": True, "stageSums": sums, "suites": {}}, sums,
                                      "bsro-guard-test-receipt/r9", G.GUARD_SUITES))

    def test_06_bounded_capture_keeps_1_mib_drains_the_rest_and_propagates_rc(self):
        out = os.path.join(mkd("cap"), "out.txt")
        code = "import sys; sys.stdout.write('x' * (3 << 20)); sys.stdout.flush(); sys.exit(7)"
        r = G.run_capture([sys.executable, "-c", code], out, forward=False)
        self.assertEqual((r["rc"], r["kept"], r["total"], r["abandoned"], r["sinkError"]), (7, 1 << 20, 3 << 20, False, None))
        self.assertEqual(os.path.getsize(out), 1 << 20)
        with self.assertRaises(FileExistsError):                         # never overwrites
            G.run_capture(["/usr/bin/true"], out, forward=False)

    def test_07_capture_ends_owned_holders_and_abandons_foreign_ones_within_bounds(self):
        d = mkd("hold")
        t0 = time.monotonic()
        r = G.run_capture(["/usr/bin/bash", "-c", "sleep 300 & echo hi; exit 4"], os.path.join(d, "a.txt"), grace=0.5, hard=10, forward=False)
        self.assertEqual((r["rc"], r["abandoned"]), (4, False)); self.assertLess(time.monotonic() - t0, 20)   # the group's sleep was killed
        self.assertEqual(group_members(r["pid"]), [])
        r = G.run_capture(["/usr/bin/bash", "-c", "setsid sleep 300 & echo $!; exit 0"], os.path.join(d, "b.txt"), grace=0.5, hard=1, forward=False)
        rc, abandoned = r["rc"], r["abandoned"]
        with open(os.path.join(d, "b.txt")) as f:
            pid = int(f.read().split()[0])
        try:
            self.assertEqual((rc, abandoned), (0, True))                 # a holder outside our group: reading stops, never a success
        finally:
            os.kill(pid, signal.SIGKILL)                                 # the test owns its stray holder

    def test_08_a_forwarded_sigterm_reaches_only_the_childs_group(self):
        d = mkd("fwd")
        drv = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('g', sys.argv[1]); g = importlib.util.module_from_spec(s); "
               "s.loader.exec_module(g); print(g.run_capture(['/usr/bin/sleep', '300'], sys.argv[2])['rc'], flush=True)")
        p = subprocess.Popen([sys.executable, "-I", "-c", drv, str(STAGE / "jobs" / "bsro_gate.py"), os.path.join(d, "o.txt")],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            time.sleep(1.0)
            p.send_signal(signal.SIGTERM)
            out, err = p.communicate(timeout=30)
        finally:
            if p.poll() is None:
                p.kill(); p.communicate()
        self.assertEqual((p.returncode, out.strip()), (0, str(-signal.SIGTERM)), err)

    def fake_run(self, mode=0o700, acc_sha=None, verdict="ok", link_out=False, name_other=False, lines=1, guard=None):
        base = mkd("base"); run = os.path.join(base, "run-20261101T000000Z-123"); os.mkdir(run, mode)
        out = os.path.join(run, "out")
        if link_out:
            real = os.path.join(run, "real"); os.mkdir(real); os.symlink(real, out); out = real
        else:
            os.mkdir(out)
        shas = {}
        for b in G.BINARIES:
            with open(os.path.join(out, b), "wb") as f:
                f.write(b.encode() * 100)
            os.chmod(os.path.join(out, b), 0o555); shas[b] = G.sha(b.encode() * 100)
        acc = {"format": "bsro-build-accounting/r9", "verdict": verdict,
               "binaries": {b: {"sha256": acc_sha or shas[b]} for b in G.BINARIES}, "runDirAllocBytes": 1, "tmpResidualBytes": 0}
        with open(os.path.join(out, "accounting.json"), "w") as f:
            json.dump(acc, f)
        with open(os.path.join(run, "guard-receipt.json"), "w") as f:
            g = {"format": "bsro-disk-guard/r5", "runDir": run + ("x" if name_other else ""), "reason": None, "childRc": 0, "groupLeftAlive": False}
            for k, v in (guard or {}).items():
                if v is DROP:
                    g.pop(k)
                else:
                    g[k] = v
            json.dump(g, f)
        return base, run, "\n".join([f"## disk-guard run dir {run}"] * lines) + "\n"

    def test_09_receipt_authenticates_the_guard_run_and_binaries_in_place(self):
        base, run, text = self.fake_run()
        r, info = G.authenticate(text, base)
        self.assertEqual((r, info["outDir"]), (run, os.path.join(run, "out")))
        self.assertEqual(info["binaries"]["mk_fixture"]["sha256"], G.sha(b"mk_fixture" * 100))
        for kw in ({"mode": 0o755}, {"acc_sha": "0" * 64}, {"verdict": "failed"}, {"link_out": True}, {"name_other": True}, {"lines": 2},
                   # r9 (root 1843 #1): only a guard that ended clean - reason null, childRc exactly int 0, groupLeftAlive exactly false
                   {"guard": {"reason": "diskFloor"}}, {"guard": {"reason": DROP}}, {"guard": {"childRc": 1}}, {"guard": {"childRc": False}},
                   {"guard": {"childRc": "0"}}, {"guard": {"childRc": DROP}}, {"guard": {"groupLeftAlive": True}},
                   {"guard": {"groupLeftAlive": None}}, {"guard": {"groupLeftAlive": DROP}}):
            base, run, text = self.fake_run(**kw)
            with self.assertRaises(G.Refused, msg=kw):
                G.authenticate(text, base)
        base, run, text = self.fake_run()
        with self.assertRaises(G.Refused):
            G.authenticate(text.replace(base, base + "-elsewhere"), base)   # not a child of the pinned base
        self.assertEqual([G.final_rc(*a) for a in ((0, True), (0, False), (71, True), (73, False))], [0, 10, 71, 73])
        ns = mkd("nostage")
        with open(os.path.join(ns, "SHA256SUMS"), "w") as f:
            f.write("x  y\n")
        with self.assertRaises(G.Refused):
            G.verify_binaries(os.path.join(run, "out"), stage=ns)        # no verified build receipt of that stage names it

    def test_10_terminal_accounting_is_bounded_and_written_once(self):
        run = mkd("acc"); out = os.path.join(run, "out"); tmp = os.path.join(run, "tmp"); os.mkdir(out); os.mkdir(tmp)
        for b in G.BINARIES:
            with open(os.path.join(out, b), "wb") as f:
                f.write(b"x" * 4096)
        self.assertEqual(G.account(run, out, tmp, 0, 0, 0), 0)
        with open(os.path.join(out, "accounting.json")) as f:
            acc = json.load(f)
        self.assertEqual(acc["verdict"], "ok"); self.assertGreater(acc["runDirAllocBytes"], 0)
        self.assertLessEqual(os.path.getsize(os.path.join(out, "accounting.json")), G.FILE_CAP)
        with self.assertRaises(FileExistsError):
            G.account(run, out, tmp, 0, 0, 0)                            # O_EXCL: never rewritten
        os.unlink(os.path.join(out, "accounting.json")); os.unlink(os.path.join(out, "mk_fixture"))
        self.assertEqual(G.account(run, out, tmp, 0, 0, 0), 1)           # a missing binary is never ok
        with self.assertRaises(G.Refused):
            G.write_new(os.path.join(run, "big.json"), b"x" * (G.FILE_CAP + 1))

    def test_11_env_prepare_keeps_scratch_outputs_and_tmpdir_inside_the_guard_run_dir(self):
        run = mkd("guardrun")
        runs = STAGE / "runs"
        before = sorted(os.listdir(runs)) if runs.exists() else []
        script = ('source "$1"; prepare build; printf "B=%s\\nO=%s\\nT=%s\\nTMPDIR=%s\\n" "$B" "$O" "$T" "$TMPDIR"; '
                  'printf "E=%s\\n" "${E[@]}"')
        p = subprocess.run(["/usr/bin/bash", "-c", script, "bash", str(STAGE / "jobs" / "env.sh")], capture_output=True, text=True,
                           timeout=600, env={"PATH": "/usr/bin:/bin", "BSRO_RUN_DIR": run})
        self.assertEqual(p.returncode, 0, p.stdout[-2000:] + p.stderr[-2000:])
        kv = dict(l.split("=", 1) for l in p.stdout.splitlines() if l[:2] in ("B=", "O=", "T=") or l.startswith("TMPDIR="))
        self.assertEqual((kv["B"], kv["O"], kv["T"], kv["TMPDIR"]), (f"{run}/scratch", f"{run}/out", f"{run}/tmp", f"{run}/tmp"))
        self.assertIn(f"E=TMPDIR={run}/tmp", p.stdout.splitlines()); self.assertIn(f"E=HOME={run}/scratch", p.stdout.splitlines())
        self.assertTrue(os.path.isfile(os.path.join(run, "out", "toolchain.txt")))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(run, "tmp")).st_mode), 0o700)
        self.assertEqual(sorted(os.listdir(runs)) if runs.exists() else [], before)   # nothing written to the stage on root
        q = subprocess.run(["/usr/bin/bash", "-c", 'source "$1"; prepare build', "bash", str(STAGE / "jobs" / "env.sh")], capture_output=True,
                           text=True, timeout=120, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(q.returncode, 9); self.assertIn("no /tmp or root fallback", q.stdout)

    # ---- r9 (root 1843 #2/#3, review 1841 m1/m2) ----------------------------------------------------------------------------------
    def test_12_lifecycle_deadlines_tick_even_under_continuous_output(self):
        d = mkd("flood")
        t0 = time.monotonic()                                           # an OWNED writer that never stops after the leader exits
        r = G.run_capture(["/usr/bin/bash", "-c", "(while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done) & exit 3"],
                          os.path.join(d, "a.txt"), grace=0.5, hard=10, forward=False)
        self.assertEqual((r["rc"], r["abandoned"]), (3, False)); self.assertLess(time.monotonic() - t0, 30)
        self.assertGreater(r["total"], 0); self.assertEqual(group_members(r["pid"]), [])          # no surviving owned writer
        pidf = os.path.join(d, "foreign.pid")                           # a FOREIGN (setsid) writer: bounded abandonment, never success
        t0 = time.monotonic()
        r = G.run_capture(["/usr/bin/bash", "-c", f"setsid bash -c 'while :; do echo y; done' & echo $! > {pidf}; exit 0"],
                          os.path.join(d, "b.txt"), grace=0.5, hard=1, forward=False)
        try:
            self.assertEqual((r["rc"], r["abandoned"]), (0, True)); self.assertLess(time.monotonic() - t0, 30)
        finally:
            with open(pidf) as f:
                os.kill(int(f.read()), signal.SIGKILL)                   # the test owns its stray writer

    def test_13_a_failed_capture_sink_stops_the_owned_build_in_order(self):
        """the sink write fails (RLIMIT_FSIZE in the driver only: EFBIG); our ONE TERM reaches the stand-in shell (trap, like build.sh)
        and its stand-in guard, which exits 73 like disk_guard after stopping its own build; the rc propagates, nothing is left"""
        d = mkd("sink")
        guard = "import signal, sys, time; signal.signal(signal.SIGTERM, lambda *a: sys.exit(73)); sys.stdout.write('x' * (2 << 20)); sys.stdout.flush(); time.sleep(300)"
        shell = f"trap ':' TERM; {sys.executable} -c \"{guard}\"; exit $?"
        drv = ("import importlib.util, json, resource, sys; resource.setrlimit(resource.RLIMIT_FSIZE, (65536, 65536)); "
               "s = importlib.util.spec_from_file_location('g', sys.argv[1]); g = importlib.util.module_from_spec(s); s.loader.exec_module(g); "
               "print(json.dumps(g.run_capture(['/usr/bin/bash', '-c', sys.argv[3]], sys.argv[2], grace=5, term_wait=30)), flush=True)")
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, "-I", "-c", drv, str(STAGE / "jobs" / "bsro_gate.py"), os.path.join(d, "o.txt"), shell],
                           capture_output=True, text=True, timeout=120)
        r = json.loads(p.stdout)
        self.assertEqual(r["rc"], 73, p.stderr); self.assertIn("write", r["sinkError"]); self.assertLess(time.monotonic() - t0, 60)
        self.assertLessEqual(os.path.getsize(os.path.join(d, "o.txt")), 65536); self.assertEqual(group_members(r["pid"]), [])

    def test_14_a_spawn_failure_closes_the_capture_fd_and_restores_the_handlers(self):
        d = mkd("spawn")
        fds, h = len(os.listdir("/proc/self/fd")), signal.getsignal(signal.SIGTERM)
        with self.assertRaises(FileNotFoundError):
            G.run_capture([os.path.join(d, "no-such-program")], os.path.join(d, "o.txt"))
        self.assertEqual(len(os.listdir("/proc/self/fd")), fds); self.assertIs(signal.getsignal(signal.SIGTERM), h)
        self.assertEqual(os.path.getsize(os.path.join(d, "o.txt")), 0)


if __name__ == "__main__":
    unittest.main()
