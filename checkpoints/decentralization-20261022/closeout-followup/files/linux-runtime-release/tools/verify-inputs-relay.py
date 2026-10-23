#!/usr/bin/env python3
"""verify-inputs-relay.py SRC OUT.json [PRECHECK.json]   (adapted from native-final-image/tools/verify-inputs.py)

The composed checkout's OWN overlay tool (metal/overlay-control-image.py, reviewed 1067a535, unchanged from 493ee9ee) selects
the RELAY-MODE install set (no --control: app_files + guest_files, exactly as overlay() does without --control; the
production Linux runtime KEPT ed918e4b is such an image) for HEAD, and it is checked against the READ-ONLY production base
(packages/exports, regular non-hardlinked targets, cmdline). Then:
  - HEAD must be the composed commit and the overlay tool 1067a535;
  - against the native 493ee9ee image's 59 inputs (native-final-image/public/INPUT-MANIFEST.json, built from the same
    tool): every relay input has the 493ee9ee bytes EXCEPT app/supervisor.js (the composed 4939dc68) and app/egress.js (D's
    bd960a2b), and every 493ee9ee input missing here is a --control direct file (platform_api_files + mcp_files of HEAD);
  - against the live control overlay (deabf8f90, KEPT ed918e4b: /home/steven/enclave-prod/dist-leasegas-deabf8f90/manifest.json):
    changed / added / removed inputs are listed (informational: the lineage review is in RESULT-LINUX-PACKAGE.md);
  - the host-admission bundle is 40e8ba71 (decision() + carriers, no DigitalOcean mirror) and the metal host-policy bundle
    acfa1b00; the live bundle e83515fc and the checkpoint lineage's 3438cdf2 / a19af83c are refused;
  - no installed input contains any of the four DigitalOcean /platform-policy mirror literals;
  - with PRECHECK.json (the build job): the install set is identical to the one the s1 precheck wrote.
Writes OUT.json; exits nonzero on any failure."""
import gzip, hashlib, importlib.util, json, stat, subprocess, sys
from pathlib import Path
BASE = Path("/home/steven/enclave-prod/dist-sdshield-2857356cd")
NATIVE = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-final-image/public/INPUT-MANIFEST.json"
LIVE = "/home/steven/enclave-prod/dist-leasegas-deabf8f90/manifest.json"
C = "fec43a6a08da2ac287fb3a5c42de89f096f4f678"
TOOL = "1067a535413f88e0c66b80441a734d5dc7771ac79e24129df25df8a1d4aeea56"
EXPECT_DIFF = {"app/supervisor.js": "4939dc688cefeed2", "app/egress.js": "bd960a2b6ff51e82"}
HOST_ADMISSION = "40e8ba71"; HOST_POLICY = "acfa1b00"
REFUSED = {"e83515fc": "live bundle without decision()", "3438cdf2": "checkpoint bundle with 4 DO mirrors", "a19af83c": "checkpoint metal host-policy with 4 DO mirrors"}
DO_MIRRORS = [b"134.199.235.187", b"134.209.248.172", b"165.245.191.129", b"146.190.246.39"]
CMDLINE_TEMPLATE = "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=${MODE} metal.isolation=snp-guest-per-app"
sha = lambda b: hashlib.sha256(b).hexdigest()

