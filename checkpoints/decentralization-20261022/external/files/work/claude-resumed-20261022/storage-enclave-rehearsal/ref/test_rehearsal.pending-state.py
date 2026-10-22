#!/usr/bin/env python3
"""test_rehearsal.py - LOCAL, MOCKED checks of the storage-enclave-rehearsal port. No PostgreSQL, no docker daemon
(test/fake_docker_rm.py over the fixture's pinned fake), no indexd, no Go, no private capture opened (only receipt files
are hashed by --plan).
  python3 -u test/test_rehearsal.py -v"""
import ast
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PKG = HERE.parent
OLD = PKG / "ref/old/rehearse-c2.py"
NEW = PKG / "rehearse/rehearse-c2.py"
sys.path.insert(0, str(PKG / "rehearse"))
import rhfx  # noqa: E402
c2fx = rhfx.c2fx
FAKE = HERE / "fake_docker_rm.py"


def defs(path):
    t = ast.parse(path.read_text())
    return {n.name: ast.unparse(n) for n in t.body if isinstance(n, ast.FunctionDef)}


def phase_calls(path):
    """[(phase name, function name)] in run order, from the old main() phase(...) calls or the new PHASES list"""
    t = path.read_text()
    m = re.findall(r'phase\("([^"]+)", (\w+)\)', t)
    if m:
        return m
    tree = ast.parse(t)
    for n in tree.body:
        if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "PHASES":
            return [tuple(x) for x in ast.literal_eval(n.value)]


