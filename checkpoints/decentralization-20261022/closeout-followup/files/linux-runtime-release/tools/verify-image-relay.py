#!/usr/bin/env python3
"""verify-image-relay.py SRC OUTDIR EXTRACT RECEIPT.json   (queued verify job; reads only, except EXTRACT and RECEIPT)
Adapted from native-final-image/tools/verify-image.py for the RELAY-MODE image of the composed commit fec43a6a: the reference
install set is the s1 precheck (receipts/inputs-precheck.json, computed by the commit's own overlay tool).

Post-build checks, from the image's OWN bytes (no build tool output is trusted):
  - kernel/cmdline/manifest: vmlinuz byte-equal to the production base, the kernel and modules records unchanged; the cmdline
    file byte-equal to the base's and the manifest's cmdlineTemplate unchanged (no metal.control, no control/platformApiBundle/
    mcpBundle record); controlOverlay names the commit and its overlay tool's sha256 with no control; the base's own
    controlOverlay (2857356cd) is the last controlOverlayHistory entry; initramfs record = file; expectedMeasurement removed.
  - entries: each installed input is a regular file with exactly the precheck sha256; every OTHER entry is the production
    base's entry with identical bytes and metadata (kernel modules included), except opt/metal/manifest.json and the parent
    directories the overlay adds; no base entry is missing.
  - runtime closure, from the image: the supervisor's import closure (the overlay's own rules) is present and its npm
    packages/subpaths are exported by the image's app/node_modules; every relative import of the installed guest helpers
    resolves; every new URL(<relative>, import.meta.url) read of every installed bundle resolves to an installed file; gsup.mjs
    starts /app/supervisor.js in the legacy (non-direct) branch; no platform-api / mcp bundle is installed.
  - the installed host-admission bundle is 40e8ba71, host-policy acfa1b00; no installed input carries a DigitalOcean
    /platform-policy mirror literal (counts over all other app/ + opt/ files are reported, not judged: base bytes).
  - EXTRACT: app/ and opt/ written out (regular files, in-subtree symlinks) for the node import check."""
import gzip, hashlib, importlib.util, json, os, posixpath, re, stat, sys
from pathlib import Path
BASE = Path("/home/steven/enclave-prod/dist-sdshield-2857356cd")
REF = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-runtime-release/receipts/inputs-precheck.json"
C = "fec43a6a08da2ac287fb3a5c42de89f096f4f678"
HA = "40e8ba71"; HP = "acfa1b00"
DO = [b"134.199.235.187", b"134.209.248.172", b"165.245.191.129", b"146.190.246.39"]
sha = lambda b: hashlib.sha256(b).hexdigest()

def index(o, p, extract=None):
    r = {}
    with gzip.open(p, "rb") as f:
        for key, name, fields, header in o.entries(f):
            h, left, mode = hashlib.sha256(), fields[6], fields[1]
            inside = extract is not None and (key.startswith("app/") or key.startswith("opt/"))
            out, link = None, b""
            if inside and stat.S_ISREG(mode):
                t = extract / key; t.parent.mkdir(parents=True, exist_ok=True); out = open(t, "wb")
            while left:
                c = o.exact(f, min(left, 1 << 20)); left -= len(c); h.update(c)
                if out: out.write(c)
                elif inside and stat.S_ISLNK(mode): link += c
            if out: out.close()
            if inside and stat.S_ISDIR(mode): (extract / key).mkdir(parents=True, exist_ok=True)
            if inside and stat.S_ISLNK(mode):
                lt = link.decode(); res = posixpath.normpath(posixpath.join(posixpath.dirname(key), lt))
                if not lt.startswith("/") and (res.startswith("app/") or res.startswith("opt/")):
                    (extract / key).parent.mkdir(parents=True, exist_ok=True)
                    if not os.path.lexists(extract / key): os.symlink(lt, extract / key)
            o.exact(f, -fields[6] % 4)
            if key == "TRAILER!!!": continue
            r[key] = {"sha256": h.hexdigest(), "mode": mode, "uid": fields[2], "gid": fields[3], "nlink": fields[4], "mtime": fields[5], "size": fields[6]}
    return r

