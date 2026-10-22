#!/usr/bin/env python3
"""run-tree.py <tree> <label> [--c2]   (run ONLY inside the shared queue job, 512 MiB; one step at a time)

In a compose.py tree (real files; nothing outside it and out/<label>/ is written, except the throwaway TMPDIR):
  1. BUILD every generated artifact the composition touches with the tree's OWN unchanged builders (network-runtime
     prerequisite first), then --check each (a rebuild that must equal the written bytes and manifest) and node --check
     each emitted bundle.
  2. PROVENANCE: the host-admission/metal host-policy bundles must be the reviewed 40e8ba71/acfa1b00 and the lease bundles
     the accepted 008cdca1/421d6584 (+ manifests a7fde25e/c12ae3ef), byte for byte; the platform API bundle must carry
     certs.js 237834d8, measured-control f2648d65 and a network runtime that carries lease-reader 907ba85d.
  3. CAPTURE: a NEW scratch repository <tree>/.git (no remote, no existing repository read for writing) holding exactly the
     inventory paths, as ONE deterministic commit (fixed author/committer/date): the COMMIT the image tools take. Compared
     with candidate tree 56ea9f45 (read-only, reconciliation/upstream.git): every differing path must be a declared delta.
  4. The git-reading vendor --checks, then the focused tests. Test files the job adds for a run are removed afterwards and
     the capture must still be clean.
Writes out/<label>/RESULT.json, every step's log, and the bundles' hashes. Exit 0 only if every step passed."""
import hashlib, json, os, shutil, subprocess, sys, time
W = "/home/steven/Documents/Codex/2026-10-18/wo/work"
M = f"{W}/resume-after-checkpoint-20261022/measured-composition"
UPSTREAM = f"{W}/resume-20261021/reconciliation/upstream.git"
CAND_TREE = "56ea9f45ae50cdd8ff0830802f34759fbd37fe1e"
SMOKE = f"{W}/resume-20261021/platform-bundle-smoke/harness"
R2 = f"{W}/claude-resumed-20261022/cutover-review/measured-carrier-integration-r2"
OLD_PA = f"{W}/resume-20261021/reconciled-candidate/metal/guest/platform-api.bundle.mjs"      # 2a903c36, the old negative
IDENT = {"GIT_AUTHOR_NAME": "SteveDeFacto", "GIT_AUTHOR_EMAIL": "5148995+SteveDeFacto@users.noreply.github.com",
         "GIT_COMMITTER_NAME": "SteveDeFacto", "GIT_COMMITTER_EMAIL": "5148995+SteveDeFacto@users.noreply.github.com",
         "GIT_AUTHOR_DATE": "2026-10-22T00:00:00Z", "GIT_COMMITTER_DATE": "2026-10-22T00:00:00Z"}
PINS = {"windows/node/host-admission.bundle.mjs": "40e8ba71d83c627e85af21d58b9ab0d8b3052504a0e7d9ee47b429948c40bd25",
        "metal/guest/host-policy.bundle.mjs": "acfa1b0099530d4c27fe451d7d3f1d124b3f7a213171557c1c2d926976e0dc3c",
        "windows/node/lease-gas-runtime.bundle.mjs": "008cdca1240372d3dccedc2f58fecfcdca6377245ad67d4970a2efe79757f4e7",
        "windows/node/lease-gas-runtime.bundle.mjs.manifest.json": "a7fde25eae445eebc483d4a2ff57b569746eb60ddd64bbf33aca4f3831fb3ad1",
        "metal/guest/lease-gas-conduit.bundle.mjs": "421d6584daa3acdfd7b459094576b46d7eafefe15f30c04e1f831ccbd34ba8d6",
        "metal/guest/lease-gas-conduit.bundle.mjs.manifest.json": "c12ae3efcae557f9bb462eb55fa9eed444426ebab608b8bc4d49992ebbf96f2d"}
