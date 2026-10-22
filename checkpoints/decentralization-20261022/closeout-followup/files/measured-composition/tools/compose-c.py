#!/usr/bin/env python3
"""compose-c.py <out-tree>   (tree-c: compose.py --c2 + the closeout layer src/closeout/)

Stage the MEASURED-CONTROL COMPOSITION as a NEW tree of real files (no build, no image, no measurement, no git):
  base      = work/resume-20261021/reconciled-candidate AS IT IS NOW: tree 56ea9f45 (reconciliation/candidate-all.sha256
              6eba6585) + the root's later in-place updates (6 changed paths, 5 added tests; listed in the inventory),
              so no reviewed candidate fix is rolled back. The candidate's pycache is not source and is skipped.
  overlays  = OVERLAYS below, each from a named reviewed source, CAS-checked against the expected base bytes and the
              expected result bytes, plus the supervisor comment patch (applied with patch(1), then verified to change
              only that one line). --c2 adds the C2 attestation-route proposal (src/c2/) on top.
  generated = NOT staged here: every committed bundle/manifest is rebuilt by the queued job from this tree.
node_modules: real copies of work/enclave's installed node_modules (the reviewed bundle recipe's dependency set).
Git symlinks inside the tree stay symlinks; any symlink that leaves the tree is refused. Nothing outside <out-tree>
is written. Prints and writes <out-tree>.inventory.json."""
import hashlib, json, os, shutil, subprocess, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
CAND = f"{W}/resume-20261021/reconciled-candidate"
CAND_LIST = f"{W}/resume-20261021/reconciliation/candidate-all.sha256"
CAND_LIST_SHA = "6eba65854c14ef910de2f5c72e3921d992f120bcdcbea3f45ed03df502daeb0f"
ENCLAVE = f"{W}/enclave"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R2 = f"{W}/claude-resumed-20261022/cutover-review/measured-carrier-integration-r2"
PC = f"{W}/claude-resumed-20261022/platform-activation/platform-carrier"
LR = f"{W}/lease-readiness-20261022/tree"
REL = f"{W}/cron-startup-20261021/release-source/source"
COST = f"{W}/resume-after-checkpoint-20261022/cost"
COSTB = f"{W}/resume-after-checkpoint-20261022/cost-bundle"
# root's in-place candidate updates after tree 56ea9f45 (current bytes are the base; recorded, asserted)
CAND_LATER = {
    "network/public-directory.mjs": ("a480b674", "95edf767"), "network/route-record.mjs": ("be3bfab7", "9ba9f6d3"),
    "relay/certs.js": ("e15802cf", "237834d8"), "test/certs.test.mjs": ("6aa8375d", "983754d9"),
    "windows/installer/install-host.ps1": ("0dc5a801", "ac2c2754"), "windows/node/hvcert.mjs": ("91b9f2db", "3a87d9b8"),
}
CAND_ADDED = ["test/route-context-churn.test.mjs", "test/route-partial-qualification.test.mjs", "test/route-resign-admin-ban.test.mjs",
              "test/route-same-route-churn.test.mjs", "test/windows-node-hvcert-pending.test.mjs"]
