#!/usr/bin/env python3
"""verify-image-cv.py SRC COMMIT OUTDIR EXTRACT VERIFIER_DIR PRECHECK.json RECEIPT.json   (queued v1 job; writes only EXTRACT and RECEIPT)
Adapted from linux-runtime-release/tools/verify-image-relay.py (D) with RECIPE-IMAGE.md's chain-verifier checks, for the relay-mode
+ --chain-verifier-dir image of COMMIT. Independence: the initramfs is parsed by THIS file's own newc reader (not the overlay's
entries()); every installed committed input is compared with `git cat-file blob COMMIT:<source>` read here (the precheck only
names the set); the native files are compared with the RECIPE-IMAGE.md table hardcoded below AND PINS.sha256 AND the commit's
metal/chain-verifier-image.json. The overlay module is loaded only for its published closure rules (supervisor_closure,
check_packages, specifiers_of), applied to the image's own extracted bytes."""
import gzip, hashlib, importlib.util, json, os, posixpath, re, stat, subprocess, sys
from pathlib import Path
BASE = Path("/home/steven/enclave-prod/dist-sdshield-2857356cd")
DO = [b"134.199.235.187", b"134.209.248.172", b"165.245.191.129", b"146.190.246.39"]
NATIVE = {  # RECIPE-IMAGE.md "Chain verifier native inputs" table: image path -> (sha256, mode)
    "opt/rpc-runtime/enclave-base-head-listener": ("9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3", 0o555),
    "opt/rpc-runtime/helios": ("cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0", 0o555),
    "opt/rpc-runtime/witness-check": ("4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411", 0o555),
    "opt/rpc-runtime/glibc/ld-linux-x86-64.so.2": ("f5e11cc62f8f2c24dff532982559f4303dba3b17e7450551372a88c8e7ea8757", 0o555),
    "opt/rpc-runtime/glibc/libc.so.6": ("02c8c3d06180beee9c7d0392aa85736c7d19f274a81e7f8f0b3d9e28e0641524", 0o444),
    "opt/rpc-runtime/glibc/libm.so.6": ("965106704753eefe8c31ae7da6daba3ead3d18c52b19b5fcc41178bcc4aa999d", 0o444),
    "opt/rpc-runtime/glibc/libgcc_s.so.1": ("e618cb9c90c2eb3a1dad1cfea5b6c1eebcf2e799ad805976f4ae47bdd61c716a", 0o444),
}
sha = lambda b: hashlib.sha256(b).hexdigest()

def newc(path, extract=None):
    """Own newc reader over the (possibly multi-member) gzip stream: {key: metadata+sha256}; app/ and opt/ written to EXTRACT."""
    r, order, dups = {}, [], []
    with gzip.open(path, "rb") as f:
        def need(n):
            b = f.read(n)
            if len(b) != n: raise ValueError(f"short read ({len(b)} of {n})")
            return b
        while True:
            magic = f.read(4)
            if not magic: break
            if magic.strip(b"\0") == b"": continue  # inter-archive padding (4-aligned)
            magic += need(2)
            if magic != b"070701": raise ValueError(f"bad magic {magic!r} after {len(order)} entries")
            h = need(104); v = [int(h[i:i + 8], 16) for i in range(0, 104, 8)]
            ino, mode, uid, gid, nlink, mtime, size, dmaj, dmin, rmaj, rmin, namesize, _ = v
            name = need(namesize)[:-1].decode(); need(-(110 + namesize) % 4)
            key = name
            while key.startswith("./"): key = key[2:]
            key = key.lstrip("/") or "."
            if name == "TRAILER!!!":
                need(-size % 4) if size else None; continue
            hs, left, data = hashlib.sha256(), size, b""
            inside = extract is not None and (key.startswith("app/") or key.startswith("opt/"))
            out = open(extract / key, "wb") if inside and stat.S_ISREG(mode) and (extract / key).parent.mkdir(parents=True, exist_ok=True) is None else None
            while left:
                c = f.read(min(left, 1 << 20))
                if not c: raise ValueError("short data")
                left -= len(c); hs.update(c)
                if out: out.write(c)
                elif stat.S_ISLNK(mode): data += c
            if out: out.close()
            need(-size % 4)
            if inside and stat.S_ISDIR(mode): (extract / key).mkdir(parents=True, exist_ok=True)
            if inside and stat.S_ISLNK(mode):
                lt = data.decode(); res = posixpath.normpath(posixpath.join(posixpath.dirname(key), lt))
                if not lt.startswith("/") and (res.startswith("app/") or res.startswith("opt/")):
                    (extract / key).parent.mkdir(parents=True, exist_ok=True)
                    if not os.path.lexists(extract / key): os.symlink(lt, extract / key)
            if key in r: dups.append(key); OCC.setdefault(str(path), {}).setdefault(key, []).append(r[key])  # earlier occurrence kept for the proof
            r[key] = {"sha256": hs.hexdigest(), "mode": mode, "uid": uid, "gid": gid, "nlink": nlink, "mtime": mtime, "size": size,
                      "rdev": [rmaj, rmin], **({"link": data.decode()} if stat.S_ISLNK(mode) else {})}
            order.append(key)
    DUPS[str(path)] = dups
    return r