class Port(unittest.TestCase):
    def test_every_phase_assertion_and_comparison_is_byte_identical(self):
        old, new = defs(OLD), defs(NEW)
        phases = [f for _, f in phase_calls(OLD)]
        self.assertEqual(len(phases), 20)
        for f in phases[1:]:                                   # S0..S10, L0..L6 (setup is ported, below)
            self.assertEqual(old[f], new[f], f)
        self.assertEqual(phase_calls(OLD), phase_calls(NEW), "same 20 phases, same names, same order")

    def test_only_the_named_functions_changed(self):
        old, new = defs(OLD), defs(NEW)
        changed = sorted(k for k in old if k in new and old[k] != new[k])
        self.assertEqual(changed, ["ctl", "indexd_hwm", "main", "setup", "tool"])
        self.assertEqual(sorted(set(old) - set(new)), ["cleanup"], "the fixed-name cleanup is replaced by the reviewed c2fx ownership")
        self.assertEqual(sorted(set(new) - set(old)), ["bind_stage", "copy_pinned", "isolated", "manifest", "pins", "tool_pins", "write_secret"])
        # indexd_hwm: only the pid parse (the controller's identity pid file is "<pid> <start> <boot>")
        self.assertEqual(old["indexd_hwm"].replace("read_text())", "read_text().split()[0])"), new["indexd_hwm"])

    def test_setup_keeps_every_assertion_and_the_same_node_config(self):
        a = lambda src: {ast.unparse(n) for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Assert)}
        old_s, new_s = defs(OLD)["setup"], defs(NEW)["setup"]
        # the two per-copy hash asserts became copy_pinned(), which RAISES on a mismatch (now every migration is pinned)
        self.assertEqual(sorted(a(old_s) - a(new_s)), ["assert sha(MIG / name) == h, name", "assert sha(W / 'bin' / name) == h, name"])
        self.assertIn("copy_pinned(src, W / 'bin' / name, h, 448)", new_s); self.assertIn("copy_pinned(src, MIG / name, h)", new_s)
        self.assertIn("raise RuntimeError(f'{Path(dst).name}: copy differs from its pin')", defs(NEW)["copy_pinned"])
        self.assertIn("assert net.split()[0] == 'none'", new_s)
        yml = lambda p: re.search(r'indexd\.yml"\)?(?:\.write_text\(|, )f"""(.*?)"""', p.read_text(), re.S).group(1)
        self.assertEqual(yml(OLD), yml(NEW), "the indexd.yml template (loopback, no peers/bootstrap/UPnP/explorer, no sizing keys) is unchanged")
        self.assertIn("UPDATE global_settings SET wallet_hash = NULL;", NEW.read_text(), "production wallet_hash nulled on the disposable copy")

    def test_passed_requires_all_20_phases_and_a_certain_cleanup(self):
        src = NEW.read_text()
        self.assertIn('len(results["phases"]) == 20 and rep["certain"]', src)
        self.assertIn('return 3 if not rep["certain"]', src)

    def test_pins_are_the_new_binaries_and_matching_tools(self):
        src = NEW.read_text()
        for h in ("c67ffa4d76e54209dbc2a019e1447e79e1cbe7c54d9566b9bd1b491229da9568", "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7",
                  "2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc", "91dc928de335473997fefbc4aa9031d009072492147f5314b79e43ab95ac53d6"):
            self.assertIn(h, src)
        for old in ("61413110dc4426e4", "e6e812fd625de0cd", "ec8dc6d293a8ce28", "indexd-c2-implementation", "RH_INPUT_DIR", "RH_LIVE_DUMP"):
            self.assertNotIn(old, src)
        p = json.loads((PKG / "tools/pins.json").read_text())
        self.assertEqual(sorted(k for k in p if not k.startswith("_")), ["c2rclient", "c2tool", "rehearsaltool-v27"])

    def test_tool_sources_are_the_old_sources_pointed_at_the_matching_trees(self):
        pairs = {"c2tool": PKG / "ref/old/tool28", "c2rclient": PKG / "ref/old/client", "rehearsaltool-v27": PKG / "ref/old/rehearsaltool"}
        trees = {"c2tool": "c2-enclave", "c2rclient": "c2-enclave", "rehearsaltool-v27": "fence-enclave"}
        for t, o in pairs.items():
            n = PKG / "tools/src" / t
            self.assertEqual((n / "main.go").read_bytes(), (o / "main.go").read_bytes(), t)
            self.assertEqual((n / "go.sum").read_bytes(), (o / "go.sum").read_bytes(), t)
            ol, nl = (o / "go.mod").read_text().splitlines(), (n / "go.mod").read_text().splitlines()
            diff = [(a, b) for a, b in zip(ol, nl) if a != b]
            self.assertEqual(len(ol), len(nl)); self.assertEqual(len(diff), 1, t)
            self.assertEqual(diff[0][1], f"replace go.sia.tech/indexd => ../../../../storage-enclave-build/trees/{trees[t]}")
            self.assertTrue((n / "../../../../storage-enclave-build/trees" / trees[t] / "go.mod").resolve().is_file())

    def test_static_ownership_and_isolation(self):
        src = NEW.read_text() + (PKG / "rehearse/rhfx.py").read_text()
        for bad in ("c2prh-", "pgrep", "pkill", "os.kill(", "0.0.0.0", '"-p",', "shutil.rmtree", "docker system", "prune", "volume rm -f"):
            self.assertNotIn(bad, src, bad)
        for need in ('"--network", "none"', '"--pull", "never"', '"--network", f"container:{self.container}"', '"--memory", f"{mem_mib}m"',
                     '"--memory-swap", f"{mem_mib}m"', '"--rm"', 'O_EXCL'):
            self.assertIn(need, src, need)
        self.assertNotIn("SNAP", defs(NEW)["pins"]); self.assertNotIn("LIVE", defs(NEW)["pins"])   # --plan never opens a capture
        run = (PKG / "rehearse/run.sh").read_text()
        self.assertIn("--mib 512", run); self.assertIn("unshare --user --map-root-user --net", run); self.assertIn("ip link set lo up", run)
        self.assertIn('MAX_SCOPE = 512 * 1024 * 1024', NEW.read_text())

    def test_negative_control_old_script_has_fixed_names_and_a_host_scan(self):
        old = OLD.read_text()
        self.assertIn('PG, TOOL, VOL = "c2prh-pg", "c2prh-tool", "c2prh-pgdata"', old)
        self.assertIn('subprocess.run(["docker", "rm", "-f", c], capture_output=True)', old)
        self.assertIn('subprocess.run(["pgrep", "-f", str(W / "releases")]', old)
        self.assertIn('pid = int((STATE / "indexd.pid").read_text())', old, "would silently lose VmHWM with the identity pid file")

    def test_rhfx_refuses_a_c2fx_that_is_not_the_reviewed_one(self):
        saved = rhfx.C2FX_SHA
        try:
            rhfx.C2FX_SHA = "0" * 64
            with self.assertRaises(RuntimeError):
                rhfx._load_c2fx()
        finally:
            rhfx.C2FX_SHA = saved
            sys.modules["c2fx"] = c2fx