SKIP = {"metal/__pycache__/overlay-control-image.cpython-314.pyc"}
# path -> (source file, expected candidate base sha8 or None for a new file, expected result sha8, item, why)
OVERLAYS = {
    "metal/guest/measured-control.mjs": (f"{R2}/src/metal/guest/measured-control.mjs", "18f47214", "f2648d65", "P1",
        "measured-carrier-integration-r2: bound platformPolicyCarriers -> ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS (patch 0ecce76f)"),
    "network/host-service-gate-carriers.mjs": (f"{PC}/src/network/host-service-gate-carriers.mjs", None, "9766bf87", "P1/C4",
        "platform-carrier: policy carriers wrapper for the host gate (source of 40e8ba71)"),
    "network/host-admission-node.mjs": (f"{PC}/src/network/host-admission-node.mjs", None, "3ec697f4", "P1/C4",
        "platform-carrier: the Windows/host bundle entry (source of 40e8ba71)"),
    "scripts/build-host-admission.mjs": (f"{PC}/src/scripts/build-host-admission.mjs", "63cc1377", "aafa8d54", "P1/C4",
        "platform-carrier: Windows entry -> network/host-admission-node.mjs; metal entry unchanged"),
    "network/platform-host-policy-config.mjs": (f"{REL}/network/platform-host-policy-config.mjs", "6422d065", "8ec507e0", "C3",
        "PRODUCTION_MIRRORS = [] (no DigitalOcean /platform-policy mirrors); book, hostOwnership, RPC quorum unchanged"),
    "network/host-admission-runtime.mjs": (f"{LR}/network/host-admission-runtime.mjs", "f9e009da", "cb42269d", "C4",
        "superset of the candidate's f9e009da (cron fix kept): adds decision()/validUntil, refusal() unchanged; the source of 6bef372d/40e8ba71"),
    "network/lease-gas-owner.mjs": (f"{ENCLAVE}/network/lease-gas-owner.mjs", "ddd3ba9b", "92cc322a", "cost", "accepted lease cost correction (cost-result.json)"),
    "cli/lease-gas.mjs": (f"{ENCLAVE}/cli/lease-gas.mjs", "27d49989", "9f34e04e", "cost", "accepted lease cost correction (cost-result.json)"),
    "test/lease-gas-cost-model.test.mjs": (f"{ENCLAVE}/test/lease-gas-cost-model.test.mjs", "48ce8ffe", "8a39e218", "cost", "accepted lease cost correction"),
    "test/lease-gas-owner-cli.test.mjs": (f"{ENCLAVE}/test/lease-gas-owner-cli.test.mjs", "ffc100c4", "79fb06e9", "cost", "accepted lease cost correction"),
    "docs/network/app-funded-leases.md": (f"{ENCLAVE}/docs/network/app-funded-leases.md", "81a85180", "76e74d07", "cost", "accepted lease cost correction"),
    "test/lease-gas-cost-model-ledger.test.mjs": (f"{ENCLAVE}/test/lease-gas-cost-model-ledger.test.mjs", None, "22084761", "cost", "accepted lease cost correction (new test)"),
    "metal/overlay-control-image.py": (f"{HERE}/src/b1/metal/overlay-control-image.py", "7a120502", None, "B1",
        "--control direct: platform-api trio + metal.control=direct over the verified base kernel"),
    "test/metal-control-overlay.test.py": (f"{HERE}/src/b1/test/metal-control-overlay.test.py", "*", None, "B1", "tests for --control direct"),
    "metal/README.md": (f"{HERE}/src/b1/metal/README.md", "5fd7a0ae", None, "B1", "documents --control direct"),
    "docs/network/measured-control-guest.md": (f"{HERE}/src/b1/docs/network/measured-control-guest.md", "9c4a492f", None, "B1", "documents --control direct"),
}
SUPERVISOR_PATCH = (f"{COSTB}/patches/supervisor-comment.diff", "2c9048c6", "8a37ab6a")
C2 = {   # path -> expected base sha8 in the composed tree (None = new file); sources in src/c2/<path>
    "relay/attestation-paths.mjs": None, "supervisor.js": "fad47c9d", "relay/api-relay.js": "1f30ccc1", "relay/boxhost.js": "017a2878",
    "test/relay-u7-eligible-routing.test.mjs": "97007070", "test/cli-attest-verifier.test.mjs": "70f61d88", "Dockerfile": "d4602d76",
    "test/attestation-route.test.mjs": None,
}
CLOSEOUT = {   # path -> expected base sha8 in the composed C2 tree (None = new file); sources in src/closeout/<path>
    "Dockerfile": "ad7f788f", "metal/overlay-control-image.py": "e0db4372", "test/metal-control-overlay.test.py": "96352fe4",
    "metal/build-image.mjs": "aa9d725a", "scripts/build-mcp-guest-bundle.mjs": "314ce200", "metal/README.md": "27a192f8",
    "docs/network/measured-control-guest.md": "59045b82", "docs/network/hosted-mcp.md": "08a95c06",
    "metal/guest/mcp-server-entry.mjs": None, "test/mcp-guest-bundle.test.mjs": None,
}
NODE_MODULES = ["node_modules", "relay/node_modules", "network/node_modules", "sdk/sessions/node_modules", "e2e/node_modules"]
CAND_NODE_MODULES_LINK = f"{ENCLAVE}/node_modules"

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def main(argv):
    out = os.path.abspath(argv[0]); c2 = True
    if os.path.lexists(out): sys.exit(f"{out} exists: a new tree only")
    if sha(CAND_LIST) != CAND_LIST_SHA: sys.exit("candidate-all.sha256 is not 6eba6585")
    if os.path.realpath(f"{CAND}/node_modules") != CAND_NODE_MODULES_LINK: sys.exit("candidate node_modules is not work/enclave's")
    listed = {}
    for line in open(CAND_LIST):
        h, p = line.rstrip("\n").split("  ", 1); listed[p[2:] if p.startswith("./") else p] = h
    # the candidate as it is now: every listed path + the later additions; assert the drift is exactly CAND_LATER
    files, drift = {}, {}
    for d, ds, fs in os.walk(CAND):
        ds[:] = [x for x in ds if not (d == CAND and x == "node_modules")]
        for n in fs + [x for x in ds if os.path.islink(os.path.join(d, x))]:
            rel = os.path.relpath(os.path.join(d, n), CAND)
            if rel in SKIP or rel == "node_modules": continue
            files[rel] = os.path.join(d, n)
    ds_links = [r for r in files if os.path.islink(files[r]) and os.path.isdir(files[r])]
    if ds_links: sys.exit(f"directory symlinks in the candidate: {ds_links}")
    if set(files) != set(listed) | set(CAND_ADDED): sys.exit(f"candidate path set drifted: +{sorted(set(files) - set(listed) - set(CAND_ADDED))[:10]} -{sorted(set(listed) - set(files))[:10]}")
    for rel, p in files.items():
        cur = sha(p)                                     # the list hashes a link by its target bytes (sha256sum follows it)
        if rel in listed and cur != listed[rel]: drift[rel] = (listed[rel][:8], cur[:8])
    if drift != CAND_LATER: sys.exit(f"candidate drift is not the recorded set: {drift}")
    os.mkdir(out); inv = {"base": {}, "overlays": {}, "c2": {}, "closeout": {}}
    for rel, p in sorted(files.items()):
        dst = os.path.join(out, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.islink(p):
            t = os.readlink(p); tgt = os.path.normpath(os.path.join(os.path.dirname(rel), t))
            if t.startswith("/") or tgt.startswith(".."): sys.exit(f"symlink leaves the tree: {rel} -> {t}")
            os.symlink(t, dst); inv["base"][rel] = "link:" + t
        else:
            shutil.copy2(p, dst); inv["base"][rel] = sha(dst)
    def put(rel, src, base8, want8):
        dst = os.path.join(out, rel)
        if base8 is None and os.path.lexists(dst): sys.exit(f"{rel} must be new")
        if base8 not in (None, "*") and not sha(dst).startswith(base8): sys.exit(f"{rel}: base is {sha(dst)[:8]}, not {base8}")
        before = sha(dst) if os.path.exists(dst) else None
        mode = os.stat(dst).st_mode & 0o7777 if os.path.exists(dst) else 0o644   # git records the exec bit: keep the base's
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.lexists(dst): os.remove(dst)
        shutil.copyfile(src, dst); os.chmod(dst, mode)
        after = sha(dst)
        if want8 and not after.startswith(want8): sys.exit(f"{rel}: result is {after[:8]}, not {want8}")
        return before, after
    for rel, (src, base8, want8, item, why) in OVERLAYS.items():
        b, a = put(rel, src, base8, want8)
        inv["overlays"][rel] = {"item": item, "source": src.replace(W + "/", "work/"), "before": b, "after": a, "why": why}
    # supervisor.js: the cost task's COMMENT-ONLY correction, applied to the candidate's own supervisor (never old history)
    p, psha, base8 = SUPERVISOR_PATCH
    if not sha(p).startswith(psha): sys.exit("supervisor comment patch is not 2c9048c6")
    sup = os.path.join(out, "supervisor.js"); before = sha(sup)
    if not before.startswith(base8): sys.exit(f"supervisor.js base is {before[:8]}")
    old = open(sup, "rb").read().split(b"\n")
    subprocess.run(["patch", "--no-backup-if-mismatch", "-s", "-p1", "-d", out, "-i", p], check=True)
    new = open(sup, "rb").read().split(b"\n")
    changed = [i for i in range(max(len(old), len(new))) if (old[i] if i < len(old) else None) != (new[i] if i < len(new) else None)]
    if len(old) != len(new) or len(changed) != 1 or b"RENEW_MARGIN_SEC" not in new[changed[0]] or old[changed[0]].split(b"//")[0] != new[changed[0]].split(b"//")[0]:
        sys.exit(f"supervisor patch changed more than the RENEW_MARGIN_SEC comment: lines {changed[:5]}")
    inv["overlays"]["supervisor.js"] = {"item": "cost", "source": p.replace(W + "/", "work/"), "before": before, "after": sha(sup),
        "why": f"comment-only correction at line {changed[0] + 1} (cost-bundle-result.json; code before // identical)"}
    if c2:
        for rel, base8 in C2.items():
            b, a = put(rel, f"{HERE}/src/c2/{rel}", base8, None)
            inv["c2"][rel] = {"before": b, "after": a}
        for rel, base8 in CLOSEOUT.items():
            b, a = put(rel, f"{HERE}/src/closeout/{rel}", base8, None)
            inv["closeout"][rel] = {"before": b, "after": a}
    for nm in NODE_MODULES:
        dst = os.path.join(out, nm)
        if os.path.lexists(dst): sys.exit(f"{nm} already in the tree")
        subprocess.run(["cp", "-a", f"{ENCLAVE}/{nm}", dst], check=True)
    bad = []
    for d, ds, fs in os.walk(out):
        for n in ds + fs:
            q = os.path.join(d, n)
            if os.path.islink(q):
                r = os.path.realpath(q)
                if not (r == out or r.startswith(out + "/")): bad.append(os.path.relpath(q, out))
    if bad: sys.exit(f"symlinks leaving the tree: {bad[:10]}")
    inv["candidate"] = {"dir": CAND.replace(W + "/", "work/"), "tree": "56ea9f45ae50cdd8ff0830802f34759fbd37fe1e", "list": CAND_LIST_SHA,
                        "laterChanged": {k: list(v) for k, v in CAND_LATER.items()}, "laterAdded": {r: sha(os.path.join(out, r)) for r in CAND_ADDED},
                        "skipped": sorted(SKIP)}
    inv["nodeModules"] = {nm: f"work/enclave/{nm} (real copy)" for nm in NODE_MODULES}
    inv["c2Applied"] = c2
    json.dump(inv, open(out + ".inventory.json", "w"), indent=1, sort_keys=True)
    print(json.dumps({"tree": out, "files": len(inv["base"]), "overlays": {k: (v["before"] or "new")[:8] + "->" + v["after"][:8] for k, v in inv["overlays"].items()},
                      "c2": {k: (v["before"] or "new")[:8] + "->" + v["after"][:8] for k, v in inv["c2"].items()},
                      "closeout": {k: (v["before"] or "new")[:8] + "->" + v["after"][:8] for k, v in inv["closeout"].items()}}, indent=1))

if __name__ == "__main__": main(sys.argv[1:])
