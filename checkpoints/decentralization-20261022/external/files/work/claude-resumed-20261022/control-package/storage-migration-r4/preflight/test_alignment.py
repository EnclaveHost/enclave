#!/usr/bin/env python3
"""r4 alignment: the preflight facts and evaluator rules (config.acl, config.path_components) must reach the same accept/refuse
decision as the r4 controller's config_file_access check on the SAME real filesystem layout.
- Facts come from the preflight's own shell readers (vm-preflight.sh r_acl/r_components, sourced), run with real stat, xattrs
  and setfacl on temp layouts.
- The controller sees the same paths. Its passwd/group lookups are r3 test_access.py's fakes: owner 'root' = this test user,
  and the evaluator is told the same owner uid. Real /tmp and / are real root (uid 0) for both.
The r3 controller is the old negative control: it accepts G1-G3."""
import importlib.util, os, pathlib, shutil, subprocess, tempfile, unittest
H = pathlib.Path(__file__).resolve().parent
def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
E = load("ev4", H / "evaluate-preflight.py")
C4 = load("c4", H.parent / "controller" / "replicactl.py")
C3 = load("c3", H.parents[1] / "storage-migration-r3" / "controller" / "replicactl.py")
T = load("t3", H.parents[1] / "storage-migration-r3" / "controller" / "test_access.py")
UID = str(os.getuid())

def facts(conf):
    p = subprocess.run(["bash", "-c", '. "$0"; CUR_T=10; echo "acl=$(r_acl "$1")"; echo "comp=$(r_components "$1" | paste -sd, -)"', str(H / "vm-preflight.sh"), str(conf)],
                       env={"PREFLIGHT_SOURCE_ONLY": "1", "PATH": "/usr/bin:/bin"}, capture_output=True, text=True, timeout=60)
    return dict(l.split("=", 1) for l in p.stdout.splitlines())

def evaluator_refuses(conf):
    f = facts(conf)
    problems = E.path_component_problems(f["comp"], conf_dir=os.path.dirname(str(conf)), owner_uid=UID)
    assert problems is not None, f
    return f["acl"] == "present" or bool(problems), f

def controller_refuses(mod, conf):
    bad = mod.check_trusted_group_access(str(conf), T.SPEC, **T.lookups())
    return any(k in b for b in bad for k in ("ACL", "config path", "config directory", "regular file")), bad

class Alignment(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix="r4-align-")); os.chmod(self.t, 0o755)
    def tearDown(self): shutil.rmtree(self.t)
    def make(self, base):
        d = base / "etc-enclave-indexd"; d.mkdir(parents=True); os.chmod(d, 0o755)
        f = d / "indexd.yml"; f.write_text("x: 1\n"); os.chmod(f, 0o640); return f

    def layouts(self):
        yield "clean", self.make(self.t / "clean"), False, False
        f = self.make(self.t / "acl")
        if shutil.which("setfacl") and subprocess.run(["setfacl", "-m", "u:nobody:r", str(f)]).returncode == 0: yield "G1 read ACL", f, True, True
        real = self.make(self.t / "real").parent; link = self.t / "link"; link.symlink_to(real)
        yield "G2 symlinked config dir", link / "indexd.yml", True, True
        a = self.t / "open"; a.mkdir(); f = self.make(a); os.chmod(a, 0o777); yield "G3 writable ancestor", f, True, True
        a = self.t / "sticky"; a.mkdir(); f = self.make(a); os.chmod(a, 0o1777); yield "sticky ancestor not root-owned", f, True, True
        f = self.make(self.t / "gw"); os.chmod(f.parent, 0o775); yield "config dir group-writable", f, True, False
        f = self.make(self.t / "st"); os.chmod(f.parent, 0o1755); yield "config dir sticky (no write bits)", f, False, False

    def test_same_decision(self):
        for name, conf, want, r3_misses in self.layouts():
            with self.subTest(name):
                ev, f = evaluator_refuses(conf); c4, bad4 = controller_refuses(C4, conf); c3, bad3 = controller_refuses(C3, conf)
                self.assertEqual(ev, want, (f, bad4)); self.assertEqual(c4, want, bad4)
                if r3_misses: self.assertFalse(c3, ("old negative control: r3 accepts", bad3))
                print(f"{name}: evaluator={'REFUSE' if ev else 'ACCEPT'} r4={'REFUSE' if c4 else 'ACCEPT'} r3={'REFUSE' if c3 else 'ACCEPT'} facts={f}", flush=True)

if __name__ == "__main__": unittest.main()
