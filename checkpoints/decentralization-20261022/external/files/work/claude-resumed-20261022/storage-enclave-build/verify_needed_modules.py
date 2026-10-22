#!/usr/bin/env python3
"""For the modules a tree's build+tests actually use (go list -deps -test), check that the module cache holds each one and
that its cached .ziphash equals the go.sum h1 line (what `go mod verify` checks, limited to the needed set).
  verify_needed_modules.py <tree>   (env: GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=readonly, GOCACHE set)"""
import os, re, subprocess, sys
tree = sys.argv[1]
modcache = subprocess.run(["go", "env", "GOMODCACHE"], capture_output=True, text=True, check=True).stdout.strip()
out = subprocess.run(["taskset", "-c", "0-1", "go", "list", "-deps", "-test", "-f", "{{with .Module}}{{.Path}} {{.Version}}{{end}}", "./cmd/...", "./contracts/..."],
                     cwd=tree, capture_output=True, text=True, check=True).stdout
mods = sorted({tuple(l.split()) for l in out.splitlines() if len(l.split()) == 2})
gosum = {}
for l in open(os.path.join(tree, "go.sum")):
    p, v, h = l.split()
    if not v.endswith("/go.mod"): gosum[(p, v)] = h
esc = lambda s: re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), s)
bad = []
for p, v in mods:
    zh = os.path.join(modcache, "cache", "download", esc(p), "@v", esc(v) + ".ziphash")
    if not os.path.exists(zh): bad.append(f"{p}@{v}: not in the module cache"); continue
    got = open(zh).read().strip()
    if gosum.get((p, v)) != got: bad.append(f"{p}@{v}: cache {got} != go.sum {gosum.get((p, v))}")
    if not os.path.isdir(os.path.join(modcache, esc(p) + "@" + esc(v))): bad.append(f"{p}@{v}: extracted module dir missing")
print(f"{len(mods)} needed modules (build+tests of ./cmd/... ./contracts/...); {len(mods) - len(bad)} verified against go.sum")
for b in bad: print("BAD", b)
sys.exit(1 if bad else 0)
