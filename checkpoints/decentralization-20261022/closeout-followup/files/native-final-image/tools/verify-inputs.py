#!/usr/bin/env python3
"""verify-inputs.py SRC OUT.json [PRECHECK.json]   (adapted from measured-image-build/tools/verify-inputs.py)

The checkout's OWN overlay tool selects the --control direct install set for its HEAD commit (app_files + guest_files +
platform_api_files + mcp_files, exactly as overlay() does) and checks it against the READ-ONLY production base
(packages/exports, regular non-hardlinked targets, cmdline). There is no earlier reviewed manifest for 493ee9ee, so instead:
  - HEAD must be 493ee9ee and the overlay tool the reviewed 1067a535 (unchanged since 6f2c7da4);
  - the platform API bundle record must be the combined bundle root named: 0a1d88de..., 8705824 bytes, 2219 inputs;
  - the delta against the previous image's 59 inputs (measured-image-build/public/inputs-precheck.json, commit 6f2c7da4) must be
    EXPLAINED by the commit range: an input whose bytes changed (or that is new) has its source path in
    `git diff 6f2c7da4 493ee9ee`, and no unchanged input has its source there (so nothing old is silently carried);
  - with PRECHECK.json (the build job): the install set is identical to the one the s1 precheck wrote.
Writes OUT.json; exits nonzero on any failure."""
import gzip, hashlib, importlib.util, json, posixpath, stat, subprocess, sys
from pathlib import Path
BASE = Path("/home/steven/enclave-prod/dist-sdshield-2857356cd")
OLD = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-image-build/public/inputs-precheck.json"
C, OLDC = "493ee9ee07497c94159ec4f6916e9ea920d31959", "6f2c7da466dc26e5f7aac88c574a6b807e1a03df"
TOOL = "1067a535413f88e0c66b80441a734d5dc7771ac79e24129df25df8a1d4aeea56"
PA = {"path": "/opt/metal/platform-api.bundle.mjs", "sha256": "0a1d88de230842442c41cc9f399d3a7dda5394fb523812b2503bc2358b09b4ef",
      "bytes": 8705824, "inputs": 2219, "sidecars": {"/opt/metal/fixtures/tpm-roots.pem": "f72ea29aefa0d778856e105f725d3c9c66a45cfc8cb35c170782bceee8d8ba5b"}}
CMDLINE = "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct"
sha = lambda b: hashlib.sha256(b).hexdigest()

def main(src, out, precheck=None):
    src = Path(src).resolve()
    spec = importlib.util.spec_from_file_location("o", src / "metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD^{commit}"], cwd=src, text=True).strip()
    m = json.loads((BASE / "manifest.json").read_text())
    installed_app, packages = o.app_files(commit, src)
    paths = {**{"app/" + p: p for p in installed_app}, **{"opt/metal/" + p: "metal/guest/" + p for p in o.guest_files(commit, src)}}
    pa_files, pa_record = o.platform_api_files(commit, src)
    for k, v in pa_files.items(): o.place(paths, k, v, "platform API file")
    mcp_add, mcp_record = o.mcp_files(commit, src, paths); paths.update(mcp_add)
    inputs = {k: {"source": v, "sha256": sha(o.committed(commit, src, v))} for k, v in sorted(paths.items())}
    wanted = {"app/node_modules/" + n + "/package.json" for n in packages}
    meta, pk = {}, {}
    with gzip.open(BASE / "initramfs.cpio.gz", "rb") as f:
        for key, name, fields, header in o.entries(f):
            left, buf = fields[6], b""
            while left:
                c = o.exact(f, min(left, 1 << 20)); left -= len(c)
                if key in wanted: buf += c
            o.exact(f, -fields[6] % 4)
            meta[key] = fields
            if key in wanted: pk[key] = buf
    pkg = o.check_packages(packages, lambda n: pk.get("app/node_modules/" + n + "/package.json"))
    bad = [k for k in inputs if k in meta and (not stat.S_ISREG(meta[k][1]) or meta[k][4] != 1)]
    # delta against the previous image's inputs, explained by the commit range
    old_raw = open(OLD, "rb").read(); old = json.loads(old_raw)
    diff = set(subprocess.check_output(["git", "diff", "--name-only", OLDC, commit], cwd=src, text=True).split())
    def hops(rel):                       # the source path and every symlink hop the overlay follows
        out, modes = [rel], o._MODES[(str(src), commit)]
        while modes.get(rel) == "120000":
            rel = posixpath.normpath(posixpath.join(posixpath.dirname(rel), subprocess.check_output(["git", "show", commit + ":" + rel], cwd=src).decode()))
            out.append(rel)
        return out
    oi = old["inputs"]
    changed = sorted(k for k in inputs if k in oi and inputs[k] != oi[k]); added = sorted(set(inputs) - set(oi)); removed = sorted(set(oi) - set(inputs))
    unexplained = [k for k in changed + added if not any(h in diff for h in hops(inputs[k]["source"]))]
    carried = [k for k in inputs if k in oi and inputs[k] == oi[k] and any(h in diff for h in hops(inputs[k]["source"]))]
    res = {"commit": commit, "tool": sha((src / "metal/overlay-control-image.py").read_bytes()), "count": len(inputs),
           "platformApiBundle": pa_record, "equalPlatformApiBundleToCombined": pa_record == PA,
           "mcpBundle": mcp_record, "equalMcpBundleTo6f2c7da4": mcp_record == old["mcpBundle"],
           "packagesFromBase": pkg, "cmdline": o.direct_cmdline(BASE, m)[0].replace("${MODE}", "snp"),
           "equalCmdline": o.direct_cmdline(BASE, m)[0].replace("${MODE}", "snp") == CMDLINE, "nonRegularTargets": bad,
           "vs6f2c7da4": {"reference": {"file": "<work>/resume-after-checkpoint-20261022/measured-image-build/public/inputs-precheck.json", "sha256": sha(old_raw), "count": len(oi)},
                          "changed": {k: {"old": oi[k]["sha256"], "new": inputs[k]["sha256"], "source": inputs[k]["source"]} for k in changed},
                          "added": added, "removed": removed, "diffPaths": len(diff),
                          "unexplainedChanges": unexplained, "unchangedButSourceInDiff": carried},
           "inputs": inputs}
    ok = (commit == C and res["tool"] == TOOL and res["equalPlatformApiBundleToCombined"] and res["equalMcpBundleTo6f2c7da4"]
          and res["equalCmdline"] and not bad and not unexplained and not carried)
    if precheck:
        p = json.load(open(precheck))
        res["equalToPrecheck"] = all(p[k] == res[k] for k in ("commit", "tool", "inputs", "platformApiBundle", "mcpBundle", "packagesFromBase", "cmdline"))
        ok = ok and res["equalToPrecheck"]
    res["ok"] = ok
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({k: v for k, v in res.items() if k not in ("inputs",)}, indent=1))
    sys.exit(0 if ok else 6)

if __name__ == "__main__": main(*sys.argv[1:])
