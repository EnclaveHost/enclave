#!/usr/bin/env python3
"""r3 controller: the explicit trusted-service-group exception for config_file, and no global relaxation.
Files are real temp files with real modes. The passwd/group databases are injected fakes, so 'root' and
'enclave-indexd' map onto this test user's own uid/gid; one test uses the REAL databases through the CLI.
The original ce63951e controller is the negative control: it refuses the production 0640 model."""
import grp, importlib.util, json, os, pathlib, pwd, subprocess, sys, tempfile, unittest
from types import SimpleNamespace as NS
H = pathlib.Path(__file__).resolve().parent
ORIG = H.parents[3] / "indexd-c2-implementation" / "package" / "controller" / "replicactl.py"     # ce63951e, read-only
def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
C, O = load("rc3", H / "replicactl.py"), load("rc0", ORIG)
UID, GID = os.getuid(), os.getgid()
SPEC = {"mode": "0640", "owner": "root", "group": "enclave-indexd", "group_members": [], "group_primary_users": ["enclave-indexd"]}

def lookups(members=(), primary=("enclave-indexd",), gid=GID, owner_uid=UID):
    users = {"root": NS(pw_name="root", pw_uid=owner_uid, pw_gid=0)}
    def getpwnam(n):
        if n not in users: raise KeyError(n)
        return users[n]
    def getgrnam(n):
        if n != "enclave-indexd": raise KeyError(n)
        return NS(gr_name=n, gr_gid=gid, gr_mem=list(members))
    def getpwall(): return [NS(pw_name="root", pw_uid=owner_uid, pw_gid=0)] + [NS(pw_name=u, pw_uid=2000 + i, pw_gid=gid) for i, u in enumerate(primary)]
    return {"getgrnam": getgrnam, "getpwnam": getpwnam, "getpwall": getpwall}