DUPS = {}; OCC = {}; DPROOF = {}

def main(src, commit, outdir, extract, vdir, precheck, receipt):
    src, outdir, extract, vdir = Path(src).resolve(), Path(outdir), Path(extract), Path(vdir)
    git = lambda *a: subprocess.check_output(["git", *a], cwd=src)
    commit = git("rev-parse", commit + "^{commit}").decode().strip()
    def blob(p):
        """bytes at p in COMMIT; a git symlink (120000) is followed inside the commit (own resolver: relative, in-repo, <=9 hops)"""
        p = posixpath.normpath(p)
        for _ in range(9):
            ls = git("ls-tree", "-z", commit, "--", p).split(b"\0")[0]
            if not ls: raise subprocess.CalledProcessError(1, ["git", "ls-tree", p])
            mode = ls.split(b" ", 1)[0]
            data = git("cat-file", "blob", f"{commit}:{p}")
            if mode != b"120000": return data
            t = data.decode()
            if t.startswith("/"): raise ValueError(f"absolute symlink {p}")
            p = posixpath.normpath(posixpath.join(posixpath.dirname(p), t))
            if p.startswith("../"): raise ValueError(f"symlink leaves the repository: {p}")
        raise ValueError(f"symlink loop at {p}")
    tool = blob("metal/overlay-control-image.py")
    spec = importlib.util.spec_from_file_location("o", src / "metal/overlay-control-image.py"); o = importlib.util.module_from_spec(spec); spec.loader.exec_module(o)
    pre = json.load(open(precheck)); checks = []
    def check(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": detail}); print(("OK   " if ok else "FAIL ") + name + (f"  {detail}" if detail not in ("", None) else ""), flush=True)
    check("overlay tool working copy == commit's bytes", (src / "metal/overlay-control-image.py").read_bytes() == tool, sha(tool))
    m = json.loads((outdir / "manifest.json").read_text()); bm = json.loads((BASE / "manifest.json").read_text())
    check("vmlinuz == production base", (outdir / "vmlinuz").read_bytes() == (BASE / "vmlinuz").read_bytes(), sha((outdir / "vmlinuz").read_bytes()))
    check("manifest kernel record + modules unchanged", m["kernel"] == bm["kernel"] and m.get("modules") == bm.get("modules"), m["kernel"].get("kver"))
    check("cmdline file == production base cmdline (relay mode)", (outdir / "cmdline").read_bytes() == (BASE / "cmdline").read_bytes(), (outdir / "cmdline").read_text().strip())
    check("cmdlineTemplate/isolation unchanged; no control/platformApiBundle/mcpBundle", m.get("cmdlineTemplate") == bm.get("cmdlineTemplate") and m.get("isolation") == bm.get("isolation") == "snp-guest-per-app" and not any(k in m for k in ("control", "platformApiBundle", "mcpBundle")))
    co = m.get("controlOverlay", {})
    check("controlOverlay.commit = COMMIT", co.get("commit") == commit, co.get("commit"))
    check("controlOverlay.builderSha256 = the commit's overlay tool", co.get("builderSha256") == sha(tool))
    check("controlOverlay has no control mode", "control" not in co)
    check("controlOverlay.baseInitramfsSha256 = production base", co.get("baseInitramfsSha256") == bm["initramfs"]["sha256"] == "516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc")
    cv = co.get("chainVerifier") or {}
    check("manifest controlOverlay.chainVerifier.installed == true", cv.get("installed") is True, json.dumps(cv)[:300])
    hist = m.get("controlOverlayHistory") or []
    check("the base's controlOverlay is the last history entry", bool(hist) and hist[-1] == bm.get("controlOverlay") and hist[:-1] == (bm.get("controlOverlayHistory") or []), f"{len(hist)} entries")
    check("manifest initramfs record = file", m["initramfs"] == {"sha256": sha((outdir / "initramfs.cpio.gz").read_bytes()), "bytes": (outdir / "initramfs.cpio.gz").stat().st_size})
    check("expectedMeasurement removed (recomputed separately)", "expectedMeasurement" not in m)
    # the committed install set: names from the precheck, bytes from git here
    ref = {k: {"source": v["source"], "sha256": sha(blob(v["source"]))} for k, v in pre["inputs"].items()}
    check("precheck sha256s == git blobs at COMMIT", all(ref[k]["sha256"] == pre["inputs"][k]["sha256"] for k in ref), f"{len(ref)} committed inputs")
    files = {f["path"].lstrip("/"): f for f in co.get("files", [])}
    committed_files = {k: {"source": v.get("source"), "sha256": v.get("sha256")} for k, v in files.items() if k in ref}
    check("controlOverlay.files covers every committed input with the git sha256", committed_files == ref, f"{len(files)} file records")
    extract.mkdir(parents=True)
    img = newc(outdir / "initramfs.cpio.gz", extract)
    base = newc(BASE / "initramfs.cpio.gz")
    def eblob(key):
        t = extract / key
        return t.read_bytes() if key in img and stat.S_ISREG(img[key]["mode"]) and t.is_file() else None
    wrong = {k: (img.get(k) or {}).get("sha256") for k, v in ref.items() if (img.get(k) or {}).get("sha256") != v["sha256"] or not stat.S_ISREG((img.get(k) or {"mode": 0})["mode"])}
    check(f"all {len(ref)} committed inputs present, regular, bytes == git blob at COMMIT", not wrong, wrong or "")
    bad_meta = {k: oct(img[k]["mode"]) for k in ref if k in img and (img[k]["mode"] & 0o022 or img[k]["nlink"] != 1)}
    check("committed inputs not group/other-writable, nlink 1", not bad_meta, bad_meta or "")
    repl_meta = {k: [img[k][f] != base[k][f] for f in ("mode", "uid", "gid")] for k in ref if k in base and any(img[k][f] != base[k][f] for f in ("mode", "uid", "gid"))}
    modes = {}
    for k in ref: modes[oct(img[k]["mode"] & 0o7777) + f" {img[k]['uid']}:{img[k]['gid']}"] = modes.get(oct(img[k]["mode"] & 0o7777) + f" {img[k]['uid']}:{img[k]['gid']}", 0) + 1
    print(f"committed-input mode/owner distribution: {modes}; replaced entries whose mode/uid/gid differ from the base: {len(repl_meta)}")
    # native chain verifier files
    pins = dict(reversed(l.split()) for l in (vdir / "PINS.sha256").read_text().splitlines() if l.strip())
    rec = json.loads(blob("metal/chain-verifier-image.json")); rec_txt = json.dumps(rec)
    nat_bad = {}
    for k, (h, mode) in NATIVE.items():
        e = img.get(k); name = k.rsplit("/", 1)[1]
        prob = []
        if not e or not stat.S_ISREG(e["mode"]): prob.append("missing/non-regular")
        else:
            if e["sha256"] != h: prob.append(f"sha {e['sha256']}")
            if e["mode"] & 0o7777 != mode: prob.append(f"mode {oct(e['mode'] & 0o7777)}")
            if (e["uid"], e["gid"]) != (0, 0): prob.append(f"owner {e['uid']}:{e['gid']}")
            if e["nlink"] != 1: prob.append("nlink")
            d = eblob(k)
            if d is None or sha(d) != h: prob.append("extracted bytes")
        if pins.get(name) != h: prob.append("PINS.sha256 differs from RECIPE table")
        if h not in rec_txt: prob.append("not in commit's chain-verifier-image.json")
        if prob: nat_bad[k] = prob
    check("each /opt/rpc-runtime native: sha256 + mode as RECIPE table, root:root, regular, == PINS == commit image record", not nat_bad, nat_bad or f"{len(NATIVE)} files")
    rt_files = sorted(k for k in img if k == "opt/rpc-runtime" or k.startswith("opt/rpc-runtime/"))
    expected_rt = set(NATIVE) | {"opt/rpc-runtime", "opt/rpc-runtime/glibc", "opt/rpc-runtime/IMAGE.json"}
    check("/opt/rpc-runtime holds exactly the natives + IMAGE.json + 2 dirs", set(rt_files) == expected_rt, sorted(set(rt_files) ^ expected_rt))
    ij = eblob("opt/rpc-runtime/IMAGE.json")
    check("/opt/rpc-runtime/IMAGE.json == commit's metal/chain-verifier-image.json", ij == blob("metal/chain-verifier-image.json"), sha(ij or b""))
    cvm = eblob("opt/metal/chain-verifier.mjs")
    check("/opt/metal/chain-verifier.mjs == commit's metal/guest/chain-verifier.mjs", cvm == blob("metal/guest/chain-verifier.mjs"), sha(cvm or b""))
    added = sorted(set(img) - set(base)); missing = sorted(set(base) - set(img))
    addedDirs = [k for k in added if stat.S_ISDIR(img[k]["mode"])]
    badDirs = {k: (oct(img[k]["mode"] & 0o7777), img[k]["uid"], img[k]["gid"]) for k in addedDirs if (img[k]["mode"] & 0o7777, img[k]["uid"], img[k]["gid"]) != (0o755, 0, 0)}
    check("new directories are 0755 root:root", not badDirs, badDirs or addedDirs)
    check("no production base entry missing", not missing, missing[:10])
    extra = sorted(set(added) - set(addedDirs) - set(ref) - set(NATIVE) - {"opt/rpc-runtime/IMAGE.json"})
    check("added entries = new inputs + natives + IMAGE.json + parent directories only", not extra, extra[:10] or f"{len(added)} added ({len(addedDirs)} dirs)")
    others = [k for k in img if k not in ref and k in base and k != "opt/metal/manifest.json"]
    changed = [k for k in others if img[k] != base[k]]
    check("every other entry identical to the base (bytes + mode/owner/nlink/mtime/rdev)", not changed, changed[:10] or f"{len(others)} entries")
    mm = eblob("opt/metal/manifest.json")
    dimg, dbase = DUPS[str(outdir / "initramfs.cpio.gz")], DUPS[str(BASE / "initramfs.cpio.gz")]
    print(f"duplicate cpio entries (later wins): image {len(dimg)} {dimg[:8]}; base {len(dbase)} {dbase[:8]}")
    check("the image itself has no duplicated cpio path", not dimg, dimg[:10])
    # the base repeats some paths; the kernel unpacker (init/initramfs.c do_name: clean_path, open O_TRUNC + vfs_truncate, then
    # fchown/fchmod/utime from the LATER header) leaves the LAST occurrence. Prove, per path, what the image installs instead.
    dproof = {}
    for k in sorted(set(dbase)):
        occ = OCC[str(BASE / "initramfs.cpio.gz")][k] + [base[k]]
        e = img.get(k) or {}
        if k in ref: want, why = ref[k]["sha256"], "installed input: git bytes at COMMIT"
        else: want, why = base[k]["sha256"], "base entry: the base's last (kernel-effective) occurrence"
        same_meta = k in ref or all(e.get(f) == base[k][f] for f in ("mode", "uid", "gid", "nlink", "mtime", "size"))
        dproof[k] = {"baseOccurrences": [{f: o[f] for f in ("sha256", "mode", "uid", "gid", "size", "mtime")} for o in occ],
                     "distinctBaseContents": len({o["sha256"] for o in occ}), "image": {f: e.get(f) for f in ("sha256", "mode", "uid", "gid", "size", "mtime")},
                     "expected": why, "ok": e.get("sha256") == want and same_meta and stat.S_ISREG(e.get("mode", 0))}
        if k in ref: dproof[k]["installedEqualsGit"] = (eblob(k) is not None and sha(eblob(k)) == ref[k]["sha256"])
        print(f"dup {k}: {len(occ)} base occurrences, {dproof[k]['distinctBaseContents']} distinct contents; image {e.get('sha256')} ({why}) ok={dproof[k]['ok']}")
    DPROOF.update(dproof)
    check("every base-duplicated path is ONE image entry equal to its kernel-effective/installed bytes (extracted bytes re-hashed)", all(v["ok"] for v in dproof.values()) and all(sha(eblob(k) or b"") == dproof[k]["image"]["sha256"] for k in dproof), {k: v["ok"] for k, v in dproof.items()})
    check("in-image opt/metal/manifest.json names COMMIT", mm is not None and commit.encode() in mm)
    def read(rel):
        d = eblob("app/" + posixpath.normpath(rel))
        return d.decode("utf8", "replace") if d is not None else None
    for label, roots in (("supervisor", o.SUPERVISOR_ROOTS + o.APP_FILES), ("chain verifier runtime", o.CHAIN_VERIFIER_ROOTS)):
        try:
            cl, packages = o.supervisor_closure(read, roots); okc = True; detail = f"{len(cl)} files"
        except ValueError as e:
            cl, packages, okc, detail = [], {}, False, str(e)
        check(f"{label} import closure present in the image", okc, detail)
        notgit = [p for p in cl if "app/" + p not in ref and eblob("app/" + p) is not None]
        diff_git = []
        for p in cl:
            try:
                if eblob("app/" + p) != blob(p): diff_git.append(p)
            except subprocess.CalledProcessError:
                diff_git.append(p + " (not in commit)")
        check(f"{label} closure files == git blobs at COMMIT", not diff_git, diff_git[:10] or f"{len(cl)} files ({len(notgit)} kept from base, equal to git)")
        try:
            pk = o.check_packages(packages, lambda n: eblob("app/node_modules/" + n + "/package.json")); check(f"{label} closure npm packages + subpath exports in the image", True, ", ".join(f"{p['name']}@{p['version']}" for p in pk))
        except ValueError as e:
            check(f"{label} closure npm packages + subpath exports in the image", False, str(e))
    guest = [k for k in img if k.startswith("opt/metal/") and k.endswith(".mjs") and stat.S_ISREG(img[k]["mode"])]
    unresolved = []
    for g in guest:
        text = eblob(g).decode("utf8", "replace")
        if not g.endswith(".bundle.mjs"):
            for s_ in o.specifiers_of(text):
                if s_.startswith("./") or s_.startswith("../"):
                    t = posixpath.normpath(posixpath.join(posixpath.dirname(g), s_))
                    if t not in img: unresolved.append(f"{g} imports {s_}")
        for rel in re.findall(r"""new URL\(\s*["'](\.{1,2}/[^"']+)["']\s*,\s*import\.meta\.url\s*\)""", text):
            t = posixpath.normpath(posixpath.join(posixpath.dirname(g), rel))
            if t not in img or not stat.S_ISREG(img[t]["mode"]): unresolved.append(f"{g} reads {rel}")
    check("guest helpers' relative imports and bundles' beside-itself reads resolve in the image", not unresolved, unresolved[:10] or f"{len(guest)} opt/metal modules")
    gsup = eblob("opt/metal/gsup.mjs").decode()
    check("gsup.mjs == commit's metal/guest/gsup.mjs and references chain-verifier.mjs", gsup.encode() == blob("metal/guest/gsup.mjs") and "chain-verifier" in gsup)
    check("gsup.mjs starts /app/supervisor.js in the legacy (non-direct) branch", "if (!CONTROL) {" in gsup and "start('supervisor', ['/usr/local/bin/node', '/app/supervisor.js']" in gsup)
    check("relay mode: no platform-api / mcp role bundle installed", not any(k in img for k in ("opt/metal/platform-api.bundle.mjs", "opt/metal/mcp-server.bundle.mjs")))
    do_inputs = sorted(k for k in list(ref) + list(NATIVE) if (b := eblob(k)) is not None and any(d in b for d in DO))
    check("no installed input carries a DigitalOcean /platform-policy mirror literal", not do_inputs, do_inputs)
    ha = (img.get("app/windows/node/host-admission.bundle.mjs") or {}).get("sha256"); hp = (img.get("opt/metal/host-policy.bundle.mjs") or {}).get("sha256")
    print(f"installed host-admission bundle {ha}; host-policy bundle {hp}")
    print(f"node in image: usr/local/bin/node {(img.get('usr/local/bin/node') or {}).get('sha256')}; usr/bin/flock {(img.get('usr/bin/flock') or {}).get('sha256')}")
    json.dump({"commit": commit, "checks": checks, "ok": all(c["ok"] for c in checks),
               "entries": {"image": len(img), "base": len(base), "added": added, "addedDirectories": addedDirs},
               "native": {k: {"sha256": img[k]["sha256"], "mode": oct(img[k]["mode"] & 0o7777), "uid": img[k]["uid"], "gid": img[k]["gid"], "size": img[k]["size"]} for k in NATIVE if k in img},
               "committedInputs": {k: {"sha256": img[k]["sha256"], "mode": oct(img[k]["mode"] & 0o7777), "uid": img[k]["uid"], "gid": img[k]["gid"], "inBase": k in base} for k in ref if k in img},
               "committedModeDistribution": modes, "duplicateProof": DPROOF, "duplicateEntries": {"image": DUPS.get(str(outdir / "initramfs.cpio.gz")), "base": DUPS.get(str(BASE / "initramfs.cpio.gz"))}, "hostAdmissionBundle": ha, "hostPolicyBundle": hp}, open(receipt, "w"), indent=1)
    sys.exit(0 if all(c["ok"] for c in checks) else 10)

if __name__ == "__main__":
    if len(sys.argv) != 8: raise SystemExit(__doc__)
    main(*sys.argv[1:])
