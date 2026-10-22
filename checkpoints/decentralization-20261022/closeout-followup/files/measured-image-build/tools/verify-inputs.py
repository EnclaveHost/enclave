#!/usr/bin/env python3
"""verify-inputs.py SRC OUT.json   (inside the queued build job, before the overlay runs)

The PUBLISHED checkout's own overlay tool selects the --control direct install set for its HEAD commit (app_files +
guest_files + platform_api_files + mcp_files, exactly as overlay() does) and checks it against the READ-ONLY production base
(packages/exports, regular non-hardlinked targets, cmdline). Every one of those inputs - path, source and sha256 - and the
bundle records must equal the reviewed 59-entry manifest measured-composition/out/c/INPUT-MANIFEST.json. Writes OUT.json;
exits nonzero on any difference."""
import gzip, hashlib, importlib.util, json, stat, subprocess, sys
from pathlib import Path
BASE = Path("/home/steven/enclave-prod/dist-sdshield-2857356cd")
REF = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition/out/c/INPUT-MANIFEST.json"
sha = lambda b: hashlib.sha256(b).hexdigest()

def main(src, out):
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
    ref = json.load(open(REF))
    res = {"commit": commit, "tool": sha((src / "metal/overlay-control-image.py").read_bytes()), "count": len(inputs),
           "equalInputs": inputs == ref["inputs"], "onlyHere": sorted(set(inputs) - set(ref["inputs"])), "onlyInReference": sorted(set(ref["inputs"]) - set(inputs)),
           "differing": sorted(k for k in set(inputs) & set(ref["inputs"]) if inputs[k] != ref["inputs"][k]),
           "equalPlatformApiBundle": pa_record == ref["platformApiBundle"], "equalMcpBundle": mcp_record == ref["mcpBundle"],
           "equalPackages": pkg == ref["packagesFromBase"], "cmdline": o.direct_cmdline(BASE, m)[0].replace("${MODE}", "snp"),
           "equalCmdline": o.direct_cmdline(BASE, m)[0].replace("${MODE}", "snp") == ref["measuredCmdline"], "nonRegularTargets": bad,
           "reference": {"file": REF, "sha256": sha(open(REF, "rb").read())}, "inputs": inputs, "platformApiBundle": pa_record, "mcpBundle": mcp_record}
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    ok = res["equalInputs"] and res["equalPlatformApiBundle"] and res["equalMcpBundle"] and res["equalPackages"] and res["equalCmdline"] and not bad and len(inputs) == 59
    print(json.dumps({k: v for k, v in res.items() if k not in ("inputs", "platformApiBundle", "mcpBundle")}, indent=1))
    sys.exit(0 if ok else 6)

if __name__ == "__main__": main(*sys.argv[1:])
