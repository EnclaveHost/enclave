#!/usr/bin/env python3
"""Cross-consistency check of this receipt package against the build's own outputs, the local pinned inputs and git.

READ-ONLY: it builds nothing and measures nothing; it recomputes hashes and compares records. Every local path is an
argument (they are this build host's paths; see RECIPE.md - the package is NOT portable without them).
  check-package.py PKG IMAGE_STAGE SOURCE_REPO CLONE_REPO BASE OVMF KEPT_DIST CHAIN_VERIFIER_INPUTS
"""
import hashlib, json, re, subprocess, sys
from pathlib import Path

PKG, STAGE, SRC, CLONE, BASE, OVMF, KEPT, V = (Path(a) for a in sys.argv[1:9])
C = "0235e7d9659f1ccbf9f258bd03593d26f32f3f3a"
TREE = "d36f220ab4258b91c6f909d720ef18ce21f73cbc"
MEAS = "4287b65e718ff958027f31beec6a0753d42784086807b950f557a963cd0277f33c9869173420f03f5fb53e4ad2859be9"
res = []
def check(name, ok, detail=""):
    res.append((name, bool(ok), detail)); print(("ok   " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
def git(repo, *a): return subprocess.run(["git", "-C", str(repo), *a], capture_output=True, check=True).stdout
def text(p): return Path(p).read_text()

# 1. the package's copies equal the stage's originals (no edited receipt or tool)
pairs = [(PKG / "tools" / n, STAGE / "tools" / n) for n in sorted(p.name for p in (PKG / "tools").iterdir())]
pairs += [(PKG / "receipts" / s / n.name, n) for s in ("build-a", "build-b") for n in sorted((STAGE / "receipts" / s).iterdir())]
pairs += [(PKG / "receipts" / n, STAGE / "receipts" / n) for n in ("image-verify-direct.json", "measurement-B.txt", "0235e7d96-fixpoint.patch")]
pairs += [(PKG / "artifacts" / n, STAGE / "out" / f"dist-direct-0235e7d96-a" / n) for n in ("MEASUREMENT", "cmdline", "manifest.json")]
bad = [str(a.relative_to(PKG)) for a, b in pairs if sha(a) != sha(b)]
check(f"package copies == stage originals ({len(pairs)} files)", not bad, ", ".join(bad))
logs = sorted((PKG / "logs").iterdir())
check(f"package logs == work logs ({len(logs)} files)", all(sha(p) == sha(STAGE.parent / "logs" / p.name) for p in logs))

# 2. artifacts A and B: receipts equal, files on disk equal the receipts, A == B
ra, rb = text(PKG / "receipts/build-a/artifacts.sha256"), text(PKG / "receipts/build-b/artifacts.sha256")
check("build-a artifacts.sha256 == build-b artifacts.sha256", ra == rb, hashlib.sha256(ra.encode()).hexdigest()[:8])
want = dict(reversed(l.split()) for l in ra.splitlines() if l.strip())
for side in "ab":
    d = STAGE / "out" / f"dist-direct-0235e7d96-{side}"
    got = {n: sha(d / n) for n in want}
    check(f"out/{side}: every artifact on disk == receipt (5 files)", got == want, ",".join(n for n in want if got[n] != want[n]))
check("initramfs sha256 = 3720a663", want.get("initramfs.cpio.gz", "").startswith("3720a6637ce43018"))
check("vmlinuz == production base vmlinuz", want.get("vmlinuz") == sha(BASE / "vmlinuz"))

# 3. one measurement everywhere
m = {"artifact MEASUREMENT": text(PKG / "artifacts/MEASUREMENT").strip(), "measurement-B.txt": text(PKG / "receipts/measurement-B.txt").strip()}
for n in ("attimg3-b1a.out", "attimg3-b1b.out", "attimg3-v1.out"):
    f = re.findall(r"\[measure [AB](?:/[ab])?\] ([0-9a-f]{96})", text(PKG / "logs" / n)); m[n] = f[-1] if f else None
check("the measurement agrees in artifact, receipt and the three job logs", set(m.values()) == {MEAS}, json.dumps({k: (v or "")[:8] for k, v in m.items()}))
append = text(PKG / "artifacts/cmdline").replace("${MODE}", "snp").strip()
check("cmdline = base template + ' metal.control=direct'", text(PKG / "artifacts/cmdline").strip() == text(BASE / "cmdline").strip() + " metal.control=direct", append)

# 4. the independent verifier's own record
j = json.loads(text(PKG / "receipts/image-verify-direct.json"))
checks = j.get("checks", [])
okc = [c for c in checks if (c.get("ok") if isinstance(c, dict) else c[1])]
check("verifier record: ok, commit, 45/45 checks", j.get("ok") is True and j.get("commit") == C and len(checks) == 45 and len(okc) == 45, f"{len(okc)}/{len(checks)}")
for k, path in (("hostAdmissionBundle", "windows/node/host-admission.bundle.mjs"), ("hostPolicyBundle", "metal/guest/host-policy.bundle.mjs")):
    check(f"verifier {k} == git {C[:9]}:{path}", j.get(k) == hashlib.sha256(git(SRC, "show", f"{C}:{path}")).hexdigest(), j.get(k, "")[:8])

# 5. both overlay unittests: 19 tests, OK, no skip
for s in "ab":
    t = text(PKG / f"receipts/build-{s}/overlay-unittest.out")
    check(f"build-{s} overlay unittest: Ran 19, OK, no skip", re.search(r"^Ran 19 tests", t, re.M) and re.search(r"^OK\s*$", t, re.M) and "skip" not in t.replace("Ran ", "").lower())

# 6. job results
for n, marker in (("attimg3-g0", "CLONE-OK"), ("attimg3-b1a", "BUILD-OK-a"), ("attimg3-b1b", "BUILD-OK-b"), ("attimg3-v1", "VERIFY-OK")):
    rc, out = text(PKG / "logs" / f"{n}.rc").strip(), text(PKG / "logs" / f"{n}.out")
    check(f"{n}: rc 0, {marker}, loopback-only namespace proved, 0 ssh", rc == "0" and marker in out and "interfaces = lo only" in out and "no ssh/scp/sftp invocation (0)" in out)
g0 = text(PKG / "logs/attimg3-g0.out")
check("g0: fixpoint patch empty", (PKG / "receipts/0235e7d96-fixpoint.patch").stat().st_size == 0)

# 7. the rebuilt bundles == the committed blobs (so the package records hashes, not copies)
tree = git(SRC, "ls-tree", "-r", C).decode().splitlines()
blobs = {l.split("\t")[1]: l.split()[2] for l in tree}
rebuilt = dict(reversed(l.split()) for l in text(PKG / "receipts/p2-rebuilt-final.sha256").splitlines() if l.strip())
miss = []
for name, h in rebuilt.items():
    paths = [p for p in blobs if p.endswith("/" + name)]
    if len(paths) != 1 or hashlib.sha256(git(SRC, "cat-file", "blob", blobs[paths[0]])).hexdigest() != h: miss.append(name)
check(f"p2 rebuilt bundles == committed blobs at {C[:9]} ({len(rebuilt)} files)", not miss, ",".join(miss))

# 8. the source is locatable and is what was built
check("source repo (c0's REPO) holds the commit with the recorded tree", git(CLONE, "rev-parse", f"{C}^{{tree}}").decode().strip() == TREE)
check("attested-verifier-source holds the commit with the recorded tree", git(SRC, "rev-parse", f"{C}^{{tree}}").decode().strip() == TREE)
rt = git(SRC, "branch", "-r", "--contains", C).decode().split()
check("a remote-tracking branch contains the commit (last fetch; the remote itself not contacted)", any("fix/rpc-attested-verifier-20261025" in r for r in rt), " ".join(rt))
check("overlay tool at the commit sha256 10db3d3d (as the reviewed ec56 build)", hashlib.sha256(git(SRC, "show", f"{C}:metal/overlay-control-image.py")).hexdigest().startswith("10db3d3d"))

# 9. local pinned inputs still present with the recorded bytes (this host only)
for p, h in ((BASE / "manifest.json", "cc2571bb5b0c85b5"), (BASE / "initramfs.cpio.gz", "516d766d9e31f07c"), (BASE / "vmlinuz", "1a3a02d5a982946e"),
             (OVMF, "142589cc4882f29a"), (KEPT / "initramfs.cpio.gz", "c190c040485974a8")):
    check(f"local input {p.name} ({p.parent.name}) sha256 {h}", p.exists() and sha(p).startswith(h))
pins = dict(reversed(l.split()) for l in text(V / "PINS.sha256").splitlines() if l.strip())
check(f"chain-verifier-inputs PINS.sha256 ({len(pins)} natives) verify", all(sha(V / n) == h for n, h in pins.items()), hashlib.sha256((V / "PINS.sha256").read_bytes()).hexdigest()[:8])

fails = [n for n, ok, _ in res if not ok]
print(f"\nPACKAGE-CHECK {len(res) - len(fails)}/{len(res)} {'OK' if not fails else 'FAIL'}")
sys.exit(1 if fails else 0)