class Access(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory(prefix="r3-access-"); self.d = pathlib.Path(self.t.name) / "etc"; self.d.mkdir(mode=0o755)
        os.chmod(self.d, 0o755)
        self.cfg = self.d / "indexd.yml"; self.cfg.write_text("directory: /x\n"); os.chmod(self.cfg, 0o640)
        self.pw = self.d / "admin.pw"; self.pw.write_text("x\n"); os.chmod(self.pw, 0o600)
    def tearDown(self): self.t.cleanup()
    def node(self, mod, access=SPEC):
        p = {"config_file": str(self.cfg), "admin_password_file": str(self.pw)}
        if access is not None: p["config_file_access"] = access
        n = mod.Node.__new__(mod.Node); n.p = p; return n

    def test_production_model_accepted_only_with_explicit_profile_entry(self):
        self.assertEqual(C.check_secret_modes(self.node(C), **lookups()), [])
        self.assertEqual(C.check_secret_modes(self.node(C, access=None)), ["config_file mode 0o640"], "no entry -> the strict rule, unchanged")
        self.assertEqual(O.check_secret_modes(self.node(O, access=None)), ["config_file mode 0o640"], "negative control: ce63951e refuses production")

    def test_strict_files_still_pass_without_entry(self):
        os.chmod(self.cfg, 0o600); self.assertEqual(C.check_secret_modes(self.node(C, access=None)), [])

    def test_admin_password_file_stays_strict(self):
        for m in (0o640, 0o660, 0o604):
            os.chmod(self.pw, m)
            with self.subTest(mode=oct(m)):
                bad = C.check_secret_modes(self.node(C), **lookups())
                self.assertEqual(bad, [f"admin_password_file mode {oct(m)}"])

    def test_mode_variants_refused(self):
        for m in (0o600, 0o644, 0o660, 0o650, 0o740, 0o641, 0o440, 0o2640, 0o1640):
            os.chmod(self.cfg, m)
            with self.subTest(mode=oct(m)):
                bad = C.check_secret_modes(self.node(C), **lookups()); self.assertTrue(any("mode" in b for b in bad), bad)

    def test_ownership_and_group_restriction(self):
        cases = [("owner differs", lookups(owner_uid=UID + 1), "owner uid"),
                 ("gid differs", lookups(gid=GID + 1), "group gid"),
                 ("supplementary member", lookups(members=("steven",)), "supplementary members"),
                 ("another primary user", lookups(primary=("enclave-indexd", "other")), "primary group"),
                 ("service not primary", lookups(primary=()), "primary group")]
        for what, lk, want in cases:
            with self.subTest(what):
                bad = C.check_secret_modes(self.node(C), **lk); self.assertTrue(any(want in b for b in bad), bad)
        if GID != 0:
            self.assertTrue(any("gid 0" in b for b in C.check_trusted_group_access(str(self.cfg), SPEC, **lookups(gid=0))))
        self.assertEqual(C.check_trusted_group_access(str(self.cfg), dict(SPEC, group="nogroup"), **lookups()), ["config_file access facts unavailable: KeyError"])
        self.assertEqual(C.check_trusted_group_access(str(self.cfg), dict(SPEC, owner="nobody-x"), **lookups()), ["config_file access facts unavailable: KeyError"])

    def test_service_owner_refused(self):
        for spec in (dict(SPEC, owner="enclave-indexd"), dict(SPEC, owner="steven", group_members=["steven"])):
            with self.subTest(owner=spec["owner"]):
                bad = C.check_trusted_group_access(str(self.cfg), spec, **lookups()); self.assertIn("is in the reader group", bad[0])

    def test_file_shape(self):
        link = self.d / "link.yml"; link.symlink_to(self.cfg)
        self.assertTrue(any("regular file" in b for b in C.check_trusted_group_access(str(link), SPEC, **lookups())))
        hard = self.d / "hard.yml"; os.link(self.cfg, hard)
        self.assertTrue(any("hard links" in b for b in C.check_trusted_group_access(str(self.cfg), SPEC, **lookups())))
        hard.unlink()
        for m in (0o775, 0o757, 0o777):
            os.chmod(self.d, m)
            with self.subTest(dir=oct(m)): self.assertTrue(any("config directory" in b for b in C.check_trusted_group_access(str(self.cfg), SPEC, **lookups())))
        os.chmod(self.d, 0o755)
        self.assertTrue(any("config directory" in b for b in C.check_trusted_group_access(str(self.cfg), SPEC, **lookups(owner_uid=UID + 1))))
        missing = self.d / "absent.yml"
        self.assertEqual(C.check_trusted_group_access(str(missing), SPEC, **lookups()), ["config_file access facts unavailable: FileNotFoundError"])

    def test_malformed_profile_entry(self):
        for spec in ({}, dict(SPEC, mode="0600"), dict(SPEC, mode=0o640), dict(SPEC, extra=1), {k: v for k, v in SPEC.items() if k != "group_members"},
                     dict(SPEC, group_members="none"), dict(SPEC, owner=""), dict(SPEC, group_primary_users=[""]), "0640", None and {}):
            with self.subTest(spec=spec):
                bad = C.check_trusted_group_access(str(self.cfg), spec, **lookups()); self.assertTrue(bad and "config_file_access must be" in bad[0], bad)

    def test_placeholder_check_kept(self):
        self.cfg.write_text("password: CHANGE_ME\n"); os.chmod(self.cfg, 0o640)
        self.assertEqual(C.check_secret_modes(self.node(C), **lookups()), ["config_file still has placeholders"])

    def cli_preflight(self, spec, userns=False):
        geo = pathlib.Path(self.t.name) / "state"; geo.mkdir(exist_ok=True)
        prof = pathlib.Path(self.t.name) / "p.json"
        prof.write_text(json.dumps({"runner": "process", "state_dir": str(geo), "release_dir": str(geo), "config_file": str(self.cfg),
                                    "admin_password_file": str(self.pw), "geoip_sha256": "0" * 64, "config_file_access": spec}))
        argv = [sys.executable, "-B", str(H / "replicactl.py"), "--profile", str(prof), "preflight"]
        if userns: argv = ["unshare", f"--map-user=0", f"--map-group={GID}"] + argv      # this uid appears as 0 (root); gid unchanged
        r = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout); self.assertEqual(r.returncode, 1); self.assertIn("geoip", out["failures"])   # no GeoLite in the temp dir
        return out["checks"]["secretModes"]

    def test_real_databases_accept_root_owned_0640_private_group(self):
        # REAL passwd/group databases (no fakes). In a user namespace this test's files are owned by "root" (uid 0) and keep
        # this user's private group, i.e. the production shape root:<service private group> 0640.
        g = grp.getgrgid(GID); primary = sorted(u.pw_name for u in pwd.getpwall() if u.pw_gid == GID)
        spec = {"mode": "0640", "owner": "root", "group": g.gr_name, "group_members": sorted(g.gr_mem), "group_primary_users": primary}
        got = self.cli_preflight(spec, userns=True)
        # review-access: inside the user namespace, the real-root ancestors (/, /tmp) appear as the overflow uid 65534, so the
        # proposed ancestor check refuses exactly those. On a real host, as root, they are uid 0. Nothing else may differ.
        self.assertTrue(got == "ok" or (got and all("config path ancestor" in b and "owner uid 65534" in b for b in got)), got)
        bad = self.cli_preflight(dict(spec, group_primary_users=primary + ["zz-not-there"]), userns=True)
        self.assertTrue(any("primary group" in b for b in bad), bad)
        bad = self.cli_preflight(spec)                     # outside the namespace the file owner is this user, not root
        self.assertTrue(any("owner uid" in b for b in bad), bad)

if __name__ == "__main__": unittest.main()