def main(src, outdir, extract, receipt):
    src, outdir, extract = Path(src).resolve(), Path(outdir), Path(extract)
    spec = importlib.util.spec_from_file_location("o", src / "metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    ref = json.load(open(REF)); checks = []
    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail}); print(("OK   " if ok else "FAIL ") + name + (f"  {detail}" if detail else ""), flush=True)
    m = json.loads((outdir / "manifest.json").read_text()); bm = json.loads((BASE / "manifest.json").read_text())
    check("vmlinuz == production base", (outdir / "vmlinuz").read_bytes() == (BASE / "vmlinuz").read_bytes(), sha((outdir / "vmlinuz").read_bytes()))
    check("manifest kernel record unchanged (7.2.3-arch1-2)", m["kernel"] == bm["kernel"], m["kernel"].get("kver"))
    check("manifest modules list unchanged", m.get("modules") == bm.get("modules"), f"{len(m.get('modules') or [])} modules")
    check("cmdline file == production base cmdline (relay mode)", (outdir / "cmdline").read_bytes() == (BASE / "cmdline").read_bytes(), (outdir / "cmdline").read_text().strip())
    check("manifest cmdlineTemplate unchanged, no control/platformApiBundle/mcpBundle", m.get("cmdlineTemplate") == bm.get("cmdlineTemplate") and not any(k in m for k in ("control", "platformApiBundle", "mcpBundle")))
    check("manifest isolation unchanged (snp-guest-per-app)", m.get("isolation") == bm.get("isolation") == "snp-guest-per-app")
    co = m.get("controlOverlay", {})
    check("controlOverlay.commit = composed commit", co.get("commit") == C, co.get("commit"))
    check("controlOverlay.builderSha256 = the commit's overlay tool", co.get("builderSha256") == sha((src / "metal/overlay-control-image.py").read_bytes()), co.get("builderSha256"))
    check("controlOverlay has no control mode", "control" not in co)
    check("controlOverlay.baseInitramfsSha256 = production base", co.get("baseInitramfsSha256") == bm["initramfs"]["sha256"])
    hist = m.get("controlOverlayHistory") or []
    check("the base's controlOverlay is the last history entry", bool(hist) and hist[-1] == bm.get("controlOverlay") and hist[:-1] == (bm.get("controlOverlayHistory") or []), f"{len(hist)} entries; last commit {(hist[-1] if hist else {}).get('commit')}")
    check("manifest initramfs record = file", m["initramfs"] == {"sha256": sha((outdir / "initramfs.cpio.gz").read_bytes()), "bytes": (outdir / "initramfs.cpio.gz").stat().st_size})
    check("expectedMeasurement removed (recomputed separately)", "expectedMeasurement" not in m)
    files = {f["path"].lstrip("/"): f for f in co.get("files", [])}
    check(f"controlOverlay.files = the {len(ref['inputs'])} precheck inputs", {k: {"source": v["source"], "sha256": v["sha256"]} for k, v in files.items()} == ref["inputs"], f"{len(files)} files")
    extract.mkdir(parents=True)
    img = index(o, outdir / "initramfs.cpio.gz", extract)
    base = index(o, BASE / "initramfs.cpio.gz")
    def blob(key):
        t = extract / key
        return t.read_bytes() if key in img and stat.S_ISREG(img[key]["mode"]) and t.is_file() else None
    wrong = {k: (img.get(k) or {}).get("sha256") for k, v in ref["inputs"].items() if (img.get(k) or {}).get("sha256") != v["sha256"] or not stat.S_ISREG((img.get(k) or {"mode": 0})["mode"])}
    check(f"all {len(ref['inputs'])} installed inputs present, regular, with the precheck sha256", not wrong, wrong or f"{len(ref['inputs'])} inputs")
    ha = (img.get("app/windows/node/host-admission.bundle.mjs") or {}).get("sha256", ""); hp = (img.get("opt/metal/host-policy.bundle.mjs") or {}).get("sha256", "")
    check(f"installed host-admission bundle = {HA}, host-policy = {HP}", ha.startswith(HA) and hp.startswith(HP), f"{ha[:16]} / {hp[:16]}")
    sup = blob("app/supervisor.js")
    check("installed supervisor.js = the composed 4939dc68", sup is not None and sha(sup).startswith("4939dc688cefeed2"), sha(sup or b"")[:16])
    added = sorted(set(img) - set(base)); missing = sorted(set(base) - set(img))
    addedDirs = [k for k in added if stat.S_ISDIR(img[k]["mode"])]
    check("no production base entry missing", not missing, missing[:10])
    check("added entries = new inputs + their parent directories only", set(added) - set(addedDirs) <= set(ref["inputs"]), sorted(set(added) - set(addedDirs) - set(ref["inputs"]))[:10])
    others = [k for k in img if k not in ref["inputs"] and k in base and k != "opt/metal/manifest.json"]
    changed = [k for k in others if img[k] != base[k]]
    check("every other entry identical to the base (bytes + metadata, kernel modules included)", not changed, changed[:10] or f"{len(others)} entries, {sum(1 for k in others if k.startswith('lib/modules') or k.startswith('usr/lib/modules'))} module-tree entries")
    def read(rel):
        d = blob("app/" + posixpath.normpath(rel))
        return d.decode("utf8", "replace") if d is not None else None
    try:
        cl, packages = o.supervisor_closure(read, o.SUPERVISOR_ROOTS + o.APP_FILES); okc = True; detail = f"{len(cl)} files"
    except ValueError as e:
        cl, packages, okc, detail = [], {}, False, str(e)
    check("supervisor import closure present in the image", okc, detail)
    try:
        pk = o.check_packages(packages, lambda n: blob("app/node_modules/" + n + "/package.json")); check("closure npm packages + subpath exports in the image", True, ", ".join(f"{p['name']}@{p['version']}" for p in pk))
    except ValueError as e:
        check("closure npm packages + subpath exports in the image", False, str(e))
    guest = [k for k in img if k.startswith("opt/metal/") and k.endswith(".mjs") and stat.S_ISREG(img[k]["mode"])]
    unresolved = []
    for g in guest:
        text = blob(g).decode("utf8", "replace")
        if not g.endswith(".bundle.mjs"):
            for spec_ in o.specifiers_of(text):
                if spec_.startswith("./") or spec_.startswith("../"):
                    t = posixpath.normpath(posixpath.join(posixpath.dirname(g), spec_))
                    if t not in img: unresolved.append(f"{g} imports {spec_}")
        for rel in re.findall(r"""new URL\(\s*["'](\.{1,2}/[^"']+)["']\s*,\s*import\.meta\.url\s*\)""", text):
            t = posixpath.normpath(posixpath.join(posixpath.dirname(g), rel))
            if t not in img or not stat.S_ISREG(img[t]["mode"]): unresolved.append(f"{g} reads {rel}")
    check("guest helpers' relative imports and every bundle's beside-itself reads resolve in the image", not unresolved, unresolved[:10] or f"{len(guest)} opt/metal modules")
    gsup = blob("opt/metal/gsup.mjs").decode()
    check("gsup.mjs starts /app/supervisor.js in the legacy (non-direct) branch", "if (!CONTROL) {" in gsup and "start('supervisor', ['/usr/local/bin/node', '/app/supervisor.js']" in gsup)
    check("relay mode: no platform-api / mcp role bundle installed", not any(k in img for k in ("opt/metal/platform-api.bundle.mjs", "opt/metal/mcp-server.bundle.mjs")))
    do_inputs = sorted(k for k in ref["inputs"] if (b := blob(k)) is not None and any(d in b for d in DO))
    check("no installed input carries a DigitalOcean /platform-policy mirror literal", not do_inputs, do_inputs)
    do_other = sorted(k for k in img if (k.startswith("app/") or k.startswith("opt/")) and k not in ref["inputs"] and stat.S_ISREG(img[k]["mode"])
                      and not k.startswith("app/node_modules/") and (b := blob(k)) is not None and any(d in b for d in DO))
    n = sum(1 for k, v in img.items() if (k.startswith("app/") or k.startswith("opt/")) and stat.S_ISREG(v["mode"]))
    # the baked supervisor environment (gsup: supEnv = flavorEnv + the fw_cfg host-wallet policy env + fixed values): which
    # platform-policy settings reach a relay-mode supervisor at all (names only, plus the public chain/book identifiers)
    fe = blob("opt/metal/flavor-env.json"); flavor = json.loads(fe) if fe else {}
    policy_keys = sorted(k for k in flavor if "HOST_POLICY" in k or "PLATFORM" in k)
    flavor_rec = {"present": fe is not None, "sha256": sha(fe) if fe else None, "keys": len(flavor), "platformPolicyKeys": policy_keys,
                  "CHAIN_ID": flavor.get("CHAIN_ID"), "ADDRESS_BOOK_ADDRESS": flavor.get("ADDRESS_BOOK_ADDRESS")}
    print(f"flavor-env.json: {json.dumps(flavor_rec)}")
    json.dump({"commit": C, "checks": checks, "ok": all(c["ok"] for c in checks), "entries": {"image": len(img), "base": len(base), "added": added, "addedDirectories": addedDirs},
               "doMirrorLiteralsInOtherBaseFiles (informational; base bytes, not inputs)": do_other, "flavorEnv (base, informational)": flavor_rec, "extracted": n}, open(receipt, "w"), indent=1)
    print(f"DO literals in other (base) app/opt files outside node_modules: {do_other}")
    print(f"extracted {n} app/ + opt/ files (node_modules included) to {extract}")
    sys.exit(0 if all(c["ok"] for c in checks) else 10)

if __name__ == "__main__": main(*sys.argv[1:])
