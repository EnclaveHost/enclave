#!/usr/bin/env python3
"""Source-preparation / check-mode tests of the candidate scripts/rpc-runtime/build-binaries.sh.
STUB CARGO ONLY (closure plumbing): a fake `cargo` on PATH records every call and writes placeholder files. Everything
else is real: rustc 1.96.0 --version, git archive of the real pinned commits, the real base tarball, the real patch apply
and verify-patched-tree.py. NOTHING HERE IS NATIVE VALIDATION: no Rust is compiled and no digest is meaningful.
env: CAND_TREE (candidate tree), BASE_TREE (77d6cc859 tree), HREPO, LREPO, TARBALL, TEST_TMP."""
import json, os, pathlib, shutil, stat, subprocess, tempfile, unittest
E = os.environ; CT, BT = pathlib.Path(E["CAND_TREE"]), pathlib.Path(E["BASE_TREE"]); HREPO, LREPO, TAR = E["HREPO"], E["LREPO"], E["TARBALL"]
SCRIPT = CT / "scripts/rpc-runtime/build-binaries.sh"; PATCH_SHA = "41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31"
STUB = r'''#!/bin/bash
# STUB cargo (closure plumbing only; compiles nothing)
echo "cwd=$PWD|offline=$CARGO_NET_OFFLINE|sde=${SOURCE_DATE_EPOCH:-}|home=$CARGO_HOME|target=${CARGO_TARGET_DIR:-}|args=$*" >> "$STUB_LOG"
case " $* " in *" --locked "*) ;; *) echo "stub: --locked missing" >&2; exit 64;; esac
case " $* " in *" --offline "*) ;; *) echo "stub: --offline missing" >&2; exit 64;; esac
[ "$CARGO_NET_OFFLINE" = true ] || { echo "stub: CARGO_NET_OFFLINE" >&2; exit 64; }
[ -n "${STUB_MUTATE_LOCK:-}" ] && [ "$(basename "$PWD")" = "$STUB_MUTATE_LOCK" ] && echo "# mutated" >> Cargo.lock
if [ "$1" = metadata ]; then echo '{"packages":[]}'; exit 0; fi
if [ "$1" = build ]; then
  prof=; bin=; while [ $# -gt 0 ]; do case $1 in --profile) prof=$2; shift;; --bin) bin=$2; shift;; esac; shift; done
  d=$CARGO_TARGET_DIR/$([ "$prof" = dev ] && echo debug || echo release); mkdir -p "$d"; echo "STUB $bin from $PWD" > "$d/$bin"; exit 0
fi
echo "stub: unexpected cargo $*" >&2; exit 65
'''
class Recipe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = pathlib.Path(tempfile.mkdtemp(prefix="recipe-", dir=E.get("TEST_TMP"))); b = cls.t / "stubbin"; b.mkdir()
        (b / "cargo").write_text(STUB); (b / "cargo").chmod(0o755); cls.path = f"{b}:{E['PATH']}"
        cls.ch = cls.t / "empty-cargo-home"; cls.ch.mkdir(); cls.n = 0
    @classmethod
    def tearDownClass(cls): subprocess.run(["chmod", "-R", "u+w", str(cls.t)]); shutil.rmtree(cls.t)
    def run_(self, *args, script=SCRIPT, hrepo=HREPO, lrepo=LREPO, env=None, work=None):
        Recipe.n += 1; work = work or self.t / f"w{Recipe.n}"; log = self.t / f"cargo-{Recipe.n}.log"; log.touch()
        r = subprocess.run(["bash", str(script), str(work), hrepo, lrepo, TAR, str(self.ch), *args], capture_output=True, text=True,
                           env={**E, "PATH": self.path, "STUB_LOG": str(log), **(env or {})}, timeout=900)
        calls = [dict(kv.split("=", 1) for kv in l.split("|")) for l in log.read_text().splitlines()]
        return r, calls, work
    def copy_scripts(self, name):
        d = self.t / name; shutil.copytree(CT / "scripts/rpc-runtime", d); return d
    def test_01_check_mode_exports_three_trees_applies_and_verifies_the_patch_offline(self):
        r, calls, w = self.run_("check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertIn("CLOSURE_CHECK_OK", r.stdout)
        self.assertIn(f"patch {PATCH_SHA}", r.stdout); self.assertIn("patched tree OK: 375 files of eeffcc980a4a", r.stdout + r.stderr)
        self.assertEqual([pathlib.Path(c["cwd"]).name for c in calls], ["helios", "helios-cli", "listener"])
        self.assertTrue(all(c["args"].startswith("metadata --locked --offline") and c["offline"] == "true" for c in calls))
        self.assertTrue((w / "helios/opstack/bin/witness-check.rs").is_file())          # ef320298: the helper's tree
        self.assertFalse((w / "helios-cli/opstack/bin/witness-check.rs").exists())     # eeffcc9: no helper
        self.assertTrue((w / "helios-cli/core/src/client/canonical.rs").is_file()); self.assertFalse((w / "helios/core/src/client/canonical.rs").exists())
        self.assertTrue((w / "vendor-inspect/base-v1.5.1/crates/common/evm").is_dir())
        Recipe.checked = w
    def test_02_build_plumbing_each_binary_from_its_own_tree_and_only_the_cli_gets_the_epoch(self):
        r, calls, w = self.run_("dev", "all")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr); b = json.loads((w / "BUILD.json").read_text())
        self.assertEqual(set(b["sha256"]), {"enclave-base-head-listener", "witness-check", "helios"})
        self.assertEqual(b["heliosCli"]["patchSha256"], PATCH_SHA); self.assertEqual(b["helios"], "ef3202982b475212d9bb6adfdc3eed4ebb0b83c5")
        by = {c["args"].split("--bin ")[1]: c for c in calls}
        self.assertEqual(pathlib.Path(by["helios"]["cwd"]).name, "helios-cli"); self.assertEqual(by["helios"]["sde"], "1792720709")
        self.assertEqual(pathlib.Path(by["witness-check"]["cwd"]).name, "helios"); self.assertEqual(by["witness-check"]["sde"], "")
        self.assertEqual(pathlib.Path(by["enclave-base-head-listener"]["cwd"]).name, "listener"); self.assertEqual(by["enclave-base-head-listener"]["sde"], "")
        self.assertTrue(by["helios"]["target"].endswith("/target-helios-cli"))
        self.assertIn("--profile dev", by["helios"]["args"])
    def refused(self, r, calls, w, msg):
        self.assertNotEqual(r.returncode, 0, r.stdout); self.assertIn(msg, r.stdout + r.stderr); self.assertEqual(calls, [], "cargo was called")
    def test_03_tampered_patch_refused_before_any_export(self):
        d = self.copy_scripts("tp"); p = d / "canonical-block.patch"; b = bytearray(p.read_bytes()); b[-2] ^= 1; p.write_bytes(bytes(b))
        r, c, w = self.run_("check", script=d / "build-binaries.sh"); self.refused(r, c, w, "canonical-block.patch is not"); self.assertFalse(w.exists())
    def test_04_tampered_manifest_refused(self):
        d = self.copy_scripts("tm"); p = d / "canonical-block.PATCHED.sha256"; p.write_text(p.read_text().replace("1c1c", "1c1d", 1))
        r, c, w = self.run_("check", script=d / "build-binaries.sh"); self.refused(r, c, w, "canonical-block.PATCHED.sha256 is not")
    def test_05_wrong_helios_and_listener_repositories_refused(self):
        e = self.t / "empty-repo"; subprocess.run(["git", "init", "-q", str(e)], check=True)
        r, c, w = self.run_("check", hrepo=str(e)); self.refused(r, c, w, "does not have tree")
        r, c, w = self.run_("check", lrepo=HREPO); self.refused(r, c, w, "does not have tree")
    def test_06_a_changed_lock_is_refused_in_check_and_build(self):
        for prof, d in [("check", "helios-cli"), ("dev", "helios-cli"), ("check", "helios"), ("dev", "listener")]:
            r, c, w = self.run_(prof, env={"STUB_MUTATE_LOCK": d}); self.assertNotEqual(r.returncode, 0, (prof, d)); self.assertIn(f"{d} Cargo.lock changed", r.stdout + r.stderr)
    def test_07_patched_tree_verifier_rejects_any_drift(self):
        w = getattr(Recipe, "checked", None); self.assertIsNotNone(w, "test_01 must run first")
        v = CT / "scripts/rpc-runtime/verify-patched-tree.py"; m = CT / "scripts/rpc-runtime/canonical-block.PATCHED.sha256"
        def ver(tree): return subprocess.run(["python3", "-I", str(v), HREPO, "eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e", str(tree), str(m)], capture_output=True, text=True)
        def fresh(n): t = self.t / n; shutil.copytree(w / "helios-cli", t, symlinks=True); return t
        self.assertEqual(ver(fresh("ok")).returncode, 0)
        t = fresh("unpatched-edit"); (t / "cli/src/main.rs").write_text((t / "cli/src/main.rs").read_text() + "//x\n"); self.assertEqual(ver(t).returncode, 6)
        t = fresh("patched-edit"); (t / "core/src/client/canonical.rs").write_text("x"); self.assertEqual(ver(t).returncode, 6)
        t = fresh("extra"); (t / "core/src/extra.rs").write_text("x"); self.assertEqual(ver(t).returncode, 6)
        t = fresh("missing"); (t / "Cargo.toml").unlink(); self.assertEqual(ver(t).returncode, 6)
        t = fresh("mode"); (t / "Cargo.toml").chmod(0o755); self.assertEqual(ver(t).returncode, 6)
        t = fresh("unpatched"); shutil.rmtree(t); subprocess.run(f"mkdir -p {t} && git -C {HREPO} archive eeffcc9 | tar -x -C {t}", shell=True, check=True)
        self.assertEqual(ver(t).returncode, 6, "the UNPATCHED eeffcc9 tree must not pass")
    def test_08_bad_arguments_and_nonempty_work_refused(self):
        r, c, w = self.run_("fast"); self.refused(r, c, w, "profile must be")
        r, c, w = self.run_("dev", "everything"); self.refused(r, c, w, "binary must be")
        nw = self.t / "nonempty"; nw.mkdir(); (nw / "f").touch(); r, c, w = self.run_("check", work=nw); self.refused(r, c, w, "must be new or empty")
    def test_09_static_no_download_and_old_listener_helper_lines_preserved(self):
        s, b = SCRIPT.read_text(), (BT / "scripts/rpc-runtime/build-binaries.sh").read_text()
        for bad in ("curl", "wget", "http://", "https://", "fetch", "git clone", "rustup install", "toolchain install"): self.assertNotIn(bad, "\n".join(l for l in s.splitlines() if not l.lstrip().startswith("#")))
        for keep in ["[[ $ONLY == all || $ONLY == listener ]] && build listener enclave-base-head-listener -p enclave-base-head-listener --bin enclave-base-head-listener",
                     "[[ $ONLY == all || $ONLY == witness-check ]] && build helios witness-check -p helios-opstack --bin witness-check",
                     "export_tree \"$HREPO\" $HELIOS $HELIOS_TREE \"$WORK/helios\"", "export_tree \"$LREPO\" $LISTENER $LISTENER_TREE \"$WORK/listener\"",
                     "HELIOS=ef3202982b475212d9bb6adfdc3eed4ebb0b83c5 HELIOS_TREE=eec339e18296d850a514f72de2efdd8729302efd",
                     "LISTENER=5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7 LISTENER_TREE=00e3a61d48c91a6072355bf0ac67564490a6fc8b"]:
            self.assertIn(keep, b); self.assertIn(keep, s)
        self.assertNotIn("build helios helios -p helios-cli", s); self.assertIn("build helios-cli helios -p helios-cli --bin helios", s)
    def test_10_closure_and_docs_agree_with_the_script_pins(self):
        c = json.loads((CT / "scripts/rpc-runtime/closure.json").read_text()); s = SCRIPT.read_text(); cli = c["sources"]["heliosCli"]
        for v in (cli["commit"], cli["tree"], cli["cargoLockSha256"], cli["patch"]["sha256"], cli["patchedManifest"]["sha256"], str(cli["sourceDateEpoch"])): self.assertIn(v, s)
        self.assertEqual(c["sources"]["helios"]["binaries"], {"witnessCheck": "-p helios-opstack --bin witness-check"})
        import hashlib
        self.assertEqual(hashlib.sha256((CT / cli["patch"]["file"]).read_bytes()).hexdigest(), cli["patch"]["sha256"])
        self.assertEqual(hashlib.sha256((CT / cli["patchedManifest"]["file"]).read_bytes()).hexdigest(), cli["patchedManifest"]["sha256"])
        self.assertIn("no identical-hash claim", " ".join((CT / "docs/network/local-chain-verifier.md").read_text().split()))
        self.assertEqual(c["tested"]["helios"], "8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378")
    def test_11_the_77d6cc859_script_is_the_gap_control(self):
        r, calls, w = self.run_("check", script=BT / "scripts/rpc-runtime/build-binaries.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse((w / "helios-cli").exists()); self.assertFalse((w / "helios/core/src/client/canonical.rs").exists())   # the old recipe builds the CLI unpatched
if __name__ == "__main__": unittest.main(verbosity=2)
