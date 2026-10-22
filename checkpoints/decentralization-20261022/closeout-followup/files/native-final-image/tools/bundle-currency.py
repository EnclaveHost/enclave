#!/usr/bin/env python3
"""bundle-currency.py SRC PRECHECK.json OUT.json   (new; s1 job, reads only)

Every prebuilt bundle the image installs must be CURRENT for commit 493ee9ee, not an older build carried along:
  - a bundle with a committed manifest (<bundle>.manifest.json): manifest sha256/bytes == the committed bundle, and every
    repository input it names (non-node_modules) has exactly the bytes committed at 493ee9ee (git symlinks followed, as the
    overlay follows them). The one gitignored prerequisite, relay/network-runtime.bundle.mjs, must be the reviewed 8399d143.
  - a bundle without a manifest (host-admission, host-policy): its bytes are unchanged since 6f2c7da4 and are the reviewed pins.
  - every bundle (and the network runtime, read from the source repo's working copy ONLY to scan it, when its sha256 is
    8399d143): no esbuild module comment ("// <path>") names a path changed in 6f2c7da4..493ee9ee unless that bundle's
    manifest lists the path with its current bytes.
node_modules inputs are not committed; they are counted, not checked here (the combined bundle's --check in the source
repo is native-final-build/build.out, not repeated)."""
import hashlib, importlib.util, json, re, subprocess, sys
from pathlib import Path
C, OLDC = "493ee9ee07497c94159ec4f6916e9ea920d31959", "6f2c7da466dc26e5f7aac88c574a6b807e1a03df"
NETRT_PIN = "8399d1434e0587c246c77bfbea5d8afac65ada130cc96abffe291afde588af1e"
NETRT_SRC = Path("/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo/relay/network-runtime.bundle.mjs")
PINS = {"windows/node/host-admission.bundle.mjs": "40e8ba71", "metal/guest/host-policy.bundle.mjs": "acfa1b00"}
sha = lambda b: hashlib.sha256(b).hexdigest()
COMMENT = re.compile(r"^// ((?:\.\./)*[\w@.\-]+(?:/[\w@.\-]+)+\.(?:m?js|cjs|json))$", re.M)

def main(src, precheck, out):
    src = Path(src).resolve()
    spec = importlib.util.spec_from_file_location("o", src / "metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    pre = json.load(open(precheck)); diff = set(subprocess.check_output(["git", "diff", "--name-only", OLDC, C], cwd=src, text=True).split())
    bundles = sorted({v["source"] for v in pre["inputs"].values() if v["source"].endswith(".bundle.mjs")})
    res, ok = {"commit": C, "diffPaths": sorted(diff), "bundles": {}}, True
    def scan(text, listed):
        named = sorted(set(m.group(1).lstrip("./") for m in COMMENT.finditer(text)))
        return named, [p for p in named if p in diff and p not in listed]
    for b in bundles:
        data = o.committed(C, src, b); raw = o.committed(C, src, b + ".manifest.json"); r = {"sha256": sha(data), "bytes": len(data)}
        if raw is not None:
            m = json.loads(raw); inp = m["inputs"]
            r["manifest"] = {"sha256Matches": m.get("sha256") == sha(data), "bytesMatch": m.get("bytes", len(data)) == len(data), "inputs": len(inp)}
            repo = {k: v for k, v in inp.items() if "node_modules/" not in k}
            stale, prereq = {}, {}
            for k, v in sorted(repo.items()):
                if k == "relay/network-runtime.bundle.mjs":
                    prereq[k] = {"sha256": v, "reviewedPin": v == NETRT_PIN}; continue
                got = o.committed(C, src, k)
                if got is None or sha(got) != v: stale[k] = {"manifest": v, "committed": sha(got) if got is not None else None}
            r["manifest"].update({"repositoryInputs": len(repo), "nodeModulesInputs": len(inp) - len(repo), "staleRepositoryInputs": stale,
                                  "gitignoredPrerequisites": prereq, "inputsChangedSince6f2c7da4": sorted(k for k in repo if k in diff)})
            good = r["manifest"]["sha256Matches"] and r["manifest"]["bytesMatch"] and not stale and all(p["reviewedPin"] for p in prereq.values())
            listed = set(repo)
        else:
            old = subprocess.run(["git", "show", OLDC + ":" + b], cwd=src, capture_output=True).stdout
            r["noManifest"] = {"unchangedSince6f2c7da4": old == data, "reviewedPin": PINS.get(b), "pinMatches": PINS.get(b) is not None and sha(data).startswith(PINS[b])}
            good = r["noManifest"]["unchangedSince6f2c7da4"] and r["noManifest"]["pinMatches"]; listed = set()
        named, hit = scan(data.decode("utf8", "replace"), listed)
        r["moduleComments"] = len(named); r["changedPathsBundledButNotCurrentInManifest"] = hit
        good = good and not hit; r["ok"] = good; ok = ok and good; res["bundles"][b] = r
    nr = {"path": "<source repo working copy>/relay/network-runtime.bundle.mjs (gitignored; read only)", "pin": NETRT_PIN}
    if NETRT_SRC.is_file() and sha(NETRT_SRC.read_bytes()) == NETRT_PIN:
        named, hit = scan(NETRT_SRC.read_text("utf8", "replace"), set())
        nr.update({"scanned": True, "moduleComments": len(named), "changedPathsBundled": hit}); ok = ok and not hit
    else:
        nr.update({"scanned": False, "why": "working copy absent or not the pin"})
    res["networkRuntime"] = nr; res["ok"] = ok
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({"ok": ok, "bundles": {k: {"ok": v["ok"], "sha256": v["sha256"][:16], "moduleComments": v["moduleComments"],
        **({"stale": v["manifest"]["staleRepositoryInputs"], "changedInputs": v["manifest"]["inputsChangedSince6f2c7da4"], "prereq": v["manifest"]["gitignoredPrerequisites"]} if "manifest" in v else v["noManifest"])}
        for k, v in res["bundles"].items()}, "networkRuntime": nr}, indent=1))
    sys.exit(0 if ok else 7)

if __name__ == "__main__": main(*sys.argv[1:])
