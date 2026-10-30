#!/usr/bin/env python3
"""STATIC: every importer of a GENERATED bundle imports only names its SOURCE ENTRY exports (the bundle's bytes may be stale;
this checks the source the generator bundles). Uses link-check.py's export reader. Usage: bundle-entry-links.py <git-dir> <ref>"""
import importlib.util, json, re, subprocess, sys, os
spec = importlib.util.spec_from_file_location("lc", os.path.join(os.path.dirname(__file__), "link-check.py"))
G, REF = sys.argv[1], sys.argv[2]; sys.argv = [sys.argv[0], G, REF, "--only"]; lc = importlib.util.module_from_spec(spec); spec.loader.exec_module(lc)
BUNDLES = {"windows/node/host-admission.bundle.mjs": "network/host-admission-node.mjs", "metal/guest/host-policy.bundle.mjs": "network/metal-host-policy.mjs",
           "windows/node/lease-gas-runtime.bundle.mjs": "network/lease-gas-runtime.mjs", "metal/guest/lease-gas-conduit.bundle.mjs": "network/lease-gas-conduit.mjs",
           "relay/network-runtime.bundle.mjs": "relay/network-runtime.mjs"}
bad, n = [], 0
for f in sorted(lc.JS):
    t = lc.src(f)
    if not t: continue
    for clause, s in re.findall(r"\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['\"](\.[^'\"]+)['\"]", lc.strip(t)) + [(c, s) for c, s in re.findall(r"\{([^}]*)\}\s*=\s*await\s+import\(\s*['\"](\.[^'\"]+)['\"]", lc.strip(t))]:
        tgt = lc.posixpath.normpath(lc.posixpath.join(lc.posixpath.dirname(f), s))
        if tgt not in BUNDLES: continue
        n += 1; ex, opaque = lc.exports(BUNDLES[tgt])
        miss = [a for a, b in lc.names(clause.replace(":", " as ")) if a not in ex]
        if miss: bad.append({"importer": f, "bundle": tgt, "sourceEntry": BUNDLES[tgt], "missing": miss, "opaqueReexport": opaque})
print(json.dumps({"ref": REF, "bundleImports": n, "broken": bad}, indent=1)); sys.exit(1 if bad else 0)