GENERATED = ["relay/network-runtime.bundle.mjs", "relay/network-runtime.bundle.mjs.manifest.json",
             "windows/node/host-admission.bundle.mjs", "metal/guest/host-policy.bundle.mjs",
             "windows/node/lease-gas-runtime.bundle.mjs", "windows/node/lease-gas-runtime.bundle.mjs.manifest.json",
             "metal/guest/lease-gas-conduit.bundle.mjs", "metal/guest/lease-gas-conduit.bundle.mjs.manifest.json",
             "metal/guest/platform-api.bundle.mjs", "metal/guest/platform-api.bundle.mjs.manifest.json",
             "metal/guest/mcp-server.bundle.mjs", "metal/guest/mcp-server.bundle.mjs.manifest.json"]
NOT_COMMITTED = {"relay/network-runtime.bundle.mjs", "relay/network-runtime.bundle.mjs.manifest.json"}   # gitignored prerequisite

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

def main(argv):
    T, label, c2 = os.path.abspath(argv[0]), argv[1], "--c2" in argv
    out = f"{M}/out/{label}"; os.makedirs(out, exist_ok=False)
    tmp = f"{M}/tmp/{label}"; os.makedirs(tmp, exist_ok=False)
    inv = json.load(open(T + ".inventory.json"))
    if inv["c2Applied"] != c2: sys.exit("inventory c2 flag differs")
    if os.path.lexists(f"{T}/.git"): sys.exit(".git already exists in the tree")
    env = {**os.environ, "TMPDIR": tmp, "GIT_OPTIONAL_LOCKS": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
    for k in ("GIT_DIR", "GIT_WORK_TREE", "NODE_OPTIONS"): env.pop(k, None)
    R = {"label": label, "tree": T, "c2": c2, "steps": [], "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    def step(name, cmd, cwd=T, extra=None, expect=0):
        t0 = time.time(); log = f"{out}/{name}.log"
        with open(log, "wb") as f:
            rc = subprocess.run(cmd, cwd=cwd, env={**env, **(extra or {})}, stdout=f, stderr=subprocess.STDOUT).returncode
        tail = open(log, "rb").read()[-1500:].decode("utf8", "replace")
        R["steps"].append({"step": name, "cmd": " ".join(cmd), "rc": rc, "ok": rc == expect, "sec": round(time.time() - t0, 1), "log": log.replace(M + "/", "")})
        print(f"[{label}] {name}: rc={rc} ({round(time.time() - t0, 1)} s)", flush=True)
        if rc != expect: print(tail, flush=True)
        return rc == expect
    def check(name, ok, detail):
        R["steps"].append({"step": name, "ok": bool(ok), "detail": detail}); print(f"[{label}] {name}: {'OK' if ok else 'FAIL'} {detail}", flush=True)
    node = shutil.which("node"); R["node"] = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    R["esbuild"] = json.load(open(f"{T}/node_modules/esbuild/package.json"))["version"]
    before = {g: (sha(f"{T}/{g}") if os.path.exists(f"{T}/{g}") else None) for g in GENERATED}
    # 1. build IN DEPENDENCY ORDER: the network runtime inlines windows/node/host-admission.bundle.mjs; the platform API bundle
    #    inlines the network runtime and metal/guest/lease-gas-conduit.bundle.mjs; mcp-server inlines host-admission; the
    #    route-dns host-service package inlines the network runtime (job-1 built the network runtime first: it inlined the
    #    candidate's stale 7aeb5de9 with its four DigitalOcean mirrors; recorded in rawlogs/job-1.out)
    for name, cmd in [("b1-host-admission", [node, "scripts/build-host-admission.mjs"]),
                      ("b2-windows-lease", [node, "scripts/build-windows-lease-runtime.mjs"]), ("b3-metal-lease", [node, "scripts/build-metal-lease-gas.mjs"]),
                      ("b4-network-runtime", [node, "relay/build-network.mjs"]),
                      ("b5-platform-api", [node, "scripts/build-platform-api-guest-bundle.mjs"]), ("b6-mcp", [node, "scripts/build-mcp-guest-bundle.mjs"]),
                      ("b7-host-service-packages", [node, "scripts/build-host-service-packages.mjs"])]:
        step(name, cmd)
    # the network runtime builder has no --check: rebuild it to a throwaway file and compare (a fixpoint, not a stale inline)
    step("c-network-runtime-rebuild", [node, "relay/build-network.mjs", f"{tmp}/network-runtime.recheck.mjs"])
    check("c-network-runtime-fixpoint", os.path.exists(f"{tmp}/network-runtime.recheck.mjs") and sha(f"{tmp}/network-runtime.recheck.mjs") == sha(f"{T}/relay/network-runtime.bundle.mjs"), "rebuild == the inlined prerequisite")
    for name, cmd in [("c-host-admission", "scripts/build-host-admission.mjs"), ("c-windows-lease", "scripts/build-windows-lease-runtime.mjs"),
                      ("c-metal-lease", "scripts/build-metal-lease-gas.mjs"), ("c-platform-api", "scripts/build-platform-api-guest-bundle.mjs"),
                      ("c-mcp", "scripts/build-mcp-guest-bundle.mjs"), ("c-host-service-packages", "scripts/build-host-service-packages.mjs"),
                      ("c-aa-vendor", "scripts/build-aa-vendor.mjs"), ("c-credit-vault-vendor", "scripts/build-credit-vault-vendor.mjs"),
                      ("c-custody-vendor", "scripts/build-custody-vendor.mjs")]:
        step(name, [node, cmd, "--check"])
    for g in GENERATED:
        if g.endswith(".mjs"): step("syntax-" + g.replace("/", "_"), [node, "--check", g])
    after = {g: sha(f"{T}/{g}") for g in GENERATED}
    R["generated"] = {g: {"before": before[g], "after": after[g]} for g in GENERATED}
    for g, want in PINS.items(): check("pin-" + g, after[g] == want, f"{after[g][:8]} (want {want[:8]})")
    # 2. C1 content of the platform API bundle and its network runtime prerequisite
    pm = json.load(open(f"{T}/metal/guest/platform-api.bundle.mjs.manifest.json")); nm = json.load(open(f"{T}/relay/network-runtime.bundle.mjs.manifest.json"))
    pa = open(f"{T}/metal/guest/platform-api.bundle.mjs", "rb").read(); nr = open(f"{T}/relay/network-runtime.bundle.mjs", "rb").read()
    check("c1-certs-in-manifest", pm["inputs"].get("relay/certs.js", "").startswith("237834d8"), pm["inputs"].get("relay/certs.js"))
    check("c1-network-runtime-in-manifest", pm["inputs"].get("relay/network-runtime.bundle.mjs") == after["relay/network-runtime.bundle.mjs"], pm["inputs"].get("relay/network-runtime.bundle.mjs"))
    check("c1-measured-control-in-manifest", pm["inputs"].get("metal/guest/measured-control.mjs", "").startswith("f2648d65"), pm["inputs"].get("metal/guest/measured-control.mjs"))
    check("c1-lease-conduit-in-manifest", pm["inputs"].get("metal/guest/lease-gas-conduit.bundle.mjs") == PINS["metal/guest/lease-gas-conduit.bundle.mjs"], pm["inputs"].get("metal/guest/lease-gas-conduit.bundle.mjs"))
    check("c1-lease-reader-in-network-runtime", any(i.endswith("network/lease-reader.mjs") for i in nm["inputs"]), "network-runtime inputs name network/lease-reader.mjs")
    for marker, blob, name in [(b"invalid rate-limit retry budget", nr, "c1-retry-budget-in-network-runtime"), (b"invalid rate-limit retry budget", pa, "c1-retry-budget-in-platform-api"),
                               (b"is not for the requested key and name", pa, "c1-acme-retention-in-platform-api"),
                               (b"platformPolicyCarriers", pa, "p1-carriers-member-in-platform-api")]:
        check(name, blob.count(marker) >= 1, f"{blob.count(marker)} x {marker.decode()}")
    # C3: no DigitalOcean /platform-policy MIRROR anywhere generated (relay/native-discovery.mjs's DO control route is a separate,
    # pre-existing item: counted and reported, not a policy mirror)
    scan = ["windows/node/host-admission.bundle.mjs", "metal/guest/host-policy.bundle.mjs", "metal/guest/mcp-server.bundle.mjs", "metal/guest/platform-api.bundle.mjs",
            "relay/network-runtime.bundle.mjs"] + [f"network/host-services/packages/{f}" for f in sorted(os.listdir(f"{T}/network/host-services/packages")) if f.endswith(".mjs")]
    for ip in [b"134.199.235.187", b"134.209.248.172", b"165.245.191.129", b"146.190.246.39"]:
        hits = [g for g in scan if ip + b"/platform-policy" in open(f"{T}/{g}", "rb").read()]
        check("c3-no-do-mirror-" + ip.decode(), not hits, hits)
    R["doAddressesOutsidePolicy"] = {g: open(f"{T}/{g}", "rb").read().count(b"134.199.235.187") for g in scan if b"134.199.235.187" in open(f"{T}/{g}", "rb").read()}
    if c2:
        for p in [b"/.well-known/enclave-attestation", b"/.well-known/tinfoil-attestation"]:
            check("c2-path-in-platform-api-" + p.decode().split("/")[-1], p in pa, "")
        check("c2-attestation-paths-in-manifest", "relay/attestation-paths.mjs" in pm["inputs"], "")
    check("c2-damaged-literal-absent" if c2 else "c2-damaged-literal-present (expected without C2)",
          (b"Cloud Provider-attestation" in pa) != c2, f"{pa.count(b'Cloud Provider-attestation')} x in platform-api")
    # 3. capture: exactly the inventory paths, one deterministic commit
    paths = sorted(set(inv["base"]) | set(inv["overlays"]) | set(inv["c2"]))
    if set(paths) & NOT_COMMITTED: sys.exit("a gitignored prerequisite is in the inventory")
    with open(f"{tmp}/paths.nul", "wb") as f: f.write(b"\0".join(p.encode() for p in paths) + b"\0")
    genv = {**IDENT, "GIT_DIR": f"{T}/.git", "GIT_WORK_TREE": T, "GIT_LITERAL_PATHSPECS": "1"}
    ok = step("g1-init", ["git", "init", "-q"], extra=genv) and step("g2-add", ["git", "add", "-f", "--pathspec-from-file", f"{tmp}/paths.nul", "--pathspec-file-nul"], extra=genv)
    tree = subprocess.run(["git", "write-tree"], cwd=T, env={**env, **genv}, capture_output=True, text=True).stdout.strip()
    msg = f"measured-control composition capture ({label}): reconciled candidate {CAND_TREE[:8]} + reviewed deltas (scratch; not published)\n"
    commit = subprocess.run(["git", "commit-tree", tree, "-m", msg], cwd=T, env={**env, **genv}, capture_output=True, text=True).stdout.strip()
    ok = ok and len(tree) == 40 and len(commit) == 40 and step("g3-ref", ["git", "update-ref", "refs/heads/composition", commit], extra=genv) \
         and step("g4-head", ["git", "symbolic-ref", "HEAD", "refs/heads/composition"], extra=genv)
    R["capture"] = {"gitDir": f"{T}/.git".replace(M + "/", ""), "tree": tree, "commit": commit, "paths": len(paths), "identity": IDENT}
    check("g5-capture", ok, f"tree {tree} commit {commit}")
    st = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=T, env={**env, **genv}, capture_output=True, text=True).stdout.splitlines()
    dirty = [l for l in st if not any(l[3:].startswith(nm) for nm in ("node_modules/", "relay/node_modules/", "network/node_modules/", "sdk/sessions/node_modules/", "e2e/node_modules/"))
             and l[3:] not in NOT_COMMITTED]
    check("g6-clean-after-capture", not dirty, dirty[:10])
    # 56ea9f45 vs the capture: (mode, blob) per path; the differences must be exactly the declared deltas
    ls = lambda gitdir, t: {l.split("\t", 1)[1]: l.split()[0] + " " + l.split()[2] for l in subprocess.run(["git", "--git-dir", gitdir, "ls-tree", "-r", t],
                             env={**env, "GIT_OPTIONAL_LOCKS": "0"}, capture_output=True, text=True, check=True).stdout.splitlines()}
    old, new = ls(UPSTREAM, CAND_TREE), ls(f"{T}/.git", tree)
    diff = sorted(p for p in set(old) | set(new) if old.get(p) != new.get(p))
    regenerated = {p for p in set(old) | set(new) if p.startswith("network/host-services/packages/")}   # build-host-service-packages output
    declared = set(inv["overlays"]) | set(inv["c2"]) | set(inv["candidate"]["laterChanged"]) | set(inv["candidate"]["laterAdded"]) | (set(GENERATED) - NOT_COMMITTED) | regenerated
    unchanged_generated = sorted(g for g in set(GENERATED) - NOT_COMMITTED if g not in diff)
    R["vsCandidate56ea9f45"] = {"changedPaths": diff, "undeclared": sorted(set(diff) - declared), "declaredButSame": sorted(declared - set(diff)), "generatedSame": unchanged_generated}
    check("g7-only-declared-deltas-vs-56ea9f45", not (set(diff) - declared), sorted(set(diff) - declared)[:10])
    # 4. vendor --checks that read git, then the focused tests
    for name, cmd in [("c-host-policy-vendor", "scripts/build-host-policy-vendor.mjs"), ("c-host-capacity-vendor", "scripts/build-host-capacity-vendor.mjs"),
                      ("c-management-vendor", "scripts/build-management-vendor.mjs")]:
        step(name, [node, cmd, "--check"])
    step("t-overlay-b1", ["python3", "-u", "test/metal-control-overlay.test.py", "-v"])
    step("t-metal-lease-gas-conduit", [node, "--test", "--test-concurrency=1", "test/metal-lease-gas-conduit.test.mjs"])
    step("t-lease-gas-cost-model-unit", [node, "--test", "--test-concurrency=1", "test/lease-gas-cost-model.test.mjs"])
    # the ARTIFACT smoke: the generated platform API bundle started as the role starts its relay child, laid out as the image lays it out
    lay = f"{tmp}/opt-metal"; os.makedirs(f"{lay}/fixtures")
    shutil.copyfile(f"{T}/metal/guest/platform-api.bundle.mjs", f"{lay}/platform-api.bundle.mjs")
    for beside, s in pm["sidecars"].items(): shutil.copyfile(f"{T}/{s['source']}", f"{lay}/{beside}"); check("sidecar-" + beside, sha(f"{lay}/{beside}") == s["sha256"], s["sha256"][:8])
    step("t-artifact-smoke", [node, "--test", "--test-concurrency=1", "--test-reporter=tap", "bundle-smoke.test.mjs"], cwd=SMOKE, extra={"BUNDLE_DIR": lay})
    # the bundle's bound-config verifier as the actual role process (r2's test, run against THIS bundle; 2a903c36 the old negative)
    added = ["test/bundle-verifier.test.mjs", "test/helpers/measured-policy-world.mjs"]
    for a in added:
        if os.path.lexists(f"{T}/{a}"): sys.exit(f"{a} exists in the tree")
    shutil.copyfile(f"{R2}/test/bundle-verifier.test.mjs", f"{T}/{added[0]}"); shutil.copyfile(f"{R2}/test/helpers/measured-policy-world.mjs", f"{T}/{added[1]}")
    step("t-bundle-verifier", [node, "--test", "--test-concurrency=1", "test/bundle-verifier.test.mjs"],
         extra={"NEW_BUNDLE": f"{T}/metal/guest/platform-api.bundle.mjs", "OLD_BUNDLE": OLD_PA})
    for a in added: os.remove(f"{T}/{a}")
    if c2:      # the relay/CLI suites run from job-2.sh AFTER this process exits (job-1: 519 MiB with this orchestrator resident)
        step("t-c2-attestation-route", [node, "--test", "--test-concurrency=1", "test/attestation-route.test.mjs"])
    st = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=T, env={**env, **genv}, capture_output=True, text=True).stdout.splitlines()
    dirty = [l for l in st if "node_modules/" not in l and l[3:] not in NOT_COMMITTED]
    check("g8-clean-after-tests", not dirty, dirty[:10])
    R["bundles"] = {g: after[g] for g in GENERATED}
    R["ok"] = all(s["ok"] for s in R["steps"]); R["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(R, open(f"{out}/RESULT.json", "w"), indent=1)
    print(json.dumps({"label": label, "ok": R["ok"], "commit": commit, "failed": [s["step"] for s in R["steps"] if not s["ok"]]}), flush=True)
    shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(0 if R["ok"] else 1)

if __name__ == "__main__": main(sys.argv[1:])