class Plan(unittest.TestCase):
    def run_cli(self, *a):
        env = dict(os.environ, RH_DOCKER="/nonexistent/docker")
        return subprocess.run([sys.executable, "-B", str(NEW), *a], capture_output=True, text=True, timeout=600, env=env)

    def test_plan_pins_match_and_reports_the_pending_tool_pins(self):
        r = self.run_cli("--plan")
        out = json.loads(r.stdout)
        self.assertEqual(r.returncode, 2, "tools are PENDING until root's reproducible build")
        self.assertEqual(sorted(p.split(":")[0] for p in out["problems"]), ["c2rclient", "c2tool", "rehearsaltool-v27"])
        self.assertTrue(all("PENDING" in p for p in out["problems"]))
        for n in ("indexd-original", "indexd-fence", "indexd-c2", "replicactl.py", "digest.sql", "down-28-to-27.sql", "down-27-to-26.sql",
                  "digest-production.sql", "retirement-extraction-receipt.json", "live-dump-receipt.json", "c2fx.py", "rhfx.py"):
            self.assertIn(n, out["pins"])
        self.assertFalse((PKG / "runs").exists(), "plan creates nothing")

    def test_execute_refuses_with_a_wrong_manifest_or_pending_tools(self):
        m = json.loads(self.run_cli("--plan").stdout)["manifest"]
        for a in (["--execute", "0" * 64], ["--execute", m]):
            r = self.run_cli(*a)
            self.assertEqual(r.returncode, 2, r.stdout)
        self.assertFalse((PKG / "runs").exists())

    def test_isolation_check_refuses_this_host_namespace(self):
        sp = importlib.util.spec_from_file_location("rh", NEW)
        m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
        ok, names, dns = m.isolated()
        if names == ["lo"]:
            self.skipTest("already in a loopback-only namespace")
        self.assertFalse(ok)


class _Docker(c2fx.Docker):
    def __init__(self):
        super().__init__(str(FAKE))

    def run(self, *args, timeout=None, input=None):
        r = subprocess.run([sys.executable, "-B", str(FAKE), *args], capture_output=True, text=True, timeout=timeout or 120)
        return r.returncode, r.stdout, r.stderr


