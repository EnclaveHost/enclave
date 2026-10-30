#!/usr/bin/env python3
# platform-bundle-closure helper (PREPARED; run only inside root's job, by jobs/root-platform-bundle-closure.sh). Reads files and
# git state; writes only the output file it is given. Every subcommand exits non-zero on any problem.
import hashlib, json, os, re, subprocess, sys

def fh(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def treedigest(root, out):
    """every entry of a dependency root: files with mode and sha256, symlinks with their target (never followed)"""
    rows = []
    for d, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for n in sorted(dirs + files):
            p = os.path.join(d, n); r = os.path.relpath(p, root)
            if os.path.islink(p): rows.append(f"L {r} -> {os.readlink(p)}")
            elif n in files: rows.append(f"F {r} {oct(os.lstat(p).st_mode & 0o7777)} {fh(p)}")
    rows.sort(); body = "\n".join(rows) + "\n"
    open(out, "w").write(body)
    print(f"{len(rows)} entries sha256:{hashlib.sha256(body.encode()).hexdigest()}")

def lockcheck(root, lock, out, *need):
    """every applicable top-level package of the lock present at root with the locked version (the r2-r4 depcheck, per root)"""
    lock = json.load(open(lock)); rows, probs = [], []
    for k, v in sorted(lock["packages"].items()):
        if not k.startswith("node_modules/") or "/node_modules/" in k[len("node_modules/"):]: continue
        name = k[len("node_modules/"):]
        osl, cpul = v.get("os"), v.get("cpu")
        if (osl and "linux" not in osl) or (cpul and "x64" not in cpul): continue
        pj = os.path.join(root, name, "package.json")
        if not os.path.exists(pj):
            if v.get("optional") or v.get("peer"): continue
            probs.append(f"missing {name}@{v.get('version')}"); continue
        b = open(pj, "rb").read(); got = json.loads(b).get("version")
        if got != v.get("version"): probs.append(f"{name}: locked {v.get('version')}, present {got}")
        rows.append(f"{name} {got} {hashlib.sha256(b).hexdigest()}")
    for n in need:
        if not any(r.split(" ")[0] == n for r in rows): probs.append(f"required {n} not in the checked closure")
    open(out, "w").write("\n".join(rows) + "\n")
    print(f"{len(rows)} packages checked; problems: {probs}"); sys.exit(1 if probs else 0)

def receipt(r4, run, root_receipt):
    """the r4 PASS receipt: root's own verdict, rc files and output lines (root's queue log prefix, e.g.
    logs/root-lease-seams-r4-0133 -> .rc / .out), for exactly this run"""
    fails = []
    try: v = json.load(open(os.path.join(run, "verdict.json")))
    except Exception as e: print(json.dumps({"ok": False, "fails": [f"no verdict.json: {e}"]})); sys.exit(1)
    rd = lambda p: open(p).read() if os.path.exists(p) else None
    if v.get("ok") is not True or v.get("fails"): fails.append(f"r4 verdict not ok: {v.get('fails')}")
    c, b = v.get("candidate", {}), v.get("base", {})
    if [c.get(k) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")] != [66, 66, 0, 0, 0, 0]: fails.append(f"candidate {c}")
    if [b.get(k) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo")] != [66, 57, 9, 0, 0, 0] or len(v.get("baseFailing", [])) != 9: fails.append(f"base {b}")
    if (rd(os.path.join(run, "candidate.tap.rc")) or "").strip() != "0": fails.append("candidate.tap.rc != 0")
    if (rd(os.path.join(run, "base.tap.rc")) or "").strip() != "1": fails.append("base.tap.rc != 1")
    if rd(os.path.join(run, "integration-check.out")) != "": fails.append("integration-check.out missing or not empty")
    bl = [l.split("  ", 1) for l in (rd(os.path.join(run, "integration-bundles.sha256")) or "").splitlines()]
    want = ["windows/node/lease-gas-runtime.bundle.mjs", "windows/node/lease-gas-runtime.bundle.mjs.manifest.json",
            "metal/guest/lease-gas-conduit.bundle.mjs", "metal/guest/lease-gas-conduit.bundle.mjs.manifest.json"]
    if [p for _, p in bl] != want: fails.append(f"integration-bundles.sha256 paths {[p for _, p in bl]}")
    if (rd(root_receipt + ".rc") or "").strip() != "0": fails.append(f"{root_receipt}.rc missing or != 0")
    out = [l for l in (rd(root_receipt + ".out") or "").splitlines() if l.strip()]
    i = out.index(f"## outputs: {run}") if f"## outputs: {run}" in out else -1   # the queue may print after the job; the job's own pair is exact
    if i < 0 or i + 1 >= len(out) or out[i + 1] != "## seams rc=0" or sum(l.startswith("## outputs: ") for l in out) != 1:
        fails.append(f"{root_receipt}.out: not exactly one outputs line, for this run, followed by '## seams rc=0'")
    print(json.dumps({"ok": not fails, "fails": fails, "run": run, "bundles": dict((p, h) for h, p in bl)}, indent=1)); sys.exit(1 if fails else 0)

def pastale(clone, manifest):
    """observation: which recorded inputs of a committed bundle manifest differ from the clone (tracked, generated, node_modules)"""
    m = json.load(open(os.path.join(clone, manifest))); r = {"stale": [], "missing": [], "inputs": len(m["inputs"])}
    for p, h in sorted(m["inputs"].items()):
        f = os.path.join(clone, p)
        if not os.path.exists(f): r["missing"].append(p)
        elif fh(f) != h: r["stale"].append(p)
    print(json.dumps(r, indent=1))

def manifests(clone, gen_list):
    """dependency-order proof: every manifest's own sha equals its bundle, and every GENERATED input it pins equals the final file"""
    gen = {l.split()[2] for l in open(gen_list) if l.strip() and not l.startswith("#")}
    fails, seen = [], {}
    for mf in sorted(p for p in gen if p.endswith(".manifest.json") or p.endswith(".MANIFEST.json")):
        m = json.load(open(os.path.join(clone, mf)))
        bundle = mf[: -len(".manifest.json")] if mf.endswith(".manifest.json") else m.get("file")
        if m.get("sha256") != fh(os.path.join(clone, bundle)): fails.append(f"{mf}: sha256 is not {bundle}'s")
        ins = m.get("inputs", m.get("sources", {}))
        if isinstance(ins, list):                       # relay/build-network.mjs records a list of paths
            out = [p for p in ins if p.startswith("..") or p.startswith("/")]
            if out: fails.append(f"{mf}: {len(out)} inputs outside the tree (location-dependent bytes), e.g. {out[:3]}")
            seen[mf] = len(ins); continue
        for p, h in ins.items():
            h = h["sha256"] if isinstance(h, dict) else h
            if p.startswith("..") or p.startswith("/"): fails.append(f"{mf}: input outside the tree {p}")
            elif p in gen and h != fh(os.path.join(clone, p)): fails.append(f"{mf}: pins generated {p} at {h[:12]}, the final file differs")
        seen[mf] = len(ins)
    print(json.dumps({"ok": not fails, "fails": fails, "inputs": seen}, indent=1)); sys.exit(1 if fails else 0)

def gitstatus(clone, gen_list, allowed_changed):
    """the candidate tree after the closure: tracked changes only in the generated list (plus the committed composition),
    no untracked file, ignored entries only the dependency copies and the untracked network runtime"""
    gen = [l.split() for l in open(gen_list) if l.strip() and not l.startswith("#")]
    tracked_gen = {p for _, k, p in gen if k == "tracked"}
    ignored_ok = {"node_modules/", "network/node_modules/", "relay/node_modules/"} | {p for _, k, p in gen if k == "always"}
    st = subprocess.run(["git", "-C", clone, "status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"], capture_output=True, check=True).stdout.decode()
    changed, untracked, ignored, fails = [], [], [], []
    for e in [x for x in st.split("\0") if x]:
        code, p = e[:2], e[3:]
        (ignored if code == "!!" else untracked if code == "??" else changed).append(p)
    extra = sorted(set(changed) - tracked_gen - set(allowed_changed))
    if extra: fails.append(f"tracked changes outside the generated list: {extra}")
    if untracked: fails.append(f"untracked files: {untracked[:10]}")
    bad_ign = sorted(p for p in ignored if not any(p == a or p.startswith(a) for a in ignored_ok))
    if bad_ign: fails.append(f"unexpected ignored files: {bad_ign[:10]}")
    print(json.dumps({"ok": not fails, "fails": fails, "changed": sorted(changed)}, indent=1)); sys.exit(1 if fails else 0)

SKIP_ALLOW = {"test/metal-control-overlay.test.py": {"test_with_inputs_every_pinned_file_is_installed_with_its_mode_and_digest",
                                                    "test_a_native_file_that_is_not_the_pinned_one_refuses_and_writes_nothing"}}

def tap(p):
    t = open(p, encoding="utf-8", errors="replace").read()
    c = {k: int(m.group(1)) for k in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo") for m in [re.search(rf"^# {k} (\d+)$", t, re.M)] if m}
    return c, sorted(set(re.findall(r"^\s*not ok \d+ - (.+?)(?: #.*)?$", t, re.M))), sorted(set(re.findall(r"^\s*ok \d+ - (.+?) # SKIP", t, re.M)))

def pyunit(p):
    t = open(p, encoding="utf-8", errors="replace").read()
    ran = re.search(r"^Ran (\d+) tests? in ", t, re.M)
    res = {n: r for n, r in re.findall(r"^(test_\w+) \([\w.]+\) \.\.\. (ok|skipped|FAIL|ERROR|expected failure|unexpected success)", t, re.M)}
    final = re.search(r"^(OK|FAILED)(?: \((.*)\))?$", t, re.M)
    return (int(ran.group(1)) if ran else None), res, (final.group(0) if final else None)

def verdict(out, tier, tests_file, counts_file):
    fails = []
    steps = [l.rstrip("\n").split("\t") for l in open(os.path.join(out, "steps.tsv")) if l.strip()]
    fails += [f"step {s[0]}: {s[2] if len(s) > 2 else ''}" for s in steps if s[1] != "ok"]
    builders = [l.rstrip("\n").split("\t") for l in open(os.path.join(out, "builders.tsv")) if l.strip()]
    cls = {}
    for bid, kind, base_rc, pre_rc, action, post_rc in builders:
        if kind == "tracked" and post_rc != "0": fails.append(f"{bid}: --check after regeneration rc {post_rc}")
        if kind == "check-only" and pre_rc != "0": fails.append(f"{bid}: check-only artifact stale (rc {pre_rc}; baseline rc {base_rc}); not regenerable in this closure")
        cls[bid] = {"kind": kind, "baselineCheckRc": base_rc, "preCheckRc": pre_rc, "action": action, "postCheckRc": post_rc,
                    "class": "always regenerated (untracked)" if kind == "always" else
                             "unchanged" if pre_rc == "0" else
                             "stale in the integrated tree (no separate baseline)" if base_rc == "na" else
                             "stale at baseline (pre-existing) and after the composition" if base_rc != "0" else "stale ONLY after the composition"}
    for l in open(os.path.join(out, "final-checks.tsv")):
        bid, r = l.split()
        if r != "0": fails.append(f"fixpoint --check {bid} rc {r}")
    expect = json.load(open(counts_file)) if counts_file and os.path.exists(counts_file) else None
    tests, results = [l.strip() for l in open(tests_file) if l.strip()], {}
    for t in tests:
        base = os.path.join(out, "tests", t.replace("/", "_"))
        rcp = base + ".rc"
        r = open(rcp).read().strip() if os.path.exists(rcp) else "missing"
        if r != "0": fails.append(f"{t}: process rc {r} (any non-zero, timeout 124 or missing is a failure)")
        allow = SKIP_ALLOW.get(t, set())
        if t.endswith(".py"):
            n, res, final = pyunit(base + ".txt")
            skipped = {k for k, v in res.items() if v == "skipped"}
            bad = {k: v for k, v in res.items() if v not in ("ok", "skipped")}
            if n is None or n != len(res): fails.append(f"{t}: Ran {n} but {len(res)} result lines parsed")
            if bad: fails.append(f"{t}: {bad}")
            if skipped != allow: fails.append(f"{t}: skipped {sorted(skipped)}, allowed exactly {sorted(allow)}")
            want_final = f"OK (skipped={len(allow)})" if allow else "OK"
            if final != want_final: fails.append(f"{t}: final line {final!r}, expected {want_final!r}")
            results[t] = {"rc": r, "tests": n, "skipped": sorted(skipped), "final": final}
        else:
            c, failing, skipped = tap(base + ".tap")
            if not c.get("tests"): fails.append(f"{t}: no TAP summary / 0 tests")
            for k in ("fail", "cancelled", "todo"):
                if c.get(k, 1): fails.append(f"{t}: {k} {c.get(k)}")
            if c.get("skipped", 1) != len(allow) or set(skipped) != allow: fails.append(f"{t}: skipped {c.get('skipped')} {skipped}, allowed exactly {sorted(allow)}")
            if failing: fails.append(f"{t}: failing {failing}")
            results[t] = {"rc": r, **c}
        if expect is not None and expect.get(t) != results[t].get("tests"): fails.append(f"{t}: {results[t].get('tests')} tests, pinned {expect.get(t)}")
    print(json.dumps({"ok": not fails, "fails": fails, "tier": tier, "builders": cls, "tests": results,
                      "testCountsPinned": expect is not None}, indent=1)); sys.exit(1 if fails else 0)

if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"treedigest": treedigest, "lockcheck": lockcheck, "receipt": receipt, "pastale": pastale, "manifests": manifests,
     "gitstatus": lambda c, g, *a: gitstatus(c, g, a), "verdict": verdict}[cmd](*args)
