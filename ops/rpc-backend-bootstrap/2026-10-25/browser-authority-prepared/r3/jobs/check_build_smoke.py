#!/usr/bin/env python3
"""check_build_smoke.py <legacy-clone> <own-clone> <out.json>: after root's private site builds (scripts/build-site.mjs,
legacy and --read-authority fixture), check the OWN dist embeds the fixture authority (its placeholder host appears in
the built JS) and the LEGACY dist does not; index every dist file (sha256); list each clone's git status (tracked build
outputs that differ from the commit are reported as DRIFT, an observation for review, not hidden)."""
import hashlib, json, pathlib, subprocess, sys
legacy, own, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
MARK = "rpc-a.own-node.example"
fails = []
def index(root):
    d = root / "site" / "dist"
    if not d.is_dir(): fails.append(f"{d} missing"); return {}, False
    files = {str(p.relative_to(d)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(d.rglob("*")) if p.is_file()}
    hit = any(MARK.encode() in p.read_bytes() for p in d.rglob("*.js") if p.is_file())
    return files, hit
lf, lhit = index(legacy); of, ohit = index(own)
if not ohit: fails.append("own-rpc dist does not embed the fixture authority")
if lhit: fails.append("legacy dist carries the fixture authority")
if not lf or not of: fails.append("a dist is empty")
status = {str(r): subprocess.run(["git", "-C", str(r), "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True).stdout.splitlines() for r in (legacy, own)}
res = {"legacyDistFiles": len(lf), "ownDistFiles": len(of), "ownEmbedsFixture": ohit, "legacyEmbedsFixture": lhit,
       "distIndex": {"legacy": lf, "own": of}, "gitStatusAfterBuild": status, "failures": fails}
json.dump(res, open(out, "w"), indent=1)
print(f"## build smoke: legacy {len(lf)} files, own {len(of)} files, own embeds fixture {ohit}, legacy embeds {lhit}, failures {len(fails)}")
for r, s in status.items(): print(f"## DRIFT/STATUS {r}: {len(s)} entries" + (": " + "; ".join(s[:8]) if s else ""))
sys.exit(1 if fails else 0)
