#!/usr/bin/env python3
"""Offline dependency verification (no network, no cargo): every package in CARGO_LOCK is satisfiable from CARGO_HOME.
  registry (crates.io) packages: registry/cache/*/<name>-<version>.crate exists and its sha256 == the lockfile checksum
  git packages: the locked commit exists as a commit in a staged bare repo under git/db
  every staged bare repo: `git fsck --full --strict` must succeed (git/checkouts is NOT staged: cargo rebuilds checkouts
  offline from these pinned commits)
  path/workspace packages (no source): skipped by definition (they are in the source tree itself).
Any git command error is a failure (never treated as empty output). Prints JSON; exit 0 only if no problem.
Usage: verify-deps.py Cargo.lock CARGO_HOME"""
import glob, hashlib, json, os, subprocess, sys, tomllib
lock, home = sys.argv[1], sys.argv[2]
pk = tomllib.load(open(lock, "rb"))["package"]
crates = {}
for p in glob.glob(os.path.join(home, "registry/cache/*/*.crate")): crates.setdefault(os.path.basename(p), []).append(p)
dbs = sorted(glob.glob(os.path.join(home, "git/db/*")))
env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
bad = []
def git(d, *a, stdin=None):
    r = subprocess.run(["git", "-C", d, *a], env=env, input=stdin, capture_output=True, text=True)
    if r.returncode != 0: bad.append(f"git {' '.join(a[:2])} failed in {os.path.basename(d)} (rc {r.returncode}): {r.stderr.strip()[:200]}")
    return r.returncode == 0, r.stdout
def h(p):
    with open(p, "rb") as f: return hashlib.file_digest(f, "sha256").hexdigest()
fsck = {}
for d in dbs:
    okb, out = git(d, "rev-parse", "--is-bare-repository")
    if not okb or out.strip() != "true": bad.append(f"not a bare repository: {d}"); continue
    okf, _ = git(d, "fsck", "--full", "--strict", "--no-progress", "--no-dangling"); fsck[os.path.basename(d)] = okf
reg = path = 0; revs = {}
for p in pk:
    s = p.get("source")
    if not s: path += 1; continue
    if s.startswith("registry+"):
        reg += 1; f = f"{p['name']}-{p['version']}.crate"; c = p.get("checksum"); hits = crates.get(f, [])
        if not hits: bad.append(f"missing crate {f}")
        elif not c or not any(h(x) == c for x in hits): bad.append(f"checksum mismatch {f}")
    elif s.startswith("git+"): revs.setdefault(s.rsplit("#", 1)[-1], []).append(p["name"])
    else: bad.append(f"unknown source kind {p['name']} {s}")
found = set()
for d in dbs:
    if not fsck.get(os.path.basename(d)): continue
    okc, out = git(d, "cat-file", "--batch-check", stdin="".join(r + "^{commit}\n" for r in revs))
    if okc:
        for line, r in zip(out.splitlines(), revs):
            if line.split()[1:2] == ["commit"] and line.split()[0] == r: found.add(r)
for r, names in revs.items():
    if r not in found: bad.append(f"missing git commit {r} ({', '.join(sorted(set(names)))})")
print(json.dumps({"lock": os.path.abspath(lock), "lockSha256": h(lock), "registryPackages": reg,
                  "gitPackages": sum(len(v) for v in revs.values()), "gitCommits": len(revs), "pathPackages": path,
                  "gitDbs": len(dbs), "fsckFullStrict": fsck, "problems": bad}, indent=1))
sys.exit(1 if bad else 0)