def main(src, out, precheck=None):
    src = Path(src).resolve()
    spec = importlib.util.spec_from_file_location("o", src / "metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD^{commit}"], cwd=src, text=True).strip()
    m = json.loads((BASE / "manifest.json").read_text())
    installed_app, packages = o.app_files(commit, src)
    paths = {**{"app/" + p: p for p in installed_app}, **{"opt/metal/" + p: "metal/guest/" + p for p in o.guest_files(commit, src)}}
    blobs = {k: o.committed(commit, src, v) for k, v in paths.items()}
    inputs = {k: {"source": v, "sha256": sha(blobs[k])} for k, v in sorted(paths.items())}
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
    # the --control direct files of the same commit (what a direct image would add on top)
    direct = {}
    pa_files, _ = o.platform_api_files(commit, src)
    for k, v in pa_files.items(): o.place(direct, k, v, "platform API file")
    mcp_add, _ = o.mcp_files(commit, src, {**paths, **direct}); direct.update(mcp_add)
    nat_raw = open(NATIVE, "rb").read(); nat = json.loads(nat_raw)["inputs"]
    vs_native = {"reference": {"file": "<work>/resume-after-checkpoint-20261022/native-final-image/public/INPUT-MANIFEST.json", "sha256": sha(nat_raw), "count": len(nat)},
                 "differ": {k: {"native": nat[k]["sha256"], "composed": inputs[k]["sha256"]} for k in inputs if k in nat and nat[k] != inputs[k]},
                 "notInNative": sorted(set(inputs) - set(nat)), "nativeOnly": sorted(set(nat) - set(inputs)),
                 "directFilesOfHead": sorted(direct)}
    vs_native["ok"] = (set(vs_native["differ"]) == set(EXPECT_DIFF) and all(inputs[k]["sha256"].startswith(p) for k, p in EXPECT_DIFF.items())
                       and not vs_native["notInNative"] and set(vs_native["nativeOnly"]) <= set(direct))
    live_raw = open(LIVE, "rb").read(); live = {f["path"].lstrip("/"): f for f in json.loads(live_raw)["controlOverlay"]["files"]}
    vs_live = {"reference": {"file": LIVE, "sha256": sha(live_raw), "commit": json.loads(live_raw)["controlOverlay"]["commit"], "count": len(live)},
               "changed": {k: {"live": live[k]["sha256"], "composed": inputs[k]["sha256"], "source": inputs[k]["source"]} for k in inputs if k in live and live[k]["sha256"] != inputs[k]["sha256"]},
               "unchanged": sorted(k for k in inputs if k in live and live[k]["sha256"] == inputs[k]["sha256"]),
               "added": sorted(set(inputs) - set(live)), "removed": sorted(set(live) - set(inputs))}
    ha = inputs.get("app/windows/node/host-admission.bundle.mjs", {}).get("sha256", ""); hp = inputs.get("opt/metal/host-policy.bundle.mjs", {}).get("sha256", "")
    refused = {k: why for k, why in REFUSED.items() if ha.startswith(k) or hp.startswith(k)}
    do_hits = {k: [d.decode() for d in DO_MIRRORS if d in b] for k, b in blobs.items() if any(d in b for d in DO_MIRRORS)}
    cmdline = (BASE / "cmdline").read_text()
    res = {"commit": commit, "tool": sha((src / "metal/overlay-control-image.py").read_bytes()), "mode": "relay (no --control)", "count": len(inputs),
           "packagesFromBase": pkg, "baseCmdline": cmdline, "equalCmdlineTemplate": cmdline == CMDLINE_TEMPLATE + "\n" and m.get("cmdlineTemplate") == CMDLINE_TEMPLATE,
           "baseIsControlImage": "control" in m, "nonRegularTargets": bad,
           "hostAdmissionBundle": ha, "hostPolicyBundle": hp, "refusedBundles": refused, "doMirrorLiterals": do_hits,
           "vsNative493": vs_native, "vsLiveDeabf8f90": vs_live, "inputs": inputs}
    ok = (commit == C and res["tool"] == TOOL and res["equalCmdlineTemplate"] and not res["baseIsControlImage"] and not bad
          and ha.startswith(HOST_ADMISSION) and hp.startswith(HOST_POLICY) and not refused and not do_hits and vs_native["ok"])
    if precheck:
        p = json.load(open(precheck))
        res["equalToPrecheck"] = all(p[k] == res[k] for k in ("commit", "tool", "inputs", "packagesFromBase", "baseCmdline"))
        ok = ok and res["equalToPrecheck"]
    res["ok"] = ok
    json.dump(res, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({k: v for k, v in res.items() if k not in ("inputs", "vsLiveDeabf8f90")}, indent=1))
    print(json.dumps({"vsLive": {k: (v if k in ("changed", "added", "removed") else (len(v) if isinstance(v, list) else v)) for k, v in vs_live.items()}}, indent=1))
    sys.exit(0 if ok else 6)

if __name__ == "__main__": main(*sys.argv[1:])
