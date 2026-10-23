"""Compare the workspace Cargo.lock with the pinned upstream base/base Cargo.lock.

Prints every package (name, version, source, checksum) present in the workspace
lock but not identical in the upstream lock. Expected: only the workspace's own
crate (no registry/git version drift).
"""
import json, sys, tomllib
up = tomllib.load(open(sys.argv[1], "rb"))["package"]
ws = tomllib.load(open(sys.argv[2], "rb"))["package"]
key = lambda p: (p["name"], p["version"], p.get("source"), p.get("checksum"))
upk = {key(p) for p in up}
new = [key(p) for p in ws if key(p) not in upk]
print(json.dumps({"workspacePackages": len(ws), "upstreamPackages": len(up),
                  "notIdenticalToUpstream": new}, indent=1))