class Ownership(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rh-t-"))
        self.state, self.log = self.tmp / "docker-state.json", self.tmp / "docker-log.jsonl"
        os.environ.update(FAKEDOCKER_STATE=str(self.state), FAKEDOCKER_LOG=str(self.log), FAKEDOCKER_FAULT="")
        sc = self.tmp / "run-p1-i1.scope"; sc.mkdir()
        self.scope = {"cgroup": str(sc), "rel": "/mock/run-p1-i1.scope", "ino": os.stat(sc).st_ino, "exempt": [], "memoryMax": 1}
        self.bin = self.tmp / "c2tool"; self.bin.write_text("#!/bin/true\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fault(self, f):
        os.environ["FAKEDOCKER_FAULT"] = f

    def st(self):
        return json.loads(self.state.read_text()) if self.state.exists() else {"containers": {}, "volumes": {}}

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def started(self):
        r = rhfx.RehearsalRun(self.tmp / "runs", _Docker(), scope=self.scope)
        r.term_wait, r.kill_wait = 3, 3
        r.begin(); r.create_volume()
        (r.stage / "sock").mkdir(); (r.stage / "pg.env").write_text("x")
        r.create_pg(r.stage / "pg.env", r.stage / "sock")
        return r

    def test_pg_is_network_none_socket_only_capped_offline_and_labelled(self):
        r = self.started()
        args = self.st()["containers"][r.container]["args"]
        has = lambda f: any(args[i:i + len(f)] == f for i in range(len(args)))
        for f in (["--network", "none"], ["--pull", "never"], ["--memory", "256m"], ["--memory-swap", "256m"], ["--read-only"],
                  ["--label", f"{c2fx.LABEL}={r.id}"], ["--mount", f"type=bind,source={r.stage / 'sock'},target=/sock"],
                  ["--mount", f"type=volume,source={r.volume},target=/var/lib/postgresql"]):
            self.assertTrue(has(f), f)
        self.assertNotIn("-p", args); self.assertNotIn("0.0.0.0", " ".join(args))
        self.assertTrue(r.container.startswith(f"enclave-c2fx-{r.id}"))

    def test_tools_get_unique_labelled_names_share_only_pg_netns_and_are_confirmed_gone(self):
        r = self.started()
        env = r.stage / "tool.env"; env.write_text("x")
        for _ in range(2):
            rc, _, _ = r.run_tool(self.bin, "migrate", env, "1000", "1000")
            self.assertEqual(rc, 0)
        runs = [c for c in self.calls() if c[:1] == ["run"] and "--rm" in c]
        self.assertEqual([c[c.index("--name") + 1] for c in runs], [f"{r.container}-tool-1", f"{r.container}-tool-2"])
        for c in runs:
            for f in (["--network", f"container:{r.container}"], ["--pull", "never"], ["--memory", "256m"], ["--memory-swap", "256m"],
                      ["--label", f"{c2fx.LABEL}={r.id}"], ["--user", "1000:1000"], ["--read-only"],
                      ["--mount", f"type=bind,source={self.bin},target=/tool,readonly=true"]):
                self.assertTrue(any(c[i:i + len(f)] == f for i in range(len(c))), f)
        ev = [(x["event"], x["name"]) for x in r.journal.records() if x.get("resource") == "tool"]
        self.assertEqual([e for e, _ in ev], ["intent", "tool-gone", "intent", "tool-gone"])
        rep = r.cleanup()
        self.assertTrue(rep["certain"], rep); self.assertEqual(self.st(), {"containers": {}, "volumes": {}}); self.assertFalse(r.stage.exists())
        self.assertEqual(set(rep["toolContainers"]["containers"].values()), {"absent"})

    def test_a_tool_left_behind_by_the_daemon_is_removed_by_label(self):
        r = self.started()
        env = r.stage / "tool.env"; env.write_text("x")
        self.fault("rm-ignored")                       # --rm did not remove it
        r.run_tool(self.bin, "migrate", env, "1", "1")
        self.fault("")
        self.assertNotIn(f"{r.container}-tool-1", self.st()["containers"])
        self.assertTrue(r.cleanup()["certain"])

    def test_lost_tool_run_response_is_resolved_by_name_and_label(self):
        r = self.started()
        env = r.stage / "tool.env"; env.write_text("x")
        self.fault("lose-run,rm-ignored")               # created, answer lost
        rc, _, _ = r.run_tool(self.bin, "migrate", env, "1", "1")
        self.fault("")
        self.assertEqual(rc, 1); self.assertNotIn(f"{r.container}-tool-1", self.st()["containers"])
        self.assertTrue(r.cleanup()["certain"])

    def test_a_foreign_container_holding_the_tool_name_is_preserved_and_keeps_the_stage(self):
        r = self.started()
        st = self.st(); st["containers"][f"{r.container}-tool-1"] = {"labels": {"someone": "else"}, "volume": None}; self.state.write_text(json.dumps(st))
        env = r.stage / "tool.env"; env.write_text("x")
        with self.assertRaises(c2fx.Unknown):
            r.run_tool(self.bin, "migrate", env, "1", "1")
        rep = r.cleanup()
        self.assertIn(f"{r.container}-tool-1", self.st()["containers"], "never removed")
        self.assertTrue(rep["toolContainers"]["containers"][f"{r.container}-tool-1"].startswith("PRESERVED"))
        self.assertFalse(rep["certain"]); self.assertTrue(r.stage.exists(), "uncertain: stage KEPT (through c2fx's own rules)")
        self.assertTrue(rep["children"].startswith("UNKNOWN: tool container(s) not confirmed gone"))

    def test_unremovable_tool_is_uncertain_then_recover_completes(self):
        r = self.started()
        env = r.stage / "tool.env"; env.write_text("x")
        self.fault("rm-ignored,rm-fails")
        with self.assertRaises(c2fx.Unknown):
            r.run_tool(self.bin, "migrate", env, "1", "1")
        rep = r.cleanup()
        self.assertFalse(rep["certain"]); self.assertTrue(r.stage.exists())
        self.fault("")
        rec = rhfx.recover(self.tmp / "runs", r.id, _Docker())
        self.assertTrue(rec["certain"], rec); self.assertFalse(r.stage.exists()); self.assertEqual(self.st(), {"containers": {}, "volumes": {}})

    def test_preexisting_pg_name_is_refused_before_anything_is_created(self):
        r = rhfx.RehearsalRun(self.tmp / "runs", _Docker(), scope=self.scope)
        self.state.write_text(json.dumps({"containers": {r.container: {"labels": {}, "volume": None}}, "volumes": {}}))
        with self.assertRaises(c2fx.Refused):
            r.begin()
        r.cleanup()
        self.assertFalse([c for c in self.calls() if c[:1] in (["run"], ["rm"]) or c[:2] in (["volume", "create"], ["volume", "rm"])])
        self.assertIn(r.container, self.st()["containers"])


if __name__ == "__main__":
    unittest.main()
