#!/usr/bin/env python3
"""STATIC import-to-bundle dependency graph of the composed generators (git objects only; nothing built or executed).
Each generator's entry modules are scanned transitively (static/dynamic import, export-from; relative specifiers resolved
like node/esbuild: exact, +.mjs/.js/.cjs, /index.*). Reaching a GENERATED output adds an edge producer -> consumer and is not
descended. Cross-check: every committed manifest's recorded inputs (esbuild metafile) that are generated outputs. Prints
the edges, both evidence sources, any cycle (exit 2), and the topological order (deterministic: given order breaks ties).
Usage: depgraph.py <git-dir> <ref>"""
import json, posixpath, re, subprocess, sys
GIT, REF = sys.argv[1], sys.argv[2]
def show(p):
    r = subprocess.run(["git", f"--git-dir={GIT}", "show", f"{REF}:{p}"], capture_output=True); return r.stdout.decode("utf8", "replace") if r.returncode == 0 else None
FILES = set(subprocess.run(["git", f"--git-dir={GIT}", "ls-tree", "-r", "--name-only", REF], capture_output=True, text=True).stdout.split())
GEN = [  # id, entries, outputs (dependency order is COMPUTED, not taken from here)
 ("host-admission", ["network/host-admission-node.mjs", "network/metal-host-policy.mjs"], ["windows/node/host-admission.bundle.mjs", "metal/guest/host-policy.bundle.mjs"]),
 ("network-runtime", ["relay/network-runtime.mjs"], ["relay/network-runtime.bundle.mjs"]),
 ("windows-lease-runtime", ["network/lease-gas-runtime.mjs"], ["windows/node/lease-gas-runtime.bundle.mjs"]),
 ("metal-lease-gas", ["network/lease-gas-conduit.mjs"], ["metal/guest/lease-gas-conduit.bundle.mjs"]),
 ("host-service-packages", ["network/bootstrap-gateway.mjs", "network/credit-vault-submitter.mjs", "network/directory-server.mjs", "network/host-services/policy-mirror.mjs", "relay/dns-relay.js", "network/host-services/argv-guard.mjs"],
   [f"network/host-services/packages/{r}.mjs" for r in ("bootstrap-replica", "credit-vault-submitter", "directory-replica", "policy-mirror", "route-dns")]),
 ("mcp-guest", ["metal/guest/mcp-server-entry.mjs", "mcp/server.mjs"], ["metal/guest/mcp-server.bundle.mjs"]),
 ("platform-api-guest", ["metal/guest/platform-api-entry.mjs"], ["metal/guest/platform-api.bundle.mjs"]),
 ("vendor-host-policy", ["@script:scripts/build-host-policy-vendor.mjs"], ["site/vendor/host-policy.js"]),
 ("vendor-management", ["network/management-browser.mjs"], ["site/vendor/management.js"]),
 ("vendor-aa", ["scripts/vendor/aa-entry.mjs"], ["site/vendor/aa.js"]),
 ("vendor-custody", ["custody/browser.mjs"], ["site/vendor/custody.js"]),
 ("vendor-credit-vault", ["scripts/vendor/credit-vault-entry.mjs"], ["site/vendor/credit-vault.js"]),
 ("vendor-host-capacity", ["@script:scripts/build-host-capacity-vendor.mjs"], ["site/vendor/host-capacity.js"]),
]
OUT = {o: g for g, _, outs in GEN for o in outs}
SPEC = re.compile(r"""(?:\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\1""")
def specs(text):
    out = []
    for raw in text.split("\n"):
        l = raw.lstrip()
        if l.startswith(("//", "*", "/*")): continue
        out += [m.group(2) for m in SPEC.finditer(raw)]
    return out
def resolve(frm, s):
    if not s.startswith("."): return None
    b = posixpath.normpath(posixpath.join(posixpath.dirname(frm), s))
    for c in (b, b + ".mjs", b + ".js", b + ".cjs", b + "/index.mjs", b + "/index.js"):
        if c in FILES or c in OUT: return c
    return ("MISSING", b)
edges, missing, via = {}, [], {}
for g, entries, outs in GEN:
    seen, q = set(), []
    for e in entries:
        if e.startswith("@script:"):   # stdin ENTRY string inside the builder: its relative specifiers resolve from the repo root
            q += [posixpath.normpath(s[2:] if s.startswith("./") else s) for s in re.findall(r"""from\s*\\?["']\.?/?([^"'\\]+\.m?js)\\?["']""", show(e[8:]) or "")]
        else: q.append(e)
    while q:
        f = q.pop()
        if f in seen: continue
        seen.add(f)
        if f in OUT and f not in outs:
            edges.setdefault(OUT[f], set()).add(g); via.setdefault((OUT[f], g), f); continue
        if f in outs: continue
        t = show(f)
        if t is None:
            if f not in OUT: missing.append((g, f))
            continue
        for s in specs(t):
            r = resolve(f, s)
            if isinstance(r, tuple): missing.append((g, f"{f} -> {s}"))
            elif r: q.append(r)
# cross-check from committed manifests (their esbuild inputs)
man_edges = set()
for g, _, outs in GEN:
    for o in outs:
        for m in (o + ".manifest.json", o.replace(".js", ".MANIFEST.json"), o.replace(".mjs", ".package.json")):
            t = show(m)
            if not t: continue
            for o2, g2 in OUT.items():
                if g2 != g and (f'"{o2}"' in t or f'"./{o2}"' in t): man_edges.add((g2, g))
static_edges = {(a, b) for a, bs in edges.items() for b in bs}
order, indeg = [], {g: 0 for g, _, _ in GEN}
for a, b in static_edges | man_edges: indeg[b] += 1
ready = [g for g, _, _ in GEN if indeg[g] == 0]; adj = {}
for a, b in static_edges | man_edges: adj.setdefault(a, set()).add(b)
while ready:
    n = ready.pop(0); order.append(n)
    for m in sorted(adj.get(n, ()), key=[g for g, _, _ in GEN].index):
        indeg[m] -= 1
        if indeg[m] == 0: ready.append(m)
ready.sort(key=[g for g, _, _ in GEN].index)
res = {"ref": REF, "staticEdges": sorted(f"{a} -> {b} (via {via[(a, b)]})" for a, b in static_edges), "manifestEdges": sorted(f"{a} -> {b}" for a, b in man_edges),
       "manifestOnly": sorted(f"{a} -> {b}" for a, b in man_edges - static_edges), "unresolved": sorted(set(f"{g}: {x}" for g, x in missing))[:20],
       "cycle": len(order) != len(GEN), "order": order}
print(json.dumps(res, indent=1)); sys.exit(2 if res["cycle"] else 0)
